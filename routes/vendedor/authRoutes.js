// routes/vendedor/authRoutes.js
import { Router } from 'express';
import { loginVendedor, verificarVendedor, meVendedor } from '../../controllers/vendedor/authVendedor.js';

const router = Router();

// POST /api/vendedor/auth/login
router.post('/login', loginVendedor);

// GET /api/vendedor/auth/me (opcional, protegido)
router.get('/me', verificarVendedor, meVendedor);

export default router;
