// controllers/devolucion/authController.js
import db from '../../config/db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const ROLE_DEVOLUCIONES = 5;

const roleNombre = (rol_id) => {
  switch (Number(rol_id)) {
    case 1: return 'Administrador';
    case 2: return 'Cargador';
    case 3: return 'Vendedor';
    case 4: return 'SuperAdmin';
    case 5: return 'Devoluciones';
    case 6: return 'Pedidos';
    default: return 'Desconocido';
  }
};

/**
 * Body admitido (cualquiera de estos campos):
 * {
 *   input | usuario | email | correo,
 *   password | contrasena | pass
 * }
 */
export const loginDevoluciones = async (req, res) => {
  try {
    const rawInput =
      req.body.input ??
      req.body.usuario ??
      req.body.email ??
      req.body.correo ??
      '';

    const rawPass =
      req.body.password ??
      req.body.contrasena ??
      req.body.pass ??
      '';

    const input = String(rawInput || '').trim();
    const password = String(rawPass || '').trim();

    if (!input) return res.status(400).json({ message: 'Ingresa tu usuario o correo' });
    if (password.length < 6) return res.status(400).json({ message: 'Contraseña mínima de 6 caracteres' });

    // Buscar por usuario o por correo
    const byMail = input.includes('@');
    const sql = byMail
      ? 'SELECT id, nombre, usuario, correo, contrasena, rol_id, activo, eliminado FROM usuarios WHERE correo = ? LIMIT 1'
      : 'SELECT id, nombre, usuario, correo, contrasena, rol_id, activo, eliminado FROM usuarios WHERE usuario = ? LIMIT 1';

    const [[user]] = await db.query(sql, [input]);
    if (!user) return res.status(401).json({ message: 'Usuario y/o contraseña inválidos' });

    if (user.eliminado === 1) {
      return res.status(403).json({ message: 'La cuenta está eliminada' });
    }
    if (user.activo !== 1) {
      return res.status(403).json({ message: 'La cuenta está inactiva' });
    }
    if (Number(user.rol_id) !== ROLE_DEVOLUCIONES) {
      return res.status(403).json({ message: 'Este usuario no es de Devoluciones' });
    }

    const ok = await bcrypt.compare(password, user.contrasena);
    if (!ok) return res.status(401).json({ message: 'Usuario y/o contraseña inválidos' });

    // JWT
    const token = jwt.sign(
      { uid: user.id, rol_id: user.rol_id, scope: 'devolucion' },
      process.env.JWT_SECRET || 'change-me',
      { expiresIn: '12h' }
    );

    return res.json({
      id: user.id,
      usuario: user.usuario,
      nombre: user.nombre,
      rol: roleNombre(user.rol_id),
      token,
    });
  } catch (e) {
    console.error('[devolucion/login] error:', e);
    return res.status(500).json({ message: 'Error en el login de Devoluciones' });
  }
};
