// controllers/vendedor/agregarClienteController.js
import db from '../../config/db.js';

/* =========================
   Utilidades generales
   ========================= */
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ123456789';
const randQR = (len = 8) =>
  Array.from({ length: len }, () => ABC[Math.floor(Math.random() * ABC.length)]).join('');

/** Normaliza texto genérico (trim) */
const norm = (v) => (v ?? '').toString().trim();
/** Normaliza para comparar claves: minúsculas y colapsa espacios */
const normKey = (v) => norm(v).toLowerCase().replace(/\s+/g, ' ');

function getUsuarioId(req) {
  return Number(req.user?.id ?? req.body?.usuarioId ?? req.query?.usuarioId) || null;
}

/** 1..7 -> 'Lunes'..'Domingo' */
const dayName = (d) => ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'][d - 1];

/** YYYY-MM-DD -> 1..7 (Lun..Dom) */
const dow1_7 = (fecha) => {
  const d = new Date(`${fecha.slice(0, 10)}T00:00:00`);
  const js = d.getDay(); // 0..6 (Dom..Sáb)
  return js === 0 ? 7 : js;
};

/** Normaliza a YYYY-MM-DD */
const toYMD = (fecha) => {
  if (fecha instanceof Date) return fecha.toISOString().slice(0, 10);
  if (typeof fecha === 'string') return fecha.slice(0, 10);
  const d = new Date(fecha);
  return d.toISOString().slice(0, 10);
};

/**
 * Asegura Estado y Municipio con soporte a UNIQUE
 * Requiere UNIQUE: estados(nombre), municipios(nombre, estado_id)
 */
async function ensureEstadoMunicipio(conn, estadoNombre, municipioNombre) {
  const estado = norm(estadoNombre);
  const municipio = norm(municipioNombre);
  if (!estado || !municipio) return { id_estado: null, id_municipio: null };

  await conn.query(
    `INSERT INTO estados (nombre, activo)
     VALUES (?, 1)
     ON DUPLICATE KEY UPDATE
       id = LAST_INSERT_ID(id),
       activo = VALUES(activo)`,
    [estado]
  );
  const [[eId]] = await conn.query('SELECT LAST_INSERT_ID() AS id');
  const idEstado = Number(eId.id);

  await conn.query(
    `INSERT INTO municipios (nombre, estado_id, activo)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE
       id = LAST_INSERT_ID(id),
       activo = VALUES(activo)`,
    [municipio, idEstado]
  );
  const [[mId]] = await conn.query('SELECT LAST_INSERT_ID() AS id');
  const idMunicipio = Number(mId.id);

  return { id_estado: idEstado, id_municipio: idMunicipio };
}

export async function getVendedorIdByUsuario(conn, usuarioId) {
  const [[row]] = await conn.query(
    'SELECT id FROM vendedores WHERE id_usuario=? LIMIT 1',
    [usuarioId]
  );
  return row?.id || null;
}

// Mapa nombres de días -> 1..7 (Lun..Dom)
const MAP_DIA = {
  lunes: 1,
  martes: 2,
  miércoles: 3,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sábado: 6,
  sabado: 6,
  domingo: 7
};

/** Asegura plantilla activa y retorna su id */
async function ensurePlantillaActiva(conn, id_vendedor) {
  const [[p]] = await conn.query(
    `SELECT id FROM plantillas_ruta WHERE id_vendedor=? AND activo=1 LIMIT 1`,
    [id_vendedor]
  );
  if (p) return p.id;
  const [ins] = await conn.query(
    `INSERT INTO plantillas_ruta (id_vendedor, nombre, activo) VALUES (?,?,1)`,
    [id_vendedor, 'Default']
  );
  return ins.insertId;
}

