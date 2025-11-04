// routes/cargador/descargasRoutes.js
import { Router } from 'express';
import {
  listarPendientes,
  obtenerPorId,
  actualizarEstado,
} from '../../controllers/cargador/descargasController.js';

const router = Router();

// Montado en server.js con: app.use('/api/cargador/descargas', router)
router.get('/pendientes', listarPendientes);
router.get('/:id', obtenerPorId);
router.patch('/:id/estado', actualizarEstado);

export default router;
