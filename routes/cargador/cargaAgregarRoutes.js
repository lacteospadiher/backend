// routes/cargador/cargaAgregarRoutes.js
import { Router } from 'express';
import {
  listarVendedores,
  listarVendedoresActivos,   // <-- NUEVO
  listarProductos,
  ultimaCargaPorVendedor,
  agregarProductosACarga,
} from '../../controllers/cargador/cargaAgregarController.js';

const router = Router();

router.get('/vendedores',           listarVendedores);
router.get('/vendedores-activos',   listarVendedoresActivos); // <-- NUEVO
router.get('/productos',            listarProductos);
router.get('/ultima-carga',         ultimaCargaPorVendedor);
router.post('/agregar',             agregarProductosACarga);

export default router;
