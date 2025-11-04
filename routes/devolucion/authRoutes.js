// routes/devolucion/authRoutes.js
import { Router } from 'express';
import { loginDevoluciones } from '../../controllers/devolucion/authController.js';

const router = Router();

// POST /api/devolucion/auth/login
router.post('/login', loginDevoluciones);

export default router;
