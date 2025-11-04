// controllers/pedidos/pedidosController.js
import db from '../../config/db.js';

/* ============================================================
 * Utilidades
 * ============================================================ */

/** Arma WHERE dinámico desde querystring */
function buildFilters(query = {}) {
  const where = [];
  const params = [];

  if (query.fecha) { // YYYY-MM-DD
    where.push('DATE(p.fecha) = ?');
    params.push(query.fecha);
  }
  if (query.vendedor_id) {
    where.push('p.id_vendedor = ?');
    params.push(Number(query.vendedor_id));
  }
  if (query.estado) { // pendiente|enviado|entregado|cancelado
    where.push('p.estado = ?');
    params.push(query.estado);
  }
  // NUEVO: filtrar por lista_para_excel = 0|1 si viene en query
  if (query.lista_para_excel !== undefined) {
    where.push('p.lista_para_excel = ?');
    params.push(Number(query.lista_para_excel) ? 1 : 0);
  }

  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { sqlWhere, params };
}

/* ============================================================
 * GET /api/pedidos
 * Lista de pedidos (con filtros opcionales)
 * ============================================================ */
export async function listPedidos(req, res) {
  try {
    const { sqlWhere, params } = buildFilters(req.query);
    const sql = `
      SELECT p.*,
             v.id AS vendedor_id_ref,
             u.nombre AS vendedor_nombre,
             cam.placa AS camioneta_placa,
             p.pedido_especial
      FROM pedidos p
      LEFT JOIN vendedores v ON v.id = p.id_vendedor
      LEFT JOIN usuarios  u ON u.id = v.id_usuario
      LEFT JOIN camionetas cam ON cam.id = p.id_camioneta
      ${sqlWhere}
      ORDER BY p.fecha DESC, p.id DESC
      LIMIT 500
    `;
    const [rows] = await db.query(sql, params);
    return res.json(rows || []);
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Error al listar pedidos' });
  }
}

/* ============================================================
 * GET /api/pedidos/:id
 * Pedido + detalle
 * ============================================================ */
export async function getPedidoById(req, res) {
  try {
    const id = Number(req.params.id);
    const [[pedido]] = await db.query('SELECT p.* FROM pedidos WHERE p.id = ?', [id]);
    if (!pedido) return res.status(404).json({ error: 'No encontrado' });

    const [detalle] = await db.query(
      `SELECT pdh.*
         FROM pedido_detalle_hist pdh
        WHERE pdh.pedido_id = ?
        ORDER BY pdh.id ASC`,
      [id]
    );

    return res.json({ pedido, detalle });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Error al obtener pedido' });
  }
}

/* ============================================================
 * POST /api/pedidos
 * Crea pedido + detalle (transacción)
 * Inserta lista_para_excel = 1
 * ============================================================ */
