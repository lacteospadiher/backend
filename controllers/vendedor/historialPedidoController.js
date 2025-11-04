// controllers/vendedor/historialPedidoController.js
import db from '../../config/db.js';

/* =============================
   Helpers de respuesta
   ============================= */
const ok  = (res, data, msg = null) => res.json({ ok: true,  msg, data });
const bad = (res, code, msg)       => res.status(code).json({ ok: false, msg });

/* =============================
   Reglas de edición (simple y directo)
   ============================= */
function getEdicionInfo(pedRow) {
  if (!pedRow) return { bloqueado: true, motivo: 'No existe el pedido' };

  if (Number(pedRow.procesado) === 1)               return { bloqueado: true, motivo: 'Pedido procesado' };
  if (Number(pedRow.listo_para_pedido_gral) === 1)  return { bloqueado: true, motivo: 'Listo para pedido general' };
  if (pedRow.carga_id != null)                      return { bloqueado: true, motivo: 'Carga registrada en camioneta' };

  return { bloqueado: false, motivo: null };
}

/* =========================================================
   GET /api/vendedor/pedidos/productos
   Catálogo oficial (con filtro q) -> usa productos.precio
   ========================================================= */
export async function listarProductosSimples(req, res) {
  const { q } = req.query;
  const like = q && q.trim() ? `%${q.trim()}%` : null;

  const sql = `
    SELECT
      p.id,
      p.nombre,
      COALESCE(p.precio, 0) AS precio
    FROM productos p
    WHERE p.activo = 1
      ${like ? 'AND p.nombre LIKE ?' : ''}
    ORDER BY p.nombre
    LIMIT 500
  `;

  try {
    const [rows] = await db.query(sql, like ? [like] : []);
    return ok(res, rows);
  } catch (e) {
    console.error('listarProductosSimples error:', e);
    return bad(res, 500, 'No se pudo cargar el catálogo');
  }
}

/* =========================================================
   GET /api/vendedor/pedidos
   Lista encabezados + preview (3) desde historial
   ========================================================= */
export async function listarHistorialPedidos(req, res) {
  const limit = Math.max(1, Math.min(Number(req.query.limit || 100), 200));
  try {
    const [rows] = await db.query(
      `SELECT
         p.id,
         p.id_vendedor                   AS vendedorId,
         p.fecha,
         p.total,
         p.estado,
         p.procesado,
         p.carga_id,
         p.listo_para_pedido_gral,
         p.lista_para_excel,
         u.nombre                        AS vendedorNombre
       FROM pedidos p
       LEFT JOIN vendedores v ON v.id = p.id_vendedor
       LEFT JOIN usuarios u   ON u.id = v.id_usuario
       ORDER BY p.fecha DESC
       LIMIT ?`,
      [limit]
    );

    const data = [];
    for (const r of rows) {
      const [det] = await db.query(
        `SELECT
           producto_id           AS productoId,
           nombre_producto       AS nombre,
           cantidad_solicitada   AS cantidad,
           precio_unitario       AS precio
         FROM pedido_detalle_hist
         WHERE pedido_id = ?
         ORDER BY id ASC
         LIMIT 3`,
        [r.id]
      );

      const preview = (det || []).map(x => ({
        productoId: Number(x.productoId),
        nombre: x.nombre,
        cantidad: Number(x.cantidad) || 0,
        precio: Number(x.precio) || 0,
      }));

      const lock = getEdicionInfo(r);
      data.push({
        id: String(r.id),
        vendedorUid: r.vendedorNombre || `Vendedor ${r.vendedorId}`,
        fechaIso: r.fecha ? new Date(r.fecha).toISOString() : null,
        totalItems: preview.length,
        totalCantidad: preview.reduce((s, it) => s + (it.cantidad || 0), 0),
        productos: preview,
        cargaHecha: r.carga_id != null,
        estado: r.estado || 'pendiente',
        idVenta: null,
        puedeEditar: !lock.bloqueado,
        editableHasta: null
      });
    }

    return ok(res, data);
  } catch (e) {
    console.error('listarHistorialPedidos error:', e);
    return bad(res, 500, 'No se pudo listar el historial');
  }
}

