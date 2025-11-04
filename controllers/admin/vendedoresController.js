// controllers/admin/vendedoresController.js
import db from '../../config/db.js';

/* ==== Helpers para rango por carga ==== */
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
const ensureNumber = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

async function getRangoPorCargaId(cargaId) {
  const [[c]] = await db.query(
    `SELECT id, id_vendedor, fecha
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
  return { ini, fin, id_vendedor: c.id_vendedor, carga_id: c.id };
}

async function pickCargaActual(vendedorId) {
  const [[noProc]] = await db.query(
    `SELECT c.id, c.fecha
       FROM cargas c
      WHERE c.id_vendedor = ? AND c.procesada = 0
      ORDER BY c.fecha DESC, c.id DESC
      LIMIT 1`, [vendedorId]
  );
  if (noProc) return noProc;

  const [[conRest]] = await db.query(
    `SELECT c.id, c.fecha
       FROM cargas c
       JOIN detalle_pedido dp ON dp.carga_id = c.id
      WHERE c.id_vendedor = ?
        AND COALESCE(dp.restante, GREATEST(dp.cantidad_inicial - dp.ventas + dp.devoluciones, 0)) > 0
      GROUP BY c.id
      ORDER BY c.fecha DESC, c.id DESC
      LIMIT 1`, [vendedorId]
  );
  if (conRest) return conRest;

  const [[ult]] = await db.query(
    `SELECT c.id, c.fecha
       FROM cargas c
      WHERE c.id_vendedor = ?
      ORDER BY c.fecha DESC, c.id DESC
      LIMIT 1`, [vendedorId]
  );
  return ult || null;
}

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
  return { ini, fin, carga_id: c.id };
}

/**
 * GET /api/vendedores?search=&activo=1
 * Devuelve: [{ id, nombre, activo }]
 */
export const listarVendedores = async (req, res) => {
  try {
    const { search, activo } = req.query;
    const where = ['v.eliminado = 0'];
    const params = [];

    if (activo !== undefined && activo !== '') {
      where.push('v.activo = ?');
      params.push(Number(!!Number(activo)));
    }
    if (search) {
      where.push('(u.nombre LIKE ? OR u.usuario LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    const [rows] = await db.query(
      `
      SELECT
        v.id,
        u.nombre AS nombre,
        v.activo
      FROM vendedores v
      JOIN usuarios u ON u.id = v.id_usuario
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY u.nombre
      `,
      params
    );

    res.json(rows);
  } catch (e) {
    console.error('listarVendedores', e);
    res.status(500).json({ error: 'Error al listar vendedores' });
  }
};

export const obtenerVendedor = async (req, res) => {
  try {
    const { id } = req.params;
    const [[row]] = await db.query(
      `
      SELECT v.id, v.activo, v.fecha_registro,
             u.nombre,
             e.nombre AS estado, m.nombre AS municipio
      FROM vendedores v
      JOIN usuarios u ON u.id = v.id_usuario
      LEFT JOIN estados e ON e.id = v.id_estado
      LEFT JOIN municipios m ON m.id = v.id_municipio
      WHERE v.id = ? AND v.eliminado = 0
    `,
      [id]
    );

    if (!row) return res.status(404).json({ error: 'Vendedor no encontrado' });
    res.json(row);
  } catch (e) {
    console.error('obtenerVendedor', e);
    res.status(500).json({ error: 'Error al obtener vendedor' });
  }
};

// GET /api/vendedores/:id/dashboard
export const dashboardVendedor = async (req, res) => {
  const { id } = req.params;
  try {
    // 1) vendedor base
    const [[vendedor]] = await db.query(
      `
      SELECT v.id, v.activo, v.fecha_registro,
             u.nombre,
             e.nombre AS estado, m.nombre AS municipio
      FROM vendedores v
      JOIN usuarios u ON u.id = v.id_usuario
      LEFT JOIN estados e ON e.id = v.id_estado
      LEFT JOIN municipios m ON m.id = v.id_municipio
      WHERE v.id = ? AND v.eliminado = 0
    `,
      [id]
    );
    if (!vendedor) return res.status(404).json({ error: 'Vendedor no encontrado' });

    // 2) camioneta
    const [[camioneta]] = await db.query(
      `
      SELECT c.id, c.placa, c.marca, c.modelo, c.color, c.kilometraje_actual, c.tiene_refrigeracion
      FROM camionetas c
      JOIN vendedores v ON v.camioneta_id = c.id
      WHERE v.id = ?
    `,
      [id]
    );

    // 3) ruta de hoy
    const [[ruta_hoy]] = await db.query(
      `
      SELECT id, fecha, estado, inicio_en, termino_en, regreso_confirmado, fecha_regreso
      FROM rutas_diarias
      WHERE id_vendedor = ? AND fecha = CURDATE()
      LIMIT 1
      `,
      [id]
    );

    // 4) KPIs: hoy
    const [[kpiHoy]] = await db.query(
      `
      SELECT COUNT(*) AS ventasHoy, IFNULL(SUM(total),0) AS totalHoy
      FROM ventas
      WHERE id_vendedor = ? AND DATE(fecha) = CURDATE()
    `,
      [id]
    );

    // 5) KPIs: últimos 30 días
    const [[kpi30]] = await db.query(
      `
      SELECT COUNT(*) AS ventas30d,
             IFNULL(SUM(total),0) AS total30d,
             COUNT(DISTINCT id_cliente) AS clientes30d
      FROM ventas
      WHERE id_vendedor = ? AND fecha >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    `,
      [id]
    );

    // 6) ventas recientes
    const [ventas_recientes] = await db.query(
      `
      SELECT id, fecha, total, tipo_pago, id_cliente, cliente, es_publico
      FROM (
        /* ventas con cliente */
        SELECT v.id,
               v.fecha,
               v.total,
               v.tipo_pago,
               v.id_cliente,
               COALESCE(c.nombre_empresa, 'PÚBLICO GENERAL') AS cliente,
               IF(c.clave='PUBLICO' OR v.id_cliente IS NULL, 1, 0) AS es_publico
        FROM ventas v
        LEFT JOIN clientes c ON c.id = v.id_cliente
        WHERE v.id_vendedor = ?

        UNION ALL

        /* ventas_publico */
        SELECT vp.id,
               vp.fecha,
               vp.total,
               'publico' AS tipo_pago,
               NULL      AS id_cliente,
               'PÚBLICO GENERAL' AS cliente,
               1 AS es_publico
        FROM ventas_publico vp
        WHERE vp.id_vendedor = ?
      ) x
      ORDER BY fecha DESC, id DESC
      LIMIT 10
      `,
      [id, id]
    );

    res.json({
      vendedor,
      camioneta: camioneta || null,
      ruta_hoy: ruta_hoy || null,
      kpis: {
        ventasHoy: Number(kpiHoy?.ventasHoy || 0),
        totalHoy: Number(kpiHoy?.totalHoy || 0),
        ventas30d: Number(kpi30?.ventas30d || 0),
        total30d: Number(kpi30?.total30d || 0),
        clientes30d: Number(kpi30?.clientes30d || 0),
      },
      ventas_recientes,
    });
  } catch (e) {
    console.error('dashboardVendedor', e);
    res.status(500).json({ error: 'Error al cargar dashboard del vendedor' });
  }
};

export const listarVendedoresSimple = async (req, res) => {
  try {
    const activos = req.query.activos === '1';
    const [rows] = await db.query(
      `
      SELECT ve.id, u.nombre
      FROM vendedores ve
      JOIN usuarios u ON u.id = ve.id_usuario
      ${activos ? 'WHERE ve.activo=1 AND ve.eliminado=0' : ''}
      ORDER BY u.nombre
    `
    );
    res.json(rows);
  } catch (e) {
    console.error('listarVendedoresSimple', e);
    res.status(500).json({ error: 'Error al listar vendedores' });
  }
};

/* ===========================
   ENDPOINTS detalle
   =========================== */

/**
 * GET /api/vendedores/:id/timeline?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=50&offset=0[&scope=carga][&cargaId=###]
 * NOTA: NO usa vista. Une eventos de cargas, ventas, devoluciones, descargas y no-ventas.
 */
// ... imports y helpers arriba (sin cambios)

/**
 * GET /api/vendedores/:id/timeline?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=50&offset=0[&scope=carga][&cargaId=###]
 * NOTA: NO usa vista. Une eventos de cargas, ventas, devoluciones, descargas y no-ventas.
 */
export const timelineVendedor = async (req, res) => {
  try {
    const idV = ensureNumber(req.params.id);
    const { from, to } = req.query;
    const limit = Math.min(Math.max(ensureNumber(req.query.limit, 50), 1), 500);
    const offset = Math.max(ensureNumber(req.query.offset, 0), 0);

    const scope = String(req.query.scope || '').toLowerCase();
    const cargaId = req.query.cargaId ? ensureNumber(req.query.cargaId, null) : null;

    const params = [idV, idV, idV, idV, idV, idV];
    let whereFecha = '';
    let rango = null;

    if (scope === 'carga') {
      rango = cargaId ? await getRangoPorCargaId(cargaId) : await getRangoPorCargaActiva(idV);
      if (!rango) return res.json([]);
      whereFecha += ` AND ev.fecha BETWEEN ? AND ?`;
    } else {
      if (from) { whereFecha += ` AND ev.fecha >= ?`; }
      if (to)   { whereFecha += ` AND ev.fecha < DATE_ADD(?, INTERVAL 1 DAY)`; }
    }

    const fechaParams = (scope==='carga')
      ? [rango.ini, rango.fin]
      : [ ...(from ? [from] : []), ...(to ? [to] : []) ];

    const [rows] = await db.query(
      `
      SELECT * FROM (
        /* Carga */
        SELECT
          'carga'        AS tipo,
          c.fecha        AS fecha,
          c.id           AS id_ref,
          CONCAT('Carga #', c.id) AS descripcion,
          JSON_OBJECT(
            'piezas', IFNULL(SUM(dp.cantidad_inicial),0),
            'procesada', c.procesada,
            'lista_para_confirmar', c.lista_para_confirmar
          ) AS extra_json
        FROM cargas c
        JOIN detalle_pedido dp ON dp.carga_id = c.id
        WHERE c.id_vendedor = ?
        GROUP BY c.id

        UNION ALL

        /* Venta (con cliente) */
        SELECT
          'venta'        AS tipo,
          v.fecha        AS fecha,
          v.id           AS id_ref,
          COALESCE(c2.nombre_empresa, 'PÚBLICO GENERAL') AS descripcion,
          JSON_OBJECT(
            'total', v.total,
            'tipo_pago', v.tipo_pago,
            'metodo_pago', v.metodo_pago,
            'id_cliente', v.id_cliente
          ) AS extra_json
        FROM ventas v
        LEFT JOIN clientes c2 ON c2.id = v.id_cliente
        WHERE v.id_vendedor = ?

        UNION ALL

        /* Venta público */
        SELECT
          'venta_publico' AS tipo,
          vp.fecha        AS fecha,
          vp.id           AS id_ref,
          'PÚBLICO GENERAL' AS descripcion,
          JSON_OBJECT(
            'total', vp.total,
            'metodo_pago', vp.metodo_pago,
            'latitud', vp.latitud,
            'longitud', vp.longitud
          ) AS extra_json
        FROM ventas_publico vp
        WHERE vp.id_vendedor = ?

        UNION ALL

        /* Devolución */
        SELECT
          'devolucion'   AS tipo,
          d.fecha        AS fecha,
          d.id           AS id_ref,
          CONCAT('Devolución #', d.id) AS descripcion,
          JSON_OBJECT(
            'motivo', d.motivo,
            'piezas', IFNULL(SUM(dd.cantidad),0)
          ) AS extra_json
        FROM devoluciones d
        LEFT JOIN devolucion_detalle dd ON dd.id_devolucion = d.id
        WHERE d.id_vendedor = ?
        GROUP BY d.id

        UNION ALL

        /* Descarga — UNA fila por descarga (sin join por producto) */
        SELECT
          'descarga'     AS tipo,
          de.fecha       AS fecha,
          de.id          AS id_ref,
          CONCAT('Descarga #', de.id) AS descripcion,
          JSON_OBJECT(
            'piezas', (
              SELECT IFNULL(SUM(dp.cantidad), 0)
              FROM descarga_productos dp
              WHERE dp.id_descarga = de.id
            ),
            'procesada', de.procesada
          ) AS extra_json
        FROM descargas de
        JOIN vendedores v3 ON v3.id = ?
        WHERE de.id_camioneta = v3.camioneta_id

        UNION ALL

        /* No venta */
        SELECT
          'no_venta'     AS tipo,
          vnv.fecha      AS fecha,
          vnv.id         AS id_ref,
          CONCAT('No venta cliente #', vnv.id_cliente) AS descripcion,
          JSON_OBJECT(
            'motivos', vnv.motivos_json,
            'observaciones', vnv.observaciones
          ) AS extra_json
        FROM visitas_no_venta vnv
        WHERE vnv.id_vendedor = ?
      ) ev
      WHERE 1=1
      ${whereFecha}
      ORDER BY ev.fecha DESC
      LIMIT ? OFFSET ?
      `,
      [...params, ...fechaParams, limit, offset]
    );

    res.json(rows);
  } catch (e) {
    console.error('timelineVendedor', e);
    res.status(500).json({ error: 'Error al obtener timeline' });
  }
};


/**
 * GET /api/vendedores/:id/ventas?from=&to=&tipoPago=&clienteId=&limit=&offset=[&scope=carga][&cargaId=###]
 */
export const listarVentasVendedor = async (req, res) => {
  try {
    const idV = Number(req.params.id);
    const { from, to, tipoPago } = req.query;
    const clienteIdRaw = req.query.clienteId;
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 500);
    const offset = Math.max(Number(req.query.offset || 0), 0);

    const scope = String(req.query.scope || '').toLowerCase();
    const cargaId = req.query.cargaId ? Number(req.query.cargaId) : null;

    let rango = null;
    if (scope === 'carga') {
      rango = cargaId
        ? await getRangoPorCargaId(cargaId)
        : await getRangoPorCargaActiva(idV);
      if (!rango) {
        const d = new Date();
        const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
        req.query.from = `${y}-${m}-${day}`;
        req.query.to   = `${y}-${m}-${day}`;
      }
    }

    // ❗️Separar parámetros por SELECT
    const paramsV  = [idV];
    const paramsVP = [idV];

    let whereV  = `v.id_vendedor=?`;
    let whereVP = `vp.id_vendedor=?`;

    if (scope === 'carga' && rango) {
      whereV  += ` AND v.fecha BETWEEN ? AND ?`;   paramsV.push(rango.ini, rango.fin);
      whereVP += ` AND vp.fecha BETWEEN ? AND ?`;  paramsVP.push(rango.ini, rango.fin);
    } else {
      if (from) { whereV += ` AND v.fecha >= ?`;       paramsV.push(from);
                  whereVP += ` AND vp.fecha >= ?`;      paramsVP.push(from); }
      if (to)   { whereV += ` AND v.fecha < DATE_ADD(?, INTERVAL 1 DAY)`;  paramsV.push(to);
                  whereVP += ` AND vp.fecha < DATE_ADD(?, INTERVAL 1 DAY)`; paramsVP.push(to); }
    }

    if (tipoPago) {
      whereV += ` AND v.tipo_pago = ?`; paramsV.push(tipoPago);
    }

    const hasClienteId = clienteIdRaw !== undefined && clienteIdRaw !== '';
    if (hasClienteId) {
      if (String(clienteIdRaw) === '0') {
        // público: ventas con cliente 'PUBLICO' o sin cliente + tabla ventas_publico
        whereV  += ` AND (v.id_cliente IS NULL OR c.clave='PUBLICO')`;
        // whereVP sin cambio (ya es público)
      } else {
        whereV  += ` AND v.id_cliente = ?`; paramsV.push(Number(clienteIdRaw));
        // excluir completamente ventas_publico si pidieron un cliente específico
        whereVP += ` AND 1=0`;
      }
    }

    const sql = `
      SELECT * FROM (
        SELECT v.id,
               v.fecha,
               v.total,
               v.tipo_pago,
               v.id_cliente,
               c.clave,
               COALESCE(c.nombre_empresa, 'PÚBLICO GENERAL') AS cliente,
               IF(c.clave='PUBLICO' OR v.id_cliente IS NULL, 1, 0) AS es_publico
        FROM ventas v
        LEFT JOIN clientes c ON c.id=v.id_cliente
        WHERE ${whereV}

        UNION ALL

        SELECT vp.id,
               vp.fecha,
               vp.total,
               'publico' AS tipo_pago,
               NULL AS id_cliente,
               'PUBLICO' AS clave,
               'PÚBLICO GENERAL' AS cliente,
               1 AS es_publico
        FROM ventas_publico vp
        WHERE ${whereVP}
      ) x
      ORDER BY x.fecha DESC
      LIMIT ? OFFSET ?`;

    // 👇 Orden correcto de parámetros: primero TODOS los del primer SELECT,
    // luego TODOS los del segundo SELECT, y al final limit/offset.
    const [rows] = await db.query(sql, [...paramsV, ...paramsVP, limit, offset]);
    res.json(rows);
  } catch (e) {
    console.error('listarVentasVendedor', e);
    res.status(500).json({ error: 'Error al listar ventas' });
  }
};



// GET /api/vendedores/:id/devoluciones?from=&to=&limit=&offset=
export const listarDevolucionesVendedor = async (req, res) => {
  try {
    const idV = ensureNumber(req.params.id);
    const { from, to } = req.query;
    const limit = Math.min(Math.max(ensureNumber(req.query.limit, 50), 1), 500);
    const offset = Math.max(ensureNumber(req.query.offset, 0), 0);

    const scope = String(req.query.scope || '').toLowerCase();
    const cargaId = req.query.cargaId ? ensureNumber(req.query.cargaId, null) : null;
    let rango = null;

    const params = [idV];
    let where = `WHERE d.id_vendedor=?`;

    if (scope === 'carga') {
      rango = cargaId ? await getRangoPorCargaId(cargaId) : await getRangoPorCargaActiva(idV);
      if (!rango) return res.json([]);
      where += ` AND d.fecha BETWEEN ? AND ?`;
      params.push(rango.ini, rango.fin);
    } else {
      if (from) { where += ` AND d.fecha >= ?`; params.push(from); }
      if (to)   { where += ` AND d.fecha < DATE_ADD(?, INTERVAL 1 DAY)`; params.push(to); }
    }

    const [rows] = await db.query(
      `
      SELECT d.*, c.nombre_empresa AS cliente
      FROM devoluciones d
      LEFT JOIN clientes c ON c.id = d.id_cliente
      ${where}
      ORDER BY d.fecha DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );
    res.json(rows);
  } catch (e) {
    console.error('listarDevolucionesVendedor', e);
    res.status(500).json({ error: 'Error al listar devoluciones' });
  }
};

