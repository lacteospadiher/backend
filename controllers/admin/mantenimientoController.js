import pool from '../../config/db.js';

export const listarMantenimientosPorCamioneta = async (req, res) => {
  try {
    const { id } = req.params;
    const [mantenimientos] = await pool.query(
      `SELECT mc.*, 
              u.nombre AS responsable_usuario 
       FROM mantenimientos_camionetas mc
       LEFT JOIN usuarios u ON mc.id_usuario = u.id
       WHERE mc.id_camioneta = ?
       ORDER BY mc.fecha DESC`,
      [id]
    );
    res.json(mantenimientos);
  } catch (error) {
    console.error(error);
    res.status(500).json({ mensaje: 'Error al obtener mantenimientos' });
  }
};

// Agregar mantenimiento a una camioneta
export const agregarMantenimiento = async (req, res) => {
  try {
    const { id } = req.params;
    const { kilometraje, descripcion, id_usuario, fecha, tipo, costo, responsable_externo } = req.body;

    await pool.query(
      `INSERT INTO mantenimientos_camionetas 
      (id_camioneta, kilometraje, descripcion, id_usuario, fecha, tipo, costo, responsable_externo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, kilometraje, descripcion, id_usuario, fecha || new Date(), tipo, costo, responsable_externo]
    );

    // Actualiza el kilometraje actual, el último mantenimiento, y la fecha en camionetas
    await pool.query(
      `UPDATE camionetas 
       SET ultimo_mantenimiento_km = ?, 
           ultima_fecha_mantenimiento = ?, 
           kilometraje_actual = ?
       WHERE id = ?`,
      [kilometraje, fecha || new Date(), kilometraje, id]
    );

    res.status(201).json({ mensaje: 'Mantenimiento agregado' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ mensaje: 'Error al agregar mantenimiento' });
  }
};