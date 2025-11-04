// routes/vendedor/clientesListadoRoutes.js
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { listarClientesMovil } from '../../controllers/vendedor/clientesListadoController.js';

const router = Router();

// Auth mínimo: igual que en tus otras rutas de vendedor
const auth = (req, res, next) => {
  try {
    const hdr = req.headers.authorization || '';
    if (!hdr.startsWith('Bearer '))
      return res.status(401).json({ ok: false, msg: 'Token requerido' });
    const token = hdr.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.id, rol: payload.rol };
    next();
  } catch {
    return res.status(401).json({ ok: false, msg: 'Token inválido' });
  }
};

// GET /api/vendedor/clientes/listado
router.get('/listado', auth, listarClientesMovil);

export default router;
