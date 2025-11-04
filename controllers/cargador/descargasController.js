// controllers/cargador/descargasController.js
import db from '../../config/db.js';

/**
 * GET /api/cargador/descargas/pendientes?limit=&offset=
 * Lista TODAS las CARGAS con procesada = 0 y lista_para_procesar = 1
 * (se conserva la ruta/contrato de "descargas" para no romper Android)
 */
export async function listarPendientes(req, res) {
  try {
    const limit  = Math.min(Number(req.query.limit) || 200, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    // OJO: aquí unimos al USUARIO DEL VENDEDOR (uVend) y al USUARIO CARGADOR (uCarg)
    const [rows] = await db.query(
      `
      SELECT
        c.id,
        c.id_camioneta,
        c.id_usuario,         -- cargador que registró
        c.id_vendedor,        -- FK a vendedores
        c.fecha,
        c.procesada,
        c.lista_para_procesar,

        -- CARGADOR (quien registró la carga)
        uCarg.nombre  AS nombre_cargador,
        uCarg.usuario AS username_cargador,
        uCarg.correo  AS correo_cargador,

        -- VENDEDOR (dueño de la carga)
        v.firebase_uid          AS vendedor_firebase_uid,
        uVend.id                AS vendedor_usuario_id,
        uVend.nombre            AS nombre_vendedor,
        uVend.usuario           AS username_vendedor,
        uVend.correo            AS correo_vendedor
      FROM cargas c
      LEFT JOIN usuarios uCarg ON uCarg.id = c.id_usuario                -- usuario cargador
      JOIN vendedores v        ON v.id = c.id_vendedor                   -- vendedor
      JOIN usuarios uVend      ON uVend.id = v.id_usuario                -- usuario del vendedor
      WHERE c.procesada = 0
        AND c.lista_para_procesar = 1
      ORDER BY c.fecha DESC, c.id DESC
      LIMIT ? OFFSET ?
      `,
      [limit, offset]
    );

    if (!rows.length) return res.json([]);

    const cargaIds    = rows.map(r => r.id);
    const vendedorIds = [...new Set(rows.map(r => r.id_vendedor).filter(Boolean))];

    // Productos por CARGA (desde detalle_pedido)
    const [prods] = await db.query(
      `
      SELECT
        dp.carga_id,
        dp.producto_id,
        COALESCE(p.nombre, dp.nombre_producto) AS nombre,
        COALESCE(dp.cantidad_inicial, 0)      AS cantidad,
        COALESCE(dp.ventas, 0)                AS ventas,
        COALESCE(dp.devoluciones, 0)          AS devoluciones,
        COALESCE(dp.restante,
                 GREATEST(dp.cantidad_inicial - dp.ventas + dp.devoluciones, 0)) AS restante
      FROM detalle_pedido dp
      LEFT JOIN productos p ON p.id = dp.producto_id
      WHERE dp.carga_id IN (?)
      `,
      [cargaIds]
    );

    const productosPorCarga = new Map();
    for (const r of prods) {
      const list = productosPorCarga.get(r.carga_id) || [];
      list.push({
        id_producto: r.producto_id,
        nombre: r.nombre,
        cantidad: Number(r.cantidad) || 0,
        ventas: Number(r.ventas) || 0,
        devoluciones: Number(r.devoluciones) || 0,
        restante: Number(r.restante) || 0,
      });
      productosPorCarga.set(r.carga_id, list);
    }

    // Rango de fechas para precargar resumen del día
    const fechas = rows
      .map(r => (r.fecha ? new Date(r.fecha) : null))
      .filter(Boolean)
      .map(d => d.toISOString().slice(0, 10));

    let minFecha = null;
    let maxFecha = null;
    if (fechas.length) {
      minFecha = fechas.reduce((a, b) => (a < b ? a : b));
      maxFecha = fechas.reduce((a, b) => (a > b ? a : b));
    }

    // Resumen inventario del día (vista agregada; si no existe, se ignora)
    const resumenIndex = new Map(); // `${id_vendedor}|${fecha_dia}` -> array
    if (vendedorIds.length && minFecha && maxFecha) {
      try {
        const [resRows] = await db.query(
          `
          SELECT r.id_vendedor, r.id_producto, r.fecha_dia, r.cantidad, r.ventas, r.restante, p.nombre
          FROM vw_resumen_inventario_dia r
          JOIN productos p ON p.id = r.id_producto
          WHERE r.id_vendedor IN (?)
            AND r.fecha_dia BETWEEN ? AND ?
          `,
          [vendedorIds, minFecha, maxFecha]
        );
        for (const r of resRows) {
          const key = `${r.id_vendedor}|${r.fecha_dia}`;
          const list = resumenIndex.get(key) || [];
          list.push({
            id_producto: r.id_producto,
            nombre: r.nombre,
            cantidad: Number(r.cantidad) || 0,
            ventas: Number(r.ventas) || 0,
            restante: Number(r.restante) || 0,
          });
          resumenIndex.set(key, list);
        }
      } catch {
        // vista opcional
      }
    }

    // Ensamble final (contrato tipo "descargas")
    const data = rows.map(r => {
      const fechaISO = r.fecha ? new Date(r.fecha).toISOString() : null;
      const fechaDia = fechaISO ? fechaISO.slice(0, 10) : null;
      const key = (r.id_vendedor && fechaDia) ? `${r.id_vendedor}|${fechaDia}` : null;

      // Preferimos firebase_uid del vendedor si existe, luego id, luego username/correo del usuario del vendedor
      const vendedorUid = String(
        r.vendedor_firebase_uid ??
        r.id_vendedor ??
        r.username_vendedor ??
        r.correo_vendedor ??
        ''
      );

      return {
        id: r.id,
        vendedorUid,
        nombreVendedor: (r.nombre_vendedor || '').trim() || '—',
        // Campo extra (útil para auditoría/UI): quién registró la carga
        nombreCargador: (r.nombre_cargador || '').trim() || '—',

        fechaHora: fechaISO,
        fechaMs: r.fecha ? new Date(r.fecha).getTime() : null,
        procesada: !!r.procesada,
        // compat con app actual
        listaParaConfirmar: true,
        // bandera real
        listaParaProcesar: !!r.lista_para_procesar,

        productos: productosPorCarga.get(r.id) || [],
        resumenInventario: key ? (resumenIndex.get(key) || []) : [],
      };
    });

    res.json(data);
  } catch (e) {
    console.error('[cargas:listarPendientes] error:', e);
    res.status(500).json({ msg: 'Error al listar cargas pendientes', error: e?.message });
  }
}

/** GET /api/cargador/descargas/:id */
export async function obtenerPorId(req, res) {
  try {
    const idNum = Number(req.params.id);
    if (!idNum) return res.status(400).json({ msg: 'id inválido' });

    // Igual que en listarPendientes: traemos vendedor (uVend) y cargador (uCarg)
    const [[c]] = await db.query(
      `
      SELECT
        c.id, c.id_camioneta, c.id_usuario, c.id_vendedor, c.fecha,
        c.procesada, c.lista_para_procesar,

        -- CARGADOR
        uCarg.nombre  AS nombre_cargador,
        uCarg.usuario AS username_cargador,
        uCarg.correo  AS correo_cargador,

        -- VENDEDOR
        v.firebase_uid          AS vendedor_firebase_uid,
        uVend.id                AS vendedor_usuario_id,
        uVend.nombre            AS nombre_vendedor,
        uVend.usuario           AS username_vendedor,
        uVend.correo            AS correo_vendedor
      FROM cargas c
      LEFT JOIN usuarios uCarg ON uCarg.id = c.id_usuario
      JOIN vendedores v        ON v.id = c.id_vendedor
      JOIN usuarios uVend      ON uVend.id = v.id_usuario
      WHERE c.id = ?
      `,
      [idNum]
    );
    if (!c) return res.status(404).json({ msg: 'Carga no encontrada' });

    const [prods] = await db.query(
      `
      SELECT
        dp.producto_id,
        COALESCE(p.nombre, dp.nombre_producto) AS nombre,
        COALESCE(dp.cantidad_inicial, 0)      AS cantidad,
        COALESCE(dp.ventas, 0)                AS ventas,
        COALESCE(dp.devoluciones, 0)          AS devoluciones,
        COALESCE(dp.restante,
                 GREATEST(dp.cantidad_inicial - dp.ventas + dp.devoluciones, 0)) AS restante
      FROM detalle_pedido dp
      LEFT JOIN productos p ON p.id = dp.producto_id
      WHERE dp.carga_id = ?
      `,
      [idNum]
    );

    const fechaISO = c.fecha ? new Date(c.fecha).toISOString() : null;
    const fechaDia = fechaISO ? fechaISO.slice(0, 10) : null;

    let resumenInventario = [];
    if (c.id_vendedor && fechaDia) {
      try {
        const [resRows] = await db.query(
          `
          SELECT r.id_producto, r.cantidad, r.ventas, r.restante, p.nombre
          FROM vw_resumen_inventario_dia r
          JOIN productos p ON p.id = r.id_producto
          WHERE r.id_vendedor = ? AND r.fecha_dia = ?
          `,
          [c.id_vendedor, fechaDia]
        );
        resumenInventario = resRows.map(r => ({
          id_producto: r.id_producto,
          nombre: r.nombre,
          cantidad: Number(r.cantidad) || 0,
          ventas: Number(r.ventas) || 0,
          restante: Number(r.restante) || 0,
        }));
      } catch {
        resumenInventario = [];
      }
    }

    const vendedorUid = String(
      c.vendedor_firebase_uid ??
      c.id_vendedor ??
      c.username_vendedor ??
      c.correo_vendedor ??
      ''
    );

    res.json({
      id: c.id,
      vendedorUid,
      nombreVendedor: (c.nombre_vendedor || '').trim() || '—',
      // informativo
      nombreCargador: (c.nombre_cargador || '').trim() || '—',

      fechaHora: fechaISO,
      fechaMs: c.fecha ? new Date(c.fecha).getTime() : null,
      procesada: !!c.procesada,
      listaParaConfirmar: true,
      listaParaProcesar: !!c.lista_para_procesar,
      productos: prods.map(p => ({
        id_producto: p.producto_id,
        nombre: p.nombre,
        cantidad: Number(p.cantidad) || 0,
        ventas: Number(p.ventas) || 0,
        devoluciones: Number(p.devoluciones) || 0,
        restante: Number(p.restante) || 0,
      })),
      resumenInventario,
    });
  } catch (e) {
    console.error('[cargas:obtenerPorId] error:', e);
    res.status(500).json({ msg: 'Error al obtener la carga', error: e?.message });
  }
}

/**
 * PATCH /api/cargador/descargas/:id/estado
 * Body: { procesada?: boolean, listaParaProcesar?: boolean }
 * Regla: si procesada=true y NO se envía listaParaProcesar, se fuerza a 0.
 */
export async function actualizarEstado(req, res) {
  try {
    const idNum = Number(req.params.id);
    if (!idNum) return res.status(400).json({ msg: 'id inválido' });

    const body = req.body || {};
    const hasProc = Object.prototype.hasOwnProperty.call(body, 'procesada');
    const hasLpp  = Object.prototype.hasOwnProperty.call(body, 'listaParaProcesar');

    if (!hasProc && !hasLpp) {
      return res.status(400).json({ msg: 'Nada que actualizar' });
    }

    const sets = [];
    const params = [];

    if (hasProc) {
      const proc = !!body.procesada;
      sets.push('procesada = ?');
      params.push(proc ? 1 : 0);
      if (proc && !hasLpp) {
        sets.push('lista_para_procesar = 0');
      }
    }
    if (hasLpp) {
      const lpp = !!body.listaParaProcesar;
      sets.push('lista_para_procesar = ?');
      params.push(lpp ? 1 : 0);
    }

    params.push(idNum);

    const [r] = await db.query(
      `UPDATE cargas SET ${sets.join(', ')} WHERE id = ?`,
      params
    );
    if (!r.affectedRows) return res.status(404).json({ msg: 'Carga no encontrada' });

    return obtenerPorId({ ...req, params: { id: String(idNum) } }, res);
  } catch (e) {
    console.error('[cargas:actualizarEstado] error:', e);
    res.status(500).json({ msg: 'Error al actualizar estado', error: e?.message });
  }
}
