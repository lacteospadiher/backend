// controllers/vendedor/pedidoController.js
import db from '../../config/db.js';

const DEBUG_PEDIDOS = process.env.DEBUG_PEDIDOS === '1';
const logd = (...a) => { if (DEBUG_PEDIDOS) console.log('[pedidos]', ...a); };

/* ----------------- Utils ----------------- */
const norm  = (v) => (v ?? '').toString().trim();
const toNum = (v, d = 0) => (v == null || v === '' || isNaN(v)) ? d : Number(v);
const round3 = (n) => Math.max(0, Math.round((toNum(n,0)) * 1000) / 1000);

const ENUM_COLOR = ['blanco', 'amarillo'];

/** Usuario autenticado (JWT/middleware) o body/query como fallback */
function getUsuarioId(req) {
  return Number(req.user?.id ?? req.body?.usuarioId ?? req.query?.usuarioId) || null;
}

/** Si el JWT trae relación con vendedor */
function getVendedorIdFromJwt(req) {
  return Number(req.user?.vendedorId ?? req.user?.id_vendedor ?? req.user?.vendedor_id) || null;
}

function isPedidosEspeciales(nameOrSlug = '') {
  const s = String(nameOrSlug || '').trim().toLowerCase();
  return (
    s === 'pedidos especiales' ||
    s === 'pedido especial' ||
    s.includes('especial')
  );
}

async function getVendedorIdByUsuario(conn, usuarioId) {
  if (!usuarioId) return null;
  const [[row]] = await conn.query(
    'SELECT id FROM vendedores WHERE id_usuario = ? AND eliminado = 0 AND activo = 1 LIMIT 1',
    [usuarioId]
  );
  return row?.id || null;
}

/** Fallback para cargas.id_usuario si no llega req.user.id / usuarioId */
async function getUsuarioIdDeVendedor(conn, vendedorId) {
  if (!vendedorId) return null;
  const [[row]] = await conn.query(
    'SELECT id_usuario FROM vendedores WHERE id = ? LIMIT 1',
    [vendedorId]
  );
  return row?.id_usuario || null;
}

async function getVendedorIdByUid(conn, vendedorUid) {
  const u = norm(vendedorUid);
  if (!u) return null;
  const [[row]] = await conn.query(
    `SELECT v.id
       FROM usuarios u
       JOIN vendedores v ON v.id_usuario = u.id
      WHERE (u.usuario = ? OR u.correo = ?)
        AND u.eliminado = 0 AND u.activo = 1
        AND v.eliminado = 0 AND v.activo = 1
      LIMIT 1`,
    [u, u]
  );
  return row?.id || null;
}

async function getVendedorPricingMode(conn, vendedorId) {
  const [[row]] = await conn.query(
    `SELECT COALESCE(pricing_mode, 'normal') AS pm
       FROM vendedores
      WHERE id = ? LIMIT 1`,
    [vendedorId]
  );
  return row?.pm || 'normal';
}

async function getCamionetaIdByVendedor(conn, vendedorId) {
  if (!vendedorId) return null;
  const [[row]] = await conn.query(
    'SELECT camioneta_id FROM vendedores WHERE id = ? AND eliminado = 0 AND activo = 1 LIMIT 1',
    [vendedorId]
  );
  return row?.camioneta_id || null;
}

/* =========================================================
   Helper de filtros para productos
   Acepta: search (o q), categoria_id, activos, color
   ========================================================= */
function buildWhere({ q, categoria_id, activos, color }) {
  const where = ['p.eliminado = 0'];
  const params = [];

  const term = norm(q);
  if (term) {
    where.push('(p.nombre LIKE ? OR p.codigo LIKE ?)');
    params.push('%' + term + '%', '%' + term + '%');
  }

  const catId = categoria_id != null && categoria_id !== '' ? Number(categoria_id) : null;
  if (!isNaN(catId) && catId != null) {
    where.push('p.categoria_id = ?');
    params.push(catId);
  }

  if (activos != null) {
    const a = Number(activos);
    where.push('p.activo = ?');
    params.push(Number(!!a));
  }

  const c = norm(color).toLowerCase();
  if (c && ENUM_COLOR.includes(c)) {
    where.push('p.color = ?');
    params.push(c);
  }

  return { where: 'WHERE ' + where.join(' AND '), params };
}

