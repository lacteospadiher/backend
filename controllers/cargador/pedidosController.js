// controllers/cargador/pedidosController.js
// Lista y detalle de pedidos (para Cargador). MySQL 8+ requerido.

import db from '../../config/db.js';

// ROLES
const ROL_CARGADOR   = 2;
const ROL_SUPERADMIN = 4;

// GET /api/cargador/pedidos/pendientes?page=1&limit=50
export const listPendientes = async (req, res) => {
  try {
    const rol = req.user?.rol;
    if (![ROL_CARGADOR, ROL_SUPERADMIN].includes(rol)) {
      return res.status(403).json({ msg: 'No autorizado' });
    }

    // Sanitizar paginación
    const pageRaw  = parseInt(req.query.page ?? '1', 10);
    const limitRaw = parseInt(req.query.limit ?? '50', 10);
    const page   = Number.isFinite(pageRaw)  && pageRaw  > 0 ? pageRaw  : 1;
    const limit  = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    const offset = (page - 1) * limit;

    // Fallback: si no hay detalle_pedido de la CARGA, usar pedido_detalle_hist
    const SQL = `
      SELECT
        x.id,
        x.fecha,
        x.procesado,
        x.estado,
        x.vendedor_id,
        x.vendedor_uid,
        x.vendedor_nombre,

        -- totales: si hay detalle de carga (dp), usarlo; si no, usar historial (pdh)
        CASE
          WHEN x.dp_count > 0 THEN x.dp_count
          ELSE x.pdh_count
        END AS totalItems,

        CASE
          WHEN x.dp_count > 0 THEN x.dp_sum
          ELSE x.pdh_sum
        END AS totalCantidad,

        CASE
          WHEN x.dp_count > 0 THEN x.dp_json
          ELSE x.pdh_json
        END AS productos

      FROM (
        SELECT
          p.id,
          p.fecha,
          p.procesado,
          p.estado,
          v.id      AS vendedor_id,
          u.usuario AS vendedor_uid,
          u.nombre  AS vendedor_nombre,

          -- Conteos y sumas desde detalle_pedido (por carga actual o última por pedido)
          COUNT(dp.producto_id)                 AS dp_count,
          COALESCE(SUM(dp.cantidad_inicial),0)  AS dp_sum,
          CASE
            WHEN COUNT(dp.producto_id)=0 THEN JSON_ARRAY()
            ELSE JSON_ARRAYAGG(
              JSON_OBJECT(
                'nombre',   dp.nombre_producto,
                'cantidad', dp.cantidad_inicial
              )
            )
          END AS dp_json,

          -- Conteos y sumas desde pedido_detalle_hist (fallback)
          COUNT(pdh.producto_id)                AS pdh_count,
          COALESCE(SUM(pdh.cantidad_solicitada),0) AS pdh_sum,
          CASE
            WHEN COUNT(pdh.producto_id)=0 THEN JSON_ARRAY()
            ELSE JSON_ARRAYAGG(
              JSON_OBJECT(
                'nombre',   pdh.nombre_producto,
                'cantidad', pdh.cantidad_solicitada
              )
            )
          END AS pdh_json

        FROM pedidos p
        JOIN vendedores v ON v.id = p.id_vendedor
        JOIN usuarios  u  ON u.id = v.id_usuario

        LEFT JOIN (
          SELECT MAX(id) AS id, pedido_id
          FROM cargas
          GROUP BY pedido_id
        ) c
          ON c.pedido_id = p.id

        -- detalle de la CARGA (si existiera)
        LEFT JOIN detalle_pedido dp
          ON dp.carga_id = COALESCE(p.carga_id, c.id)

        -- Fallback a historial original del pedido
        LEFT JOIN pedido_detalle_hist pdh
          ON pdh.pedido_id = p.id

        WHERE p.procesado = 0
        GROUP BY p.id, p.fecha, p.procesado, p.estado, v.id, u.usuario, u.nombre
      ) AS x
      ORDER BY x.fecha DESC
      LIMIT ${offset}, ${limit}
    `;

    const [rows] = await db.query(SQL);

    const items = rows.map(r => {
      const fecha = r.fecha ? new Date(r.fecha) : null;
      let productos = [];
      try { productos = JSON.parse(r.productos || '[]'); } catch { productos = []; }

      return {
        id: Number(r.id),
        vendedorId: Number(r.vendedor_id),
        vendedorUid: r.vendedor_uid || '',
        vendedorNombre: r.vendedor_nombre || '',
        fechaIso: fecha ? fecha.toISOString() : null,
        fechaUnix: fecha ? Math.floor(fecha.getTime() / 1000) : null,
        totalItems: Number(r.totalItems) || 0,
        totalCantidad: Number(r.totalCantidad) || 0,
        productos, // [{nombre, cantidad}]
        procesado: !!r.procesado,
        estado: r.estado
      };
    });

    res.json({ page, limit, count: items.length, items });
  } catch (err) {
    console.error('listPendientes error:', err);
    res.status(500).json({ msg: 'Error del servidor' });
  }
};

