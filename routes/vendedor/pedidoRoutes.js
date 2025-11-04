import { Router } from 'express';
import { listarProductos, crearPedido } from '../../controllers/vendedor/pedidoController.js';

const router = Router();

// GET /api/vendedor/pedidos/productos?q=...
router.get('/productos', listarProductos);

// POST /api/vendedor/pedidos
router.post('/', crearPedido);

export default router;
