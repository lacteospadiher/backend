import db from '../../config/db.js';

// --- Estados ---
export const obtenerEstados = async (req, res) => {
  try {
    const [estados] = await db.query('SELECT id, nombre FROM estados WHERE activo = 1 ORDER BY nombre');
    res.json(estados);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener estados' });
  }
};

// --- Municipios ---
export const obtenerMunicipios = async (req, res) => {
  const { estado_id } = req.query;
  if (!estado_id) {
    return res.status(400).json({ error: 'Falta estado_id' });
  }
  try {
    const [municipios] = await db.query(
      'SELECT id, nombre FROM municipios WHERE estado_id = ? AND activo = 1 ORDER BY nombre',
      [estado_id]
    );
    res.json(municipios);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener municipios' });
  }
};
