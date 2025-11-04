// routes/pedidos/authRoutes.js
import { Router } from 'express';
import { loginPedidos } from '../../controllers/pedidos/authController.js';

const router = Router();

// POST /api/pedidos/auth/login
router.post('/login', loginPedidos);

export default router;
