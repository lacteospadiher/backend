// controllers/cargador/registrarPedidoController.js
// Flujo: catálogo productos, vendedor, leer pedido, patch pedido (reescribe detalle de la CARGA),
// confirmar (crea/usa CARGA y marca pedido procesado)
// MySQL 8 (mysql2/promise)

import db from '../../config/db.js';

const ROL_CARGADOR   = 2;
const ROL_SUPERADMIN = 4;

const ensureRole = (req, res) => {
  const rol = req.user?.rol;
  if (![ROL_CARGADOR, ROL_SUPERADMIN].includes(rol)) {
    res.status(403).json({ msg: 'No autorizado' });
    return false;
  }
  return true;
};

/* =========================================================
 * Helpers
 * =======================================================*/
const sumDuplicates = (items) => {
  const acc = new Map();
  for (const p of items || []) {
    const idProd = Number(p?.productoId ?? p?.id);
    const cant   = Math.max(0, Number(p?.cantidad ?? 0));
    if (!idProd || cant <= 0) continue;
    acc.set(idProd, (acc.get(idProd) ?? 0) + cant);
  }
  return Array.from(acc.entries()).map(([id, cantidad]) => ({ id, cantidad }));
};

async function ensureCargaForPedido(conn, pedidoId, usuarioId) {
  // Devuelve { cargaId, vendedorId, id_camioneta }
  const [[ped]] = await conn.query(
    `SELECT id, id_vendedor, id_camioneta, carga_id
       FROM pedidos
      WHERE id = ?
      FOR UPDATE`,
    [pedidoId]
  );
  if (!ped) throw new Error('Pedido no encontrado');

  let cargaId = ped.carga_id ?? null;
  let id_camioneta = ped.id_camioneta ?? null;

  // Si el pedido no tiene camioneta, intenta tomar la del vendedor
  if (!id_camioneta) {
    const [[vend]] = await conn.query(
      'SELECT camioneta_id FROM vendedores WHERE id = ? LIMIT 1',
      [ped.id_vendedor]
    );
    id_camioneta = vend?.camioneta_id ?? null;
  }

  if (!cargaId) {
    const [ins] = await conn.query(
      `INSERT INTO cargas
         (id_vendedor, id_camioneta, id_usuario, fecha, procesada, lista_para_confirmar, observaciones, pedido_id)
       VALUES (?, ?, ?, NOW(), 0, 0, NULL, ?)`,
      [ped.id_vendedor, id_camioneta, usuarioId, ped.id]
    );
    cargaId = ins.insertId;
    await conn.query(
      'UPDATE pedidos SET carga_id = ? WHERE id = ?',
      [cargaId, ped.id]
    );
  }

  return { cargaId, vendedorId: ped.id_vendedor, id_camioneta };
}

async function upsertDetalleCarga(conn, cargaId, items /* [{id,cantidad}] */) {
  let total = 0;
  for (const it of items) {
    const prodId = Number(it.id);
    const cant   = Math.max(0, Number(it.cantidad || 0));
    if (!prodId || cant <= 0) continue;

    const [[prd]] = await conn.query(
      'SELECT id, nombre, precio FROM productos WHERE id = ?',
      [prodId]
    );
    if (!prd) throw new Error(`Producto ${prodId} no existe`);

    total += cant * Number(prd.precio);

    await conn.query(
      `INSERT INTO detalle_pedido
         (carga_id, producto_id, nombre_producto, precio_unitario, cantidad_inicial, ventas, devoluciones)
       VALUES (?, ?, ?, ?, ?, 0, 0)
       ON DUPLICATE KEY UPDATE
         nombre_producto   = VALUES(nombre_producto),
         precio_unitario   = VALUES(precio_unitario),
         cantidad_inicial  = VALUES(cantidad_inicial)`,
      [cargaId, prd.id, prd.nombre, prd.precio, cant]
    );
  }
  return total;
}

/* =========================================================
 * Endpoints
 * =======================================================*/

/** GET /api/cargador/registrar-pedido/productos  */
export const getProductos = async (req, res) => {
  if (!ensureRole(req, res)) return;
  try {
    const [rows] = await db.query(`
      SELECT id, nombre, precio
        FROM productos
       WHERE activo=1 AND eliminado=0
       ORDER BY nombre ASC
    `);
    res.json(rows.map(r => ({
      id: Number(r.id),
      nombre: r.nombre,
      precio: Number(r.precio)
    })));
  } catch (e) {
    res.status(500).json({ msg: e.message || 'Error al listar productos' });
  }
};

