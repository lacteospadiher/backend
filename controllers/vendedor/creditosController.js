// controllers/vendedor/creditosController.js
import db from '../../config/db.js';

const EPS = 0.009; // ~1 centavo de tolerancia

async function getPoliticaCredito(clienteId) {
  const [[cli]] = await db.query(`
    SELECT
      id,
      COALESCE(permite_credito,0)           AS permite_credito,
      COALESCE(dias_credito,0)              AS dias_credito,
      COALESCE(limite_credito_monto,0)      AS limite_monto,
      COALESCE(limite_creditos_abiertos,0)  AS limite_abiertos
    FROM clientes
    WHERE id = ?
    LIMIT 1`, [clienteId]);

  if (!cli) return null;

  const [[aggs]] = await db.query(`
    SELECT
      COUNT(*)                                   AS abiertos,
      COALESCE(SUM(c.saldo),0)                   AS saldo_abierto,
      MIN(c.fecha_vencimiento)                   AS proximo_vencimiento
    FROM creditos c
    JOIN ventas v ON v.id = c.id_venta
    WHERE v.id_cliente = ?
      AND c.saldo > ?`,
    [clienteId, EPS]
  );

  const abiertos = Number(aggs?.abiertos || 0);
  const saldoAbierto = Number(aggs?.saldo_abierto || 0);

  return {
    cliente_id: clienteId,
    permite_credito: !!cli.permite_credito,
    dias_credito: Number(cli.dias_credito || 0),
    limite_abiertos: Number(cli.limite_abiertos || 0),
    limite_monto: Number(cli.limite_monto || 0),
    abiertos,
    saldo_abierto: saldoAbierto,
    proximo_vencimiento: aggs?.proximo_vencimiento ?? null,
    puede_abrir:
      !!cli.permite_credito &&
      (cli.limite_abiertos ? abiertos < cli.limite_abiertos : true) &&
      (cli.limite_monto    ? saldoAbierto < cli.limite_monto : true),
    capacidad_restante: {
      abiertos: Math.max((cli.limite_abiertos || 0) - abiertos, 0),
      monto:    Math.max((cli.limite_monto    || 0) - saldoAbierto, 0)
    }
  };
}

function isPaid(saldo) {
  return Math.abs(Number(saldo || 0)) <= EPS;
}

function estadoMatch(saldo, estado) {
  if (estado === 'pendiente') return Number(saldo || 0) > EPS;
  if (estado === 'pagado')    return isPaid(saldo);
  return true; // 'todos'
}

function normEstado(raw) {
  const v = String(raw || 'pendiente').toLowerCase();
  if (v === 'pendiente' || v === 'pagado' || v === 'todos') return v;
  return 'pendiente';
}

/**
 * GET /api/creditos/por-qr/:codigo
 * ?estado=pendiente|pagado|todos (default: pendiente)
 * 🔒 Oculta créditos marcados para no mostrar al vendedor.
 */
export async function getCreditosPorQR(req, res) {
  try {
    const codigo = String(req.params.codigo || '').trim();
    if (!codigo) return res.status(400).json({ message: 'codigo_qr requerido' });

    const estado = normEstado(req.query.estado);

    const [[cli]] = await db.query(
      `SELECT id, nombre_empresa AS nombre
         FROM clientes
        WHERE codigo_qr=? AND activo=1 AND eliminado=0
        LIMIT 1`,
      [codigo]
    );
    if (!cli) return res.status(404).json({ message: 'Cliente no encontrado para ese QR' });

    const politica = await getPoliticaCredito(cli.id);

    const [rows] = await db.query(
      `SELECT c.id            AS creditoId,
              v.id            AS ventaId,
              v.fecha         AS fecha,
              COALESCE(c.total, v.total) AS total,
              c.saldo         AS saldo,
              c.fecha_vencimiento       AS fechaVencimiento,
              v.id_vendedor   AS idVendedor,
              u.nombre        AS vendedor
         FROM creditos c
         JOIN ventas      v  ON v.id = c.id_venta
         JOIN vendedores  ve ON ve.id = v.id_vendedor
         JOIN usuarios    u  ON u.id = ve.id_usuario
        WHERE v.id_cliente = ?
          AND c.ocultar_vendedor = 0
        ORDER BY v.fecha DESC, c.id DESC`,
      [cli.id]
    );

    const creditos = rows
      .filter(r => estadoMatch(r.saldo, estado))
      .map(r => {
        const pagado = isPaid(r.saldo);
        const vencido = !pagado && r.fechaVencimiento && new Date(r.fechaVencimiento) < new Date();
        return {
          creditoId : r.creditoId,
          ventaId   : r.ventaId,
          fecha     : r.fecha,
          fechaVencimiento: r.fechaVencimiento,
          total     : Number(r.total || 0),
          saldo     : Number(r.saldo || 0),
          idVendedor: r.idVendedor,
          vendedor  : r.vendedor,
          estado    : pagado ? 'Pagado' : (vencido ? 'Vencido' : 'Pendiente')
        };
      });

    res.json({
      cliente: { id: cli.id, nombre: cli.nombre },
      politica,
      creditos
    });
  } catch (e) {
    console.error('[getCreditosPorQR]', e);
    res.status(500).json({ message: 'Error obteniendo créditos por QR' });
  }
}

