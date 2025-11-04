// server.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';

import db from './config/db.js';
import { verificarJwt } from './middlewares/verificarJwt.js';
import { requireAnyRole } from './middlewares/roles.js';

dotenv.config();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// CORS + body
const ALLOWED_ORIGINS = (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim());
const corsOptions = {
  origin: (origin, cb) => (!origin || ALLOWED_ORIGINS.includes(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS'))),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));

// Salud
app.get('/api/health', (_, res) => res.json({ ok: true }));
app.get('/api/health/db', async (_, res) => {
  try {
    const [[row]] = await db.query('SELECT 1 AS ok');
    return res.json({ ok: row?.ok === 1 });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'db error' });
  }
});

// =========== IMPORTS DE RUTAS ===========

// Auth
import authRoutes from './routes/admin/authRoutes.js';
import cargadorAuthRoutes from './routes/cargador/authroutes.js';
import vendedorAuthRoutes from './routes/vendedor/authRoutes.js';

// Admin core
import usuarioRoutes from './routes/admin/usuarioRoutes.js';
import dashboardRoutes from './routes/admin/dashboardRoutes.js';
import camionetaRoutes from './routes/admin/camionetaRoutes.js';
import mantenimientoRoutes from './routes/admin/mantenimientoRoutes.js';
import catalogosRoutes from './routes/admin/catalogosRoutes.js';
import productosRoutes from './routes/admin/productosRoutes.js';
import tamanosPresentacionRoutes from './routes/admin/tamano_presentacionRoutes.js';
import categoriasRoutes from './routes/admin/categoriasRoutes.js';
import visitasRoutes from './routes/admin/clientesVisitasRoutes.js';
import { listarCadenas } from './controllers/admin/clientesController.js';

// Clientes
import clientesRoutes from './routes/admin/clientesRoutes.js';
import clientesDescuentosRoutes from './routes/admin/clientesDescuentosRoutes.js';
import clientesHistorialRoutes from './routes/admin/clientesHistoralRoutes.js';
import clientesCreditosRoutes from './routes/admin/clientesCreditosRoutes.js';
import clientesQrRoutes from './routes/admin/clientesQrRoutes.js';
import clientesCajasRoutes from './routes/admin/clientesCajasRoutes.js';
import clientesDescuentosProductoRoutes, {
  clientesDescuentosProductoGlobalRoutes,
} from './routes/admin/clientesDescuentosProductosRoutes.js';

// Más admin
import ubicacionRoutes from './routes/admin/ubicacionRoutes.js';
import vendedoresRoutes from './routes/admin/vendedoresRoutes.js';
import rutasPlantillaRoutes from './routes/admin/plantillasRutaRoutes.js';
import rutasRoutes from './routes/admin/rutasRoutes.js';
import inventarioRoutes from './routes/admin/inventarioRoutes.js';
import tiposCajasRoutes from './routes/admin/tiposCajasRoutes.js';
import cambiosRoutes from './routes/admin/cambiosRoutes.js';
import devolucionesRoutes from './routes/admin/devolucionesRoutes.js';
import ventasRoutes from './routes/admin/ventasRoutes.js';
import descuentosGlobalesRoutes from './routes/admin/descuentosGlobalesRoutes.js';
import reportesRoutes from './routes/admin/reportesRoutes.js';
import cargadoresPinRoutes from './routes/admin/pinRoutes.js';
import dispositivosRoutes from './routes/admin/dispositivosRoutes.js';

// Cargador
import mobileCommonRoutes from './routes/cargador/commonRoutes.js';
import cargadorPedidosRoutes from './routes/cargador/pedidosRoutes.js';
import registrarPedidoRoutes from './routes/cargador/registrarPedidoRoutes.js';
import cargadorDescargasRoutes from './routes/cargador/descargasRoutes.js'; // <= alias plano /api/cargador/descargas
import descargaRevisionRoutes from './routes/cargador/descargaRevisionRoutes.js';
import cargaAgregarRoutes from './routes/cargador/cargaAgregarRoutes.js';
import envasesRoutes from './routes/cargador/envasesRoutes.js';
import opcionesVendedorRoutes from './routes/vendedor/opcionesRoutes.js';
import pedidosAdminRoutes from './routes/admin/pedidosRoutes.js';

// Vendedor 
import vendedorInventarioRoutes from './routes/vendedor/inventarioRoutes.js';
import vendedorScannerRoutes from './routes/vendedor/scannerRoutes.js';
import vendedorAgregarClienteRoutes from './routes/vendedor/agregarClienteRoutes.js';
import publicCatalogosRoutes from './routes/vendedor/catalogosRoutes.js';
import ventaPublicoRoutes from './routes/vendedor/ventaPublicoRoutes.js';
import vendedorPedidoRoutes from './routes/vendedor/pedidoRoutes.js';
import vendedorHistorialPedidoRoutes from './routes/vendedor/historialPedidoRoutes.js';
import vendedorNuevaVentaRoutes from './routes/vendedor/nuevaVentaRoutes.js';
import creditosRoutes from './routes/vendedor/creditosRoutes.js';
import vendedorClientesListadoRoutes from './routes/vendedor/clientesListadoRoutes.js';
import vendedorNoVentaRoutes from './routes/vendedor/noVentaRoutes.js';
import vendedorDevolucionesRoutes from './routes/vendedor/devolucionesRoutes.js';
import vendedorHistorialVentasRoutes from './routes/vendedor/historialVentasRoutes.js';
import prestamosCajasRoutes from './routes/vendedor/prestamosCajasRoutes.js';
import vendedorBalanceRoutes from './routes/vendedor/balanceRoutes.js';
// ... arriba con los otros imports de vendedor
import vendedorCorteRoutes from './routes/vendedor/corteRoutes.js';
import devRoutes from './routes/devolucion/devRoutes.js';


// Devolucion 
import pedidosAuth from './routes/pedidos/authRoutes.js';
import pedidosRoutes from './routes/pedidos/pedidosRoutes.js';
// ...otros imports
import devolucionAuthRoutes from './routes/devolucion/authRoutes.js';

// Helpers
import { desactivarVencidos } from './controllers/admin/clientesDescuentosController.js';

// =========== MONTAJE DE RUTAS ===========

// Auth
app.use('/api/admin/auth', authRoutes);
app.get('/api/clientes/cadenas', listarCadenas);

// Admin core
app.use('/api/usuarios', usuarioRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/camionetas', camionetaRoutes);
app.use('/api/mantenimiento', mantenimientoRoutes);
app.use('/api/catalogos', catalogosRoutes);
app.use('/api/productos', productosRoutes);
app.use('/api/tamanos_presentacion', tamanosPresentacionRoutes);
app.use('/api/categorias', categoriasRoutes);
app.use('/api', visitasRoutes);

// Clientes (orden importante)
app.use('/api/clientes', clientesCajasRoutes);
app.use('/api/clientes/descuentos-producto', clientesDescuentosProductoGlobalRoutes);
app.use('/api/clientes/:clienteId/descuentos-producto', clientesDescuentosProductoRoutes);
app.use('/api/clientes', clientesDescuentosRoutes);
app.use('/api/clientes', clientesHistorialRoutes);
app.use('/api/clientes', clientesCreditosRoutes);
app.use('/api/clientes', clientesQrRoutes);
app.use('/api/clientes', clientesRoutes);

// Otros admin
app.use('/api/ubicacion', ubicacionRoutes);
app.use('/api/vendedores', vendedoresRoutes);
app.use('/api/rutas', rutasPlantillaRoutes);
app.use('/api/rutas', rutasRoutes);
app.use('/api/inventario', inventarioRoutes);
app.use('/api/tipos-cajas', tiposCajasRoutes);
app.use('/api/cambios', cambiosRoutes);
app.use('/api/devoluciones', devolucionesRoutes);
app.use('/api/ventas', ventasRoutes);
// Solo Admin (1) y SuperAdmin (4) pueden acceder a /api/reportes (GET/HEAD de tus handlers)
app.use('/api/reportes', verificarJwt, requireAnyRole([1, 4]), reportesRoutes);
app.use('/api/descuentos-globales', descuentosGlobalesRoutes);
app.use('/api/admin/cargadores', cargadoresPinRoutes);
app.use('/api/admin/dispositivos', dispositivosRoutes);

// Cargador (prefijos)
app.use('/api/cargador/auth', cargadorAuthRoutes);
app.use('/api/cargador/common', mobileCommonRoutes);
app.use('/api/cargador/pedidos', cargadorPedidosRoutes);
app.use('/api/cargador/registrar-pedido', registrarPedidoRoutes);
app.use('/api/cargador/descarga-revision', descargaRevisionRoutes);
app.use('/api/cargador/carga-agregar', cargaAgregarRoutes);
app.use('/api/cargador/envases', envasesRoutes);
app.use('/api/vendedor/opciones', opcionesVendedorRoutes);
app.use('/api/admin/pedidos', pedidosAdminRoutes);

// 👇 Alias plano para compat con Android: /api/cargador/descargas
app.use('/api/cargador/descargas', cargadorDescargasRoutes);

// Vendedor
app.use('/api/vendedor/auth', vendedorAuthRoutes);
app.use('/api/vendedor/inventario', vendedorInventarioRoutes);
app.use('/api/vendedor/scanner', vendedorScannerRoutes);
app.use('/api/vendedor/clientes', vendedorAgregarClienteRoutes);
app.use('/api/public/catalogos', publicCatalogosRoutes);
app.use('/api/vendedor', ventaPublicoRoutes);
app.use('/api/vendedor/pedidos', vendedorPedidoRoutes);
app.use('/api/vendedor/pedidos', vendedorHistorialPedidoRoutes);
app.use('/api/vendedor/nueva-venta', vendedorNuevaVentaRoutes);
app.use('/api/creditos', creditosRoutes);
app.use('/api/vendedor/clientes', vendedorClientesListadoRoutes);
app.use('/api/vendedor/no-venta', vendedorNoVentaRoutes);
app.use('/api/vendedor/devoluciones', vendedorDevolucionesRoutes);
app.use('/api/vendedor/historial-ventas', vendedorHistorialVentasRoutes);
app.use('/api/vendedor/balance', vendedorBalanceRoutes);
// Vendedor — préstamos de cajas (CORRECTO)
app.use('/api/vendedor/prestamos-cajas', prestamosCajasRoutes);
app.use('/api/vendedor/corte', vendedorCorteRoutes);
app.use('/api/dev', devRoutes);

// Pedidos
app.use('/api/pedidos/auth', pedidosAuth);
app.use('/api/pedidos', pedidosRoutes);
// ...otras rutas ya montadas

// Devolución (Android cliente)
app.use('/api/devolucion/auth', devolucionAuthRoutes);

// 404
app.use((req, res) => res.status(404).json({ msg: 'Ruta no encontrada', path: req.originalUrl }));

// ============================
// Socket.IO
// ============================
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  path: '/socket.io',
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});
app.set('io', io);

