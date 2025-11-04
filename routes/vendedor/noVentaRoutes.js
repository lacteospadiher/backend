// routes/vendedor/noVentaRoutes.js
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { listarMotivos, registrarNoVenta } from '../../controllers/vendedor/noVentaController.js';

const router = Router();

const auth = (req, res, next) => {
  try {
    const hdr = req.headers.authorization || '';
    if (!hdr.startsWith('Bearer ')) return res.status(401).json({ ok:false, msg:'Token requerido' });
    const token = hdr.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.id, rol: payload.rol };
    next();
  } catch {
    return res.status(401).json({ ok:false, msg:'Token inválido' });
  }
};

router.get('/motivos', auth, listarMotivos);  // opcional (carga catálogo desde backend)
router.post('/', auth, registrarNoVenta);     // registra no-venta

export default router;
