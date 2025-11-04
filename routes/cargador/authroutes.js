import { Router } from 'express';
import { loginCargador } from '../../controllers/cargador/authController.js';

const router = Router();
router.post('/login', loginCargador);

export default router;
