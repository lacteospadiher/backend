// controllers/productos.controller.js
import db from '../../config/db.js';

/* =============================
   Helpers
   ============================= */
const buildWhere = (q, categoria_id, activosOrActivo) => {
  const where = [];
  const params = [];

  // Filtro por activo / inactivo+eliminado
  if (activosOrActivo == null) {
    // por defecto: no eliminados (cubre activos e inactivos, pero tu UI manda activo=1/0)
    where.push('p.eliminado = 0');
  } else {
    const flag = Number(activosOrActivo);
    if (flag === 1) {
      where.push('p.eliminado = 0 AND p.activo = 1');
    } else {
      // inactivos O eliminados
      where.push('(p.eliminado = 1 OR p.activo = 0)');
    }
  }

  if (q) {
    where.push('(p.nombre LIKE ? OR p.codigo LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (categoria_id) {
    where.push('p.categoria_id = ?');
    params.push(Number(categoria_id));
  }

  return { where: 'WHERE ' + where.join(' AND '), params };
};

const ENUM_COLOR = ['blanco','amarillo'];

const validarPayload = (body, isUpdate = false) => {
  const {
    nombre, precio, precio_mayoreo,
    categoria_id,
    color,
    codigo,
    activo
  } = body ?? {};

  if (!isUpdate) {
    if (!nombre || !String(nombre).trim()) throw new Error('El nombre es obligatorio');
    if (categoria_id == null || isNaN(Number(categoria_id))) throw new Error('categoria_id es obligatorio');
    if (precio == null || isNaN(Number(precio))) throw new Error('El precio es obligatorio');
    if (precio_mayoreo == null || isNaN(Number(precio_mayoreo))) throw new Error('El precio_mayoreo es obligatorio');
  }

  // Validaciones adicionales
  if (precio != null && Number(precio) < 0) throw new Error('El precio no puede ser negativo');
  if (precio_mayoreo != null && Number(precio_mayoreo) < 0) throw new Error('El precio_mayoreo no puede ser negativo');
  if (precio != null && precio_mayoreo != null && Number(precio_mayoreo) > Number(precio)) {
    throw new Error('El precio de mayoreo no puede ser mayor que el precio normal');
  }

  const colorOk = color && ENUM_COLOR.includes(color) ? color : null;

  return {
    nombre: nombre?.trim() ?? null,
    categoria_id: categoria_id != null ? Number(categoria_id) : null,
    precio: precio != null ? Number(precio) : null,
    precio_mayoreo: precio_mayoreo != null ? Number(precio_mayoreo) : 0,
    color: colorOk,
    tipo_venta: 'pieza',
    codigo: codigo?.trim() || null,
    activo: activo == null ? 1 : Number(!!activo),
  };
};

/* =============================
   GET /productos
   ============================= */
export const listarProductos = async (req, res) => {
  try {
    const { search, categoria_id, cliente_id } = req.query;
    const activos = (req.query.activos ?? req.query.activo);

    const { where, params } = buildWhere(search, categoria_id, activos);

    const descWhereParts = [
      `dc.activo = 1`,
      `(dc.fecha_inicio IS NULL OR dc.fecha_inicio <= CURDATE())`,
      `(dc.fecha_fin IS NULL OR dc.fecha_fin >= CURDATE())`
    ];
    const descParams = [];
    if (cliente_id) {
      descWhereParts.push(`dc.cliente_id = ?`);
      descParams.push(Number(cliente_id));
    }
    const descWhere = descWhereParts.join(' AND ');

    const [rows] = await db.query(`
      SELECT
        p.*,
        c.nombre AS categoria,
        dcp.descuento_max,
        dcp.descuentos_activos
      FROM productos p
      LEFT JOIN categorias_productos c ON c.id = p.categoria_id
      LEFT JOIN (
        SELECT
          dc.producto_id,
          MAX(dc.porcentaje) AS descuento_max,
          COUNT(*)           AS descuentos_activos
        FROM descuentos_cliente_producto dc
        WHERE ${descWhere}
        GROUP BY dc.producto_id
      ) dcp ON dcp.producto_id = p.id
      ${where}
      ORDER BY c.nombre ASC, p.nombre ASC, p.fecha_registro DESC
      LIMIT 1000
    `, [...descParams, ...params]);

    res.json(rows);
  } catch (error) {
    console.error('Error al listar productos:', error);
    res.status(500).json({ error: 'Error al listar productos' });
  }
};

/* =============================
   GET /productos/:id
   ============================= */
export const obtenerProductoPorId = async (req, res) => {
  try {
    const { id } = req.params;
    const [[row]] = await db.query(`
      SELECT
        p.*,
        c.nombre AS categoria
      FROM productos p
      LEFT JOIN categorias_productos c ON c.id = p.categoria_id
      WHERE p.id = ?
    `, [id]);

    if (!row) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(row);
  } catch (error) {
    console.error('Error al obtener producto:', error);
    res.status(500).json({ error: 'Error al obtener producto' });
  }
};

/* =============================
   POST /productos
   ============================= */
export const crearProducto = async (req, res) => {
  const conn = await db.getConnection();
  try {
    const p = validarPayload(req.body);

    if (p.codigo) {
      const [existente] = await conn.query(
        `SELECT id FROM productos WHERE codigo = ? AND eliminado = 0`,
        [p.codigo]
      );
      if (existente.length > 0) {
        return res.status(400).json({ error: 'Ese código ya existe' });
      }
    }

    await conn.beginTransaction();

    const [r] = await conn.query(`
      INSERT INTO productos
        (nombre, categoria_id, precio, precio_mayoreo,
         cantidad, unidad_medida, color, tipo_venta,
         codigo, activo, eliminado, fecha_registro, fecha_actualizacion)
      VALUES (?, ?, ?, ?, NULL, NULL, ?, 'pieza', ?, ?, 0, NOW(), NOW())
    `, [
      p.nombre, p.categoria_id, p.precio, p.precio_mayoreo,
      p.color, p.codigo, p.activo
    ]);

    await conn.commit();
    return res.status(201).json({ ok: true, mensaje: 'Producto registrado', id: r.insertId });
  } catch (error) {
    await conn.rollback();
    if (error?.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Duplicado: existe un producto con el mismo código o variante' });
    }
    console.error('Error al crear producto:', error);
    console.error('SQL Msg:', error?.sqlMessage || error?.message);
    return res.status(500).json({ error: error?.message || 'Error al crear producto' });
  } finally {
    conn.release();
  }
};

/* =============================
   PUT /productos/:id
   ============================= */
export const editarProducto = async (req, res) => {
  try {
    const { id } = req.params;
    const p = validarPayload(req.body, true);

    if (p.codigo) {
      const [existente] = await db.query(
        `SELECT id FROM productos WHERE codigo = ? AND id != ? AND eliminado = 0`,
        [p.codigo, id]
      );
      if (existente.length > 0) {
        return res.status(400).json({ error: 'Ese código ya existe' });
      }
    }

    const [r] = await db.query(`
      UPDATE productos SET
        nombre = COALESCE(?, nombre),
        categoria_id = COALESCE(?, categoria_id),
        precio = COALESCE(?, precio),
        precio_mayoreo = COALESCE(?, precio_mayoreo),
        cantidad = NULL,
        unidad_medida = NULL,
        color = ?,
        tipo_venta = 'pieza',
        codigo = ?,
        activo = ?
      WHERE id = ? AND eliminado = 0
    `, [
      p.nombre, p.categoria_id, p.precio, p.precio_mayoreo,
      p.color, p.codigo, p.activo, id
    ]);

    if (r.affectedRows === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true, mensaje: 'Producto actualizado' });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Duplicado: existe un producto con el mismo código o variante' });
    }
    console.error('Error al editar producto:', error);
    res.status(500).json({ error: error?.message || 'Error al editar producto' });
  }
};

/* =============================
   DELETE /productos/:id  (soft delete)
   ============================= */
export const eliminarProducto = async (req, res) => {
  try {
    const { id } = req.params;
    const [r] = await db.query(
      `UPDATE productos SET eliminado = 1, activo = 0 WHERE id = ?`,
      [id]
    );
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true, mensaje: 'Producto eliminado' });
  } catch (error) {
    console.error('Error al eliminar producto:', error);
    res.status(500).json({ error: 'Error al eliminar producto' });
  }
};

/* =============================
   PATCH /productos/:id/activar
   ============================= */
export const activarProducto = async (req, res) => {
  try {
    const { id } = req.params;
    const [r] = await db.query(
      `UPDATE productos SET activo = 1, eliminado = 0 WHERE id = ?`,
      [id]
    );
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true, mensaje: 'Producto activado' });
  } catch (error) {
    console.error('Error al activar producto:', error);
    res.status(500).json({ error: 'Error al activar producto' });
  }
};