/**
 * Detecta columnas de 'pedidos'.
 * Incluye `lista_para_excel` y `pedido_especial`.
 */
async function detectSchema(conn) {
  try { await conn.query('SELECT 1 FROM pedidos LIMIT 0'); }
  catch { throw new Error("La tabla 'pedidos' no existe en la base de datos."); }

  const [cols] = await conn.query('SHOW COLUMNS FROM pedidos');
  const names = new Set(cols.map(c => c.Field));

  const usuarioCol   = names.has('id_usuario')    ? 'id_usuario'    : (names.has('usuario_id')    ? 'usuario_id'    : null);
  const clienteCol   = names.has('cliente_id')    ? 'cliente_id'    : (names.has('id_cliente')    ? 'id_cliente'    : null);
  const vendedorCol  = names.has('id_vendedor')   ? 'id_vendedor'   : (names.has('vendedor_id')   ? 'vendedor_id'   : null);
  const camionetaCol = names.has('id_camioneta')  ? 'id_camioneta'  : (names.has('camioneta_id')  ? 'camioneta_id'  : null);
  const fechaCol     = names.has('fecha')         ? 'fecha'         : (names.has('created_at')    ? 'created_at'    : 'fecha');
  const totalCol     = names.has('total')         ? 'total'         : (names.has('monto_total')   ? 'monto_total'   : 'total');
  const estadoCol    = names.has('estado')        ? 'estado'        : (names.has('status')        ? 'status'        : 'estado');
  const procesadoCol = names.has('procesado')     ? 'procesado'     : (names.has('procesada')     ? 'procesada'     : null);
  const obsCol       = names.has('observaciones') ? 'observaciones' : (names.has('nota')          ? 'nota'          : null);
  const cargaIdCol   = names.has('carga_id')      ? 'carga_id'      : null;
  const excelCol     = names.has('lista_para_excel') ? 'lista_para_excel' : null;
  const pedidoEspCol = names.has('pedido_especial')   ? 'pedido_especial' : null;  // 👈 NUEVO

  return {
    usuarioCol, clienteCol, vendedorCol, camionetaCol, fechaCol, totalCol, estadoCol,
    procesadoCol, obsCol, cargaIdCol, excelCol, pedidoEspCol
  };
}

/** Suma duplicados [{productoId,cantidad}] → array compacta */
function sumDuplicates(items) {
  const acc = new Map();
  for (const it of (Array.isArray(items) ? items : [])) {
    const id = Number(it?.productoId ?? it?.id);
    const cant = round3(it?.cantidad);
    if (!id || cant <= 0) continue;
    acc.set(id, +(((acc.get(id) || 0) + cant).toFixed(3)));
  }
  return [...acc.entries()].map(([id, cantidad]) => ({ id, cantidad }));
}

/* =================== Endpoints =================== */

/**
 * GET /api/vendedor/pedidos/productos
 * Query:
 *   - search (o q)
 *   - categoria_id
 *   - activos (0|1)
 *   - color=blanco|amarillo
 *   - group=categoria | group=1  -> agrupa por categoría
 */
