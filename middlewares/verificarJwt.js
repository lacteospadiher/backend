// middlewares/verificarJwt.js
import jwt from 'jsonwebtoken';
import { getRolId } from './roles.js';

export const verificarJwt = (req, res, next) => {
  try {
    if (req.method === 'OPTIONS') return next();

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : authHeader.trim();

    if (!token) return res.status(401).json({ msg: 'Token no proporcionado o inválido' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // decoded puede traer { id, rol_id } o { id, rol } o strings como 'Admin'
    const rolId = getRolId(decoded);
    if (!decoded?.id || !Number.isFinite(rolId)) {
      return res.status(401).json({ msg: 'Token inválido' });
    }

    // Anexamos ambas formas para compatibilidad
    req.user = { ...decoded, rol_id: rolId };
    req.auth = req.user;

    next();
  } catch (error) {
    const msg = error?.name === 'TokenExpiredError' ? 'Token expirado' : 'Token inválido o expirado';
    return res.status(401).json({ msg });
  }
};
