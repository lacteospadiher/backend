// controllers/admin/descuentosGlobalesController.js
import db from '../../config/db.js';

const estadoSql = `
  CASE
    WHEN d.activo=0 THEN 'inactivo'
    WHEN CURDATE()<d.fecha_inicio THEN 'programado'
    WHEN CURDATE()>d.fecha_fin THEN 'vencido'
    ELSE 'vigente'
  END AS estado
`;

const getRolId = (req) => {
  const raw = req?.user?.rol_id ?? req?.user?.rol ?? 0;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  const s = String(raw || '').toLowerCase();
  if (s.includes('super')) return 4;
  if (s.includes('administrador')) return 1;
  return 0;
};
const requireSuperAdmin = (req, res) => {
  if (getRolId(req) !== 4) {
    res.status(403).json({ error: 'Permisos insuficientes (requiere SuperAdmin).' });
    return false;
  }
  return true;
};
const isYMD = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Busca traslapes de globales activos (opcional: excluye id) */
const findOverlaps = async (conn, { fecha_inicio, fecha_fin, activo = 1, excludeId = null }) => {
  const params = [fecha_fin, fecha_inicio, Number(activo)];
  const extra = excludeId ? ' AND d.id <> ?' : '';
  if (excludeId) params.push(excludeId);
  const [rows] = await conn.query(
    `
    SELECT d.id, d.porcentaje, d.fecha_inicio, d.fecha_fin
      FROM descuentos_globales d
     WHERE NOT (? < d.fecha_inicio OR ? > d.fecha_fin)
       AND d.activo = ?
       ${extra}
     ORDER BY d.fecha_inicio DESC
    `,
    params
  );
  return rows;
};

export const listarDescuentosGlobales = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT d.*, ${estadoSql}
      FROM descuentos_globales d
      ORDER BY d.fecha_inicio DESC, d.id DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error('listarDescuentosGlobales', e);
    res.status(500).json({ error: 'Error al listar descuentos globales' });
  }
};

