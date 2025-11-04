// controllers/devolucion/devController.js
import db from '../../config/db.js';

/* ============================= Helpers ============================= */
const asLike = (v) => `%${String(v || '').trim()}%`;

/** Ajusta 'hasta' a final del día si viene solo 'YYYY-MM-DD' */
const normalizeHasta = (hasta) => {
  if (!hasta) return hasta;
  const s = String(hasta).trim();
  // Si trae hora, lo respetamos; si no, cerramos 23:59:59
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s} 23:59:59` : s;
};

const isNumeric = (v) => v != null && String(v).trim() !== '' && !isNaN(Number(v));
const mapInt = (v, def = null) => (v == null || isNaN(Number(v)) ? def : Number(v));

/**
 * Filtros soportados (todos opcionales):
 * - producto: like contra nombre de producto en detalle (y productos)
 * - motivo: like contra d.motivo
 * - vendedor:
 *    - si es numérico => d.id_vendedor = ?
 *    - si no es numérico => filtra por u.nombre LIKE ?
 * - desde: d.fecha >= ?
 * - hasta: d.fecha <= ? (normalizado a 23:59:59 si viene YYYY-MM-DD)
 * - categoriaId: filtra por productos.categoria_id
 * - categoria: filtra por categorias_productos.nombre (LIKE)
 * - categoriaSlug: filtra por categorias_productos.slug (LIKE)
 */
const buildWhere = ({
  producto,
  motivo,
  vendedor,
  desde,
  hasta,
  categoriaId,
  categoria,
  categoriaSlug,
}) => {
  const where = [];
  const params = [];

  if (producto && producto.trim()) {
    where.push(`EXISTS (
      SELECT 1
      FROM devolucion_detalle ddx
      LEFT JOIN productos px ON px.id = ddx.id_producto
      WHERE ddx.id_devolucion = d.id
        AND (ddx.nombre_producto LIKE ? OR px.nombre LIKE ?)
    )`);
    params.push(asLike(producto), asLike(producto));
  }

  if (motivo && motivo.trim()) {
    where.push(`d.motivo LIKE ?`);
    params.push(asLike(motivo));
  }

  if (vendedor && String(vendedor).trim()) {
    if (isNumeric(vendedor)) {
      where.push(`d.id_vendedor = ?`);
      params.push(Number(vendedor));
    } else {
      // Filtrar por nombre de usuario del vendedor
      where.push(`u.nombre LIKE ?`);
      params.push(asLike(vendedor));
    }
  }

  if (desde && String(desde).trim()) {
    where.push(`d.fecha >= ?`);
    params.push(desde);
  }

  const hastaFix = normalizeHasta(hasta);
  if (hastaFix && hastaFix.trim()) {
    where.push(`d.fecha <= ?`);
    params.push(hastaFix);
  }

  // --------- Filtros por categoría ----------
  // NOTA: filtramos solo líneas con id_producto (si no hay producto, no hay categoría)
  if (isNumeric(categoriaId)) {
    where.push(`EXISTS (
      SELECT 1
      FROM devolucion_detalle ddc
      JOIN productos pc   ON pc.id = ddc.id_producto
      WHERE ddc.id_devolucion = d.id
        AND pc.categoria_id = ?
    )`);
    params.push(Number(categoriaId));
  } else if (categoria && categoria.trim()) {
    // por nombre de categoría
    where.push(`EXISTS (
      SELECT 1
      FROM devolucion_detalle ddc
      JOIN productos pc   ON pc.id = ddc.id_producto
      JOIN categorias_productos cc ON cc.id = pc.categoria_id
      WHERE ddc.id_devolucion = d.id
        AND cc.nombre LIKE ?
    )`);
    params.push(asLike(categoria));
  } else if (categoriaSlug && categoriaSlug.trim()) {
    where.push(`EXISTS (
      SELECT 1
      FROM devolucion_detalle ddc
      JOIN productos pc   ON pc.id = ddc.id_producto
      JOIN categorias_productos cc ON cc.id = pc.categoria_id
      WHERE ddc.id_devolucion = d.id
        AND cc.slug LIKE ?
    )`);
    params.push(asLike(categoriaSlug));
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
  };
};

/* ============================= GET / (lista paginada) ============================= */
export const listarDevoluciones = async (req, res) => {
  try {
    const { page = 1, pageSize = 50, ...filters } = req.query;
    const { whereSql, params } = buildWhere(filters);

    // total
    const [[{ total }]] = await db.query(
      `
      SELECT COUNT(DISTINCT d.id) AS total
      FROM devoluciones d
      LEFT JOIN vendedores v ON v.id = d.id_vendedor
      LEFT JOIN usuarios  u ON u.id = v.id_usuario
      ${whereSql}
      `,
      params
    );

    const limit = Math.max(mapInt(pageSize, 50), 1);
    const offset = (Math.max(mapInt(page, 1), 1) - 1) * limit;

    // datos
    const [rows] = await db.query(
      `
      SELECT
        d.id,
        d.id_vendedor,
        COALESCE(u.nombre, CONCAT('Vendedor #', d.id_vendedor)) AS vendedor_nombre,
        d.id_cliente,
        COALESCE(c.nombre_empresa, d.cliente_nombre)            AS cliente_nombre,
        d.cliente_qr,
        d.motivo,
        d.procesada,
        DATE_FORMAT(d.fecha, '%Y-%m-%d %H:%i:%s')               AS fecha,
        d.creado_en,
        d.actualizado_en,
        SUM(dd.cantidad)                                        AS piezas_devueltas,
        SUM(COALESCE(dd.precio_unitario, 0) * dd.cantidad)      AS importe_estimado,

        /* Primer producto (por id de detalle más bajo) */
        (
          SELECT COALESCE(p2.nombre, dd2.nombre_producto)
          FROM devolucion_detalle dd2
          LEFT JOIN productos p2 ON p2.id = dd2.id_producto
          WHERE dd2.id_devolucion = d.id
          ORDER BY dd2.id ASC
          LIMIT 1
        ) AS primer_producto,

        /* Primera categoría: toma la primera línea que sí tenga producto y categoría */
        COALESCE((
          SELECT cp2.nombre
          FROM devolucion_detalle dd3
          JOIN productos p3 ON p3.id = dd3.id_producto
          JOIN categorias_productos cp2 ON cp2.id = p3.categoria_id
          WHERE dd3.id_devolucion = d.id
          ORDER BY dd3.id ASC
          LIMIT 1
        ), 'Sin categoría') AS primera_categoria

      FROM devoluciones d
      LEFT JOIN vendedores v ON v.id = d.id_vendedor
      LEFT JOIN usuarios  u ON u.id = v.id_usuario
      LEFT JOIN clientes  c ON c.id = d.id_cliente
      LEFT JOIN devolucion_detalle dd ON dd.id_devolucion = d.id
      ${whereSql}
      GROUP BY d.id
      ORDER BY d.fecha DESC, d.id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    res.json({ page: Number(page), pageSize: limit, total, data: rows });
  } catch (error) {
    console.error('Error al listar devoluciones:', error);
    res.status(500).json({ error: 'Error al listar devoluciones' });
  }
};

