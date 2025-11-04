import { Router } from "express";
import {
  kpis,
  ventasSerie,
  ventasPorDia,
  ventasPorVendedor,
  ventasPorCliente,
  topProductos,
  detalleVentas,
  rutasCumplimiento,
  rutasListado,
  creditosSaldos,
  creditosAbiertos,
  pagosRecientes,
  inventarioRotacion,
  inventarioActual,
  devolucionesPorMotivo,
  devolucionesDetalle,
  gasolinaConsumo,
  gasolinaRegistros,
  exportCsv,
  exportPrint,
  exportXlsx,
  productosPorCategoria,
} from "../../controllers/admin/reportesController.js";
import { requireSuperAdmin } from "../../middlewares/roles.js";

const r = Router();

/** 🔒 Todo /admin/reportes/* sólo SuperAdmin */
r.use(requireSuperAdmin);

/* ===== KPIs / Ventas ===== */
r.get("/kpis", kpis);
r.get("/ventas/serie", ventasSerie);
r.get("/ventas/por-dia", ventasPorDia);
r.get("/ventas/por-vendedor", ventasPorVendedor);
r.get("/ventas/por-cliente", ventasPorCliente);
r.get("/ventas/top-productos", topProductos);
r.get("/ventas/detalle", detalleVentas);

/* ===== Rutas ===== */
r.get("/rutas/cumplimiento", rutasCumplimiento);
r.get("/rutas/listado", rutasListado);

/* ===== Créditos ===== */
r.get("/creditos/saldos", creditosSaldos);
r.get("/creditos/abiertos", creditosAbiertos);
r.get("/creditos/pagos-recientes", pagosRecientes);

/* ===== Inventario ===== */
r.get("/inventario/rotacion", inventarioRotacion);
r.get("/inventario/actual", inventarioActual);

/* ===== Devoluciones ===== */
r.get("/devoluciones/por-motivo", devolucionesPorMotivo);
r.get("/devoluciones/detalle", devolucionesDetalle);

/* ===== Gasolina ===== */
r.get("/gasolina/consumo", gasolinaConsumo);
r.get("/gasolina/registros", gasolinaRegistros);

/* ===== Catálogo agrupado ===== */
r.get("/productos/por-categoria", productosPorCategoria);

/* ===== Export ===== */
r.get("/export/csv", exportCsv);
r.post("/export/print", exportPrint);
r.get("/export/xlsx", exportXlsx);

export default r;