export async function listarProductos(req, res) {
  const conn = await db.getConnection();
  try {
    const search      = req.query?.search ?? req.query?.q ?? '';
    const categoriaId = req.query?.categoria_id;
    const activos     = req.query?.activos;
    const color       = req.query?.color;
    const groupParam  = (req.query?.group ?? '').toString().trim().toLowerCase();
    const wantsGroup  = groupParam === 'categoria' || groupParam === '1';

    const { where, params } = buildWhere({ q: search, categoria_id: categoriaId, activos, color });

    const orderBy = `
      ORDER BY
        c.nombre ASC,
        CASE WHEN c.nombre = 'Fresco'
             THEN FIELD(p.color, 'blanco','amarillo')
             ELSE 3
        END ASC,
        p.nombre ASC
    `;

    const [rows] = await conn.query(
      `
      SELECT
        p.id                 AS id,
        p.nombre             AS nombre,
        p.precio             AS precio,
        p.precio_mayoreo     AS precio_mayoreo,
        p.categoria_id       AS categoria_id,
        p.color              AS color,
        c.nombre             AS categoria,
        c.slug               AS categoria_slug
      FROM productos p
      LEFT JOIN categorias_productos c ON c.id = p.categoria_id
      ${where}
      ${orderBy}
      LIMIT 1000
      `,
      params
    );

    const plano = rows.map(r => ({
      id: Number(r.id),
      nombre: r.nombre,
      precio: Number(r.precio ?? 0),
      precioMayoreo: Number(r.precio_mayoreo ?? 0),
      color: r.color ?? null,
      categoriaId: r.categoria_id != null ? Number(r.categoria_id) : null,
      categoria: r.categoria ?? null,
      categoriaSlug: r.categoria_slug ?? null
    }));

    if (!wantsGroup) {
      return res.json({ ok: true, data: plano });
    }

    // Categorías activas
    const [cats] = await conn.query(
      `
      SELECT id, nombre, slug
      FROM categorias_productos
      WHERE activo = 1
      ORDER BY nombre ASC
      `
    );

    const grupos = new Map(
      cats.map(c => [
        Number(c.id),
        { categoriaId: Number(c.id), categoria: c.nombre, slug: c.slug, productos: [] }
      ])
    );

    // Colocar productos en su categoría activa
    for (const p of plano) {
      if (p.categoriaId != null && grupos.has(p.categoriaId)) {
        grupos.get(p.categoriaId).productos.push({
          id: p.id,
          nombre: p.nombre,
          precio: p.precio,
          precioMayoreo: p.precioMayoreo,
          color: p.color
        });
      }
    }

    // Asegura “Pedidos especiales”
    let tieneEspecial = false;
    for (const g of grupos.values()) {
      if (isPedidosEspeciales(g.categoria) || isPedidosEspeciales(g.slug)) {
        tieneEspecial = true; break;
      }
    }
    if (!tieneEspecial) {
      grupos.set(0, {
        categoriaId: 0,
        categoria: 'Pedidos especiales',
        slug: 'pedidos-especiales',
        productos: [] // la app muestra textarea
      });
    }

    const data = Array.from(grupos.values()).sort((a, b) =>
      String(a.categoria || '').localeCompare(String(b.categoria || ''))
    );

    return res.json({ ok: true, data });
  } catch (e) {
    console.error('Error listando productos:', e);
    return res.status(500).json({ ok: false, msg: e?.sqlMessage || e?.message || 'Error listando productos' });
  } finally {
    try { conn.release(); } catch {}
  }
}

/**
 * POST /api/vendedor/pedidos
 * body: {
 *   idVendedor?, vendedorUid?, idCamioneta?,
 *   observaciones?, pedidoEspecial?,  // 👈 NUEVO
 *   items:[{productoId,cantidad}]
 * }
 */
