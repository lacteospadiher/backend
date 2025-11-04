import { Router } from 'express';
import { listarEstados, listarMunicipios } from '../../controllers/vendedor/agregarClienteController.js';

const router = Router();
router.get('/estados', listarEstados);
router.get('/municipios', listarMunicipios);
export default router;