/** Valida exclusividad: cliente NO debe estar en otra plantilla ACTIVA el mismo día */
async function clienteDisponibleParaDia(conn, id_cliente, dia_semana, vendedor_actual_id = null) {
  const [rows] = await conn.query(
    `SELECT pr.id AS plantilla_id, v.id AS vendedor_id, u.nombre AS vendedor_nombre
       FROM plantilla_ruta_clientes prc
       JOIN plantillas_ruta pr ON pr.id = prc.id_plantilla AND pr.activo=1
       JOIN vendedores v  ON v.id = pr.id_vendedor
       JOIN usuarios  u  ON u.id = v.id_usuario
      WHERE prc.id_cliente=? AND prc.dia_semana=?`,
    [id_cliente, dia_semana]
  );
  if (!rows.length) return { ok: true };
  const conflict = rows.find((r) =>
    vendedor_actual_id ? r.vendedor_id !== Number(vendedor_actual_id) : true
  );
  if (conflict) {
    return {
      ok: false,
      conflicto: { vendedor_otro: conflict.vendedor_nombre, plantilla_id: conflict.plantilla_id }
    };
  }
  return { ok: true };
}

/** Crea (si falta) la ruta del vendedor para la fecha dada y devuelve id */
async function ensureRutaDiaria(conn, id_vendedor, fechaYMD) {
  await conn.query(
    `INSERT IGNORE INTO rutas_diarias (id_vendedor, fecha, estado, regreso_confirmado)
     VALUES (?,?, 'programada', 0)`,
    [id_vendedor, fechaYMD]
  );
  const [[r0]] = await conn.query(
    `SELECT id FROM rutas_diarias WHERE id_vendedor=? AND fecha=? LIMIT 1`,
    [id_vendedor, fechaYMD]
  );
  return r0?.id;
}

/* =========================
   Soporte de Cadenas
   ========================= */
// Catálogo de cadenas soportadas -> etiqueta canónica
const CADENAS_CANON = {
  'bara': 'Bara',
  'carnemart': 'CarneMart',
  'carne mart': 'CarneMart',
  'ahorramax': 'Ahorramax',
  'ahorra max': 'Ahorramax',
};

/* Decide palabra 'normal' | 'cadena' usando tipo_cliente y/o cadena */
function toTipoClienteWord(rawTipoCliente, cadenaRaw) {
  const v = normKey(rawTipoCliente);
  const cadKey = normKey(cadenaRaw);
  if (['c', 'cadena', '1', 'true', 'sí', 'si'].includes(v)) return 'cadena';
  if (['n', 'normal', '0', 'false'].includes(v)) return 'normal';
  if (CADENAS_CANON[cadKey]) return 'cadena';
  return 'normal';
}
function toTipoClienteDb(word) {
  return word === 'cadena' ? 'C' : 'N';
}
/* Devuelve 'Bara' | 'CarneMart' | 'Ahorramax' | null */
function sanitizeCadena(cadenaRaw, tipoWord) {
  if (tipoWord !== 'cadena') return null;
  const key = normKey(cadenaRaw);
  return CADENAS_CANON[key] || null;
}

/* =========================
   POST /api/vendedor/clientes/crear
   ========================= */