/* ===========================
   CONTROL MANUAL DE RUTA (HOY)
   =========================== */

// POST /api/vendedores/:id/ruta/iniciar
export const iniciarRutaManual = async (req, res) => {
  try {
    const idV = ensureNumber(req.params.id);
    if (!idV) return res.status(400).json({ error: 'bad_request' });

    // Buscar la ruta de HOY para el vendedor
    const [[ruta]] = await db.query(
      `SELECT id FROM rutas_diarias WHERE id_vendedor=? AND fecha=CURDATE() LIMIT 1`,
      [idV]
    );
    if (!ruta) return res.status(404).json({ error: 'ruta_no_encontrada' });

    // Marcar como "en_curso" y setear inicio si venía NULL
    const [upd] = await db.query(
      `UPDATE rutas_diarias
         SET estado='en_curso',
             inicio_en = COALESCE(inicio_en, NOW()),
             regreso_confirmado = 0
       WHERE id=?`,
      [ruta.id]
    );

    if (upd.affectedRows === 0) {
      return res.status(500).json({ error: 'no_actualizada' });
    }

    // Avisar por socket al room del vendedor
    try {
      const io = req.app?.get('io');
      io?.to(`vendedor:${idV}`)?.emit('ruta:actualizada', { id: ruta.id, action: 'iniciar' });
    } catch (e) {
      // no romper por socket
    }

    res.json({ ok: true, ruta_id: ruta.id });
  } catch (e) {
    console.error('iniciarRutaManual', e);
    res.status(500).json({ error: 'start_error', detail: e.message });
  }
};

