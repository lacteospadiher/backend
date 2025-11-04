// routes/productos.routes.js
import { Router } from 'express';
import {
  listarProductos,
  obtenerProductoPorId,
  crearProducto,
  editarProducto,
  eliminarProducto,
  activarProducto
} from '../../controllers/admin/productosController.js';

const router = Router();

router.get('/', listarProductos);
router.get('/:id', obtenerProductoPorId);
router.post('/', crearProducto);
router.put('/:id', editarProducto);
router.delete('/:id', eliminarProducto);
router.patch('/:id/activar', activarProducto);

export default router;
