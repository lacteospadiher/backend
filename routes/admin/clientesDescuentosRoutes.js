// routes/admin/clientesDescuentosRoutes.js
import { Router } from 'express';
import {
  listarDescuentosCliente,
  crearDescuentoCliente,
  actualizarDescuentoCliente,
  toggleDescuentoCliente,
  obtenerDescuentoVigente
} from '../../controllers/admin/clientesDescuentosController.js';

const router = Router();

router.get('/:clienteId/descuentos', listarDescuentosCliente);
router.get('/:clienteId/descuentos/vigente', obtenerDescuentoVigente);
router.post('/:clienteId/descuentos', crearDescuentoCliente);
router.patch('/:clienteId/descuentos/:id', actualizarDescuentoCliente);
router.patch('/:clienteId/descuentos/:id/toggle', toggleDescuentoCliente);

export default router;
