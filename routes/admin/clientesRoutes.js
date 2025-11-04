import { Router } from 'express';
import {
  listarClientes,
  obtenerCliente,
  crearCliente,
  editarCliente,
  eliminarCliente,
  activarCliente,
  listarCadenas, // NUEVO
} from '../../controllers/admin/clientesController.js';

const router = Router();

/* Rutas específicas SIEMPRE antes que las paramétricas */
router.get('/cadenas', listarCadenas);
router.patch('/:id/activar', activarCliente);

router.get('/', listarClientes);
router.get('/:id', obtenerCliente);
router.post('/', crearCliente);
router.put('/:id', editarCliente);
router.delete('/:id', eliminarCliente);

export default router;
