// routes/vendedor/scannerRoutes.js
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import {
  validarCodigo,
  getClientePorCodigo,
  marcarEscaneo
} from '../../controllers/vendedor/scannerController.js';

const router = Router();

// Middleware JWT simple
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

router.post('/validar', auth, validarCodigo);
router.get('/cliente/:codigo', auth, getClientePorCodigo);
router.post('/marcar-escaneo', auth, marcarEscaneo);

export default router;
