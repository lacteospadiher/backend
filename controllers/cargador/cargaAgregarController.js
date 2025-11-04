// controllers/cargador/cargaAgregarController.js
import db from '../../config/db.js';

const toMs = (d) => (d ? new Date(d).getTime() : null);

/** GET /api/cargador/carga-agregar/vendedores */
export async function listarVendedores(req, res) {
  const [rows] = await db.query(`
    SELECT v.id AS vendedorId, u.nombre,
           cam.id AS camionetaId, cam.marca, cam.modelo, cam.placa,
           cam.kilometraje_actual AS kilometraje
      FROM vendedores v
      JOIN usuarios  u   ON u.id = v.id_usuario
 LEFT JOIN camionetas cam ON cam.id = v.camioneta_id
     WHERE v.activo=1 AND v.eliminado=0
  ORDER BY u.nombre ASC
  `);

  const data = rows.map((r) => ({
    id: String(r.vendedorId),
    nombre: r.nombre,
    camioneta: r.marca && r.modelo ? `${r.marca} ${r.modelo}` : null, // ← corregido
    placas: r.placa || null,
    kilometraje: r.kilometraje ?? null,
    camionetaId: r.camionetaId ? String(r.camionetaId) : null,
  }));

  res.json({ ok: true, data });
}

/** NEW: GET /api/cargador/carga-agregar/vendedores-activos */
export async function listarVendedoresActivos(req, res) {
  const [rows] = await db.query(`
    SELECT v.id AS vendedorId, u.nombre,
           cam.id AS camionetaId, cam.marca, cam.modelo, cam.placa,
           cam.kilometraje_actual AS kilometraje,
           c.id AS cargaId
      FROM vendedores v
      JOIN usuarios  u   ON u.id = v.id_usuario
 LEFT JOIN camionetas cam ON cam.id = v.camioneta_id
      JOIN cargas c ON c.id_vendedor = v.id AND c.procesada = 0
     WHERE v.activo=1 AND v.eliminado=0
  GROUP BY v.id
  ORDER BY u.nombre ASC
  `);

  const data = rows.map((r) => ({
    id: String(r.vendedorId),
    nombre: r.nombre,
    camioneta: r.marca && r.modelo ? `${r.marca} ${r.modelo}` : null, // ← corregido
    placas: r.placa || null,
    kilometraje: r.kilometraje ?? null,
    camionetaId: r.camionetaId ? String(r.camionetaId) : null,
    cargaId: r.cargaId ? String(r.cargaId) : null,
  }));

  res.json({ ok: true, data });
}

/** GET /api/cargador/carga-agregar/productos */
export async function listarProductos(req, res) {
  const [rows] = await db.query(`
    SELECT id, nombre, precio, IFNULL(cantidad,0) AS stock
      FROM productos
     WHERE activo=1 AND eliminado=0
  ORDER BY nombre ASC
  `);

  res.json({
    ok: true,
    data: rows.map((r) => ({
      id: String(r.id),
      nombre: r.nombre,
      precio: Number(r.precio),
      stock: Number(r.stock),
    })),
  });
}

/** GET /api/cargador/carga-agregar/ultima-carga?vendedorId=### */
export async function ultimaCargaPorVendedor(req, res) {
  const vendedorId = Number(req.query.vendedorId);
  if (!vendedorId) return res.status(400).json({ ok: false, error: 'vendedorId requerido' });

  const [[c]] = await db.query(
    `
    SELECT c.id, c.fecha, c.id_camioneta, c.id_vendedor,
           u.nombre AS nombreVendedor,
           cam.marca, cam.modelo, cam.placa, cam.kilometraje_actual
      FROM cargas c
      JOIN vendedores v ON v.id = c.id_vendedor
      JOIN usuarios   u ON u.id = v.id_usuario
 LEFT JOIN camionetas cam ON cam.id = c.id_camioneta
     WHERE c.id_vendedor=? AND c.procesada=0
  ORDER BY c.fecha DESC, c.id DESC
     LIMIT 1
  `,
    [vendedorId]
  );

  if (!c) return res.json({ ok: true, data: null });

  // Productos desde detalle_pedido (carga_id)
  const [prods] = await db.query(
    `
    SELECT p.id, p.nombre, dp.cantidad_inicial AS cantidad
      FROM detalle_pedido dp
      JOIN productos p ON p.id = dp.producto_id
     WHERE dp.carga_id = ?
  ORDER BY p.nombre ASC
  `,
    [c.id]
  );

  res.json({
    ok: true,
    data: {
      carga: {
        id: String(c.id),
        fechaMillis: toMs(c.fecha),
        vendedor: { id: String(c.id_vendedor), nombre: c.nombreVendedor },
        unidad: {
          camioneta: c.marca && c.modelo ? `${c.marca} ${c.modelo}` : null, // ← corregido
          placas: c.placa || null,
          kilometraje: c.kilometraje_actual ?? null,
        },
      },
      productos: prods.map((p) => ({
        id: String(p.id),
        nombre: p.nombre,
        cantidad: Number(p.cantidad || 0),
      })),
    },
  });
}

