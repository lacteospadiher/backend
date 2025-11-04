// routes/admin/dashboard.routes.js
import { Router } from 'express';
import {
  obtenerVentasDelDia,
  obtenerAlertasMantenimiento,
  productosMasVendidos,
  vendedoresMasVentas,
  clientesDestacadosPorMunicipio,
  obtenerMunicipios,
  creditosResumen,
  clientesTopDestacados, // ✅
} from '../../controllers/admin/dashboardController.js';

import { verificarAdmin } from '../../middlewares/verificarAdmin.js';

const router = Router();

// Ventas del día
router.get('/ventas-dia', verificarAdmin, obtenerVentasDelDia);

// Alertas de mantenimiento
router.get('/mantenimiento-alertas', verificarAdmin, obtenerAlertasMantenimiento);

// Estadísticas
router.get('/estadisticas/productos-mas-vendidos', verificarAdmin, productosMasVendidos);
router.get('/estadisticas/vendedores-mas-ventas', verificarAdmin, vendedoresMasVentas);
router.get('/estadisticas/clientes-destacados-municipio', verificarAdmin, clientesDestacadosPorMunicipio);
router.get('/estadisticas/top-clientes', verificarAdmin, clientesTopDestacados); // ✅ nuevo

// Catálogos
router.get('/municipios', verificarAdmin, obtenerMunicipios);

// Créditos por cobrar
router.get('/creditos', verificarAdmin, creditosResumen);

export default router;
