// controllers/categorias.controller.js
import db from '../../config/db.js';

export const listarCategorias = async (_req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT id, nombre, slug, activo
      FROM categorias_productos
      WHERE activo = 1
      ORDER BY nombre
    `);
    res.json(rows);
  } catch (e) {
    console.error('listarCategorias', e);
    res.status(500).json({ error: 'Error al listar categorías' });
  }
};

export const crearCategoria = async (req, res) => {
  try {
    const { nombre } = req.body;
    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ error: 'El nombre de la categoría es obligatorio' });
    }
    const slug = String(nombre).trim().toLowerCase().replace(/\s+/g, '-');

    const [r] = await db.query(`
      INSERT INTO categorias_productos (nombre, slug, activo)
      VALUES (?, ?, 1)
    `, [nombre.trim(), slug]);

    res.json({ mensaje: 'Categoría creada', id: r.insertId });
  } catch (e) {
    if (e?.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Ya existe una categoría con ese nombre' });
    }
    console.error('crearCategoria', e);
    res.status(500).json({ error: 'Error al crear categoría' });
  }
};


