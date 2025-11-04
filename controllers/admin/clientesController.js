import db from '../../config/db.js';

/* ========================= Helpers ========================= */
const toNull       = v => (v === '' || v === undefined ? null : v);
const toNumOrNull  = v => (v === '' || v === undefined || v === null ? null : Number(v));
const toBoolOrNull = v => (v === '' || v === undefined || v === null ? null : Number(!!v));
const toPricingOrNull = v => (v === 'mayoreo' || v === 'normal' ? v : null);

const isPositiveIntOrNull = (v) => v == null || v === '' ? null : (Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : NaN);
const isNumberOrNull      = (v) => v == null || v === '' ? null : (isNaN(Number(v)) ? NaN : Number(v));
const isYMD               = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const normStr             = (s) => (s ?? '').toString().trim();

const buildWhere = (search, activo) => {
  const where = ['c.eliminado = 0'];
  const params = [];
  const s = normStr(search);
  if (s) {
    where.push('(c.clave LIKE ? OR c.nombre_empresa LIKE ? OR c.telefono LIKE ?)');
    params.push(`%${s}%`, `%${s}%`, `%${s}%`);
  }
  if (activo !== undefined && activo !== null && `${activo}` !== '') {
    where.push('c.activo = ?');
    params.push(Number(activo));
  }
  return { where: 'WHERE ' + where.join(' AND '), params };
};

const getRolId = (req) => {
  const raw = req?.user?.rol_id ?? req?.user?.rol ?? 0;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  const s = String(raw || '').toLowerCase();
  if (s.includes('super')) return 4;
  if (s.includes('admin')) return 1;
  return 0;
};

const requireSuperAdmin = (req, res) => {
  if (getRolId(req) !== 4) {
    res.status(403).json({ error: 'Permisos insuficientes (requiere SuperAdmin).' });
    return false;
  }
  return true;
};

/** Validación de payload de cliente (POST/PUT) */
const validateClientePayload = (b, isUpdate = false) => {
  const errors = [];

  const name = normStr(b.nombre_empresa);
  if (!isUpdate || b.nombre_empresa !== undefined) {
    if (!name) errors.push('nombre_empresa es requerido.');
    else if (name.length > 180) errors.push('nombre_empresa excede 180 caracteres.');
  }

  if (b.telefono !== undefined) {
    const tel = normStr(b.telefono);
    if (tel && !/^[0-9+\-()\s]{7,20}$/.test(tel)) errors.push('telefono con formato inválido.');
  }

  if (b.codigo_postal !== undefined) {
    const cp = normStr(b.codigo_postal);
    if (cp && !/^\d{4,10}$/.test(cp)) errors.push('codigo_postal inválido.');
  }

  if (b.dias_credito !== undefined) {
    const n = isPositiveIntOrNull(b.dias_credito);
    if (Number.isNaN(n)) errors.push('dias_credito debe ser entero >= 0.');
  }

  if (b.limite_credito_monto !== undefined) {
    const n = isNumberOrNull(b.limite_credito_monto);
    if (Number.isNaN(n) || (n != null && n < 0)) errors.push('limite_credito_monto debe ser número >= 0.');
  }

  if (b.limite_creditos_abiertos !== undefined) {
    const n = isPositiveIntOrNull(b.limite_creditos_abiertos);
    if (Number.isNaN(n)) errors.push('limite_creditos_abiertos debe ser entero >= 0.');
  }

  if (b.pricing_mode !== undefined && !['normal', 'mayoreo'].includes(b.pricing_mode)) {
    errors.push("pricing_mode debe ser 'normal' o 'mayoreo'.");
  }

  if (!isUpdate) {
    if (b.activo !== undefined && ![0,1,true,false,'0','1'].includes(b.activo)) {
      errors.push('activo inválido.');
    }
  }

  return errors;
};

/* ========================= Controladores ========================= */