export async function crearCliente(req, res) {
  const conn = await db.getConnection();
  try {
    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(400).json({ ok: false, msg: 'Falta usuario (JWT)' });

    const nombre = norm(req.body?.nombre);
    const telefono = norm(req.body?.telefono);
    const correo = norm(req.body?.correo);
    const direccion = req.body?.direccion || {};
    const calle = norm(direccion.calle);
    const colonia = norm(direccion.colonia);
    const cp = norm(direccion.codigoPostal);
    const estadoN = norm(direccion.estado);
    const muniN = norm(direccion.municipio);

    // === tipo_cliente / cadena (con Ahorramax) ===
    const cadenaRaw = norm(req.body?.cadena);
    const tipoClienteRaw = norm(req.body?.tipo_cliente); // 'C'|'N'|'cadena'|'normal'|1|0|true|false
    const tipoWord = toTipoClienteWord(tipoClienteRaw, cadenaRaw); // 'normal' | 'cadena'
    const tipoDb = toTipoClienteDb(tipoWord);                      // 'N' | 'C'
    const cadena = sanitizeCadena(cadenaRaw, tipoWord);            // 'Bara'|'CarneMart'|'Ahorramax'|null

    let diasVisita = Array.isArray(req.body?.diasVisita) ? req.body.diasVisita : [];
    const ubic = req.body?.ubicacion || {};
    const lat = Number(ubic.lat ?? null);
    const lng = Number(ubic.lng ?? null);

    const reqFactura = Number.isFinite(Number(req.body?.requiereFactura))
      ? (Number(req.body.requiereFactura) ? 1 : 0)
      : 0;

    let codigoQR = norm(req.body?.codigoQR) || randQR(8);

    if (!nombre || !telefono || !calle || !colonia || !cp || !estadoN || !muniN) {
      return res.status(400).json({ ok: false, msg: 'Campos obligatorios incompletos' });
    }

    await conn.beginTransaction();

    // Estado/Municipio
    const { id_estado, id_municipio } = await ensureEstadoMunicipio(conn, estadoN, muniN);

    // Evitar colisión QR (hasta 3 intentos)
    for (let i = 0; i < 3; i++) {
      const [[ex]] = await conn.query('SELECT id FROM clientes WHERE codigo_qr=? LIMIT 1', [codigoQR]);
      if (!ex) break;
      codigoQR = randQR(8 + i);
    }

    // Insert cliente (ajustado al esquema de tu tabla)
    const [ins] = await conn.query(
      `INSERT INTO clientes
       (id_usuario_creador, nombre_empresa, telefono, correo,
        calle_numero, colonia, codigo_postal,
        latitud, longitud,
        id_estado, id_municipio,
        permite_credito, requiere_factura, dias_credito,
        limite_credito_monto, limite_creditos_abiertos,
        codigo_qr, clave,
        activo, tipo_cliente, cadena, pricing_mode,
        eliminado, fecha_registro, fecha_actualizacion)
       VALUES (?,?,?,?, ?,?,?, ?,?, ?,?, ?,?, ?, ?, ?, ?, NULL,
               1, ?, ?, 'normal',
               0, NOW(), NOW())`,
      [
        usuarioId,
        nombre,
        telefono,
        correo || null,

        calle,
        colonia,
        cp,

        Number.isFinite(lat) ? lat : null,
        Number.isFinite(lng) ? lng : null,

        id_estado,
        id_municipio,

        0,                // permite_credito
        reqFactura,
        null,             // dias_credito
        null,             // limite_credito_monto
        null,             // limite_creditos_abiertos

        codigoQR,
        // clave -> NULL, se setea abajo
        tipoDb,                          // 'C' | 'N'
        tipoDb === 'C' ? cadena : null   // 'Bara'|'CarneMart'|'Ahorramax'|null
      ]
    );
    const clienteId = ins.insertId;

    // Clave tipo CLI-000001
    await conn.query(
      'UPDATE clientes SET clave = CONCAT("CLI-", LPAD(?, 6, "0")), fecha_actualizacion=NOW() WHERE id = ?',
      [clienteId, clienteId]
    );

    // Vendedor asociado
    const vendedorId = await getVendedorIdByUsuario(conn, usuarioId);

    // Si no mandan días de visita, se usa HOY (solo para asignación en rutas)
    if (!diasVisita.length) {
      const hoy = new Date();
      const ymd = hoy.toISOString().slice(0, 10);
      const dia = dow1_7(ymd);
      diasVisita = [dayName(dia).toLowerCase()];
    }

    // 1) Plantilla por días de visita con validación cross-vendedor
    if (vendedorId && diasVisita.length) {
      const plantillaId = await ensurePlantillaActiva(conn, vendedorId);

      for (const d of diasVisita) {
        const key = normKey(d);
        const dia = MAP_DIA[key];
        if (!dia) continue;

        const disp = await clienteDisponibleParaDia(conn, clienteId, dia, vendedorId);
        if (!disp.ok) {
          await conn.rollback();
          return res.status(409).json({
            ok: false,
            msg: `El cliente ya está asignado los ${dayName(dia)} con ${disp.conflicto.vendedor_otro}`
          });
        }

        const [[dup]] = await conn.query(
          `SELECT id FROM plantilla_ruta_clientes
           WHERE id_plantilla=? AND dia_semana=? AND id_cliente=? LIMIT 1`,
          [plantillaId, dia, clienteId]
        );
        if (dup) continue;

        const [[ord]] = await conn.query(
          `SELECT COALESCE(MAX(orden),0)+1 AS nextOrden
           FROM plantilla_ruta_clientes
           WHERE id_plantilla=? AND dia_semana=?`,
          [plantillaId, dia]
        );
        const nextOrden = Number(ord?.nextOrden || 1);

        await conn.query(
          `INSERT INTO plantilla_ruta_clientes (id_plantilla, dia_semana, id_cliente, orden)
           VALUES (?, ?, ?, ?)`,
          [plantillaId, dia, clienteId, nextOrden]
        );
      }
    }

    // 2) Agregar SIEMPRE a la ruta de HOY del vendedor (si hay vendedor)
    if (vendedorId) {
      const hoy = toYMD(new Date());
      const dia = dow1_7(hoy);

      const disp = await clienteDisponibleParaDia(conn, clienteId, dia, vendedorId);
      if (!disp.ok) {
        await conn.rollback();
        return res.status(409).json({
          ok: false,
          msg: `El cliente ya está asignado los ${dayName(dia)} con ${disp.conflicto.vendedor_otro}`
        });
      }

      const rutaId = await ensureRutaDiaria(conn, vendedorId, hoy);

      const [[ya]] = await conn.query(
        `SELECT id FROM rutas_clientes WHERE id_ruta=? AND id_cliente=? LIMIT 1`,
        [rutaId, clienteId]
      );
      if (!ya) {
        const [[mx]] = await conn.query(
          `SELECT IFNULL(MAX(orden),0) AS m FROM rutas_clientes WHERE id_ruta=?`,
          [rutaId]
        );
        const ord = Number(mx?.m || 0) + 1;

        await conn.query(
          `INSERT INTO rutas_clientes (id_ruta, id_cliente, orden) VALUES (?,?,?)`,
          [rutaId, clienteId, ord]
        );
        await conn.query(
          `INSERT INTO movimientos_ruta (id_ruta, id_cliente, tipo_movimiento, fecha)
           VALUES (?, ?, 'cliente_agregado', NOW())`,
          [rutaId, clienteId]
        );
      }
    }

    await conn.commit();

    return res.json({
      ok: true,
      data: {
        id: clienteId,
        clave: `CLI-${String(clienteId).padStart(6, '0')}`,
        codigo_qr: codigoQR,
        codigoQR: codigoQR,
        requiere_factura: reqFactura,
        requiereFactura: reqFactura,
        tipo_cliente: tipoWord,     // 'normal' | 'cadena'
        tipo_cliente_db: tipoDb,    // 'N' | 'C'
        cadena: tipoDb === 'C' ? cadena : null, // 'Bara' | 'CarneMart' | 'Ahorramax' | null
        nombre,
        telefono,
        correo: correo || null
      }
    });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    return res.status(500).json({ ok: false, msg: e?.message || 'Error al crear cliente' });
  } finally {
    try { conn.release(); } catch {}
  }
}

