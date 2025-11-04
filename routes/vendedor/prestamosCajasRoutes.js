// routes/vendedor/prestamosCajasRoutes.js
import { Router } from 'express';
import {
  getSaldoCliente,
  getHistorialCliente,
  registrarMovimiento,
} from '../../controllers/vendedor/prestamosCajasController.js';

const router = Router();

/**
 * Rutas bajo /api/vendedor/prestamos-cajas
 */
router.get('/saldo', getSaldoCliente);
router.get('/historial', getHistorialCliente);
router.post('/movimientos', registrarMovimiento);

export default router;
