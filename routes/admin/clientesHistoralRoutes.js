// routes/admin/clientesHistorialRoutes.js
import { Router } from 'express';
import { historialComprasCliente, detalleVenta } from '../../controllers/admin/clientesHistorialController.js';

const router = Router();

router.get('/:clienteId/historial', historialComprasCliente);
router.get('/venta/:ventaId/detalle', detalleVenta);

export default router;
