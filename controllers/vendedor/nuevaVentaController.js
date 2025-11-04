// controllers/vendedor/nuevaVentaController.js
import db from '../../config/db.js';

/* ========================= Helpers ========================= */
const norm = s => String(s || '').trim().toLowerCase();
const EPS  = 0.009; // ~1 centavo de tolerancia

async function resolveVendedorId({ idVendedor, vendedorUid }) {
  if (idVendedor) return Number(idVendedor);
  if (!vendedorUid) return null;
  const [[row]] = await db.query(
    `SELECT id FROM vendedores WHERE firebase_uid = ? LIMIT 1`,
    [vendedorUid]
  );
  return row?.id || null;
}

async function resolveClienteId({ clienteId, codigoQR }) {
  if (clienteId) return Number(clienteId);
  if (!codigoQR) return null;
  const [[row]] = await db.query(
    `SELECT id FROM clientes WHERE codigo_qr=? AND eliminado=0 LIMIT 1`,
    [codigoQR]
  );
  return row?.id || null;
}

/** Pricing SOLO por cliente (mayoreo|normal) */
async function resolvePricingModeFromCliente({ clienteId }) {
  if (!clienteId) return 'normal';
  const [[c]] = await db.query(
    `SELECT COALESCE(pricing_mode,'normal') AS m FROM clientes WHERE id=? LIMIT 1`,
    [clienteId]
  );
  return (c?.m === 'mayoreo') ? 'mayoreo' : 'normal';
}

/** Cliente es cadena/C */
async function esClienteCadena(clienteId) {
  if (!clienteId) return false;
  const [[r]] = await db.query(
    `SELECT (tipo_cliente IN ('cadena','C')) AS is_cadena
       FROM clientes
      WHERE id=? LIMIT 1`,
    [clienteId]
  );
  return !!(r?.is_cadena);
}

/* ========================= Descuentos ========================= */
/** Prioridad: cliente+producto > cliente > global (en cada nivel se toma el mayor vigente) */
async function buildDescuentosMap({ clienteId, productoIds = [] }) {
  const map = new Map(); // productoId -> { pct, source }
  const hoy = new Date().toISOString().slice(0,10); // YYYY-MM-DD
  const uniqProdIds = [...new Set((productoIds || []).map(Number).filter(Boolean))];

  // 1) Cliente+Producto
  if (clienteId && uniqProdIds.length) {
    const marks = uniqProdIds.map(()=>'?').join(',');
    const [rows] = await db.query(
      `SELECT producto_id, MAX(porcentaje) AS pct
         FROM descuentos_cliente_producto
        WHERE cliente_id = ?
          AND activo = 1
          AND ? BETWEEN fecha_inicio AND fecha_fin
          AND producto_id IN (${marks})
        GROUP BY producto_id`,
      [clienteId, hoy, ...uniqProdIds]
    );
    for (const r of rows) {
      map.set(Number(r.producto_id), { pct: Number(r.pct || 0), source: 'cliente_producto' });
    }
  }

  // 2) Cliente (máximo vigente)
  let pctCliente = 0;
  if (clienteId) {
    const [[rowCli]] = await db.query(
      `SELECT MAX(porcentaje) AS pct
         FROM descuentos_cliente
        WHERE cliente_id = ?
          AND activo = 1
          AND ? BETWEEN fecha_inicio AND fecha_fin
        LIMIT 1`,
      [clienteId, hoy]
    );
    pctCliente = Number(rowCli?.pct || 0);
  }

  // 3) Global (máximo vigente)
  const [[rowGlob]] = await db.query(
    `SELECT MAX(porcentaje) AS pct
       FROM descuentos_globales
      WHERE activo = 1
        AND ? BETWEEN fecha_inicio AND fecha_fin
      LIMIT 1`,
    [hoy]
  );
  const pctGlobal = Number(rowGlob?.pct || 0);

  // Completar mapa con el mejor nivel disponible
  for (const pid of uniqProdIds) {
    if (!map.has(pid)) {
      const pct = Math.max(pctCliente, pctGlobal);
      if (pct > 0) {
        map.set(pid, { pct, source: pctCliente >= pctGlobal ? 'cliente' : 'global' });
      }
    }
  }
  return map;
}

