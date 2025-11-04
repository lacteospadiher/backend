// routes/vendedor/historialPedidoRoutes.js
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import {
  listarHistorialPedidos,
  obtenerPedido,
  estaBloqueado,
  actualizarPedido,
  listarProductosSimples
} from '../../controllers/vendedor/historialPedidoController.js';

const router = Router();

const auth = (req, res, next) => {
  try {
    const hdr = req.headers.authorization || '';
    if (!hdr.startsWith('Bearer ')) {
      return res.status(401).json({ ok:false, msg:'Token requerido' });
    }
    const token = hdr.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.id, rol: payload.rol };
    next();
  } catch (e) {
    return res.status(401).json({ ok:false, msg:'Token inválido' });
  }
};

router.get('/', auth, listarHistorialPedidos);
router.get('/productos', auth, listarProductosSimples);
router.get('/:pedidoId', auth, obtenerPedido);
router.get('/:pedidoId/bloqueado', auth, estaBloqueado);
router.put('/:pedidoId', auth, actualizarPedido);

export default router;
