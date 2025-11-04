// src/routes/cambios.routes.js
import { Router } from 'express';
import { createCambio } from '../../controllers/admin/cambiosController.js';

const router = Router();
router.post('/', createCambio);

export default router;