// GET /api/cargador/pedidos/:id
export const getPedido = async (req, res) => {
  try {
    const rol = req.user?.rol;
    if (![ROL_CARGADOR, ROL_SUPERADMIN].includes(rol)) {
      return res.status(403).json({ msg: 'No autorizado' });
    }

    const { id } = req.params;

    // Si no hay detalle de carga (dp), regresamos el historial original (pdh)
    const SQL = `
      SELECT
        p.id,
        p.fecha,
        p.procesado,
        p.estado,
        p.total,
        p.observaciones,
        v.id      AS vendedor_id,
        u.usuario AS vendedor_uid,
        u.nombre  AS vendedor_nombre,

        CASE
          WHEN COUNT(dp.producto_id) > 0 THEN
            JSON_ARRAYAGG(
              JSON_OBJECT(
                'producto_id',     dp.producto_id,
                'nombre',          dp.nombre_producto,
                'cantidad',        dp.cantidad_inicial,
                'precio_unitario', dp.precio_unitario
              )
            )
          ELSE
            JSON_ARRAYAGG(
              JSON_OBJECT(
                'producto_id',     pdh.producto_id,
                'nombre',          pdh.nombre_producto,
                'cantidad',        pdh.cantidad_solicitada,
                'precio_unitario', pdh.precio_unitario
              )
            )
        END AS detalle

      FROM pedidos p
      JOIN vendedores v ON v.id = p.id_vendedor
      JOIN usuarios  u  ON u.id = v.id_usuario

      LEFT JOIN (
        SELECT MAX(id) AS id, pedido_id
        FROM cargas
        GROUP BY pedido_id
      ) c
        ON c.pedido_id = p.id

      LEFT JOIN detalle_pedido dp
        ON dp.carga_id = COALESCE(p.carga_id, c.id)

      LEFT JOIN pedido_detalle_hist pdh
        ON pdh.pedido_id = p.id

      WHERE p.id = ?
      GROUP BY p.id, p.fecha, p.procesado, p.estado, p.total, p.observaciones, v.id, u.usuario, u.nombre
    `;

    const [rows] = await db.execute(SQL, [id]);
    if (rows.length === 0) return res.status(404).json({ msg: 'Pedido no encontrado' });

    const r = rows[0];
    const fecha = r.fecha ? new Date(r.fecha) : null;

    let detalle = [];
    try { detalle = JSON.parse(r.detalle || '[]'); } catch { detalle = []; }

    res.json({
      id: Number(r.id),
      vendedorId: Number(r.vendedor_id),
      vendedorUid: r.vendedor_uid || '',
      vendedorNombre: r.vendedor_nombre || '',
      fechaIso: fecha ? fecha.toISOString() : null,
      fechaUnix: fecha ? Math.floor(fecha.getTime() / 1000) : null,
      procesado: !!r.procesado,
      estado: r.estado,
      total: Number(r.total) || 0,
      observaciones: r.observaciones || null,
      detalle // [{producto_id, nombre, cantidad, precio_unitario}]
    });
  } catch (err) {
    console.error('getPedido error:', err);
    res.status(500).json({ msg: 'Error del servidor' });
  }
};

// POST /api/cargador/pedidos/:id/marcar-procesado
export const marcarProcesado = async (req, res) => {
  try {
    const rol = req.user?.rol;
    if (![ROL_CARGADOR, ROL_SUPERADMIN].includes(rol)) {
      return res.status(403).json({ msg: 'No autorizado' });
    }
    const { id } = req.params;

    const [upd] = await db.execute(`UPDATE pedidos SET procesado = 1 WHERE id = ?`, [id]);
    if (upd.affectedRows === 0) return res.status(404).json({ msg: 'Pedido no encontrado' });

    res.json({ ok: true });
  } catch (err) {
    console.error('marcarProcesado error:', err);
    res.status(500).json({ msg: 'Error del servidor' });
  }
};
