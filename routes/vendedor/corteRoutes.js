// routes/vendedor/corteRoutes.js
import { Router } from 'express';
import { getResumenCorte } from '../../controllers/vendedor/inventarioController.js';
// Si prefieres separarlo en otro controller, cambia el import.

const router = Router();

// /api/vendedor/corte/resumen?vendedorId=###
router.get('/resumen', getResumenCorte);

export default router;
