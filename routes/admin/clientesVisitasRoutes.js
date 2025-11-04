import { Router } from 'express';
import { getVisitasPorCliente } from '../../controllers/admin/clientesVisitasController.js';

const router = Router();

// EXACTO a lo que consume tu FE:
router.get('/clientes/:id/visitas', getVisitasPorCliente);

export default router;
