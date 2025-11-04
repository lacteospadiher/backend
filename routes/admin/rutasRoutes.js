// routes/admin/rutasRoutes.js
import { Router } from 'express';
import {
  obtenerRutaDelDia,
  preloadDia,
  preloadSemana,
  iniciarRuta,
  finalizarRuta,
  reiniciarRuta,
  agregarClienteRuta,
  scanClienteRuta,
  resumenRuta,
  clientesDisponiblesPlantilla,
} from '../../controllers/admin/rutasController.js';

const r = Router();

/* --- Rutas “estáticas” (deben ir antes de las que llevan :id) --- */
r.get('/', obtenerRutaDelDia); // <-- esto resuelve tu 404
r.get('/plantilla/disponibles', clientesDisponiblesPlantilla);
r.post('/preload-dia', preloadDia);
r.post('/preload-semana', preloadSemana);

/* --- Rutas basadas en :id (después de las anteriores) --- */
r.patch('/:id/iniciar', iniciarRuta);
r.patch('/:id/finalizar', finalizarRuta);
r.patch('/:id/reiniciar', reiniciarRuta);
r.get('/:id/resumen', resumenRuta);
r.post('/:id/scan', scanClienteRuta);
r.post('/:id/clientes', agregarClienteRuta);

export default r;
