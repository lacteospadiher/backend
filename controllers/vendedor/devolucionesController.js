// controllers/vendedor/devolucionesController.js
import db from '../../config/db.js';

/* ===================== Helpers comunes ===================== */

/** Última carga real del vendedor: primero vista, luego fallback directo */
async function getUltimaCargaId(vendedorId) {
  const [[viaView]] = await db.query(
    `SELECT carga_id
       FROM vw_ultima_carga_por_vendedor
      WHERE id_vendedor = ?
      LIMIT 1`,
    [vendedorId]
  );
  if (viaView?.carga_id) return Number(viaView.carga_id);

  const [[ult]] = await db.query(
    `SELECT id
       FROM cargas
      WHERE id_vendedor = ?
      ORDER BY fecha DESC, id DESC
      LIMIT 1`,
    [vendedorId]
  );
  return ult ? Number(ult.id) : null;
}

/** ✅ Restante = inicial - ventas - devoluciones (capado a >= 0) */
const RESTANTE_EXPR =
  'GREATEST(dp.cantidad_inicial - COALESCE(dp.ventas,0) - COALESCE(dp.devoluciones,0), 0)';

/* ===================== Endpoints ===================== */

/**
 * GET /api/vendedor/devoluciones/inventario?vendedor_id=#
 * Inventario vigente (última carga) con 'restante' y precio (snapshot).
 * Nombre: preferimos catálogo si existe, si no, el snapshot de la carga.
 */
export async function getInventarioVigente(req, res) {
  try {
    const vendedorId = Number(req.query.vendedor_id || 0);
    if (!Number.isFinite(vendedorId) || vendedorId <= 0) {
      return res.status(400).json({ message: 'vendedor_id inválido' });
    }

    const cargaId = await getUltimaCargaId(vendedorId);
    if (!cargaId) {
      return res.status(400).json({ message: 'El vendedor no tiene carga vigente' });
    }

    const [rows] = await db.query(
      `SELECT
         dp.producto_id AS id_producto,
         COALESCE(p.nombre, dp.nombre_producto) AS nombre,
         ${RESTANTE_EXPR} AS restante,
         dp.precio_unitario AS precio
       FROM detalle_pedido dp
       LEFT JOIN productos p ON p.id = dp.producto_id
       WHERE dp.carga_id = ?
       ORDER BY nombre ASC`,
      [cargaId]
    );

    return res.json(
      rows.map(r => ({
        id_producto: Number(r.id_producto),
        nombre: r.nombre,
        restante: Number(r.restante ?? 0),
        precio: r.precio != null ? Number(r.precio) : null
      }))
    );
  } catch (e) {
    console.error('[getInventarioVigente]', e);
    return res.status(500).json({ message: 'Error obteniendo inventario' });
  }
}

/**
 * GET /api/vendedor/devoluciones/para-devolver?vendedor_id=#
 * Máximo devolvible = ventas - devoluciones (>=0) en la carga vigente.
 */
export async function getParaDevolver(req, res) {
  try {
    const vendedorId = Number(req.query.vendedor_id || 0);
    if (!Number.isFinite(vendedorId) || vendedorId <= 0) {
      return res.status(400).json({ message: 'vendedor_id inválido' });
    }

    const cargaId = await getUltimaCargaId(vendedorId);
    if (!cargaId) return res.json([]);

    const [rows] = await db.query(
      `SELECT
         dp.producto_id AS id_producto,
         COALESCE(p.nombre, dp.nombre_producto) AS nombre,
         COALESCE(dp.ventas,0) AS ventas,
         COALESCE(dp.devoluciones,0) AS devoluciones,
         GREATEST(COALESCE(dp.ventas,0) - COALESCE(dp.devoluciones,0), 0) AS max_devolvible
       FROM detalle_pedido dp
       LEFT JOIN productos p ON p.id = dp.producto_id
       WHERE dp.carga_id = ?
       ORDER BY nombre ASC`,
      [cargaId]
    );

    return res.json(
      rows.map(r => ({
        id_producto: Number(r.id_producto),
        nombre: r.nombre,
        ventas: Number(r.ventas || 0),
        devoluciones: Number(r.devoluciones || 0),
        max_devolvible: Number(r.max_devolvible || 0)
      }))
    );
  } catch (e) {
    console.error('[getParaDevolver]', e);
    return res.status(500).json({ message: 'Error obteniendo máximos devolvibles' });
  }
}

