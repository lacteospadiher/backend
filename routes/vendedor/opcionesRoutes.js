// routes/vendedor/opcionesRoutes.js
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { resumenOpciones, me } from '../../controllers/vendedor/opcionesController.js';

const router = Router();

/* Auth mínimo: sólo valida JWT, sin filtrar por rol */
const auth = (req, res, next) => {
  try {
    const hdr = req.headers.authorization || '';
    if (!hdr.startsWith('Bearer ')) {
      return res.status(401).json({ msg: 'Token requerido' });
    }
    const token = hdr.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.id, rol: payload.rol };
    return next();
  } catch {
    return res.status(401).json({ msg: 'Token inválido' });
  }
};

/* Endpoints */
router.get('/me', auth, me);
router.get('/resumen', auth, resumenOpciones);

export default router;
