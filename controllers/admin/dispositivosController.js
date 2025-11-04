// controllers/admin/dispositivosController.js
import db from '../../config/db.js';

// === Helpers ===
const ALLOWED_ROLES_FOR_ANY = new Set(['Vendedor','Cargador','Devoluciones','Pedidos']);
const ROLE_FOR_CEL = new Set(['Vendedor']);
const ROLES_FOR_TAB = new Set(['Cargador','Devoluciones','Pedidos']);

const assert = (cond, msg = 'Solicitud inválida', status = 400) => {
  if (!cond) {
    const err = new Error(msg);
    err.status = status;
    throw err;
  }
};

const isPrinter = (t) => ['IMP-T','IMP-C','IMP-CE'].includes(t);
const isMaster  = (t) => t === 'CEL' || t === 'TAB';

// Convención de actualización de campos de texto plano:
// undefined -> mantener; "" -> borrar (NULL); string -> establecer
function normalizePlainInput(v) {
  if (v === undefined) return { mode: 'keep' };
  if (v === '') return { mode: 'clear' };
  return { mode: 'set', value: String(v) };
}

const mapLike = (q) => `%${q}%`;

// Carga detalle del dispositivo con:
// - asignación actual (si existe)
// - impresoras vinculadas (si es CEL/TAB) o, si es impresora, a qué master está ligada
export async function getDispositivoById(req, res) {
  try {
    const { id } = req.params;

    const [rows] = await db.query(
      `
      SELECT
        d.id, d.codigo, d.tipo_codigo, d.marca, d.modelo, d.numero_serie,
        d.imei1, d.imei2, d.numero_linea,
        d.correo_login, d.password_login, d.password_dispositivo,
        d.creado_en, d.actualizado_en,
        a.usuario_id, u.nombre AS usuario_nombre, a.fecha_entrega, a.estado AS estado_asignacion
      FROM dispositivos d
      LEFT JOIN dispositivos_asignaciones a
        ON a.dispositivo_id = d.id
       AND a.estado='asignado'
       AND a.fecha_devolucion IS NULL
      LEFT JOIN usuarios u ON u.id = a.usuario_id
      WHERE d.id = ?
      `,
      [id]
    );
    assert(rows.length, 'Dispositivo no encontrado', 404);
    const disp = rows[0];

    // Impresoras vinculadas a este master
    let impresoras = [];
    if (isMaster(disp.tipo_codigo)) {
      const [imp] = await db.query(
        `
        SELECT di.id, di.codigo, di.tipo_codigo, di.marca, di.modelo, di.numero_serie
        FROM dispositivos_vinculos v
        JOIN dispositivos di ON di.id = v.impresora_id
        WHERE v.principal_id = ?
        ORDER BY di.codigo
        `,
        [id]
      );
      impresoras = imp;
    }

    // Si es impresora, ver contra qué principal está vinculada
    let principal = null;
    if (isPrinter(disp.tipo_codigo)) {
      const [pri] = await db.query(
        `
        SELECT p.id, p.codigo, p.tipo_codigo, p.marca, p.modelo
        FROM dispositivos_vinculos v
        JOIN dispositivos p ON p.id = v.principal_id
        WHERE v.impresora_id = ?
        `,
        [id]
      );
      principal = pri[0] ?? null;
    }

    res.json({ dispositivo: disp, impresoras, principal });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}

// Listado (con filtros y paginado) + asignación + impresoras
export async function listarDispositivos(req, res) {
  try {
    const {
      search = '',
      tipo,               // 'CEL' | 'TAB' | 'IMP' | 'IMP-T' | 'IMP-C' | 'IMP-CE'
      asignados,          // '1' (solo asignados) | '0' (solo no asignados)
      libres,             // '1' => impresoras no vinculadas
      page = 1,
      pageSize = 20
    } = req.query;

    const p = Number(page) > 0 ? Number(page) : 1;
    const ps = Math.min(Math.max(Number(pageSize) || 20, 1), 100);

    const where = [];
    const params = [];

    // Búsqueda libre (incluye credenciales en texto plano)
    if (search) {
      where.push(`(
        d.codigo LIKE ? OR d.marca LIKE ? OR d.modelo LIKE ? OR d.numero_serie LIKE ?
        OR d.imei1 LIKE ? OR d.numero_linea LIKE ?
        OR d.correo_login LIKE ? OR d.password_login LIKE ? OR d.password_dispositivo LIKE ?
      )`);
      const s = `%${search}%`;
      params.push(s, s, s, s, s, s, s, s, s);
    }

    // Filtro por tipo (incluye agrupado IMP)
    if (tipo === 'IMP') {
      where.push(`d.tipo_codigo IN ('IMP-T','IMP-C','IMP-CE')`);
    } else if (tipo) {
      where.push(`d.tipo_codigo = ?`);
      params.push(tipo);
    }

    // Filtro de asignación (solo aplica a CEL/TAB; pero no estorba si está para impresoras)
    if (asignados === '1') {
      where.push(`a.estado='asignado' AND a.fecha_devolucion IS NULL`);
    } else if (asignados === '0') {
      where.push(`(a.id IS NULL OR a.estado<>'asignado' OR a.fecha_devolucion IS NOT NULL)`);
    }

    // Impresoras libres (no vinculadas a ningún master)
    if (String(libres) === '1') {
      where.push(`d.id NOT IN (SELECT dv.impresora_id FROM dispositivos_vinculos dv)`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Total
    const [[{ total }]] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM dispositivos d
      LEFT JOIN dispositivos_asignaciones a
        ON a.dispositivo_id = d.id
       AND a.estado='asignado'
       AND a.fecha_devolucion IS NULL
      ${whereSql}
      `,
      params
    );

    // Page
    const [rows] = await db.query(
      `
      SELECT
        d.id, d.codigo, d.tipo_codigo, d.marca, d.modelo, d.numero_serie, d.imei1, d.numero_linea,
        d.correo_login, d.password_login, d.password_dispositivo,
        a.usuario_id, u.nombre AS usuario_nombre, a.fecha_entrega
      FROM dispositivos d
      LEFT JOIN dispositivos_asignaciones a
        ON a.dispositivo_id = d.id
       AND a.estado='asignado'
       AND a.fecha_devolucion IS NULL
      LEFT JOIN usuarios u ON u.id = a.usuario_id
      ${whereSql}
      ORDER BY d.creado_en DESC, d.id DESC
      LIMIT ${ps} OFFSET ${(p - 1) * ps}
      `,
      params
    );

    // Para CEL/TAB, adjuntamos impresoras vinculadas
    const masterIds = rows.filter(r => isMaster(r.tipo_codigo)).map(r => r.id);
    let impresorasPorMaster = {};
    if (masterIds.length) {
      const [imps] = await db.query(
        `
        SELECT v.principal_id, di.id, di.codigo, di.tipo_codigo, di.marca, di.modelo
        FROM dispositivos_vinculos v
        JOIN dispositivos di ON di.id = v.impresora_id
        WHERE v.principal_id IN (${masterIds.map(() => '?').join(',')})
        ORDER BY di.codigo
        `,
        masterIds
      );
      for (const row of imps) {
        if (!impresorasPorMaster[row.principal_id]) impresorasPorMaster[row.principal_id] = [];
        impresorasPorMaster[row.principal_id].push({
          id: row.id, codigo: row.codigo, tipo_codigo: row.tipo_codigo, marca: row.marca, modelo: row.modelo
        });
      }
    }

    const data = rows.map(r => ({
      ...r,
      impresoras: impresorasPorMaster[r.id] ?? []
    }));

    res.json({ total, page: p, pageSize: ps, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}


// Crear dispositivo (CEL/TAB/IMP-*) — con coerción de IMEIs/línea/serie según tipo
export async function crearDispositivo(req, res) {
  try {
    const {
      tipo_codigo,        // 'CEL'|'TAB'|'IMP-T'|'IMP-C'|'IMP-CE'
      marca,
      modelo,
      numero_serie = null,
      imei1 = null,
      imei2 = null,
      numero_linea = null,
      correo_login = null,
      password_login = null,
      password_dispositivo = null
    } = req.body;

    assert(tipo_codigo, 'tipo_codigo es requerido');
    assert(marca && modelo, 'marca y modelo son requeridos');

    // Normalización de campos según tipo
    let nSerie = numero_serie;
    let nImei1 = imei1;
    let nImei2 = imei2;
    let nLinea = numero_linea;

    if (tipo_codigo === 'TAB') {
      // Tablets: sin IMEIs ni línea (serie opcional)
      nImei1 = null; nImei2 = null; nLinea = null;
    } else if (isPrinter(tipo_codigo)) {
      // Impresoras: sin serie ni IMEIs ni línea
      nSerie = null; nImei1 = null; nImei2 = null; nLinea = null;
    }
    const esMaster = isMaster(tipo_codigo);

    const [result] = await db.query(
      `
      INSERT INTO dispositivos
        (tipo_codigo, marca, modelo, numero_serie, imei1, imei2, numero_linea,
         correo_login, password_login, password_dispositivo)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      `,
      [
        tipo_codigo, marca, modelo, nSerie, nImei1, nImei2, nLinea,
        esMaster ? (correo_login ?? null) : null,
        esMaster ? (password_login ?? null) : null,
        esMaster ? (password_dispositivo ?? null) : null
      ]
    );

    const id = result.insertId;
    const [created] = await db.query(`SELECT * FROM dispositivos WHERE id = ?`, [id]);
    res.status(201).json(created[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// Actualizar dispositivo — maneja credenciales EN CLARO (set/clear/keep)
// y obliga NULL en IMEIs/línea/serie para TAB/IMP
export async function actualizarDispositivo(req, res) {
  try {
    const { id } = req.params;
    const {
      marca,
      modelo,
      numero_serie = null,
      imei1 = null,
      imei2 = null,
      numero_linea = null,
      correo_login,
      password_login,
      password_dispositivo
    } = req.body;

    const [[exists]] = await db.query(`SELECT id, tipo_codigo FROM dispositivos WHERE id = ?`, [id]);
    assert(exists, 'Dispositivo no encontrado', 404);

    const correoNorm = normalizePlainInput(correo_login);
    const passLoginNorm = normalizePlainInput(password_login);
    const passDispNorm  = normalizePlainInput(password_dispositivo);

    const sets = [
      `marca = COALESCE(?, marca)`,
      `modelo = COALESCE(?, modelo)`
    ];
    const params = [marca, modelo];

    // Campos de identificación según tipo
    if (exists.tipo_codigo === 'CEL') {
      // Celulares: permiten todo
      sets.push(`numero_serie = ?`, `imei1 = ?`, `imei2 = ?`, `numero_linea = ?`);
      params.push(numero_serie, imei1, imei2, numero_linea);
    } else if (exists.tipo_codigo === 'TAB') {
      // Tablets: serie opcional, PERO IMEIs y línea forzados a NULL
      sets.push(`numero_serie = ?`, `imei1 = NULL`, `imei2 = NULL`, `numero_linea = NULL`);
      params.push(numero_serie);
    } else if (isPrinter(exists.tipo_codigo)) {
      // Impresoras: serie/IMEIs/línea forzados a NULL
      sets.push(`numero_serie = NULL`, `imei1 = NULL`, `imei2 = NULL`, `numero_linea = NULL`);
    }

    // Credenciales: solo no-impresoras (masters)
    if (!isPrinter(exists.tipo_codigo)) {
      if (correoNorm.mode === 'set')   { sets.push(`correo_login = ?`); params.push(correoNorm.value); }
      else if (correoNorm.mode === 'clear') { sets.push(`correo_login = NULL`); }

      if (passLoginNorm.mode === 'set') { sets.push(`password_login = ?`); params.push(passLoginNorm.value); }
      else if (passLoginNorm.mode === 'clear') { sets.push(`password_login = NULL`); }

      if (passDispNorm.mode === 'set')  { sets.push(`password_dispositivo = ?`); params.push(passDispNorm.value); }
      else if (passDispNorm.mode === 'clear') { sets.push(`password_dispositivo = NULL`); }
    } else {
      // Blindaje extra para impresoras
      sets.push(`correo_login = NULL`, `password_login = NULL`, `password_dispositivo = NULL`);
    }

    await db.query(`UPDATE dispositivos SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);

    const [row] = await db.query(`SELECT * FROM dispositivos WHERE id = ?`, [id]);
    res.json(row[0]);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}

// Eliminar dispositivo (duro). Opcional: bloquear si tiene asignación vigente
export async function eliminarDispositivo(req, res) {
  try {
    const { id } = req.params;
    const [[{ cnt }]] = await db.query(
      `SELECT COUNT(*) AS cnt
       FROM dispositivos_asignaciones
       WHERE dispositivo_id = ? AND estado='asignado' AND fecha_devolucion IS NULL`,
      [id]
    );
    assert(cnt === 0, 'No puedes eliminar un dispositivo con asignación vigente', 409);
    await db.query(`DELETE FROM dispositivos WHERE id = ?`, [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}

// Asignar dispositivo CEL/TAB a usuario por regla de rol (usa SP + validación previa)
export async function asignarDispositivo(req, res) {
  try {
    const { id } = req.params; // dispositivo_id
    const { usuario_id, observaciones = null } = req.body;
    assert(usuario_id, 'usuario_id requerido');

    // Carga tipo de dispositivo
    const [[disp]] = await db.query(`SELECT id, tipo_codigo FROM dispositivos WHERE id = ?`, [id]);
    assert(disp, 'Dispositivo no encontrado', 404);

    // Carga rol del usuario
    const [[usr]] = await db.query(
      `SELECT u.id, r.nombre AS rol
         FROM usuarios u
         JOIN roles r ON r.id = u.rol_id
        WHERE u.id = ? AND u.eliminado = 0 AND u.activo = 1`,
      [usuario_id]
    );
    assert(usr, 'Usuario no elegible', 400);
    assert(ALLOWED_ROLES_FOR_ANY.has(usr.rol), 'Solo Vendedor/Cargador/Devoluciones/Pedidos pueden recibir dispositivos', 400);

    if (disp.tipo_codigo === 'CEL') {
      assert(ROLE_FOR_CEL.has(usr.rol), 'CEL solo puede asignarse a Vendedor', 400);
    } else if (disp.tipo_codigo === 'TAB') {
      assert(ROLES_FOR_TAB.has(usr.rol), 'TAB solo puede asignarse a Cargador/Devoluciones/Pedidos', 400);
    } else {
      assert(false, 'Las impresoras no se asignan a usuarios. Se vinculan a un CEL/TAB.', 400);
    }

    // Llama SP que respeta unicidad y corta vínculos cuando corresponde
    await db.query(`CALL sp_asignar_dispositivo(?,?,?)`, [id, usuario_id, observaciones]);

    // Responder con estado actual
    return getDispositivoById(req, res);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}

// Devolver (cerrar asignación vigente)
export async function devolverDispositivo(req, res) {
  try {
    const { id } = req.params;

    const [open] = await db.query(
      `SELECT id
         FROM dispositivos_asignaciones
        WHERE dispositivo_id = ?
          AND estado='asignado'
          AND fecha_devolucion IS NULL
        ORDER BY fecha_entrega DESC
        LIMIT 1`,
      [id]
    );
    assert(open.length, 'No hay asignación abierta para este dispositivo', 409);

    await db.query(
      `UPDATE dispositivos_asignaciones
          SET estado='devuelto', fecha_devolucion = NOW()
        WHERE id = ?`,
      [open[0].id]
    );

    // Trigger AU ya rompe vínculos de impresoras si aplica
    return getDispositivoById(req, res);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}

// Vincular impresora a un master (CEL/TAB)
export async function vincularImpresora(req, res) {
  try {
    const { id } = req.params; // principal_id (CEL/TAB)
    const { impresora_id } = req.body;
    assert(impresora_id, 'impresora_id requerido');

    const [[master]] = await db.query(`SELECT id, tipo_codigo FROM dispositivos WHERE id = ?`, [id]);
    assert(master, 'Master no encontrado', 404);
    assert(isMaster(master.tipo_codigo), 'Solo CEL/TAB pueden ser master de impresoras', 400);

    const [[imp]] = await db.query(`SELECT id, tipo_codigo FROM dispositivos WHERE id = ?`, [impresora_id]);
    assert(imp, 'Impresora no encontrada', 404);
    assert(isPrinter(imp.tipo_codigo), 'Solo impresoras pueden vincularse', 400);

    // Validación de compatibilidad (también valida el trigger)
    if (imp.tipo_codigo === 'IMP-T') {
      assert(master.tipo_codigo === 'TAB', 'IMP-T solo puede vincularse a TAB', 400);
    } else {
      assert(master.tipo_codigo === 'CEL', 'IMP-C/IMP-CE solo pueden vincularse a CEL', 400);
    }

    // Un impresora -> un vínculo único (ux_vinculo_impresora)
    // Si ya tenía, MySQL tirará error. Podemos intentar idempotencia:
    await db.query(
      `INSERT INTO dispositivos_vinculos (impresora_id, principal_id)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE principal_id = VALUES(principal_id)`,
      [impresora_id, id]
    );

    return getDispositivoById(req, res);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}

// Desvincular impresora
export async function desvincularImpresora(req, res) {
  try {
    const { id, impresoraId } = req.params; // principal_id, impresora
    await db.query(
      `DELETE FROM dispositivos_vinculos WHERE principal_id = ? AND impresora_id = ?`,
      [id, impresoraId]
    );
    return getDispositivoById(req, res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// Usuarios elegibles para asignación según tipo de master
export async function listarUsuariosElegibles(req, res) {
  try {
    const { para } = req.query; // 'CEL' | 'TAB'
    assert(para === 'CEL' || para === 'TAB', 'para debe ser CEL o TAB');

    let rolFiltro;
    if (para === 'CEL') {
      rolFiltro = ['Vendedor'];
    } else {
      rolFiltro = ['Cargador','Devoluciones','Pedidos'];
    }

    const [rows] = await db.query(
      `
      SELECT u.id, u.nombre, u.usuario, r.nombre AS rol
      FROM usuarios u
      JOIN roles r ON r.id = u.rol_id
      WHERE u.activo=1 AND u.eliminado=0
        AND r.nombre IN (${rolFiltro.map(() => '?').join(',')})
      ORDER BY r.nombre, u.nombre
      `,
      rolFiltro
    );
    res.json(rows);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
