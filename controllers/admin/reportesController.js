// controllers/admin/reportesController.js
import db from '../../config/db.js';
import ExcelJS from 'exceljs';

/* ========= Helpers ========= */
function range(q) {
  const desde = (q.desde || '').slice(0,10);
  const hasta = (q.hasta || '').slice(0,10);
  return {
    desde: desde || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10),
    hasta: hasta || new Date().toISOString().slice(0,10)
  };
}
function addIf(value, clause, params, arr) {
  if (value != null && value !== '' && value !== '0') {
    arr.push(clause);
    params.push(value);
  }
}
function normalizeGran(s) {
  const m = String(s||'day').toLowerCase().match(/^(day|week|month)/);
  return m ? m[1] : 'day';
}
function logError(tag, e, extraSql) {
  const msg = e?.sqlMessage || e?.message || String(e);
  console.error(`[${tag}]`, msg);
  if (extraSql) console.error(`[${tag}] SQL:`, extraSql);
}

/* =========================
   KPIs
   ========================= */
export async function kpis(req, res, next) {
  try {
    const { desde, hasta } = range(req.query);
    const vendedor_id = req.query.vendedor_id || null;
    const cliente_id  = req.query.cliente_id  || null;
    const producto_id = req.query.producto_id || null;

    // ---- Ventas (con cliente) ----
    const where = ["v.fecha >= ? AND v.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const args  = [desde, hasta];
    addIf(vendedor_id, "v.id_vendedor = ?", args, where);
    addIf(cliente_id,  "v.id_cliente  = ?", args, where);
    const joinDV = producto_id ? "JOIN detalle_venta dv ON dv.id_venta = v.id" : "";
    if (producto_id) addIf(producto_id, "dv.id_producto = ?", args, where);

    const sqlKpiVentas = `
      SELECT
        COUNT(*)               AS numVentas,
        IFNULL(SUM(v.total),0) AS totalVentas,
        IFNULL(AVG(v.total),0) AS ticketPromedio,
        COUNT(DISTINCT v.id_cliente) AS clientesAtendidos
      FROM ventas v
      ${joinDV}
      WHERE ${where.join(" AND ")}
    `;
    const [[k]] = await db.query(sqlKpiVentas, args);

    // ---- Ventas público (sólo sumar al total global) ----
    const whereVP = ["vp.fecha >= ? AND vp.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const argsVP  = [desde, hasta];
    addIf(vendedor_id, "vp.id_vendedor = ?", argsVP, whereVP);
    const [[vpAgg]] = await db.query(
      `SELECT IFNULL(SUM(vp.total),0) AS totalPublico, COUNT(*) AS numPublico
         FROM ventas_publico vp
        WHERE ${whereVP.join(' AND ')}`,
      argsVP
    );

    // Créditos (saldo)
    const whereCred = ["v.fecha >= ? AND v.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const argsCred  = [desde, hasta];
    addIf(vendedor_id, "v.id_vendedor = ?", argsCred, whereCred);
    addIf(cliente_id,  "v.id_cliente  = ?", argsCred, whereCred);
    const sqlCred = `
      SELECT IFNULL(SUM(cr.saldo),0) AS creditoAbierto
        FROM creditos cr
        JOIN ventas v ON v.id = cr.id_venta
       WHERE ${whereCred.join(" AND ")}
    `;
    const [[c]] = await db.query(sqlCred, argsCred);

    // Devoluciones
    const whereDev = ["d.fecha >= ? AND d.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const argsDev  = [desde, hasta];
    addIf(vendedor_id, "d.id_vendedor = ?", argsDev, whereDev);
    addIf(cliente_id,  "d.id_cliente  = ?", argsDev, whereDev);
    const sqlDev = `
      SELECT COUNT(DISTINCT d.id) AS numDevoluciones,
             IFNULL(SUM(dd.cantidad * p.precio),0) AS montoDevoluciones
        FROM devoluciones d
        LEFT JOIN devolucion_detalle dd ON dd.id_devolucion = d.id
        LEFT JOIN productos p ON p.id = dd.id_producto
       WHERE ${whereDev.join(" AND ")}
    `;
    const [[d]] = await db.query(sqlDev, argsDev);

    // Cambios (opcional)
    let numCambios = 0;
    try {
      const whereCamb = ["c.fecha >= ? AND c.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
      const argsCamb  = [desde, hasta];
      addIf(vendedor_id, "c.id_vendedor = ?", argsCamb, whereCamb);
      addIf(cliente_id,  "c.id_cliente  = ?", argsCamb, whereCamb);
      const [[cam]] = await db.query(
        `SELECT COUNT(*) AS numCambios FROM cambios c WHERE ${whereCamb.join(" AND ")}`,
        argsCamb
      );
      numCambios = Number(cam?.numCambios || 0);
    } catch {}

    res.json({
      totalVentas: Number(k.totalVentas || 0) + Number(vpAgg.totalPublico || 0),
      numVentas: Number(k.numVentas || 0) + Number(vpAgg.numPublico || 0),
      ticketPromedio: Number(k.ticketPromedio || 0),
      clientesAtendidos: Number(k.clientesAtendidos || 0),
      creditoAbierto: Number(c.creditoAbierto || 0),
      numDevoluciones: Number(d.numDevoluciones || 0),
      montoDevoluciones: Number(d.montoDevoluciones || 0),
      numCambios
    });
  } catch (e) { logError('kpis', e); next(e); }
}

/* =========================
   SERIE DE VENTAS
   ========================= */
export async function ventasSerie(req, res, next) {
  try {
    const { desde, hasta } = range(req.query);
    const vendedor_id = req.query.vendedor_id || null;
    const cliente_id  = req.query.cliente_id  || null;
    const producto_id = req.query.producto_id || null;
    const gran = normalizeGran(req.query.granularity); // day|week|month

    let groupExpr, labelExpr, orderExpr, groupExprVP, labelExprVP, orderExprVP;
    if (gran === 'month') {
      groupExpr = "DATE_FORMAT(v.fecha,'%Y-%m')";
      labelExpr = "DATE_FORMAT(v.fecha,'%Y-%m')";
      orderExpr = "DATE_FORMAT(v.fecha,'%Y-%m')";
      groupExprVP = "DATE_FORMAT(vp.fecha,'%Y-%m')";
      labelExprVP = "DATE_FORMAT(vp.fecha,'%Y-%m')";
      orderExprVP = "DATE_FORMAT(vp.fecha,'%Y-%m')";
    } else if (gran === 'week') {
      groupExpr = "YEARWEEK(v.fecha, 3)";
      labelExpr = "CONCAT(YEAR(v.fecha), '-W', LPAD(WEEK(v.fecha, 3),2,'0'))";
      orderExpr = "YEAR(v.fecha), WEEK(v.fecha, 3)";
      groupExprVP = "YEARWEEK(vp.fecha, 3)";
      labelExprVP = "CONCAT(YEAR(vp.fecha), '-W', LPAD(WEEK(vp.fecha, 3),2,'0'))";
      orderExprVP = "YEAR(vp.fecha), WEEK(vp.fecha, 3)";
    } else {
      groupExpr = "DATE(v.fecha)";
      labelExpr = "DATE(v.fecha)";
      orderExpr = "DATE(v.fecha)";
      groupExprVP = "DATE(vp.fecha)";
      labelExprVP = "DATE(vp.fecha)";
      orderExprVP = "DATE(vp.fecha)";
    }

    // Ventas con cliente
    const where = ["v.fecha >= ? AND v.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const args  = [desde, hasta];
    addIf(vendedor_id, "v.id_vendedor = ?", args, where);
    addIf(cliente_id,  "v.id_cliente  = ?", args, where);
    const joinDV = producto_id ? "JOIN detalle_venta dv ON dv.id_venta = v.id" : "";
    if (producto_id) addIf(producto_id, "dv.id_producto = ?", args, where);

    // Ventas al público
    const whereVP = ["vp.fecha >= ? AND vp.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const argsVP  = [desde, hasta];
    addIf(vendedor_id, "vp.id_vendedor = ?", argsVP, whereVP);

    const [rows] = await db.query(
      `
      SELECT periodo, SUM(total) AS total, SUM(num) AS num
      FROM (
        SELECT ${labelExpr} AS periodo,
               IFNULL(SUM(v.total),0) AS total,
               COUNT(*) AS num
        FROM ventas v
        ${joinDV}
       WHERE ${where.join(" AND ")}
       GROUP BY ${groupExpr}

       UNION ALL

       SELECT ${labelExprVP} AS periodo,
              IFNULL(SUM(vp.total),0) AS total,
              COUNT(*) AS num
       FROM ventas_publico vp
       WHERE ${whereVP.join(" AND ")}
       GROUP BY ${groupExprVP}
      ) x
      GROUP BY periodo
      ORDER BY periodo
      `,
      [...args, ...argsVP]
    );

    res.json(rows.map(r => ({ periodo: String(r.periodo), total: Number(r.total||0), num: Number(r.num||0) })));
  } catch (e) { logError('ventasSerie', e); next(e); }
}

// Compat
export async function ventasPorDia(req, res, next) {
  try {
    req.query.granularity = 'day';
    return ventasSerie(req, res, next);
  } catch (e) { logError('ventasPorDia', e); next(e); }
}

/* =========================
   Ventas agrupadas
   ========================= */
export async function ventasPorVendedor(req, res, next) {
  try {
    const { desde, hasta } = range(req.query);
    const vendedor_id = req.query.vendedor_id || null;
    const cliente_id  = req.query.cliente_id  || null;
    const producto_id = req.query.producto_id || null;

    const where = ["v.fecha >= ? AND v.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const args  = [desde, hasta];
    addIf(vendedor_id, "v.id_vendedor = ?", args, where);
    addIf(cliente_id,  "v.id_cliente  = ?", args, where);
    const joinDV = producto_id ? "JOIN detalle_venta dv ON dv.id_venta = v.id" : "";
    if (producto_id) addIf(producto_id, "dv.id_producto = ?", args, where);

    const whereVP = ["vp.fecha >= ? AND vp.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const argsVP  = [desde, hasta];
    addIf(vendedor_id, "vp.id_vendedor = ?", argsVP, whereVP);

    const [rows] = await db.query(
      `
      SELECT vendedor, SUM(total) AS total, SUM(num) AS num
      FROM (
        SELECT COALESCE(u.nombre, CONCAT('Vendedor #', v.id_vendedor)) AS vendedor,
               IFNULL(SUM(v.total),0) AS total,
               COUNT(*) AS num
        FROM ventas v
        LEFT JOIN vendedores ven ON ven.id = v.id_vendedor
        LEFT JOIN usuarios u ON u.id = ven.id_usuario
        ${joinDV}
       WHERE ${where.join(" AND ")}
       GROUP BY v.id_vendedor

       UNION ALL

       SELECT COALESCE(u2.nombre, CONCAT('Vendedor #', vp.id_vendedor)) AS vendedor,
              IFNULL(SUM(vp.total),0) AS total,
              COUNT(*) AS num
       FROM ventas_publico vp
       LEFT JOIN vendedores ven2 ON ven2.id = vp.id_vendedor
       LEFT JOIN usuarios u2 ON u2.id = ven2.id_usuario
       WHERE ${whereVP.join(' AND ')}
       GROUP BY vp.id_vendedor
      ) x
      GROUP BY vendedor
      ORDER BY total DESC
      `,
      [...args, ...argsVP]
    );

    res.json(rows.map(r => ({ ...r, total: Number(r.total), num: Number(r.num) })));
  } catch (e) { logError('ventasPorVendedor', e); next(e); }
}

export async function ventasPorCliente(req, res, next) {
  try {
    const { desde, hasta } = range(req.query);
    const vendedor_id = req.query.vendedor_id || null;
    const cliente_id  = req.query.cliente_id  || null;
    const producto_id = req.query.producto_id || null;

    const where = ["v.fecha >= ? AND v.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const args  = [desde, hasta];
    addIf(vendedor_id, "v.id_vendedor = ?", args, where);
    addIf(cliente_id,  "v.id_cliente  = ?", args, where);
    const joinDV = producto_id ? "JOIN detalle_venta dv ON dv.id_venta = v.id" : "";
    if (producto_id) addIf(producto_id, "dv.id_producto = ?", args, where);

    const sql = `
      SELECT COALESCE(c.nombre_empresa, c.clave) AS cliente,
             IFNULL(SUM(v.total),0) AS total,
             COUNT(*) AS num
        FROM ventas v
        JOIN clientes c ON c.id = v.id_cliente
        ${joinDV}
       WHERE ${where.join(" AND ")}
       GROUP BY v.id_cliente
       ORDER BY total DESC
    `;
    const [rows] = await db.query(sql, args);
    res.json(rows.map(r => ({ ...r, total: Number(r.total), num: Number(r.num) })));
  } catch (e) { logError('ventasPorCliente', e); next(e); }
}

export async function topProductos(req, res, next) {
  try {
    const { desde, hasta } = range(req.query);
    const vendedor_id = req.query.vendedor_id || null;
    const cliente_id  = req.query.cliente_id  || null;
    const producto_id = req.query.producto_id || null;

    const whereV = ["v.fecha >= ? AND v.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const argsV  = [desde, hasta];
    addIf(vendedor_id, "v.id_vendedor = ?", argsV, whereV);
    addIf(cliente_id,  "v.id_cliente  = ?", argsV, whereV);
    if (producto_id) addIf(producto_id, "dv.id_producto = ?", argsV, whereV);

    const whereVP = ["vp.fecha >= ? AND vp.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const argsVP  = [desde, hasta];
    addIf(vendedor_id, "vp.id_vendedor = ?", argsVP, whereVP);
    if (producto_id) addIf(producto_id, "vpd.producto_id = ?", argsVP, whereVP);

    const [rows] = await db.query(
      `
      SELECT id_producto, producto, categoria, color, SUM(cantidad) AS cantidad, SUM(total) AS total
      FROM (
        SELECT 
          p.id   AS id_producto,
          p.nombre AS producto,
          COALESCE(cat.nombre, 'Sin categoría') AS categoria,
          p.color AS color,
          IFNULL(SUM(dv.cantidad),0) AS cantidad,
          IFNULL(SUM(dv.cantidad * dv.precio),0) AS total
        FROM ventas v
        JOIN detalle_venta dv        ON dv.id_venta = v.id
        JOIN productos p             ON p.id       = dv.id_producto
        LEFT JOIN categorias_productos cat ON cat.id = p.categoria_id
        WHERE ${whereV.join(" AND ")}
        GROUP BY p.id, p.nombre, cat.nombre, p.color

        UNION ALL

        SELECT 
          p2.id   AS id_producto,
          p2.nombre AS producto,
          COALESCE(cat2.nombre, 'Sin categoría') AS categoria,
          p2.color AS color,
          IFNULL(SUM(vpd.cantidad),0) AS cantidad,
          IFNULL(SUM(vpd.cantidad * vpd.precio_unitario),0) AS total
        FROM ventas_publico vp
        JOIN ventas_publico_detalle vpd ON vpd.venta_publico_id = vp.id
        JOIN productos p2               ON p2.id = vpd.producto_id
        LEFT JOIN categorias_productos cat2 ON cat2.id = p2.categoria_id
        WHERE ${whereVP.join(' AND ')}
        GROUP BY p2.id, p2.nombre, cat2.nombre, p2.color
      ) t
      GROUP BY id_producto, producto, categoria, color
      ORDER BY total DESC, cantidad DESC
      LIMIT 50
      `,
      [...argsV, ...argsVP]
    );

    res.json(rows.map(r => ({
      id_producto: r.id_producto,
      producto: r.producto,
      categoria: r.categoria,
      color: r.color || null,
      cantidad: Number(r.cantidad||0),
      total: Number(r.total||0)
    })));
  } catch (e) { logError('topProductos', e); next(e); }
}

/* ========= NUEVO: Productos agrupados por categoría ========= */
export async function productosPorCategoria(req, res, next) {
  try {
    const { activos } = req.query; // opcional: ?activos=1 para sólo activos
    const where = ['p.eliminado = 0'];
    const params = [];
    if (activos != null) {
      where.push('p.activo = ?');
      params.push(Number(!!activos));
    }

    const sql = `
      SELECT
        p.id,
        p.nombre,
        p.precio,
        p.precio_mayoreo,
        p.codigo,
        p.activo,
        COALESCE(c.nombre, 'Sin categoría') AS categoria
      FROM productos p
      LEFT JOIN categorias_productos c ON c.id = p.categoria_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.nombre ASC, p.nombre ASC, p.fecha_registro DESC
    `;
    const [rows] = await db.query(sql, params);

    // Agrupar en JS para impresión bonita
    const byCat = new Map();
    for (const r of rows) {
      const k = r.categoria || 'Sin categoría';
      if (!byCat.has(k)) byCat.set(k, []);
      byCat.get(k).push({
        id: r.id,
        nombre: r.nombre,
        precio: Number(r.precio||0),
        precio_mayoreo: Number(r.precio_mayoreo||0),
        codigo: r.codigo || '',
        activo: Number(r.activo||0) === 1
      });
    }
    const payload = [...byCat.entries()].map(([categoria, productos]) => ({ categoria, productos }));
    res.json(payload);
  } catch (e) { logError('productosPorCategoria', e); next(e); }
}

export async function detalleVentas(req, res, next) {
  try {
    const { desde, hasta } = range(req.query);
    const vendedor_id = req.query.vendedor_id || null;
    const cliente_id  = req.query.cliente_id  || null;
    const producto_id = req.query.producto_id || null;

    const whereV = ["v.fecha >= ? AND v.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const argsV  = [desde, hasta];
    addIf(vendedor_id, "v.id_vendedor = ?", argsV, whereV);
    addIf(cliente_id,  "v.id_cliente  = ?", argsV, whereV);
    const joinDV = producto_id ? "JOIN detalle_venta dv ON dv.id_venta = v.id" : "";
    if (producto_id) addIf(producto_id, "dv.id_producto = ?", argsV, whereV);

    const whereVP = ["vp.fecha >= ? AND vp.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const argsVP  = [desde, hasta];
    addIf(vendedor_id, "vp.id_vendedor = ?", argsVP, whereVP);

    const [rows] = await db.query(
      `
      SELECT id, fecha, tipo_pago, total, vendedor, cliente
      FROM (
        SELECT v.id, v.fecha, v.tipo_pago, v.total,
               COALESCE(uv.nombre, CONCAT('Vendedor #', v.id_vendedor)) AS vendedor,
               COALESCE(c.nombre_empresa, c.clave) AS cliente
        FROM ventas v
        LEFT JOIN clientes c ON c.id = v.id_cliente
        LEFT JOIN vendedores ven ON ven.id = v.id_vendedor
        LEFT JOIN usuarios uv ON uv.id = ven.id_usuario
        ${joinDV}
       WHERE ${whereV.join(" AND ")}

       UNION ALL

       SELECT vp.id, vp.fecha, 'publico' AS tipo_pago, vp.total,
              COALESCE(uv2.nombre, CONCAT('Vendedor #', vp.id_vendedor)) AS vendedor,
              'PÚBLICO GENERAL' AS cliente
       FROM ventas_publico vp
       LEFT JOIN vendedores ven2 ON ven2.id = vp.id_vendedor
       LEFT JOIN usuarios uv2 ON uv2.id = ven2.id_usuario
       WHERE ${whereVP.join(' AND ')}
      ) x
      ORDER BY fecha DESC, id DESC
      LIMIT 2000
      `,
      [...argsV, ...argsVP]
    );
    res.json(rows.map(r => ({ ...r, total: Number(r.total||0) })));
  } catch (e) { logError('detalleVentas', e); next(e); }
}

/* =========================
   Créditos
   ========================= */
export async function creditosSaldos(req, res, next) {
  try {
    const { desde, hasta } = range(req.query);
    const vendedor_id = req.query.vendedor_id || null;
    const cliente_id  = req.query.cliente_id  || null;

    const whereC = ["v.fecha >= ? AND v.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const argsC  = [desde, hasta];
    addIf(vendedor_id, "v.id_vendedor = ?", argsC, whereC);
    addIf(cliente_id,  "v.id_cliente  = ?", argsC, whereC);

    const sql = `
      SELECT cli.id AS cliente_id,
             COALESCE(cli.nombre_empresa, cli.clave) AS cliente,
             IFNULL(SUM(pc.total_pagos),0) AS total_pagos,
             IFNULL(SUM(cr.saldo),0) AS saldo_pendiente
        FROM creditos cr
        JOIN ventas v     ON v.id  = cr.id_venta
        JOIN clientes cli ON cli.id = v.id_cliente
        LEFT JOIN (
          SELECT id_credito, SUM(monto) AS total_pagos
          FROM pagos_credito
          GROUP BY id_credito
        ) pc ON pc.id_credito = cr.id
       WHERE ${whereC.join(" AND ")}
       GROUP BY cli.id
       ORDER BY saldo_pendiente DESC
    `;
    const [rows] = await db.query(sql, argsC);
    res.json(rows.map(r => ({
      cliente_id: r.cliente_id,
      cliente: r.cliente,
      total_pagos: Number(r.total_pagos||0),
      saldo_pendiente: Number(r.saldo_pendiente||0),
      total_creditos: Number((Number(r.total_pagos||0) + Number(r.saldo_pendiente||0)).toFixed(2))
    })));
  } catch (e) { logError('creditosSaldos', e); next(e); }
}

export async function creditosAbiertos(req, res, next) {
  try {
    const vendedor_id = req.query.vendedor_id || null;
    const cliente_id  = req.query.cliente_id  || null;

    const where = ["cr.saldo > 0"];
    const args  = [];
    addIf(vendedor_id, "v.id_vendedor = ?", args, where);
    addIf(cliente_id,  "v.id_cliente  = ?", args, where);

    const sql = `
      SELECT cli.id AS cliente_id,
             COALESCE(cli.nombre_empresa, cli.clave) AS cliente,
             COUNT(*) AS creditos_abiertos,
             IFNULL(SUM(cr.saldo),0) AS saldo_credito
        FROM creditos cr
        JOIN ventas v     ON v.id  = cr.id_venta
        JOIN clientes cli ON cli.id = v.id_cliente
       WHERE ${where.join(" AND ")}
       GROUP BY cli.id
       ORDER BY saldo_credito DESC
    `;
    const [rows] = await db.query(sql, args);
    res.json(rows.map(r => ({
      cliente_id: r.cliente_id,
      cliente: r.cliente,
      creditos_abiertos: Number(r.creditos_abiertos||0),
      saldo_credito: Number(r.saldo_credito||0)
    })));
  } catch (e) { logError('creditosAbiertos', e); next(e); }
}

export async function pagosRecientes(req, res, next) {
  try {
    const { desde, hasta } = range(req.query);
    const vendedor_id = req.query.vendedor_id || null;
    const cliente_id  = req.query.cliente_id  || null;

    const where = ["p.fecha >= ? AND p.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const args  = [desde, hasta];
    addIf(vendedor_id, "v.id_vendedor = ?", args, where);
    addIf(cliente_id,  "v.id_cliente  = ?", args, where);

    const sql = `
      SELECT p.fecha, COALESCE(cli.nombre_empresa, cli.clave) AS cliente,
             p.monto, p.tipo_pago, p.referencia
        FROM pagos_credito p
        JOIN creditos cr ON cr.id = p.id_credito
        JOIN ventas v ON v.id = cr.id_venta
        JOIN clientes cli ON cli.id = v.id_cliente
       WHERE ${where.join(" AND ")}
       ORDER BY p.fecha DESC
       LIMIT 2000
    `;
    const [rows] = await db.query(sql, args);
    res.json(rows.map(r => ({ ...r, monto: Number(r.monto||0) })));
  } catch (e) { logError('pagosRecientes', e); next(e); }
}

/* =========================
   Rutas
   ========================= */
export async function rutasCumplimiento(req, res, next) {
  try {
    const { desde, hasta } = range(req.query);
    const vendedor_id = req.query.vendedor_id || null;

    const where = ["r.fecha >= ? AND r.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const args  = [desde, hasta];
    addIf(vendedor_id, "r.id_vendedor = ?", args, where);

    const sql = `
      SELECT COALESCE(u.nombre, CONCAT('Vendedor #', r.id_vendedor)) AS vendedor,
             COUNT(rc.id) AS programadas,
             SUM(CASE WHEN rc.scaneado = 1 THEN 1 ELSE 0 END) AS escaneadas
        FROM rutas_diarias r
        LEFT JOIN rutas_clientes rc ON rc.id_ruta = r.id
        LEFT JOIN vendedores ven ON ven.id = r.id_vendedor
        LEFT JOIN usuarios u ON u.id = ven.id_usuario
       WHERE ${where.join(" AND ")}
       GROUP BY r.id_vendedor
       ORDER BY vendedor ASC
    `;
    const [rows] = await db.query(sql, args);
    const mapped = rows.map(r => {
      const programadas = Number(r.programadas||0);
      const escaneadas  = Number(r.escaneadas||0);
      const porcentaje  = programadas ? Number(((escaneadas*100)/programadas).toFixed(2)) : 0;
      return { vendedor: r.vendedor, programadas, escaneadas, porcentaje };
    });
    res.json(mapped);
  } catch (e) { logError('rutasCumplimiento', e); next(e); }
}

export async function rutasListado(req, res, next) {
  try {
    const { desde, hasta } = range(req.query);
    const vendedor_id = req.query.vendedor_id || null;

    const where = ["r.fecha >= ? AND r.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const args  = [desde, hasta];
    addIf(vendedor_id, "r.id_vendedor = ?", args, where);

    const sql = `
      SELECT r.id, r.fecha, r.estado,
             COALESCE(u.nombre, CONCAT('Vendedor #', r.id_vendedor)) AS vendedor,
             COUNT(rc.id) AS paradas,
             SUM(CASE WHEN rc.scaneado = 1 THEN 1 ELSE 0 END) AS escaneadas
        FROM rutas_diarias r
        LEFT JOIN rutas_clientes rc ON rc.id_ruta = r.id
        LEFT JOIN vendedores ven ON ven.id = r.id_vendedor
        LEFT JOIN usuarios u ON u.id = ven.id_usuario
       WHERE ${where.join(" AND ")}
       GROUP BY r.id
       ORDER BY r.fecha DESC, r.id DESC
       LIMIT 5000
    `;
    const [rows] = await db.query(sql, args);
    res.json(rows.map(r => ({
      id: r.id, fecha: r.fecha, vendedor: r.vendedor, estado: r.estado,
      paradas: Number(r.paradas||0), escaneadas: Number(r.escaneadas||0)
    })));
  } catch (e) { logError('rutasListado', e); next(e); }
}

/* =========================
   Inventario
   ========================= */
export async function inventarioRotacion(req, res, next) {
  try {
    const { desde, hasta } = range(req.query);
    const vendedor_id = req.query.vendedor_id || null;
    const producto_id = req.query.producto_id || null;

    const where = ["iv.fecha_dia >= ? AND iv.fecha_dia < DATE_ADD(?, INTERVAL 1 DAY)"];
    const args  = [desde, hasta];
    addIf(vendedor_id, "iv.id_vendedor = ?", args, where);
    addIf(producto_id, "iv.id_producto = ?", args, where);

    const sql = `
      SELECT p.nombre AS producto,
             SUM(iv.cantidad_inicial) AS cargado,
             SUM(iv.cantidad_vendida) AS vendido,
             SUM(iv.cantidad_restante) AS restante
        FROM inventario_vendedor iv
        JOIN productos p ON p.id = iv.id_producto
       WHERE ${where.join(" AND ")}
       GROUP BY iv.id_producto
       ORDER BY producto ASC
    `;
    const [rows] = await db.query(sql, args);
    res.json(rows.map(r => ({
      producto: r.producto,
      cargado: Number(r.cargado||0),
      vendido: Number(r.vendido||0),
      restante: Number(r.restante||0)
    })));
  } catch (e) { logError('inventarioRotacion', e); next(e); }
}

export async function inventarioActual(req, res, next) {
  try {
    const producto_id = req.query.producto_id || null;

    const where = [];
    const args  = [];
    addIf(producto_id, "i.id_producto = ?", args, where);

    const sql = `
      SELECT p.nombre AS producto, i.cantidad
        FROM inventario i
        JOIN productos p ON p.id = i.id_producto
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY p.nombre ASC
    `;
    const [rows] = await db.query(sql, args);
    res.json(rows.map(r => ({ producto: r.producto, cantidad: Number(r.cantidad||0) })));
  } catch (e) { logError('inventarioActual', e); next(e); }
}

/* =========================
   Devoluciones
   ========================= */
export async function devolucionesPorMotivo(req, res, next) {
  try {
    const { desde, hasta } = range(req.query);
    const vendedor_id = req.query.vendedor_id || null;
    const cliente_id  = req.query.cliente_id  || null;

    const where = ["d.fecha >= ? AND d.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const args  = [desde, hasta];
    addIf(vendedor_id, "d.id_vendedor = ?", args, where);
    addIf(cliente_id,  "d.id_cliente  = ?", args, where);

    const sql = `
      SELECT d.motivo, SUM(dd.cantidad) AS cantidad
        FROM devoluciones d
        JOIN devolucion_detalle dd ON dd.id_devolucion = d.id
       WHERE ${where.join(" AND ")}
       GROUP BY d.motivo
       ORDER BY cantidad DESC
    `;
    const [rows] = await db.query(sql, args);
    res.json(rows.map(r => ({ motivo: r.motivo, cantidad: Number(r.cantidad||0) })));
  } catch (e) { logError('devolucionesPorMotivo', e); next(e); }
}

export async function devolucionesDetalle(req, res, next) {
  try {
    const { desde, hasta } = range(req.query);
    const vendedor_id = req.query.vendedor_id || null;
    const cliente_id  = req.query.cliente_id  || null;

    const where = ["d.fecha >= ? AND d.fecha < DATE_ADD(?, INTERVAL 1 DAY)"];
    const args  = [desde, hasta];
    addIf(vendedor_id, "d.id_vendedor = ?", args, where);
    addIf(cliente_id,  "d.id_cliente  = ?", args, where);

    const sql = `
      SELECT d.id, d.fecha, d.motivo,
             COALESCE(uv.nombre, CONCAT('Vendedor #', d.id_vendedor)) AS vendedor,
             COALESCE(cli.nombre_empresa, cli.clave) AS cliente,
             SUM(dd.cantidad * p.precio) AS total
        FROM devoluciones d
        LEFT JOIN devolucion_detalle dd ON dd.id_devolucion = d.id
        LEFT JOIN productos p ON p.id = dd.id_producto
        LEFT JOIN vendedores ven ON ven.id = d.id_vendedor
        LEFT JOIN usuarios uv ON uv.id = ven.id_usuario
        LEFT JOIN clientes cli ON cli.id = d.id_cliente
       WHERE ${where.join(" AND ")}
       GROUP BY d.id
       ORDER BY d.fecha DESC, d.id DESC
       LIMIT 2000
    `;
    const [rows] = await db.query(sql, args);
    res.json(rows.map(r => ({ ...r, total: r.total != null ? Number(r.total) : null })));
  } catch (e) { logError('devolucionesDetalle', e); next(e); }
}

/* =========================
   Gasolina
   ========================= */
export async function gasolinaConsumo(req, res, next) {
  try {
    const { desde, hasta } = range(req.query);
    const sql = `
      SELECT COALESCE(ca.placa, CONCAT('Camioneta #', cg.id_camioneta)) AS camioneta,
             AVG(cg.consumo_por_km) AS consumo_por_km
        FROM consumo_gasolina cg
        LEFT JOIN camionetas ca ON ca.id = cg.id_camioneta
       WHERE cg.fecha_inicio < DATE_ADD(?, INTERVAL 1 DAY) AND cg.fecha_fin >= ?
       GROUP BY cg.id_camioneta
       ORDER BY camioneta ASC
    `;
    const [rows] = await db.query(sql, [hasta, desde]);
    res.json(rows.map(r => ({ camioneta: r.camioneta, consumo_por_km: Number(r.consumo_por_km||0) })));
  } catch (e) { logError('gasolinaConsumo', e); next(e); }
}

export async function gasolinaRegistros(req, res, next) {
  try {
    const { desde, hasta } = range(req.query);
    const sql = `
      SELECT rg.fecha, COALESCE(ca.placa, CONCAT('Camioneta #', rg.id_camioneta)) AS camioneta,
             rg.kilometraje, rg.litros_cargados, rg.costo
        FROM registros_gasolina rg
        LEFT JOIN camionetas ca ON ca.id = rg.id_camioneta
       WHERE rg.fecha >= ? AND rg.fecha < DATE_ADD(?, INTERVAL 1 DAY)
       ORDER BY rg.fecha DESC, rg.id DESC
       LIMIT 3000
    `;
    const [rows] = await db.query(sql, [desde, hasta]);
    res.json(rows.map(r => ({
      fecha: r.fecha,
      camioneta: r.camioneta,
      kilometraje: Number(r.kilometraje||0),
      litros_cargados: Number(r.litros_cargados||0),
      costo: Number(r.costo||0)
    })));
  } catch (e) { logError('gasolinaRegistros', e); next(e); }
}

/* =========================
   Exportaciones CSV / HTML
   ========================= */

// CSV compatible con Excel (BOM, CRLF, y sep=, en primera línea)
function toCSV(rows, headers, { sep = ",", excelSepLine = true } = {}) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return (s.includes('"') || s.includes('\n') || s.includes('\r') || s.includes(sep))
      ? `"${s.replace(/"/g,'""')}"` 
      : s;
  };
  const lines = [];
  if (excelSepLine) lines.push(`sep=${sep}`);
  lines.push(headers.join(sep));
  for (const r of rows) lines.push(headers.map(h => esc(r[h])).join(sep));
  return '\uFEFF' + lines.join('\r\n'); // BOM + CRLF
}

async function collectDataset(req, res, next, ds) {
  const fakeReq = { query: req.query };
  let rows = [], headers = [];
  const collect = async (fn) => {
    let data;
    const fakeRes = { json: (d) => { data = d; } };
    await fn(fakeReq, fakeRes, next);
    return data || [];
  };

  if (ds === 'ventas_serie') {
    rows = await collect(ventasSerie);
    headers = ['periodo','total','num'];
  } else if (ds === 'ventas_vendedor') {
    rows = await collect(ventasPorVendedor);
    headers = ['vendedor','total','num'];
  } else if (ds === 'ventas_cliente') {
    rows = await collect(ventasPorCliente);
    headers = ['cliente','total','num'];
  } else if (ds === 'top_productos') {
    rows = await collect(topProductos);
    headers = ['producto','total','cantidad'];
  } else if (ds === 'rutas_cumplimiento') {
    rows = await collect(rutasCumplimiento);
    headers = ['vendedor','programadas','escaneadas','porcentaje'];
  } else if (ds === 'creditos_saldos') {
    rows = await collect(creditosSaldos);
    headers = ['cliente_id','cliente','total_creditos','total_pagos','saldo_pendiente'];
  } else {
    return { error: 'dataset no soportado' };
  }
  return { rows, headers };
}

export async function exportCsv(req, res, next) {
  try {
    const ds = String(req.query.dataset || '').toLowerCase();
    if (!ds) return res.status(400).json({ error: 'dataset es obligatorio' });

    const { rows, headers, error } = await collectDataset(req, res, next, ds);
    if (error) return res.status(400).json({ error });

    const sep = req.query.sep || ",";                 
    const excel = req.query.excel === "0" ? false : true; 
    const csv = toCSV(rows, headers, { sep, excelSepLine: excel });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${ds}.csv"`);
    res.send(csv);
  } catch (e) { logError('exportCsv', e); next(e); }
}

export async function exportPrint(req, res, next) {
  try {
    const { filtros = {}, sections = [] } = req.body || {};
    const q = { ...filtros };
    const fs = (obj) => Object.entries(obj).map(([k,v]) => `<span><b>${k}:</b> ${v ?? ''}</span>`).join(' · ');

    const collect = async (fn) => {
      let data;
      const fakeReq = { query: q };
      const fakeRes = { json: (d) => { data = d; } };
      await fn(fakeReq, fakeRes, next);
      return data || [];
    };

    const secHtml = [];

    if (sections.includes('kpis')) {
      const k = await new Promise((resolve)=> {
        const fakeRes = { json:(d)=>resolve(d) };
        kpis({ query:q }, fakeRes, next);
      });
      secHtml.push(`
        <section>
          <h2>KPIs</h2>
          <table>
            <tr><th>Total ventas</th><td>${k.totalVentas}</td></tr>
            <tr><th># Ventas</th><td>${k.numVentas}</td></tr>
            <tr><th>Ticket promedio</th><td>${k.ticketPromedio}</td></tr>
            <tr><th>Clientes atendidos</th><td>${k.clientesAtendidos}</td></tr>
            <tr><th>Crédito abierto</th><td>${k.creditoAbierto}</td></tr>
            <tr><th>Devoluciones</th><td>${k.montoDevoluciones}</td></tr>
            <tr><th># Cambios</th><td>${k.numCambios ?? 0}</td></tr>
          </table>
        </section>
      `);
    }

    if (sections.includes('ventas_serie')) {
      const serie = await collect(ventasSerie);
      const rows = serie.map(r => `<tr><td>${r.periodo}</td><td>${r.total}</td><td>${r.num}</td></tr>`).join('');
      secHtml.push(`
        <section>
          <h2>Serie de ventas</h2>
          <table><thead><tr><th>Periodo</th><th>Total</th><th>#</th></tr></thead><tbody>${rows}</tbody></table>
        </section>
      `);
    }

    if (sections.includes('ventas_vendedor')) {
      const vv = await collect(ventasPorVendedor);
      const rows = vv.map(r => `<tr><td>${r.vendedor}</td><td>${r.total}</td><td>${r.num}</td></tr>`).join('');
      secHtml.push(`
        <section>
          <h2>Ventas por vendedor</h2>
          <table><thead><tr><th>Vendedor</th><th>Total</th><th>#</th></tr></thead><tbody>${rows}</tbody></table>
        </section>
      `);
    }

    if (sections.includes('ventas_cliente')) {
      const vc = await collect(ventasPorCliente);
      const rows = vc.map(r => `<tr><td>${r.cliente}</td><td>${r.total}</td><td>${r.num}</td></tr>`).join('');
      secHtml.push(`
        <section>
          <h2>Ventas por cliente</h2>
          <table><thead><tr><th>Cliente</th><th>Total</th><th>#</th></tr></thead><tbody>${rows}</tbody></table>
        </section>
      `);
    }

    /* ===== MODIFICADO: Top productos AGRUPADO por categoría ===== */
if (sections.includes('top_productos')) {
  const tp = await collect(topProductos);
  const rows = tp.map(r => {
    const cat = String(r.categoria || '').toLowerCase();
    const col = String(r.color || '').toLowerCase();
    const isAmarillo = col === 'amarillo' || cat.includes('amarill');
    const isBlanco   = col === 'blanco'   || cat.includes('blanc');

    const swatch = isAmarillo
      ? `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:#f59e0b;border:1px solid #d97706;vertical-align:middle;margin-right:6px"></span> Amarillo`
      : isBlanco
      ? `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:#ffffff;border:1px solid #94a3b8;vertical-align:middle;margin-right:6px"></span> Blanco`
      : `<span style="color:#64748b">—</span>`;

    return `
      <tr>
        <td>${r.producto}</td>
        <td>${r.categoria || ''}</td>
        <td>${swatch}</td>
        <td style="text-align:right;">${Number(r.total || 0).toFixed(2)}</td>
        <td style="text-align:right;">${Number(r.cantidad || 0)}</td>
      </tr>
    `;
  }).join('');

  secHtml.push(`
    <section>
      <h2>Top productos</h2>
      <table>
        <thead>
          <tr>
            <th>Producto</th>
            <th>Categoría</th>
            <th>Color</th>
            <th>Total</th>
            <th>Cant.</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `);
}

    if (sections.includes('rutas_cumplimiento')) {
      const rc = await collect(rutasCumplimiento);
      const rows = rc.map(r => `<tr><td>${r.vendedor}</td><td>${r.programadas}</td><td>${r.escaneadas}</td><td>${r.porcentaje}%</td></tr>`).join('');
      secHtml.push(`
        <section>
          <h2>Cumplimiento de rutas</h2>
          <table><thead><tr><th>Vendedor</th><th>Prog.</th><th>Visitadas</th><th>%</th></tr></thead><tbody>${rows}</tbody></table>
        </section>
      `);
    }

    /* ===== NUEVO: Productos por categoría (catálogo) ===== */
    if (sections.includes('productos_categoria')) {
      const pc = await collect(productosPorCategoria);
      const catBlocks = pc.map(cat => {
        const rows = (cat.productos || []).map(p => `
          <tr>
            <td>${p.nombre}</td>
            <td>${p.codigo || ''}</td>
            <td style="text-align:right;">${Number(p.precio||0).toFixed(2)}</td>
            <td style="text-align:right;">${Number(p.precio_mayoreo||0).toFixed(2)}</td>
            <td style="text-align:center;">${p.activo ? 'Sí' : 'No'}</td>
          </tr>
        `).join('');
        return `
          <section>
            <h2>Productos — ${cat.categoria}</h2>
            <table>
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Código</th>
                  <th>Precio</th>
                  <th>Mayoreo</th>
                  <th>Activo</th>
                </tr>
              </thead>
              <tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:#6b7280;">Sin productos</td></tr>'}</tbody>
            </table>
          </section>
        `;
      }).join('\n');

      secHtml.push(catBlocks);
    }

    const html = `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8"/>
        <title>Reporte</title>
        <style>
          body{font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding:16px; color:#111}
          h1{margin:0 0 8px 0}
          h2{margin:20px 0 8px 0; page-break-after: avoid;}
          .filtros{color:#555; font-size:12px; margin-bottom:12px}
          table{border-collapse:collapse; width:100%; font-size:12px}
          th,td{border:1px solid #ddd; padding:6px}
          thead th{background:#f6f6f6; text-align:left}
          section{margin-bottom:20px}
          .cat-title{ margin:14px 0 6px; font-size:14px; font-weight:700; color:#0f172a; }
          .cat-block{ margin-bottom:14px; }
          @media print{
            body{padding:0}
            thead { display: table-header-group; }
            tfoot { display: table-footer-group; }
            tr, table { page-break-inside: avoid; }
            .cat-block{ page-break-inside: avoid; break-inside: avoid; }
          }
        </style>
      </head>
      <body>
        <h1>Reporte</h1>
        <div class="filtros">${fs(q)}</div>
        ${secHtml.join('\n')}
        <script>window.print && setTimeout(()=>window.print(), 300)</script>
      </body>
      </html>
    `;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) { logError('exportPrint', e); next(e); }
}

/* =========================
   Exportación XLSX (exceljs)
   ========================= */
function autoWidth(worksheet, min = 10, max = 40) {
  worksheet.columns?.forEach((col) => {
    let width = Math.max(min, (col.header ? String(col.header).length : min) + 2);
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const v = cell.value;
      const len =
        v == null ? 0 :
        typeof v === 'string' ? v.length :
        typeof v === 'number' ? String(v).length :
        v instanceof Date ? 10 : 0;
      width = Math.max(width, len + 2);
    });
    col.width = Math.min(width, max);
  });
}

// ======= Wow XLSX helpers =======
const PALETTE = {
  primary:  'FF2563EB',
  success:  'FF10B981',
  warning:  'FFF59E0B',
  danger:   'FFDC2626',
  slate900: 'FF0F172A',
  slate800: 'FF1F2937',
  slate700: 'FF334155',
  slate600: 'FF475569',
  slate100: 'FFF1F5F9',
  slate050: 'FFF8FAFC',
  white:    'FFFFFFFF',
  border:   'FFE5E7EB'
};

function mergeBanner(ws, text, subtitle) {
  ws.mergeCells('A1:H1');
  ws.mergeCells('A2:H2');
  const c1 = ws.getCell('A1');
  const c2 = ws.getCell('A2');
  c1.value = text;
  c2.value = subtitle || '';
  c1.font = { bold:true, size:20, color:{ argb: PALETTE.white } };
  c2.font = { size:12, color:{ argb: PALETTE.white } };
  c1.alignment = c2.alignment = { vertical:'middle', horizontal:'left' };
  for (const addr of ['A1:H1','A2:H2']) {
    ws.getCell(addr.split(':')[0]).fill = {
      type:'gradient', gradient:'angle', degree:0,
      stops:[
        {position:0, color:{argb:PALETTE.primary}},
        {position:1, color:{argb:PALETTE.success}}
      ]
    };
  }
  ws.getRow(1).height = 36;
  ws.getRow(2).height = 22;
}

function paintMerged(ws, range, {bg, bold=false, color='FF000000', size=12, italic=false}={}) {
  const [start] = range.split(':');
  ws.mergeCells(range);
  const cell = ws.getCell(start);
  if (bg) cell.fill = { type:'pattern', pattern:'solid', fgColor:{argb:bg}};
  cell.font = { bold, color:{argb:color}, size, italic };
  cell.alignment = { vertical:'middle', horizontal:'left', wrapText:true };
  return cell;
}

function kpiCard(ws, r1, c1, title, value, color) {
  const colLetters = (i)=>String.fromCharCode(64+i);
  const c2 = c1 + 1;
  const addr = `${colLetters(c1)}${r1}:${colLetters(c2)}${r1+2}`;
  ws.mergeCells(addr);
  const topLeft = ws.getCell(colLetters(c1)+r1);
  topLeft.alignment = { vertical:'middle', horizontal:'left', wrapText:true };
  topLeft.value = {
    richText: [
      { text: title + '\n', font:{ bold:true, color:{argb:PALETTE.slate700} } },
      { text: String(value ?? ''), font:{ size:16, bold:true, color:{argb:color} } }
    ]
  };
  for (let r=r1; r<=r1+2; r++){
    for (let c=c1; c<=c2; c++){
      const cell = ws.getCell(r, c);
      cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: PALETTE.slate050 } };
      cell.border = {
        top:{ style:'thin', color:{argb:PALETTE.border} },
        left:{ style:'thin', color:{argb:PALETTE.border} },
        bottom:{ style:'thin', color:{argb:PALETTE.border} },
        right:{ style:'thin', color:{argb:PALETTE.border} },
      };
    }
  }
}

function addStyledTable(ws, name, headers, rows, { style='TableStyleMedium9', totals=false, formats={} } = {}) {
  const startCol = 1;
  const hasRows = Array.isArray(rows) && rows.length > 0;

  const startRowForTitle = ws.lastRow?.number ? ws.lastRow.number + 2 : 6;
  ws.getCell(startRowForTitle - 1, startCol).value = name;
  ws.getCell(startRowForTitle - 1, startCol).font = { bold:true, color:{argb:PALETTE.slate800} };
  ws.getCell(startRowForTitle - 1, startCol).alignment = { vertical:'middle' };

  if (!hasRows) {
    const headerLabels = headers.map(h => h.label);
    const headerRow = ws.insertRow(startRowForTitle, headerLabels);
    headerRow.font = { bold: true, color: { argb: PALETTE.slate700 } };
    headerRow.eachCell((cell) => {
      cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: PALETTE.slate100 } };
      cell.border = {
        top:{ style:'thin', color:{argb:PALETTE.border} },
        left:{ style:'thin', color:{argb:PALETTE.border} },
        bottom:{ style:'thin', color:{argb:PALETTE.border} },
        right:{ style:'thin', color:{argb:PALETTE.border} },
      };
      cell.alignment = { vertical:'middle', horizontal:'left', wrapText:true };
    });
    headers.forEach((h, idx) => {
      const col = ws.getColumn(startCol + idx);
      if (formats[h.key]) col.numFmt = formats[h.key];
    });
    autoWidth(ws, 10, 45);
    if (!ws.views || ws.views.length === 0) ws.views = [{ state:'frozen', ySplit: headerRow.number }];
    return {
      startRow: headerRow.number,
      endRow: headerRow.number,
      startCol,
      endCol: startCol + headers.length - 1,
      hasRows: false
    };
  }

  const startRow = startRowForTitle;
  const data = rows.map(r => headers.map(h => r[h.key]));
  const columns = headers.map(h => {
    const col = { name: h.label };
    if (totals && h.totalFn) col.totalsRowFunction = h.totalFn;
    return col;
  });

  ws.addTable({
    name: (name.replace(/\s+/g,'_') + '_' + ws.name + '_' + startRow).replace(/[^\w]/g,''),
    ref: `A${startRow}`,
    headerRow: true,
    totalsRow: !!totals,
    style: { theme: style, showRowStripes: true },
    columns,
    rows: data
  });

  headers.forEach((h, idx) => {
    const col = ws.getColumn(startCol + idx);
    if (formats[h.key]) col.numFmt = formats[h.key];
  });

  autoWidth(ws, 10, 45);
  if (!ws.views || ws.views.length === 0) ws.views = [{ state:'frozen', ySplit: startRow }];

  const endRow = startRow + data.length;
  return { startRow, endRow, startCol, endCol: startCol + headers.length - 1, hasRows: true };
}

function subtotalFormula(colLetter, fromRow, toRow) {
  return `SUBTOTAL(9,${colLetter}${fromRow}:${colLetter}${toRow})`;
}

export async function exportXlsx(req, res, next) {
  try {
    const filtros = {
      desde: req.query.desde,
      hasta: req.query.hasta,
      granularity: req.query.granularity || 'day',
      vendedor_id: req.query.vendedor_id,
      cliente_id: req.query.cliente_id,
      producto_id: req.query.producto_id,
      vendedor_label: req.query.vendedor_label || req.body?.vendedor_label || '',
      cliente_label:  req.query.cliente_label  || req.body?.cliente_label  || '',
      producto_label: req.query.producto_label || req.body?.producto_label || ''
    };

    const collect = async (fn) => {
      let data;
      const fakeReq = { query: filtros };
      const fakeRes = { json: (d) => { data = d; } };
      await fn(fakeReq, fakeRes, next);
      return data || [];
    };

    const kpisData       = await new Promise((resolve) => {
      const fakeRes = { json: (d) => resolve(d) };
      kpis({ query: filtros }, fakeRes, next);
    });
    const serieData      = await collect(ventasSerie);
    const vendData       = await collect(ventasPorVendedor);
    const cliData        = await collect(ventasPorCliente);
    const topData        = await collect(topProductos);
    const rutasData      = await collect(rutasCumplimiento);
    const creditosData   = await collect(creditosSaldos);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'PADIHER';
    wb.created = new Date();

    /* ====== Portada ====== */
    const cover = wb.addWorksheet('Reporte Ejecutivo');
    cover.properties.defaultRowHeight = 20;
    cover.columns = Array.from({length:8}, ()=>({ width: 18 }));

    mergeBanner(
      cover,
      'Reporte Ejecutivo',
      `Periodo: ${filtros.desde || '-'}  a  ${filtros.hasta || '-'}`
    );

    const filtrosPartes = [];
    if (filtros.granularity) {
      const gMap = { day:'Día', week:'Semana', month:'Mes' };
      filtrosPartes.push(`Granularidad: ${gMap[filtros.granularity] || filtros.granularity}`);
    }
    if (filtros.vendedor_id) filtrosPartes.push(`Vendedor: ${filtros.vendedor_label || filtros.vendedor_id}`);
    if (filtros.cliente_id)  filtrosPartes.push(`Cliente: ${filtros.cliente_label || filtros.cliente_id}`);
    if (filtros.producto_id) filtrosPartes.push(`Producto: ${filtros.producto_label || filtros.producto_id}`);
    const filtrosTexto = filtrosPartes.length ? `Filtros aplicados — ${filtrosPartes.join(' · ')}` : 'Filtros aplicados — Ninguno';

    const filtrosCell = paintMerged(cover, 'A3:H3', { bg: PALETTE.slate100, bold: false, color: PALETTE.slate700, size: 11 });
    filtrosCell.value = filtrosTexto;
    cover.getRow(3).height = 22;

    const kBlocks = [
      { t: 'Total Ventas (MXN)',     v: (kpisData?.totalVentas||0).toLocaleString('es-MX',{style:'currency',currency:'MXN'}), color: PALETTE.primary },
      { t: 'Ticket Promedio (MXN)',  v: (kpisData?.ticketPromedio||0).toLocaleString('es-MX',{style:'currency',currency:'MXN'}), color: PALETTE.success },
      { t: '# Ventas',               v: String(kpisData?.numVentas||0),                                               color: PALETTE.warning },
      { t: 'Clientes Atendidos',     v: String(kpisData?.clientesAtendidos||0),                                       color: PALETTE.primary },
      { t: 'Crédito Abierto (MXN)',  v: (kpisData?.creditoAbierto||0).toLocaleString('es-MX',{style:'currency',currency:'MXN'}), color: PALETTE.danger },
      { t: 'Devoluciones (MXN)',     v: (kpisData?.montoDevoluciones||0).toLocaleString('es-MX',{style:'currency',currency:'MXN'}), color: PALETTE.warning },
    ];
    const cardPositions = [
      [5,1],[5,3],[5,5],
      [9,1],[9,3],[9,5]
    ];
    kBlocks.forEach((b, i) => {
      const [r,c] = cardPositions[i];
      kpiCard(cover, r, c, b.t, b.v, b.color);
    });

    cover.getCell('A15').value = 'Generado: ' + new Date().toLocaleString();
    cover.getCell('A15').font = { color:{argb:PALETTE.slate600}, italic:true };

    /* ====== Serie ====== */
    const wsSerie = wb.addWorksheet('Ventas - Serie');
    wsSerie.columns = [{width:18},{width:18},{width:18}];
    const serieHeaders = [
      { key:'periodo', label:'Periodo' },
      { key:'total',   label:'Total (MXN)' },
      { key:'num',     label:'# Ventas' },
    ];
    const serieRows = (serieData||[]).map(x => ({ periodo:x.periodo, total:Number(x.total||0), num:Number(x.num||0) }));
    const serieTable = addStyledTable(wsSerie, 'Serie de Ventas', serieHeaders, serieRows, {
      style:'TableStyleMedium9', totals:true, formats:{ total:'"$"#,##0.00' }
    });
    if (serieTable.hasRows) {
      const end = serieTable.endRow;
      wsSerie.getCell(`B${end+1}`).value = { formula: subtotalFormula('B', serieTable.startRow+1, end) };
      wsSerie.getCell(`C${end+1}`).value = { formula: subtotalFormula('C', serieTable.startRow+1, end) };
    }

    /* ====== Vendedores ====== */
    const wsVend = wb.addWorksheet('Ventas - Vendedores');
    const vendHeaders = [
      { key:'vendedor', label:'Vendedor' },
      { key:'total',    label:'Total (MXN)' },
      { key:'num',      label:'# Ventas' },
    ];
    const vendRows = (vendData||[]).map(x => ({ vendedor:x.vendedor, total:Number(x.total||0), num:Number(x.num||0) }));
    const vendTable = addStyledTable(wsVend, 'Ventas por vendedor', vendHeaders, vendRows, {
      style:'TableStyleMedium10', totals:true, formats:{ total:'"$"#,##0.00' }
    });
    if (vendTable.hasRows) {
      const end = vendTable.endRow;
      wsVend.getCell(`B${end+1}`).value = { formula: subtotalFormula('B', vendTable.startRow+1, end) };
      wsVend.getCell(`C${end+1}`).value = { formula: subtotalFormula('C', vendTable.startRow+1, end) };
    }

    /* ====== Clientes ====== */
    const wsCli = wb.addWorksheet('Ventas - Clientes');
    const cliHeaders = [
      { key:'cliente', label:'Cliente' },
      { key:'total',   label:'Total (MXN)' },
      { key:'num',     label:'# Ventas' },
    ];
    const cliRows = (cliData||[]).map(x => ({ cliente:x.cliente, total:Number(x.total||0), num:Number(x.num||0) }));
    const cliTable = addStyledTable(wsCli, 'Ventas por cliente', cliHeaders, cliRows, {
      style:'TableStyleMedium2', totals:true, formats:{ total:'"$"#,##0.00' }
    });
    if (cliTable.hasRows) {
      const end = cliTable.endRow;
      wsCli.getCell(`B${end+1}`).value = { formula: subtotalFormula('B', cliTable.startRow+1, end) };
      wsCli.getCell(`C${end+1}`).value = { formula: subtotalFormula('C', cliTable.startRow+1, end) };
    }

    /* ====== Top productos ====== */
    const wsTop = wb.addWorksheet('Top productos');
    const topHeaders = [
      { key:'producto', label:'Producto' },
      { key:'total',    label:'Total (MXN)' },
      { key:'cantidad', label:'Cantidad' },
    ];
    const topRows = (topData||[]).map(x => ({ producto:x.producto, total:Number(x.total||0), cantidad:Number(x.cantidad||0) }));
    const topTable = addStyledTable(wsTop, 'Top productos', topHeaders, topRows, {
      style:'TableStyleMedium7', totals:true, formats:{ total:'"$"#,##0.00' }
    });
    if (topTable.hasRows) {
      const end = topTable.endRow;
      wsTop.getCell(`B${end+1}`).value = { formula: subtotalFormula('B', topTable.startRow+1, end) };
      wsTop.getCell(`C${end+1}`).value = { formula: subtotalFormula('C', topTable.startRow+1, end) };
    }

    /* ====== Rutas ====== */
    const wsRutas = wb.addWorksheet('Rutas - Cumplimiento');
    const rutasHeaders = [
      { key:'vendedor',    label:'Vendedor' },
      { key:'programadas', label:'Programadas' },
      { key:'escaneadas',  label:'Visitadas' },
      { key:'porcentaje',  label:'% Cumplimiento' },
    ];
    const rutasRows = (rutasData||[]).map(x => ({
      vendedor:x.vendedor,
      programadas:Number(x.programadas||0),
      escaneadas:Number(x.escaneadas||0),
      porcentaje:Number(x.porcentaje||x.cumplimiento||0)/100
    }));
    const rutasTable = addStyledTable(wsRutas, 'Cumplimiento de rutas', rutasHeaders, rutasRows, {
      style:'TableStyleMedium4', totals:true, formats:{ porcentaje:'0.00%' }
    });
    if (rutasTable.hasRows) {
      const end = rutasTable.endRow;
      wsRutas.getCell(`B${end+1}`).value = { formula: subtotalFormula('B', rutasTable.startRow+1, end) };
      wsRutas.getCell(`C${end+1}`).value = { formula: subtotalFormula('C', rutasTable.startRow+1, end) };
      wsRutas.getCell(`D${end+1}`).value = { formula: `IFERROR(C${end+1}/B${end+1},0)` };
    }

    /* ====== Créditos ====== */
    const wsCred = wb.addWorksheet('Créditos - Saldos');
    const credHeaders = [
      { key:'cliente',         label:'Cliente' },
      { key:'total_creditos',  label:'Total Créditos (MXN)' },
      { key:'total_pagos',     label:'Total Pagos (MXN)' },
      { key:'saldo_pendiente', label:'Saldo Pendiente (MXN)' },
    ];
    const credRows = (creditosData||[]).map(x => ({
      cliente:x.cliente,
      total_creditos:Number(x.total_creditos||0),
      total_pagos:Number(x.total_pagos||0),
      saldo_pendiente:Number(x.saldo_pendiente||0),
    }));
    const credTable = addStyledTable(wsCred, 'Créditos - Saldos', credHeaders, credRows, {
      style:'TableStyleMedium3',
      totals:true,
      formats:{ total_creditos:'"$"#,##0.00', total_pagos:'"$"#,##0.00', saldo_pendiente:'"$"#,##0.00' }
    });
    if (credTable.hasRows) {
      const end = credTable.endRow;
      ['B','C','D'].forEach(col => {
        wsCred.getCell(`${col}${end+1}`).value = { formula: subtotalFormula(col, credTable.startRow+1, end) };
      });
    }

    const filename = `reporte-wow_${(filtros.desde||'ini')}_a_${(filtros.hasta||'fin')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    logError('exportXlsx', e);
    next(e);
  }
}
