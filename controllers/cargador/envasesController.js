// controllers/cargador/envasesController.js
import db from '../../config/db.js';

const CAJA_LABELS = {
  chica:  'Caja chica',
  grande: 'Caja grande',
  cubeta: 'Cubeta',
};
const KEY_BY_LABEL = {
  'Caja chica':  'chica',
  'Caja grande': 'grande',
  'Cubeta':      'cubeta',
};

const toIso  = (d) => (d ? new Date(d).toISOString() : null);
const toUnix = (d) => (d ? Math.floor(new Date(d).getTime() / 1000) : null);

/* ====== Helpers de introspección ====== */
async function tableExists(tableName) {
  const [[row]] = await db.query(
    `SELECT COUNT(*) AS n
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tableName]
  );
  return Number(row?.n || 0) > 0;
}
async function getExistingColumns(tableName) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME AS c
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tableName]
  );
  return new Set(rows.map(r => r.c));
}
/** envase vs tipos_cajas */
async function getCajaIdSource() {
  const cols = await getExistingColumns('prestamos_cajas');
  const hasTiposCol = cols.has('id_tipo_caja');
  const hasEnvCol   = cols.has('id_envase');

  const hasTiposTbl = await tableExists('tipos_cajas');
  const hasEnvTbl   = await tableExists('envase');

  if (hasEnvCol && hasEnvTbl) return { mode: 'envase', idCol: 'id_envase', catTable: 'envase', catNameCol: 'nombre' };
  if (hasTiposCol && hasTiposTbl) return { mode: 'tipos_cajas', idCol: 'id_tipo_caja', catTable: 'tipos_cajas', catNameCol: 'nombre' };
  if (hasEnvTbl) return { mode: 'envase', idCol: 'id_envase', catTable: 'envase', catNameCol: 'nombre' };
  if (hasTiposTbl) return { mode: 'tipos_cajas', idCol: 'id_tipo_caja', catTable: 'tipos_cajas', catNameCol: 'nombre' };
  return { mode: 'none', idCol: null, catTable: null, catNameCol: null };
}
async function getCajaTypeIds() {
  const src = await getCajaIdSource();
  if (src.mode === 'none') return { src, chica: null, grande: null, cubeta: null };
  const [rows] = await db.query(
    `SELECT id, ${src.catNameCol} AS n FROM ${src.catTable} WHERE ${src.catNameCol} IN (?,?,?)`,
    ['Caja chica','Caja grande','Cubeta']
  );
  const map = new Map(rows.map(r => [String(r.n).toLowerCase(), r.id]));
  return {
    src,
    chica:  map.get('caja chica')  || null,
    grande: map.get('caja grande') || null,
    cubeta: map.get('cubeta')      || null,
  };
}

/* =========================================================
   GET /api/cargador/envases/vendedores
   ========================================================= */
export const listVendedores = async (_req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        v.id                              AS vendedor_id,
        u.usuario                         AS vendedor_uid,
        u.nombre                          AS vendedor_nombre,
        c.id                              AS camioneta_id,
        c.placa                           AS placas,
        CONCAT_WS(' ', c.marca, c.modelo) AS camioneta,
        COALESCE(c.kilometraje_actual,0)  AS kilometraje
      FROM vendedores v
      JOIN usuarios u      ON u.id = v.id_usuario
      LEFT JOIN camionetas c ON c.id = v.camioneta_id
      WHERE v.activo=1 AND v.eliminado=0
      ORDER BY u.nombre ASC
    `);

    const items = rows.map(r => ({
      id: r.vendedor_id,
      vendedorUid: r.vendedor_uid || '',
      vendedorNombre: r.vendedor_nombre || '',
      camionetaId: r.camioneta_id,
      camioneta: r.camioneta || '',
      placas: r.placas || '',
      kilometraje: Number(r.kilometraje) || 0,
    }));

    res.json({ count: items.length, items });
  } catch (err) {
    console.error('listVendedores error:', err);
    res.status(500).json({ msg: 'Error del servidor' });
  }
};

/* =========================================================
   GET /api/cargador/envases/carga-activa?vendedorId=#
   ========================================================= */
