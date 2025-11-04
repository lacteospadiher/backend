// routes/devolucion/devRoutes.js
import { Router } from 'express';
import {
  listarDevoluciones,
  obtenerDevolucionPorId,
  obtenerOpciones,
  obtenerStats,
} from '../../controllers/devolucion/devController.js';

const router = Router();

// Solo vistas
// GET /api/dev?categoriaId=3&categoria=Lácteos&categoriaSlug=lacteos
router.get('/', listarDevoluciones);
router.get('/opciones', obtenerOpciones);
router.get('/stats', obtenerStats);
router.get('/:id', obtenerDevolucionPorId);

export default router;