export async function crearPedido(req, res) {
  const conn = await db.getConnection();
  try {
    const schema = await detectSchema(conn);

    // 1) Usuario (si pedidos requiere id_usuario)
    const usuarioId = getUsuarioId(req);
    if (schema.usuarioCol && !usuarioId) {
      return res.status(401).json({ ok:false, msg:'Sesión inválida: falta id_usuario' });
    }

    // 2) Vendedor
    let vendedorId =
      Number(req.body?.idVendedor || 0) ||
      getVendedorIdFromJwt(req) ||
      await getVendedorIdByUsuario(conn, usuarioId) ||
      await getVendedorIdByUid(conn, req.body?.vendedorUid);

    if (!vendedorId) return res.status(400).json({ ok:false, msg:'Vendedor no identificado' });

    // 3) Camioneta
    const camionetaId = toNum(req.body?.idCamioneta, 0) || await getCamionetaIdByVendedor(conn, vendedorId);

    // 4) Items
    const items = sumDuplicates(req.body?.items);
    if (!items.length) return res.status(400).json({ ok:false, msg:'Debes enviar items válidos' });

    // 5) Validar productos + precios
    const productoIds = items.map(x => x.id);
    const placeholders = productoIds.map(() => '?').join(',');
    const [prods] = await conn.query(
      `SELECT id, nombre, precio, precio_mayoreo
         FROM productos
        WHERE id IN (${placeholders}) AND activo = 1 AND eliminado = 0`,
      productoIds
    );
    if (prods.length !== productoIds.length) {
      return res.status(400).json({ ok:false, msg:'Algún producto no existe o está inactivo' });
    }
    const pmap = new Map(prods.map(p => [Number(p.id), p]));
    const pricingMode = await getVendedorPricingMode(conn, vendedorId);

    let total = 0;
    let totalCantidad = 0;
    const snapshot = items.map(it => {
      const p = pmap.get(it.id);
      const unit = (pricingMode === 'mayoreo' && toNum(p.precio_mayoreo, 0) > 0)
        ? toNum(p.precio_mayoreo, 0)
        : toNum(p.precio, 0);
      total += unit * it.cantidad;
      totalCantidad += it.cantidad;
      return { producto_id: it.id, nombre: p.nombre, cantidad: it.cantidad, precio_unitario: unit };
    });

    // 6) Transacción: pedidos + historial
    await conn.beginTransaction();

    // 6.1) INSERT en pedidos (incluyendo lista_para_excel y pedido_especial si existen)
    const cols = [];
    const vals = [];
    const phs  = [];
    const pushCol = (name, value) => { cols.push('`' + name + '`'); vals.push(value); phs.push('?'); };

    if (schema.usuarioCol)   pushCol(schema.usuarioCol, usuarioId);
    if (schema.clienteCol)   pushCol(schema.clienteCol, null);
    pushCol(schema.vendedorCol, vendedorId);
    if (schema.camionetaCol) pushCol(schema.camionetaCol, camionetaId ?? null);
    pushCol(schema.fechaCol, new Date());
    pushCol(schema.totalCol, Number(total.toFixed(2)));
    pushCol(schema.estadoCol, 'pendiente');
    if (schema.procesadoCol) pushCol(schema.procesadoCol, 0);
    if (schema.obsCol)       pushCol(schema.obsCol, norm(req.body?.observaciones) || null);
    if (schema.excelCol)     pushCol(schema.excelCol, 1); // marcar para Excel
    if (schema.pedidoEspCol) pushCol(schema.pedidoEspCol, norm(req.body?.pedidoEspecial) || null); // 👈 NUEVO

    const [insP] = await conn.query(
      `INSERT INTO \`pedidos\` (${cols.join(',')}) VALUES (${phs.join(',')})`,
      vals
    );
    const pedidoId = Number(insP.insertId);

    // 6.2) Historial inmutable
    if (snapshot.length) {
      const ph = [];
      const vv = [];
      for (const d of snapshot) {
        ph.push('(?, ?, ?, ?, ?)');
        vv.push(
          pedidoId,
          d.producto_id,
          d.nombre,
          Math.round(d.cantidad),
          d.precio_unitario
        );
      }
      await conn.query(
        `INSERT INTO \`pedido_detalle_hist\`
           (\`pedido_id\`, \`producto_id\`, \`nombre_producto\`, \`cantidad_solicitada\`, \`precio_unitario\`)
         VALUES ${ph.join(',')}
         ON DUPLICATE KEY UPDATE
           \`nombre_producto\` = VALUES(\`nombre_producto\`),
           \`precio_unitario\` = VALUES(\`precio_unitario\`)`,
        vv
      );
    }

    // 6.3) (no crear carga ni detalle_pedido aquí)

    // 6.4) Asegurar total
    await conn.query(
      `UPDATE \`pedidos\` SET \`${schema.totalCol}\` = ? WHERE id = ?`,
      [Number(total.toFixed(2)), pedidoId]
    );

    await conn.commit();

    return res.status(201).json({
      ok: true,
      data: {
        pedidoId,
        pedidoNumero: pedidoId,
        cargaId: null,
        estado: 'pendiente',
        total: Number(total.toFixed(2)),
        totalItems: snapshot.length,
        totalCantidad: Number(totalCantidad.toFixed(3))
      },
      msg: `Pedido creado con folio #${pedidoId}`
    });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    console.error('[pedidos] crearPedido error:', e);
    return res.status(500).json({ ok:false, msg: e?.message || 'Error creando pedido' });
  } finally {
    try { conn.release(); } catch {}
  }
}
