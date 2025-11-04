// controllers/vendedor/ventaPublicoController.js
import db from '../../config/db.js';

/* ===================== Utils comunes ===================== */
function getVendedorId(req) {
  return Number(
    req.user?.vendedorId ??
    req.user?.id_vendedor ??
    req.params?.idVendedor ??
    req.query?.idVendedor ??
    req.query?.vendedorId
  ) || null;
}

/** Normaliza "Efectivo"/"Transferencia" → enum simple */
function normalizeMetodoPago(x) {
  const t = String(x || '').trim().toLowerCase();
  if (t.startsWith('trans')) return 'transferencia';
  return 'efectivo';
}

/* ===================== Carga actual ===================== */
/**
 * Solo permitimos la ÚLTIMA carga **no procesada** del vendedor.
 * (No hacemos fallback a cargas viejas o procesadas para evitar confusiones).
 */
async function pickCargaActual(conn, vendedorId) {
  const [[row]] = await conn.query(
    `SELECT c.id, c.fecha, c.procesada, c.lista_para_confirmar, c.id_camioneta
       FROM cargas c
      WHERE c.id_vendedor = ? AND c.procesada = 0
      ORDER BY c.fecha DESC, c.id DESC
      LIMIT 1`,
    [vendedorId]
  );
  return row || null;
}

async function leerCargaActual(conn, vendedorId) {
  const row = await pickCargaActual(conn, vendedorId);
  if (!row) return null;

  const carga = {
    id: Number(row.id),
    fecha: row.fecha,
    procesada: !!row.procesada,
    listaParaConfirmar: !!row.lista_para_confirmar,
    id_camioneta: row.id_camioneta != null ? Number(row.id_camioneta) : null
  };

  const [det] = await conn.query(
    `SELECT
        dp.producto_id,
        dp.nombre_producto,
        dp.precio_unitario,
        dp.cantidad_inicial,
        COALESCE(dp.ventas,0)       AS ventas,
        COALESCE(dp.devoluciones,0) AS devoluciones,
        -- RESTANTE correcto: cargado - ventas + devoluciones
        COALESCE(dp.restante, GREATEST(dp.cantidad_inicial - dp.ventas + dp.devoluciones, 0)) AS restante
       FROM detalle_pedido dp
      WHERE dp.carga_id = ?
      ORDER BY dp.nombre_producto ASC`,
    [carga.id]
  );

  const productosNuevos = det.map(r => ({
    productoId: Number(r.producto_id),
    nombre: r.nombre_producto,
    precio: Number(r.precio_unitario ?? 0),
    cargado: Number(r.cantidad_inicial ?? 0),
    vendido: Number(r.ventas ?? 0),
    devoluciones: Number(r.devoluciones ?? 0),
    restante: Number(r.restante ?? 0)
  }));

  // Compatibilidad con apps antiguas que esperan 'productos'
  const productosCompat = det.map(r => ({
    nombre: r.nombre_producto,
    cantidad: Number(r.cantidad_inicial ?? 0),
    restante: Number(r.restante ?? 0)
  }));

  return { carga, productosNuevos, productosCompat };
}

/* ===================== Handlers ===================== */
/**
 * GET /api/vendedor/ventapublico/carga-activa/:idVendedor
 * GET /api/vendedor/inventario/activo?idVendedor=#
 * Respuesta unificada (como inventarioController) + compat 'productos'
 */