/**
 * GET /api/vendedor/devoluciones/pendientes?vendedor_id=#
 * Lista devoluciones NO procesadas con detalle.
 */
export async function getDevolucionesPendientes(req, res) {
  try {
    const vendedorId = Number(req.query.vendedor_id || 0);
    if (!Number.isFinite(vendedorId) || vendedorId <= 0) {
      return res.status(400).json({ message: 'vendedor_id inválido' });
    }

    const [cab] = await db.query(
      `SELECT d.id, d.motivo, d.fecha, d.cliente_nombre, d.cliente_qr
         FROM devoluciones d
        WHERE d.id_vendedor = ? AND d.procesada = 0
        ORDER BY d.fecha DESC, d.id DESC`,
      [vendedorId]
    );
    if (cab.length === 0) return res.json([]);

    const ids = cab.map(r => r.id);
    const [det] = await db.query(
      `SELECT dd.id_devolucion, dd.nombre_producto, dd.cantidad, dd.precio_unitario
         FROM devolucion_detalle dd
        WHERE dd.id_devolucion IN (?)`,
      [ids]
    );

    const detalleByDev = det.reduce((acc, r) => {
      (acc[r.id_devolucion] ||= []).push({
        nombre: r.nombre_producto,
        cantidad: Number(r.cantidad),
        precio_unitario: r.precio_unitario !== null ? Number(r.precio_unitario) : null
      });
      return acc;
    }, {});

    const resp = cab.map(c => ({
      id: c.id,
      cliente_nombre: c.cliente_nombre,
      cliente_qr: c.cliente_qr,
      motivo: c.motivo,
      fecha: c.fecha,
      procesada: 0,
      productos: detalleByDev[c.id] || []
    }));

    return res.json(resp);
  } catch (e) {
    console.error('[getDevolucionesPendientes]', e);
    return res.status(500).json({ message: 'Error listando devoluciones pendientes' });
  }
}

/**
 * POST /api/vendedor/devoluciones
 * body: {
 *   vendedor_id: number,
 *   cliente_qr?: string,
 *   cliente_id?: number,
 *   motivo: string,
 *   productos: [{ id_producto?: number, nombre?: string, cantidad: number }],
 *   force?: number | boolean   // <- si es truthy, valida solo contra RESTANTE
 * }
 */
