// routes/mobile/pedidosRoutes.js

import { Router } from 'express';
import { listPendientes, getPedido, marcarProcesado } from '../../controllers/cargador/pedidosController.js';
import jwt from 'jsonwebtoken';

const router = Router();

/* --- Middleware mínimo de auth si no lo tienes ya --- */
const auth = (req, res, next) => {
  try {
    const hdr = req.headers.authorization || '';
    if (!hdr.startsWith('Bearer ')) return res.status(401).json({ msg: 'Token requerido' });
    const token = hdr.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.id, rol: payload.rol };
    next();
  } catch {
    return res.status(401).json({ msg: 'Token inválido' });
  }
};

router.get('/pendientes', auth, listPendientes);
router.get('/:id',        auth, getPedido);
router.post('/:id/marcar-procesado', auth, marcarProcesado);

export default router;
