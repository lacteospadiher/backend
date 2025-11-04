// controllers/admin/inventarioController.js
import db from '../../config/db.js';

/* ============================
 * Utils / Helpers
 * ============================ */

const toDate = (d) => {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10); // YYYY-MM-DD
};

const ensureNumber = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

/** Date -> "YYYY-MM-DD HH:mm:ss" (zona del server) */
function toSqlDateTime(d) {
  const pad = n => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

/** Rango (?ini&?fin) o día de hoy por defecto */
function getRangoFechas(req) {
  const qIni = req.query?.ini;
  const qFin = req.query?.fin;
  const ini = qIni ? new Date(qIni) : new Date(new Date().setHours(0, 0, 0, 0));
  const fin = qFin ? new Date(qFin) : new Date(new Date().setHours(23, 59, 59, 999));
  return { ini: toSqlDateTime(ini), fin: toSqlDateTime(fin) };
}

/** Helper: rango por CARGA usando cargaId (fin = siguiente carga o NOW) */
async function getRangoPorCargaId(cargaId) {
  const [[c]] = await db.query(
    `SELECT id, id_vendedor, id_camioneta, fecha
       FROM cargas
      WHERE id = ?
      LIMIT 1`, [cargaId]
  );
  if (!c) return null;

  const [[nextC]] = await db.query(
    `SELECT fecha
       FROM cargas
      WHERE id_vendedor = ? AND fecha > ?
      ORDER BY fecha ASC
      LIMIT 1`,
    [c.id_vendedor, c.fecha]
  );

  const ini = toSqlDateTime(new Date(c.fecha));
  const fin = toSqlDateTime(nextC?.fecha ? new Date(nextC.fecha) : new Date());
  return { ini, fin, id_vendedor: c.id_vendedor, carga_id: c.id, id_camioneta: c.id_camioneta ?? null };
}

/** Preferimos: 1) no procesada; 2) con restante>0; 3) última por fecha */
async function pickCargaActual(vendedorId) {
  const [[noProc]] = await db.query(
    `SELECT c.id, c.fecha, c.id_vendedor, c.id_camioneta
       FROM cargas c
      WHERE c.id_vendedor = ? AND c.procesada = 0
      ORDER BY c.fecha DESC, c.id DESC
      LIMIT 1`, [vendedorId]
  );
  if (noProc) return noProc;

  const [[conRest]] = await db.query(
    `SELECT c.id, c.fecha, c.id_vendedor, c.id_camioneta
       FROM cargas c
       JOIN detalle_pedido dp ON dp.carga_id = c.id
      WHERE c.id_vendedor = ?
        AND COALESCE(dp.restante, GREATEST(dp.cantidad_inicial - dp.ventas - dp.devoluciones, 0)) > 0
      GROUP BY c.id
      ORDER BY c.fecha DESC, c.id DESC
      LIMIT 1`, [vendedorId]
  );
  if (conRest) return conRest;

  const [[ult]] = await db.query(
    `SELECT c.id, c.fecha, c.id_vendedor, c.id_camioneta
       FROM cargas c
      WHERE c.id_vendedor = ?
      ORDER BY c.fecha DESC, c.id DESC
      LIMIT 1`, [vendedorId]
  );
  return ult || null;
}

/** Rango por CARGA ACTIVA de un vendedor */
async function getRangoPorCargaActiva(vId) {
  const c = await pickCargaActual(vId);
  if (!c) return null;

  const [[nextC]] = await db.query(
    `SELECT fecha
       FROM cargas
      WHERE id_vendedor = ? AND fecha > ?
      ORDER BY fecha ASC
      LIMIT 1`,
    [vId, c.fecha]
  );

  const ini = toSqlDateTime(new Date(c.fecha));
  const fin = toSqlDateTime(nextC?.fecha ? new Date(nextC.fecha) : new Date());
  return { ini, fin, id_vendedor: vId, carga_id: c.id, id_camioneta: c.id_camioneta ?? null };
}

/* ============================
 * INVENTARIO: por día o por carga
 * ============================ */
/**
 * GET /api/inventario/vendedores/:id/dia?fecha=YYYY-MM-DD
 * Soporta: ?scope=carga  (usa la carga ACTIVA o ?cargaId)
 * Devuelve por producto: cargado, vendido, devuelto, restante
 */
export const inventarioDelDiaVendedor = async (req, res) => {
  try {
    const idVendedor = ensureNumber(req.params.id);
    const fecha = toDate(req.query.fecha);
    if (!idVendedor) return res.status(400).json({ error: 'id (vendedor) requerido' });

    const scope = String(req.query.scope || '').toLowerCase();
    const cargaId = req.query.cargaId ? ensureNumber(req.query.cargaId, null) : null;

    let rangoCarga = null;
    if (scope === 'carga') {
      rangoCarga = cargaId
        ? await getRangoPorCargaId(cargaId)
        : await getRangoPorCargaActiva(idVendedor);
      if (!rangoCarga) {
        return res.json({
          fecha: null,
          camioneta_id: null,
          detalle: [],
          totales: { cargado: 0, vendido: 0, devuelto: 0, restante: 0 },
          scope
        });
      }
    }

    // 1) camioneta del vendedor
    const [[vend]] = await db.query(`SELECT camioneta_id FROM vendedores WHERE id = ?`, [idVendedor]);
    const camId = rangoCarga?.id_camioneta ?? vend?.camioneta_id ?? null;

    // 2) Cargado
    let cargadoRows = [];
    if (scope === 'carga') {
      const [rows] = await db.query(
        `SELECT dp.producto_id AS id_producto, SUM(dp.cantidad_inicial) AS cargado
           FROM detalle_pedido dp
          WHERE dp.carga_id = ?
          GROUP BY dp.producto_id`,
        [rangoCarga.carga_id]
      );
      cargadoRows = rows;
    } else {
      if (!fecha || !camId) cargadoRows = [];
      else {
        const [rows] = await db.query(
          `SELECT dp.producto_id AS id_producto, SUM(dp.cantidad_inicial) AS cargado
           FROM cargas c
           JOIN detalle_pedido dp ON dp.carga_id = c.id
           WHERE c.id_camioneta = ?
             AND DATE(c.fecha) = ?
           GROUP BY dp.producto_id`,
          [camId, fecha]
        );
        cargadoRows = rows;
      }
    }

    // 3) Vendido (ventas + público)
    let vendidoRows = [];
    if (scope === 'carga') {
      const [rows] = await db.query(
        `
        SELECT id_producto, SUM(cant) AS vendido FROM (
          SELECT dv.id_producto, SUM(dv.cantidad) AS cant
            FROM ventas v
            JOIN detalle_venta dv ON dv.id_venta = v.id
           WHERE v.id_vendedor = ?
             AND v.fecha BETWEEN ? AND ?
           GROUP BY dv.id_producto
          UNION ALL
          SELECT vpd.producto_id AS id_producto, SUM(vpd.cantidad) AS cant
            FROM ventas_publico vp
            JOIN ventas_publico_detalle vpd ON vpd.venta_publico_id = vp.id
           WHERE vp.id_vendedor = ?
             AND vp.fecha BETWEEN ? AND ?
           GROUP BY vpd.producto_id
        ) t
        GROUP BY id_producto
        `,
        [idVendedor, rangoCarga.ini, rangoCarga.fin, idVendedor, rangoCarga.ini, rangoCarga.fin]
      );
      vendidoRows = rows;
    } else {
      if (!fecha) vendidoRows = [];
      else {
        const [rows] = await db.query(
          `
          SELECT id_producto, SUM(cant) AS vendido FROM (
            SELECT dv.id_producto, SUM(dv.cantidad) AS cant
              FROM ventas v
              JOIN detalle_venta dv ON dv.id_venta = v.id
             WHERE v.id_vendedor = ?
               AND DATE(v.fecha) = ?
             GROUP BY dv.id_producto
            UNION ALL
            SELECT vpd.producto_id AS id_producto, SUM(vpd.cantidad) AS cant
              FROM ventas_publico vp
              JOIN ventas_publico_detalle vpd ON vpd.venta_publico_id = vp.id
             WHERE vp.id_vendedor = ?
               AND DATE(vp.fecha) = ?
             GROUP BY vpd.producto_id
          ) t
          GROUP BY id_producto
          `,
          [idVendedor, fecha, idVendedor, fecha]
        );
        vendidoRows = rows;
      }
    }

    // 4) Devuelto (descargas)
    let devueltoRows = [];
    if (scope === 'carga') {
      if (camId) {
        const [rows] = await db.query(
          `SELECT dp.id_producto, SUM(dp.cantidad) AS devuelto
             FROM descargas d
             JOIN descarga_productos dp ON dp.id_descarga = d.id
            WHERE d.id_camioneta = ?
              AND d.fecha BETWEEN ? AND ?
            GROUP BY dp.id_producto`,
          [camId, rangoCarga.ini, rangoCarga.fin]
        );
        devueltoRows = rows;
      }
    } else {
      if (camId && fecha) {
        const [rows] = await db.query(
          `SELECT dp.id_producto, SUM(dp.cantidad) AS devuelto
             FROM descargas d
             JOIN descarga_productos dp ON dp.id_descarga = d.id
            WHERE d.id_camioneta = ?
              AND DATE(d.fecha) = ?
            GROUP BY dp.id_producto`,
          [camId, fecha]
        );
        devueltoRows = rows;
      }
    }

    // Unión y enriquecido
    const map = new Map();
    const add = (rows, field) => {
      for (const r of rows) {
        const pid = ensureNumber(r.id_producto, null);
        if (pid == null) continue;
        const cur = map.get(pid) || { id_producto: pid, cargado: 0, vendido: 0, devuelto: 0 };
        cur[field] = ensureNumber(r[field]);
        map.set(pid, cur);
      }
    };
    add(cargadoRows, 'cargado');
    add(vendidoRows, 'vendido');
    add(devueltoRows, 'devuelto');

    const productosIds = [...map.keys()];
    let productosInfo = [];
    if (productosIds.length) {
      const placeholders = productosIds.map(() => '?').join(',');
      const [info] = await db.query(
        `SELECT p.id, p.nombre, p.unidad_medida, p.cantidad, p.color, p.tipo_venta,
                p.categoria_id, cp.nombre AS categoria_nombre
           FROM productos p
           LEFT JOIN categorias_productos cp ON cp.id = p.categoria_id
          WHERE p.id IN (${placeholders})`,
        productosIds
      );
      productosInfo = info;
    }
    const infoById = new Map(productosInfo.map(p => [p.id, p]));

    const detalle = [...map.values()]
      .map(x => ({
        ...x,
        restante: ensureNumber((x.cargado || 0) - (x.vendido || 0) - (x.devuelto || 0)),
        producto: infoById.get(x.id_producto) || null
      }))
      .sort((a, b) => (b.cargado || 0) - (a.cargado || 0));

    const totales = detalle.reduce((acc, it) => {
      acc.cargado += it.cargado || 0;
      acc.vendido += it.vendido || 0;
      acc.devuelto += it.devuelto || 0;
      acc.restante += it.restante || 0;
      return acc;
    }, { cargado: 0, vendido: 0, devuelto: 0, restante: 0 });

    res.json({
      fecha: scope === 'carga' ? null : fecha,
      camioneta_id: rangoCarga?.id_camioneta ?? vend?.camioneta_id ?? null,
      detalle,
      totales,
      scope
    });
  } catch (e) {
    console.error('inventarioDelDiaVendedor', e);
    res.status(500).json({ error: 'Error al obtener inventario' });
  }
};

/**
 * GET /api/inventario/vendedores/:id/historial?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Sumas por día (cargado, vendido, devuelto, restante)
 */
export const historialInventarioVendedor = async (req, res) => {
  try {
    const idVendedor = ensureNumber(req.params.id);
    if (!idVendedor) return res.status(400).json({ error: 'id vendedor requerido' });

    const from = toDate(req.query.from) || toDate(new Date(Date.now() - 29*86400000));
    const to   = toDate(req.query.to)   || toDate(new Date());

    const [[vend]] = await db.query(`SELECT camioneta_id FROM vendedores WHERE id = ?`, [idVendedor]);
    const camId = vend?.camioneta_id || null;

    const [cargado] = camId
      ? await db.query(
          `
          SELECT DATE(c.fecha) AS dia, SUM(dp.cantidad_inicial) AS cargado
            FROM cargas c
            JOIN detalle_pedido dp ON dp.carga_id = c.id
           WHERE c.id_camioneta = ?
             AND DATE(c.fecha) BETWEEN ? AND ?
           GROUP BY DATE(c.fecha)
          `,
          [camId, from, to]
        )
      : [ [] ];

    const [vendido] = await db.query(
      `
      SELECT dia, SUM(vendido) AS vendido
        FROM (
          SELECT DATE(v.fecha) AS dia, SUM(dv.cantidad) AS vendido
            FROM ventas v
            JOIN detalle_venta dv ON dv.id_venta = v.id
           WHERE v.id_vendedor = ?
             AND DATE(v.fecha) BETWEEN ? AND ?
           GROUP BY DATE(v.fecha)

          UNION ALL

          SELECT DATE(vp.fecha) AS dia, SUM(vpd.cantidad) AS vendido
            FROM ventas_publico vp
            JOIN ventas_publico_detalle vpd ON vpd.venta_publico_id = vp.id
           WHERE vp.id_vendedor = ?
             AND DATE(vp.fecha) BETWEEN ? AND ?
           GROUP BY DATE(vp.fecha)
        ) t
       GROUP BY dia
      `,
      [idVendedor, from, to, idVendedor, from, to]
    );

    const [devuelto] = camId
      ? await db.query(
          `
          SELECT DATE(d.fecha) AS dia, SUM(dp.cantidad) AS devuelto
            FROM descargas d
            JOIN descarga_productos dp ON dp.id_descarga = d.id
           WHERE d.id_camioneta = ?
             AND DATE(d.fecha) BETWEEN ? AND ?
           GROUP BY DATE(d.fecha)
          `,
          [camId, from, to]
        )
      : [ [] ];

    const byDay = new Map();
    const add = (rows, field) => {
      for (const r of rows) {
        const dia = toDate(r.dia);
        const cur = byDay.get(dia) || { dia, cargado: 0, vendido: 0, devuelto: 0, restante: 0 };
        cur[field] = ensureNumber(r[field]);
        byDay.set(dia, cur);
      }
    };
    add(cargado, 'cargado');
    add(vendido, 'vendido');
    add(devuelto, 'devuelto');
    for (const v of byDay.values()) {
      v.restante = (v.cargado || 0) - (v.vendido || 0) - (v.devuelto || 0);
    }

    const rows = [...byDay.values()].sort((a,b)=> a.dia.localeCompare(b.dia));
    res.json({ from, to, rows });
  } catch (e) {
    console.error('historialInventarioVendedor', e);
    res.status(500).json({ error: 'Error al obtener historial' });
  }
};

/* ============================
 * CARGAS / DESCARGAS
 * ============================ */

/**
 * POST /api/inventario/cargas
 * body: { id_camioneta?, id_vendedor?, id_usuario?, observaciones?, items:[{id_producto, cantidad_inicial, precio_unitario?, nombre_producto?}] }
 */
export const crearCarga = async (req, res) => {
  const { id_camioneta, id_vendedor, id_usuario = null, observaciones = null, items = [] } = req.body || {};
  if (!id_camioneta && !id_vendedor) return res.status(400).json({ error: 'id_camioneta o id_vendedor requerido' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items vacío' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    let camId = id_camioneta ? ensureNumber(id_camioneta, null) : null;
    if (!camId && id_vendedor) {
      const [[vend]] = await conn.query(`SELECT camioneta_id FROM vendedores WHERE id = ?`, [ensureNumber(id_vendedor)]);
      camId = vend?.camioneta_id;
      if (!camId) throw new Error('Vendedor sin camioneta asignada');
    }

    const [ins] = await conn.query(
      `INSERT INTO cargas (id_camioneta, id_usuario, id_vendedor, observaciones)
       VALUES (?, ?, ?, ?)`,
      [camId, id_usuario, id_vendedor || null, observaciones]
    );
    const id_carga = ins.insertId;

    for (const it of items) {
      await conn.query(
        `INSERT INTO detalle_pedido
           (carga_id, producto_id, nombre_producto, cantidad_inicial, precio_unitario, ventas, devoluciones)
         VALUES (?,?,?,?,?,0,0)`,
        [
          id_carga,
          ensureNumber(it.id_producto),
          it.nombre_producto ?? String(it.id_producto),
          ensureNumber(it.cantidad_inicial ?? it.cantidad ?? 0),
          ensureNumber(it.precio_unitario ?? 0),
        ]
      );
    }

    await conn.commit();
    res.json({ mensaje: 'Carga registrada', id_carga });
  } catch (e) {
    await conn.rollback();
    console.error('crearCarga', e);
    res.status(500).json({ error: e.message || 'Error al crear carga' });
  } finally {
    conn.release();
  }
};

/**
 * GET /api/inventario/vendedores/:id/cargas?from=&to=
 */
export const listarCargasDeVendedor = async (req, res) => {
  try {
    const idVendedor = ensureNumber(req.params.id);
    const from = toDate(req.query.from) || toDate(new Date(Date.now() - 29*86400000));
    const to   = toDate(req.query.to)   || toDate(new Date());

    const [[vend]] = await db.query(`SELECT camioneta_id FROM vendedores WHERE id = ?`, [idVendedor]);
    const camId = vend?.camioneta_id || null;
    if (!camId) return res.json([]);

    const [rows] = await db.query(
      `
      SELECT c.id, c.fecha, c.observaciones,
             SUM(dp.cantidad_inicial) AS total_piezas
        FROM cargas c
        JOIN detalle_pedido dp ON dp.carga_id = c.id
       WHERE c.id_camioneta = ?
         AND DATE(c.fecha) BETWEEN ? AND ?
       GROUP BY c.id
       ORDER BY c.fecha DESC, c.id DESC
      `,
      [camId, from, to]
    );

    res.json(rows);
  } catch (e) {
    console.error('listarCargasDeVendedor', e);
    res.status(500).json({ error: 'Error al listar cargas' });
  }
};

/**
 * POST /api/inventario/descargas
 * body: { id_camioneta?, id_vendedor?, id_usuario?, observaciones?, items:[{id_producto, cantidad}] }
 */
export const crearDescarga = async (req, res) => {
  const { id_camioneta, id_vendedor, id_usuario = null, observaciones = null, items = [] } = req.body || {};
  if (!id_camioneta && !id_vendedor) return res.status(400).json({ error: 'id_camioneta o id_vendedor requerido' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items vacío' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    let camId = id_camioneta ? ensureNumber(id_camioneta, null) : null;
    if (!camId && id_vendedor) {
      const [[vend]] = await conn.query(`SELECT camioneta_id FROM vendedores WHERE id = ?`, [ensureNumber(id_vendedor)]);
      camId = vend?.camioneta_id;
      if (!camId) throw new Error('Vendedor sin camioneta asignada');
    }

    const [ins] = await conn.query(
      `INSERT INTO descargas (id_camioneta, id_usuario, fecha, observaciones, procesada, lista_para_confirmar)
       VALUES (?, ?, NOW(), ?, 0, 1)`,
      [camId, id_usuario, observaciones]
    );
    const id_descarga = ins.insertId;

    for (const it of items) {
      await conn.query(
        `INSERT INTO descarga_productos (id_descarga, id_producto, cantidad)
         VALUES (?, ?, ?)`,
        [id_descarga, ensureNumber(it.id_producto), ensureNumber(it.cantidad)]
      );
    }

    await conn.commit();
    res.json({ mensaje: 'Descarga registrada', id_descarga });
  } catch (e) {
    await conn.rollback();
    console.error('crearDescarga', e);
    res.status(500).json({ error: e.message || 'Error al crear descarga' });
  } finally {
    conn.release();
  }
};

/**
 * GET /api/inventario/vendedores/:id/descargas?from=&to=
 */
export const listarDescargasDeVendedor = async (req, res) => {
  try {
    const idVendedor = ensureNumber(req.params.id);
    const from = toDate(req.query.from) || toDate(new Date(Date.now() - 29*86400000));
    const to   = toDate(req.query.to)   || toDate(new Date());

    const [[vend]] = await db.query(`SELECT camioneta_id FROM vendedores WHERE id = ?`, [idVendedor]);
    const camId = vend?.camioneta_id || null;
    if (!camId) return res.json([]);

    const [rows] = await db.query(
      `
      SELECT d.id, d.fecha, d.observaciones,
             SUM(dp.cantidad) AS total_piezas
        FROM descargas d
        JOIN descarga_productos dp ON dp.id_descarga = d.id
       WHERE d.id_camioneta = ?
         AND DATE(d.fecha) BETWEEN ? AND ?
       GROUP BY d.id
       ORDER BY d.fecha DESC, d.id DESC
      `,
      [camId, from, to]
    );

    res.json(rows);
  } catch (e) {
    console.error('listarDescargasDeVendedor', e);
    res.status(500).json({ error: 'Error al listar descargas' });
  }
};

/* ============================
 * NUEVOS ENDPOINTS PARA EL FRONT (Admin)
 * ============================ */

/**
 * GET /api/inventario/vendedores/:id/resumen?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 * Opcional: ?scope=carga[&cargaId]
 * Suma por producto (cargado, vendido, devuelto, restante)
 */
export const resumenInventarioVendedor = async (req, res) => {
  try {
    const idVendedor = ensureNumber(req.params.id);
    const desde = toDate(req.query.desde) || toDate(new Date(Date.now() - 29*86400000));
    const hasta = toDate(req.query.hasta) || toDate(new Date());

    const scope = String(req.query.scope || '').toLowerCase();
    const cargaId = req.query.cargaId ? ensureNumber(req.query.cargaId, null) : null;

    const [[vend]] = await db.query(`SELECT camioneta_id FROM vendedores WHERE id = ?`, [idVendedor]);
    const camId = vend?.camioneta_id || null;

    // Filtros por carga
    let rango = null;
    if (scope === 'carga') {
      rango = cargaId ? await getRangoPorCargaId(cargaId) : await getRangoPorCargaActiva(idVendedor);
      if (!rango) {
        return res.json({
          desde: null, hasta: null, camioneta_id: camId,
          detalle: [], totales: { cargado:0, vendido:0, devuelto:0, restante:0 }
        });
      }
    }

    // Cargado
    let cargado = [];
    if (scope === 'carga') {
      const [rows] = await db.query(
        `SELECT dp.producto_id AS id_producto, SUM(dp.cantidad_inicial) AS cargado
           FROM detalle_pedido dp
          WHERE dp.carga_id = ?
          GROUP BY dp.producto_id`,
        [rango.carga_id]
      );
      cargado = rows;
    } else if (camId) {
      const [rows] = await db.query(
        `SELECT dp.producto_id AS id_producto, SUM(dp.cantidad_inicial) AS cargado
           FROM cargas c
           JOIN detalle_pedido dp ON dp.carga_id = c.id
          WHERE c.id_camioneta = ?
            AND DATE(c.fecha) BETWEEN ? AND ?
          GROUP BY dp.producto_id`,
        [camId, desde, hasta]
      );
      cargado = rows;
    }

    // Vendido
    let vendido = [];
    if (scope === 'carga') {
      const [rows] = await db.query(
        `
        SELECT id_producto, SUM(cant) AS vendido FROM (
          SELECT dv.id_producto, SUM(dv.cantidad) AS cant
            FROM ventas v
            JOIN detalle_venta dv ON dv.id_venta = v.id
           WHERE v.id_vendedor = ?
             AND v.fecha BETWEEN ? AND ?
           GROUP BY dv.id_producto

          UNION ALL

          SELECT vpd.producto_id AS id_producto, SUM(vpd.cantidad) AS cant
            FROM ventas_publico vp
            JOIN ventas_publico_detalle vpd ON vpd.venta_publico_id = vp.id
           WHERE vp.id_vendedor = ?
             AND vp.fecha BETWEEN ? AND ?
           GROUP BY vpd.producto_id
        ) t
        GROUP BY id_producto
        `,
        [idVendedor, rango.ini, rango.fin, idVendedor, rango.ini, rango.fin]
      );
      vendido = rows;
    } else {
      const [rows] = await db.query(
        `
        SELECT id_producto, SUM(cant) AS vendido FROM (
          SELECT dv.id_producto, SUM(dv.cantidad) AS cant
            FROM ventas v
            JOIN detalle_venta dv ON dv.id_venta = v.id
           WHERE v.id_vendedor = ?
             AND DATE(v.fecha) BETWEEN ? AND ?
           GROUP BY dv.id_producto

          UNION ALL

          SELECT vpd.producto_id AS id_producto, SUM(vpd.cantidad) AS cant
            FROM ventas_publico vp
            JOIN ventas_publico_detalle vpd ON vpd.venta_publico_id = vp.id
           WHERE vp.id_vendedor = ?
             AND DATE(vp.fecha) BETWEEN ? AND ?
           GROUP BY vpd.producto_id
        ) t
        GROUP BY id_producto
        `,
        [idVendedor, desde, hasta, idVendedor, desde, hasta]
      );
      vendido = rows;
    }

    // Devuelto
    let devuelto = [];
    if (scope === 'carga') {
      if (camId) {
        const [rows] = await db.query(
          `SELECT dp.id_producto, SUM(dp.cantidad) AS devuelto
             FROM descargas d
             JOIN descarga_productos dp ON dp.id_descarga = d.id
            WHERE d.id_camioneta = ?
              AND d.fecha BETWEEN ? AND ?
            GROUP BY dp.id_producto`,
          [camId, rango.ini, rango.fin]
        );
        devuelto = rows;
      }
    } else if (camId) {
      const [rows] = await db.query(
        `SELECT dp.id_producto, SUM(dp.cantidad) AS devuelto
           FROM descargas d
           JOIN descarga_productos dp ON dp.id_descarga = d.id
          WHERE d.id_camioneta = ?
            AND DATE(d.fecha) BETWEEN ? AND ?
          GROUP BY dp.id_producto`,
        [camId, desde, hasta]
      );
      devuelto = rows;
    }

    // Unión
    const map = new Map();
    const add = (rows, field) => {
      for (const r of rows) {
        const pid = ensureNumber(r.id_producto, null);
        if (pid == null) continue;
        const cur = map.get(pid) || { id_producto: pid, cargado: 0, vendido: 0, devuelto: 0 };
        cur[field] = ensureNumber(r[field]);
        map.set(pid, cur);
      }
    };
    add(cargado, 'cargado');
    add(vendido, 'vendido');
    add(devuelto, 'devuelto');

    const ids = [...map.keys()];
    let infoById = new Map();
    if (ids.length) {
      const [prods] = await db.query(
        `SELECT id, nombre, cantidad, unidad_medida, color, tipo_venta
           FROM productos
          WHERE id IN (${ids.map(()=>'?').join(',')})`,
        ids
      );
      infoById = new Map(prods.map(p => [p.id, p]));
    }

    const detalle = [...map.values()].map(x => ({
      ...x,
      restante: (x.cargado||0) - (x.vendido||0) - (x.devuelto||0),
      producto: infoById.get(x.id_producto) || null
    })).sort((a,b)=> (b.cargado||0) - (a.cargado||0));

    const totales = detalle.reduce((t, r) => {
      t.cargado  += r.cargado  || 0;
      t.vendido  += r.vendido  || 0;
      t.devuelto += r.devuelto || 0;
      t.restante += r.restante || 0;
      return t;
    }, { cargado: 0, vendido: 0, devuelto: 0, restante: 0 });

    res.json({
      desde: scope==='carga' ? rango.ini.slice(0,10) : desde,
      hasta: scope==='carga' ? rango.fin.slice(0,10) : hasta,
      camioneta_id: camId,
      detalle,
      totales,
      scope
    });
  } catch (e) {
    console.error('resumenInventarioVendedor', e);
    res.status(500).json({ error: 'Error al consultar resumen' });
  }
};

/**
 * GET /api/inventario/vendedores/:id/movimientos?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&tipo=(carga|venta|descarga|todos)
 * Opcional: ?scope=carga[&cargaId]
 * Devuelve listado plano de movimientos con producto enriquecido
 */
export const movimientosInventarioVendedor = async (req, res) => {
  try {
    const idVendedor = ensureNumber(req.params.id);
    const desde = toDate(req.query.desde) || toDate(new Date(Date.now() - 29*86400000));
    const hasta = toDate(req.query.hasta) || toDate(new Date());
    const tipo  = (req.query.tipo || 'todos').toLowerCase();

    const scope = String(req.query.scope || '').toLowerCase();
    const cargaId = req.query.cargaId ? ensureNumber(req.query.cargaId, null) : null;

    const [[vend]] = await db.query(`SELECT camioneta_id FROM vendedores WHERE id = ?`, [idVendedor]);
    const camId = vend?.camioneta_id || null;

    let rango = null;
    if (scope === 'carga') {
      rango = cargaId ? await getRangoPorCargaId(cargaId) : await getRangoPorCargaActiva(idVendedor);
      if (!rango) return res.json({ desde:null, hasta:null, items: [], scope });
    }

    const promises = [];

    // CARGAS
    if ((tipo === 'todos' || tipo === 'carga') && camId) {
      if (scope === 'carga') {
        promises.push(db.query(
          `SELECT 'carga' AS tipo, c.id AS id_ref, c.fecha, dp.producto_id AS id_producto, dp.cantidad_inicial AS cantidad, c.observaciones AS notas
             FROM cargas c
             JOIN detalle_pedido dp ON dp.carga_id = c.id
            WHERE dp.carga_id = ?`,
          [rango.carga_id]
        ));
      } else {
        promises.push(db.query(
          `SELECT 'carga' AS tipo, c.id AS id_ref, c.fecha, dp.producto_id AS id_producto, dp.cantidad_inicial AS cantidad, c.observaciones AS notas
             FROM cargas c
             JOIN detalle_pedido dp ON dp.carga_id = c.id
            WHERE c.id_camioneta = ?
              AND DATE(c.fecha) BETWEEN ? AND ?`,
          [camId, desde, hasta]
        ));
      }
    }

    // VENTAS (cliente + público)
    if (tipo === 'todos' || tipo === 'venta') {
      if (scope === 'carga') {
        promises.push(db.query(
          `SELECT 'venta' AS tipo, v.id AS id_ref, v.fecha, dv.id_producto, dv.cantidad, NULL AS notas
             FROM ventas v
             JOIN detalle_venta dv ON dv.id_venta = v.id
            WHERE v.id_vendedor = ?
              AND v.fecha BETWEEN ? AND ?`,
          [idVendedor, rango.ini, rango.fin]
        ));
        promises.push(db.query(
          `SELECT 'venta_publico' AS tipo, vp.id AS id_ref, vp.fecha, vpd.producto_id AS id_producto, vpd.cantidad, NULL AS notas
             FROM ventas_publico vp
             JOIN ventas_publico_detalle vpd ON vpd.venta_publico_id = vp.id
            WHERE vp.id_vendedor = ?
              AND vp.fecha BETWEEN ? AND ?`,
          [idVendedor, rango.ini, rango.fin]
        ));
      } else {
        promises.push(db.query(
          `SELECT 'venta' AS tipo, v.id AS id_ref, v.fecha, dv.id_producto, dv.cantidad, NULL AS notas
             FROM ventas v
             JOIN detalle_venta dv ON dv.id_venta = v.id
            WHERE v.id_vendedor = ?
              AND DATE(v.fecha) BETWEEN ? AND ?`,
          [idVendedor, desde, hasta]
        ));
        promises.push(db.query(
          `SELECT 'venta_publico' AS tipo, vp.id AS id_ref, vp.fecha, vpd.producto_id AS id_producto, vpd.cantidad, NULL AS notas
             FROM ventas_publico vp
             JOIN ventas_publico_detalle vpd ON vpd.venta_publico_id = vp.id
            WHERE vp.id_vendedor = ?
              AND DATE(vp.fecha) BETWEEN ? AND ?`,
          [idVendedor, desde, hasta]
        ));
      }
    }

    // DESCARGAS
    if ((tipo === 'todos' || tipo === 'descarga') && camId) {
      if (scope === 'carga') {
        promises.push(db.query(
          `SELECT 'descarga' AS tipo, d.id AS id_ref, d.fecha, dp.id_producto, dp.cantidad, d.observaciones AS notas
             FROM descargas d
             JOIN descarga_productos dp ON dp.id_descarga = d.id
            WHERE d.id_camioneta = ?
              AND d.fecha BETWEEN ? AND ?`,
          [camId, rango.ini, rango.fin]
        ));
      } else {
        promises.push(db.query(
          `SELECT 'descarga' AS tipo, d.id AS id_ref, d.fecha, dp.id_producto, dp.cantidad, d.observaciones AS notas
             FROM descargas d
             JOIN descarga_productos dp ON dp.id_descarga = d.id
            WHERE d.id_camioneta = ?
              AND DATE(d.fecha) BETWEEN ? AND ?`,
          [camId, desde, hasta]
        ));
      }
    }

    const results = await Promise.all(promises);
    const flat = results.flatMap(([rows]) => rows);

    const ids = [...new Set(flat.map(r => r.id_producto))].filter(Boolean);
    let infoById = new Map();
    if (ids.length) {
      const [prods] = await db.query(
        `SELECT id, nombre, cantidad, unidad_medida, color, tipo_venta
           FROM productos
          WHERE id IN (${ids.map(()=>'?').join(',')})`,
        ids
      );
      infoById = new Map(prods.map(p => [p.id, p]));
    }

    const enriched = flat.map(r => ({
      ...r,
      producto: r.id_producto ? (infoById.get(r.id_producto) || null) : null
    })).sort((a,b) => new Date(b.fecha) - new Date(a.fecha));

    res.json({
      desde: scope==='carga' ? rango.ini.slice(0,10) : desde,
      hasta: scope==='carga' ? rango.fin.slice(0,10) : hasta,
      items: enriched,
      scope
    });
  } catch (e) {
    console.error('movimientosInventarioVendedor', e);
    res.status(500).json({ error: 'Error al consultar movimientos' });
  }
};
