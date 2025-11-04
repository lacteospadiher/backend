// routes/admin/plantillasRutaRoutes.js
import { Router } from 'express';
import {
  getPlantillaSemana,     // semana completa (usado por tu modal)
  getPlantillaDia,        // opcional: un día específico
  addClientePlantilla,
  reorderPlantillaDia,
  removeClientePlantilla,
} from '../../controllers/admin/plantillasRutaController.js';

const router = Router();

// Plantilla (semana completa y por día)
router.get('/plantilla', getPlantillaSemana);       // <-- tu modal usa este
router.get('/plantilla/dia', getPlantillaDia);      // <-- opcional

// Altas / edición
router.post('/plantilla/clientes', addClientePlantilla);
router.patch('/plantilla/reordenar', reorderPlantillaDia);
router.delete('/plantilla/cliente', removeClientePlantilla);

export default router;