/** GET /api/cargador/registrar-pedido/vendedores/:id */
export const getVendedorById = async (req, res) => {
  if (!ensureRole(req, res)) return;
  try {
    const id = Number(req.params.id);
    const [[row]] = await db.query(`
      SELECT v.id,
             u.nombre AS nombreCompleto,
             CONCAT_WS(' ', c.marca, c.modelo) AS camioneta,
             c.kilometraje_actual AS kilometraje,
             c.placa AS placas,
             c.id AS camionetaId
        FROM vendedores v
        LEFT JOIN usuarios  u ON u.id = v.id_usuario
        LEFT JOIN camionetas c ON c.id = v.camioneta_id
       WHERE v.id = ?
       LIMIT 1
    `, [id]);
    if (!row) return res.status(404).json({ msg: 'Vendedor no encontrado' });
    res.json({
      id: Number(row.id),
      nombreCompleto: row.nombreCompleto || '',
      camioneta: row.camioneta || null,
      kilometraje: row.kilometraje != null ? Number(row.kilometraje) : null,
      placas: row.placas || null,
      camionetaId: row.camionetaId != null ? Number(row.camionetaId) : null
    });
  } catch (e) {
    res.status(500).json({ msg: e.message || 'Error al obtener vendedor' });
  }
};

/** GET /api/cargador/registrar-pedido/pedido/:id */
export const getPedidoById = async (req, res) => {
  if (!ensureRole(req, res)) return;
  try {
    const pedidoId = Number(req.params.id);

    const [[cab]] = await db.query(`
      SELECT p.id, p.fecha, p.estado, p.procesado, p.carga_id,
             p.pedido_especial,
             v.id AS vendedorId, u.nombre AS nombreCompleto,
             CONCAT_WS(' ', c.marca, c.modelo) AS camioneta,
             c.kilometraje_actual AS kilometraje,
             c.placa AS placas
        FROM pedidos p
        JOIN vendedores v ON v.id = p.id_vendedor
        JOIN usuarios  u ON u.id = v.id_usuario
        LEFT JOIN camionetas c ON c.id = v.camioneta_id
       WHERE p.id = ?
       LIMIT 1
    `, [pedidoId]);
    if (!cab) return res.status(404).json({ msg: 'Pedido no encontrado' });

    let productos = [];
    if (cab.carga_id) {
      const [det] = await db.query(`
        SELECT dp.producto_id      AS productoId,
               dp.nombre_producto  AS nombre,
               dp.precio_unitario  AS precio,
               dp.cantidad_inicial AS cantidad
          FROM detalle_pedido dp
         WHERE dp.carga_id = ?
         ORDER BY dp.nombre_producto ASC
      `, [cab.carga_id]);
      productos = det.map(r => ({
        productoId: Number(r.productoId),
        nombre: r.nombre,
        precio: Number(r.precio),
        cantidad: Number(r.cantidad)
      }));
    } else {
      const [det] = await db.query(`
        SELECT pdh.producto_id         AS productoId,
               pdh.nombre_producto     AS nombre,
               pdh.precio_unitario     AS precio,
               pdh.cantidad_solicitada AS cantidad
          FROM pedido_detalle_hist pdh
         WHERE pdh.pedido_id = ?
         ORDER BY pdh.nombre_producto ASC
      `, [pedidoId]);
      productos = det.map(r => ({
        productoId: Number(r.productoId),
        nombre: r.nombre,
        precio: Number(r.precio),
        cantidad: Number(r.cantidad)
      }));
    }

    const fechaUnix =
      cab.fecha ? Math.floor(new Date(cab.fecha).getTime() / 1000) : Math.floor(Date.now() / 1000);

    res.json({
      id: Number(cab.id),
      fechaUnix,
      vendedor: {
        id: Number(cab.vendedorId),
        nombreCompleto: cab.nombreCompleto || '',
        camioneta: cab.camioneta || null,
        kilometraje: cab.kilometraje != null ? Number(cab.kilometraje) : null,
        placas: cab.placas || null
      },
      productos,
      pedidoEspecial: cab.pedido_especial ?? null
    });
  } catch (e) {
    res.status(500).json({ msg: e.message || 'Error al obtener pedido' });
  }
};

/** PATCH /api/cargador/registrar-pedido/pedido/:id  (reescribe detalle de la CARGA asociada) */
export const patchPedido = async (req, res) => {
  if (!ensureRole(req, res)) return;
  const conn = await db.getConnection();
  try {
    const pedidoId = Number(req.params.id);
    const productosBody = Array.isArray(req.body.productos) ? req.body.productos : [];
    if (!productosBody.length) { conn.release(); return res.status(400).json({ msg: 'productos requerido' }); }

    await conn.beginTransaction();

    const usuarioId = Number(req.user?.id);
    const { cargaId } = await ensureCargaForPedido(conn, pedidoId, usuarioId);

    const items = sumDuplicates(productosBody);
    if (!items.length) { await conn.rollback(); conn.release(); return res.status(400).json({ msg: 'Sin productos válidos' }); }

    await conn.query('DELETE FROM detalle_pedido WHERE carga_id = ?', [cargaId]);

    const total = await upsertDetalleCarga(conn, cargaId, items);

    await conn.query('UPDATE pedidos SET total = ? WHERE id = ?', [total, pedidoId]);

    await conn.commit();
    res.json({ ok: true, total: Number(total), cargaId });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    res.status(500).json({ msg: e.message || 'Error al actualizar pedido' });
  } finally {
    try { conn.release(); } catch {}
  }
};