function aplicarDescuento(precioBase, pct) {
  const p = Number(precioBase || 0);
  const d = Math.max(Number(pct || 0), 0);
  const v = Math.max(p * (1 - d/100), 0);
  return Math.round(v * 100) / 100; // 2 decimales
}

/* ========================= Resolver por categoría+nombre (prioriza CARGA) ========================= */
async function resolveCategoriaIdsByNombre(nombresCat = []) {
  if (!nombresCat.length) return new Map();
  const uniq = [...new Set(nombresCat.map(n => String(n || '').trim()).filter(Boolean))];
  if (!uniq.length) return new Map();
  const marks = uniq.map(()=>'?').join(',');
  const [rows] = await db.query(
    `SELECT id, nombre FROM categorias_productos WHERE nombre IN (${marks})`,
    uniq
  );
  const m = new Map();
  for (const r of rows) m.set(norm(r.nombre), Number(r.id));
  return m;
}

async function mapProductosEnCargaPorCatNombre(items, cargaId) {
  if (!Array.isArray(items) || !items.length || !cargaId) return new Map();

  // Completa categoriaId si solo te mandan categoriaNombre
  const catNames = items.map(x => x?.categoriaNombre).filter(Boolean);
  const catMapByName = await resolveCategoriaIdsByNombre(catNames);

  const stdItems = items.map(x => ({
    nombre: String(x?.nombre || ''),
    categoriaId: x?.categoriaId ?? (x?.categoriaNombre ? catMapByName.get(norm(x.categoriaNombre)) : null),
  }));

  const nombres = [...new Set(stdItems.map(i => norm(i.nombre)).filter(Boolean))];
  if (!nombres.length) return new Map();
  const marks = nombres.map(()=>'?').join(',');

  // 1) Candidatos en la CARGA (usa dp.restante STORED)
  const [enCarga] = await db.query(
    `SELECT
        dp.producto_id AS id,
        dp.nombre_producto COLLATE utf8mb4_unicode_ci AS nombre,
        p.categoria_id                         AS categoria_id,
        cp.nombre                              AS categoria_nombre,
        p.precio, p.precio_mayoreo,
        dp.precio_unitario                     AS precio_unitario_dp,
        dp.restante                            AS restante
     FROM detalle_pedido dp
     LEFT JOIN productos p ON p.id = dp.producto_id
     LEFT JOIN categorias_productos cp ON cp.id = p.categoria_id
    WHERE dp.carga_id = ?
      AND LOWER(TRIM(dp.nombre_producto)) COLLATE utf8mb4_unicode_ci IN (${marks})`,
    [cargaId, ...nombres]
  );

  const candidatosPorNombre = new Map();
  for (const r of enCarga) {
    const key = norm(r.nombre);
    const list = candidatosPorNombre.get(key) || [];
    list.push({
      id: Number(r.id),
      nombre: r.nombre,
      categoria_id: r.categoria_id != null ? Number(r.categoria_id) : null,
      categoria_nombre: r.categoria_nombre || null,
      precio: Number(r.precio || 0),
      precio_mayoreo: Number(r.precio_mayoreo || 0),
      precio_unitario_dp: r.precio_unitario != null ? Number(r.precio_unitario) : null,
      restante: Number(r.restante || 0),
      fuente: 'carga'
    });
    candidatosPorNombre.set(key, list);
  }

  // 2) Candidatos en el CATÁLOGO
  const [enCatalogoRaw] = await db.query(
    `SELECT p.id, p.nombre, p.categoria_id, cp.nombre AS categoria_nombre, p.precio, p.precio_mayoreo
       FROM productos p
       JOIN categorias_productos cp ON cp.id = p.categoria_id
      WHERE p.activo=1 AND p.eliminado=0
        AND LOWER(TRIM(p.nombre)) COLLATE utf8mb4_unicode_ci IN (${marks})`,
    nombres
  );
  const catalogoPorNombre = new Map();
  for (const r of enCatalogoRaw) {
    const key = norm(r.nombre);
    const arr = catalogoPorNombre.get(key) || [];
    arr.push({
      id: Number(r.id),
      nombre: r.nombre,
      categoria_id: Number(r.categoria_id),
      categoria_nombre: r.categoria_nombre || null,
      precio: Number(r.precio || 0),
      precio_mayoreo: Number(r.precio_mayoreo || 0),
      precio_unitario_dp: null,
      restante: 0,
      fuente: 'catalogo'
    });
    catalogoPorNombre.set(key, arr);
  }

  // 3) Elegir el candidato
  const result = new Map(); // key = `${catId||0}:${norm(nombre)}`
  for (const it of stdItems) {
    const nkey = norm(it.nombre);
    const catId = it.categoriaId || 0;
    const keyComp = `${catId}:${nkey}`;

    let cand = (candidatosPorNombre.get(nkey) || []).filter(c => !it.categoriaId || c.categoria_id === it.categoriaId);
    if (!cand.length) {
      cand = (catalogoPorNombre.get(nkey) || []).filter(c => !it.categoriaId || c.categoria_id === it.categoriaId);
    }

    cand.sort((a, b) => {
      if (b.restante !== a.restante) return b.restante - a.restante;
      if (a.fuente !== b.fuente) return a.fuente === 'carga' ? -1 : 1;
      return a.id - b.id;
    });

    if (cand[0]) result.set(keyComp, cand[0]);
  }

  return result;
}

