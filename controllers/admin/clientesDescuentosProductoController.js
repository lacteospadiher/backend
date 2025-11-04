// controllers/admin/clientesDescuentosProductoController.js
import db from '../../config/db.js';

/* ====================== Helpers ====================== */
const toInt = (v, def = null) => {
  const n = Number(v);
  return Number.isFinite(n) ? (n | 0) : def;
};
const toNum = (v, def = null) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
/** Normaliza a 'YYYY-MM-DD' o null */
const toDate = (s) => (s ? String(s).slice(0, 10) : null);
/** Normaliza modo (default = 'agregar') */
const normMode = (m) => {
  const s = String(m || 'agregar').trim().toLowerCase();
  return (s === 'reemplazar') ? 'reemplazar' : 'agregar';
};
/** Regla de traslape (rangos inclusivos) */
const overlapSQL = `
  SELECT id, porcentaje, fecha_inicio, fecha_fin, activo
  FROM descuentos_cliente_producto
  WHERE cliente_id = ? AND producto_id = ? AND activo = 1
    AND NOT (fecha_fin < ? OR fecha_inicio > ?)
`;

const getRolId = (req) => {
  const u = req?.user || {};
  const raw =
    u.rol_id ?? u.rolId ?? u.roleId ?? // num id
    u.rol ?? u.role ?? u.tipo ?? 0;     // string rol
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  const s = String(raw || '').toLowerCase();
  if (s.includes('super')) return 4;
  if (s.includes('admin')) return 1;
  return 0;
};
const requireSuperAdmin = (req, res) => {
  if (getRolId(req) !== 4) {
    res.status(403).json({ error: 'Permisos insuficientes (requiere SuperAdmin).' });
    return false;
  }
  return true;
};

/* ===================================================== */
/* ===============  POR CLIENTE (CRUD)  ================ */
/* ===================================================== */

export const listarDescuentosProducto = async (req, res) => {
  try {
    const { clienteId } = req.params;
    const cliId = toInt(clienteId);
    if (!cliId) return res.status(400).json({ error: 'clienteId inválido' });

    const [rows] = await db.query(`
      SELECT d.id, d.cliente_id, d.producto_id,
             p.nombre AS producto_nombre,
             p.color  AS color,
             cp.nombre AS categoria_nombre,
             d.porcentaje, d.fecha_inicio, d.fecha_fin, d.activo,
             CASE
               WHEN d.activo=0 THEN 'inactivo'
               WHEN CURDATE()<d.fecha_inicio THEN 'programado'
               WHEN CURDATE()>d.fecha_fin THEN 'vencido'
               ELSE 'vigente'
             END AS estado
      FROM descuentos_cliente_producto d
      JOIN productos p ON p.id=d.producto_id
      LEFT JOIN categorias_productos cp ON cp.id = p.categoria_id
      WHERE d.cliente_id=?
      ORDER BY cp.nombre ASC, p.nombre ASC, d.fecha_inicio DESC
    `, [cliId]);

    res.json(rows || []);
  } catch (err) {
    console.error('listarDescuentosProducto', err);
    res.status(500).json({ error: 'Error al listar descuentos por producto' });
  }
};

export const obtenerDescuentoProductoVigente = async (req, res) => {
  try {
    const { clienteId } = req.params;
    const cliId = toInt(clienteId);
    const { productoId } = req.query;
    const prodId = toInt(productoId);
    if (!cliId || !prodId) return res.status(400).json({ error: 'clienteId / productoId inválidos' });

    const [rows] = await db.query(`
      SELECT *
      FROM descuentos_cliente_producto d
      WHERE d.cliente_id=? AND d.producto_id=? AND d.activo=1
        AND CURDATE() BETWEEN d.fecha_inicio AND d.fecha_fin
      ORDER BY d.porcentaje DESC, d.id DESC
      LIMIT 1
    `, [cliId, prodId]);

    res.json(rows?.[0] || null);
  } catch (err) {
    console.error('obtenerDescuentoProductoVigente', err);
    res.status(500).json({ error: 'Error al obtener descuento por producto' });
  }
};