// POST /api/vendedores/:id/ruta/finalizar
export const finalizarRutaManual = async (req, res) => {
  try {
    const idV = ensureNumber(req.params.id);
    if (!idV) return res.status(400).json({ error: 'bad_request' });

    // Buscar la ruta de HOY para el vendedor
    const [[ruta]] = await db.query(
      `SELECT id FROM rutas_diarias WHERE id_vendedor=? AND fecha=CURDATE() LIMIT 1`,
      [idV]
    );
    if (!ruta) return res.status(404).json({ error: 'ruta_no_encontrada' });

    // Marcar como finalizada y setear tiempos si venían NULL
    const [upd] = await db.query(
      `UPDATE rutas_diarias
         SET estado='finalizada',
             termino_en     = COALESCE(termino_en, NOW()),
             regreso_confirmado = 1,
             fecha_regreso  = COALESCE(fecha_regreso, NOW())
       WHERE id=?`,
      [ruta.id]
    );

    if (upd.affectedRows === 0) {
      return res.status(500).json({ error: 'no_actualizada' });
    }

    // Avisar por socket al room del vendedor
    try {
      const io = req.app?.get('io');
      io?.to(`vendedor:${idV}`)?.emit('ruta:actualizada', { id: ruta.id, action: 'finalizar' });
    } catch (e) {
      // no romper por socket
    }

    res.json({ ok: true, ruta_id: ruta.id });
  } catch (e) {
    console.error('finalizarRutaManual', e);
    res.status(500).json({ error: 'finish_error', detail: e.message });
  }
};