/**
 * GET /api/creditos/cliente/:clienteId
 * 🔒 Oculta créditos de cadena/C al vendedor.
 */
export async function getCreditosPorCliente(req, res) {
  try {
    const clienteId = Number(req.params.clienteId);
    if (!Number.isFinite(clienteId) || clienteId <= 0) {
      return res.status(400).json({ message: 'clienteId inválido' });
    }
    const estado = normEstado(req.query.estado);

    const [rows] = await db.query(
      `SELECT c.id            AS creditoId,
              v.id            AS ventaId,
              v.fecha         AS fecha,
              COALESCE(c.total, v.total) AS total,
              c.saldo         AS saldo,
              c.fecha_vencimiento       AS fechaVencimiento,
              v.id_vendedor   AS idVendedor,
              u.nombre        AS vendedor
         FROM creditos c
         JOIN ventas      v  ON v.id = c.id_venta
         JOIN vendedores  ve ON ve.id = v.id_vendedor
         JOIN usuarios    u  ON u.id = ve.id_usuario
        WHERE v.id_cliente = ?
          AND c.ocultar_vendedor = 0
        ORDER BY v.fecha DESC, c.id DESC`,
      [clienteId]
    );

    const creditos = rows
      .filter(r => estadoMatch(r.saldo, estado))
      .map(r => {
        const pagado = isPaid(r.saldo);
        const vencido = !pagado && r.fechaVencimiento && new Date(r.fechaVencimiento) < new Date();
        return {
          creditoId : r.creditoId,
          ventaId   : r.ventaId,
          fecha     : r.fecha,
          fechaVencimiento: r.fechaVencimiento,
          total     : Number(r.total || 0),
          saldo     : Number(r.saldo || 0),
          idVendedor: r.idVendedor,
          vendedor  : r.vendedor,
          estado    : pagado ? 'Pagado' : (vencido ? 'Vencido' : 'Pendiente')
        };
      });

    res.json(creditos);
  } catch (e) {
    console.error('[getCreditosPorCliente]', e);
    res.status(500).json({ message: 'Error obteniendo créditos' });
  }
}

/**
 * GET /api/creditos/:creditoId
 * 🔒 Si es crédito oculto, no se devuelve al vendedor.
 */
export async function getCreditoDetalle(req, res) {
  try {
    const creditoId = Number(req.params.creditoId);
    if (!Number.isFinite(creditoId) || creditoId <= 0) {
      return res.status(400).json({ message: 'creditoId inválido' });
    }

    const [[cab]] = await db.query(
      `SELECT c.id AS creditoId, c.saldo,
              COALESCE(c.total, v.total) AS total,
              c.fecha_vencimiento       AS fechaVencimiento,
              v.id AS ventaId, v.fecha,
              cli.id AS clienteId, cli.nombre_empresa AS cliente,
              u.nombre AS vendedor,
              c.ocultar_vendedor
         FROM creditos c
         JOIN ventas      v  ON v.id = c.id_venta
         LEFT JOIN clientes cli ON cli.id = v.id_cliente
         JOIN vendedores ve ON ve.id = v.id_vendedor
         JOIN usuarios   u  ON u.id = ve.id_usuario
        WHERE c.id = ?
        LIMIT 1`,
      [creditoId]
    );
    if (!cab) return res.status(404).json({ message: 'Crédito no encontrado' });
    if (cab.ocultar_vendedor) return res.status(404).json({ message: 'Crédito no disponible' });

    const [abonos] = await db.query(
      `SELECT id, monto, tipo_pago AS tipoPago, procesado, fecha, referencia, observaciones
         FROM pagos_credito
        WHERE id_credito = ?
        ORDER BY fecha ASC, id ASC`,
      [creditoId]
    );

    const pagado = isPaid(cab.saldo);
    const vencido = !pagado && cab.fechaVencimiento && new Date(cab.fechaVencimiento) < new Date();

    res.json({
      creditoId: cab.creditoId,
      venta: {
        id   : cab.ventaId,
        fecha: cab.fecha,
        total: Number(cab.total || 0)
      },
      cliente : { id: cab.clienteId, nombre: cab.cliente },
      vendedor: cab.vendedor,
      saldo   : Number(cab.saldo || 0),
      fechaVencimiento: cab.fechaVencimiento,
      estado  : pagado ? 'Pagado' : (vencido ? 'Vencido' : 'Pendiente'),
      abonos  : abonos.map(a => ({
        id           : a.id,
        monto        : Number(a.monto || 0),
        tipoPago     : a.tipoPago,
        procesado    : !!a.procesado,
        fecha        : a.fecha,
        referencia   : a.referencia ?? null,
        observaciones: a.observaciones ?? null
      }))
    });
  } catch (e) {
    console.error('[getCreditoDetalle]', e);
    res.status(500).json({ message: 'Error obteniendo detalle de crédito' });
  }
}

