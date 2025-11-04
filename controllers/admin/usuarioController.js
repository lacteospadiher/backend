// controllers/admin/usuarioController.js
import db from '../../config/db.js';
import bcrypt from 'bcryptjs';

/* ============================
   Helpers
============================ */
const obtenerUsuariosPorRol = async (rol_id, extend = false) => {
  if (rol_id === 3 && extend) {
    // Vendedores extendidos
    const [usuarios] = await db.query(
      `SELECT 
          u.id        AS id_usuario,
          v.id        AS id_vendedor,
          u.nombre, 
          u.correo, 
          u.telefono, 
          u.usuario, 
          u.rol_id, 
          u.activo, 
          u.eliminado, 
          u.creado_en,
          c.nombre    AS creado_por_nombre,
          r.nombre    AS creado_por_rol,
          v.id_estado, 
          v.id_municipio, 
          v.camioneta_id,
          e.nombre    AS estado_nombre,
          m.nombre    AS municipio_nombre,
          cam.modelo  AS camioneta_nombre,
          v.pricing_mode
       FROM usuarios u
       LEFT JOIN usuarios c   ON u.creado_por = c.id
       LEFT JOIN roles r      ON c.rol_id     = r.id
       LEFT JOIN vendedores v ON u.id         = v.id_usuario
       LEFT JOIN estados e    ON v.id_estado  = e.id
       LEFT JOIN municipios m ON v.id_municipio = m.id
       LEFT JOIN camionetas cam ON v.camioneta_id = cam.id
       WHERE u.rol_id = 3 AND u.eliminado = 0 AND v.eliminado = 0`
    );
    return usuarios;
  } else {
    const [usuarios] = await db.query(
      `SELECT 
          u.id, u.nombre, u.correo, u.telefono, u.usuario, u.rol_id, u.activo, u.eliminado, u.creado_en,
          c.nombre AS creado_por_nombre,
          r.nombre AS creado_por_rol
       FROM usuarios u
       LEFT JOIN usuarios c ON u.creado_por = c.id
       LEFT JOIN roles r    ON c.rol_id     = r.id
       WHERE u.rol_id = ? AND u.eliminado = 0`,
      [rol_id]
    );
    return usuarios;
  }
};

/* ============================
   Listados por rol
============================ */
export const obtenerAdministradores = async (req, res) => {
  try {
    const usuarios = await obtenerUsuariosPorRol(1);
    res.json(usuarios);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener administradores' });
  }
};

export const obtenerSuperAdmins = async (req, res) => {
  try {
    const usuarios = await obtenerUsuariosPorRol(4);
    res.json(usuarios);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener superadmins' });
  }
};

export const obtenerCargadores = async (req, res) => {
  try {
    const usuarios = await obtenerUsuariosPorRol(2);
    res.json(usuarios);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener cargadores' });
  }
};

export const obtenerVendedores = async (req, res) => {
  try {
    // Devolvemos vendedores extendidos (incluye pricing_mode)
    const [usuarios] = await db.query(
      `SELECT 
          v.id AS id_vendedor,
          u.id AS id_usuario,
          u.nombre, 
          u.correo, 
          u.telefono, 
          u.usuario, 
          u.rol_id, 
          u.activo, 
          u.eliminado, 
          u.creado_en,
          v.id_estado,
          e.nombre AS estado_nombre,
          v.id_municipio,
          m.nombre AS municipio_nombre,
          v.camioneta_id,
          cam.modelo AS camioneta_nombre,
          v.pricing_mode
       FROM vendedores v
       LEFT JOIN usuarios u  ON v.id_usuario   = u.id
       LEFT JOIN estados e   ON v.id_estado    = e.id
       LEFT JOIN municipios m ON v.id_municipio = m.id
       LEFT JOIN camionetas cam ON v.camioneta_id = cam.id
       WHERE u.rol_id = 3 AND u.eliminado = 0 AND v.eliminado = 0`
    );
    res.json(usuarios);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener vendedores', detalle: error.message });
  }
};

