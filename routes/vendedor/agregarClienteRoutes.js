// routes/vendedor/agregarClienteRoutes.js
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import {
  crearCliente,
  listarMisClientes,
  getClientePorQR,
  listarEstados,        // <-- importa
  listarMunicipios,     // <-- importa
} from '../../controllers/vendedor/agregarClienteController.js';

const router = Router();

// Auth mínimo (para las rutas que sí lo requieren)
const auth = (req, res, next) => {
  try {
    const hdr = req.headers.authorization || '';
    if (!hdr.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, msg: 'Token requerido' });
    }
    const token = hdr.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.id, rol: payload.rol };
    next();
  } catch {
    return res.status(401).json({ ok: false, msg: 'Token inválido' });
  }
};

// ----- Vendedor / Clientes (con auth)
router.post('/crear', auth, crearCliente);
router.get('/mis', auth, listarMisClientes);
router.get('/by-qr/:codigo', auth, getClientePorQR);

// ----- Catálogos (SIN auth, para que cargue el formulario)
router.get('/estados', listarEstados);
router.get('/municipios', listarMunicipios);

export default router;