/**
 * POST /api/creditos/:creditoId/abonos
 */
export async function postAbono(req, res) {
  const conn = await db.getConnection();
  try {
    const creditoId = Number(req.params.creditoId);
    if (!Number.isFinite(creditoId) || creditoId <= 0) {
      return res.status(400).json({ message: 'creditoId inválido' });
    }

    const monto = Number(req.body?.monto);
    const tipoPago = String(req.body?.tipo_pago || '').toLowerCase();
    const procesado = Number(req.body?.procesado ?? 0) ? 1 : 0;

    const referencia = (req.body?.referencia ?? '').toString().trim() || null;
    const observaciones = (req.body?.observaciones ?? '').toString().trim() || null;

    if (!Number.isFinite(monto) || monto <= 0) {
      return res.status(400).json({ message: 'monto inválido' });
    }
    if (!['efectivo', 'transferencia'].includes(tipoPago)) {
      return res.status(400).json({ message: 'tipo_pago inválido' });
    }

    await conn.beginTransaction();

    const [[cred]] = await conn.query(
      `SELECT c.id, c.saldo, c.ocultar_vendedor, COALESCE(c.total, v.total) AS total
         FROM creditos c
         JOIN ventas v ON v.id = c.id_venta
        WHERE c.id = ?
        FOR UPDATE`,
      [creditoId]
    );
    if (!cred) {
      await conn.rollback();
      return res.status(404).json({ message: 'Crédito no encontrado' });
    }
    if (cred.ocultar_vendedor) {
      await conn.rollback();
      return res.status(403).json({ message: 'No permitido' });
    }

    const saldoActual = Number(cred.saldo || 0);
    if (monto > saldoActual + EPS) {
      await conn.rollback();
      return res.status(400).json({ message: 'El abono excede el saldo actual' });
    }

    await conn.query(
      `INSERT INTO pagos_credito (id_credito, monto, tipo_pago, procesado, referencia, observaciones, fecha)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [creditoId, monto, tipoPago, procesado, referencia, observaciones]
    );

    const [[c2]] = await conn.query(
      `SELECT saldo FROM creditos WHERE id = ?`,
      [creditoId]
    );

    await conn.commit();

    const nuevoSaldo = Number(c2?.saldo || 0);
    return res.json({
      ok: true,
      saldoActual: nuevoSaldo,
      estado: isPaid(nuevoSaldo) ? 'Pagado' : 'Pendiente'
    });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    console.error('[postAbono]', e);
    res.status(500).json({ message: 'Error registrando abono' });
  } finally {
    try { conn.release?.(); } catch {}
  }
}

/**
 * GET /api/creditos
 * 🔒 Filtra ocultos (cadena/C) para vendedor.
 */
export async function getCreditos(req, res) {
  try {
    const estado = normEstado(req.query.estado);
    const vendedorId = Number(req.query.vendedor_id || 0) || null;
    const clienteId  = Number(req.query.cliente_id  || 0) || null;

    const where = ['c.ocultar_vendedor = 0'];
    const params = [];

    if (vendedorId) { where.push('v.id_vendedor = ?'); params.push(vendedorId); }
    if (clienteId)  { where.push('v.id_cliente  = ?'); params.push(clienteId);  }

    const baseSql =
      `SELECT c.id AS creditoId,
              c.saldo AS saldo,
              v.id AS ventaId,
              v.fecha AS fecha,
              COALESCE(c.total, v.total) AS total,
              cli.id AS clienteId,
              cli.nombre_empresa AS cliente,
              v.id_vendedor AS idVendedor,
              u.nombre AS vendedor,
              c.fecha_vencimiento AS fechaVencimiento
         FROM creditos c
         JOIN ventas      v  ON v.id = c.id_venta
         LEFT JOIN clientes cli ON cli.id = v.id_cliente
         JOIN vendedores ve  ON ve.id = v.id_vendedor
         JOIN usuarios   u   ON u.id = ve.id_usuario`;

    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const orderSql = ` ORDER BY v.fecha DESC, c.id DESC`;

    const [rowsAll] = await db.query(baseSql + whereSql + orderSql, params);

    const rows = rowsAll.filter(r => estadoMatch(r.saldo, estado));

    res.json(rows.map(r => {
      const pagado = isPaid(r.saldo);
      const vencido = !pagado && r.fechaVencimiento && new Date(r.fechaVencimiento) < new Date();
      return {
        creditoId : r.creditoId,
        ventaId   : r.ventaId,
        fecha     : r.fecha,
        fechaVencimiento: r.fechaVencimiento,
        total     : Number(r.total || 0),
        saldo     : Number(r.saldo || 0),
        cliente   : r.cliente,
        clienteId : r.clienteId,
        idVendedor: r.idVendedor,
        vendedor  : r.vendedor,
        estado    : pagado ? 'Pagado' : (vencido ? 'Vencido' : 'Pendiente')
      };
    }));
  } catch (e) {
    console.error('[getCreditos]', e);
    res.status(500).json({ message: 'Error listando créditos' });
  }
}