export const obtenerVendedoresDisponibles = async (req, res) => {
  try {
    const [vendedores] = await db.query(`
      SELECT v.id, u.nombre
      FROM vendedores v
      INNER JOIN usuarios u ON v.id_usuario = u.id
      WHERE v.eliminado = 0 AND v.activo = 1 AND u.eliminado = 0 AND v.camioneta_id IS NULL
    `);
    res.json(vendedores);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener vendedores disponibles', detalle: error.message });
  }
};

/* ============================
   Crear / Editar / Eliminar / Password
============================ */
export const crearUsuario = async (req, res) => {
  const conn = await db.getConnection();
  try {
    const {
      nombre, correo, telefono, usuario, contrasena, rol_id, admin_id,
      id_estado, id_municipio, camioneta_id, pricing_mode
    } = req.body;

    // Verificación de admin
    const [adminResult] = await conn.query('SELECT rol_id FROM usuarios WHERE id = ?', [admin_id]);
    if (!adminResult.length) {
      conn.release();
      return res.status(401).json({ error: 'Administrador inválido' });
    }
    const rolAdmin = adminResult[0].rol_id;

    // Permisos de creación: solo SuperAdmin puede crear Admins o SuperAdmins
    if ((rol_id == 1 || rol_id == 4) && rolAdmin != 4) {
      conn.release();
      return res.status(403).json({ error: 'Solo el SuperAdministrador puede crear Administradores o SuperAdmins' });
    }

    // Unicidad usuario/correo (solo activos)
    const [existeUsuario] = await conn.query(
      'SELECT id FROM usuarios WHERE (usuario = ? OR correo = ?) AND eliminado = 0',
      [usuario, correo]
    );
    if (existeUsuario.length) {
      conn.release();
      return res.status(400).json({ error: 'El usuario o correo ya existe' });
    }

    const hashedPassword = await bcrypt.hash(contrasena, 10);
    const [userResult] = await conn.query(
      `INSERT INTO usuarios (nombre, correo, telefono, usuario, contrasena, rol_id, activo, eliminado, creado_en, creado_por)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, NOW(), ?)`,
      [nombre, correo, telefono, usuario, hashedPassword, rol_id, admin_id]
    );
    const usuarioId = userResult.insertId;

    if (rol_id == 3) {
      const mode = (pricing_mode === 'mayoreo') ? 'mayoreo' : 'normal';
      await conn.query(
        'INSERT INTO vendedores (id_usuario, id_estado, id_municipio, camioneta_id, pricing_mode, activo, eliminado) VALUES (?, ?, ?, NULL, ?, 1, 0)',
        [usuarioId, id_estado || null, id_municipio || null, mode]
      );
    } else if (rol_id == 2) {
      await conn.query(
        'INSERT INTO cargadores (id_usuario, activo, eliminado) VALUES (?, 1, 0)',
        [usuarioId]
      );
    } else if (rol_id == 5) {
      await conn.query(
        'INSERT INTO devoluciones (id_usuario, activo, eliminado) VALUES (?, 1, 0)',
        [usuarioId]
      ).catch(() => {}); // si no existe la tabla, ignora silenciosamente
    } else if (rol_id == 6) {
      await conn.query(
        'INSERT INTO pedidos_users (id_usuario, activo, eliminado) VALUES (?, 1, 0)',
        [usuarioId]
      ).catch(() => {}); // si no existe la tabla, ignora
    }

    conn.release();
    // Devolvemos el id para que el frontend opcionalmente asigne PIN a cargadores
    res.status(201).json({ mensaje: 'Usuario creado correctamente', id: usuarioId, rol_id });
  } catch (error) {
    if (conn) conn.release();
    console.error('ERROR crearUsuario:', error);
    res.status(500).json({ error: 'Error al crear usuario', detalle: error.message });
  }
};