export const crearDescuentoProducto = async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  const { clienteId } = req.params;
  const cliId = toInt(clienteId);

  const {
    producto_id,
    porcentaje,
    fecha_inicio,
    fecha_fin,
    activo = true,
    modo: modoBody
  } = req.body || {};
  const modo = normMode(modoBody ?? req.query?.modo);

  try {
    if (!cliId) return res.status(400).json({ error: 'clienteId inválido' });

    const prodId = toInt(producto_id);
    const pct = toNum(porcentaje);
    const ini = toDate(fecha_inicio);
    const fin = toDate(fecha_fin);
    const actv = !!activo;

    if (!prodId) return res.status(400).json({ error: 'producto_id requerido' });
    if (pct == null || pct < 0 || pct > 100) return res.status(400).json({ error: 'porcentaje debe ser 0–100' });
    if (!ini || !fin) return res.status(400).json({ error: 'fecha_inicio y fecha_fin requeridas' });
    if (fin < ini) return res.status(400).json({ error: 'fecha_fin no puede ser menor a fecha_inicio' });

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [overlaps] = await conn.query(overlapSQL, [cliId, prodId, ini, fin]);

      if (overlaps.length > 0 && modo === 'agregar') {
        await conn.rollback();
        return res.status(409).json({
          error: 'Este cliente ya tiene un descuento activo que cubre estas fechas para este producto.',
          action: 'confirm_reemplazar',
          overlaps
        });
      }

      if (overlaps.length > 0 && modo === 'reemplazar') {
        const ids = overlaps.map(r => r.id);
        await conn.query(
          `UPDATE descuentos_cliente_producto SET activo=0 WHERE id IN (${ids.map(()=>'?').join(',')})`,
          ids
        );
      }

      const [ins] = await conn.query(
        `INSERT INTO descuentos_cliente_producto
           (cliente_id, producto_id, porcentaje, fecha_inicio, fecha_fin, activo)
         VALUES (?,?,?,?,?,?)`,
        [cliId, prodId, pct, ini, fin, actv ? 1 : 0]
      );

      await conn.commit();
      return res.status(201).json({
        id: ins.insertId,
        cliente_id: cliId,
        producto_id: prodId,
        porcentaje: pct,
        fecha_inicio: ini,
        fecha_fin: fin,
        activo: actv
      });
    } catch (e) {
      if (e?.code === 'ER_SIGNAL_EXCEPTION' || e?.sqlState === '45000') {
        try { await conn.rollback(); } catch {}
        return res.status(409).json({
          error: e?.sqlMessage || 'Traslape detectado por la base de datos.',
          action: 'confirm_reemplazar'
        });
      }
      try { await conn.rollback(); } catch {}
      console.error('crearDescuentoProducto', e);
      return res.status(500).json({ error: e.message || 'Error al crear descuento' });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('crearDescuentoProducto', err);
    res.status(500).json({ error: err.message });
  }
};

