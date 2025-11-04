// routes/admin/tiposCajasRoutes.js
import { Router } from 'express';
import { listarTiposCajas } from '../../controllers/admin/tiposCajasController.js';

const router = Router();
router.get('/', listarTiposCajas); // GET /api/tipos-cajas

export default router;
