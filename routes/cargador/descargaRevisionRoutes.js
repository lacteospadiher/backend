// routes/cargador/descargaRevisionRoutes.js
import { Router } from 'express';
import {
  listarVendedores,
  listarProductos,
  listarCargasPendientes,
  listarDevolucionesPendientes,
  confirmarRevision,
  listarDescargasPendientes,
  obtenerDescargaPorId,
  patchDescargaEstado,
  confirmarDescarga,
} from '../../controllers/cargador/descargaRevisionController.js';

const router = Router();

// Monta en server.js:
// app.use('/api/cargador/descarga-revision', router)

router.get('/vendedores', listarVendedores);
router.get('/productos', listarProductos);

// Pendientes para la app móvil (cargas del día sin procesar)
router.get('/pendientes', listarCargasPendientes);

// Alias para Android (drListarDevolPend)
router.get('/devoluciones-pendientes', listarDevolucionesPendientes);
router.get('/devoluciones', listarDevolucionesPendientes);

// Detalle/listado de descargas (snapshots armados)
router.get('/descargas', listarDescargasPendientes);     // ?descargaId=###
router.get('/descargas/:id', obtenerDescargaPorId);

// Cambiar estado descarga — 2 rutas compatibles
router.patch('/descargas/:id/estado', patchDescargaEstado);
// 👇 Esta es la que usa tu ApiService.patchDescargaEstado
router.patch('/:id/estado', patchDescargaEstado);

// Confirmar revisión (POST desde la app)
router.post('/confirmar', confirmarRevision);

router.post('/descargas/:id/confirmar', confirmarDescarga);
export default router;