export const actualizarDescuentoProducto = async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;

  const { clienteId, id } = req.params;
  const cliId = toInt(clienteId);
  const rowId = toInt(id);

  const {
    porcentaje,
    fecha_inicio,
    fecha_fin,
    activo,
    modo: modoBody
  } = req.body || {};
  const modo = normMode(modoBody ?? req.query?.modo);

  try {
    if (!cliId || !rowId) return res.status(400).json({ error: 'ids inválidos' });

    const onlyToggle =
      typeof activo !== 'undefined' &&
      typeof porcentaje === 'undefined' &&
      typeof fecha_inicio === 'undefined' &&
      typeof fecha_fin === 'undefined';

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [cur] = await conn.query(
        `SELECT cliente_id, producto_id, porcentaje, fecha_inicio, fecha_fin, activo
           FROM descuentos_cliente_producto
          WHERE id=? AND cliente_id=? LIMIT 1`,
        [rowId, cliId]
      );
      if (!cur.length) {
        await conn.rollback();
        return res.status(404).json({ error: 'No encontrado' });
      }
      const current = cur[0];
      const prodId = toInt(current.producto_id);

      if (onlyToggle) {
        const [r] = await conn.query(
          `UPDATE descuentos_cliente_producto SET activo=? WHERE id=? AND cliente_id=?`,
          [!!activo ? 1 : 0, rowId, cliId]
        );
        await conn.commit();
        return res.json({ id: rowId, cliente_id: cliId, activo: !!activo });
      }

      const newPct = (typeof porcentaje !== 'undefined') ? toNum(porcentaje) : current.porcentaje;
      const newIni = (typeof fecha_inicio !== 'undefined') ? toDate(fecha_inicio) : toDate(current.fecha_inicio);
      const newFin = (typeof fecha_fin !== 'undefined') ? toDate(fecha_fin) : toDate(current.fecha_fin);
      const newAct = (typeof activo !== 'undefined') ? (!!activo ? 1 : 0) : current.activo;

      if (newPct == null || newPct < 0 || newPct > 100) {
        await conn.rollback();
        return res.status(400).json({ error: 'porcentaje debe ser 0–100' });
      }
      if (!newIni || !newFin) {
        await conn.rollback();
        return res.status(400).json({ error: 'fecha_inicio y fecha_fin requeridas' });
      }
      if (newFin < newIni) {
        await conn.rollback();
        return res.status(400).json({ error: 'fecha_fin no puede ser menor a fecha_inicio' });
      }

      if (newAct === 1) {
        const [overlaps] = await conn.query(
          `${overlapSQL} AND id <> ?`,
          [cliId, prodId, newIni, newFin, rowId]
        );

        if (overlaps.length > 0 && modo === 'agregar') {
          await conn.rollback();
          return res.status(409).json({
            error: 'Este cliente ya tiene un descuento activo que cubre estas fechas para este producto.',
            action: 'confirm_reemplazar',
            overlaps
          });
        }

        if (overlaps.length > 0 && modo === 'reemplazar') {
          const ids = overlaps.map(r => r.id);
          await conn.query(
            `UPDATE descuentos_cliente_producto SET activo=0 WHERE id IN (${ids.map(()=>'?').join(',')})`,
            ids
          );
        }
      }

      const [r] = await conn.query(
        `UPDATE descuentos_cliente_producto
            SET porcentaje = ?,
                fecha_inicio = ?,
                fecha_fin = ?,
                activo = ?
          WHERE id = ? AND cliente_id = ?`,
        [newPct, newIni, newFin, newAct, rowId, cliId]
      );
      if (!r.affectedRows) {
        await conn.rollback();
        return res.status(404).json({ error: 'No encontrado' });
      }

      await conn.commit();
      res.json({
        id: rowId,
        cliente_id: cliId,
        producto_id: prodId,
        porcentaje: newPct,
        fecha_inicio: newIni,
        fecha_fin: newFin,
        activo: !!newAct
      });
    } catch (e) {
      if (e?.code === 'ER_SIGNAL_EXCEPTION' || e?.sqlState === '45000') {
        try { await conn.rollback(); } catch {}
        return res.status(409).json({
          error: e?.sqlMessage || 'Traslape detectado por la base de datos.',
          action: 'confirm_reemplazar'
        });
      }
      try { await conn.rollback(); } catch {}
      console.error('actualizarDescuentoProducto', e);
      return res.status(500).json({ error: e.message || 'Error al actualizar descuento' });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('actualizarDescuentoProducto', err);
    res.status(500).json({ error: err.message });
  }
};

export const toggleDescuentoProducto = async (req, res) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const { clienteId, id } = req.params;
    const cliId = toInt(clienteId);
    const rowId = toInt(id);
    const flag = req.body?.activo ? 1 : 0;

    if (!cliId || !rowId) return res.status(400).json({ error: 'ids inválidos' });

    const [r] = await db.query(
      `UPDATE descuentos_cliente_producto SET activo=? WHERE id=? AND cliente_id=?`,
      [flag, rowId, cliId]
    );
    if (!r.affectedRows) return res.status(404).json({ error:'No encontrado' });
    res.json({ mensaje: 'Estatus actualizado', id: rowId, activo: !!flag });
  } catch (err) {
    console.error('toggleDescuentoProducto', err);
    res.status(500).json({ error: err.message });
  }
};

