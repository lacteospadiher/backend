// routes/vendedor/balanceRoutes.js
import { Router } from 'express';
import { getBalanceVendedor } from '../../controllers/vendedor/balanceController.js';
import { verificarJwt } from '../../middlewares/verificarJwt.js';
import { requireAnyRole } from '../../middlewares/roles.js';

const router = Router();

/**
 * Roles permitidos:
 *  - Vendedor (3)
 *  - Admin (1)
 *  - SuperAdmin (4)
 * Ajusta si tu enumeración difiere.
 */
router.get('/:id',
  verificarJwt,
  requireAnyRole([1, 3, 4]),
  getBalanceVendedor
);

export default router;
