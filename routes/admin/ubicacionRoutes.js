import { Router } from 'express';
import { listarEstados, listarMunicipios } from '../../controllers/admin/ubicacionController.js';

const router = Router();
router.get('/estados', listarEstados);
router.get('/municipios', listarMunicipios);

export default router;