/* =========================================================
   NUEVO: BALANCE (Deudas / A favor) + CAJAS POR VENDEDOR
   Reemplaza completamente al antiguo "cambios"
   =========================================================
   GET /api/vendedores/:id/balance
     ?ini=YYYY-MM-DD HH:mm:ss&fin=YYYY-MM-DD HH:mm:ss
   Si no mandas rango, usa [fecha_ultima_carga, NOW()].
   Devuelve:
     - ventas / recaudado / cobrable / balance (dinero)
     - cajas (prestamos_cajas) por envase y totales
*/
function _toSqlDT(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = d.getFullYear(), m = pad(d.getMonth()+1), day = pad(d.getDate());
  const hh = pad(d.getHours()), mm = pad(d.getMinutes()), ss = pad(d.getSeconds());
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}
async function _pickUltimaCarga(vId) {
  const [[row]] = await db.query(
    `SELECT id, fecha
       FROM cargas
      WHERE id_vendedor = ?
      ORDER BY fecha DESC, id DESC
      LIMIT 1`,
    [vId]
  );
  return row || null;
}
async function _computeBalanceDinero(vId, ini, fin) {
  // Ventas con cliente (incluye crédito) — mapeo a método de pago para UI
  const [[v1]] = await db.query(
    `SELECT
        SUM(CASE
              WHEN COALESCE(
                     metodo_pago,
                     CASE
                       WHEN tipo_pago='contado' THEN 'efectivo'
                       WHEN tipo_pago='transferencia' THEN 'transferencia'
                       ELSE metodo_pago
                     END
                   ) = 'efectivo'
              THEN total ELSE 0 END) AS v_all_ef,
        SUM(CASE
              WHEN COALESCE(
                     metodo_pago,
                     CASE
                       WHEN tipo_pago='contado' THEN 'efectivo'
                       WHEN tipo_pago='transferencia' THEN 'transferencia'
                       ELSE metodo_pago
                     END
                   ) = 'transferencia'
              THEN total ELSE 0 END) AS v_all_tr,

        -- SOLO contado/transfer (para COBRABLE)
        SUM(CASE
              WHEN tipo_pago IN ('contado','transferencia') AND
                   COALESCE(metodo_pago,
                            CASE
                              WHEN tipo_pago='contado' THEN 'efectivo'
                              WHEN tipo_pago='transferencia' THEN 'transferencia'
                              ELSE NULL
                            END) = 'efectivo'
              THEN total ELSE 0 END) AS v_ct_ef,
        SUM(CASE
              WHEN tipo_pago IN ('contado','transferencia') AND
                   COALESCE(metodo_pago,
                            CASE
                              WHEN tipo_pago='contado' THEN 'efectivo'
                              WHEN tipo_pago='transferencia' THEN 'transferencia'
                              ELSE NULL
                            END) = 'transferencia'
              THEN total ELSE 0 END) AS v_ct_tr,

        SUM(CASE WHEN tipo_pago='credito' THEN total ELSE 0 END) AS v_cr
       FROM ventas
      WHERE id_vendedor = ? AND fecha BETWEEN ? AND ?`,
    [vId, ini, fin]
  );

  // Ventas al público
  const [[v2]] = await db.query(
    `SELECT
        SUM(CASE WHEN metodo_pago='efectivo'      THEN total ELSE 0 END) AS vp_ef,
        SUM(CASE WHEN metodo_pago='transferencia' THEN total ELSE 0 END) AS vp_tr
       FROM ventas_publico
      WHERE id_vendedor = ? AND fecha BETWEEN ? AND ?`,
    [vId, ini, fin]
  );

  // Abonos a crédito
  const [[ab]] = await db.query(
    `SELECT
        SUM(CASE WHEN p.tipo_pago='efectivo'      THEN p.monto ELSE 0 END) AS ab_ef,
        SUM(CASE WHEN p.tipo_pago='transferencia' THEN p.monto ELSE 0 END) AS ab_tr
       FROM pagos_credito p
       JOIN creditos c ON c.id = p.id_credito
       JOIN ventas v   ON v.id = c.id_venta
      WHERE v.id_vendedor = ? AND p.fecha BETWEEN ? AND ?`,
    [vId, ini, fin]
  );

  const ventaEfUI  = Number(v1?.v_all_ef || 0) + Number(v2?.vp_ef || 0);
  const ventaTrUI  = Number(v1?.v_all_tr || 0) + Number(v2?.vp_tr || 0);
  const ventaCred  = Number(v1?.v_cr || 0);
  const totalBruto = ventaEfUI + ventaTrUI;

  // Cobrable (contado + público)
  const cobrableEf = Number(v1?.v_ct_ef || 0) + Number(v2?.vp_ef || 0);
  const cobrableTr = Number(v1?.v_ct_tr || 0) + Number(v2?.vp_tr || 0);
  const cobrableSubtotal = cobrableEf + cobrableTr;

  // Recaudado (cobrable + abonos crédito)
  const recEf = cobrableEf + Number(ab?.ab_ef || 0);
  const recTr = cobrableTr + Number(ab?.ab_tr || 0);
  const recTot = recEf + recTr;

  return {
    ventas_efectivo: ventaEfUI,
    ventas_transferencia: ventaTrUI,
    ventas_subtotal: ventaEfUI + ventaTrUI,
    ventas_credito: ventaCred,
    total_bruto: totalBruto,
    cobrable_subtotal: cobrableSubtotal,
    recaudado_efectivo: recEf,
    recaudado_transferencia: recTr,
    recaudado_total: recTot,
    balance_debe: Math.max(cobrableSubtotal - recTot, 0),
    balance_afavor: Math.max(recTot - cobrableSubtotal, 0),
  };
}