/** Precio unitario correcto, con fallback al snapshot de la carga (dp.precio_unitario) */
function getUnitPrice(prodInfo, pricingMode) {
  const pm = Number(prodInfo?.precio_mayoreo || 0);
  const pn = Number(prodInfo?.precio || 0);
  const pCarga = prodInfo?.precio_unitario_dp != null ? Number(prodInfo.precio_unitario_dp) : 0;

  if (pricingMode === 'mayoreo' && pm > 0) return pm;
  if (pn > 0) return pn;
  return pCarga;
}

async function getUltimaCargaId(vendedorId) {
  const [[row]] = await db.query(
    `SELECT id FROM cargas WHERE id_vendedor=? ORDER BY fecha DESC, id DESC LIMIT 1`,
    [vendedorId]
  );
  return row ? Number(row.id) : null;
}

/* ========================= Política de crédito (ADMIN) ========================= */
async function getPoliticaCredito(clienteId) {
  const [[cli]] = await db.query(`
    SELECT
      id,
      COALESCE(permite_credito,0)           AS permite_credito,
      COALESCE(dias_credito,0)              AS dias_credito,
      COALESCE(limite_credito_monto,0)      AS limite_monto,
      COALESCE(limite_creditos_abiertos,0)  AS limite_abiertos
    FROM clientes
    WHERE id = ?
    LIMIT 1`, [clienteId]);

  if (!cli) return null;

  const [[aggs]] = await db.query(`
    SELECT
      COUNT(*)                 AS abiertos,
      COALESCE(SUM(c.saldo),0) AS saldo_abierto
    FROM creditos c
    JOIN ventas v ON v.id = c.id_venta
    WHERE v.id_cliente = ? AND c.saldo > ?`,
    [clienteId, EPS]
  );

  return {
    permite_credito: !!cli.permite_credito,
    dias_credito: Number(cli.dias_credito || 0),
    limite_abiertos: Number(cli.limite_abiertos || 0),
    limite_monto: Number(cli.limite_monto || 0),
    abiertos: Number(aggs?.abiertos || 0),
    saldo_abierto: Number(aggs?.saldo_abierto || 0)
  };
}

/* ========================= Endpoints ========================= */

/**
 * GET /vendedor/nueva-venta/carga-activa?idVendedor=... | &vendedorUid=...
 */
