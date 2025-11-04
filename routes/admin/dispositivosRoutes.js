// routes/admin/dispositivosRoutes.js
import { Router } from 'express';
import {
  listarDispositivos,
  getDispositivoById,
  crearDispositivo,
  actualizarDispositivo,
  eliminarDispositivo,
  asignarDispositivo,
  devolverDispositivo,
  vincularImpresora,
  desvincularImpresora,
  listarUsuariosElegibles
} from '../../controllers/admin/dispositivosController.js';

// Si tienes middlewares de auth/roles, colócalos aquí (ejemplos):
// import { requireAuth, requireRole } from '../../middlewares/auth.js';

const router = Router();

// GET /api/admin/dispositivos?search=&tipo=&asignados=&page=&pageSize=
router.get('/', /* requireAuth, requireRole('Administrador','SuperAdministrador'), */ listarDispositivos);

// GET /api/admin/dispositivos/usuarios-elegibles?para=CEL|TAB
router.get('/usuarios-elegibles', /* requireAuth, */ listarUsuariosElegibles);

// GET /api/admin/dispositivos/:id
router.get('/:id', /* requireAuth, */ getDispositivoById);

// POST /api/admin/dispositivos
router.post('/', /* requireAuth, requireRole('Administrador','SuperAdministrador'), */ crearDispositivo);

// PATCH /api/admin/dispositivos/:id
router.patch('/:id', /* requireAuth, requireRole('Administrador','SuperAdministrador'), */ actualizarDispositivo);

// DELETE /api/admin/dispositivos/:id
router.delete('/:id', /* requireAuth, requireRole('Administrador','SuperAdministrador'), */ eliminarDispositivo);

// POST /api/admin/dispositivos/:id/asignar   { usuario_id, observaciones? }
router.post('/:id/asignar', /* requireAuth, */ asignarDispositivo);

// POST /api/admin/dispositivos/:id/devolver
router.post('/:id/devolver', /* requireAuth, */ devolverDispositivo);

// POST /api/admin/dispositivos/:id/vincular-impresora   { impresora_id }
router.post('/:id/vincular-impresora', /* requireAuth, */ vincularImpresora);

// DELETE /api/admin/dispositivos/:id/vinculo-impresora/:impresoraId
router.delete('/:id/vinculo-impresora/:impresoraId', /* requireAuth, */ desvincularImpresora);

export default router;
