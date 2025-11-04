import jwt from 'jsonwebtoken';

const ROL_VENDEDOR   = 3;
const ROL_SUPERADMIN = 4;

export const verificarVendedor = (req, res, next) => {
  try {
    if (req.method === 'OPTIONS') return next();
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : authHeader.trim();
    if (!token) return res.status(401).json({ msg: 'Token no proporcionado o inválido' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    if (![ROL_VENDEDOR, ROL_SUPERADMIN].includes(decoded.rol)) {
      return res.status(403).json({ msg: 'No tienes permisos para acceder' });
    }

    next();
  } catch (error) {
    const msg = error?.name === 'TokenExpiredError' ? 'Token expirado' : 'Token inválido o expirado';
    return res.status(401).json({ msg });
  }
};
