// controllers/vendedor/balanceController.js
import db from '../../config/db.js';

/* ===================== Helpers ===================== */
const ensureNumber = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const pad2 = (n) => String(n).padStart(2, '0');
const toSqlDT = (d) => {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
};
const startOfDay = (d) => {
  const nd = new Date(d);
  nd.setHours(0, 0, 0, 0);
  return nd;
};
const endOfDay = (d) => {
  const nd = new Date(d);
  nd.setHours(23, 59, 59, 999);
  return nd;
};

async function pickUltimaCarga(vId) {
  const [[row]] = await db.query(
    `SELECT id, fecha
       FROM cargas
      WHERE id_vendedor = ?
      ORDER BY fecha DESC, id DESC
      LIMIT 1`,
    [vId]
  );
  return row || null;
}

/* ===================== Cálculos ===================== */
async function computeDinero(vId, ini, fin) {
  // Ventas con cliente
  const [[v1]] = await db.query(
    `SELECT
       SUM(CASE
             WHEN tipo_pago IN ('contado','transferencia')
              AND COALESCE(metodo_pago, CASE
                     WHEN tipo_pago='contado' THEN 'efectivo'
                     WHEN tipo_pago='transferencia' THEN 'transferencia'
                   END) = 'efectivo'
             THEN total ELSE 0 END) AS v_ct_ef,
       SUM(CASE
             WHEN tipo_pago IN ('contado','transferencia')
              AND COALESCE(metodo_pago, CASE
                     WHEN tipo_pago='contado' THEN 'efectivo'
                     WHEN tipo_pago='transferencia' THEN 'transferencia'
                   END) = 'transferencia'
             THEN total ELSE 0 END) AS v_ct_tr,
       SUM(CASE WHEN tipo_pago='credito' THEN total ELSE 0 END) AS v_cr,
       SUM(CASE
             WHEN COALESCE(metodo_pago, CASE
                     WHEN tipo_pago='contado' THEN 'efectivo'
                     WHEN tipo_pago='transferencia' THEN 'transferencia'
                   END) = 'efectivo'
             THEN total ELSE 0 END) AS v_all_ef,
       SUM(CASE
             WHEN COALESCE(metodo_pago, CASE
                     WHEN tipo_pago='contado' THEN 'efectivo'
                     WHEN tipo_pago='transferencia' THEN 'transferencia'
                   END) = 'transferencia'
             THEN total ELSE 0 END) AS v_all_tr
     FROM ventas
    WHERE id_vendedor = ? AND fecha BETWEEN ? AND ?`,
    [vId, ini, fin]
  );

  // Ventas público
  const [[vp]] = await db.query(
    `SELECT
       SUM(CASE WHEN metodo_pago='efectivo'      THEN total ELSE 0 END) AS vp_ef,
       SUM(CASE WHEN metodo_pago='transferencia' THEN total ELSE 0 END) AS vp_tr
     FROM ventas_publico
    WHERE id_vendedor = ? AND fecha BETWEEN ? AND ?`,
    [vId, ini, fin]
  );

  // Abonos a crédito
  const [[ab]] = await db.query(
    `SELECT
       SUM(CASE WHEN p.tipo_pago='efectivo'      THEN p.monto ELSE 0 END) AS ab_ef,
       SUM(CASE WHEN p.tipo_pago='transferencia' THEN p.monto ELSE 0 END) AS ab_tr
     FROM pagos_credito p
     JOIN creditos c ON c.id = p.id_credito
     JOIN ventas v   ON v.id = c.id_venta
    WHERE v.id_vendedor = ? AND p.fecha BETWEEN ? AND ?`,
    [vId, ini, fin]
  );

  const ventas_efectivo      = ensureNumber(v1?.v_all_ef, 0) + ensureNumber(vp?.vp_ef, 0);
  const ventas_transferencia = ensureNumber(v1?.v_all_tr, 0) + ensureNumber(vp?.vp_tr, 0);
  const ventas_subtotal      = ventas_efectivo + ventas_transferencia;
  const ventas_credito       = ensureNumber(v1?.v_cr, 0);
  const total_bruto          = ventas_subtotal;

  // Cobrable (contado + público)
  const cobrable_subtotal =
    ensureNumber(v1?.v_ct_ef, 0) + ensureNumber(v1?.v_ct_tr, 0) +
    ensureNumber(vp?.vp_ef, 0) + ensureNumber(vp?.vp_tr, 0);

  // Recaudado (cobrable + abonos de crédito)
  const recaudado_efectivo      = (ensureNumber(v1?.v_ct_ef, 0) + ensureNumber(vp?.vp_ef, 0)) + ensureNumber(ab?.ab_ef, 0);
  const recaudado_transferencia = (ensureNumber(v1?.v_ct_tr, 0) + ensureNumber(vp?.vp_tr, 0)) + ensureNumber(ab?.ab_tr, 0);
  const recaudado_total         = recaudado_efectivo + recaudado_transferencia;

  const balance_debe   = Math.max(cobrable_subtotal - recaudado_total, 0);
  const balance_afavor = Math.max(recaudado_total - cobrable_subtotal, 0);

  return {
    ventas_efectivo,
    ventas_transferencia,
    ventas_subtotal,
    ventas_credito,
    total_bruto,
    cobrable_subtotal,
    recaudado_efectivo,
    recaudado_transferencia,
    recaudado_total,
    balance_debe,
    balance_afavor,
  };
}

