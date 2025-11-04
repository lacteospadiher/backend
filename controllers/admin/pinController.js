// controllers/admin/pinController.js
import bcrypt from 'bcryptjs';
import db from '../../config/db.js';

/**
 * Intenta resolver el id real del cargador a partir de:
 *  - cargadores.id  (cuando ya tienes el id de cargador)
 *  - usuarios.id    (cuando te pasan el id del usuario)
 */
async function resolveCargadorId(idOrUsuario) {
  const [rows] = await db.query(
    `SELECT id
       FROM cargadores
      WHERE id = ? OR id_usuario = ?
      LIMIT 1`,
    [idOrUsuario, idOrUsuario]
  );
  return rows?.[0]?.id || null;
}

export const getPinStatus = async (req, res) => {
  try {
    const user = req.user; // { id, rol }
    if (user?.rol !== 4) {
      return res.status(403).json({ msg: 'Solo SuperAdmin' });
    }

    const { id } = req.params; // puede ser cargadores.id o usuarios.id
    const cargadorId = await resolveCargadorId(id);
    if (!cargadorId) return res.status(404).json({ msg: 'Cargador no encontrado' });

    const [rows] = await db.query(
      `SELECT
         id,
         pin_hash IS NOT NULL AS tiene_pin,
         pin_updated_by,
         pin_updated_at,
         pin_intentos,
         pin_bloqueado_hasta
       FROM cargadores
      WHERE id = ?`,
      [cargadorId]
    );

    return res.json({ ok: true, ...rows[0] });
  } catch (e) {
    console.error('getPinStatus error:', e);
    return res.status(500).json({ msg: 'Error del servidor' });
  }
};

export const setPin = async (req, res) => {
  try {
    const user = req.user; // { id, rol }
    if (user?.rol !== 4) {
      return res.status(403).json({ msg: 'Solo SuperAdmin' });
    }

    const { id } = req.params; // puede ser cargadores.id o usuarios.id
    const cargadorId = await resolveCargadorId(id);
    if (!cargadorId) return res.status(404).json({ msg: 'Cargador no encontrado' });

    const { pin } = req.body || {};
    if (!pin || typeof pin !== 'string' || pin.trim().length < 4) {
      return res.status(400).json({ msg: 'PIN inválido (mín. 4 caracteres)' });
    }

    const hash = await bcrypt.hash(pin.trim(), 12);
    const [result] = await db.query(
      `UPDATE cargadores
          SET pin_hash = ?,
              pin_updated_by = ?,
              pin_updated_at = NOW(),
              pin_intentos = 0,
              pin_bloqueado_hasta = NULL
        WHERE id = ?`,
      [hash, user.id, cargadorId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ msg: 'Cargador no encontrado' });
    }

    return res.json({ ok: true, msg: 'PIN actualizado' });
  } catch (e) {
    console.error('setPin error:', e);
    return res.status(500).json({ msg: 'Error del servidor' });
  }
};

export const clearPin = async (req, res) => {
  try {
    const user = req.user; // { id, rol }
    if (user?.rol !== 4) {
      return res.status(403).json({ msg: 'Solo SuperAdmin' });
    }

    const { id } = req.params; // puede ser cargadores.id o usuarios.id
    const cargadorId = await resolveCargadorId(id);
    if (!cargadorId) return res.status(404).json({ msg: 'Cargador no encontrado' });

    const [result] = await db.query(
      `UPDATE cargadores
          SET pin_hash = NULL,
              pin_updated_by = ?,
              pin_updated_at = NOW(),
              pin_intentos = 0,
              pin_bloqueado_hasta = NULL
        WHERE id = ?`,
      [user.id, cargadorId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ msg: 'Cargador no encontrado' });
    }

    return res.json({ ok: true, msg: 'PIN removido' });
  } catch (e) {
    console.error('clearPin error:', e);
    return res.status(500).json({ msg: 'Error del servidor' });
  }
};
