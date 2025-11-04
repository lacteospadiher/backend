// routes/admin/inventarioRoutes.js
import { Router } from 'express';

import {
  inventarioDelDiaVendedor,
  historialInventarioVendedor,
  crearCarga,
  listarCargasDeVendedor,
  crearDescarga,
  listarDescargasDeVendedor,
  resumenInventarioVendedor,
  movimientosInventarioVendedor,
} from '../../controllers/admin/inventarioController.js';

// Reusa balance para alias /totales
import { balanceVendedor } from '../../controllers/admin/vendedoresController.js';

const router = Router();

/** Inventario del día o por carga (scope=carga) */
router.get('/vendedores/:id/dia', inventarioDelDiaVendedor);

/** Historial (rangos) por vendedor */
router.get('/vendedores/:id/historial', historialInventarioVendedor);

/** Resumen y Movimientos (con scope=carga opcional) */
router.get('/vendedores/:id/resumen', resumenInventarioVendedor);
router.get('/vendedores/:id/movimientos', movimientosInventarioVendedor);

/** Cargas */
router.post('/cargas', crearCarga);
router.get('/vendedores/:id/cargas', listarCargasDeVendedor);

/** Descargas */
router.post('/descargas', crearDescarga);
router.get('/vendedores/:id/descargas', listarDescargasDeVendedor);

/** ✅ Alias de compat: /api/inventario/totales => balanceVendedor */
router.get('/totales', (req, res, next) => {
  const idV = Number(req.query.idVendedor || req.query.vendedorId || req.query.id);
  if (!idV) return res.status(400).json({ error: 'idVendedor requerido' });
  req.params.id = idV;
  return balanceVendedor(req, res, next);
});

export default router;