export const editarUsuario = async (req, res) => {
  const { id } = req.params; // usuarios.id
  const {
    nombre, correo, telefono, usuario,
    rol_id, id_estado, id_municipio, camioneta_id, admin_id, pricing_mode
  } = req.body;
  const conn = await db.getConnection();

  try {
    // ¿Quién ejecuta?
    const [adminResult] = await conn.query('SELECT rol_id FROM usuarios WHERE id = ?', [admin_id]);
    if (!adminResult.length) {
      conn.release();
      return res.status(401).json({ error: 'Administrador inválido' });
    }
    const rolAdmin = adminResult[0].rol_id;

    // Usuario actual
    const [userRows] = await conn.query('SELECT rol_id FROM usuarios WHERE id = ?', [id]);
    if (!userRows.length) {
      conn.release();
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    const rolAnterior = userRows[0].rol_id;

    // Unicidad username/correo
    const [existe] = await conn.query(
      'SELECT id FROM usuarios WHERE (usuario = ? OR correo = ?) AND id != ? AND eliminado = 0',
      [usuario, correo, id]
    );
    if (existe.length) {
      conn.release();
      return res.status(400).json({ error: 'El usuario o correo ya existe en otro usuario' });
    }

    // Permisos: solo SuperAdmin puede crear/editar Admins o SuperAdmins
    if ((rolAnterior == 1 || rol_id == 1 || rolAnterior == 4 || rol_id == 4) && rolAdmin != 4) {
      conn.release();
      return res.status(403).json({ error: 'Solo el SuperAdministrador puede crear/editar Administradores o SuperAdmins' });
    }

    // Update usuarios
    await conn.query(
      `UPDATE usuarios SET nombre=?, correo=?, telefono=?, usuario=?, rol_id=?, actualizado_en=NOW() WHERE id=?`,
      [nombre, correo, telefono, usuario, rol_id, id]
    );

    // Tablas secundarias según rol
    if (rolAnterior != rol_id) {
      if (rolAnterior == 3) await conn.query('DELETE FROM vendedores WHERE id_usuario = ?', [id]);
      if (rolAnterior == 2) await conn.query('DELETE FROM cargadores WHERE id_usuario = ?', [id]);
      if (rolAnterior == 5) await conn.query('DELETE FROM devoluciones WHERE id_usuario = ?', [id]).catch(() => {});
      if (rolAnterior == 6) await conn.query('DELETE FROM pedidos_users WHERE id_usuario = ?', [id]).catch(() => {});

      if (rol_id == 3) {
        const mode = (pricing_mode === 'mayoreo') ? 'mayoreo' : 'normal';
        await conn.query(
          'INSERT INTO vendedores (id_usuario, id_estado, id_municipio, camioneta_id, pricing_mode, activo, eliminado) VALUES (?, ?, ?, ?, ?, 1, 0)',
          [id, id_estado || null, id_municipio || null, camioneta_id || null, mode]
        );
      } else if (rol_id == 2) {
        await conn.query(
          'INSERT INTO cargadores (id_usuario, activo, eliminado) VALUES (?, 1, 0)',
          [id]
        );
      } else if (rol_id == 5) {
        await conn.query(
          'INSERT INTO devoluciones (id_usuario, activo, eliminado) VALUES (?, 1, 0)',
          [id]
        ).catch(() => {});
      } else if (rol_id == 6) {
        await conn.query(
          'INSERT INTO pedidos_users (id_usuario, activo, eliminado) VALUES (?, 1, 0)',
          [id]
        ).catch(() => {});
      }
    } else {
      if (rol_id == 3) {
        const mode = (pricing_mode === 'mayoreo') ? 'mayoreo' : 'normal';
        await conn.query(
          'UPDATE vendedores SET id_estado=?, id_municipio=?, camioneta_id=?, pricing_mode=?, fecha_actualizacion=NOW() WHERE id_usuario=?',
          [id_estado || null, id_municipio || null, camioneta_id || null, mode, id]
        );
      }
    }

    conn.release();
    res.json({ mensaje: 'Usuario actualizado correctamente' });
  } catch (error) {
    if (conn) conn.release();
    console.error('ERROR editarUsuario:', error);
    res.status(500).json({ error: 'Error al editar usuario', detalle: error.message });
  }
};

export const eliminarUsuario = async (req, res) => {
  const { id } = req.params;       // usuarios.id (usuario a eliminar)
  const { admin_id } = req.body;   // quien ejecuta
  const conn = await db.getConnection();

  try {
    if (!admin_id) {
      conn.release();
      return res.status(400).json({ error: 'Falta admin_id' });
    }

    // Datos del admin que ejecuta
    const [[adminRow]] = await conn.query(
      'SELECT id, rol_id FROM usuarios WHERE id = ? AND eliminado = 0',
      [admin_id]
    );
    if (!adminRow) {
      conn.release();
      return res.status(401).json({ error: 'Administrador inválido' });
    }

    // No puedes eliminarte a ti mismo
    if (Number(id) === Number(admin_id)) {
      conn.release();
      return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta.' });
    }

    // Datos del usuario objetivo
    const [[target]] = await conn.query(
      'SELECT id, rol_id, eliminado FROM usuarios WHERE id = ?',
      [id]
    );
    if (!target) {
      conn.release();
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    if (target.eliminado === 1) {
      conn.release();
      return res.status(410).json({ error: 'El usuario ya estaba eliminado' });
    }

    // Permisos: solo SuperAdmin puede eliminar Admins o SuperAdmins
    if ([1, 4].includes(Number(target.rol_id)) && Number(adminRow.rol_id) !== 4) {
      conn.release();
      return res.status(403).json({ error: 'Solo el SuperAdministrador puede eliminar Administradores o SuperAdmins.' });
    }

    // No permitir eliminar al último SuperAdmin
    if (Number(target.rol_id) === 4) {
      const [[countRow]] = await conn.query(
        'SELECT COUNT(*) AS cnt FROM usuarios WHERE rol_id = 4 AND eliminado = 0 AND activo = 1 AND id <> ?',
        [id]
      );
      if (!countRow || Number(countRow.cnt) === 0) {
        conn.release();
        return res.status(400).json({ error: 'No puedes eliminar al último SuperAdministrador.' });
      }
    }

    // Reglas especiales para vendedores
    if (Number(target.rol_id) === 3) {
      const [[vendRow]] = await conn.query(
        'SELECT id, camioneta_id FROM vendedores WHERE id_usuario = ?',
        [id]
      );
      if (vendRow) {
        if (vendRow.camioneta_id) {
          conn.release();
          return res.status(400).json({
            error: 'No puedes eliminar este vendedor porque tiene una camioneta asignada. Desvincúlalo primero.'
          });
        }
        await conn.query('UPDATE vendedores SET camioneta_id = NULL WHERE id = ?', [vendRow.id]);
        await conn.query('UPDATE vendedores SET eliminado = 1, activo = 0 WHERE id = ?', [vendRow.id]);
      }
    }

    // Soft delete del usuario
    const [resU] = await conn.query(
      'UPDATE usuarios SET eliminado = 1, activo = 0, actualizado_en = NOW() WHERE id = ?',
      [id]
    );
    if (!resU.affectedRows) {
      conn.release();
      return res.status(500).json({ error: 'No se pudo eliminar el usuario' });
    }

    conn.release();
    return res.json({ mensaje: 'Usuario eliminado correctamente' });
  } catch (error) {
    if (conn) conn.release();
    console.error('ERROR eliminando usuario:', error);
    return res.status(500).json({ error: 'Error al eliminar usuario', detalle: error.message });
  }
};

export const cambiarContrasena = async (req, res) => {
  const { id } = req.params; // usuarios.id
  const { nuevaContrasena, contrasenaAdmin, admin_id } = req.body;

  try {
    const [adminData] = await db.query('SELECT contrasena, rol_id FROM usuarios WHERE id = ?', [admin_id]);
    if (!adminData.length) return res.status(401).json({ error: 'Administrador inválido' });

    const [target] = await db.query('SELECT rol_id FROM usuarios WHERE id = ?', [id]);
    if (target.length && (target[0].rol_id == 1 || target[0].rol_id == 4) && adminData[0].rol_id != 4) {
      return res.status(403).json({ error: 'Solo el SuperAdministrador puede cambiar contraseñas de administradores o superadmins' });
    }

    const match = await bcrypt.compare(contrasenaAdmin, adminData[0].contrasena);
    if (!match) return res.status(403).json({ error: 'Contraseña de administrador incorrecta' });

    const hashedPassword = await bcrypt.hash(nuevaContrasena, 10);
    await db.query('UPDATE usuarios SET contrasena = ?, actualizado_en = NOW() WHERE id = ?', [hashedPassword, id]);

    res.json({ mensaje: 'Contraseña actualizada correctamente' });
  } catch (error) {
    res.status(500).json({ error: 'Error al cambiar contraseña' });
  }
};

/* ============================
   Pricing mode: PATCH rápido
============================ */
export const actualizarVendedorPricingMode = async (req, res) => {
  try {
    const { id } = req.params; // vendedores.id
    const { pricing_mode } = req.body;
    if (!['normal','mayoreo'].includes(pricing_mode)) {
      return res.status(400).json({ error: 'pricing_mode inválido' });
    }
    const [r] = await db.query(
      `UPDATE vendedores SET pricing_mode=?, fecha_actualizacion=NOW() WHERE id=? AND eliminado=0`,
      [pricing_mode, id]
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Vendedor no encontrado' });
    res.json({ ok: true, mensaje: 'Modo de precio actualizado', pricing_mode });
  } catch (e) {
    console.error('actualizarVendedorPricingMode', e);
    res.status(500).json({ error: 'Error al actualizar modo de precio' });
  }
};

/* ============================
   Devoluciones / Pedidos (roles 5 y 6)
============================ */
export const obtenerDevoluciones = async (req, res) => {
  try {
    const usuarios = await obtenerUsuariosPorRol(5); // rol 5 = Devoluciones
    res.json(usuarios);
  } catch (error) {
    console.error('obtenerDevoluciones', error);
    res.status(500).json({ error: 'Error al obtener usuarios de Devoluciones' });
  }
};

export const obtenerPedidos = async (req, res) => {
  try {
    const usuarios = await obtenerUsuariosPorRol(6); // rol 6 = Pedidos
    res.json(usuarios);
  } catch (error) {
    console.error('obtenerPedidos', error);
    res.status(500).json({ error: 'Error al obtener usuarios de Pedidos' });
  }
};

/**
 * Crear usuario de Devoluciones (rol 5)
 * Campos: mismos que Cargador, pero SIN PIN.
 */
export const crearUsuarioDevoluciones = async (req, res) => {
  try {
    req.body = { ...req.body, rol_id: 5 };
    if ('pin' in req.body) delete req.body.pin;
    return crearUsuario(req, res);
  } catch (error) {
    console.error('crearUsuarioDevoluciones', error);
    res.status(500).json({ error: 'Error al crear usuario de Devoluciones' });
  }
};

/**
 * Crear usuario de Pedidos (rol 6)
 * Campos: mismos que Cargador, pero SIN PIN.
 */
export const crearUsuarioPedidos = async (req, res) => {
  try {
    req.body = { ...req.body, rol_id: 6 };
    if ('pin' in req.body) delete req.body.pin;
    return crearUsuario(req, res);
  } catch (error) {
    console.error('crearUsuarioPedidos', error);
    res.status(500).json({ error: 'Error al crear usuario de Pedidos' });
  }
};

/**
 * Editar usuario de Devoluciones / Pedidos (wrappers)
 */
export const editarUsuarioDevoluciones = async (req, res) => {
  return editarUsuario(req, res);
};

export const editarUsuarioPedidos = async (req, res) => {
  return editarUsuario(req, res);
};

/**
 * Eliminar (soft delete) usuario de Devoluciones / Pedidos (wrappers)
 */
export const eliminarUsuarioDevoluciones = async (req, res) => {
  return eliminarUsuario(req, res);
};

export const eliminarUsuarioPedidos = async (req, res) => {
  return eliminarUsuario(req, res);
};