export const getCargaActiva = async (req, res) => {
  try {
    const vendedorId = parseInt(req.query.vendedorId, 10);
    if (!vendedorId) return res.status(400).json({ msg: 'vendedorId requerido' });

    const [rows] = await db.execute(
      `SELECT id, fecha
         FROM cargas
        WHERE id_vendedor = ? AND procesada = 0
        ORDER BY fecha DESC, id DESC
        LIMIT 1`,
      [vendedorId]
    );
    if (!rows.length) return res.status(404).json({ msg: 'Sin carga activa' });

    const c = rows[0];
    res.json({ id: c.id, fechaIso: toIso(c.fecha), fechaUnix: toUnix(c.fecha) });
  } catch (err) {
    console.error('getCargaActiva error:', err);
    res.status(500).json({ msg: 'Error del servidor' });
  }
};

/* =========================================================
   GET /api/cargador/envases/historial?vendedorId=#&limit=100
   — Historial por vendedor (últimos movimientos; no filtra por cliente)
   ========================================================= */
export const getHistorial = async (req, res) => {
  const vendedorId = parseInt(req.query.vendedorId, 10);
  if (!vendedorId) return res.status(400).json({ msg: 'vendedorId requerido' });

  const limitRaw = parseInt(req.query.limit || '100', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 100;

  try {
    const { src, chica, grande, cubeta } = await getCajaTypeIds();
    if (src.mode === 'none') return res.json({ count: 0, items: [] });

    const idCol = src.idCol;

    const [rows] = await db.query(
      `
      SELECT pc.id, pc.fecha, pc.tipo, pc.cantidad, cat.${src.catNameCol} AS tipo_envase
      FROM prestamos_cajas pc
      JOIN ${src.catTable} cat ON cat.id = pc.${idCol}
      WHERE pc.id_vendedor = ?
      ORDER BY pc.fecha DESC, pc.id DESC
      LIMIT ?`,
      [vendedorId, limit]
    );

    const items = rows.map(r => ({
      id: r.id,
      fechaIso: toIso(r.fecha),
      fechaUnix: toUnix(r.fecha),
      tipo: r.tipo === 'prestamo' ? 'SALIDA' : 'RECOLECCION',
      caja: r.tipo_envase,
      cantidad: Number(r.cantidad) || 0,
    }));

    res.json({ count: items.length, items });
  } catch (err) {
    console.error('getHistorial error:', err);
    res.status(500).json({ msg: 'Error del servidor' });
  }
};

/* =========================================================
   GET /api/cargador/envases/resumen?vendedorId=#  (ó &cargaId=#)
   — Resumen por la ÚLTIMA CARGA (o carga indicada) desde el ledger
   ========================================================= */
export const getResumenEnvases = async (req, res) => {
  const vendedorId = parseInt(req.query.vendedorId || '0', 10);
  let cargaId = parseInt(req.query.cargaId || '0', 10);

  if (!cargaId && !vendedorId) {
    return res.status(400).json({ msg: 'vendedorId o cargaId requerido' });
  }

  try {
    const { src, chica, grande, cubeta } = await getCajaTypeIds();
    if (src.mode === 'none') return res.json({ cargaId: null, items: [] });
    const idCol = src.idCol;

    if (!cargaId) {
      const [[row]] = await db.execute(
        `SELECT id FROM cargas WHERE id_vendedor=? AND procesada=0 ORDER BY fecha DESC, id DESC LIMIT 1`,
        [vendedorId]
      );
      if (!row) return res.status(404).json({ msg: 'Sin carga activa' });
      cargaId = row.id;
    }

    // Sumar SOLO los movimientos ligados a esta carga
    const [rows] = await db.query(
      `
      SELECT ${idCol} AS caja_id, tipo, SUM(cantidad) AS cant
      FROM prestamos_cajas
      WHERE carga_id = ?
      GROUP BY ${idCol}, tipo`,
      [cargaId]
    );

    const totals = {
      chica:  { salidas: 0, recolecciones: 0 },
      grande: { salidas: 0, recolecciones: 0 },
      cubeta: { salidas: 0, recolecciones: 0 },
    };

    const id2key = new Map();
    if (chica)  id2key.set(String(chica),  'chica');
    if (grande) id2key.set(String(grande), 'grande');
    if (cubeta) id2key.set(String(cubeta), 'cubeta');

    for (const r of rows) {
      const key = id2key.get(String(r.caja_id));
      if (!key) continue;
      if (r.tipo === 'prestamo') totals[key].salidas = Number(r.cant || 0);
      else if (r.tipo === 'recoleccion') totals[key].recolecciones = Number(r.cant || 0);
    }

    const items = ['chica','grande','cubeta'].map(k => ({
      nombre: CAJA_LABELS[k],
      salidas: totals[k].salidas,
      recolecciones: totals[k].recolecciones,
      // si quieres, aquí podrías calcular debe/aFavor por-carga, pero normalmente
      // el saldo es histórico por vendedor (no por carga).
    }));

    res.json({ cargaId, items });
  } catch (err) {
    console.error('getResumenEnvases error:', err);
    res.status(500).json({ msg: 'Error del servidor' });
  }
};

/* =========================================================
   POST /api/cargador/envases/salida
   body: { vendedorId, caja: "cajaChica|cajaGrande|cubeta", cantidad, cargaId? }
   ========================================================= */
export const registrarSalida = async (req, res) => {
  await registrarMovimiento(req, res, 'prestamo');
};

/* =========================================================
   POST /api/cargador/envases/recoleccion
   body: { vendedorId, caja: "cajaChica|cajaGrande|cubeta", cantidad, cargaId? }
   ========================================================= */
export const registrarRecoleccion = async (req, res) => {
  await registrarMovimiento(req, res, 'recoleccion');
};

/* =============== Núcleo común (transaccional, SIN cliente) =============== */
async function registrarMovimiento(req, res, tipoMovimiento) {
  try {
    const vendedorId = parseInt(req.body.vendedorId, 10);
    const cajaKeyRaw = String(req.body.caja || ''); // cajaChica|cajaGrande|cubeta
    const cantidad   = parseInt(req.body.cantidad, 10);
    let   cargaId    = req.body.cargaId ? parseInt(req.body.cargaId, 10) : null;

    if (!vendedorId) return res.status(400).json({ msg: 'vendedorId requerido' });
    const mapKey = { cajaChica: 'chica', cajaGrande: 'grande', cubeta: 'cubeta' };
    if (!['cajaChica','cajaGrande','cubeta'].includes(cajaKeyRaw)) {
      return res.status(400).json({ msg: 'caja inválida' });
    }
    const cajaKey = mapKey[cajaKeyRaw];

    if (!cantidad || cantidad <= 0) {
      return res.status(400).json({ msg: 'cantidad debe ser > 0' });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      if (!cargaId) {
        const [cr] = await conn.execute(
          `SELECT id FROM cargas WHERE id_vendedor=? AND procesada=0 ORDER BY fecha DESC, id DESC LIMIT 1`,
          [vendedorId]
        );
        if (!cr.length) throw new Error('No hay carga activa para este vendedor');
        cargaId = cr[0].id;
      }

      // Catálogo: envase o tipos_cajas
      const { src, chica, grande, cubeta } = await getCajaTypeIds();
      if (src.mode === 'none') throw new Error('Catálogo de cajas no disponible');

      const idCol = src.idCol;
      const byKey = { chica, grande, cubeta };
      const cajaId = byKey[cajaKey];
      if (!cajaId) throw new Error(`Tipo de envase no encontrado: ${CAJA_LABELS[cajaKey]}`);

      // Bitácora ledger con carga_id
      const insertSql = `
        INSERT INTO prestamos_cajas (id_vendedor, ${idCol}, tipo, cantidad, fecha, carga_id)
        VALUES (?,?,?,?, NOW(), ?)`;
      await conn.query(insertSql, [vendedorId, cajaId, tipoMovimiento, cantidad, cargaId]);

      await conn.commit();

      // Recalcular mini-resumen por esta carga & caja
      const [[agg]] = await db.query(
        `
        SELECT
          SUM(CASE WHEN tipo='prestamo'    THEN cantidad ELSE 0 END) AS salidas,
          SUM(CASE WHEN tipo='recoleccion' THEN cantidad ELSE 0 END) AS recolecciones
        FROM prestamos_cajas
        WHERE carga_id = ? AND ${idCol} = ?`,
        [cargaId, cajaId]
      );

      return res.json({
        ok: true,
        cargaId,
        tipo: tipoMovimiento === 'prestamo' ? 'SALIDA' : 'RECOLECCION',
        caja: CAJA_LABELS[cajaKey],
        cantidad,
        estadoCaja: {
          salidas: Number(agg?.salidas || 0),
          recolecciones: Number(agg?.recolecciones || 0),
        },
      });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      return res.status(400).json({ msg: e.message });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('registrarMovimiento error:', err);
    return res.status(500).json({ msg: 'Error del servidor' });
  }
}
