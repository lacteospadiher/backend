import jwt from 'jsonwebtoken';

const ROL_CARGADOR   = 2;
const ROL_SUPERADMIN = 4;

export const verificarCargador = (req, res, next) => {
  try {
    if (req.method === 'OPTIONS') return next();

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : authHeader.trim();

    if (!token) {
      return res.status(401).json({ msg: 'Token no proporcionado o inválido' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, rol }

    // ====== Política de acceso ======
    // Permitir a Cargador (2) y SuperAdmin (4) en cualquier método:
    if (![ROL_CARGADOR, ROL_SUPERADMIN].includes(decoded.rol)) {
      return res.status(403).json({ msg: 'No tienes permisos para acceder' });
    }
    // Si quisieras restringir modificaciones solo a Cargador/SuperAdmin,
    // ya está cubierto por la línea anterior. Ajusta aquí si necesitas
    // una lógica distinta por método.
    // =================================

    next();
  } catch (error) {
    const msg =
      error?.name === 'TokenExpiredError'
        ? 'Token expirado'
        : 'Token inválido o expirado';
    return res.status(401).json({ msg });
  }
};