/**
 * POST /api/cargador/carga-agregar/agregar
 * body: {
 *   cargaId: number,
 *   items: [{ productoId:number, cantidad:number }],
 *   permitirNegativo?: boolean   // ignorado en este endpoint
 * }
 *
 * Importante: NO valida stock y NO descuenta inventario aquí.
 * Solo inserta/acumula en detalle_pedido (borrador de la carga).
 */
export async function agregarProductosACarga(req, res) {
  const { cargaId, items } = req.body || {};
  const idCarga = Number(cargaId);
  if (!idCarga || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: 'cargaId e items requeridos' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Lock de la carga activa (asegura existencia y que no esté procesada)
    const [[carga]] = await conn.query(
      `
      SELECT c.id, c.id_vendedor, c.id_camioneta
        FROM cargas c
       WHERE c.id=? AND c.procesada=0
       FOR UPDATE
      `,
      [idCarga]
    );
    if (!carga) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: 'Carga no encontrada o ya procesada' });
    }

    // Sanitiza items
    const ids = items.map((x) => Number(x.productoId)).filter((n) => Number.isFinite(n));
    if (ids.length === 0) {
      await conn.rollback();
      return res.status(400).json({ ok: false, error: 'items inválidos' });
    }

    // Traer nombres/precios de productos (sin FOR UPDATE; no vamos a tocar inventario)
    const [productosRef] = await conn.query(
      `
      SELECT id, nombre, IFNULL(precio,0) AS precio
        FROM productos
       WHERE id IN (${ids.map(() => '?').join(',')})
      `,
      ids
    );
    const refMap = new Map(
      productosRef.map((r) => [Number(r.id), { nombre: r.nombre || '', precio: Number(r.precio) }])
    );

    // Upsert en detalle_pedido (sumar a cantidad_inicial) SIN validar stock NI descontar inventario
    for (const it of items) {
      const pid = Number(it?.productoId);
      const cant = Number(it?.cantidad ?? 0);
      if (!Number.isFinite(pid) || !Number.isFinite(cant) || cant <= 0) continue;

      const ref = refMap.get(pid) || { nombre: '', precio: 0 };

      await conn.query(
        `
        INSERT INTO detalle_pedido
           (carga_id, producto_id, nombre_producto, cantidad_inicial, ventas, devoluciones, precio_unitario)
        VALUES (?,?,?,?,0,0,?)
        ON DUPLICATE KEY UPDATE
           cantidad_inicial = cantidad_inicial + VALUES(cantidad_inicial)
        `,
        [idCarga, pid, ref.nombre, cant, ref.precio]
      );
    }

    // Devolver lista actualizada
    const [prodsAct] = await conn.query(
      `
      SELECT p.id, p.nombre, dp.cantidad_inicial AS cantidad
        FROM detalle_pedido dp
        JOIN productos p ON p.id = dp.producto_id
       WHERE dp.carga_id = ?
    ORDER BY p.nombre ASC
      `,
      [idCarga]
    );

    await conn.commit();
    res.json({
      ok: true,
      cargaId: String(idCarga),
      productos: prodsAct.map((p) => ({
        id: String(p.id),
        nombre: p.nombre,
        cantidad: Number(p.cantidad || 0),
      })),
    });
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    // 400 si es error de validación; 500 si es interno desconocido
    const msg = (e && e.message) || 'Error';
    const isClientErr =
      /invalido|inválido|payload|requerid|no encontrada|procesad/i.test(msg);
    res.status(isClientErr ? 400 : 500).json({ ok: false, error: msg });
  } finally {
    conn.release();
  }
}
