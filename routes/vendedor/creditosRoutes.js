// routes/vendedor/creditosRoutes.js
import { Router } from 'express';
import {
  getCreditosPorQR,
  getCreditosPorCliente,
  getCreditoDetalle,
  postAbono,
  getCreditos
} from '../../controllers/vendedor/creditosController.js';

// Si deseas restringir a vendedores autenticados:
// import { verificarVendedor } from '../../middlewares/verificarVendedor.js';

const router = Router();

// Listado general (filtros opcionales)
// router.get('/', verificarVendedor, getCreditos);
router.get('/', getCreditos);

// Por QR de cliente (pendientes por defecto)
// router.get('/por-qr/:codigo', verificarVendedor, getCreditosPorQR);
router.get('/por-qr/:codigo', getCreditosPorQR);

// Por clienteId
// router.get('/cliente/:clienteId', verificarVendedor, getCreditosPorCliente);
router.get('/cliente/:clienteId', getCreditosPorCliente);

// Detalle de un crédito (incluye abonos)
// router.get('/:creditoId', verificarVendedor, getCreditoDetalle);
router.get('/:creditoId', getCreditoDetalle);

// Registrar abono
// router.post('/:creditoId/abonos', verificarVendedor, postAbono);
router.post('/:creditoId/abonos', postAbono);

export default router;
