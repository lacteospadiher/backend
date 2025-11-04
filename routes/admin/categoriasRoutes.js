// routes/categorias.routes.js
import { Router } from 'express';
import { listarCategorias, crearCategoria } from '../../controllers/admin/categoriasController.js';

const router = Router();

router.get('/', listarCategorias);
router.post('/', crearCategoria);

export default router;
