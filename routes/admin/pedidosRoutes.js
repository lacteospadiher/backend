// routes/admin/pedidosRoutes.js
import { Router } from 'express';
import { listPendientes, marcarProcesado } from '../../controllers/admin/pedidosAdminController.js';

// Si tienes middleware de auth/roles, colócalo aquí.
// import { authAdmin } from '../../middlewares/auth.js';

const router = Router();

router.get('/pendientes', /*authAdmin,*/ listPendientes);
router.post('/:id/procesar', /*authAdmin,*/ marcarProcesado);

export default router;