io.on('connection', (socket) => {
  const origin = socket.request?.headers?.origin;
  console.log('[socket] conectado:', socket.id, 'origin:', origin || 'n/a');

  socket.on('join', (room) => socket.join(room));
  socket.on('leave', (room) => socket.leave(room));

  socket.on('disconnect', (reason) => {
    console.log('[socket] desconectado:', socket.id, 'reason:', reason);
  });
});

// ============================
// Arranque HTTP
// ============================
const PORT = Number(process.env.PORT) || 3001;
httpServer.listen(PORT, () => {
  console.log(`🚀 Backend corriendo en puerto ${PORT}`);
});

// ============================
// Helpers CRON
// ============================
const TZ = process.env.CRON_TZ || 'America/Mexico_City';

async function runWithMySqlLock(lockName, fn) {
  const [[row]] = await db.query('SELECT GET_LOCK(?, 0) AS got', [lockName]);
  if (!row?.got) {
    console.log(`[CRON] Saltado por lock: ${lockName}`);
    return;
  }
  try {
    await fn();
  } catch (e) {
    console.error(`[CRON] Error en ${lockName}:`, e);
  } finally {
    try {
      await db.query('DO RELEASE_LOCK(?)', [lockName]);
    } catch (e) {
      console.error(`[CRON] No se pudo liberar lock ${lockName}:`, e?.message);
    }
  }
}

