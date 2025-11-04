import { Router } from 'express';
import {
  listarDescuentosGlobales,
  obtenerDescuentoGlobalVigente,
  crearDescuentoGlobal,
  actualizarDescuentoGlobal,
  toggleDescuentoGlobal
} from '../../controllers/admin/descuentosGlobalesController.js';

const router = Router();

router.get('/', listarDescuentosGlobales);
router.get('/vigente', obtenerDescuentoGlobalVigente);
router.post('/', crearDescuentoGlobal);
router.patch('/:id', actualizarDescuentoGlobal);
router.patch('/:id/toggle', toggleDescuentoGlobal);

export default router;