async function _computeCajasVendedor(vId, ini, fin) {
  // Agregamos por envase (1: chica, 2: grande, 3: cubeta)
  const [rows] = await db.query(
    `SELECT id_envase,
            SUM(CASE WHEN tipo='prestamo'    THEN cantidad ELSE 0 END) AS prestado,
            SUM(CASE WHEN tipo='recoleccion' THEN cantidad ELSE 0 END) AS recolectado
       FROM prestamos_cajas
      WHERE id_vendedor = ?
        AND fecha BETWEEN ? AND ?
      GROUP BY id_envase`,
    [vId, ini, fin]
  );

  // Map a llaves legibles
  const labelByEnv = { 1: 'chica', 2: 'grande', 3: 'cubeta' };
  const base = {
    chica:  { prestado:0, recolectado:0, debe:0, a_favor:0 },
    grande: { prestado:0, recolectado:0, debe:0, a_favor:0 },
    cubeta: { prestado:0, recolectado:0, debe:0, a_favor:0 },
  };

  for (const r of rows) {
    const key = labelByEnv[Number(r.id_envase)] || `env_${r.id_envase}`;
    const prestado = Number(r.prestado || 0);
    const recolectado = Number(r.recolectado || 0);
    const debe = Math.max(prestado - recolectado, 0);
    const afavor = Math.max(recolectado - prestado, 0);
    base[key] = { prestado, recolectado, debe, a_favor: afavor };
  }

  const totales = Object.values(base).reduce((acc, it) => {
    acc.prestado    += it.prestado;
    acc.recolectado += it.recolectado;
    acc.debe_total  += it.debe;
    acc.afavor_total+= it.a_favor;
    return acc;
  }, { prestado:0, recolectado:0, debe_total:0, afavor_total:0 });

  return { por_envase: base, totales };
}

