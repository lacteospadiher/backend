// controllers/clientesHistorialController.js
import db from '../../config/db.js';

export const historialComprasCliente = async (req, res) => {
  try {
    const clienteId = Number(req.params.clienteId);
    if (!Number.isFinite(clienteId) || clienteId <= 0) {
      return res.status(400).json({ error: 'clienteId inválido' });
    }

    let { desde, hasta, vendedor_id, page = 1, limit = 50 } = req.query;

    // saneo de paginación
    page = Number(page) || 1;
    limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const offset = (page - 1) * limit;

    const where = ['v.id_cliente = ?'];
    const params = [clienteId];

    if (desde) { where.push('v.fecha >= ?'); params.push(`${desde} 00:00:00`); }
    if (hasta) { where.push('v.fecha <= ?'); params.push(`${hasta} 23:59:59`); }

    const vendedorIdNum = Number(vendedor_id);
    if (Number.isFinite(vendedorIdNum) && vendedorIdNum > 0) {
      where.push('v.id_vendedor = ?');
      params.push(vendedorIdNum);
    }

    const sql = `
      SELECT v.id, v.fecha, v.total, v.tipo_pago,
             u.nombre AS vendedor
      FROM ventas v
      JOIN vendedores ve ON ve.id = v.id_vendedor
      JOIN usuarios   u  ON u.id = ve.id_usuario
      WHERE ${where.join(' AND ')}
      ORDER BY v.fecha DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await db.query(sql, [...params, limit, offset]);

    // Mantenemos exactamente el mismo formato que ya consume el front (array simple):
    res.json(
      rows.map(r => ({
        id: r.id,
        fecha: r.fecha,
        total: Number(r.total),
        tipo_pago: r.tipo_pago,
        vendedor: r.vendedor
      }))
    );
  } catch (e) {
    console.error('historialComprasCliente', e);
    res.status(500).json({ error: 'Error al obtener historial' });
  }
};

export const detalleVenta = async (req, res) => {
  try {
    const ventaId = Number(req.params.ventaId);
    if (!Number.isFinite(ventaId) || ventaId <= 0) {
      return res.status(400).json({ error: 'ventaId inválido' });
    }

    const [items] = await db.query(
      `
      SELECT
        dv.id_producto,
        p.nombre,
        dv.cantidad,
        dv.precio AS precio_unitario,
        (dv.cantidad * dv.precio) AS subtotal
      FROM detalle_venta dv
      JOIN productos p ON p.id = dv.id_producto
      WHERE dv.id_venta = ?
      ORDER BY dv.id
      `,
      [ventaId]
    );

    res.json(
      items.map(it => ({
        id_producto: it.id_producto,
        nombre: it.nombre,
        cantidad: Number(it.cantidad),
        precio_unitario: Number(it.precio_unitario),
        subtotal: Number(it.subtotal)
      }))
    );
  } catch (e) {
    console.error('detalleVenta', e);
    res.status(500).json({ error: 'Error al obtener detalle de venta' });
  }
};