async function broadcastRutaActualizada(estadoFiltro = null, action = 'cron') {
  const sql =
    'SELECT id_vendedor FROM rutas_diarias WHERE fecha = CURDATE()' +
    (estadoFiltro ? ' AND estado = ?' : '');
  const params = estadoFiltro ? [estadoFiltro] : [];
  const [rows] = await db.query(sql, params);
  rows.forEach((r) => {
    io.to(`vendedor:${r.id_vendedor}`).emit('ruta:actualizada', {
      action,
      estado: estadoFiltro || undefined,
    });
  });
}

// ============================
// CRON jobs
// ============================
cron.schedule(
  '0 4 * * *',
  async () => {
    await runWithMySqlLock('cron_preload_rutas', async () => {
      console.log('[CRON] 04:00 Preload rutas (hoy)');
      await db.query('CALL sp_preload_rutas(CURDATE(), NULL)');
      console.log('[CRON] 04:00 OK');
      await broadcastRutaActualizada(null, 'cron_preload');
    });
  },
  { timezone: TZ }
);

cron.schedule(
  '0 8 * * *',
  async () => {
    await runWithMySqlLock('cron_iniciar_rutas', async () => {
      console.log('[CRON] 08:00 Iniciar rutas (hoy)');
      await db.query('CALL sp_iniciar_rutas_auto(CURDATE())');
      console.log('[CRON] 08:00 OK');
      await broadcastRutaActualizada('en_curso', 'cron_iniciar');
    });
  },
  { timezone: TZ }
);

