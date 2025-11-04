// routes/vendedor/historialVentasRoutes.js
import { Router } from 'express';
import {
  getVentasPorCliente,
  getVentaById,
  getMotivosNoVenta
} from '../../controllers/vendedor/historialVentasController.js';

const router = Router();
router.get('/', getVentasPorCliente);               // ?cliente_id=# | ?cliente_qr= | &limit=
router.get('/motivos-no-venta', getMotivosNoVenta); // ?cliente_id=#
router.get('/:ventaId', getVentaById);              // detalle/reimpresión
export default router;
