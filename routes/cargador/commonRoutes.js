import express from 'express';
import { verificarJwt } from '../../middlewares/verificarJwt.js';
import { verifyAdminPin } from '../../controllers/cargador/commonController.js';

const router = express.Router();
router.post('/verify-pin', verificarJwt, verifyAdminPin);
export default router;
