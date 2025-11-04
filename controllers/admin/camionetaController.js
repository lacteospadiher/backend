// controllers/camionetas.controller.js
import db from '../../config/db.js'; // tu instancia de conexión mysql2/promise

// Listar todas las camionetas
export const listarCamionetas = async (req, res) => {
  try {
    const [camionetas] = await db.query(`
      SELECT c.*,
             v.id AS id_vendedor,
             u.nombre AS nombre_vendedor
      FROM camionetas c
      LEFT JOIN vendedores v ON v.camioneta_id = c.id AND v.activo = 1 AND v.eliminado = 0
      LEFT JOIN usuarios u ON v.id_usuario = u.id
      WHERE c.eliminado = 0
      ORDER BY c.fecha_registro DESC
    `);
    res.json(camionetas);
  } catch (err) {
    console.error('Error al listar camionetas:', err);
    res.status(500).json({ error: 'Error al listar camionetas' });
  }
};

// Crear una nueva camioneta
export const crearCamioneta = async (req, res) => {
  try {
    const {
      placa, marca, modelo, color,
      aseguradora,               // NUEVO
      seguro_vencimiento,        // NUEVO (YYYY-MM-DD)
      kilometraje_actual, mantenimiento_km,
      ultimo_mantenimiento_km, ultima_fecha_mantenimiento,
      tiene_refrigeracion = false
    } = req.body;

    const [result] = await db.query(`
      INSERT INTO camionetas
        (placa, marca, modelo, color, aseguradora, seguro_vencimiento,
         kilometraje_actual, mantenimiento_km, ultimo_mantenimiento_km, ultima_fecha_mantenimiento, tiene_refrigeracion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      placa, marca, modelo, color, aseguradora || null, seguro_vencimiento || null,
      kilometraje_actual, mantenimiento_km, ultimo_mantenimiento_km, ultima_fecha_mantenimiento || null, !!tiene_refrigeracion
    ]);

    res.json({ mensaje: 'Camioneta registrada correctamente.', id: result.insertId });
  } catch (err) {
    console.error('Error al crear camioneta:', err);
    res.status(500).json({ error: 'Error al crear camioneta', detalle: err.sqlMessage || err.message });
  }
};

// Editar una camioneta existente
export const editarCamioneta = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      placa, marca, modelo, color,
      aseguradora,               // NUEVO
      seguro_vencimiento,        // NUEVO
      kilometraje_actual, mantenimiento_km,
      ultimo_mantenimiento_km, ultima_fecha_mantenimiento,
      tiene_refrigeracion = false
    } = req.body;

    await db.query(`
      UPDATE camionetas SET
        placa = ?, marca = ?, modelo = ?, color = ?,
        aseguradora = ?, seguro_vencimiento = ?,
        kilometraje_actual = ?, mantenimiento_km = ?,
        ultimo_mantenimiento_km = ?, ultima_fecha_mantenimiento = ?,
        tiene_refrigeracion = ?,
        fecha_actualizacion = NOW()
      WHERE id = ? AND eliminado = 0
    `, [
      placa, marca, modelo, color,
      aseguradora || null, seguro_vencimiento || null,
      kilometraje_actual, mantenimiento_km,
      ultimo_mantenimiento_km, ultima_fecha_mantenimiento || null,
      !!tiene_refrigeracion,
      id
    ]);

    res.json({ mensaje: 'Camioneta actualizada correctamente.' });
  } catch (err) {
    console.error('Error al editar camioneta:', err);
    res.status(500).json({ error: 'Error al editar camioneta', detalle: err.sqlMessage || err.message });
  }
};

// Eliminar (lógico) una camioneta
export const eliminarCamioneta = async (req, res) => {
  try {
    const { id } = req.params;
    // 1. ¿Está asignada?
    const [asignada] = await db.query(`
      SELECT id FROM vendedores
      WHERE camioneta_id = ? AND activo = 1 AND eliminado = 0
    `, [id]);
    if (asignada.length > 0) {
      return res.status(400).json({
        mensaje: "Desvincula primero el vendedor antes de eliminar la camioneta."
      });
    }
    // 2. Si no está asignada, elimina
    await db.query(`UPDATE camionetas SET eliminado = 1, activo = 0, fecha_actualizacion = NOW() WHERE id = ?`, [id]);
    res.json({ mensaje: 'Camioneta eliminada correctamente.' });
  } catch (err) {
    console.error('Error al eliminar camioneta:', err);
    res.status(500).json({ error: 'Error al eliminar camioneta', detalle: err.sqlMessage || err.message });
  }
};

// Asignar vendedor a camioneta — v16 (sin tabla puente)
export const asignarVendedor = async (req, res) => {
  const camionetaId = Number(req.params.id); // id de camioneta
  const { id_vendedor } = req.body;          // id de tabla vendedores

  if (!Number.isInteger(camionetaId) || camionetaId <= 0) {
    return res.status(400).json({ error: 'camionetaId inválido' });
  }
  if (!Number.isInteger(id_vendedor) || id_vendedor <= 0) {
    return res.status(400).json({ error: 'id_vendedor inválido' });
  }

  const conn = await db.getConnection(); // mysql2/promise pool
  try {
    await conn.beginTransaction();

    // 0) Validaciones básicas
    const [cam] = await conn.query(
      `SELECT id FROM camionetas WHERE id=? AND activo=1 AND eliminado=0`,
      [camionetaId]
    );
    if (cam.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Camioneta no encontrada o inactiva' });
    }

    const [vend] = await conn.query(
      `SELECT id, camioneta_id FROM vendedores WHERE id=? AND activo=1 AND eliminado=0`,
      [id_vendedor]
    );
    if (vend.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Vendedor no encontrado o inactivo' });
    }

    // 1) Nada que hacer si ya está asignado a esa camioneta
    if (vend[0].camioneta_id === camionetaId) {
      await conn.commit();
      return res.json({ ok: true, mensaje: 'Ya estaba asignado', camionetaId, vendedorId: id_vendedor });
    }

    // 2) Libera la camioneta (cumple UNIQUE en vendedores.camioneta_id)
    await conn.query(`UPDATE vendedores SET camioneta_id = NULL WHERE camioneta_id = ?`, [camionetaId]);

    // 3) Asigna la camioneta al vendedor
    await conn.query(`UPDATE vendedores SET camioneta_id = ? WHERE id = ?`, [camionetaId, id_vendedor]);

    // 4) Historial (si no lo controlas por trigger)
    await conn.query(
      `INSERT INTO historial_asignaciones (camioneta_id, vendedor_id, fecha) VALUES (?, ?, NOW())`,
      [camionetaId, id_vendedor]
    );

    await conn.commit();
    res.json({ ok: true, mensaje: 'Vendedor asignado correctamente.', camionetaId, vendedorId: id_vendedor });
  } catch (err) {
    await conn.rollback();
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'La camioneta ya está asignada (conflicto UNIQUE)' });
    }
    console.error('Error al asignar vendedor:', err);
    res.status(500).json({ error: 'Error interno asignando vendedor' });
  } finally {
    conn.release();
  }
};

// Desvincular vendedor de camioneta — v16 (sin tabla puente)
export const desvincularVendedor = async (req, res) => {
  const camionetaId = Number(req.params.id);
  if (!Number.isInteger(camionetaId) || camionetaId <= 0) {
    return res.status(400).json({ error: 'camionetaId inválido' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [cam] = await conn.query(
      `SELECT id FROM camionetas WHERE id=? AND activo=1 AND eliminado=0`,
      [camionetaId]
    );
    if (!cam.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Camioneta no encontrada o inactiva' });
    }

    const [upd] = await conn.query(
      `UPDATE vendedores SET camioneta_id = NULL WHERE camioneta_id = ?`,
      [camionetaId]
    );
    if (upd.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'No hay vendedor asignado a esta camioneta.' });
    }

    await conn.commit();
    res.json({ ok: true, mensaje: 'Vendedor desvinculado correctamente.' });
  } catch (err) {
    await conn.rollback();
    console.error('Error al desvincular vendedor:', err);
    res.status(500).json({ error: 'Error al desvincular vendedor' });
  } finally {
    conn.release();
  }
};

// Mantenimientos (sin cambios de seguro)
export const historialAsignaciones = async (req, res) => {
  const { id } = req.params;
  try {
    const [historial] = await db.query(`
      SELECT ha.*, v.id AS id_vendedor, u.nombre AS nombre_vendedor
      FROM historial_asignaciones ha
      LEFT JOIN vendedores v ON ha.vendedor_id = v.id
      LEFT JOIN usuarios u ON v.id_usuario = u.id
      WHERE ha.camioneta_id = ?
      ORDER BY ha.fecha DESC
    `, [id]);
    res.json(historial);
  } catch (err) {
    console.error('Error al consultar historial de asignaciones:', err);
    res.status(500).json({ error: 'Error al consultar historial de asignaciones', detalle: err.sqlMessage });
  }
};

export const historialMantenimientos = async (req, res) => {
  const { id } = req.params;
  try {
    const [mantenimientos] = await db.query(`
      SELECT mc.*, u.nombre AS responsable
      FROM mantenimientos_camionetas mc
      LEFT JOIN usuarios u ON mc.id_usuario = u.id
      WHERE mc.id_camioneta = ?
      ORDER BY mc.fecha DESC
    `, [id]);
    res.json(mantenimientos);
  } catch (err) {
    console.error('Error al consultar historial de mantenimientos:', err);
    res.status(500).json({ error: 'Error al consultar historial de mantenimientos', detalle: err.sqlMessage });
  }
};

export const agregarMantenimiento = async (req, res) => {
  const { id } = req.params;
  const { kilometraje, descripcion, id_usuario, tipo, costo, responsable_externo } = req.body;

  try {
    await db.query(`
      INSERT INTO mantenimientos_camionetas
        (id_camioneta, kilometraje, descripcion, id_usuario, tipo, costo, responsable_externo)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, kilometraje, descripcion, id_usuario, tipo, costo, responsable_externo]);

    await db.query(`
      UPDATE camionetas
      SET ultimo_mantenimiento_km = ?, ultima_fecha_mantenimiento = NOW()
      WHERE id = ? AND (kilometraje_actual >= ? OR ultimo_mantenimiento_km < ?)
    `, [kilometraje, id, kilometraje, kilometraje]);

    res.json({ mensaje: 'Mantenimiento registrado correctamente.' });
  } catch (err) {
    console.error('Error al registrar mantenimiento:', err);
    res.status(500).json({ error: 'Error al registrar mantenimiento', detalle: err.sqlMessage });
  }
};

export const historialKilometrajes = async (req, res) => {
  const { id } = req.params;
  try {
    const [kilometrajes] = await db.query(`
      SELECT * FROM historial_kilometraje
      WHERE id_camioneta = ?
      ORDER BY fecha DESC
    `, [id]);
    res.json(kilometrajes);
  } catch (err) {
    console.error('Error al consultar historial de kilometraje:', err);
    res.status(500).json({ error: 'Error al consultar historial de kilometraje', detalle: err.sqlMessage });
  }
};
