// controllers/tamanos_presentacion.controller.js
import db from '../../config/db.js';

export const listarTamanos = async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM tamanos_presentacion ORDER BY nombre');
    res.json(rows);
  } catch {
    res.json([]);
  }
};
