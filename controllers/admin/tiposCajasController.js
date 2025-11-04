// controllers/tiposCajasController.js
import db from '../../config/db.js';

export const listarTiposCajas = async (_req, res) => {
  try {
    const [rows] = await db.query(`SELECT id, nombre, descripcion FROM tipos_cajas ORDER BY nombre`);
    res.json(rows);
  } catch (e) {
    console.error('listarTiposCajas', e);
    res.status(500).json({ error: 'Error al listar tipos de cajas' });
  }
};
