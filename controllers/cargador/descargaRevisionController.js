// controllers/cargador/descargaRevisionController.js
import db from '../../config/db.js';

/* ============================== Utils ============================== */

const toInt = (v) => (v === null || v === undefined ? null : parseInt(v, 10) || null);

/** Regresa un Set con las columnas existentes en la tabla dada. */
async function getExistingColumns(tableName) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME AS c
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tableName]
  );
  return new Set(rows.map((r) => r.c));
}

/** Verifica si existe una tabla. */
async function tableExists(tableName) {
  const [[row]] = await db.query(
    `SELECT COUNT(*) AS n
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tableName]
  );
  return Number(row?.n || 0) > 0;
}

/** Fuente de ID de caja */
async function getCajaIdSource() {
  const cols = await getExistingColumns('prestamos_cajas');
  const hasTiposCol = cols.has('id_tipo_caja');
  const hasEnvCol   = cols.has('id_envase');

  const hasTiposTbl = await tableExists('tipos_cajas');
  const hasEnvTbl   = await tableExists('envase');

  if (hasEnvCol && hasEnvTbl) {
    return { mode: 'envase', idCol: 'id_envase', table: 'envase', nombreCol: 'nombre' };
  }
  if (hasTiposCol && hasTiposTbl) {
    return { mode: 'tipos_cajas', idCol: 'id_tipo_caja', table: 'tipos_cajas', nombreCol: 'nombre' };
  }
  if (hasEnvTbl) {
    return { mode: 'envase', idCol: 'id_envase', table: 'envase', nombreCol: 'nombre' };
  }
  if (hasTiposTbl) {
    return { mode: 'tipos_cajas', idCol: 'id_tipo_caja', table: 'tipos_cajas', nombreCol: 'nombre' };
  }
  return { mode: 'none', idCol: null, table: null, nombreCol: null };
}

/** IDs de caja chica/grande/cubeta */
async function getCajaTypeIds() {
  const src = await getCajaIdSource();
  if (src.mode === 'none' || !src.table) return { src, chica: null, grande: null, cubeta: null };

  try {
    const [rows] = await db.query(
      `SELECT id, ${src.nombreCol} AS n FROM ${src.table} WHERE ${src.nombreCol} IN (?,?,?)`,
      ['Caja chica', 'Caja grande', 'Cubeta']
    );
    const byName = new Map(rows.map(r => [String(r.n).toLowerCase(), r.id]));
    return {
      src,
      chica:  byName.get('caja chica')  || null,
      grande: byName.get('caja grande') || null,
      cubeta: byName.get('cubeta')      || null,
    };
  } catch (e) {
    console.warn('[getCajaTypeIds] fallback por error:', e.code || e.message);
    return { src: { ...src, mode: 'none' }, chica: null, grande: null, cubeta: null };
  }
}

/** Detecta dónde está la categoría del producto (columna/tabla) */
async function getCategoriaSource() {
  // Candidatos comunes: columna en productos -> tabla de categorías
  const candidates = [
    { prodCol: 'categoria_id', table: 'categorias',        nombreCol: 'nombre',  tableId: 'id' },
    { prodCol: 'id_categoria', table: 'categorias',        nombreCol: 'nombre',  tableId: 'id' },
    { prodCol: 'id_categoria', table: 'categorias_productos', nombreCol: 'nombre', tableId: 'id' },
    { prodCol: 'id_departamento', table: 'departamentos',  nombreCol: 'nombre',  tableId: 'id' },
    { prodCol: 'rubro_id',     table: 'rubros',            nombreCol: 'nombre',  tableId: 'id' },
    { prodCol: 'id_rubro',     table: 'rubros',            nombreCol: 'nombre',  tableId: 'id' },
  ];

  const prodCols = await getExistingColumns('productos');
  for (const c of candidates) {
    if (!prodCols.has(c.prodCol)) continue;
    if (await tableExists(c.table)) {
      // Si la tabla no tiene 'nombre', intenta alternativas comunes
      const catCols = await getExistingColumns(c.table);
      const nombreCol = catCols.has(c.nombreCol)
        ? c.nombreCol
        : (catCols.has('descripcion') ? 'descripcion'
          : (catCols.has('name') ? 'name' : null));
      const tableId = catCols.has(c.tableId) ? c.tableId : (catCols.has('id') ? 'id' : null);
      if (nombreCol && tableId) {
        return { ok: true, prodCol: c.prodCol, table: c.table, nombreCol, tableId };
      }
    }
  }
  return { ok: false };
}

/** Normaliza envases_json */
function parseEnvasesJson(raw) {
  if (!raw) return { cajasChicas: 0, cajasGrandes: 0, cubetas: 0 };

  let obj = raw;
  try { if (typeof raw === 'string') obj = JSON.parse(raw); } catch {}

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  const flat = {
    chicas:  num(obj?.cajasChicas ?? obj?.cajaChica ?? obj?.chica ?? obj?.chicas),
    grandes: num(obj?.cajasGrandes ?? obj?.cajaGrande ?? obj?.grande ?? obj?.grandes),
    cubetas: num(obj?.cubetas ?? obj?.cubeta),
  };

  const nested = {
    chicas:  num(obj?.cajaChica?.salidas  ?? obj?.cajaChica?.cargadas ?? obj?.cajaChica?.prestamos),
    grandes: num(obj?.cajaGrande?.salidas ?? obj?.cajaGrande?.cargadas ?? obj?.cajaGrande?.prestamos),
    cubetas: num(obj?.cubeta?.salidas     ?? obj?.cubeta?.cargadas    ?? obj?.cubeta?.prestamos),
  };

  const cajasChicas  = flat.chicas  || nested.chicas  || 0;
  const cajasGrandes = flat.grandes || nested.grandes || 0;
  const cubetas      = flat.cubetas || nested.cubetas || 0;

  return { cajasChicas, cajasGrandes, cubetas };
}

/** UPDATE dinámico */
function buildDynamicUpdate(table, dataObj, existingCols, whereSql, whereParams = []) {
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(dataObj)) {
    if (existingCols.has(k)) {
      sets.push(`${k} = ?`);
      params.push(v);
    }
  }
  if (!sets.length) return null;
  const sql = `UPDATE ${table} SET ${sets.join(', ')} ${whereSql}`;
  return { sql, params: [...params, ...whereParams] };
}

/* (Opcional) Totales de texto */
function armarTotalesTexto(t = {}) {
  const fmt = (n) =>
    new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })
      .format(Number(n || 0));
  const venta = Number(t.ventaGeneralHoy || 0);
  const rec   = Number(t.recaudado || t.recaudadoTotal || 0);
  const debe  = Math.max(venta - rec, 0);
  const aFav  = Math.max(rec - venta, 0);
  return [
    '════════════════════════════════',
    '   RESUMEN DEL DÍA',
    '════════════════════════════════',
    `Venta General: ${fmt(venta)}`,
    `Recaudado:     ${fmt(rec)}`,
    debe > 0 ? `Debe:          ${fmt(debe)}` : `A favor:       ${fmt(aFav)}`,
    '════════════════════════════════',
  ].join('\n');
}

/* ============================= Vendedores ============================= */

export async function listarVendedores(_req, res) {
  try {
    const [rows] = await db.query(`
      SELECT v.id AS vendedorId, u.nombre,
             cam.marca, cam.modelo, cam.placa,
             cam.kilometraje_actual AS kilometraje
        FROM vendedores v
        JOIN usuarios  u   ON u.id = v.id_usuario
   LEFT JOIN camionetas cam ON cam.id = v.camioneta_id
       WHERE v.activo=1 AND v.eliminado=0
    ORDER BY u.nombre ASC
    `);

    const data = rows.map((r) => ({
      id: String(r.vendedorId),
      nombre: r.nombre,
      camioneta: r.marca && r.modelo ? `${r.marca} ${r.modelo}` : null,
      placas: r.placa || null,
      kilometraje: r.kilometraje ?? null,
    }));

    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Error' });
  }
}

/* ============================== Productos ============================= */

export async function listarProductos(_req, res) {
  try {
    // También devolvemos categoría si existe
    const cat = await getCategoriaSource();
    let sql = `SELECT p.id, p.nombre`;
    if (cat.ok) sql += `, p.${cat.prodCol} AS categoriaId, cat.${cat.nombreCol} AS categoriaNombre`;
    sql += ` FROM productos p WHERE p.activo=1 AND p.eliminado=0`;
    if (cat.ok) sql += ` LEFT JOIN ${cat.table} cat ON cat.${cat.tableId} = p.${cat.prodCol}`;
    sql += ` ORDER BY p.nombre ASC`;

    const [rows] = await db.query(sql);

    res.json({
      ok: true,
      data: rows.map((r) => ({
        id: String(r.id),
        nombre: r.nombre,
        categoriaId: r.categoriaId != null ? Number(r.categoriaId) : null,
        categoriaNombre: r.categoriaNombre ?? null,
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Error' });
  }
}

/* ======================== Cargas pendientes (APP) ===================== */

export async function listarCargasPendientes(req, res) {
  try {
    const cargaId = req.query.cargaId ? Number(req.query.cargaId) : null;

    const params = [];
    let where = 'c.procesada = 0 AND c.lista_para_procesar = 1';
    if (cargaId) { where += ' AND c.id = ?'; params.push(cargaId); }

    const cargasCols = await getExistingColumns('cargas');
    const selEnvasesJson  = cargasCols.has('envases_json')  ? 'c.envases_json'  : 'NULL AS envases_json';
    const selTotalesTexto = cargasCols.has('totales_texto') ? 'c.totales_texto' : 'NULL AS totales_texto';

    const sql = `
      SELECT c.id, c.id_vendedor, c.id_camioneta, c.fecha,
             ${selEnvasesJson}, ${selTotalesTexto},
             u.nombre AS nombreVendedor,
             cam.marca, cam.modelo, cam.placa, cam.kilometraje_actual
        FROM cargas c
   LEFT JOIN vendedores v ON v.id = c.id_vendedor
   LEFT JOIN usuarios   u ON u.id = v.id_usuario
   LEFT JOIN camionetas cam ON cam.id = c.id_camioneta
       WHERE ${where}
    ORDER BY c.fecha DESC, c.id DESC
    `;

    const [rows] = await db.query(sql, params);

    const { src, chica, grande, cubeta } = await getCajaTypeIds();
    const hasPrestamos = await tableExists('prestamos_cajas');
    const cat = await getCategoriaSource();

    const data = [];
    for (const r of rows) {
      // === Productos con categoría (dinámico) ===
      let prodSql = `
        SELECT 
             COALESCE(p.id, dp.producto_id) AS id,
             COALESCE(p.nombre, dp.nombre_producto) AS nombre,
             COALESCE(dp.cantidad_inicial, 0) AS cantidad,
             COALESCE(dp.ventas, 0) AS ventas,
             COALESCE(dp.devoluciones, 0) AS devoluciones,
             COALESCE(dp.restante, GREATEST(dp.cantidad_inicial - dp.ventas - dp.devoluciones, 0)) AS restante`;
      if (cat.ok) {
        prodSql += `,
             p.${cat.prodCol} AS categoriaId,
             cat.${cat.nombreCol} AS categoriaNombre`;
      } else {
        prodSql += `,
             NULL AS categoriaId,
             NULL AS categoriaNombre`;
      }
      prodSql += `
           FROM detalle_pedido dp
      LEFT JOIN productos p ON p.id = dp.producto_id`;
      if (cat.ok) {
        prodSql += ` LEFT JOIN ${cat.table} cat ON cat.${cat.tableId} = p.${cat.prodCol}`;
      }
      prodSql += ` WHERE dp.carga_id = ? ORDER BY nombre ASC`;

      const [prods] = await db.query(prodSql, [r.id]);

      const resumenInventario = prods.map((p) => ({
        nombre: p.nombre,
        cantidad: Number(p.cantidad || 0),
        ventas: Number(p.ventas || 0),
        devoluciones: Number(p.devoluciones || 0),
        restante: Number(p.restante || 0),
        categoriaId: p.categoriaId != null ? Number(p.categoriaId) : null,
        categoriaNombre: p.categoriaNombre ?? null,
        ok: Number(p.restante || 0) === 0
      }));

      // === CARGADAS DEL DÍA (última carga) ===
      const envasesCargados = parseEnvasesJson(r.envases_json);

      // Si snapshot vacío, acumula de prestamos_cajas por carga
      if ((!envasesCargados.cajasChicas && !envasesCargados.cajasGrandes && !envasesCargados.cubetas)) {
        const { src, chica, grande, cubeta } = await getCajaTypeIds();
        if (src.mode !== 'none') {
          const idCol = src.idCol;
          const [agg] = await db.query(
            `
            SELECT
              SUM(CASE WHEN ${idCol}=? AND tipo='prestamo' THEN cantidad ELSE 0 END) AS ch,
              SUM(CASE WHEN ${idCol}=? AND tipo='prestamo' THEN cantidad ELSE 0 END) AS gr,
              SUM(CASE WHEN ${idCol}=? AND tipo='prestamo' THEN cantidad ELSE 0 END) AS cu
            FROM prestamos_cajas
            WHERE carga_id = ?`,
            [chica, grande, cubeta, r.id]
          );
          envasesCargados.cajasChicas  = Number(agg?.[0]?.ch || 0);
          envasesCargados.cajasGrandes = Number(agg?.[0]?.gr || 0);
          envasesCargados.cubetas      = Number(agg?.[0]?.cu || 0);
        }
      }

      // === SALDO HISTÓRICO (ledger) ===
      let cajaChicaEntradas = 0, cajaChicaSalidasHist = 0;
      let cajaGrandeEntradas = 0, cajaGrandeSalidasHist = 0;
      let cubetaEntradas = 0, cubetaSalidasHist = 0;

      if (hasPrestamos && r.id_vendedor && src.mode !== 'none') {
        const idCol = src.idCol;
        const mkSum = (id) =>
          id ? `SUM(CASE WHEN ${idCol}=${db.escape(id)} AND tipo='recoleccion' THEN cantidad ELSE 0 END) AS ent_${id},
                SUM(CASE WHEN ${idCol}=${db.escape(id)} AND tipo='prestamo'    THEN cantidad ELSE 0 END) AS sal_${id}`
             : `0 AS ent_null_${Math.random().toString(36).slice(2)}, 0 AS sal_null_${Math.random().toString(36).slice(2)}`;

        const [saldos] = await db.query(
          `
          SELECT
            ${mkSum(chica)},
            ${mkSum(grande)},
            ${mkSum(cubeta)}
          FROM prestamos_cajas
          WHERE id_vendedor = ?`,
          [r.id_vendedor]
        );

        let i = 0;
        const vals = Object.values(saldos[0] || {});
        if (chica)  { cajaChicaEntradas  = Number(vals[i++] || 0); cajaChicaSalidasHist  = Number(vals[i++] || 0); } else { i += 2; }
        if (grande) { cajaGrandeEntradas = Number(vals[i++] || 0); cajaGrandeSalidasHist = Number(vals[i++] || 0); } else { i += 2; }
        if (cubeta) { cubetaEntradas     = Number(vals[i++] || 0); cubetaSalidasHist     = Number(vals[i++] || 0); } else { i += 2; }
      }

      const cajaChicaDebe    = Math.max(0, cajaChicaSalidasHist  - cajaChicaEntradas);
      const cajaChicaAFavor  = Math.max(0, cajaChicaEntradas - cajaChicaSalidasHist);
      const cajaGrandeDebe   = Math.max(0, cajaGrandeSalidasHist - cajaGrandeEntradas);
      const cajaGrandeAFavor = Math.max(0, cajaGrandeEntradas - cajaGrandeSalidasHist);
      const cubetaDebe       = Math.max(0, cubetaSalidasHist     - cubetaEntradas);
      const cubetaAFavor     = Math.max(0, cubetaEntradas    - cubetaSalidasHist);

      data.push({
        id: String(r.id),
        vendedorUid: r.id_vendedor ? String(r.id_vendedor) : null,
        nombreVendedor: r.nombreVendedor || '—',
        fechaMillis: r.fecha ? new Date(r.fecha).getTime() : null,

        productos: prods.map((p) => ({
          id: p.id != null ? String(p.id) : null,
          nombre: p.nombre,
          cantidad: Number(p.cantidad || 0),
          categoriaId: p.categoriaId != null ? Number(p.categoriaId) : null,
          categoriaNombre: p.categoriaNombre ?? null,
        })),
        resumenInventario,

        camioneta: r.marca && r.modelo ? `${r.marca} ${r.modelo}` : null,
        placas: r.placa || null,
        kilometraje: r.kilometraje_actual ?? null,

        totales: null,
        totalesTexto: r.totales_texto || null,

        envasesCargados,
        cajaChicaSalidas:  envasesCargados.cajasChicas,
        cajaGrandeSalidas: envasesCargados.cajasGrandes,
        cubetaSalidas:     envasesCargados.cubetas,

        cajaChicaEntradas,
        cajaGrandeEntradas,
        cubetaEntradas,
        cajaChicaDebe,
        cajaChicaAFavor,
        cajaGrandeDebe,
        cajaGrandeAFavor,
        cubetaDebe,
        cubetaAFavor,
      });
    }

    res.json({ ok: true, data });
  } catch (e) {
    console.error('[pendientes] ERROR:', e?.code, e?.sqlMessage || e?.message);
    res.status(500).json({ ok: false, error: e?.message || 'Error' });
  }
}


/* ===================== Devoluciones pendientes ===================== */

export async function listarDevolucionesPendientes(req, res) {
  try {
    const vendedorId = Number(req.query.vendedorId);
    if (!vendedorId)
      return res.status(400).json({ ok: false, error: 'vendedorId requerido' });

    const hasLiga = await tableExists('descargas_devoluciones');

    let rows = [];
    if (hasLiga) {
      const [r] = await db.query(
        `
        SELECT d.id AS dev_id, d.motivo AS motivo, d.fecha,
               p.nombre AS producto, dd.cantidad
          FROM devoluciones d
          JOIN devolucion_detalle dd ON dd.id_devolucion = d.id
          JOIN productos p           ON p.id = dd.id_producto
     LEFT JOIN descargas_devoluciones l ON l.id_devolucion = d.id
         WHERE d.id_vendedor = ?
           AND l.id_devolucion IS NULL
      ORDER BY d.fecha DESC, d.id DESC
        `,
        [vendedorId]
      );
      rows = r;
    } else {
      const [r] = await db.query(
        `
        SELECT d.id AS dev_id, d.motivo AS motivo, d.fecha,
               p.nombre AS producto, dd.cantidad
          FROM devoluciones d
          JOIN devolucion_detalle dd ON dd.id_devolucion = d.id
          JOIN productos p           ON p.id = dd.id_producto
         WHERE d.id_vendedor = ?
           AND COALESCE(d.procesada,0) = 0
      ORDER BY d.fecha DESC, d.id DESC
        `,
        [vendedorId]
      );
      rows = r;
    }

    const data = rows.map((r) => ({
      docId: String(r.dev_id),
      nombre: r.producto,
      cantidad: Number(r.cantidad || 0),
      motivo: r.motivo || '',
      horaStr: new Date(r.fecha).toTimeString().substring(0, 8),
    }));

    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Error' });
  }
}

/* ========================= Confirmar revisión ========================= */
/** POST /api/cargador/descarga-revision/confirmar */
export async function confirmarRevision(req, res) {
  const conn = await db.getConnection();
  try {
    const {
      cargaId,
      vendedorUid,
      usuarioId,
      unidad,
      resumenInventario,
      envases,
      devolucionesSistema,
      devolucionesExtras,
      faltantesRuta,
      totales,
      totalesTexto,
    } = req.body || {};

    const idCarga = Number(cargaId);
    if (!idCarga) {
      conn.release();
      return res.status(400).json({ ok: false, error: 'cargaId requerido' });
    }

    await conn.beginTransaction();

    // Lock de la carga
    const [[carga]] = await conn.query(
      `SELECT id_camioneta, id_vendedor, fecha
         FROM cargas
        WHERE id = ? FOR UPDATE`,
      [idCarga]
    );
    if (!carga) throw new Error('Carga no encontrada');

    const idVendedor = vendedorUid ? Number(vendedorUid) : carga.id_vendedor || null;

    // Resolver usuario actor
    let actorUserId = Number(usuarioId) || null;
    if (!actorUserId && idVendedor) {
      const [[vu]] = await conn.query(
        `SELECT id_usuario FROM vendedores WHERE id = ? LIMIT 1`,
        [idVendedor]
      );
      actorUserId = vu?.id_usuario || null;
    }
    if (!actorUserId) {
      const [[sa]] = await conn.query(
        `SELECT id FROM usuarios WHERE usuario='superadmin' LIMIT 1`
      );
      actorUserId = sa?.id || null;
    }
    if (!actorUserId) throw new Error('No se pudo resolver usuario para registrar la descarga');

    // (1) Reusar/crear descarga pendiente
    let idDescarga = null;
    const [[exist]] = await conn.query(
      `SELECT id
         FROM descargas
        WHERE id_camioneta = ?
          AND procesada = 0
          AND lista_para_confirmar = 1
        ORDER BY fecha DESC
        LIMIT 1`,
      [carga.id_camioneta]
    );

    if (exist) {
      idDescarga = exist.id;
      await conn.query(
        `UPDATE descargas
            SET fecha = NOW(), observaciones = COALESCE(observaciones, NULL)
          WHERE id = ?`,
        [idDescarga]
      );
      await conn.query(`DELETE FROM descarga_productos WHERE id_descarga = ?`, [idDescarga]);
    } else {
      const [insDesc] = await conn.query(
        `INSERT INTO descargas (id_camioneta, id_usuario, fecha, observaciones, procesada, lista_para_confirmar)
         VALUES (?, ?, NOW(), NULL, 0, 1)`,
        [carga.id_camioneta, actorUserId]
      );
      idDescarga = insDesc.insertId;
    }

    // (2) Kilometraje (solo sube)
    if (unidad?.kilometraje != null) {
      await conn.query(
        `UPDATE camionetas
            SET kilometraje_actual = GREATEST(?, kilometraje_actual)
          WHERE id = ?`,
        [Number(unidad.kilometraje), carga.id_camioneta]
      );
    }

    // (3) Envases -> prestamos_cajas (recolección)
    const { src, chica, grande, cubeta } = await getCajaTypeIds();
    const cjCh = Number(envases?.cajasChicas || 0);
    const cjGr = Number(envases?.cajasGrandes || 0);
    const cub  = Number(envases?.cubetas || 0);

    if (idVendedor && src.mode !== 'none') {
      const idCol = src.idCol;
      const insertSql = `
        INSERT INTO prestamos_cajas (id_vendedor, ${idCol}, tipo, cantidad, fecha, descarga_id)
        VALUES (?,?,?,?,?,?)`;

      const base = (idCaja, cant) => [idVendedor, idCaja, 'recoleccion', cant, new Date(), idDescarga];

      if (cjCh > 0 && chica)  await conn.query(insertSql, base(chica,  cjCh));
      if (cjGr > 0 && grande) await conn.query(insertSql, base(grande, cjGr));
      if (cub  > 0 && cubeta) await conn.query(insertSql, base(cubeta, cub));
    }

    // (4) Devoluciones (ligar + marcar procesadas)
    const sys = Array.isArray(devolucionesSistema) ? devolucionesSistema : [];
    const ext = Array.isArray(devolucionesExtras) ? devolucionesExtras : [];

    const devIds = [...new Set(sys.map((x) => Number(x.docId)).filter(Boolean))];

    const hasLiga = await tableExists('descargas_devoluciones');
    if (devIds.length) {
      if (hasLiga) {
        const values = devIds.map(() => '(?, ?)').join(',');
        const params = devIds.flatMap((id) => [idDescarga, id]);
        await conn.query(
          `INSERT IGNORE INTO descargas_devoluciones (id_descarga, id_devolucion)
           VALUES ${values}`,
          params
        );
      }
      await conn.query(
        `UPDATE devoluciones SET procesada = 1, actualizado_en = NOW()
          WHERE id IN (${devIds.map(() => '?').join(',')})`,
        devIds
      );
    }

    if (hasLiga) {
      await conn.query(
        `UPDATE devoluciones d
           JOIN descargas_devoluciones l ON l.id_devolucion = d.id
            SET d.procesada = 1,
                d.actualizado_en = NOW()
          WHERE l.id_descarga = ?`,
        [idDescarga]
      );
    }

    // (5) Sumar devoluciones al inventario (si existe la tabla)
    const hasInventario = await tableExists('inventario');
    const sumByProd = new Map();
    for (const l of sys) {
      if (!l?.nombre) continue;
      const [[p]] = await conn.query(
        `SELECT id FROM productos WHERE LOWER(nombre) = LOWER(?) LIMIT 1`,
        [l.nombre]
      );
      if (p?.id) sumByProd.set(p.id, (sumByProd.get(p.id) || 0) + Number(l.cantidad || 0));
    }
    for (const l of ext) {
      if (!l?.productoId) continue;
      const pid = Number(l.productoId);
      if (pid) sumByProd.set(pid, (sumByProd.get(pid) || 0) + Number(l.cantidad || 0));
    }
    if (hasInventario) {
      for (const [pid, cant] of sumByProd.entries()) {
        if (cant > 0) {
          await conn.query(
            `INSERT INTO inventario (id_producto, cantidad)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE cantidad = cantidad + VALUES(cantidad)`,
            [pid, cant]
          );
        }
      }
    }

    // (6) descarga_productos con "restante"
    const resumen = Array.isArray(resumenInventario) ? resumenInventario : [];
    for (const r of resumen) {
      const nombre = r?.nombre;
      const restante = Number(r?.restante || 0);
      if (!nombre) continue;
      const [[p]] = await conn.query(
        `SELECT id FROM productos WHERE LOWER(nombre)=LOWER(?) LIMIT 1`,
        [nombre]
      );
      if (p?.id && restante >= 0) {
        await conn.query(
          `INSERT INTO descarga_productos (id_descarga, id_producto, cantidad)
           VALUES (?,?,?)
           ON DUPLICATE KEY UPDATE cantidad = VALUES(cantidad)`,
          [idDescarga, p.id, restante]
        );
        if (hasInventario && restante > 0) {
          await conn.query(
            `INSERT INTO inventario (id_producto, cantidad)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE cantidad = cantidad + VALUES(cantidad)`,
            [p.id, restante]
          );
        }
      }
    }

    // (7) snapshot/totales en cargas
    const cargasCols = await getExistingColumns('cargas');
    const snapshotCarga = {
      resumen_inventario_json:
        Array.isArray(resumen) && resumen.length ? JSON.stringify(resumen) : null,
      envases_json:
        envases && Object.keys(envases).length ? JSON.stringify(envases) : null,
      devoluciones_sistema_json:
        Array.isArray(devolucionesSistema) && devolucionesSistema.length
          ? JSON.stringify(devolucionesSistema)
          : null,
      devoluciones_extras_json:
        Array.isArray(devolucionesExtras) && devolucionesExtras.length
          ? JSON.stringify(devolucionesExtras)
          : null,
      faltantes_ruta_json:
        Array.isArray(faltantesRuta) && faltantesRuta.length
          ? JSON.stringify(faltantesRuta)
          : null,
      totales_json:  totales ? JSON.stringify(totales) : null,
      totales_texto: typeof totalesTexto === 'string' && totalesTexto.length ? totalesTexto : null,
    };
    const upd = buildDynamicUpdate('cargas', snapshotCarga, cargasCols, 'WHERE id = ?', [idCarga]);
    if (upd) await conn.query(upd.sql, upd.params);

    // (8) Saldos posteriores
    let saldoPosterior = { cajaChica: null, cajaGrande: null, cubeta: null };
    if (idVendedor && src.mode !== 'none') {
      const idCol = src.idCol;
      const mkAgg = (id) =>
        id ? `SUM(CASE WHEN ${idCol}=${db.escape(id)} AND tipo='prestamo'    THEN cantidad ELSE 0 END) AS sal_${id},
              SUM(CASE WHEN ${idCol}=${db.escape(id)} AND tipo='recoleccion' THEN cantidad ELSE 0 END) AS ent_${id}`
           : `0 AS sal_null_${Math.random().toString(36).slice(2)}, 0 AS ent_null_${Math.random().toString(36).slice(2)}`;

      const [[s]] = await conn.query(
        `
        SELECT
          ${mkAgg(chica)},
          ${mkAgg(grande)},
          ${mkAgg(cubeta)}
        FROM prestamos_cajas
        WHERE id_vendedor = ?`,
        [idVendedor]
      );

      const vals = Object.values(s || {});
      let i = 0;

      let chicaSal = 0, chicaEnt = 0;
      let grandeSal = 0, grandeEnt = 0;
      let cubetaSal = 0, cubetaEnt = 0;

      if (chica)  { chicaSal  = Number(vals[i++] || 0); chicaEnt  = Number(vals[i++] || 0); } else { i += 2; }
      if (grande) { grandeSal = Number(vals[i++] || 0); grandeEnt = Number(vals[i++] || 0); } else { i += 2; }
      if (cubeta) { cubetaSal = Number(vals[i++] || 0); cubetaEnt = Number(vals[i++] || 0); } else { i += 2; }

      saldoPosterior = {
        cajaChica:  { debe: Math.max(0, chicaSal  - chicaEnt),  aFavor: Math.max(0, chicaEnt  - chicaSal) },
        cajaGrande: { debe: Math.max(0, grandeSal - grandeEnt), aFavor: Math.max(0, grandeEnt - grandeSal) },
        cubeta:     { debe: Math.max(0, cubetaSal - cubetaEnt), aFavor: Math.max(0, cubetaEnt - cubetaSal) },
      };
    }

    /* ================== Cerrar ================== */

    await conn.query(
      `UPDATE cargas
          SET procesada = 1,
              lista_para_confirmar = 0,
              lista_para_procesar  = 0
        WHERE id = ?`,
      [idCarga]
    );

    await conn.query(
      ` UPDATE detalle_pedido
    SET ventas = GREATEST(
          ventas,
          GREATEST(cantidad_inicial - COALESCE(devoluciones,0), 0)
        )
  WHERE carga_id = ?`,
      [idCarga]
    );

    if (idVendedor && await tableExists('inventario_vendedor')) {
      await conn.query(
        `UPDATE inventario_vendedor
            SET cantidad_restante = 0,
                cerrado = 1,
                cerrado_en = NOW()
          WHERE id_vendedor = ?
            AND fecha_dia   = DATE(?)`,
        [idVendedor, carga.fecha]
      );
    }

    if (await tableExists('descargas_snapshot')) {
      const snapshot = {
        idDescarga,
        idCarga,
        fecha: new Date().toISOString(),
        unidad,
        envases,
        devolucionesSistema,
        devolucionesExtras,
        faltantesRuta,
        totales,
        totalesTexto,
        resumenInventario,
        saldoPosterior
      };
      try {
        await conn.query(
          `INSERT INTO descargas_snapshot (descarga_id, snapshot_json, creado_en)
           VALUES (?,?, NOW())`,
          [idDescarga, JSON.stringify(snapshot)]
        );
      } catch (eSnap) {
        console.warn('[descarga:snapshot] no se pudo guardar:', eSnap?.message);
      }
    }

    await conn.commit();
    res.json({ ok: true, descargaId: String(idDescarga), saldoPosterior });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    console.error('[confirmarRevision] ERROR:', e?.code, e?.sqlMessage || e?.message);
    res.status(500).json({ ok: false, error: 'Error al confirmar' });
  } finally {
    try { conn.release(); } catch {}
  }
}

/* ==================== Descargas (consulta/estado) ==================== */

export async function listarDescargasPendientes(req, res) {
  try {
    const descargaId = req.query.descargaId ? Number(req.query.descargaId) : null;

    const params = [];
    let where = 'd.procesada=0 AND d.lista_para_confirmar=1';
    if (descargaId) { where += ' AND d.id=?'; params.push(descargaId); }

    const [rows] = await db.query(
      `
      SELECT d.id, d.id_camioneta, d.id_usuario, d.fecha,
             u.nombre AS nombreUsuario,
             cam.marca, cam.modelo, cam.placa, cam.kilometraje_actual
        FROM descargas d
   LEFT JOIN usuarios  u   ON u.id = d.id_usuario
   LEFT JOIN camionetas cam ON cam.id = d.id_camioneta
       WHERE ${where}
    ORDER BY d.fecha DESC, d.id DESC
      `,
      params
    );

    const hasLiga = await tableExists('descargas_devoluciones');
    const cat = await getCategoriaSource();

    const data = [];
    for (const r of rows) {
      // productos de la descarga + categoría
      let prodSql = `
        SELECT dp.id_producto, p.nombre, dp.cantidad`;
      if (cat.ok) {
        prodSql += `, p.${cat.prodCol} AS categoriaId, cat.${cat.nombreCol} AS categoriaNombre`;
      } else {
        prodSql += `, NULL AS categoriaId, NULL AS categoriaNombre`;
      }
      prodSql += `
          FROM descarga_productos dp
          JOIN productos p ON p.id = dp.id_producto`;
      if (cat.ok) prodSql += ` LEFT JOIN ${cat.table} cat ON cat.${cat.tableId} = p.${cat.prodCol}`;
      prodSql += ` WHERE dp.id_descarga = ? ORDER BY p.nombre ASC`;

      const [prods] = await db.query(prodSql, [r.id]);

      let devoluciones = [];
      if (hasLiga) {
        const [devs] = await db.query(
          `
          SELECT d.id  AS dev_id, dd.motivo AS motivo, d.fecha,
                 p.nombre AS producto, dd.cantidad
            FROM descargas_devoluciones l
            JOIN devoluciones d        ON d.id = l.id_devolucion
            JOIN devolucion_detalle dd ON dd.id_devolucion = d.id
            JOIN productos p           ON p.id = dd.id_producto
           WHERE l.id_descarga = ?
        ORDER BY d.fecha DESC, d.id DESC, p.nombre ASC
          `,
          [r.id]
        );
        devoluciones = devs.map((x) => ({
          docId: String(x.dev_id),
          nombre: x.producto,
          cantidad: Number(x.cantidad || 0),
          motivo: x.motivo || '',
          horaStr: new Date(x.fecha).toTimeString().substring(0, 8),
        }));
      }

      // Cajas ligadas
      let cajasDescarga = null;
      const pcCols = await getExistingColumns('prestamos_cajas');
      const { src, chica, grande, cubeta } = await getCajaTypeIds();
      if (pcCols.has('descarga_id') && src.mode !== 'none') {
        const idCol = src.idCol;
        const [cx] = await db.query(
          `
          SELECT
            SUM(CASE WHEN ${idCol}=? AND tipo='recoleccion' THEN cantidad ELSE 0 END) AS chica_entr,
            SUM(CASE WHEN ${idCol}=? AND tipo='prestamo'    THEN cantidad ELSE 0 END) AS chica_sal,
            SUM(CASE WHEN ${idCol}=? AND tipo='recoleccion' THEN cantidad ELSE 0 END) AS grande_entr,
            SUM(CASE WHEN ${idCol}=? AND tipo='prestamo'    THEN cantidad ELSE 0 END) AS grande_sal,
            SUM(CASE WHEN ${idCol}=? AND tipo='recoleccion' THEN cantidad ELSE 0 END) AS cubeta_entr,
            SUM(CASE WHEN ${idCol}=? AND tipo='prestamo'    THEN cantidad ELSE 0 END) AS cubeta_sal
          FROM prestamos_cajas
          WHERE descarga_id = ?`,
          [chica, chica, grande, grande, cubeta, cubeta, r.id]
        );
        const row = cx?.[0] || {};
        cajasDescarga = {
          cajaChicaEntradas:  Number(row.chica_entr  || 0),
          cajaChicaSalidas:   Number(row.chica_sal   || 0),
          cajaGrandeEntradas: Number(row.grande_entr || 0),
          cajaGrandeSalidas:  Number(row.grande_sal  || 0),
          cubetaEntradas:     Number(row.cubeta_entr || 0),
          cubetaSalidas:      Number(row.cubeta_sal  || 0),
        };
      }

      data.push({
        id: String(r.id),
        fechaMillis: r.fecha ? new Date(r.fecha).getTime() : null,
        usuarioNombre: r.nombreUsuario || '—',
        camioneta: r.marca && r.modelo ? `${r.marca} ${r.modelo}` : null,
        placas: r.placa || null,
        kilometraje: r.kilometraje_actual ?? null,
        productos: prods.map((p) => ({
          id_producto: p.id_producto,
          nombre: p.nombre,
          cantidad: Number(p.cantidad || 0),
          categoriaId: p.categoriaId != null ? Number(p.categoriaId) : null,
          categoriaNombre: p.categoriaNombre ?? null,
        })),
        devoluciones,
        cajas: cajasDescarga,
      });
    }

    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Error' });
  }
}

export async function obtenerDescargaPorId(req, res) {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id requerido' });

    const [[r]] = await db.query(
      `
      SELECT d.id, d.id_camioneta, d.id_usuario, d.fecha,
             u.nombre AS nombreUsuario,
             cam.marca, cam.modelo, cam.placa, cam.kilometraje_actual
        FROM descargas d
   LEFT JOIN usuarios  u   ON u.id = d.id_usuario
   LEFT JOIN camionetas cam ON cam.id = d.id_camioneta
       WHERE d.id = ?`,
      [id]
    );
    if (!r) return res.status(404).json({ ok: false, error: 'Descarga no encontrada' });

    const cat = await getCategoriaSource();

    let prodSql = `
      SELECT dp.id_producto, p.nombre, dp.cantidad`;
    if (cat.ok) {
      prodSql += `, p.${cat.prodCol} AS categoriaId, cat.${cat.nombreCol} AS categoriaNombre`;
    } else {
      prodSql += `, NULL AS categoriaId, NULL AS categoriaNombre`;
    }
    prodSql += `
        FROM descarga_productos dp
        JOIN productos p ON p.id = dp.id_producto`;
    if (cat.ok) prodSql += ` LEFT JOIN ${cat.table} cat ON cat.${cat.tableId} = p.${cat.prodCol}`;
    prodSql += ` WHERE dp.id_descarga = ? ORDER BY p.nombre ASC`;

    const [prods] = await db.query(prodSql, [id]);

    const hasLiga = await tableExists('descargas_devoluciones');
    let devoluciones = [];
    if (hasLiga) {
      const [devs] = await db.query(
        `
        SELECT d.id  AS dev_id, dd.motivo AS motivo, d.fecha,
               p.nombre AS producto, dd.cantidad
          FROM descargas_devoluciones l
          JOIN devoluciones d        ON d.id = l.id_devolucion
          JOIN devolucion_detalle dd ON dd.id_devolucion = d.id
          JOIN productos p           ON p.id = dd.id_producto
         WHERE l.id_descarga = ?
      ORDER BY d.fecha DESC, d.id DESC, p.nombre ASC`,
        [id]
      );
      devoluciones = devs.map((x) => ({
        docId: String(x.dev_id),
        nombre: x.producto,
        cantidad: Number(x.cantidad || 0),
        motivo: x.motivo || '',
        horaStr: new Date(x.fecha).toTimeString().substring(0, 8),
      }));
    }

    // Cajas ligadas
    let cajasDescarga = null;
    const pcCols = await getExistingColumns('prestamos_cajas');
    const { src, chica, grande, cubeta } = await getCajaTypeIds();
    if (pcCols.has('descarga_id') && src.mode !== 'none') {
      const idCol = src.idCol;
      const [cx] = await db.query(
        `
        SELECT
          SUM(CASE WHEN ${idCol}=? AND tipo='recoleccion' THEN cantidad ELSE 0 END) AS chica_entr,
          SUM(CASE WHEN ${idCol}=? AND tipo='prestamo'    THEN cantidad ELSE 0 END) AS chica_sal,
          SUM(CASE WHEN ${idCol}=? AND tipo='recoleccion' THEN cantidad ELSE 0 END) AS grande_entr,
          SUM(CASE WHEN ${idCol}=? AND tipo='prestamo'    THEN cantidad ELSE 0 END) AS grande_sal,
          SUM(CASE WHEN ${idCol}=? AND tipo='recoleccion' THEN cantidad ELSE 0 END) AS cubeta_entr,
          SUM(CASE WHEN ${idCol}=? AND tipo='prestamo'    THEN cantidad ELSE 0 END) AS cubeta_sal
        FROM prestamos_cajas
        WHERE descarga_id = ?`,
        [chica, chica, grande, grande, cubeta, cubeta, id]
      );
      const row = cx?.[0] || {};
      cajasDescarga = {
        cajaChicaEntradas:  Number(row.chica_entr  || 0),
        cajaChicaSalidas:   Number(row.chica_sal   || 0),
        cajaGrandeEntradas: Number(row.grande_entr || 0),
        cajaGrandeSalidas:  Number(row.grande_sal  || 0),
        cubetaEntradas:     Number(row.cubeta_entr || 0),
        cubetaSalidas:      Number(row.cubeta_sal  || 0),
      };
    }

    return res.json({
      ok: true,
      data: {
        id: String(r.id),
        fechaMillis: r.fecha ? new Date(r.fecha).getTime() : null,
        usuarioNombre: r.nombreUsuario || '—',
        camioneta: (r.marca && r.modelo) ? `${r.marca} ${r.modelo}` : null,
        placas: r.placa || null,
        kilometraje: r.kilometraje_actual ?? null,
        productos: prods.map((p) => ({
          id_producto: p.id_producto,
          nombre: p.nombre,
          cantidad: Number(p.cantidad || 0),
          categoriaId: p.categoriaId != null ? Number(p.categoriaId) : null,
          categoriaNombre: p.categoriaNombre ?? null,
        })),
        devoluciones,
        cajas: cajasDescarga,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Error' });
  }
}

/** PATCH estado (descargas) */
export async function patchDescargaEstado(req, res) {
  try {
    const id = toInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id inválido' });

    const procesada = typeof req.body?.procesada === 'boolean' ? req.body.procesada : null;
    const lpc       = typeof req.body?.listaParaConfirmar === 'boolean' ? req.body.listaParaConfirmar : null;

    if (procesada === null && lpc === null) {
      return res.status(400).json({ ok: false, error: 'Nada para actualizar' });
    }

    const sets = [];
    const args = [];
    if (procesada !== null) {
      sets.push('procesada = ?');
      args.push(procesada ? 1 : 0);
      if (procesada) sets.push('lista_para_confirmar = 0');
    }
    if (lpc !== null) {
      sets.push('lista_para_confirmar = ?');
      args.push(lpc ? 1 : 0);
    }
    args.push(id);

    const sql = `UPDATE descargas SET ${sets.join(', ')} WHERE id = ?`;
    const [r] = await db.query(sql, args);
    if (!r.affectedRows) {
      return res.status(404).json({ ok: false, error: 'Descarga no encontrada' });
    }

    const [[row]] = await db.query(
      `SELECT id, id_camioneta, id_usuario, fecha, procesada, lista_para_confirmar
         FROM descargas WHERE id = ?`,
      [id]
    );

    return res.json({ ok: true, data: row });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'Error' });
  }
}

/* ========= Confirmar descarga (finalizar flujo) ========= */
export async function confirmarDescarga(req, res) {
  const conn = await db.getConnection();
  try {
    const id = Number(req.params.id);
    if (!id) {
      conn.release();
      return res.status(400).json({ ok: false, error: 'id inválido' });
    }

    await conn.beginTransaction();

    // Lock descarga
    const [[d]] = await conn.query(
      `SELECT id, id_camioneta, id_usuario, fecha, procesada, lista_para_confirmar
         FROM descargas
        WHERE id = ? FOR UPDATE`,
      [id]
    );
    if (!d) {
      await conn.rollback();
      conn.release();
      return res.status(404).json({ ok: false, error: 'Descarga no encontrada' });
    }
    if (Number(d.procesada) === 1) {
      await conn.commit();
      conn.release();
      return res.json({ ok: true, data: { id: String(d.id), procesada: 1, lista_para_confirmar: 0 } });
    }

    // Snapshot productos (con categoría)
    const cat = await getCategoriaSource();

    let prodSql = `
      SELECT dp.id_producto, p.nombre, dp.cantidad`;
    if (cat.ok) {
      prodSql += `, p.${cat.prodCol} AS categoriaId, cat.${cat.nombreCol} AS categoriaNombre`;
    } else {
      prodSql += `, NULL AS categoriaId, NULL AS categoriaNombre`;
    }
    prodSql += `
        FROM descarga_productos dp
        JOIN productos p ON p.id = dp.id_producto`;
    if (cat.ok) prodSql += ` LEFT JOIN ${cat.table} cat ON cat.${cat.tableId} = p.${cat.prodCol}`;
    prodSql += ` WHERE dp.id_descarga = ? ORDER BY p.nombre ASC`;

    const [prods] = await conn.query(prodSql, [id]);

    const hasLiga = await tableExists('descargas_devoluciones');

    let devoluciones = [];
    if (hasLiga) {
      const [devs] = await conn.query(
        `
        SELECT d.id  AS dev_id, dd.motivo AS motivo, d.fecha,
               p.nombre AS producto, dd.cantidad
          FROM descargas_devoluciones l
          JOIN devoluciones d        ON d.id = l.id_devolucion
          JOIN devolucion_detalle dd ON dd.id_devolucion = d.id
          JOIN productos p           ON p.id = dd.id_producto
         WHERE l.id_descarga = ?
      ORDER BY d.fecha DESC, d.id DESC, p.nombre ASC
        `,
        [id]
      );
      devoluciones = devs.map((x) => ({
        docId: String(x.dev_id),
        nombre: x.producto,
        cantidad: Number(x.cantidad || 0),
        motivo: x.motivo || '',
        fecha: x.fecha,
      }));

      const idsToMark = devoluciones.map(dv => Number(dv.docId)).filter(Boolean);
      if (idsToMark.length) {
        await conn.query(
          `UPDATE devoluciones
              SET procesada = 1, actualizado_en = NOW()
            WHERE id IN (${idsToMark.map(() => '?').join(',')})`,
          idsToMark
        );
      }

      await conn.query(
        `UPDATE devoluciones d
           JOIN descargas_devoluciones l ON l.id_devolucion = d.id
            SET d.procesada = 1,
                d.actualizado_en = NOW()
          WHERE l.id_descarga = ?`,
        [id]
      );
    }

    let cajas = null;
    const pcCols = await getExistingColumns('prestamos_cajas');
    const { src, chica, grande, cubeta } = await getCajaTypeIds();
    if (pcCols.has('descarga_id') && src.mode !== 'none') {
      const idCol = src.idCol;
      const [cx] = await conn.query(
        `
        SELECT
          SUM(CASE WHEN ${idCol}=? AND tipo='recoleccion' THEN cantidad ELSE 0 END) AS chica_entr,
          SUM(CASE WHEN ${idCol}=? AND tipo='prestamo'    THEN cantidad ELSE 0 END) AS chica_sal,
          SUM(CASE WHEN ${idCol}=? AND tipo='recoleccion' THEN cantidad ELSE 0 END) AS grande_entr,
          SUM(CASE WHEN ${idCol}=? AND tipo='prestamo'    THEN cantidad ELSE 0 END) AS grande_sal,
          SUM(CASE WHEN ${idCol}=? AND tipo='recoleccion' THEN cantidad ELSE 0 END) AS cubeta_entr,
          SUM(CASE WHEN ${idCol}=? AND tipo='prestamo'    THEN cantidad ELSE 0 END) AS cubeta_sal
        FROM prestamos_cajas
        WHERE descarga_id = ?`,
        [chica, chica, grande, grande, cubeta, cubeta, id]
      );
      const row = cx?.[0] || {};
      cajas = {
        cajaChicaEntradas:  Number(row.chica_entr  || 0),
        cajaChicaSalidas:   Number(row.chica_sal   || 0),
        cajaGrandeEntradas: Number(row.grande_entr || 0),
        cajaGrandeSalidas:  Number(row.grande_sal  || 0),
        cubetaEntradas:     Number(row.cubeta_entr || 0),
        cubetaSalidas:      Number(row.cubeta_sal  || 0),
      };
    }

    const snapshot = {
      descargaId: id,
      fecha: d.fecha,
      productos: (prods || []).map(p => ({
        id_producto: p.id_producto,
        nombre: p.nombre,
        cantidad: Number(p.cantidad || 0),
        categoriaId: p.categoriaId != null ? Number(p.categoriaId) : null,
        categoriaNombre: p.categoriaNombre ?? null,
      })),
      devoluciones,
      cajas,
    };

    if (await tableExists('descargas_snapshot')) {
      await conn.query(
        `INSERT INTO descargas_snapshot (descarga_id, snapshot_json, creado_en)
         VALUES (?,?, NOW())`,
        [id, JSON.stringify(snapshot)]
      );
    }

    const dCols = await getExistingColumns('descargas');
    const sets = ['procesada = 1', 'lista_para_confirmar = 0'];
    if (dCols.has('procesada_en')) sets.push('procesada_en = NOW()');

    await conn.query(
      `UPDATE descargas SET ${sets.join(', ')} WHERE id = ?`,
      [id]
    );

    await conn.commit();
    conn.release();
    return res.json({ ok: true, data: { id: String(id), procesada: 1, lista_para_confirmar: 0 } });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    try { conn.release(); } catch {}
    return res.status(500).json({ ok: false, error: e?.message || 'Error al confirmar descarga' });
  }
}

/* ==================== Helper para CREAR carga ==================== */
export async function registrarPrestamoEnvasesAlCrearCarga(conn, {
  cargaId,
  vendedorId,
  envasesJson
}) {
  const { src, chica, grande, cubeta } = await getCajaTypeIds();
  if (!cargaId || !vendedorId || src.mode === 'none') return;

  const ch = Number(envasesJson?.cajasChicas || 0);
  const gr = Number(envasesJson?.cajasGrandes || 0);
  const cu = Number(envasesJson?.cubetas || 0);
  if (ch <= 0 && gr <= 0 && cu <= 0) return;

  const idCol = src.idCol;

  const insertSql = `
    INSERT INTO prestamos_cajas (id_vendedor, ${idCol}, tipo, cantidad, fecha, carga_id)
    VALUES (?,?,?,?,NOW(),?)`;

  if (ch > 0 && chica)  await conn.query(insertSql, [vendedorId, chica,  'prestamo', ch, cargaId]);
  if (gr > 0 && grande) await conn.query(insertSql, [vendedorId, grande, 'prestamo', gr, cargaId]);
  if (cu > 0 && cubeta) await conn.query(insertSql, [vendedorId, cubeta, 'prestamo', cu, cargaId]);
}