// GET /api/vendedores/:id/balance
export const balanceVendedor = async (req, res) => {
  try {
    const idV = ensureNumber(req.params.id);
    if (!idV) return res.status(400).json({ error: 'bad_request' });

    const acumulado =
      String(req.query.acumulado ?? '').toLowerCase() === '1' ||
      String(req.query.acumulado ?? '').toLowerCase() === 'true';

    // Si viene fin lo respetamos; si no, ahora.
    let { ini, fin } = req.query || {};

    function _endOfDay(d) {
      const nd = new Date(d);
      nd.setHours(23, 59, 59, 999);
      return nd;
    }

    // Si es acumulado, ignoramos 'ini' y usamos "desde siempre".
    if (acumulado) {
      const finD = fin ? new Date(fin) : new Date();
      fin = _toSqlDT(_endOfDay(finD));
      ini = '1970-01-01 00:00:00';
    }

    // Si NO es acumulado y no mandan rango, usamos [ultima_carga, NOW()]
    if (!acumulado && (!ini || !fin)) {
      const ult = await _pickUltimaCarga(idV);
      if (ult?.fecha) {
        ini = _toSqlDT(new Date(ult.fecha));
        fin = _toSqlDT(new Date());
      } else {
        // fallback: hoy completo
        const now = new Date();
        const start = new Date(now); start.setHours(0,0,0,0);
        const end   = new Date(now); end.setHours(23,59,59,999);
        ini = _toSqlDT(start);
        fin = _toSqlDT(end);
      }
    }

    const dinero = await _computeBalanceDinero(idV, ini, fin);
    const cajas  = await _computeCajasVendedor(idV, ini, fin);

    const aFavorDinero = Math.max((dinero.recaudado_total || 0) - (dinero.cobrable_subtotal || 0), 0);

    return res.json({
      ok: true,
      data: {
        acumulado: !!acumulado,
        ini, fin,
        ventas_efectivo:      Number(dinero.ventas_efectivo || 0),
        ventas_transferencia: Number(dinero.ventas_transferencia || 0),
        ventas_subtotal:      Number(dinero.ventas_subtotal || 0),
        ventas_credito:       Number(dinero.ventas_credito || 0),
        total_bruto:          Number(dinero.total_bruto || 0),

        cobrable_subtotal: Number(dinero.cobrable_subtotal || 0),

        recaudado_efectivo:      Number(dinero.recaudado_efectivo || 0),
        recaudado_transferencia: Number(dinero.recaudado_transferencia || 0),
        recaudado_total:         Number(dinero.recaudado_total || 0),

        balance_debe:   Number(Math.max((dinero.cobrable_subtotal || 0) - (dinero.recaudado_total || 0), 0)),
        balance_afavor: Number(aFavorDinero || 0),

        cajas, // { por_envase: {chica|grande|cubeta|env_X}, totales:{...} }
      }
    });
  } catch (e) {
    console.error('balanceVendedor', e);
    res.status(500).json({ error: 'Error al calcular balance del vendedor' });
  }
};

