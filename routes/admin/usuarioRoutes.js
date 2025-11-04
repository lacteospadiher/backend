// routes/admin/usuarioRoutes.js
import { Router } from 'express';
import {
  // === existentes ===
  obtenerAdministradores,
  obtenerSuperAdmins,
  obtenerCargadores,
  obtenerVendedores,
  obtenerVendedoresDisponibles,
  crearUsuario,
  editarUsuario,
  eliminarUsuario,
  cambiarContrasena,
  actualizarVendedorPricingMode,

  // === NUEVOS (roles 5 y 6) ===
  obtenerDevoluciones,
  obtenerPedidos,
  crearUsuarioDevoluciones,
  crearUsuarioPedidos,
  editarUsuarioDevoluciones,
  editarUsuarioPedidos,
  eliminarUsuarioDevoluciones,
  eliminarUsuarioPedidos,
} from '../../controllers/admin/usuarioController.js';
import { verificarAdmin } from '../../middlewares/verificarAdmin.js';

const router = Router();

/* =========================
   Listados
========================= */
router.get('/administradores', verificarAdmin, obtenerAdministradores);
router.get('/superadmins',    verificarAdmin, obtenerSuperAdmins);
router.get('/cargadores',     verificarAdmin, obtenerCargadores);
router.get('/vendedores',     verificarAdmin, obtenerVendedores);
router.get('/vendedores/disponibles', verificarAdmin, obtenerVendedoresDisponibles);

// NUEVOS
router.get('/devoluciones', verificarAdmin, obtenerDevoluciones); // rol 5
router.get('/pedidos',      verificarAdmin, obtenerPedidos);      // rol 6

/* =========================
   Crear
========================= */
router.post('/', verificarAdmin, crearUsuario); // genérico (manda rol_id en body)

// NUEVOS (sin PIN, mismos campos que cargador)
router.post('/devoluciones', verificarAdmin, crearUsuarioDevoluciones); // fuerza rol_id=5
router.post('/pedidos',      verificarAdmin, crearUsuarioPedidos);      // fuerza rol_id=6

/* =========================
   Editar
========================= */
router.put('/:id', verificarAdmin, editarUsuario); // genérico

// NUEVOS (alias de edición por rol)
router.put('/devoluciones/:id', verificarAdmin, editarUsuarioDevoluciones);
router.put('/pedidos/:id',      verificarAdmin, editarUsuarioPedidos);

/* =========================
   Eliminar (soft delete)
========================= */
router.patch('/eliminar/:id', verificarAdmin, eliminarUsuario); // genérico

// NUEVOS (alias por rol)
router.patch('/devoluciones/eliminar/:id', verificarAdmin, eliminarUsuarioDevoluciones);
router.patch('/pedidos/eliminar/:id',      verificarAdmin, eliminarUsuarioPedidos);

/* =========================
   Password & otros
========================= */
router.post('/cambiar-contrasena/:id', verificarAdmin, cambiarContrasena);

// Cambiar rápido el modo de precio por vendedor (id = vendedores.id)
router.patch('/vendedores/:id/pricing-mode', verificarAdmin, actualizarVendedorPricingMode);

export default router;
