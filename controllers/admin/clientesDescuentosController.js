// controllers/admin/clientesDescuentosController.js
import db from '../../config/db.js';

const getRolId = (req) => {
  const u = req?.user || {};
  const raw =
    u.rol_id ?? u.rolId ?? u.roleId ??
    u.rol ?? u.role ?? u.tipo ?? 0;
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
const isYMD = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * GET /api/clientes/:clienteId/descuentos
 */
export const listarDescuentosCliente = async (req, res) => {
  try {
    const { clienteId } = req.params;

    const [rows] = await db.query(`
      SELECT
        d.id,
        d.cliente_id,
        d.porcentaje,
        d.fecha_inicio,
        d.fecha_fin,
        d.activo,
        CASE
          WHEN d.activo = 0 THEN 'inactivo'
          WHEN CURDATE() < d.fecha_inicio THEN 'programado'
          WHEN CURDATE() > d.fecha_fin THEN 'vencido'
          ELSE 'vigente'
        END AS estado,
        (d.activo = 1 AND CURDATE() BETWEEN d.fecha_inicio AND d.fecha_fin) AS vigente,
        GREATEST(DATEDIFF(d.fecha_fin, CURDATE()), 0) AS dias_restantes
      FROM descuentos_cliente d
      WHERE d.cliente_id = ?
      ORDER BY d.fecha_inicio DESC, d.id DESC
    `, [clienteId]);

    res.json(rows);
  } catch (e) {
    console.error('listarDescuentosCliente', e);
    res.status(500).json({ error: 'Error al listar descuentos' });
  }
};

/**
 * GET /api/clientes/:clienteId/descuentos/vigente
 */
export const obtenerDescuentoVigente = async (req, res) => {
  try {
    const { clienteId } = req.params;
    const [rows] = await db.query(`
      SELECT
        d.id, d.cliente_id, d.porcentaje, d.fecha_inicio, d.fecha_fin, d.activo
      FROM descuentos_cliente d
      WHERE d.cliente_id = ?
        AND d.activo = 1
        AND CURDATE() BETWEEN d.fecha_inicio AND d.fecha_fin
      ORDER BY d.porcentaje DESC, d.id DESC
      LIMIT 1
    `, [clienteId]);

    res.json(rows[0] || null);
  } catch (e) {
    console.error('obtenerDescuentoVigente', e);
    res.status(500).json({ error: 'Error al obtener descuento vigente' });
  }
};

/**
 * POST /api/clientes/:clienteId/descuentos
 * body: { porcentaje, fecha_inicio (YYYY-MM-DD), fecha_fin (YYYY-MM-DD), activo (bool) }
 */
export const crearDescuentoCliente = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const { clienteId } = req.params;
    const { porcentaje, fecha_inicio, fecha_fin, activo = true } = req.body;

    if (porcentaje == null || porcentaje === '') {
      return res.status(400).json({ error: 'porcentaje es obligatorio' });
    }
    const p = Number(porcentaje);
    if (!Number.isFinite(p) || p < 0 || p > 100) {
      return res.status(400).json({ error: 'porcentaje debe estar entre 0 y 100' });
    }
    if (!isYMD(fecha_inicio) || !isYMD(fecha_fin)) {
      return res.status(400).json({ error: 'Fechas inválidas (YYYY-MM-DD).' });
    }
    if (new Date(fecha_fin) < new Date(fecha_inicio)) {
      return res.status(400).json({ error: 'fecha_fin no puede ser menor a fecha_inicio' });
    }

    const [r] = await db.query(`
      INSERT INTO descuentos_cliente (cliente_id, porcentaje, fecha_inicio, fecha_fin, activo)
      VALUES (?, ?, ?, ?, ?)
    `, [clienteId, p, fecha_inicio, fecha_fin, !!activo]);

    res.json({ mensaje: 'Descuento creado', id: r.insertId });
  } catch (e) {
    console.error('crearDescuentoCliente', e);
    const msg = e?.sqlMessage || e?.message || 'Error al crear descuento';
    if ((e?.code === 'ER_SIGNAL_EXCEPTION' || e?.sqlState === '45000')) {
      return res.status(409).json({ error: msg });
    }
    res.status(500).json({ error: msg });
  }
};

/**
 * PATCH /api/clientes/:clienteId/descuentos/:id
 * body opcional: { porcentaje?, fecha_inicio?, fecha_fin?, activo? }
 */
export const actualizarDescuentoCliente = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const { clienteId, id } = req.params;
    const { porcentaje, fecha_inicio, fecha_fin, activo } = req.body;

    if (porcentaje != null) {
      const p = Number(porcentaje);
      if (!Number.isFinite(p) || p < 0 || p > 100) {
        return res.status(400).json({ error: 'porcentaje debe estar entre 0 y 100' });
      }
    }
    if ((fecha_inicio && !isYMD(fecha_inicio)) || (fecha_fin && !isYMD(fecha_fin))) {
      return res.status(400).json({ error: 'Fechas inválidas (YYYY-MM-DD).' });
    }
    if (fecha_inicio && fecha_fin && new Date(fecha_fin) < new Date(fecha_inicio)) {
      return res.status(400).json({ error: 'fecha_fin no puede ser menor a fecha_inicio' });
    }

    const [r] = await db.query(`
      UPDATE descuentos_cliente SET
        porcentaje   = COALESCE(?, porcentaje),
        fecha_inicio = COALESCE(?, fecha_inicio),
        fecha_fin    = COALESCE(?, fecha_fin),
        activo       = COALESCE(?, activo)
      WHERE id = ? AND cliente_id = ?
    `, [porcentaje, fecha_inicio, fecha_fin, (activo == null ? null : !!activo), id, clienteId]);

    if (!r.affectedRows) return res.status(404).json({ error: 'Descuento no encontrado' });

    res.json({ mensaje: 'Descuento actualizado' });
  } catch (e) {
    console.error('actualizarDescuentoCliente', e);
    const msg = e?.sqlMessage || e?.message || 'Error al actualizar descuento';
    if ((e?.code === 'ER_SIGNAL_EXCEPTION' || e?.sqlState === '45000')) {
      return res.status(409).json({ error: msg });
    }
    res.status(500).json({ error: msg });
  }
};

/**
 * PATCH /api/clientes/:clienteId/descuentos/:id/toggle
 * body: { activo: boolean }
 */
export const toggleDescuentoCliente = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const { clienteId, id } = req.params;
    const { activo } = req.body;
    const [r] = await db.query(`
      UPDATE descuentos_cliente
      SET activo = ?
      WHERE id = ? AND cliente_id = ?
    `, [Number(!!activo), id, clienteId]);

    if (!r.affectedRows) return res.status(404).json({ error: 'Descuento no encontrado' });

    res.json({ mensaje: 'Estatus de descuento actualizado' });
  } catch (e) {
    console.error('toggleDescuentoCliente', e);
    res.status(500).json({ error: 'Error al actualizar estatus' });
  }
};

/** CRON opcional: desactiva vencidos */
export const desactivarVencidos = async () => {
  await db.query(`
    UPDATE descuentos_cliente
       SET activo = 0
     WHERE activo = 1
       AND fecha_fin < CURDATE()
  `);
};