export const obtenerDescuentoGlobalVigente = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT d.*
      FROM descuentos_globales d
      WHERE d.activo=1
        AND CURDATE() BETWEEN d.fecha_inicio AND d.fecha_fin
      ORDER BY d.porcentaje DESC, d.id DESC
      LIMIT 1
    `);
    res.json(rows[0] || null);
  } catch (e) {
    console.error('obtenerDescuentoGlobalVigente', e);
    res.status(500).json({ error: 'Error al obtener descuento global vigente' });
  }
};

export const crearDescuentoGlobal = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const { porcentaje, fecha_inicio, fecha_fin, activo = true } = req.body;
    if (porcentaje == null || porcentaje === '') return res.status(400).json({ error: 'porcentaje requerido' });
    const p = Number(porcentaje);
    if (!Number.isFinite(p) || p < 0 || p > 100) return res.status(400).json({ error: 'porcentaje debe estar entre 0 y 100' });
    if (!isYMD(fecha_inicio) || !isYMD(fecha_fin)) return res.status(400).json({ error: 'Fechas inválidas (YYYY-MM-DD).' });
    if (new Date(fecha_fin) < new Date(fecha_inicio)) return res.status(400).json({ error: 'Fecha fin no puede ser menor a fecha inicio' });

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // Si se crea activo, evitar traslape con otros activos (política más estricta y clara para UI)
      if (activo) {
        const overlaps = await findOverlaps(conn, { fecha_inicio, fecha_fin, activo: 1 });
        if (overlaps.length) {
          await conn.rollback();
          return res.status(409).json({ error: 'Empalme con descuento(s) global(es) activo(s).', overlaps });
        }
      }

      const [r] = await conn.query(
        `INSERT INTO descuentos_globales (porcentaje, fecha_inicio, fecha_fin, activo) VALUES (?,?,?,?)`,
        [p, fecha_inicio, fecha_fin, !!activo ? 1 : 0]
      );
      await conn.commit();
      res.json({ mensaje:'Descuento global creado', id:r.insertId });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      console.error('crearDescuentoGlobal', e);
      res.status(500).json({ error:e.message || 'Error al crear descuento global' });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('crearDescuentoGlobal outer', e);
    res.status(500).json({ error:e.message });
  }
};

export const actualizarDescuentoGlobal = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const { id } = req.params;
    const { porcentaje, fecha_inicio, fecha_fin, activo } = req.body;

    // Validaciones suaves
    if (porcentaje != null) {
      const p = Number(porcentaje);
      if (!Number.isFinite(p) || p < 0 || p > 100) return res.status(400).json({ error: 'porcentaje debe estar entre 0 y 100' });
    }
    if ((fecha_inicio && !isYMD(fecha_inicio)) || (fecha_fin && !isYMD(fecha_fin))) {
      return res.status(400).json({ error: 'Fechas inválidas (YYYY-MM-DD).' });
    }
    if (fecha_inicio && fecha_fin && new Date(fecha_fin) < new Date(fecha_inicio)) {
      return res.status(400).json({ error: 'Fecha fin no puede ser menor a fecha inicio' });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // Tomar actuales
      const [[cur]] = await conn.query(`SELECT * FROM descuentos_globales WHERE id=? LIMIT 1`, [id]);
      if (!cur) { await conn.rollback(); return res.status(404).json({ error:'No encontrado' }); }

      const next = {
        porcentaje: porcentaje != null ? Number(porcentaje) : cur.porcentaje,
        fecha_inicio: (fecha_inicio ?? cur.fecha_inicio)?.toString().slice(0,10),
        fecha_fin: (fecha_fin ?? cur.fecha_fin)?.toString().slice(0,10),
        activo: typeof activo === 'boolean' ? (activo ? 1 : 0) : cur.activo
      };

      if (new Date(next.fecha_fin) < new Date(next.fecha_inicio)) {
        await conn.rollback();
        return res.status(400).json({ error: 'Fecha fin no puede ser menor a fecha inicio' });
      }

      // Si quedará activo, validar traslapes contra otros activos
      if (next.activo === 1) {
        const overlaps = await findOverlaps(conn, { fecha_inicio: next.fecha_inicio, fecha_fin: next.fecha_fin, activo: 1, excludeId: cur.id });
        if (overlaps.length) {
          await conn.rollback();
          return res.status(409).json({ error: 'Empalme con descuento(s) global(es) activo(s).', overlaps });
        }
      }

      const [r] = await conn.query(
        `UPDATE descuentos_globales
            SET porcentaje= ?,
                fecha_inicio= ?,
                fecha_fin= ?,
                activo= ?
          WHERE id=?`,
        [next.porcentaje, next.fecha_inicio, next.fecha_fin, next.activo, id]
      );
      if (!r.affectedRows) { await conn.rollback(); return res.status(404).json({ error:'No encontrado' }); }

      await conn.commit();
      res.json({ mensaje:'Descuento global actualizado' });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      console.error('actualizarDescuentoGlobal', e);
      res.status(500).json({ error:e.message });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('actualizarDescuentoGlobal outer', e);
    res.status(500).json({ error:e.message });
  }
};

export const toggleDescuentoGlobal = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const { id } = req.params;
    const { activo } = req.body;

    // Si se intenta activar, garantizar no traslape con otro activo
    if (activo === true) {
      const [[cur]] = await db.query(`SELECT * FROM descuentos_globales WHERE id=? LIMIT 1`, [id]);
      if (!cur) return res.status(404).json({ error:'No encontrado' });
      const overlaps = await findOverlaps(db, { fecha_inicio: cur.fecha_inicio, fecha_fin: cur.fecha_fin, activo: 1, excludeId: cur.id });
      if (overlaps.length) {
        return res.status(409).json({ error: 'Empalme con descuento(s) global(es) activo(s).', overlaps });
      }
    }

    const [r] = await db.query(`UPDATE descuentos_globales SET activo=? WHERE id=?`, [!!activo, id]);
    if (!r.affectedRows) return res.status(404).json({ error:'No encontrado' });
    res.json({ mensaje:'Estatus actualizado' });
  } catch (e) {
    console.error('toggleDescuentoGlobal', e);
    res.status(500).json({ error:e.message });
  }
};
