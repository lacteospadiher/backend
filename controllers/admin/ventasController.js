// controllers/admin/ventasController.js
import db from '../../config/db.js';

const ensurePublico = async (conn) => {
  const [[row]] = await conn.query(`SELECT id FROM clientes WHERE clave='PUBLICO' LIMIT 1`);
  if (row) return row.id;
  const [ins] = await conn.query(
    `INSERT INTO clientes (clave, nombre_empresa, permite_credito, activo, eliminado)
     VALUES ('PUBLICO','PÚBLICO GENERAL',0,1,0)`
  );
  return ins.insertId;
};

export const crearVentaPublico = async (req, res) => {
  const { idVendedor, items, total, tipo_pago = 'contado', descuento_total = 0, id_ruta = null } = req.body;

  // Validaciones básicas
  if (!idVendedor || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'bad_request', detail: 'idVendedor e items son requeridos' });
  }
  if (tipo_pago === 'credito') {
    return res.status(400).json({ error: 'publico_no_credito', detail: 'PUBLICO no permite crédito' });
  }

  for (const it of items) {
    if (!it?.id_producto || Number(it.cantidad) <= 0 || Number(it.precio_unitario) < 0) {
      return res.status(400).json({ error: 'bad_items', detail: 'Revisa id_producto, cantidad y precio_unitario' });
    }
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const idClientePublico = await ensurePublico(conn);

    const [insV] = await conn.query(
      `INSERT INTO ventas (id_cliente, id_vendedor, id_ruta, total, tipo_pago, descuento_total, pagado)
       VALUES (?,?,?,?,?,?,?)`,
      [idClientePublico, idVendedor, id_ruta, total, tipo_pago, descuento_total, 1] // contado/transfer = pagado
    );
    const idVenta = insV.insertId;

    // detalle
    for (const it of items) {
      await conn.query(
        `INSERT INTO detalle_venta (id_venta, id_producto, cantidad, precio_unitario, descuento_unitario)
         VALUES (?,?,?,?,?)`,
        [idVenta, it.id_producto, it.cantidad, it.precio_unitario, it.descuento_unitario || 0]
      );
    }

    await conn.commit();

    // 🔔 Notifica en tiempo real
    try {
      req.app.get('io')?.to(`vendedor:${idVendedor}`).emit('venta:nueva', { id: idVenta, publico: true });
    } catch {}

    res.json({ ok: true, id_venta: idVenta });
  } catch (e) {
    await conn.rollback();
    console.error('crearVentaPublico', e);
    res.status(500).json({ error: 'venta_publico_error', detail: e.message });
  } finally {
    conn.release();
  }
};

// 👇 alias para tu import actual
export { crearVentaPublico as createVentaPublico };
