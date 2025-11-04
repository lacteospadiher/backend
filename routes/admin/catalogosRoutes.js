import { Router } from 'express';
import { obtenerEstados, obtenerMunicipios } from '../../controllers/admin/catalogosController.js';

const router = Router();

router.get('/estados', obtenerEstados);              // GET /api/estados
router.get('/municipios', obtenerMunicipios);        // GET /api/municipios?estado_id=xx

export default router;
