// routes/admin/vendedoresRoutes.js
import { Router } from 'express';

import {
  listarVendedores,
  obtenerVendedor,
  dashboardVendedor,
  timelineVendedor,
  listarVentasVendedor,
  listarDevolucionesVendedor,
  balanceVendedor,
  listarVendedoresSimple,
  iniciarRutaManual,
  finalizarRutaManual,
  listarCreditosVendedor
} from '../../controllers/admin/vendedoresController.js';

const router = Router();

router.get('/', listarVendedores);
router.get('/simple', listarVendedoresSimple);
router.get('/:id', obtenerVendedor);
router.get('/:id/dashboard', dashboardVendedor);

// Detalle
router.get('/:id/timeline', timelineVendedor);
router.get('/:id/ventas', listarVentasVendedor);
router.get('/:id/devoluciones', listarDevolucionesVendedor);
router.get('/:id/creditos', listarCreditosVendedor);

// Compat para el frontend que pide /cambios (ahora balance)
router.get('/:id/cambios', balanceVendedor);
router.get('/:id/balance', balanceVendedor);

// Control manual de ruta (HOY)
router.post('/:id/ruta/iniciar', iniciarRutaManual);
router.post('/:id/ruta/finalizar', finalizarRutaManual);

export default router;
