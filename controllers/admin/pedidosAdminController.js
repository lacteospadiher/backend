// controllers/admin/pedidosAdminController.js
import db from '../../config/db.js';

// GET /api/admin/pedidos/pendientes?page=1&limit=100
export async function listPendientes(req, res) {
  try {
    const page  = Math.max(parseInt(req.query.page  ?? '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '50', 10), 1), 200);
    const offset = (page - 1) * limit;

    // Subconsulta para armar el resumen por pedido
    const SQL = `
      SELECT
        x.id,
        x.fecha,
        x.procesado,
        x.estado,
        x.vendedor_id,
        x.vendedor_nombre,
        x.totalItems,
        x.totalCantidad,
        x.productos
      FROM (
        SELECT
          p.id,
          p.fecha,
          p.procesado,
          p.estado,
          v.id       AS vendedor_id,
          u.nombre   AS vendedor_nombre,
          COUNT(dp.id_producto)           AS totalItems,
          COALESCE(SUM(dp.cantidad), 0)   AS totalCantidad,
          CASE
            WHEN COUNT(dp.id_producto)=0 THEN JSON_ARRAY()
            ELSE JSON_ARRAYAGG(JSON_OBJECT('nombre', pr.nombre, 'cantidad', dp.cantidad))
          END AS productos
        FROM pedidos p
        JOIN vendedores v           ON v.id = p.id_vendedor
        JOIN usuarios   u           ON u.id = v.id_usuario
        LEFT JOIN detalle_pedido dp ON dp.id_pedido = p.id
        LEFT JOIN productos pr      ON pr.id        = dp.id_producto
        WHERE p.procesado = 0
        GROUP BY p.id, p.fecha, p.procesado, p.estado, v.id, u.nombre
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
        id: r.id,
        vendedorId: r.vendedor_id,
        vendedorNombre: r.vendedor_nombre || '',
        fechaUnix: fecha ? Math.floor(fecha.getTime() / 1000) : null,
        totalItems: Number(r.totalItems) || 0,
        totalCantidad: Number(r.totalCantidad) || 0,
        productos, // [{nombre, cantidad}]
      };
    });

    // total para paginación
    const [[cnt]] = await db.query(
      `SELECT COUNT(*) AS total FROM pedidos WHERE procesado = 0`
    );

    return res.json({ ok: true, data: { items, page, limit, total: cnt.total } });
  } catch (err) {
    console.error('listPendientes(admin) error:', err);
    return res.status(500).json({ ok: false, msg: 'Error al listar pedidos pendientes' });
  }
}

// POST /api/admin/pedidos/:id/procesar
export async function marcarProcesado(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, msg: 'id inválido' });

    const [upd] = await db.execute(
      `UPDATE pedidos SET procesado = 1 WHERE id = ? AND procesado = 0`,
      [id]
    );
    if (upd.affectedRows === 0) {
      return res.status(404).json({ ok: false, msg: 'Pedido no encontrado o ya procesado' });
    }

    return res.json({ ok: true, data: { id }, msg: 'Procesado' });
  } catch (err) {
    console.error('marcarProcesado(admin) error:', err);
    return res.status(500).json({ ok: false, msg: 'Error al procesar pedido' });
  }
}
