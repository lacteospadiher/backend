import { Router } from 'express';
import { listarMantenimientosPorCamioneta, agregarMantenimiento } from '../../controllers/admin/mantenimientoController.js';

const router = Router();

// OJO: la ruta correcta para historial y agregar es esta:
router.get('/camionetas/:id/mantenimientos', listarMantenimientosPorCamioneta);
router.post('/camionetas/:id/mantenimientos', agregarMantenimiento);

export default router;
