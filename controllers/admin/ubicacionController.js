import db from '../../config/db.js';

export const listarEstados = async (_req, res) => {
  try {
    const [rows] = await db.query(`SELECT id, nombre FROM estados WHERE activo = 1 ORDER BY nombre`);
    res.json(rows);
  } catch (e) {
    console.error('listarEstados', e);
    res.status(500).json({ error: 'Error al listar estados' });
  }
};

export const listarMunicipios = async (req, res) => {
  try {
    const { estado_id } = req.query;
    if (!estado_id) return res.status(400).json({ error: 'estado_id es obligatorio' });
    const [rows] = await db.query(
      `SELECT id, nombre FROM municipios WHERE activo = 1 AND estado_id = ? ORDER BY nombre`,
      [estado_id]
    );
    res.json(rows);
  } catch (e) {
    console.error('listarMunicipios', e);
    res.status(500).json({ error: 'Error al listar municipios' });
  }
};
