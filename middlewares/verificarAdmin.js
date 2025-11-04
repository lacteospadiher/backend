// middlewares/verificarAdmin.js
import jwt from 'jsonwebtoken';

export const verificarAdmin = (req, res, next) => {
  try {
    // Permitir preflight CORS
    if (req.method === 'OPTIONS') return next();

    // Soporta "Bearer <token>" o el token directo
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : authHeader.trim();

    if (!token) {
      return res.status(401).json({ msg: 'Token no proporcionado o inválido' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    // Reglas de acceso por método:
    // - GET/HEAD: Admin (1) o SuperAdmin (4)
    // - Otros (POST/PUT/PATCH/DELETE): solo SuperAdmin (4)
    if (['GET', 'HEAD'].includes(req.method)) {
      if (![1, 4].includes(decoded.rol)) {
        return res.status(403).json({ msg: 'No tienes permisos para acceder' });
      }
    } else {
      if (decoded.rol !== 4) {
        return res.status(403).json({ msg: 'Solo el SuperAdministrador puede realizar esta acción' });
      }
    }

    next();
  } catch (error) {
    const msg =
      error?.name === 'TokenExpiredError'
        ? 'Token expirado'
        : 'Token inválido o expirado';
    return res.status(401).json({ msg });
  }
};
