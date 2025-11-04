// routes/admin/pinRoutes.js
import express from 'express';
import { verificarJwt } from '../../middlewares/verificarJwt.js';
import { setPin, clearPin, getPinStatus } from '../../controllers/admin/pinController.js';

const router = express.Router();

router.use(verificarJwt); // requieren JWT de SuperAdmin

// Admin de PIN por cargador (acepta id de cargadores.id o usuarios.id)
router.get('/:id/pin', getPinStatus);
router.put('/:id/pin', setPin);
router.delete('/:id/pin', clearPin);

export default router;