/* =========================
   GET /api/vendedor/clientes/mis
   ========================= */
export async function listarMisClientes(req, res) {
  try {
    const usuarioId = getUsuarioId(req);
    if (!usuarioId) return res.status(401).json({ ok: false, msg: 'No autorizado' });

    const q = norm(req.query?.q);
    const params = [usuarioId];
    let sql = `
      SELECT
        c.id,
        c.clave,
        c.nombre_empresa AS nombre,
        c.telefono,
        c.correo,
        c.colonia,
        c.calle_numero AS calle,
        c.codigo_postal,
        c.codigo_qr     AS codigoQR,
        c.requiere_factura AS requiereFactura,
        c.tipo_cliente,      -- 'C'|'N'
        c.cadena,
        c.pricing_mode,
        e.nombre AS estado,
        m.nombre AS municipio,
        c.fecha_registro,
        c.fecha_actualizacion
      FROM clientes c
      LEFT JOIN estados    e ON e.id = c.id_estado
      LEFT JOIN municipios m ON m.id = c.id_municipio
      WHERE c.id_usuario_creador = ?
        AND c.activo=1 AND c.eliminado=0
    `;
    if (q) {
      sql += ` AND (c.nombre_empresa LIKE ? OR c.telefono LIKE ? OR c.clave LIKE ? OR c.codigo_qr LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += ' ORDER BY c.fecha_registro DESC LIMIT 200';

    const [rows] = await db.query(sql, params);
    return res.json({ ok: true, data: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, msg: e?.message || 'Error listando' });
  }
}

/* =========================
   GET /api/vendedor/clientes/by-qr/:codigo
   ========================= */
export async function getClientePorQR(req, res) {
  try {
    const codigo = norm(req.params?.codigo);
    if (!codigo) return res.status(400).json({ ok: false, msg: 'Falta código' });

    const [rows] = await db.query(
      `SELECT
         c.id,
         c.clave,
         c.nombre_empresa AS nombre,
         c.telefono,
         c.correo,
         c.colonia,
         c.calle_numero AS calle,
         c.codigo_postal,
         c.codigo_qr     AS codigoQR,
         c.requiere_factura AS requiereFactura,
         c.tipo_cliente,      -- 'C'|'N'
         c.cadena,
         c.pricing_mode,
         e.nombre AS estado,
         m.nombre AS municipio,
         c.fecha_registro,
         c.fecha_actualizacion
       FROM clientes c
       LEFT JOIN estados e    ON e.id=c.id_estado
       LEFT JOIN municipios m ON m.id=c.id_municipio
       WHERE c.activo=1 AND c.eliminado=0
         AND (c.codigo_qr=? OR c.clave=?)
       LIMIT 1`,
      [codigo, codigo]
    );
    if (!rows.length) return res.status(404).json({ ok: false, msg: 'No encontrado' });
    return res.json({ ok: true, data: rows[0] });
  } catch (e) {
    return res.status(500).json({ ok: false, msg: e?.message || 'Error' });
  }
}

/* =========================
   Catálogos para Android
   ========================= */

// GET /api/catalogos/estados
export async function listarEstados(req, res) {
  try {
    const q = (req.query?.q ?? '').toString().trim();
    const activosParam = req.query?.activos;
    const limit = Math.min(Math.max(Number(req.query?.limit || 100), 1), 500);

    const params = [];
    let sql = `SELECT id, nombre, IFNULL(activo,1) AS activo FROM estados WHERE 1=1`;
    if (activosParam === '0' || activosParam === '1') {
      sql += ` AND IFNULL(activo,1) = ?`;
      params.push(Number(activosParam));
    }
    if (q) {
      sql += ` AND nombre LIKE ?`;
      params.push(`%${q}%`);
    }
    sql += ` ORDER BY nombre ASC LIMIT ${limit}`;

    const [rows] = await db.query(sql, params);
    const data = rows.map((r) => ({
      id: Number(r.id), nombre: r.nombre, activo: Number(r.activo ?? 1),
    }));

    return res.json(data);
  } catch (e) {
    return res.status(500).json({ ok: false, msg: e?.message || 'Error listando estados' });
  }
}

// GET /api/catalogos/municipios?estadoId=###
export async function listarMunicipios(req, res) {
  try {
    const estadoId = Number(req.query?.estadoId ?? req.query?.estado_id);
    if (!Number.isFinite(estadoId) || estadoId <= 0) {
      return res.status(400).json({ ok: false, msg: 'Falta estadoId válido' });
    }

    const q = (req.query?.q ?? '').toString().trim();
    const activosParam = req.query?.activos;
    const limit = Math.min(Math.max(Number(req.query?.limit || 200), 1), 1000);

    const params = [estadoId];
    let sql = `
      SELECT id, nombre, estado_id AS estadoId, IFNULL(activo,1) AS activo
      FROM municipios
      WHERE estado_id = ?
    `;
    if (activosParam === '0' || activosParam === '1') {
      sql += ` AND IFNULL(activo,1) = ?`;
      params.push(Number(activosParam));
    }
    if (q) {
      sql += ` AND nombre LIKE ?`;
      params.push(`%${q}%`);
    }
    sql += ` ORDER BY nombre ASC LIMIT ${limit}`;

    const [rows] = await db.query(sql, params);
    const data = rows.map((r) => ({
      id: Number(r.id), nombre: r.nombre, estadoId: Number(r.estadoId), activo: Number(r.activo ?? 1),
    }));

    return res.json(data);
  } catch (e) {
    return res.status(500).json({ ok: false, msg: e?.message || 'Error listando municipios' });
  }
}