export async function createPedido(req, res) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const {
      id_vendedor,
      id_camioneta,
      fecha,
      total = 0,
      estado = 'pendiente',
      procesado = 0,
      listo_para_pedido_gral = 0,
      carga_id = null,
      observaciones = null,
      pedido_especial = null,
      detalle = [],
    } = req.body || {};

    const [ins] = await conn.query(
      `INSERT INTO pedidos
       (id_vendedor, id_camioneta, fecha, total, estado, procesado, listo_para_pedido_gral, lista_para_excel, carga_id, observaciones, pedido_especial)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [id_vendedor, id_camioneta, fecha, total, estado, procesado, listo_para_pedido_gral, carga_id, observaciones, pedido_especial]
    );

    const pedidoId = ins.insertId;

    if (Array.isArray(detalle) && detalle.length) {
      const values = detalle.map(d => ([
        pedidoId,
        d.producto_id,
        d.nombre_producto,
        Number(d.cantidad_solicitada || 0),
        Number(d.precio_unitario || 0),
        Number((d.cantidad_solicitada || 0) * (d.precio_unitario || 0)),
      ]));
      await conn.query(
        `INSERT INTO pedido_detalle_hist
         (pedido_id, producto_id, nombre_producto, cantidad_solicitada, precio_unitario, subtotal_solicitado, creado_en)
         VALUES ${values.map(()=>'(?,?,?,?,?,?,NOW())').join(',')}`,
        values.flat()
      );
    }

    await conn.commit();
    return res.status(201).json({ id: pedidoId });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    return res.status(500).json({ error: e?.message || 'Error al crear pedido' });
  } finally {
    conn.release();
  }
}

/* ============================================================
 * PATCH /api/pedidos/:id
 * Actualiza campos permitidos (incluye lista_para_excel)
 * ============================================================ */
export async function updatePedido(req, res) {
  const conn = await db.getConnection();
  try {
    const id = Number(req.params.id);
    const [[existe]] = await conn.query('SELECT id FROM pedidos WHERE id=?', [id]);
    if (!existe) return res.status(404).json({ error: 'No encontrado' });

    const camposPermitidos = [
      'total', 'estado', 'procesado', 'listo_para_pedido_gral',
      'carga_id', 'observaciones', 'fecha', 'id_vendedor', 'id_camioneta',
      'lista_para_excel', 'pedido_especial'
    ];
    const sets = [];
    const params = [];
    for (const k of camposPermitidos) {
      if (Object.prototype.hasOwnProperty.call(req.body, k)) {
        sets.push(`${k} = ?`);
        params.push(req.body[k]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Sin cambios' });

    params.push(id);
    await conn.query(`UPDATE pedidos SET ${sets.join(', ')} WHERE id = ?`, params);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Error al actualizar pedido' });
  } finally {
    conn.release();
  }
}

/* ============================================================
 * DELETE /api/pedidos/:id
 * Borra pedido + detalle
 * ============================================================ */
export async function deletePedido(req, res) {
  const conn = await db.getConnection();
  try {
    const id = Number(req.params.id);
    await conn.beginTransaction();
    await conn.query('DELETE FROM pedido_detalle_hist WHERE pedido_id=?', [id]);
    const [r] = await conn.query('DELETE FROM pedidos WHERE id=?', [id]);
    await conn.commit();
    if (!r.affectedRows) return res.status(404).json({ error: 'No encontrado' });
    return res.json({ ok: true });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    return res.status(500).json({ error: e?.message || 'Error al eliminar pedido' });
  } finally {
    conn.release();
  }
}

/* ============================================================
 * GET /api/pedidos/tabla?fecha=YYYY-MM-DD[&excel=1]
 * Estructura para Activity Android
 * ============================================================ */
export async function getTablaPedidos(req, res) {
  try {
    const fecha = req.query.fecha; // opcional
    const onlyExcel = String(req.query.excel || '').trim() === '1';
    const params = [];
    const where = [];

    if (fecha) { where.push('DATE(p.fecha) = ?'); params.push(fecha); }
    else       { where.push('DATE(p.fecha) = CURDATE()'); }

    if (onlyExcel) where.push('p.lista_para_excel = 1');

    const filtro = 'WHERE ' + where.join(' AND ');

    // Vendedores
    const [vendRows] = await db.query(
      `
      SELECT DISTINCT p.id_vendedor AS id, u.nombre AS nombre
        FROM pedidos p
        LEFT JOIN vendedores v ON v.id = p.id_vendedor
        LEFT JOIN usuarios  u ON u.id = v.id_usuario
      ${filtro}
      ORDER BY p.id_vendedor ASC
      `,
      params
    );
    const vendedores = vendRows || [];
    const vendedorIndex = new Map();
    vendedores.forEach((v, i) => vendedorIndex.set(Number(v.id), i));

    // Productos involucrados (AHORA CON color)
    const [prodRows] = await db.query(
      `
      SELECT DISTINCT
             pdh.producto_id                          AS id,
             COALESCE(pr.nombre, pdh.nombre_producto) AS nombre,
             COALESCE(cp.nombre, 'General')           AS categoria,
             CASE
               WHEN LOWER(NULLIF(pr.color,'')) IN ('blanco','amarillo')
                 THEN LOWER(pr.color)
               ELSE NULL
             END                                      AS color
        FROM pedido_detalle_hist pdh
        INNER JOIN pedidos p ON p.id = pdh.pedido_id
        LEFT  JOIN productos pr ON pr.id = pdh.producto_id
        LEFT  JOIN categorias_productos cp ON cp.id = pr.categoria_id
      ${filtro}
      ORDER BY nombre ASC
      `,
      params
    );

    // Cantidades por producto y vendedor
    const [cantidades] = await db.query(
      `
      SELECT
        pdh.producto_id,
        p.id_vendedor,
        SUM(pdh.cantidad_solicitada) AS cantidad
      FROM pedido_detalle_hist pdh
      INNER JOIN pedidos p ON p.id = pdh.pedido_id
      ${filtro}
      GROUP BY pdh.producto_id, p.id_vendedor
      ORDER BY pdh.producto_id, p.id_vendedor
      `,
      params
    );

    const pedidos = (cantidades || []).map(r => ({
      productoId: r.producto_id,
      vendedorIndex: vendedorIndex.has(Number(r.id_vendedor)) ? vendedorIndex.get(Number(r.id_vendedor)) : 0,
      cantidad: Number(r.cantidad || 0),
    }));


       // ======= NUEVO: especiales por vendedor para la misma fecha/filtro =======
    const [espRows] = await db.query(
      `
      SELECT p.id            AS pedido_id,
             p.id_vendedor   AS vendedor_id,
             TRIM(p.pedido_especial) AS texto
        FROM pedidos p
      ${filtro}
        AND COALESCE(NULLIF(TRIM(p.pedido_especial),''), NULL) IS NOT NULL
      ORDER BY p.id ASC
      `,
      params
    );

    const especiales = (espRows || []).map(r => ({
      pedidoId: Number(r.pedido_id),
      vendedorIndex: vendedorIndex.has(Number(r.vendedor_id)) ? vendedorIndex.get(Number(r.vendedor_id)) : 0,
      texto: r.texto
    }));

    return res.json({
      productos: prodRows || [],
      vendedores,
      pedidos,
      pedidos,
      especiales, // NUEVO
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Error al generar tabla' });
  }
}

/* ============================================================
 * POST /api/pedidos/excel/reset
 * Body opcional: { pedido_ids: number[] }
 * Si no hay pedido_ids => resetea TODOS los lista_para_excel=1
 * ============================================================ */
export async function resetListaParaExcel(req, res) {
  const conn = await db.getConnection();
  try {
    const ids = Array.isArray(req.body?.pedido_ids)
      ? req.body.pedido_ids.map(Number).filter(x => x > 0)
      : [];

    let sql, params;
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      sql = `UPDATE pedidos SET lista_para_excel = 0 WHERE id IN (${ph})`;
      params = ids;
    } else {
      sql = 'UPDATE pedidos SET lista_para_excel = 0 WHERE lista_para_excel = 1';
      params = [];
    }

    const [r] = await conn.query(sql, params);
    return res.json({ ok: true, afectados: r.affectedRows || 0 });
  } catch (e) {
    return res.status(500).json({ ok:false, msg: e?.message || 'Error reseteando banderas' });
  } finally {
    try { conn.release(); } catch {}
  }
}

/* ============================================================
 * NUEVO
 * POST /api/pedidos/excel/reset-by-fecha
 * Body o query: { fecha: 'YYYY-MM-DD' }
 * Resetea lista_para_excel=0 únicamente para la fecha indicada.
 * ============================================================ */
export async function resetListaParaExcelByFecha(req, res) {
  const conn = await db.getConnection();
  try {
    const fecha = (req.body?.fecha || req.query?.fecha || '').toString().trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return res.status(400).json({ ok:false, msg:'Fecha requerida en formato YYYY-MM-DD' });
    }

    const [r] = await conn.query(
      `
      UPDATE pedidos
         SET lista_para_excel = 0
       WHERE lista_para_excel = 1
         AND DATE(fecha) = ?
      `,
      [fecha]
    );

    return res.json({ ok:true, fecha, afectados: r.affectedRows || 0 });
  } catch (e) {
    return res.status(500).json({ ok:false, msg: e?.message || 'Error reseteando por fecha' });
  } finally {
    try { conn.release(); } catch {}
  }
}
