// routes/cargador/envasesRoutes.js
import express from 'express';
import {
  listVendedores,
  getCargaActiva,
  getHistorial,
  getResumenEnvases,  // <- NUEVO
  registrarSalida,
  registrarRecoleccion,
} from '../../controllers/cargador/envasesController.js';

const router = express.Router();

router.get('/vendedores',   listVendedores);
router.get('/carga-activa', getCargaActiva);
router.get('/historial',    getHistorial);
router.get('/resumen',      getResumenEnvases);  // <- NUEVO

router.post('/salida',      registrarSalida);
router.post('/recoleccion', registrarRecoleccion);

export default router;
