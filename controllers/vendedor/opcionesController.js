// controllers/vendedor/opcionesController.js
import db from '../../config/db.js';

/**
 * GET /api/vendedor/opciones/me
 * Identidad básica (para mostrar en cabecera del menú)
 */
export const me = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ msg: 'No autorizado' });

    const [userRows] = await db.execute(
      `SELECT u.id, u.usuario, u.nombre, u.rol_id
         FROM usuarios u
        WHERE u.id = ? LIMIT 1`,
      [userId]
    );

    const [vendRows] = await db.execute(
      'SELECT v.id AS vendedorId FROM vendedores v WHERE v.id_usuario = ? LIMIT 1',
      [userId]
    );

    return res.json({
      id: userRows[0]?.id ?? null,
      usuario: userRows[0]?.usuario ?? null,
      nombre: userRows[0]?.nombre ?? null,
      rol: userRows[0]?.rol_id ?? null,
      vendedorId: vendRows[0]?.vendedorId ?? null
    });
  } catch (err) {
    console.error('me error:', err);
    return res.status(500).json({ msg: 'Error del servidor' });
  }
};

/**
 * GET /api/vendedor/opciones/resumen?fecha=YYYY-MM-DD
 * Contadores del menú (SIN rutas diarias)
 */
export const resumenOpciones = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ msg: 'No autorizado' });

    // 1) Resolver vendedorId
    const [vendRows] = await db.execute(
      'SELECT v.id AS vendedorId FROM vendedores v WHERE v.id_usuario = ? LIMIT 1',
      [userId]
    );
    const vendedorId = vendRows[0]?.vendedorId || null;
    if (!vendedorId) return res.status(403).json({ msg: 'Usuario no es vendedor' });

    // 2) Fecha (por defecto: hoy)
    const fecha = (req.query.fecha || new Date().toISOString().slice(0, 10)).slice(0, 10);

    // 3) Info básica del usuario (para encabezado)
    const [infoRows] = await db.execute(
      `SELECT u.id, u.usuario, u.nombre, u.rol_id
         FROM usuarios u
        WHERE u.id = ? LIMIT 1`,
      [userId]
    );
    const usuario = infoRows[0] || {};

    // 4) Pedidos pendientes
    const [[pedPend]] = await db.execute(
      `SELECT COUNT(*) AS n
         FROM pedidos
        WHERE id_vendedor = ?
          AND estado = 'pendiente'
          AND procesado = 0`,
      [vendedorId]
    );

    // 5) Inventario del día (si no tienes esta tabla, devuelve ceros)
    let invHoy = { items: 0, total_inicial: 0, total_vendida: 0, total_restante: 0 };
    try {
      const [[rowInv]] = await db.execute(
        `SELECT
            COUNT(*)                            AS items,
            IFNULL(SUM(cantidad_inicial), 0)    AS total_inicial,
            IFNULL(SUM(cantidad_vendida), 0)    AS total_vendida,
            IFNULL(SUM(cantidad_restante), 0)   AS total_restante
           FROM inventario_vendedor
          WHERE id_vendedor = ? AND fecha_dia = ?`,
        [vendedorId, fecha]
      );
      invHoy = rowInv || invHoy;
    } catch {
      // Si inventario_vendedor no existe, respondemos ceros
    }

    // 6) Créditos pendientes (tu esquema usa SALDO, no "pagado")
    const [[credPend]] = await db.execute(
      `SELECT COUNT(*) AS n
         FROM creditos c
         JOIN ventas v ON v.id = c.id_venta
        WHERE v.id_vendedor = ? AND c.saldo > 0`,
      [vendedorId]
    );

    // 7) Devoluciones de hoy (conteo)
    const [[devHoy]] = await db.execute(
      `SELECT COUNT(*) AS n
         FROM devoluciones
        WHERE id_vendedor = ? AND DATE(fecha) = ?`,
      [vendedorId, fecha]
    );

    // 8) SIN rutas diarias → rutaEstado = null
    return res.json({
      vendedor: {
        usuarioId: usuario.id,
        vendedorId,
        usuario: usuario.usuario,
        nombre: usuario.nombre,
        rol: usuario.rol_id
      },
      fecha,
      badges: {
        pedidosPendientes: Number(pedPend?.n || 0),
        rutaEstado: null, // ← sin rutas diarias
        inventarioHoy: {
          items: Number(invHoy?.items || 0),
          totalInicial: Number(invHoy?.total_inicial || 0),
          totalVendida: Number(invHoy?.total_vendida || 0),
          totalRestante: Number(invHoy?.total_restante || 0)
        },
        creditosPendientes: Number(credPend?.n || 0),
        devolucionesHoy: Number(devHoy?.n || 0)
      }
    });
  } catch (err) {
    console.error('resumenOpciones error:', err);
    return res.status(500).json({ msg: 'Error del servidor' });
  }
};