/* =========================================================
   GET /api/vendedor/pedidos/:pedidoId
   Encabezado + todas las líneas (historial) + puedeEditar
   ========================================================= */
export async function obtenerPedido(req, res) {
  const { pedidoId } = req.params;
  try {
    const [encRows] = await db.query(
      `SELECT p.id, p.fecha, p.id_vendedor AS vendedorId, p.estado, p.procesado, p.carga_id,
              p.listo_para_pedido_gral, p.lista_para_excel,
              COALESCE(u.nombre, CONCAT('Vendedor ', p.id_vendedor)) AS vendedorNombre
       FROM pedidos p
       LEFT JOIN vendedores v ON v.id = p.id_vendedor
       LEFT JOIN usuarios  u  ON u.id = v.id_usuario
       WHERE p.id = ?
       LIMIT 1`,
      [pedidoId]
    );
    const enc = encRows?.[0];
    if (!enc) return bad(res, 404, 'Pedido no encontrado');

    const [lineas] = await db.query(
      `SELECT
         producto_id           AS productoId,
         nombre_producto       AS nombre,
         cantidad_solicitada   AS cantidad,
         precio_unitario       AS precio
       FROM pedido_detalle_hist
       WHERE pedido_id = ?
       ORDER BY id ASC`,
      [pedidoId]
    );

    const productos = (lineas || []).map(r => ({
      productoId: Number(r.productoId),
      nombre: r.nombre,
      cantidad: Number(r.cantidad) || 0,
      precio: Number(r.precio) || 0,
    }));

    const totalItems = productos.length;
    const totalCantidad = productos.reduce((s, r) => s + (r.cantidad || 0), 0);

    const lock = getEdicionInfo(enc);

    const dto = {
      id: String(pedidoId),
      vendedorUid: enc.vendedorNombre || '',
      fechaIso: enc.fecha ? new Date(enc.fecha).toISOString() : null,
      totalItems,
      totalCantidad,
      productos,
      cargaHecha: enc.carga_id != null,
      estado: enc.estado || 'pendiente',
      idVenta: null,
      puedeEditar: !lock.bloqueado,
      editableHasta: null
    };

    return ok(res, dto);
  } catch (e) {
    console.error('obtenerPedido error:', e);
    return bad(res, 500, 'No se pudo obtener el pedido');
  }
}

/* =========================================================
   GET /api/vendedor/pedidos/:pedidoId/bloqueado
   Solo (procesado, listo_para_pedido_gral, carga_id)
   ========================================================= */
export async function estaBloqueado(req, res) {
  const { pedidoId } = req.params;
  try {
    const [rows] = await db.query(
      `SELECT id, procesado, listo_para_pedido_gral, carga_id
       FROM pedidos
       WHERE id = ?
       LIMIT 1`,
      [pedidoId]
    );
    const ped = rows?.[0];
    if (!ped) return ok(res, { bloqueado: true, motivo: 'No existe', editableHasta: null, editableHastaISO: null });

    const info = getEdicionInfo(ped);
    return ok(res, {
      bloqueado: info.bloqueado,
      motivo: info.motivo,
      editableHasta: null,
      editableHastaISO: null
    });
  } catch (e) {
    console.error('estaBloqueado error:', e);
    return bad(res, 500, e?.message || 'Error validando bloqueo');
  }
}

/* =========================================================
   PUT /api/vendedor/pedidos/:pedidoId
   Reemplazo total del historial + recálculo de total
   (sin escribir en columna generada subtotal_solicitado)
   ========================================================= */
