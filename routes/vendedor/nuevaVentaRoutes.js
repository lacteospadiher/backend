// routes/vendedor/nuevaVentaRoutes.js
import { Router } from 'express';
import {
  getCargaActiva,
  getClientePorCodigo,
  venderContadoCliente,
  venderCredito,
  getDisponibles
} from '../../controllers/vendedor/nuevaVentaController.js';

import { verificarVendedor } from '../../middlewares/verificarVendedor.js';

const router = Router();

// Lecturas
router.get('/carga-activa', verificarVendedor, getCargaActiva);
router.get('/clientes/por-qr/:codigo', verificarVendedor, getClientePorCodigo);
router.get('/disponibles', verificarVendedor, getDisponibles);

// Ventas (siempre con cliente; NO público)
router.post('/ventas/contado', verificarVendedor, venderContadoCliente);
router.post('/ventas/credito', verificarVendedor, venderCredito);

export default router;
