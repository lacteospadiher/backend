import { Router } from 'express';
import {
  getCargaActiva,
  getDevolucionesPendientes,
  getTotalesCorte,
  confirmarResumen,
  hacerCorte,
  marcarCargaListaParaProcesar, // ← NUEVO
} from '../../controllers/vendedor/inventarioController.js';

// import { authVendedor } from '../../middlewares/auth.js';

const router = Router();

// router.use(authVendedor); // si aplica

router.get('/activo', getCargaActiva);
router.get('/devoluciones-pendientes', getDevolucionesPendientes);
router.get('/totales', getTotalesCorte);
router.post('/confirmar', confirmarResumen);
router.post('/corte', hacerCorte);

// NUEVO: marca lista_para_procesar = 1 en la carga vigente
router.post('/marcar-procesar', marcarCargaListaParaProcesar);

export default router;
