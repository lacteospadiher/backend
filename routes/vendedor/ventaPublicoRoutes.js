// routes/vendedor/ventaPublicoRoutes.js
import { Router } from 'express';
import { getCargaActiva, venderPublico } from '../../controllers/vendedor/ventaPublicoController.js';

const router = Router();

// Mismo handler para ambos paths (compat Android y “inventario”)
router.get('/ventapublico/carga-activa/:idVendedor', getCargaActiva);
router.get('/inventario/activo', getCargaActiva);

// Venta al público (contado/transferencia)
router.post('/ventapublico/vender', venderPublico);

export default router;