export async function actualizarPedido(req, res) {
  const conn = await db.getConnection();
  try {
    const pedidoId = Number(req.params.pedidoId || 0);
    if (!Number.isFinite(pedidoId) || pedidoId <= 0) {
      return bad(res, 400, 'pedidoId inválido');
    }

    const productosReq = Array.isArray(req.body?.productos) ? req.body.productos : [];
    if (!productosReq.length) return bad(res, 400, 'Productos vacíos');

    // Valida bloqueo con tus 3 reglas
    const [pedRows] = await db.query(
      `SELECT id, procesado, listo_para_pedido_gral, carga_id
       FROM pedidos
       WHERE id = ?
       LIMIT 1`,
      [pedidoId]
    );
    const ped = pedRows?.[0];
    if (!ped) return bad(res, 404, 'Pedido no existe');

    const lockInfo = getEdicionInfo(ped);
    if (lockInfo.bloqueado) {
      return bad(res, 409, lockInfo.motivo || 'Pedido bloqueado para edición');
    }

    // Normaliza y agrupa
    const acum = new Map();
    for (const it of productosReq) {
      const pid = Number(it.productoId || 0);
      const cant = Number(it.cantidad || 0);
      if (!Number.isFinite(pid) || pid <= 0)  return bad(res, 400, `productoId inválido: ${it.productoId}`);
      if (!Number.isFinite(cant) || cant <= 0) return bad(res, 400, `Cantidad inválida para producto ${pid}`);
      acum.set(pid, (acum.get(pid) || 0) + cant);
    }
    if (!acum.size) return bad(res, 400, 'Sin líneas válidas');

    const ids = [...acum.keys()];
    const place = ids.map(() => '?').join(',');

    // Fallback: si no hay último precio en historial, usa productos.precio
    const preciosSql = `
      WITH ult AS (
        SELECT
          producto_id,
          nombre_producto,
          precio_unitario,
          ROW_NUMBER() OVER (PARTITION BY producto_id ORDER BY creado_en DESC, id DESC) AS rn
        FROM pedido_detalle_hist
        WHERE producto_id IN (${place})
      )
      SELECT
        p.id AS producto_id,
        COALESCE(u.nombre_producto, p.nombre)         AS nombre_producto,
        COALESCE(u.precio_unitario, p.precio, 0)      AS precio_unitario
      FROM productos p
      LEFT JOIN ult u
        ON u.producto_id = p.id AND u.rn = 1
      WHERE p.id IN (${place})
    `;

    await conn.beginTransaction();

    const [precios] = await conn.query(preciosSql, [...ids, ...ids]);
    const byId = new Map(precios.map(r => [Number(r.producto_id), r]));

    // Reemplazo total del historial para el pedido
    await conn.query(
      'DELETE FROM pedido_detalle_hist WHERE pedido_id = ?',
      [pedidoId]
    );

    // Inserción (SIN subtotal_solicitado) y recálculo de total
    let total = 0;
    for (const [pid, cantidad] of acum.entries()) {
      const meta = byId.get(pid);
      if (!meta) {
        await conn.rollback();
        return bad(res, 400, `Producto ${pid} no existe en catálogo`);
      }
      const nombre = meta.nombre_producto;
      const precio = Number(meta.precio_unitario ?? 0);
      const subtotal = +(cantidad * precio).toFixed(2);

      await conn.query(
        `INSERT INTO pedido_detalle_hist
         (pedido_id, producto_id, nombre_producto, cantidad_solicitada, precio_unitario, creado_en)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [pedidoId, pid, nombre, cantidad, precio]
      );

      total += subtotal;
    }

    // Actualiza total del pedido
    await conn.query(
      `UPDATE pedidos
       SET total = ?
       WHERE id = ?`,
      [+(total.toFixed(2)), pedidoId]
    );

    await conn.commit();
    return ok(res, { pedidoId, total: +(total.toFixed(2)) }, 'Pedido actualizado');
  } catch (e) {
    try { await conn.rollback(); } catch {}
    console.error('actualizarPedido error:', e);
    return bad(res, 500, e?.message || 'Error actualizando pedido');
  } finally {
    try { conn.release(); } catch {}
  }
}