const ENVASE_LABEL = {
  1: 'Caja Chica',
  2: 'Caja Grande',
  3: 'Cubeta',
};

async function computeCajas(vId, ini, fin) {
  const [rows] = await db.query(
    `SELECT id_envase,
            SUM(CASE WHEN tipo='prestamo'    THEN cantidad ELSE 0 END) AS prestado,
            SUM(CASE WHEN tipo='recoleccion' THEN cantidad ELSE 0 END) AS recolectado
       FROM prestamos_cajas
      WHERE id_vendedor = ?
        AND fecha BETWEEN ? AND ?
      GROUP BY id_envase`,
    [vId, ini, fin]
  );

  async function computeCreditosSaldo(vId) {
  // Usa la columna 'saldo' si existe; si no, calcula (total - SUM(abonos))
  const [[row]] = await db.query(
    `SELECT SUM(c.saldo) AS saldo_total
       FROM creditos c
       JOIN ventas v ON v.id = c.id_venta
      WHERE v.id_vendedor = ?`,
    [vId]
  );
  return ensureNumber(row?.saldo_total, 0);
}

  const detalle = [];
  let debe_total = 0;
  let afavor_total = 0;

  for (const r of rows) {
    const envId = ensureNumber(r.id_envase);
    const nombre = ENVASE_LABEL[envId] || `Envase ${envId}`;
    const prestado = ensureNumber(r.prestado, 0);
    const recolectado = ensureNumber(r.recolectado, 0);

    if (prestado > recolectado) {
      const cant = prestado - recolectado;
      detalle.push({ nombre, estado: 'DEBE', cantidad: cant });
      debe_total += cant;
    } else if (recolectado > prestado) {
      const cant = recolectado - prestado;
      detalle.push({ nombre, estado: 'AFAVOR', cantidad: cant });
      afavor_total += cant;
    }
  }

  return { detalle, totales: { debe_total, afavor_total } };
}

// ... arriba, junto con computeDinero/computeCajas

/**
 * Suma el saldo vigente de TODOS los créditos del vendedor (histórico).
 * Soporta dos esquemas:
 *  - Si la tabla `creditos` tiene columna `saldo`: la usa directo.
 *  - Si no: calcula (total de la venta - SUM(abonos.monto)).
 */
async function computeCreditosSaldo(vId) {
  const [[row]] = await db.query(
    `
    SELECT
      SUM(
        COALESCE(
          c.saldo,                         -- si existe columna saldo
          (v.total - COALESCE(ab.abonos,0))-- fallback: total venta - abonos
        )
      ) AS saldo_total
    FROM creditos c
    JOIN ventas v
      ON v.id = c.id_venta
    LEFT JOIN (
      SELECT id_credito, SUM(monto) AS abonos
      FROM pagos_credito
      GROUP BY id_credito
    ) ab
      ON ab.id_credito = c.id
    WHERE v.id_vendedor = ?
    `,
    [vId]
  );
  return ensureNumber(row?.saldo_total, 0);
}

export const getBalanceVendedor = async (req, res) => {
  try {
    const vId = ensureNumber(req.params.id);
    if (!vId) return res.status(400).json({ error: 'bad_request' });

    // 👇 Fuerza "modo histórico" por defecto
    // Si el cliente no manda nada, tratamos como acumulado.
    const acumuladoFlag = ['1','true'].includes(String(req.query.acumulado||'').toLowerCase());
    const forzarAcumulado = true; // 👈 deja true para que SIEMPRE sea histórico
    const acumulado = forzarAcumulado || acumuladoFlag;

    let { ini, fin } = req.query || {};
    if (acumulado) {
      ini = '1970-01-01 00:00:00';
      fin = toSqlDT(endOfDay(new Date()));
    } else {
      // (solo si algún día quieres permitir rangos manuales)
      if (ini && /^\d{4}-\d{2}-\d{2}$/.test(String(ini))) ini = `${ini} 00:00:00`;
      if (fin && /^\d{4}-\d{2}-\d{2}$/.test(String(fin))) fin = `${fin} 23:59:59`;
      if (!ini || !fin) {
        const now = new Date();
        ini = toSqlDT(startOfDay(now));
        fin = toSqlDT(endOfDay(now));
      }
    }

    const dinero = await computeDinero(vId, ini, fin);     // 👈 ya corre histórico
    const cajas  = await computeCajas(vId, ini, fin);       // 👈 idem
    const credito_saldo_total = await computeCreditosSaldo(vId); // 👈 NUEVO

    // Alias para UI “Balance” histórico
    const ui = {
      debe: dinero.balance_debe,       // si lo usas (cobrable - recaudado) histórico
      afavor: dinero.balance_afavor,   // si aplica
      creditoSaldoTotal: credito_saldo_total, // 👈 NUEVO: lo que deben clientes (saldo vigente)
      cajasDebeTotal: cajas.totales.debe_total || 0,       // 👈 NUEVO: envases netos "Debe"
      cajasAFavorTotal: cajas.totales.afavor_total || 0    // 👈 NUEVO: envases netos "A favor"
    };

    return res.json({
      ok: true,
      data: {
        rango: { ini, fin, acumulado: true }, // 👈 deja marcado verdadero
        dinero,
        cajas,
        creditos: { saldo_total: credito_saldo_total },     // 👈 extra informativo
        ui
      },
    });
  } catch (e) {
    console.error('getBalanceVendedor', e);
    return res.status(500).json({ error: 'Error al calcular balance' });
  }
};