/** GET /api/clientes/cadenas  →  ['Bara','CarneMart','Ahorramax', ...] */
export const listarCadenas = async (_req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT DISTINCT TRIM(c.cadena) AS cadena
      FROM clientes c
      WHERE c.eliminado = 0
        AND c.tipo_cliente = 'C'
        AND c.cadena IS NOT NULL
        AND c.cadena <> ''
      ORDER BY cadena ASC
      `
    );
    const data = rows
      .map(r => r.cadena)
      .filter(v => typeof v === 'string' && v.trim().length > 0);
    res.json(data);
  } catch (e) {
    console.error('listarCadenas', { code: e.code, sqlMessage: e.sqlMessage, sql: e.sql, message: e.message });
    res.status(500).json({ error: 'Error al listar cadenas' });
  }
};

/** GET /api/clientes  (soporta filtros: search, activo, vendedor_id, en_ruta, fecha, tipo_cliente, cadena, desc_prod_id, desc_activos) */
export const listarClientes = async (req, res) => {
  try {
    const { search, activo, page = 1, limit = 50 } = req.query;

    // Filtros extra
    const fecha = req.query.fecha ? String(req.query.fecha).slice(0,10) : null; // 'YYYY-MM-DD'
    const excluirAsignados = Number(req.query.excluir_asignados_dia || 0) === 1;
    const excluirRutaId = req.query.excluir_ruta_id ? Number(req.query.excluir_ruta_id) : null;

    // Filtro por vendedor / rutas
    const vendedorId = req.query.vendedor_id ? Number(req.query.vendedor_id) : null;
    const enRuta = Number(req.query.en_ruta || 0) === 1;

    // Filtro por descuentos de producto
    const descProdId = req.query.desc_prod_id ? Number(req.query.desc_prod_id) : null;
    const descActivos = Number(req.query.desc_activos || 1) === 1;

    // === Filtros de tipo/cadena usados por el FRONT ===
    // tipo_cliente: 'N' | 'C' (o variantes: 'normal' | 'cadena')
    // cadena: nombre exacto ('Bara','CarneMart','Ahorramax',...)
    const tipoRaw = normStr(req.query.tipo_cliente).toLowerCase();
    const cadenaFilter = normStr(req.query.cadena);

    let tipoCliente = null;
    if (['n','normal','0','false'].includes(tipoRaw)) tipoCliente = 'N';
    if (['c','cadena','1','true'].includes(tipoRaw))  tipoCliente = 'C';

    // Validaciones de filtros
    if (enRuta && !isYMD(fecha)) {
      return res.status(400).json({ error: "Debe proporcionar 'fecha' válida (YYYY-MM-DD) cuando en_ruta = 1." });
    }
    if (Number.isNaN(vendedorId ?? 0)) return res.status(400).json({ error: 'vendedor_id inválido.' });
    if (Number.isNaN(excluirRutaId ?? 0)) return res.status(400).json({ error: 'excluir_ruta_id inválido.' });
    if (Number.isNaN(descProdId ?? 0)) return res.status(400).json({ error: 'desc_prod_id inválido.' });

    const { where, params } = buildWhere(search, activo);

    const p = Math.max(parseInt(page, 10) || 1, 1);
    const l = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const offset = (p - 1) * l;

    let extra = '';

    // Aplicación del filtro tipo/cadena FINAL:
    // - si tipoCliente === 'N': solo normales
    // - si tipoCliente === 'C' y SIN cadena: todas las cadenas
    // - si tipoCliente === 'C' y CON cadena: esa cadena específica
    if (tipoCliente === 'N') {
      extra += ` AND c.tipo_cliente = 'N' `;
    } else if (tipoCliente === 'C') {
      if (cadenaFilter) {
        extra += ` AND c.tipo_cliente = 'C' AND c.cadena = ? `;
        params.push(cadenaFilter);
      } else {
        extra += ` AND c.tipo_cliente = 'C' `;
      }
    } else if (cadenaFilter) {
      // si mandan solo cadena sin tipo, asumimos cadenas
      extra += ` AND c.tipo_cliente = 'C' AND c.cadena = ? `;
      params.push(cadenaFilter);
    }

    // Vendedor / ruta del día o plantillas
    if (vendedorId) {
      if (enRuta && fecha) {
        extra += `
          AND EXISTS (
            SELECT 1
              FROM rutas_diarias rd
              JOIN rutas_clientes rc ON rc.id_ruta = rd.id
             WHERE rd.id_vendedor = ?
               AND rd.fecha = ?
               AND rc.id_cliente = c.id
          )
        `;
        params.push(vendedorId, fecha);
      } else {
        extra += `
          AND EXISTS (
            SELECT 1
              FROM plantillas_ruta pr
              JOIN plantilla_ruta_clientes prc ON prc.id_plantilla = pr.id
             WHERE pr.id_vendedor = ?
               AND pr.activo = 1
               AND prc.id_cliente = c.id
          )
        `;
        params.push(vendedorId);
      }
    }

    // Filtro por descuentos de producto
    if (descProdId) {
      if (descActivos) {
        extra += `
          AND EXISTS (
            SELECT 1
              FROM descuentos_cliente_producto dcp
             WHERE dcp.cliente_id = c.id
               AND dcp.producto_id = ?
               AND dcp.activo = 1
               AND (dcp.fecha_inicio IS NULL OR dcp.fecha_inicio <= CURDATE())
               AND (dcp.fecha_fin IS NULL OR dcp.fecha_fin >= CURDATE())
          )
        `;
        params.push(descProdId);
      } else {
        extra += `
          AND EXISTS (
            SELECT 1
              FROM descuentos_cliente_producto dcp
             WHERE dcp.cliente_id = c.id
               AND dcp.producto_id = ?
          )
        `;
        params.push(descProdId);
      }
    }

    if (fecha && excluirAsignados) {
      extra += `
        AND NOT EXISTS (
          SELECT 1
            FROM rutas_clientes rc
            JOIN rutas_diarias rd ON rd.id = rc.id_ruta
           WHERE rc.id_cliente = c.id
             AND rd.fecha = ?
             ${excluirRutaId ? 'AND rd.id <> ?' : ''}
        )
      `;
      params.push(fecha);
      if (excluirRutaId) params.push(excluirRutaId);
    }

    // Total
    const [[cnt]] = await db.query(
      `
      SELECT COUNT(1) AS total
      FROM clientes c
      ${where}
      ${extra}
      `,
      [...params]
    );

    // Listado
    const [rows] = await db.query(
      `
      SELECT
        c.*,
        COALESCE(s.total_creditos, 0)   AS total_creditos,
        COALESCE(s.total_pagos, 0)      AS total_pagos,
        COALESCE(s.saldo_pendiente, 0)  AS saldo_pendiente
      FROM clientes c
      LEFT JOIN (
        SELECT
          v.id_cliente                                   AS id_cliente,
          SUM(v.total)                                   AS total_creditos,
          SUM(COALESCE(pc.total_pagos,0))                AS total_pagos,
          SUM(v.total) - SUM(COALESCE(pc.total_pagos,0)) AS saldo_pendiente
        FROM ventas v
        JOIN creditos cr ON cr.id_venta = v.id
        LEFT JOIN (
          SELECT id_credito, SUM(monto) AS total_pagos
          FROM pagos_credito
          GROUP BY id_credito
        ) pc ON pc.id_credito = cr.id
        WHERE v.tipo_pago = 'credito'
        GROUP BY v.id_cliente
      ) s ON s.id_cliente = c.id
      ${where}
      ${extra}
      ORDER BY c.fecha_registro DESC
      LIMIT ? OFFSET ?
      `,
      [...params, l, offset]
    );

    const data = rows.map(r => ({
      ...r,
      clave: r.clave ?? `CLI-${String(r.id).padStart(6, '0')}`
    }));

    res.set('X-Total-Count', String(cnt?.total ?? data.length));
    res.json(data);
  } catch (e) {
    console.error('listarClientes', { code: e.code, sqlMessage: e.sqlMessage, sql: e.sql, message: e.message });
    res.status(500).json({ error: 'Error al listar clientes' });
  }
};

/** GET /api/clientes/:id */
export const obtenerCliente = async (req, res) => {
  try {
    const { id } = req.params;
    const nid = Number(id);
    if (!Number.isInteger(nid) || nid <= 0) return res.status(400).json({ error: 'ID inválido.' });

    // Versión estable: computa saldos usando la misma lógica que el listado para evitar discrepancias
    const [[row]] = await db.query(
      `
      SELECT
        c.*,
        COALESCE(s.total_creditos, 0)   AS total_creditos,
        COALESCE(s.total_pagos, 0)      AS total_pagos,
        COALESCE(s.saldo_pendiente, 0)  AS saldo_pendiente
      FROM clientes c
      LEFT JOIN (
        SELECT
          v.id_cliente                                   AS id_cliente,
          SUM(v.total)                                   AS total_creditos,
          SUM(COALESCE(pc.total_pagos,0))                AS total_pagos,
          SUM(v.total) - SUM(COALESCE(pc.total_pagos,0)) AS saldo_pendiente
        FROM ventas v
        JOIN creditos cr ON cr.id_venta = v.id
        LEFT JOIN (
          SELECT id_credito, SUM(monto) AS total_pagos
          FROM pagos_credito
          GROUP BY id_credito
        ) pc ON pc.id_credito = cr.id
        WHERE v.tipo_pago = 'credito'
        GROUP BY v.id_cliente
      ) s ON s.id_cliente = c.id
      WHERE c.id = ? AND c.eliminado = 0
      LIMIT 1
      `,
      [nid]
    );

    if (!row) return res.status(404).json({ error: 'Cliente no encontrado' });

    row.clave = row.clave ?? `CLI-${String(row.id).padStart(6, '0')}`;
    res.json(row);
  } catch (e) {
    console.error('obtenerCliente', { code: e.code, sqlMessage: e.sqlMessage, sql: e.sql, message: e.message });
    res.status(500).json({ error: 'Error al obtener cliente' });
  }
};

/** POST /api/clientes */
export const crearCliente = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const b = req.body;
    const errors = validateClientePayload(b, false);
    if (errors.length) return res.status(400).json({ error: 'Validación fallida', details: errors });

    const pricing = b.pricing_mode === 'mayoreo' ? 'mayoreo' : 'normal';

    if (b.telefono) {
      const [[dup]] = await db.query(
        `SELECT id FROM clientes WHERE eliminado = 0 AND nombre_empresa = ? AND telefono = ? LIMIT 1`,
        [normStr(b.nombre_empresa), normStr(b.telefono)]
      );
      if (dup) return res.status(409).json({ error: 'Ya existe un cliente con ese nombre y teléfono.' });
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [r1] = await conn.query(
        `
        INSERT INTO clientes (
          nombre_empresa, telefono, calle_numero, colonia, codigo_postal,
          id_estado, id_municipio, permite_credito, dias_credito,
          limite_credito_monto, limite_creditos_abiertos, activo, eliminado,
          pricing_mode, tipo_cliente, cadena
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `,
        [
          b.nombre_empresa ?? null,
          b.telefono ?? null,
          b.calle_numero ?? null,
          b.colonia ?? null,
          b.codigo_postal ?? null,
          b.id_estado ? Number(b.id_estado) : null,
          b.id_municipio ? Number(b.id_municipio) : null,
          b.permite_credito ? 1 : 0,
          b.dias_credito != null && b.dias_credito !== '' ? Number(b.dias_credito) : null,
          b.limite_credito_monto != null && b.limite_credito_monto !== '' ? Number(b.limite_credito_monto) : null,
          b.limite_creditos_abiertos != null && b.limite_creditos_abiertos !== '' ? Number(b.limite_creditos_abiertos) : null,
          b.activo === undefined ? 1 : (b.activo ? 1 : 0),
          0,
          pricing,
          b.tipo_cliente === 'C' ? 'C' : 'N',
          b.tipo_cliente === 'C' ? (b.cadena || null) : null
        ]
      );

      const newId = r1.insertId;

      await conn.query(
        `UPDATE clientes SET clave = CONCAT('CLI-', LPAD(?, 6, '0')) WHERE id = ?`,
        [newId, newId]
      );

      await conn.commit();

      res.json({ mensaje: 'Cliente creado', id: newId, clave: `CLI-${String(newId).padStart(6, '0')}` });
    } catch (txErr) {
      await conn.rollback();
      throw txErr;
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('crearCliente', { code: e.code, sqlMessage: e.sqlMessage, sql: e.sql, message: e.message });
    res.status(500).json({ error: e.message || 'Error al crear cliente' });
  }
};

/** PUT /api/clientes/:id */
export const editarCliente = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const { id } = req.params;
    const nid = Number(id);
    if (!Number.isInteger(nid) || nid <= 0) return res.status(400).json({ error: 'ID inválido.' });

    const [[exists]] = await db.query(`SELECT id FROM clientes WHERE id = ? AND eliminado = 0 LIMIT 1`, [nid]);
    if (!exists) return res.status(404).json({ error: 'Cliente no encontrado' });

    const b = req.body;
    if (!Object.keys(b || {}).length) return res.status(400).json({ error: 'Nada para actualizar.' });

    const errors = validateClientePayload(b, true);
    if (errors.length) return res.status(400).json({ error: 'Validación fallida', details: errors });

    const params = [
      toNull(b.nombre_empresa),
      toNull(b.telefono),
      toNull(b.calle_numero),
      toNull(b.colonia),
      toNull(b.codigo_postal),
      toNumOrNull(b.id_estado),
      toNumOrNull(b.id_municipio),
      toBoolOrNull(b.permite_credito),
      toNumOrNull(b.dias_credito),
      toNumOrNull(b.limite_credito_monto),
      toNumOrNull(b.limite_creditos_abiertos),
      toBoolOrNull(b.activo),
      toPricingOrNull(b.pricing_mode),
      b.tipo_cliente === undefined ? null : (b.tipo_cliente === 'C' ? 'C' : 'N'),
      b.tipo_cliente === 'C' ? (b.cadena || null) : (b.tipo_cliente === 'N' ? null : null),
      nid
    ];

    const [r] = await db.query(
      `
      UPDATE clientes SET
        nombre_empresa           = COALESCE(?, nombre_empresa),
        telefono                 = COALESCE(?, telefono),
        calle_numero             = COALESCE(?, calle_numero),
        colonia                  = COALESCE(?, colonia),
        codigo_postal            = COALESCE(?, codigo_postal),
        id_estado                = COALESCE(?, id_estado),
        id_municipio             = COALESCE(?, id_municipio),
        permite_credito          = COALESCE(?, permite_credito),
        dias_credito             = COALESCE(?, dias_credito),
        limite_credito_monto     = COALESCE(?, limite_credito_monto),
        limite_creditos_abiertos = COALESCE(?, limite_creditos_abiertos),
        activo                   = COALESCE(?, activo),
        pricing_mode             = COALESCE(?, pricing_mode),
        tipo_cliente             = COALESCE(?, tipo_cliente),
        cadena                   = COALESCE(?, cadena)
      WHERE id = ? AND eliminado = 0
      `,
      params
    );

    if (!r.affectedRows) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json({ mensaje: 'Cliente actualizado' });
  } catch (e) {
    console.error('editarCliente', { code: e.code, sqlMessage: e.sqlMessage, sql: e.sql, message: e.message });
    res.status(500).json({ error: 'Error al actualizar cliente' });
  }
};

/** DELETE /api/clientes/:id (soft delete) */
export const eliminarCliente = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const { id } = req.params;
    const nid = Number(id);
    if (!Number.isInteger(nid) || nid <= 0) return res.status(400).json({ error: 'ID inválido.' });

    const [r] = await db.query(
      `UPDATE clientes SET eliminado = 1, activo = 0 WHERE id = ? AND eliminado = 0`,
      [nid]
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json({ mensaje: 'Cliente eliminado' });
  } catch (e) {
    console.error('eliminarCliente', { code: e.code, sqlMessage: e.sqlMessage, sql: e.sql, message: e.message });
    res.status(500).json({ error: 'Error al eliminar cliente' });
  }
};

/** PATCH /api/clientes/:id/activar */
export const activarCliente = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const { id } = req.params;
    const nid = Number(id);
    if (!Number.isInteger(nid) || nid <= 0) return res.status(400).json({ error: 'ID inválido.' });

    const [r] = await db.query(
      `UPDATE clientes SET activo = 1, eliminado = 0 WHERE id = ?`,
      [nid]
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json({ mensaje: 'Cliente activado' });
  } catch (e) {
    console.error('activarCliente', { code: e.code, sqlMessage: e.sqlMessage, sql: e.sql, message: e.message });
    res.status(500).json({ error: 'Error al activar cliente' });
  }
};