export async function getCargaActiva(req, res) {
  const conn = await db.getConnection();
  try {
    const vendedorId = getVendedorId(req);
    if (!vendedorId) {
      conn.release?.();
      return res.status(400).json({ ok: false, error: 'Falta idVendedor' });
    }

    const data = await leerCargaActual(conn, vendedorId);
    conn.release?.();

    // Si NO hay carga, o ya está procesada, ocultamos la pantalla de venta al público
    if (!data || data.carga?.procesada || data.productosNuevos.length === 0) {
      return res.json({ ok: true, data: null, msg: 'Sin carga activa' });
    }

    return res.json({
      ok: true,
      data: {
        id: data.carga.id,
        procesada: data.carga.procesada,
        carga: {
          id: data.carga.id,
          fecha: data.carga.fecha,
          procesada: data.carga.procesada,
          listaParaConfirmar: data.carga.listaParaConfirmar
        },
        productosNuevos: data.productosNuevos,
        // compat Android legacy:
        productos: data.productosCompat
      }
    });
  } catch (e) {
    conn.release?.();
    console.error('[ventapublico.getCargaActiva]', e);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
}

/**
 * POST /api/vendedor/ventapublico/vender
 * body: { idVendedor|vendedorId, tipoPago, latitud?, longitud?, productos:[{nombre,cantidad}] }
 */
export async function venderPublico(req, res) {
  const conn = await db.getConnection();
  try {
    const vendedorId = getVendedorId(req) ?? Number(req.body?.idVendedor || req.body?.vendedorId || 0);
    if (!Number.isFinite(vendedorId) || vendedorId <= 0) {
      conn.release?.();
      return res.status(400).json({ ok: false, error: 'idVendedor requerido' });
    }

    const productos = Array.isArray(req.body?.productos) ? req.body.productos : [];
    if (!productos.length) {
      conn.release?.();
      return res.status(400).json({ ok: false, error: 'productos vacío' });
    }

    const metodoPago = normalizeMetodoPago(req.body?.tipoPago);
    const latitud = req.body?.latitud ?? null;
    const longitud = req.body?.longitud ?? null;

    // 1) Carga actual (NO procesada)
    const cargaRow = await pickCargaActual(conn, vendedorId);
    if (!cargaRow?.id) {
      conn.release?.();
      return res.status(409).json({ ok: false, error: 'Sin carga para este vendedor' });
    }
    const cargaId = Number(cargaRow.id);

    await conn.beginTransaction();

    // 2) Resolver productos por nombre EN ESA CARGA + bloquear fila
    const nombres = productos.map(p => String(p?.nombre || '').trim()).filter(Boolean);
    const marks = nombres.map(() => '?').join(',');
    if (!marks) {
      await conn.rollback(); conn.release?.();
      return res.status(400).json({ ok: false, error: 'Productos sin nombre' });
    }

    const [dpRows] = await conn.query(
      `SELECT dp.producto_id, dp.nombre_producto, dp.precio_unitario,
              COALESCE(dp.restante, GREATEST(dp.cantidad_inicial - dp.ventas + dp.devoluciones, 0)) AS restante
         FROM detalle_pedido dp
        WHERE dp.carga_id = ?
          AND dp.nombre_producto IN (${marks})
        FOR UPDATE`,
      [cargaId, ...nombres]
    );

    const byName = new Map(dpRows.map(r => [String(r.nombre_producto), r]));

    // 3) Validaciones
    for (const item of productos) {
      const nombre = String(item.nombre || '').trim();
      const qty = Number(item.cantidad || 0);
      const dp = byName.get(nombre);
      if (!dp) {
        await conn.rollback(); conn.release?.();
        return res.status(400).json({ ok:false, error:`Producto no está en la carga: ${nombre}` });
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        await conn.rollback(); conn.release?.();
        return res.status(400).json({ ok:false, error:`Cantidad inválida para ${nombre}` });
      }
      const restante = Number(dp.restante || 0);
      if (qty > restante + 1e-9) {
        await conn.rollback(); conn.release?.();
        return res.status(409).json({ ok:false, error:`Sin suficiente restante para ${nombre} (restante=${restante})` });
      }
    }

    // 4) Encabezado ventas_publico
    let total = 0;
    for (const item of productos) {
      const dp = byName.get(String(item.nombre).trim());
      total += Number(item.cantidad) * Number(dp.precio_unitario);
    }
    total = Math.round(total * 100) / 100;

    const [insVenta] = await conn.query(
      `INSERT INTO ventas_publico
         (id_vendedor, total, metodo_pago, latitud, longitud, fecha)
       VALUES (?,?,?,?,?, NOW())`,
      [vendedorId, total, metodoPago, latitud, longitud]
    );
    const ventaId = insVenta.insertId;

    // 5) Detalle + actualizar inventario (solo 'ventas')
    for (const item of productos) {
      const nombre = String(item.nombre).trim();
      const qty = Number(item.cantidad);
      const dp = byName.get(nombre);
      const precio = Number(dp.precio_unitario);
      const productoId = dp.producto_id;

      await conn.query(
        `INSERT INTO ventas_publico_detalle
           (venta_publico_id, producto_id, nombre_producto, cantidad, precio_unitario)
         VALUES (?,?,?,?,?)`,
        [ventaId, productoId, nombre, qty, precio]
      );

      await conn.query(
        `UPDATE detalle_pedido
            SET ventas = COALESCE(ventas,0) + ?
          WHERE carga_id = ? AND producto_id = ?`,
        [qty, cargaId, productoId]
      );
    }

    await conn.commit();

    // Broadcast opcional
    try {
      const io = req.app?.get?.('io');
      if (io) io.to(`vendedor:${vendedorId}`).emit('inventario:actualizado', { action: 'venta_publico', ventaId, cargaId });
    } catch {}

    conn.release?.();
    return res.json({ ok: true, data: { ventaId, total, metodo_pago: metodoPago } });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    conn.release?.();
    console.error('[venderPublico]', e);
    return res.status(500).json({ ok: false, error: 'Error al registrar la venta al público' });
  }
}
