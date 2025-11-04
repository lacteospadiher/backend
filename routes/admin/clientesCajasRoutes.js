// routes/admin/clientesCajasRoutes.js
import { Router } from 'express';
import {
  saldoCajasCliente,
  movimientosCajasCliente,
  registrarMovimientoCajas,
  detalleCajasCliente
} from '../../controllers/admin/clientesCajasController.js';

const router = Router({ mergeParams: true });

// ✅ rutas relativas al prefijo con el que se monta en server.js
router.get('/:clienteId/cajas/saldo',       saldoCajasCliente);
router.get('/:clienteId/cajas/detalle',     detalleCajasCliente);
router.get('/:clienteId/cajas/movimientos', movimientosCajasCliente);
router.post('/:clienteId/cajas/movimiento', registrarMovimientoCajas);

export default router;
