// src/routes/devoluciones.routes.js
import { Router } from 'express';
import { createDevolucion } from '../../controllers/admin/devolucionesController.js';

const router = Router();
router.post('/', createDevolucion);

export default router;
