// controllers/vendedor/authVendedor.js
import db from '../../config/db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const ALLOWED_ROLES = new Set(['Vendedor', 'SuperAdministrador']);

export const loginVendedor = async (req, res) => {
  try {
    const { usuario, contrasena } = req.body || {};
    if (!usuario || !contrasena) {
      return res.status(400).json({ msg: 'usuario y contrasena son requeridos' });
    }

    // Normalizamos el usuario (quitar espacios)
    const userKey = String(usuario).trim();

    // Trae usuario + rol + vendedor_id (si existe) + camioneta opcional
    const [rows] = await db.query(
      `
      SELECT
        u.id                 AS user_id,
        u.usuario            AS usuario,
        u.contrasena         AS hash,
        u.rol_id             AS rol_id,
        r.nombre             AS rol_nombre,
        u.nombre             AS nombre,
        v.id                 AS vendedor_id,
        v.camioneta_id       AS camioneta_id
      FROM usuarios u
      JOIN roles r       ON r.id = u.rol_id
      LEFT JOIN vendedores v ON v.id_usuario = u.id
      WHERE u.usuario = ? AND u.eliminado = 0 AND u.activo = 1
      LIMIT 1
      `,
      [userKey]
    );

    if (!rows.length) {
      return res.status(401).json({ msg: 'Credenciales inválidas' });
    }

    const u = rows[0];

    // Verifica contraseña
    const ok = await bcrypt.compare(contrasena, u.hash || '');
    if (!ok) return res.status(401).json({ msg: 'Credenciales inválidas' });

    // Verifica rol permitido
    if (!ALLOWED_ROLES.has(u.rol_nombre)) {
      return res.status(403).json({ msg: 'No tienes permisos de vendedor' });
    }

    // Requiere estar registrado como vendedor
    if (!u.vendedor_id) {
      return res.status(403).json({ msg: 'Usuario no registrado como Vendedor' });
    }

    // Actualiza último login (no bloqueante)
    db.query('UPDATE usuarios SET ultimo_login = NOW() WHERE id = ?', [u.user_id]).catch(() => {});

    // Genera JWT
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ msg: 'Falta JWT_SECRET en el servidor' });
    }

    const payload = { id: u.user_id, rol: u.rol_id, rolNombre: u.rol_nombre, vendedorId: u.vendedor_id };
    const token = jwt.sign(payload, secret, { expiresIn: '8h' });

    return res.json({
      token,
      expiresIn: 8 * 60 * 60,
      usuario: u.usuario,
      nombre: u.nombre,
      rolId: u.rol_id,
      rolNombre: u.rol_nombre,
      id: u.user_id,
      vendedorId: u.vendedor_id,
      camionetaId: u.camioneta_id ?? null,
    });
  } catch (err) {
    console.error('[loginVendedor] error:', err);
    return res.status(500).json({ msg: 'Error del servidor' });
  }
};

// Middleware opcional para proteger rutas de vendedor
export const verificarVendedor = (req, res, next) => {
  try {
    if (req.method === 'OPTIONS') return next();

    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();
    if (!token) return res.status(401).json({ msg: 'Token no proporcionado o inválido' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // decoded: { id, rol, rolNombre, vendedorId, iat, exp }
    if (!decoded?.id || !decoded?.rolNombre || !decoded?.vendedorId) {
      return res.status(401).json({ msg: 'Token inválido' });
    }
    if (!ALLOWED_ROLES.has(decoded.rolNombre)) {
      return res.status(403).json({ msg: 'No tienes permisos para acceder' });
    }

    req.user = decoded;
    next();
  } catch (e) {
    const msg = e?.name === 'TokenExpiredError' ? 'Token expirado' : 'Token inválido o expirado';
    return res.status(401).json({ msg });
  }
};

// (Opcional) endpoint de verificación/me
export const meVendedor = (req, res) => {
  // Requiere montar verificarVendedor antes de este handler
  const u = req.user;
  return res.json({
    id: u.id,
    rol: u.rolNombre,
    vendedorId: u.vendedorId,
  });
};