export const listarCreditosVendedor = async (req, res) => {
  try {
    const idV = ensureNumber(req.params.id);
    if (!idV) return res.status(400).json({ error: 'bad_request' });

    const { from, to, vigentes } = req.query;
    const soloVigentes = String(vigentes ?? '').trim() === '1';

    // 👇 NUEVO: acumulado
    const acumulado =
      String(req.query.acumulado ?? '').toLowerCase() === '1' ||
      String(req.query.acumulado ?? '').toLowerCase() === 'true';

    const scope = String(req.query.scope || '').toLowerCase();
    const cargaId = req.query.cargaId ? ensureNumber(req.query.cargaId, null) : null;

    let ini = null, fin = null;

    function _endOfDay(d) {
      const nd = new Date(d);
      nd.setHours(23,59,59,999);
      return nd;
    }

    if (acumulado) {
      // Desde siempre hasta ahora
      ini = '1970-01-01 00:00:00';
      fin = _toSqlDT(_endOfDay(new Date()));
    } else if (scope === 'carga') {
      const rango = cargaId ? await getRangoPorCargaId(cargaId) : await getRangoPorCargaActiva(idV);
      if (!rango) return res.json([]);
      ini = rango.ini;
      fin = rango.fin;
    } else {
      if (from) ini = `${from} 00:00:00`;
      if (to)   fin = `${to} 23:59:59`;
      // si no mandan nada, por defecto el día de hoy (comportamiento anterior)
      if (!ini && !fin) {
        const d = new Date();
        const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
        ini = `${y}-${m}-${day} 00:00:00`;
        fin = `${y}-${m}-${day} 23:59:59`;
      } else if (ini && !fin) {
        fin = `${from} 23:59:59`;
      } else if (!ini && fin) {
        ini = `${to} 00:00:00`;
      }
    }

    const params = [idV, ini, fin];

    const buildSql = (ventaFkCol) => `
      SELECT
        c.id                                        AS credito_id,
        ${ventaFkCol}                               AS venta_id,
        v.id_cliente                                AS cliente_id,
        COALESCE(cl.nombre_empresa, 'PÚBLICO GENERAL') AS cliente,
        v.fecha                                     AS fecha_venta,
        c.total                                     AS monto_credito,
        c.saldo                                     AS saldo,
        MAX(p.fecha)                                AS ultimo_pago_en
      FROM creditos c
      JOIN ventas v              ON v.id = ${ventaFkCol}
      LEFT JOIN clientes cl      ON cl.id = v.id_cliente
      LEFT JOIN pagos_credito p  ON p.id_credito = c.id
      WHERE v.id_vendedor = ?
        AND v.fecha BETWEEN ? AND ?
      GROUP BY
        c.id, ${ventaFkCol}, v.id_cliente, cl.nombre_empresa, v.fecha, c.total, c.saldo
      ${soloVigentes ? `HAVING c.saldo > 0` : ``}
      ORDER BY
        (c.saldo > 0) DESC,
        COALESCE(MAX(p.fecha), v.fecha) DESC,
        c.id DESC
    `;

    async function tryQuery(ventaFkCol) {
      const [rows] = await db.query(buildSql(ventaFkCol), params);
      return rows;
    }

    let rows;
    try {
      rows = await tryQuery('c.id_venta');
    } catch (e1) {
      if (e1?.code === 'ER_BAD_FIELD_ERROR' && /id_venta/.test(e1?.sqlMessage || '')) {
        rows = await tryQuery('c.venta_id');
      } else if (e1?.code === 'ER_NO_SUCH_TABLE' || e1?.sqlState === '42S02') {
        return res.json([]);
      } else {
        throw e1;
      }
    }

    const out = rows.map(r => ({
      id: r.credito_id,
      venta_id: r.venta_id,
      cliente_id: r.cliente_id ?? 0,
      cliente: r.cliente,
      fecha: r.fecha_venta,
      fecha_venta: r.fecha_venta,
      monto: Number(r.monto_credito || 0),
      saldo: Number(r.saldo || 0),
      actualizado_en: r.ultimo_pago_en || r.fecha_venta
    }));

    return res.json(out);
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE' || e?.sqlState === '42S02') {
      return res.json([]);
    }
    console.error('listarCreditosVendedor', e);
    return res.status(500).json({ error: 'Error al listar créditos' });
  }
};