/**
 * POST /api/cargador/registrar-pedido/confirmar
 * body: { vendedorId?:number, pedidoId?:number, productos?:[{id|productoId, cantidad}], observaciones?:string, pedidoEspecial?:string }
 */
export const postConfirmarCarga = async (req, res) => {
  if (!ensureRole(req, res)) return;
  const conn = await db.getConnection();
  try {
    const {
      vendedorId: vendedorIdBody,
      pedidoId,
      productos: productosBody,
      observaciones,
      pedidoEspecial
    } = req.body;
    const usuarioId = Number(req.user?.id);

    await conn.beginTransaction();

    let pedido_id;
    let vendedorId;
    let id_camioneta = null;
    let cargaId;
    let total = 0;

    if (pedidoId) {
      // 1) Garantiza CARGA y toma datos del pedido
      const ctx = await ensureCargaForPedido(conn, Number(pedidoId), usuarioId);
      cargaId = ctx.cargaId;
      vendedorId = ctx.vendedorId;
      id_camioneta = ctx.id_camioneta;

      // 2) Items a usar: body o lo que ya exista en la carga
      let items = [];
      if (Array.isArray(productosBody) && productosBody.length) {
        items = sumDuplicates(productosBody);
        await conn.query('DELETE FROM detalle_pedido WHERE carga_id = ?', [cargaId]);
        total = await upsertDetalleCarga(conn, cargaId, items);
      } else {
        const [det] = await conn.query(
          'SELECT producto_id AS id, cantidad_inicial AS cantidad FROM detalle_pedido WHERE carga_id = ?',
          [cargaId]
        );
        items = sumDuplicates(det);
        total = await upsertDetalleCarga(conn, cargaId, items); // re-snapshot
      }

      // 3) Marca pedido como procesado/enviado + total + observaciones + pedido_especial
      const obs = observaciones || `Pedido #${pedidoId} confirmado desde módulo Cargador`;
      await conn.query(
        `UPDATE pedidos
            SET fecha = NOW(),
                estado = 'enviado',
                procesado = 1,
                listo_para_pedido_gral = 1,
                observaciones = ?,
                pedido_especial = ?,
                total = ?
          WHERE id = ?`,
        [obs, (pedidoEspecial ?? null), total, Number(pedidoId)]
      );

      pedido_id = Number(pedidoId);
    } else {
      // Crear pedido + carga y confirmar
      if (!vendedorIdBody) { await conn.rollback(); return res.status(400).json({ msg: 'vendedorId requerido' }); }
      if (!Array.isArray(productosBody) || !productosBody.length) {
        await conn.rollback(); return res.status(400).json({ msg: 'productos requeridos' });
      }
      vendedorId = Number(vendedorIdBody);

      const [[vend]] = await conn.query(
        'SELECT camioneta_id FROM vendedores WHERE id = ? LIMIT 1',
        [vendedorId]
      );
      id_camioneta = vend?.camioneta_id ?? null;

      const obs = observaciones || 'Pedido creado y confirmado desde módulo Cargador';
      const [insP] = await conn.query(
        `INSERT INTO pedidos
           (id_vendedor, id_camioneta, fecha, total, estado, procesado, listo_para_pedido_gral, carga_id, observaciones, pedido_especial)
         VALUES (?, ?, NOW(), 0.00, 'enviado', 1, 1, NULL, ?, ?)`,
        [vendedorId, id_camioneta, obs, (pedidoEspecial ?? null)]
      );
      pedido_id = Number(insP.insertId);

      // Crea CARGA y enlaza
      const [insC] = await conn.query(
        `INSERT INTO cargas
           (id_vendedor, id_camioneta, id_usuario, fecha, procesada, lista_para_confirmar, observaciones, pedido_id)
         VALUES (?, ?, ?, NOW(), 0, 0, NULL, ?)`,
        [vendedorId, id_camioneta, usuarioId, pedido_id]
      );
      cargaId = Number(insC.insertId);
      await conn.query('UPDATE pedidos SET carga_id = ? WHERE id = ?', [cargaId, pedido_id]);

      // Detalle (snapshot + cantidad_inicial)
      const items = sumDuplicates(productosBody);
      total = await upsertDetalleCarga(conn, cargaId, items);

      // Actualiza total del pedido
      await conn.query('UPDATE pedidos SET total = ? WHERE id = ?', [total, pedido_id]);
    }

    await conn.commit();
    return res.json({ ok: true, id: pedido_id, cargaId, pedidoProcesado: true, total: Number(total) });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    return res.status(500).json({ msg: e.message || 'Error al confirmar pedido' });
  } finally {
    try { conn.release(); } catch {}
  }
};
