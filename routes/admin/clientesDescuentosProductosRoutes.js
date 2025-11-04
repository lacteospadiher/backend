// routes/admin/clientesDescuentosProductosRoutes.js
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import {
  listarDescuentosProducto,
  obtenerDescuentoProductoVigente,
  crearDescuentoProducto,
  actualizarDescuentoProducto,
  toggleDescuentoProducto,
  aplicarDescuentoProductoGlobal
} from '../../controllers/admin/clientesDescuentosProductoController.js';

/* ========= Middleware inline de autenticación (sin crear archivos) =========
   - Verifica Authorization: Bearer <token>
   - Decodifica con process.env.JWT_SECRET
   - Coloca req.user (acepta payload directo o payload.user)
*/
const ensureAuthInline = (req, res, next) => {
  try {
    const auth = req.headers?.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Falta Authorization Bearer' });

    const token = m[1];
    const secret = process.env.JWT_SECRET || process.env.JWT_ADMIN_SECRET || process.env.JWT_KEY || '';
    if (!secret) {
      // Si no hay secret definido, mejor fallar explícito
      return res.status(500).json({ error: 'JWT secret no configurado en el servidor' });
    }

    const payload = jwt.verify(token, secret);
    req.user = payload?.user || payload || {};
    // Normalización suave por si el token usa otras claves comunes
    if (!req.user.rol_id && (payload?.roleId || payload?.rolId)) req.user.rol_id = payload.roleId || payload.rolId;
    if (!req.user.rol && (payload?.role || payload?.tipo)) req.user.rol = payload.role || payload.tipo;

    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
};

/* ===== Router por CLIENTE (requiere :clienteId) =====
   Base: /api/clientes/:clienteId/descuentos-producto
*/
const routerCliente = Router({ mergeParams: true });
routerCliente.use(ensureAuthInline);

routerCliente.get('/', listarDescuentosProducto);
routerCliente.get('/vigente', obtenerDescuentoProductoVigente);
routerCliente.post('/', crearDescuentoProducto);
routerCliente.patch('/:id', actualizarDescuentoProducto);
routerCliente.patch('/:id/toggle', toggleDescuentoProducto);

/* ===== Router GLOBAL (sin :clienteId) =====
   Base: /api/clientes/descuentos-producto
   Endpoint final:  POST /api/clientes/descuentos-producto/global
*/
const routerGlobal = Router();
routerGlobal.use(ensureAuthInline);
routerGlobal.post('/global', aplicarDescuentoProductoGlobal);

export { routerGlobal as clientesDescuentosProductoGlobalRoutes };
export default routerCliente;
