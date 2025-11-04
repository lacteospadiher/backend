// src/controllers/cambios.controller.js
import db from '../../config/db.js';

export const listCambiosByVendedor = async (req, res) => {
  const idV = Number(req.params.id);
  const { from, to } = req.query;
  const limit = Number(req.query.limit || 50);
  const offset = Number(req.query.offset || 0);

  try {
    const params = [idV];
    let where = `WHERE c.id_vendedor=?`;
    if (from) { where += ` AND c.fecha >= ?`; params.push(from); }
    if (to)   { where += ` AND c.fecha < DATE_ADD(?, INTERVAL 1 DAY)`; params.push(to); }

    const [rows] = await db.query(
      `SELECT c.*, cl.nombre_empresa AS cliente
         FROM cambios c
         JOIN clientes cl ON cl.id=c.id_cliente
       ${where}
       ORDER BY c.fecha DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'cambios_list_error', detail: e.message });
  }
};

export const createCambio = async (req, res) => {
  const { id_cliente, id_vendedor, observaciones, dev, ent } = req.body;
  // dev: [{id_producto, cantidad}], ent: [{id_producto, cantidad}]
  if (!id_cliente || !id_vendedor) return res.status(400).json({ error: 'bad_request' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [ins] = await conn.query(
      `INSERT INTO cambios (id_cliente, id_vendedor, observaciones) VALUES (?,?,?)`,
      [id_cliente, id_vendedor, observaciones || null]
    );
    const idCambio = ins.insertId;

    if (Array.isArray(dev)) {
      for (const it of dev) {
        await conn.query(
          `INSERT INTO cambios_productos_dev (id_cambio, id_producto, cantidad) VALUES (?,?,?)`,
          [idCambio, it.id_producto, it.cantidad]
        );
      }
    }
    if (Array.isArray(ent)) {
      for (const it of ent) {
        await conn.query(
          `INSERT INTO cambios_productos_ent (id_cambio, id_producto, cantidad) VALUES (?,?,?)`,
          [idCambio, it.id_producto, it.cantidad]
        );
      }
    }

    await conn.commit();

    req.app.get('io')?.to(`vendedor:${id_vendedor}`).emit('cambio:nuevo', { id: idCambio });

    res.json({ ok: true, id_cambio: idCambio });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: 'cambio_create_error', detail: e.message });
  } finally {
    conn.release();
  }
};