export async function postDevolucion(req, res) {
  const conn = await db.getConnection();
  try {
    const vendedorId = Number(req.body?.vendedor_id);
    const clienteQr  = (req.body?.cliente_qr || '').trim() || null;
    const clienteId  = req.body?.cliente_id != null ? Number(req.body.cliente_id) : null;
    const motivo     = String(req.body?.motivo || '').trim();
    const productos  = Array.isArray(req.body?.productos) ? req.body.productos : [];
    const forceFlag  = !!req.body?.force;

    if (!Number.isFinite(vendedorId) || vendedorId <= 0) {
      return res.status(400).json({ message: 'vendedor_id inválido' });
    }
    if (!motivo) return res.status(400).json({ message: 'motivo requerido' });
    if (productos.length === 0) return res.status(400).json({ message: 'productos requerido' });

    // Resuelve cliente (opcional)
    let cliente = { id: clienteId, nombre: null };
    if (!cliente.id && clienteQr) {
      const [[cli]] = await conn.query(
        `SELECT id, nombre_empresa FROM clientes WHERE codigo_qr = ? LIMIT 1`,
        [clienteQr]
      );
      if (cli) cliente = { id: cli.id, nombre: cli.nombre_empresa };
    } else if (cliente.id) {
      const [[cli]] = await conn.query(
        `SELECT id, nombre_empresa FROM clientes WHERE id = ? LIMIT 1`,
        [cliente.id]
      );
      if (cli) cliente.nombre = cli.nombre_empresa;
    }

    await conn.beginTransaction();

    // Última carga real
    const cargaId = await (async () => {
      const [[viaView]] = await conn.query(
        `SELECT carga_id
           FROM vw_ultima_carga_por_vendedor
          WHERE id_vendedor = ?
          LIMIT 1`,
        [vendedorId]
      );
      if (viaView?.carga_id) return Number(viaView.carga_id);

      const [[ult]] = await conn.query(
        `SELECT id
           FROM cargas
          WHERE id_vendedor = ?
          ORDER BY fecha DESC, id DESC
          LIMIT 1`,
        [vendedorId]
      );
      return ult ? Number(ult.id) : null;
    })();

    if (!cargaId) {
      await conn.rollback();
      return res.status(400).json({ message: 'El vendedor no tiene carga vigente' });
    }

    // Cabecera
    const [insCab] = await conn.query(
      `INSERT INTO devoluciones (id_vendedor, id_cliente, cliente_nombre, cliente_qr, motivo, procesada, fecha)
       VALUES (?, ?, ?, ?, ?, 0, NOW())`,
      [vendedorId, cliente.id || null, cliente.nombre || null, clienteQr, motivo]
    );
    const devolucionId = insCab.insertId;

    // Mapa de productos de la carga
    const [mapRows] = await conn.query(
      `SELECT
         dp.producto_id,
         COALESCE(p.nombre, dp.nombre_producto) AS nombre_producto,
         dp.precio_unitario,
         dp.cantidad_inicial,
         COALESCE(dp.ventas,0)       AS ventas,
         COALESCE(dp.devoluciones,0) AS devoluciones,
         ${RESTANTE_EXPR}            AS restante
       FROM detalle_pedido dp
       LEFT JOIN productos p ON p.id = dp.producto_id
       WHERE dp.carga_id = ?`,
      [cargaId]
    );

    const byId   = new Map(mapRows.map(r => [Number(r.producto_id), r]));
    const byName = new Map(mapRows.map(r => [String(r.nombre_producto).toLowerCase(), r]));

    // Detalle + validaciones + impacto a dp.devoluciones
    for (const item of productos) {
      const cant = Number(item?.cantidad);
      if (!Number.isFinite(cant) || cant <= 0) {
        await conn.rollback();
        return res.status(400).json({ message: 'cantidad inválida en productos' });
      }

      let row = null;
      if (item.id_producto != null) row = byId.get(Number(item.id_producto));
      if (!row && item.nombre) row = byName.get(String(item.nombre).toLowerCase());
      if (!row) {
        await conn.rollback();
        return res
          .status(400)
          .json({ message: `producto no pertenece a la carga vigente: ${item.nombre || item.id_producto}` });
      }

      // Validaciones
      const restante = Math.max(Number(row.restante) || 0, 0);
      if (cant > restante) {
        await conn.rollback();
        return res.status(400).json({
          message: `Excede restante en camioneta para ${row.nombre_producto}. Restante: ${restante}`
        });
      }

      if (!forceFlag) {
        const maxDev = Math.max((Number(row.ventas) || 0) - (Number(row.devoluciones) || 0), 0);
        if (cant > maxDev) {
          await conn.rollback();
          return res.status(400).json({
            message: `Cantidad a devolver excede lo vendido para ${row.nombre_producto}. Pendiente por devolver: ${maxDev}`
          });
        }
      }

      // Inserta detalle
      await conn.query(
        `INSERT INTO devolucion_detalle (id_devolucion, id_producto, nombre_producto, cantidad, precio_unitario)
         VALUES (?, ?, ?, ?, ?)`,
        [devolucionId, row.producto_id, row.nombre_producto, cant, row.precio_unitario]
      );

      // Impacta devoluciones en la fila de detalle_pedido (⬆ aumenta devoluciones → ⬇ restante)
      await conn.query(
        `UPDATE detalle_pedido
            SET devoluciones = COALESCE(devoluciones,0) + ?
          WHERE carga_id = ? AND producto_id = ?`,
        [cant, cargaId, row.producto_id]
      );
    }

    await conn.commit();
    return res.json({ ok: true, devolucion_id: devolucionId });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    console.error('[postDevolucion]', e);
    return res.status(500).json({ message: 'Error registrando devolución' });
  } finally {
    try { conn.release?.(); } catch {}
  }
}

/**
 * PATCH /api/vendedor/devoluciones/:id/procesar
 * Marca la devolución como procesada (no toca inventario).
 */
export async function patchProcesarDevolucion(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ message: 'id inválido' });
    }
    const [upd] = await db.query(
      `UPDATE devoluciones
          SET procesada = 1,
              actualizado_en = NOW()
        WHERE id = ?`,
      [id]
    );
    if (upd.affectedRows === 0) return res.status(404).json({ message: 'Devolución no encontrada' });
    return res.json({ ok: true });
  } catch (e) {
    console.error('[patchProcesarDevolucion]', e);
    return res.status(500).json({ message: 'Error procesando devolución' });
  }
}
