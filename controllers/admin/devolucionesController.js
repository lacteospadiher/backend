// src/controllers/devoluciones.controller.js
import db from '../../config/db.js';

export const listDevolucionesByVendedor = async (req, res) => {
  const idV = Number(req.params.id);
  const { from, to } = req.query;
  const limit = Number(req.query.limit || 50);
  const offset = Number(req.query.offset || 0);

  try {
    const params = [idV];
    let where = `WHERE d.id_vendedor=?`;
    if (from) { where += ` AND d.fecha >= ?`; params.push(from); }
    if (to)   { where += ` AND d.fecha < DATE_ADD(?, INTERVAL 1 DAY)`; params.push(to); }

    const [rows] = await db.query(
      `SELECT d.*, c.nombre_empresa AS cliente
         FROM devoluciones d
    LEFT JOIN clientes c ON c.id = d.id_cliente
       ${where}
       ORDER BY d.fecha DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'devoluciones_list_error', detail: e.message });
  }
};

export const createDevolucion = async (req, res) => {
  const { id_vendedor, id_cliente, id_venta, motivo, observaciones, detalle } = req.body; // detalle: [{id_producto,cantidad,motivo}]
  if (!id_vendedor || !Array.isArray(detalle) || detalle.length === 0) {
    return res.status(400).json({ error: 'bad_request' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [insDev] = await conn.query(
      `INSERT INTO devoluciones (id_cliente, id_vendedor, id_venta, motivo, observaciones)
       VALUES (?,?,?,?,?)`,
      [id_cliente || null, id_vendedor, id_venta || null, motivo || null, observaciones || null]
    );
    const idDevolucion = insDev.insertId;

    for (const it of detalle) {
      await conn.query(
        `INSERT INTO devolucion_detalle (id_devolucion, id_producto, cantidad, motivo)
         VALUES (?,?,?,?)`,
        [idDevolucion, it.id_producto, it.cantidad, it.motivo || 'otro']
      );
    }

    await conn.commit();

    // tiempo real
    req.app.get('io')?.to(`vendedor:${id_vendedor}`).emit('devolucion:nueva', { id: idDevolucion });

    res.json({ ok: true, id_devolucion: idDevolucion });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: 'devolucion_create_error', detail: e.message });
  } finally {
    conn.release();
  }
};