export async function getCargaActiva(req, res) {
  try {
    const idVendedor = await resolveVendedorId({
      idVendedor: req.query.idVendedor || req.query.vendedor_id,
      vendedorUid: req.query.vendedorUid
    });
    if (!idVendedor) return res.status(400).json({ ok:false, msg:'Falta idVendedor/vendedorUid' });

    const cargaId = await getUltimaCargaId(idVendedor);
    if (!cargaId) return res.json({ ok:true, data:{ productos: [] }, msg:'Sin carga' });

    const [rows] = await db.query(
      `SELECT
          dp.producto_id,
          dp.nombre_producto AS nombre,
          dp.cantidad_inicial,
          dp.precio_unitario,
          dp.restante
       FROM detalle_pedido dp
      WHERE dp.carga_id = ?
      ORDER BY dp.nombre_producto`,
      [cargaId]
    );

    const productos = rows.map(r => ({
      id_producto: Number(r.producto_id),
      nombre: r.nombre,
      cantidad: Number(r.cantidad_inicial || 0),
      restante: Number(r.restante || 0),
      precio_unitario: r.precio_unitario != null ? Number(r.precio_unitario) : null
    }));

    return res.json({ ok:true, data:{ cargaId, productos } });
  } catch (e) {
    console.error('[getCargaActiva]', e);
    return res.status(500).json({ ok:false, msg:'Error leyendo carga' });
  }
}

/**
 * GET /vendedor/nueva-venta/clientes/por-qr/:codigo
 * → { id, nombre }
 */
export async function getClientePorCodigo(req, res) {
  try {
    const codigo = req.params.codigo;
    if (!codigo) return res.status(400).json({ ok:false, msg:'codigo requerido' });
    const [[cli]] = await db.query(
      `SELECT id, nombre_empresa AS nombre
         FROM clientes
        WHERE codigo_qr=? AND eliminado=0 LIMIT 1`,
      [codigo]
    );
    if (!cli) return res.status(404).json({ ok:false, msg:'Cliente no encontrado' });
    return res.json({ ok:true, data:{ id: Number(cli.id), nombre: cli.nombre } });
  } catch (e) {
    console.error('[getClientePorCodigo]', e);
    return res.status(500).json({ ok:false, msg:'Error buscando cliente' });
  }
}

/**
 * POST /vendedor/nueva-venta/ventas/contado
 */
