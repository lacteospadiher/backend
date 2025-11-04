// routes/vendedor/devolucionesRoutes.js
import { Router } from 'express';
import {
  getInventarioVigente,
  getParaDevolver,
  getDevolucionesPendientes,
  postDevolucion,
  patchProcesarDevolucion
} from '../../controllers/vendedor/devolucionesController.js';

const router = Router();

/**
 * Base en server.js:
 * app.use('/api/vendedor/devoluciones', vendedorDevolucionesRoutes);
 *
 * Endpoints resultantes:
 *  GET    /api/vendedor/devoluciones/inventario
 *  GET    /api/vendedor/devoluciones/para-devolver
 *  GET    /api/vendedor/devoluciones/pendientes
 *  POST   /api/vendedor/devoluciones
 *  PATCH  /api/vendedor/devoluciones/:id/procesar
 */

// Inventario vigente (para mostrar "Restante")
router.get('/inventario', getInventarioVigente);

// Máximo devolvible (ventas - devoluciones) en la carga vigente
router.get('/para-devolver', getParaDevolver);

// Listar devoluciones pendientes del vendedor
router.get('/pendientes', getDevolucionesPendientes);

// Registrar devolución
router.post('/', postDevolucion);

// Marcar devolución como procesada
router.patch('/:id/procesar', patchProcesarDevolucion);

export default router;
