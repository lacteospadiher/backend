import db from '../../config/db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const ROL_CARGADOR   = 2;
const ROL_SUPERADMIN = 4;

export const loginCargador = async (req, res) => {
  const { usuario, contrasena } = req.body;

  try {
    if (!usuario || !contrasena) {
      return res.status(400).json({ msg: 'usuario y contrasena son requeridos' });
    }

    const isEmail = usuario.includes('@');

    const [rows] = await db.execute(
      `
      SELECT
        u.id,
        u.usuario,
        u.correo,
        u.contrasena,
        u.rol_id,
        u.nombre,
        u.activo,
        u.eliminado,
        c.id AS cargador_id
      FROM usuarios u
      LEFT JOIN cargadores c ON c.id_usuario = u.id
      WHERE ${isEmail ? 'u.correo = ?' : 'u.usuario = ?'}
        AND u.eliminado = 0
        AND u.activo    = 1
      LIMIT 1
      `,
      [usuario]
    );

    if (rows.length === 0) return res.status(401).json({ msg: 'Credenciales inválidas' });

    const u = rows[0];
    const ok = await bcrypt.compare(contrasena, u.contrasena || '');
    if (!ok) return res.status(401).json({ msg: 'Credenciales inválidas' });

    if (![ROL_CARGADOR, ROL_SUPERADMIN].includes(u.rol_id)) {
      return res.status(403).json({ msg: 'No tienes permisos de cargador' });
    }
    if (!u.cargador_id) {
      return res.status(403).json({ msg: 'Usuario no registrado como Cargador' });
    }

    // no bloquear si falla
    db.execute('UPDATE usuarios SET ultimo_login = NOW() WHERE id = ?', [u.id]).catch(() => {});

    // ⚠️ Payload EXACTO que espera tu middleware: { id, rol }
    const token = jwt.sign(
      { id: u.id, rol: u.rol_id },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    return res.json({
      token,
      expiresIn: 8 * 60 * 60,
      usuario: u.usuario,
      nombre: u.nombre,
      rol: u.rol_id,
      id: u.id,
      cargadorId: u.cargador_id
    });

  } catch (error) {
    console.error('Error en loginCargador:', error);
    res.status(500).json({ msg: 'Error del servidor' });
  }
};