/* ===================================================== */
/* ==============  GLOBAL A TODOS CLIENTES  ============ */
/* ===================================================== */
export const aplicarDescuentoProductoGlobal = async (req, res) => {
  if (getRolId(req) !== 4) return res.status(403).json({ error: 'Permisos insuficientes (requiere SuperAdmin).' });

  const {
    producto_id,
    porcentaje,
    fecha_inicio,
    fecha_fin,
    activo = true,
    modo = 'reemplazar'
  } = req.body || {};

  try {
    const prodId = toInt(producto_id);
    const pct = toNum(porcentaje);
    const ini = toDate(fecha_inicio);
    const fin = toDate(fecha_fin);
    const actv = !!activo;
    const m = normMode(modo) || 'reemplazar';

    if (!prodId) return res.status(400).json({ error: 'producto_id requerido' });
    if (pct == null || pct < 0 || pct > 100) return res.status(400).json({ error: 'porcentaje debe ser 0–100' });
    if (!ini || !fin) return res.status(400).json({ error: 'fecha_inicio y fecha_fin requeridas' });
    if (fin < ini) return res.status(400).json({ error: 'fecha_fin no puede ser menor a fecha_inicio' });

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      let disabled = 0;
      let inserted = 0;

      if (m === 'reemplazar') {
        const [upd] = await conn.query(`
          UPDATE descuentos_cliente_producto d
          JOIN clientes c ON c.id = d.cliente_id
         SET d.activo = 0
        WHERE c.activo = 1 AND c.eliminado = 0
          AND d.producto_id = ?
          AND d.activo = 1
          AND NOT (? < d.fecha_inicio OR ? > d.fecha_fin)
        `, [prodId, fin, ini]);
        disabled = upd.affectedRows || 0;

        const [ins] = await conn.query(`
          INSERT INTO descuentos_cliente_producto
            (cliente_id, producto_id, porcentaje, fecha_inicio, fecha_fin, activo)
          SELECT c.id, ?, ?, ?, ?, ?
            FROM clientes c
           WHERE c.activo = 1 AND c.eliminado = 0
        `, [prodId, pct, ini, fin, actv ? 1 : 0]);
        inserted = ins.affectedRows || 0;

      } else {
        const [ins] = await conn.query(`
          INSERT INTO descuentos_cliente_producto
            (cliente_id, producto_id, porcentaje, fecha_inicio, fecha_fin, activo)
          SELECT c.id, ?, ?, ?, ?, ?
            FROM clientes c
           WHERE c.activo = 1 AND c.eliminado = 0
             AND NOT EXISTS (
               SELECT 1
                 FROM descuentos_cliente_producto d
                WHERE d.cliente_id = c.id
                  AND d.producto_id = ?
                  AND d.activo = 1
                  AND NOT (? < d.fecha_inicio OR ? > d.fecha_fin)
             )
        `, [prodId, pct, ini, fin, actv ? 1 : 0, prodId, fin, ini]);
        inserted = ins.affectedRows || 0;
      }

      await conn.commit();
      res.json({ mensaje: 'Descuento global aplicado', producto_id: prodId, inserted, disabled, modo: m });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      console.error('aplicarDescuentoProductoGlobal', e);
      if (e?.code === 'ER_SIGNAL_EXCEPTION' || e?.sqlState === '45000') {
        return res.status(409).json({ error: e?.sqlMessage || 'Traslape detectado por la base de datos.' });
      }
      res.status(500).json({ error: e.message || 'Error al aplicar descuento global' });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('aplicarDescuentoProductoGlobal outer', e);
    res.status(500).json({ error: e.message || 'Error al aplicar descuento global' });
  }
};