export async function venderContadoCliente(req, res) {
  const conn = await db.getConnection();
  try {
    const { idVendedor, vendedorUid, clienteId, codigoQR, tipoPago, productos } = req.body || {};
    const vendedorID = await resolveVendedorId({ idVendedor, vendedorUid });
    const clienteID  = await resolveClienteId({ clienteId, codigoQR });

    if (!vendedorID) { conn.release?.(); return res.status(400).json({ ok:false, msg:'Falta idVendedor o vendedorUid' }); }
    if (!clienteID)  { conn.release?.(); return res.status(400).json({ ok:false, msg:'Falta clienteId o codigoQR' }); }
    if (!Array.isArray(productos) || !productos.length) {
      conn.release?.(); return res.status(400).json({ ok:false, msg:'Productos vacíos' });
    }

    const pricingMode = await resolvePricingModeFromCliente({ clienteId: clienteID });

    const cargaId = await getUltimaCargaId(vendedorID);
    if (!cargaId) {
      conn.release?.();
      return res.status(409).json({ ok:false, msg:'No hay carga para el vendedor' });
    }

    const mapProd = await mapProductosEnCargaPorCatNombre(productos, cargaId);

    const missing = [];
    for (const p of productos) {
      const catId = p.categoriaId || 0;
      const key = `${catId}:${norm(p.nombre)}`;
      if (!mapProd.get(key)) {
        missing.push(p.categoriaId ? `${p.nombre} (catId=${p.categoriaId})` : p.nombre);
      }
    }
    if (missing.length) {
      conn.release?.();
      return res.status(404).json({ ok:false, msg:`Producto(s) no encontrado(s): ${missing.join(', ')}` });
    }

    const productoIds = productos
      .map(p => {
        const key = `${(p.categoriaId||0)}:${norm(p.nombre)}`;
        const info = mapProd.get(key);
        return info?.id ? Number(info.id) : null;
      })
      .filter(Boolean);
    const descMap = await buildDescuentosMap({ clienteId: clienteID, productoIds });

    const detalle = [];
    let total = 0;
    for (const p of productos) {
      const catId = p.categoriaId || 0;
      const key = `${catId}:${norm(p.nombre)}`;
      const info = mapProd.get(key);
      const cant = Number(p.cantidad || 0);
      if (cant <= 0) continue;

      const precioBase = getUnitPrice(info, pricingMode);
      const dInfo = descMap.get(Number(info.id));
      const precioFinal = dInfo ? aplicarDescuento(precioBase, dInfo.pct) : precioBase;

      total += cant * precioFinal;
      detalle.push({
        id_producto: info.id,
        nombre: info.nombre,
        cantidad: cant,
        precio: precioFinal,
        descuento_pct: dInfo?.pct || 0,
        descuento_origen: dInfo?.source || null
      });
    }
    if (!detalle.length) {
      conn.release?.();
      return res.status(400).json({ ok:false, msg:'Todas las cantidades vienen en 0' });
    }

    const metodo_pago = String(tipoPago || '').toLowerCase() === 'transferencia' ? 'transferencia' : 'efectivo';
    const tipo_pago = (metodo_pago === 'transferencia') ? 'transferencia' : 'contado';

    // === marca venta de cadena/C para EXCLUIR del corte (pero sí afectar inventario)
    const isCadena = await esClienteCadena(clienteID);

    await conn.beginTransaction();

    // Stock bloqueo (usa dp.restante STORED)
    const [stocks] = await conn.query(
      `SELECT producto_id, restante
         FROM detalle_pedido
        WHERE carga_id = ?
          AND producto_id IN (${detalle.map(()=>'?').join(',')})
        FOR UPDATE`,
      [cargaId, ...detalle.map(d => d.id_producto)]
    );
    const restMap = new Map(stocks.map(r => [Number(r.producto_id), Number(r.restante || 0)]));
    const insuf = [];
    for (const d of detalle) {
      const rest = restMap.has(d.id_producto) ? restMap.get(d.id_producto) : 0;
      if (d.cantidad > rest) insuf.push(`${d.nombre}: solicitado ${d.cantidad}, disponible ${rest}`);
    }
    if (insuf.length) {
      await conn.rollback();
      conn.release?.();
      return res.status(409).json({ ok:false, msg:'Stock insuficiente', detalle: insuf });
    }

    // Insert venta (marcada)
    const [insV] = await conn.query(
      `INSERT INTO ventas (id_vendedor, id_cliente, total, tipo_pago, metodo_pago, procesada, fecha, es_cadena, excluir_corte)
       VALUES (?,?,?,?,?,0, NOW(), ?, ?)`,
      [vendedorID, clienteID, total, tipo_pago, metodo_pago, isCadena ? 1 : 0, isCadena ? 1 : 0]
    );
    const ventaId = insV.insertId;

    // detalle_venta
    for (const d of detalle) {
      await conn.query(
        `INSERT INTO detalle_venta (id_venta, id_producto, cantidad, precio) VALUES (?,?,?,?)`,
        [ventaId, d.id_producto, d.cantidad, d.precio]
      );
    }

    // Descontar de la carga real (ventas)
    for (const d of detalle) {
      await conn.query(
        `UPDATE detalle_pedido
            SET ventas = ventas + ?
          WHERE carga_id = ? AND producto_id = ?`,
        [d.cantidad, cargaId, d.id_producto]
      );
    }

    await conn.commit();
    conn.release?.();
    return res.json({ ok:true, data:{
      ventaId,
      clienteId: clienteID,
      vendedorUID: null,
      total,
      tipoPago: tipo_pago,
      pricingMode,
      fecha: new Date().toISOString(),
      esCadena: isCadena ? 1 : 0,
      excluirCorte: isCadena ? 1 : 0
    }});
  } catch (e) {
    try { await conn.rollback(); } catch {}
    conn.release?.();
    console.error('[venderContadoCliente]', e);
    return res.status(500).json({ ok:false, msg: e?.message || 'Error registrando venta' });
  }
}