/* ============================= GET /:id ============================= */
export const obtenerDevolucionPorId = async (req, res) => {
  try {
    const { id } = req.params;

    const [[header]] = await db.query(
      `
      SELECT
        d.*,
        COALESCE(u.nombre, CONCAT('Vendedor #', d.id_vendedor)) AS vendedor_nombre,
        COALESCE(c.nombre_empresa, d.cliente_nombre)            AS cliente_nombre_real,
        DATE_FORMAT(d.fecha, '%Y-%m-%d %H:%i:%s')               AS fecha_fmt
      FROM devoluciones d
      LEFT JOIN vendedores v ON v.id = d.id_vendedor
      LEFT JOIN usuarios  u ON u.id = v.id_usuario
      LEFT JOIN clientes  c ON c.id = d.id_cliente
      WHERE d.id = ?
      `,
      [id]
    );
    if (!header) return res.status(404).json({ error: 'Devolución no encontrada' });

    const [detalle] = await db.query(
      `
      SELECT
        dd.id,
        dd.id_producto,
        COALESCE(p.nombre, dd.nombre_producto) AS nombre_producto,
        dd.cantidad,
        dd.precio_unitario,
        COALESCE(cp.nombre, 'Sin categoría')   AS categoria_nombre
      FROM devolucion_detalle dd
      LEFT JOIN productos p              ON p.id = dd.id_producto
      LEFT JOIN categorias_productos cp  ON cp.id = p.categoria_id
      WHERE dd.id_devolucion = ?
      ORDER BY dd.id ASC
      `,
      [id]
    );

    res.json({ header, detalle });
  } catch (error) {
    console.error('Error al obtener devolución:', error);
    res.status(500).json({ error: 'Error al obtener devolución' });
  }
};

