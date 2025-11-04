// controllers/vendedor/inventarioController.js
import db from '../../config/db.js';

/* ===================== Utils ===================== */
function getVendedorId(req) {
  // acepta tanto idVendedor como vendedorId (compat Android)
  return Number(
    req.user?.vendedorId ??
    req.user?.id_vendedor ??
    req.query?.idVendedor ??
    req.query?.vendedorId ??
    req.params?.vendedorId
  ) || null;
}

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const fmt$ = (n) => MXN.format(Number(n || 0));

/** Date -> "YYYY-MM-DD HH:mm:ss" (zona del server) */
function toSqlDateTime(d) {
  const pad = n => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

/** Rango (?ini&?fin) o día de hoy por defecto */
function getRangoFechas(req) {
  const qIni = req.query?.ini;
  const qFin = req.query?.fin;
  const ini = qIni ? new Date(qIni) : new Date(new Date().setHours(0, 0, 0, 0));
  const fin = qFin ? new Date(qFin) : new Date(new Date().setHours(23, 59, 59, 999));
  return { ini: toSqlDateTime(ini), fin: toSqlDateTime(fin) };
}

/** Rango por CARGA vigente: [carga.fecha, ahora] */
function getRangoPorCarga(carga) {
  if (!carga?.fecha) return null;
  const ini = toSqlDateTime(new Date(carga.fecha));
  const fin = toSqlDateTime(new Date()); // ahora
  return { ini, fin };
}

function armarTotalesTexto(t) {
  const ventaEfec   = Number(t.ventaEfectivo || 0);
  const ventaTr     = Number(t.ventaTransferencia || 0);
  const cobrable    = Number(t.cobrableSubtotal ?? (ventaEfec + ventaTr));        // contado + público
  const totalBruto  = Number(t.totalBruto || 0);                                   // incluye crédito
  const recEf       = Number(t.recaudadoEfectivo || 0);
  const recTr       = Number(t.recaudadoTransferencia || 0);
  const recTotal    = Number(t.recaudadoTotal ?? (recEf + recTr));
  const debeNeto    = Number(t.debeNeto ?? Math.max(cobrable - recTotal, 0));
  const aFavor      = Number(t.aFavor ?? Math.max(recTotal - cobrable, 0));

  return [
    'VENTAS (por tipo de pago) — incluye cliente + público + crédito',
    `• Efectivo: ${fmt$(ventaEfec)}`,
    `• Transferencia: ${fmt$(ventaTr)}`,
    `• Total: ${fmt$(ventaEfec + ventaTr)}`,
    '',
    `COBRABLE HOY (contado + público, SIN crédito): ${fmt$(cobrable)}`,
    `TOTAL BRUTO (todo lo vendido incl. crédito): ${fmt$(totalBruto)}`,
    '',
    'RECAUDADO (contado + público + abonos crédito)',
    `• Efectivo: ${fmt$(recEf)}`,
    `• Transferencias: ${fmt$(recTr)}`,
    `• Total recaudado: ${fmt$(recTotal)}`,
    '',
    'BALANCE (Cobrable − Recaudado)',
    (debeNeto > 0) ? `• Debe: ${fmt$(debeNeto)}` : `• A favor: ${fmt$(aFavor)}`
  ].join('\n');
}

/* ===================== Carga actual ===================== */
/** Preferimos: 1) no procesada; 2) con restante>0; 3) última por fecha */
async function pickCargaActual(vendedorId) {
  const [[noProc]] = await db.query(
    `SELECT c.id, c.fecha, c.procesada, c.lista_para_confirmar, c.id_camioneta
       FROM cargas c
      WHERE c.id_vendedor = ? AND c.procesada = 0
      ORDER BY c.fecha DESC, c.id DESC
      LIMIT 1`, [vendedorId]
  );
  if (noProc) return noProc;

  const [[conRest]] = await db.query(
    `SELECT c.id, c.fecha, c.procesada, c.lista_para_confirmar, c.id_camioneta
       FROM cargas c
       JOIN detalle_pedido dp ON dp.carga_id = c.id
      WHERE c.id_vendedor = ?
        AND dp.restante > 0
      GROUP BY c.id
      ORDER BY c.fecha DESC, c.id DESC
      LIMIT 1`, [vendedorId]
  );
  if (conRest) return conRest;

  const [[ult]] = await db.query(
    `SELECT c.id, c.fecha, c.procesada, c.lista_para_confirmar, c.id_camioneta
       FROM cargas c
      WHERE c.id_vendedor = ?
      ORDER BY c.fecha DESC, c.id DESC
      LIMIT 1`, [vendedorId]
  );
  return ult || null;
}

async function leerCargaActual(vendedorId) {
  const row = await pickCargaActual(vendedorId);
  if (!row) return null;

  const carga = {
    id: Number(row.id),
    fecha: row.fecha,
    procesada: !!row.procesada,
    listaParaConfirmar: !!row.lista_para_confirmar,
    id_camioneta: row.id_camioneta != null ? Number(row.id_camioneta) : null
  };

  const [det] = await db.query(
    `SELECT
        dp.producto_id,
        dp.nombre_producto,
        dp.precio_unitario,
        dp.cantidad_inicial,
        COALESCE(dp.ventas,0)        AS ventas,
        COALESCE(dp.devoluciones,0)  AS devoluciones,
        dp.restante
       FROM detalle_pedido dp
      WHERE dp.carga_id = ?
      ORDER BY dp.nombre_producto ASC`,
    [carga.id]
  );

  const productosNuevos = det.map(r => ({
    productoId: Number(r.producto_id),
    nombre: r.nombre_producto,
    precio: Number(r.precio_unitario ?? 0),
    cargado: Number(r.cantidad_inicial ?? 0),
    vendido: Number(r.ventas ?? 0),
    devoluciones: Number(r.devoluciones ?? 0),
    restante: Number(r.restante ?? 0)
  }));

  return { carga, productosNuevos };
}

/* ===================== Totales (panel) ===================== */
async function computeTotalesCorte(vendedorId, rango) {
  const { ini, fin } = rango;

  // Ventas con cliente (excluye ventas de cadena / excluir_corte=1)
  const [[v1]] = await db.query(
    `SELECT
        -- TODAS por método (incluye crédito, pero excluye excluir_corte=1)
        SUM(CASE
              WHEN COALESCE(
                     metodo_pago,
                     CASE
                       WHEN tipo_pago='contado'       THEN 'efectivo'
                       WHEN tipo_pago='transferencia' THEN 'transferencia'
                       ELSE metodo_pago
                     END
                   ) = 'efectivo'
              THEN total ELSE 0 END) AS v_all_ef,
        SUM(CASE
              WHEN COALESCE(
                     metodo_pago,
                     CASE
                       WHEN tipo_pago='contado'       THEN 'efectivo'
                       WHEN tipo_pago='transferencia' THEN 'transferencia'
                       ELSE metodo_pago
                     END
                   ) = 'transferencia'
              THEN total ELSE 0 END) AS v_all_tr,

        -- SOLO contado/transfer (para COBRABLE), y excluye excluir_corte=1
        SUM(CASE
              WHEN tipo_pago IN ('contado','transferencia') AND
                   COALESCE(metodo_pago,
                            CASE
                              WHEN tipo_pago='contado'       THEN 'efectivo'
                              WHEN tipo_pago='transferencia' THEN 'transferencia'
                              ELSE NULL
                            END) = 'efectivo'
              THEN total ELSE 0 END) AS v_ct_ef,
        SUM(CASE
              WHEN tipo_pago IN ('contado','transferencia') AND
                   COALESCE(metodo_pago,
                            CASE
                              WHEN tipo_pago='contado'       THEN 'efectivo'
                              WHEN tipo_pago='transferencia' THEN 'transferencia'
                              ELSE NULL
                            END) = 'transferencia'
              THEN total ELSE 0 END) AS v_ct_tr,

        SUM(CASE WHEN tipo_pago='credito' THEN total ELSE 0 END) AS v_cr
       FROM ventas
      WHERE id_vendedor = ?
        AND fecha BETWEEN ? AND ?
        AND COALESCE(excluir_corte,0) = 0`,
    [vendedorId, ini, fin]
  );

  // Ventas al público
  const [[v2]] = await db.query(
    `SELECT
        SUM(CASE WHEN metodo_pago='efectivo'      THEN total ELSE 0 END) AS vp_ef,
        SUM(CASE WHEN metodo_pago='transferencia' THEN total ELSE 0 END) AS vp_tr
       FROM ventas_publico
      WHERE id_vendedor = ? AND fecha BETWEEN ? AND ?`,
    [vendedorId, ini, fin]
  );

  // Abonos a crédito (excluye créditos de ventas con excluir_corte=1)
  const [[ab]] = await db.query(
    `SELECT
        SUM(CASE WHEN p.tipo_pago='efectivo'      THEN p.monto ELSE 0 END) AS ab_ef,
        SUM(CASE WHEN p.tipo_pago='transferencia' THEN p.monto ELSE 0 END) AS ab_tr
       FROM pagos_credito p
       JOIN creditos c ON c.id = p.id_credito
       JOIN ventas   v ON v.id = c.id_venta
      WHERE v.id_vendedor = ?
        AND p.fecha BETWEEN ? AND ?
        AND COALESCE(v.excluir_corte,0) = 0`,
    [vendedorId, ini, fin]
  );

  // Para UI (incluye crédito + público)
  const ventaEfectivoUI      = Number(v1?.v_all_ef || 0) + Number(v2?.vp_ef || 0);
  const ventaTransferUI      = Number(v1?.v_all_tr || 0) + Number(v2?.vp_tr || 0);

  // Cobrable (para balance): contado + público
  const cobrableEf           = Number(v1?.v_ct_ef || 0) + Number(v2?.vp_ef || 0);
  const cobrableTr           = Number(v1?.v_ct_tr || 0) + Number(v2?.vp_tr || 0);
  const cobrableSubtotal     = cobrableEf + cobrableTr;

  // Crédito (informativo)
  const ventaCredito         = Number(v1?.v_cr || 0);

  // Total bruto (todo)
  const totalBruto           = ventaEfectivoUI + ventaTransferUI;

  // Recaudado real = cobrable + abonos
  const recaudadoEfectivo      = cobrableEf + Number(ab?.ab_ef || 0);
  const recaudadoTransferencia = cobrableTr + Number(ab?.ab_tr || 0);
  const recaudadoTotal         = recaudadoEfectivo + recaudadoTransferencia;

  return {
    // para UI
    ventaEfectivo:      ventaEfectivoUI,
    ventaTransferencia: ventaTransferUI,

    // informativos
    ventaCredito,
    totalBruto,

    // balance contra cobrable
    cobrableSubtotal,

    // recaudación
    recaudadoEfectivo,
    recaudadoTransferencia,
    recaudadoTotal,

    // auxiliares balance
    debeNeto: Math.max(cobrableSubtotal - recaudadoTotal, 0),
    aFavor:   Math.max(recaudadoTotal - cobrableSubtotal, 0),

    ini, fin
  };
}

// Devoluciones pendientes: usa rango desde la última carga real
async function leerDevolucionesPendientes(vendedorId) {
  // 1) Última carga real del vendedor
  const [[ult]] = await db.query(
    `SELECT c.id AS carga_id, c.fecha
       FROM cargas c
      WHERE c.id_vendedor = ?
      ORDER BY c.fecha DESC, c.id DESC
      LIMIT 1`,
    [vendedorId]
  );
  if (!ult) {
    return { items: [], totales: { cantidadTotal: 0, total: 0 } };
  }

  // 2) Devoluciones NO procesadas dentro del rango de la carga vigente
  const [items] = await db.query(
    `SELECT
        d.id              AS devolucionId,
        dd.id_producto    AS productoId,
        COALESCE(p.nombre, dd.nombre_producto) AS producto,
        dd.cantidad,
        d.motivo,
        DATE_FORMAT(d.fecha, '%H:%i') AS hora
       FROM devoluciones d
       JOIN devolucion_detalle dd ON dd.id_devolucion = d.id
       LEFT JOIN productos p ON p.id = dd.id_producto
      WHERE d.id_vendedor = ?
        AND d.procesada = 0
        AND d.fecha BETWEEN ? AND NOW()
      ORDER BY d.fecha DESC, producto ASC`,
    [vendedorId, ult.fecha]
  );

  const cantidadTotal = items.reduce((a, r) => a + Number(r.cantidad || 0), 0);

  return {
    items: items.map(r => ({
      devolucionId: Number(r.devolucionId),
      productoId: r.productoId != null ? Number(r.productoId) : null,
      producto: r.producto,
      cantidad: Number(r.cantidad || 0),
      motivo: r.motivo,
      hora: r.hora
    })),
    totales: {
      cantidadTotal,
      total: 0
    }
  };
}

/* ===================== Endpoints ===================== */
/** GET /inventario/activo?idVendedor=# */
export async function getCargaActiva(req, res) {
  try {
    const vendedorId = getVendedorId(req);
    if (!vendedorId) return res.status(400).json({ ok: false, msg: 'Falta idVendedor' });

    const data = await leerCargaActual(vendedorId);
    if (!data || data.productosNuevos.length === 0) {
      return res.json({ ok: true, data: null, msg: 'Sin carga activa' });
    }

    const payload = {
      id: data.carga.id,
      procesada: data.carga.procesada,
      carga: {
        id: data.carga.id,
        procesada: data.carga.procesada,
        listaParaConfirmar: data.carga.listaParaConfirmar
      },
      productosNuevos: data.productosNuevos
    };

    return res.json({ ok: true, data: payload });
  } catch (e) {
    console.error('[inventario.getCargaActiva]', e);
    return res.status(500).json({ ok: false, msg: e?.message || 'Error al obtener carga activa' });
  }
}

/** GET /inventario/devoluciones-pendientes?idVendedor=# */
export async function getDevolucionesPendientes(req, res) {
  try {
    const vendedorId = getVendedorId(req);
    if (!vendedorId) return res.status(400).json({ ok: false, msg: 'Falta idVendedor' });

    const data = await leerDevolucionesPendientes(vendedorId);
    return res.json({ ok: true, data });
  } catch (e) {
    console.error('[inventario.getDevolucionesPendientes]', e);
    return res.status(500).json({ ok: false, msg: e?.message || 'Error al obtener devoluciones' });
  }
}

/**
 * GET /inventario/totales?idVendedor=#
 *      [&flat=1]
 *      [&ini=YYYY-MM-DD HH:mm:ss&fin=YYYY-MM-DD HH:mm:ss]
 */
export async function getTotalesCorte(req, res) {
  try {
    const vendedorId = getVendedorId(req);
    if (!vendedorId) return res.status(400).json({ ok: false, msg: 'Falta idVendedor' });

    const data = await leerCargaActual(vendedorId);
    if (!data) return res.status(404).json({ ok:false, msg:'Sin carga vigente' });

    const rango = (req.query?.ini || req.query?.fin) ? getRangoFechas(req) : getRangoPorCarga(data.carga);
    const flat = req.query.flat === '1';
    const t = await computeTotalesCorte(vendedorId, rango);

    if (flat) {
      return res.json({
        ok: true,
        data: {
          ventas_efectivo:         Number(t.ventaEfectivo || 0),
          ventas_transferencia:    Number(t.ventaTransferencia || 0),
          ventas_subtotal:         Number((t.ventaEfectivo || 0) + (t.ventaTransferencia || 0)),
          ventas_credito:          Number(t.ventaCredito || 0),
          total_bruto:             Number(t.totalBruto || 0),
          recaudado_efectivo:      Number(t.recaudadoEfectivo || 0),
          recaudado_transferencia: Number(t.recaudadoTransferencia || 0),
          recaudado_total:         Number(t.recaudadoTotal || 0),
          balance_debe:            Number(t.debeNeto || 0),
          ini: t.ini, fin: t.fin,
          carga_id: data.carga.id,
          cobrable_subtotal:       Number(t.cobrableSubtotal || 0)
        }
      });
    }

    return res.json({
      ok: true,
      data: {
        ventas: {
          efectivo:      Number(t.ventaEfectivo || 0),
          transferencia: Number(t.ventaTransferencia || 0),
          subtotal:      Number((t.ventaEfectivo || 0) + (t.ventaTransferencia || 0))
        },
        recaudado: {
          efectivo:      Number(t.recaudadoEfectivo || 0),
          transferencia: Number(t.recaudadoTransferencia || 0),
          subtotal:      Number(t.recaudadoTotal || 0)
        },
        // balance real (contra lo cobrable)
        balance: Number(t.cobrableSubtotal - t.recaudadoTotal),
        balance_debe: Number(t.debeNeto || 0),

        extras: {
          ventas_credito:     Number(t.ventaCredito || 0),
          total_bruto:        Number(t.totalBruto || 0),
          cobrable_subtotal:  Number(t.cobrableSubtotal || 0),
          ini: t.ini, fin: t.fin, carga_id: data.carga.id
        }
      }
    });
  } catch (e) {
    console.error('[inventario.getTotalesCorte]', e);
    return res.status(500).json({ ok: false, msg: e?.message || 'Error al obtener totales' });
  }
}

/** ✅ GET /api/vendedor/corte/resumen?vendedorId=###  (por CARGA) */
export async function getResumenCorte(req, res) {
  try {
    const vendedorId = getVendedorId(req);
    if (!vendedorId) return res.status(400).json({ ok:false, msg:'Falta vendedorId/idVendedor' });

    const data = await leerCargaActual(vendedorId);
    if (!data) return res.status(404).json({ ok:false, msg:'Sin carga vigente' });

    const rango = getRangoPorCarga(data.carga);
    const t = await computeTotalesCorte(vendedorId, rango);

    return res.json({
      ok: true,
      data: {
        ventas: {
          efectivo:      Number(t.ventaEfectivo || 0),
          transferencia: Number(t.ventaTransferencia || 0),
          subtotal:      Number((t.ventaEfectivo || 0) + (t.ventaTransferencia || 0))
        },
        recaudado: {
          efectivo:      Number(t.recaudadoEfectivo || 0),
          transferencia: Number(t.recaudadoTransferencia || 0),
          subtotal:      Number(t.recaudadoTotal || 0)
        },
        balance_debe: Number(t.debeNeto || 0),
        extras: {
          ventas_credito:     Number(t.ventaCredito || 0),
          total_bruto:        Number(t.totalBruto || 0),
          cobrable_subtotal:  Number(t.cobrableSubtotal || 0),
          ini: t.ini, fin: t.fin, carga_id: data.carga.id
        }
      }
    });
  } catch (e) {
    console.error('[inventario.getResumenCorte]', e);
    return res.status(500).json({ ok:false, msg:'Error al obtener resumen del corte' });
  }
}

/** POST /inventario/confirmar  (eco para impresión; por CARGA) */
export async function confirmarResumen(req, res) {
  try {
    const vendedorId = getVendedorId(req);
    if (!vendedorId) return res.status(400).json({ ok:false, msg:'Falta idVendedor' });

    const data = await leerCargaActual(vendedorId);
    if (!data) return res.status(404).json({ ok:false, msg:'Sin carga para confirmar' });

    const rango = (req.query?.ini || req.query?.fin) ? getRangoFechas(req) : getRangoPorCarga(data.carga);
    const totales = await computeTotalesCorte(vendedorId, rango);
    const totalesTexto = armarTotalesTexto(totales);

    const resumen = data.productosNuevos.map(p => ({
      productoId: p.productoId,
      nombre: p.nombre,
      cantidad: p.cargado,
      ventas: p.vendido,
      devoluciones: p.devoluciones ?? 0,
      restante: p.restante
    }));

    return res.json({
      ok: true,
      msg: 'Resumen generado desde la carga real',
      data: {
        cargaId: data.carga.id,
        totales,
        totalesTexto,
        resumen,
        descargaId: null,
        rango
      }
    });
  } catch (e) {
    console.error('[inventario.confirmarResumen]', e);
    return res.status(500).json({ ok:false, msg: e?.message || 'Error al confirmar resumen' });
  }
}

/** POST /inventario/corte  (solo lectura; por CARGA) */
export async function hacerCorte(req, res) {
  try {
    const vendedorId = getVendedorId(req);
    if (!vendedorId) return res.status(400).json({ ok:false, msg:'Falta idVendedor' });

    const data = await leerCargaActual(vendedorId);
    if (!data) return res.status(404).json({ ok:false, msg:'Sin carga para corte' });

    const rango = (req.query?.ini || req.query?.fin) ? getRangoFechas(req) : getRangoPorCarga(data.carga);
    const totales = await computeTotalesCorte(vendedorId, rango);
    const totalesTexto = armarTotalesTexto(totales);

    const resumen = data.productosNuevos.map(p => ({
      productoId: p.productoId,
      nombre: p.nombre,
      cantidad: p.cargado,
      ventas: p.vendido,
      devoluciones: p.devoluciones ?? 0,
      restante: p.restante
    }));

    return res.json({
      ok: true,
      msg: 'Corte (solo lectura) generado desde la carga real',
      data: { cargaId: data.carga.id, descargaId: null, totales, totalesTexto, resumen, rango }
    });
  } catch (e) {
    console.error('[inventario.hacerCorte]', e);
    return res.status(500).json({ ok:false, msg: e?.message || 'Error al generar corte' });
  }
}

/** ✅ NUEVO: POST /inventario/marcar-procesar?idVendedor=# */
export async function marcarCargaListaParaProcesar(req, res) {
  try {
    const vendedorId = getVendedorId(req);
    if (!vendedorId) {
      return res.status(400).json({ ok:false, msg:'Falta idVendedor' });
    }

    const data = await leerCargaActual(vendedorId);
    if (!data?.carga?.id) {
      return res.status(404).json({ ok:false, msg:'Sin carga vigente' });
    }

    const cargaId = data.carga.id;

    const [upd] = await db.query(
      `UPDATE cargas
          SET lista_para_procesar = 1
        WHERE id = ? AND procesada = 0`,
      [cargaId]
    );

    return res.json({
      ok: true,
      msg: upd.affectedRows ? 'Carga marcada para procesar' : 'Sin cambios (ya estaba marcada o no aplica)',
      data: { cargaId, lista_para_procesar: 1 }
    });
  } catch (e) {
    console.error('[inventario.marcarCargaListaParaProcesar]', e);
    return res.status(500).json({ ok:false, msg: e?.message || 'Error al marcar carga para procesar' });
  }
}