/**
 * POST /vendedor/nueva-venta/ventas/credito
 * Valida política; marca cadena para no aparecer al vendedor.
 */
export async function venderCredito(req, res) {
  const conn = await db.getConnection();
  try {
    const {
      idVendedor, vendedorUid,
      clienteId, codigoQR,
      abono, productos,
      tipoPagoAbono,
      metodoPagoCredito
    } = req.body || {};

    const vendedorID = await resolveVendedorId({ idVendedor, vendedorUid });
    const clienteID  = await resolveClienteId({ clienteId, codigoQR });

    if (!vendedorID) { conn.release?.(); return res.status(400).json({ ok:false, msg:'Falta idVendedor o vendedorUid' }); }
    if (!clienteID)  { conn.release?.(); return res.status(400).json({ ok:false, msg:'Falta clienteId o codigoQR' }); }
    if (!Array.isArray(productos) || !productos.length) {
      conn.release?.(); return res.status(400).json({ ok:false, msg:'Productos vacíos' });
    }

    const pricingMode = await resolvePricingModeFromCliente({ clienteId: clienteID });

    const cargaId = await getUltimaCargaId(vendedorID);
    if (!cargaId) { conn.release?.(); return res.status(409).json({ ok:false, msg:'No hay carga para el vendedor' }); }

    const mapProd  = await mapProductosEnCargaPorCatNombre(productos, cargaId);

    const missing  = [];
    for (const p of productos) {
      const catId = p.categoriaId || 0;
      const key = `${catId}:${norm(p.nombre)}`;
      if (!mapProd.get(key)) {
        missing.push(p.categoriaId ? `${p.nombre} (catId=${p.categoriaId})` : p.nombre);
      }
    }
    if (missing.length) {
      conn.release?.(); return res.status(404).json({ ok:false, msg:`Producto(s) no encontrado(s): ${missing.join(', ')}` });
    }

    const productoIds = productos
      .map(p => {
        const key = `${(p.categoriaId||0)}:${norm(p.nombre)}`;
        const info = mapProd.get(key);
        return info?.id ? Number(info.id) : null;
      })
      .filter(Boolean);
    const descMap = await buildDescuentosMap({ clienteId: clienteID, productoIds });

    const detalle = [];
    let total = 0;
    for (const p of productos) {
      const catId = p.categoriaId || 0;
      const key = `${catId}:${norm(p.nombre)}`;
      const info = mapProd.get(key);
      const cant = Number(p.cantidad || 0);
      if (cant <= 0) continue;

      const precioBase = getUnitPrice(info, pricingMode);
      const dInfo = descMap.get(Number(info.id));
      const precioFinal = dInfo ? aplicarDescuento(precioBase, dInfo.pct) : precioBase;

      total += cant * precioFinal;
      detalle.push({
        id_producto: info.id,
        nombre: info.nombre,
        cantidad: cant,
        precio: precioFinal,
        descuento_pct: dInfo?.pct || 0,
        descuento_origen: dInfo?.source || null
      });
    }
    if (!detalle.length) {
      conn.release?.(); return res.status(400).json({ ok:false, msg:'Todas las cantidades vienen en 0' });
    }

    const abonoNum = Math.max(Number(abono || 0), 0);
    const tipoAbono = (String(tipoPagoAbono || '').toLowerCase() === 'transferencia') ? 'transferencia' : 'efectivo';
    const metodoCredito = (String(metodoPagoCredito || tipoPagoAbono || '').toLowerCase() === 'transferencia')
      ? 'transferencia' : 'efectivo';

    const pol = await getPoliticaCredito(clienteID);
    if (!pol) { conn.release?.(); return res.status(400).json({ ok:false, msg:'Cliente inválido' }); }
    if (!pol.permite_credito) {
      conn.release?.(); return res.status(403).json({ ok:false, msg:'Crédito no permitido para este cliente' });
    }
    const impactoSaldo = Math.max(total - abonoNum, 0);
    if (pol.limite_abiertos && pol.abiertos >= pol.limite_abiertos) {
      conn.release?.(); return res.status(403).json({ ok:false, msg:'Límite de créditos abiertos alcanzado' });
    }
    if (pol.limite_monto && (pol.saldo_abierto + impactoSaldo) > pol.limite_monto + EPS) {
      conn.release?.(); return res.status(403).json({ ok:false, msg:'Límite de monto de crédito excedido' });
    }

    // === marca venta de cadena/C
    const isCadena = await esClienteCadena(clienteID);

    await conn.beginTransaction();

    // Stock bloqueo (usa dp.restante STORED)
    const [stocks] = await conn.query(
      `SELECT producto_id, restante
         FROM detalle_pedido
        WHERE carga_id = ?
          AND producto_id IN (${detalle.map(()=>'?').join(',')})
        FOR UPDATE`,
      [cargaId, ...detalle.map(d => d.id_producto)]
    );
    const restMap = new Map(stocks.map(r => [Number(r.producto_id), Number(r.restante || 0)]));
    const insuf = [];
    for (const d of detalle) {
      const rest = restMap.has(d.id_producto) ? restMap.get(d.id_producto) : 0;
      if (d.cantidad > rest) insuf.push(`${d.nombre}: solicitado ${d.cantidad}, disponible ${rest}`);
    }
    if (insuf.length) {
      await conn.rollback();
      conn.release?.(); return res.status(409).json({ ok:false, msg:'Stock insuficiente', detalle: insuf });
    }

    // 1) Venta a crédito (marcada)
    const [insV] = await conn.query(
      `INSERT INTO ventas (id_vendedor, id_cliente, total, tipo_pago, metodo_pago, procesada, fecha, es_cadena, excluir_corte)
       VALUES (?,?,?,?,?,0, NOW(), ?, ?)`,
      [vendedorID, clienteID, total, 'credito', metodoCredito, isCadena ? 1 : 0, isCadena ? 1 : 0]
    );
    const ventaId = insV.insertId;

    // 2) Detalle
    for (const d of detalle) {
      await conn.query(
        `INSERT INTO detalle_venta (id_venta, id_producto, cantidad, precio)
         VALUES (?,?,?,?)`,
        [ventaId, d.id_producto, d.cantidad, d.precio]
      );
    }

    // 3) Crédito creado por trigger (con fecha_vencimiento/ocultar_vendedor si cadena)
    const [[cred]] = await conn.query(
      `SELECT id, total, saldo, fecha_vencimiento
         FROM creditos
        WHERE id_venta = ?
        LIMIT 1
        FOR UPDATE`,
      [ventaId]
    );
    if (!cred) {
      throw new Error('No se generó el crédito automáticamente (trigger faltante)');
    }
    const creditoId = cred.id;

    // 4) Abono inicial (opcional)
    if (abonoNum > 0) {
      await conn.query(
        `INSERT INTO pagos_credito (id_credito, monto, tipo_pago, procesado, fecha)
         VALUES (?,?,?, 0, NOW())`,
        [creditoId, abonoNum, tipoAbono]
      );
    }

    // 5) Descontar de la carga real
    for (const d of detalle) {
      await conn.query(
        `UPDATE detalle_pedido
            SET ventas = ventas + ?
          WHERE carga_id = ? AND producto_id = ?`,
        [d.cantidad, cargaId, d.id_producto]
      );
    }

    await conn.commit();
    conn.release?.();

    return res.json({ ok:true, data:{
      ventaId,
      clienteId: clienteID,
      vendedorUID: null,
      total,
      tipoPago: 'credito',
      metodoPagoCredito: metodoCredito,
      pricingMode,
      fecha: new Date().toISOString(),
      creditoId,
      abono: abonoNum,
      restante: Math.max(total - abonoNum, 0),
      fechaVencimiento: cred.fecha_vencimiento ?? null,
      esCadena: isCadena ? 1 : 0,
      excluirCorte: isCadena ? 1 : 0
    }});
  } catch (e) {
    try { await conn.rollback(); } catch {}
    conn.release?.();
    console.error('[venderCredito]', e);
    return res.status(500).json({ ok:false, msg: e?.message || 'Error registrando venta a crédito' });
  }
}