/* ============================= GET /opciones ============================= */
export const obtenerOpciones = async (_req, res) => {
  try {
    const [productos] = await db.query(
      `
      SELECT id, nombre
      FROM productos
      WHERE eliminado = 0 AND activo = 1
      ORDER BY nombre ASC
      `
    );

    const [categorias] = await db.query(
      `
      SELECT id, nombre, slug
      FROM categorias_productos
      WHERE activo = 1
      ORDER BY nombre ASC
      `
    );

    const [motivos] = await db.query(
      `
      SELECT DISTINCT motivo
      FROM devoluciones
      WHERE motivo IS NOT NULL AND motivo <> ''
      ORDER BY motivo ASC
      `
    );

    const [vendedores] = await db.query(
      `
      SELECT v.id, u.nombre
      FROM vendedores v
      JOIN usuarios u ON u.id = v.id_usuario
      WHERE v.activo = 1 AND v.eliminado = 0
      ORDER BY u.nombre ASC
      `
    );

    res.json({
      productos,
      categorias,
      motivos: motivos.map((m) => m.motivo),
      vendedores,
    });
  } catch (error) {
    console.error('Error al obtener opciones:', error);
    res.status(500).json({ error: 'Error al obtener opciones' });
  }
};

/* ============================= GET /stats ============================= */
export const obtenerStats = async (req, res) => {
  try {
    const desde = req.query.desde ?? null;
    const hasta = normalizeHasta(req.query.hasta ?? null);

    const where = [];
    const params = [];
    if (desde) { where.push('d.fecha >= ?'); params.push(desde); }
    if (hasta) { where.push('d.fecha <= ?'); params.push(hasta); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // porMotivo
    const [porMotivo] = await db.query(
      `
      SELECT
        d.motivo,
        CAST(COUNT(DISTINCT d.id) AS UNSIGNED) AS devoluciones,
        CAST(SUM(dd.cantidad)      AS UNSIGNED) AS piezas
      FROM devoluciones d
      LEFT JOIN devolucion_detalle dd ON dd.id_devolucion = d.id
      ${whereSql}
      GROUP BY d.motivo
      ORDER BY devoluciones DESC
      `,
      params
    );

    // porProducto (incluye categoria)
    const [porProducto] = await db.query(
      `
      SELECT
        COALESCE(p.nombre, dd.nombre_producto)     AS producto,
        CAST(SUM(dd.cantidad) AS UNSIGNED)         AS piezas,
        cp.nombre                                   AS categoria
      FROM devoluciones d
      JOIN devolucion_detalle dd   ON dd.id_devolucion = d.id
      LEFT JOIN productos p        ON p.id = dd.id_producto
      LEFT JOIN categorias_productos cp ON cp.id = p.categoria_id
      ${whereSql}
      GROUP BY COALESCE(p.nombre, dd.nombre_producto), cp.nombre
      ORDER BY piezas DESC
      LIMIT 200
      `,
      params
    );

    // porVendedor
    const [porVendedor] = await db.query(
      `
      SELECT
        COALESCE(u.nombre, CONCAT('Vendedor #', d.id_vendedor)) AS vendedor,
        CAST(COUNT(DISTINCT d.id) AS UNSIGNED) AS devoluciones,
        CAST(SUM(dd.cantidad)      AS UNSIGNED) AS piezas
      FROM devoluciones d
      LEFT JOIN vendedores v ON v.id = d.id_vendedor
      LEFT JOIN usuarios  u ON u.id = v.id_usuario
      LEFT JOIN devolucion_detalle dd ON dd.id_devolucion = d.id
      ${whereSql}
      GROUP BY vendedor
      ORDER BY devoluciones DESC
      `,
      params
    );

    // porCategoria
    const [porCategoria] = await db.query(
      `
      SELECT
        COALESCE(cp.nombre, 'Sin categoría')             AS categoria,
        CAST(COUNT(DISTINCT d.id) AS UNSIGNED)           AS devoluciones,
        CAST(SUM(dd.cantidad)      AS UNSIGNED)          AS piezas
      FROM devoluciones d
      JOIN devolucion_detalle dd ON dd.id_devolucion = d.id
      LEFT JOIN productos p              ON p.id = dd.id_producto
      LEFT JOIN categorias_productos cp  ON cp.id = p.categoria_id
      ${whereSql}
      GROUP BY COALESCE(cp.nombre, 'Sin categoría')
      ORDER BY piezas DESC
      `,
      params
    );

    res.json({ porMotivo, porProducto, porVendedor, porCategoria });
  } catch (error) {
    console.error('Error al obtener stats:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
};