cron.schedule(
  '0 22 * * *',
  async () => {
    await runWithMySqlLock('cron_finalizar_rutas', async () => {
      console.log('[CRON] 22:00 Finalizar rutas (hoy)');
      await db.query('CALL sp_finalizar_rutas_auto(CURDATE())');
      console.log('[CRON] 22:00 OK');
      await broadcastRutaActualizada('finalizada', 'cron_finalizar');
    });
  },
  { timezone: TZ }
);

cron.schedule(
  '5 0 * * *',
  async () => {
    await runWithMySqlLock('cron_descuentos_expiran', async () => {
      console.log('[CRON] 00:05 Desactivar descuentos vencidos');
      await desactivarVencidos();
      console.log('[CRON] 00:05 OK');
    });
  },
  { timezone: TZ }
);

// ============================
// Sync rutas al arrancar
// ============================
(async function bootSyncRutas() {
  try {
    const mxNow = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
    const hour = mxNow.getHours();

    if (hour >= 22) {
      await db.query('CALL sp_finalizar_rutas_auto(CURDATE())');
      await broadcastRutaActualizada('finalizada', 'boot_sync');
    } else if (hour >= 8) {
      await db.query('CALL sp_iniciar_rutas_auto(CURDATE())');
      await broadcastRutaActualizada('en_curso', 'boot_sync');
    } else {
      await broadcastRutaActualizada(null, 'boot_sync');
    }
    console.log('[BOOT] Sync rutas OK');
  } catch (e) {
    console.error('[BOOT] Sync rutas error:', e);
  }
})();

// ============================
// Manejo de errores global
// ============================
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

// ============================
// Apagado limpio
// ============================
async function gracefulShutdown(signal) {
  try {
    console.log(`\n[SHUTDOWN] Señal recibida: ${signal}. Cerrando...`);
    httpServer.close(() => {
      console.log('[HTTP] Servidor detenido.');
    });
    try {
      await db.end?.(); // mysql2/promise pool
      console.log('[DB] Pool cerrado.');
    } catch (e) {
      console.error('[DB] Error al cerrar pool:', e?.message);
    }
  } finally {
    process.exit(0);
  }
}

['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => gracefulShutdown(sig));
});