/**
 * GET /vendedor/nueva-venta/disponibles?idVendedor=...&clienteId=...|&codigoQR=...
 * [&group=categoria]
 */
export async function getDisponibles(req, res) {
  try {
    const idVendedor = Number(req.query.idVendedor || req.query.vendedor_id);
    const clienteID  = await resolveClienteId({ clienteId: req.query.clienteId, codigoQR: req.query.codigoQR });
    const groupMode  = String(req.query.group || '').toLowerCase();

    if (!idVendedor) return res.status(400).json({ ok:false, msg:'vendedor_id requerido' });

    const cargaId = await getUltimaCargaId(idVendedor);
    if (!cargaId) return res.json({ ok:true, data:{ productos: [] } });

    const pricingMode = await resolvePricingModeFromCliente({ clienteId: clienteID || null });

    const [rows] = await db.query(
      `SELECT
          dp.producto_id,
          dp.nombre_producto AS nombre,
          p.categoria_id,
          COALESCE(cp.nombre,'Sin categoría') AS categoria_nombre,
          p.precio, p.precio_mayoreo,
          dp.precio_unitario AS precio_unitario_dp,
          dp.restante
       FROM detalle_pedido dp
       LEFT JOIN productos p ON p.id = dp.producto_id
       LEFT JOIN categorias_productos cp ON cp.id = p.categoria_id
      WHERE dp.carga_id = ?
        AND dp.restante > 0
      ORDER BY cp.nombre, dp.nombre_producto`,
      [cargaId]
    );

    const productoIds = rows.map(r => Number(r.producto_id)).filter(Boolean);
    const descMap = await buildDescuentosMap({ clienteId: clienteID || null, productoIds });

    const toItem = (r) => {
      const precioBase = getUnitPrice(
        {
          precio: Number(r.precio || 0),
          precio_mayoreo: Number(r.precio_mayoreo || 0),
          precio_unitario_dp: r.precio_unitario_dp != null ? Number(r.precio_unitario_dp) : null
        },
        pricingMode
      );
      const dInfo = descMap.get(Number(r.producto_id));
      const precioFinal = dInfo ? aplicarDescuento(precioBase, dInfo.pct) : precioBase;

      return {
        id_producto: Number(r.producto_id),
        nombre: r.nombre,
        precio: Number(precioFinal || 0),
        restante: Number(r.restante || 0),
        descuento_pct: dInfo?.pct || 0,
        descuento_origen: dInfo?.source || null
      };
    };

    if (groupMode === 'categoria') {
      const gruposMap = new Map();
      for (const r of rows) {
        const key = r.categoria_id == null ? 'null' : String(r.categoria_id);
        if (!gruposMap.has(key)) {
          gruposMap.set(key, {
            categoria_id: r.categoria_id != null ? Number(r.categoria_id) : null,
            categoria: r.categoria_nombre || 'Sin categoría',
            productos: []
          });
        }
        gruposMap.get(key).productos.push(toItem(r));
      }

      const grupos = [...gruposMap.values()]
        .sort((a, b) => a.categoria.localeCompare(b.categoria, 'es', { sensitivity: 'base' }))
        .map(g => ({
          ...g,
          productos: g.productos.sort((a, b) =>
            a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' })
          )
        }));

      return res.json({ ok:true, data:{ grupos }, pricingMode });
    }

    const productos = rows.map(toItem);
    return res.json({ ok:true, data:{ productos }, pricingMode });
  } catch (e) {
    console.error('[getDisponibles]', e);
    res.status(500).json({ ok:false, msg:'Error al obtener disponibles' });
  }
}
