// src/routes/ventas.routes.js
import { Router } from 'express';
import { createVentaPublico } from '../../controllers/admin/ventasController.js';

const router = Router();
router.post('/publico', createVentaPublico);

export default router;
