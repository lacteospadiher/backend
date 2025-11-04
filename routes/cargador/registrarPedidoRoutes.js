// routes/cargador/registrarPedidoRoutes.js
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import {
  getProductos,
  getVendedorById,
  getPedidoById,
  patchPedido,
  postConfirmarCarga
} from '../../controllers/cargador/registrarPedidoController.js';

const router = Router();

/** Auth mínimo (usa el mismo JWT_SECRET que ya tienes) */
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

// Catálogos necesarios para la pantalla del cargador
router.get('/productos', auth, getProductos);
router.get('/vendedores/:id', auth, getVendedorById);

// Flujo de "cargar pedido"
router.get('/pedido/:id', auth, getPedidoById);
router.patch('/pedido/:id', auth, patchPedido);
router.post('/confirmar', auth, postConfirmarCarga);

export default router;
