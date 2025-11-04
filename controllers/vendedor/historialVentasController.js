// controllers/vendedor/historialVentasController.js
import db from '../../config/db.js';

/**
 * GET /api/vendedor/historial-ventas?cliente_id=#&cliente_qr=STR&limit=#
 */
export async function getVentasPorCliente(req, res) {
  try {
    const rawClienteId = req.query.cliente_id;
    const rawClienteQr = (req.query.cliente_qr || '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 1000);

    let clienteId = Number(rawClienteId || 0);
    let clienteIdFromQr = undefined;

    // Si viene cliente_qr, resolver a id antes de consultar ventas
    if (rawClienteQr) {
      const [[qrRow]] = await db.query(
        `SELECT id FROM clientes WHERE codigo_qr = ? LIMIT 1`,
        [rawClienteQr]
      );
      if (qrRow && Number.isFinite(Number(qrRow.id))) {
        clienteIdFromQr = Number(qrRow.id);
      }
    }

    // Si no venía cliente_id válido, intenta con el del QR (sin usar "!")
    if ((!Number.isFinite(clienteId) || clienteId <= 0) && Number.isFinite(clienteIdFromQr)) {
      clienteId = Number(clienteIdFromQr);
    }

    if (!Number.isFinite(clienteId) || clienteId <= 0) {
      return res.status(400).json({ message: 'cliente_id inválido' });
    }

    // 1) Cabeceras (conforme al esquema actual: ventas.id_cliente)
    const sqlVentasById = `
      SELECT v.id,
             v.fecha,
             v.id_vendedor,
             v.id_cliente AS id_cliente,
             v.total,
             v.tipo_pago,
             v.metodo_pago,
             0 AS es_devolucion,
             u.nombre AS vendedor_nombre,
             c.nombre_empresa AS cliente_nombre
        FROM ventas v
   LEFT JOIN vendedores ve ON ve.id = v.id_vendedor
   LEFT JOIN usuarios  u   ON u.id = ve.id_usuario
   LEFT JOIN clientes  c   ON c.id = v.id_cliente
       WHERE v.id_cliente = ?
       ORDER BY v.fecha DESC, v.id DESC
       LIMIT ?`;

    const [ventasById] = await db.query(sqlVentasById, [clienteId, limit]);
    let ventas = ventasById;

    // 2) Fallback: si no hay filas y venía QR, filtra por QR vía JOIN
    if (ventas.length === 0 && rawClienteQr) {
      const sqlVentasByQr = `
        SELECT v.id,
               v.fecha,
               v.id_vendedor,
               v.id_cliente AS id_cliente,
               v.total,
               v.tipo_pago,
               v.metodo_pago,
               0 AS es_devolucion,
               u.nombre AS vendedor_nombre,
               c.nombre_empresa AS cliente_nombre
          FROM ventas v
     LEFT JOIN vendedores ve ON ve.id = v.id_vendedor
     LEFT JOIN usuarios  u   ON u.id = ve.id_usuario
     LEFT JOIN clientes  c   ON c.id = v.id_cliente
         WHERE c.codigo_qr = ?
         ORDER BY v.fecha DESC, v.id DESC
         LIMIT ?`;
      const [ventasQr] = await db.query(sqlVentasByQr, [rawClienteQr, limit]);
      ventas = ventasQr;
    }

    if (ventas.length === 0) return res.json([]);

    const ventaIds = ventas.map(v => v.id);

    // 3) Detalle por venta
    const [det] = await db.query(
      `SELECT dv.id_venta,
              dv.id_producto   AS producto_id,
              p.nombre         AS nombre,
              dv.cantidad,
              dv.precio,
              (dv.cantidad * dv.precio) AS subtotal
         FROM detalle_venta dv
    LEFT JOIN productos p ON p.id = dv.id_producto
        WHERE dv.id_venta IN (?)`,
      [ventaIds]
    );

    // 4) Abonos por venta
    const [abonos] = await db.query(
      `SELECT v.id AS id_venta, COALESCE(SUM(pc.monto),0) AS abono
         FROM ventas v
    LEFT JOIN creditos cr ON cr.id_venta = v.id
    LEFT JOIN pagos_credito pc ON pc.id_credito = cr.id
        WHERE v.id IN (?)
        GROUP BY v.id`,
      [ventaIds]
    );
    const abonoMap = new Map(abonos.map(a => [a.id_venta, Number(a.abono)]));

    // 5) Subtotales y agrupación
    const subtotalPorVenta = det.reduce((acc, r) => {
      acc[r.id_venta] = (acc[r.id_venta] || 0) + Number(r.subtotal || 0);
      return acc;
    }, {});

    const detByVenta = det.reduce((acc, r) => {
      (acc[r.id_venta] ||= []).push({
        producto_id: r.producto_id,
        nombre: r.nombre || '',
        cantidad: Number(r.cantidad || 0),
        precio: Number(r.precio || 0),
        subtotal: Number(r.subtotal || 0),
      });
      return acc;
    }, {});

    // 6) Respuesta
    const resp = ventas.map(v => ({
      id: v.id,
      fecha: v.fecha,
      fecha_iso: v.fecha,
      cliente_nombre: v.cliente_nombre || '',
      tipo_pago: v.tipo_pago || '',
      metodo_pago: v.metodo_pago || '',
      es_devolucion: !!v.es_devolucion,
      subtotal: Number(subtotalPorVenta[v.id] || 0),
      total: Number(v.total || 0),
      abono: Number(abonoMap.get(v.id) || 0),
      vendedor_id: v.id_vendedor,
      vendedor_nombre: v.vendedor_nombre || '',
      productos: detByVenta[v.id] || [],
    }));

    res.json(resp);
  } catch (e) {
    console.error('[getVentasPorCliente]', e);
    res.status(500).json({ message: 'Error obteniendo ventas del cliente' });
  }
}

/**
 * GET /api/vendedor/historial-ventas/:ventaId
 */
export async function getVentaById(req, res) {
  try {
    const ventaId = Number(req.params.ventaId || 0);
    if (!Number.isFinite(ventaId) || ventaId <= 0) {
      return res.status(400).json({ message: 'ventaId inválido' });
    }

    const [[v]] = await db.query(
      `SELECT v.id,
              v.fecha,
              v.id_vendedor,
              v.id_cliente AS id_cliente,
              v.total,
              v.tipo_pago,
              v.metodo_pago,
              0 AS es_devolucion,
              u.nombre AS vendedor_nombre,
              c.nombre_empresa AS cliente_nombre
         FROM ventas v
    LEFT JOIN vendedores ve ON ve.id = v.id_vendedor
    LEFT JOIN usuarios  u   ON u.id = ve.id_usuario
    LEFT JOIN clientes  c   ON c.id = v.id_cliente
        WHERE v.id = ?
        LIMIT 1`,
      [ventaId]
    );
    if (!v) return res.status(404).json({ message: 'Venta no encontrada' });

    const [productos] = await db.query(
      `SELECT dv.id_producto   AS producto_id,
              p.nombre         AS nombre,
              dv.cantidad,
              dv.precio,
              (dv.cantidad * dv.precio) AS subtotal
         FROM detalle_venta dv
    LEFT JOIN productos p ON p.id = dv.id_producto
        WHERE dv.id_venta = ?`,
      [ventaId]
    );

    const [[ab]] = await db.query(
      `SELECT COALESCE(SUM(pc.monto),0) AS abono
         FROM creditos cr
    LEFT JOIN pagos_credito pc ON pc.id_credito = cr.id
        WHERE cr.id_venta = ?`,
      [ventaId]
    );

    const subtotal = productos.reduce((s, r) => s + Number(r.subtotal || 0), 0);

    res.json({
      id: v.id,
      fecha: v.fecha,
      fecha_iso: v.fecha,
      cliente_nombre: v.cliente_nombre || '',
      tipo_pago: v.tipo_pago || '',
      metodo_pago: v.metodo_pago || '',
      es_devolucion: !!v.es_devolucion,
      subtotal: Number(subtotal || 0),
      total: Number(v.total || 0),
      abono: Number(ab?.abono || 0),
      vendedor_id: v.id_vendedor,
      vendedor_nombre: v.vendedor_nombre || '',
      productos: productos.map(r => ({
        producto_id: r.producto_id,
        nombre: r.nombre || '',
        cantidad: Number(r.cantidad || 0),
        precio: Number(r.precio || 0),
        subtotal: Number(r.subtotal || 0),
      })),
    });
  } catch (e) {
    console.error('[getVentaById]', e);
    res.status(500).json({ message: 'Error leyendo venta' });
  }
}

/**
 * GET /api/vendedor/historial-ventas/motivos-no-venta?cliente_id=#
 */
export async function getMotivosNoVenta(req, res) {
  try {
    const clienteId = Number(req.query.cliente_id || 0);
    if (!Number.isFinite(clienteId) || clienteId <= 0) {
      return res.status(400).json({ message: 'cliente_id inválido' });
    }

    const [rows] = await db.query(
      `SELECT v.id,
              v.fecha,
              v.ruta_id,
              v.motivos_json
         FROM visitas_no_venta v
        WHERE v.id_cliente = ?
        ORDER BY v.fecha DESC
        LIMIT 200`,
      [clienteId]
    );

    const [cats] = await db.query(
      `SELECT clave, descripcion FROM motivos_no_venta_catalogo WHERE activo = 1`
    );
    const catMap = new Map(cats.map(r => [r.clave, r.descripcion]));

    const resp = rows.map(r => {
      let motivos = [];
      try {
        const arr = Array.isArray(r.motivos_json) ? r.motivos_json : JSON.parse(r.motivos_json || '[]');
        motivos = arr.map(x => {
          const clave = String(x || '').trim();
          return { clave, descripcion: catMap.get(clave) || clave };
        });
      } catch {
        motivos = [];
      }
      const iso = new Date(r.fecha);
      const dd = iso.toISOString().slice(0,10);  // yyyy-mm-dd
      const hh = iso.toTimeString().slice(0,5);  // HH:mm
      return {
        id: r.id,
        fecha: dd.split('-').reverse().join('/'), // dd/MM/yyyy
        hora: hh,
        ruta_id: r.ruta_id,
        motivos
      };
    });

    res.json(resp);
  } catch (e) {
    console.error('[getMotivosNoVenta]', e);
    res.status(500).json({ message: 'Error obteniendo motivos de no venta' });
  }
}
