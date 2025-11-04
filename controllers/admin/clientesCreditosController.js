// controllers/clientesCreditosController.js
import db from '../../config/db.js';

export const creditosCliente = async (req, res) => {
  try {
    const { clienteId } = req.params;
    const [rows] = await db.query(
      `
      SELECT
        cr.id,
        cr.id_venta,
        v.fecha                                        AS fecha,
        v.total                                        AS monto,             -- alias que usa el FE
        COALESCE(pc.total_pagos,0)                     AS pagos,
        GREATEST(v.total - COALESCE(pc.total_pagos,0), 0) AS pendiente,
        cr.fecha_vencimiento                           AS fecha_limite,      -- usado por el FE
        CASE
          WHEN GREATEST(v.total - COALESCE(pc.total_pagos,0), 0) <= 0.009
          THEN 1 ELSE 0
        END                                            AS pagado,            -- usado por el FE
        cr.saldo                                       AS saldo_registrado
      FROM creditos cr
      JOIN ventas v  ON v.id = cr.id_venta
      LEFT JOIN (
        SELECT id_credito, SUM(monto) AS total_pagos
        FROM pagos_credito
        GROUP BY id_credito
      ) pc ON pc.id_credito = cr.id
      WHERE v.id_cliente = ?
      ORDER BY v.fecha DESC, cr.id DESC
      `,
      [clienteId]
    );
    res.json(rows);
  } catch (e) {
    console.error('creditosCliente', e);
    res.status(500).json({ error: 'Error al listar créditos' });
  }
};

export const saldoCliente = async (req, res) => {
  try {
    const { clienteId } = req.params;
    const [[row]] = await db.query(
      `
      SELECT
        ?                                  AS cliente_id,
        COALESCE(SUM(v.total),0)           AS total_creditos,
        COALESCE(SUM(pc.total_pagos),0)    AS total_pagos,
        COALESCE(SUM(v.total),0) - COALESCE(SUM(pc.total_pagos),0) AS saldo_pendiente
      FROM ventas v
      JOIN creditos cr ON cr.id_venta = v.id
      LEFT JOIN (
        SELECT id_credito, SUM(monto) AS total_pagos
        FROM pagos_credito
        GROUP BY id_credito
      ) pc ON pc.id_credito = cr.id
      WHERE v.tipo_pago = 'credito'
        AND v.id_cliente = ?
      `,
      [clienteId, clienteId]
    );

    res.json(
      row || {
        cliente_id: Number(clienteId),
        total_creditos: 0,
        total_pagos: 0,
        saldo_pendiente: 0,
      }
    );
  } catch (e) {
    console.error('saldoCliente', e);
    res.status(500).json({ error: 'Error al obtener saldo' });
  }
};

export const pagarCredito = async (req, res) => {
  const conn = await db.getConnection();
  try {
    let {
      id_credito,
      monto,
      tipo_pago = 'efectivo',
      referencia = null,
      observaciones = null,
    } = req.body;

    // Validaciones básicas
    if (!id_credito) return res.status(400).json({ error: 'id_credito es obligatorio' });
    monto = Number(String(monto ?? '').toString().replace(',', '.'));
    if (!Number.isFinite(monto) || monto <= 0) {
      return res.status(400).json({ error: 'monto debe ser numérico y mayor a 0' });
    }

    await conn.beginTransaction();

    // 1) Obtener crédito y venta asociada (BLOQUEADO para evitar carrera)
    const [[cr]] = await conn.query(
      `
      SELECT cr.id, cr.id_venta, v.id_cliente, v.total
      FROM creditos cr
      JOIN ventas v ON v.id = cr.id_venta
      WHERE cr.id = ?
      FOR UPDATE
      `,
      [id_credito]
    );
    if (!cr) {
      await conn.rollback();
      return res.status(404).json({ error: 'Crédito no encontrado' });
    }

    const clienteId = cr.id_cliente;

    // 2) Pagos del crédito (bloqueo implícito por transacción; lectura consistente)
    const [[pc]] = await conn.query(
      `SELECT COALESCE(SUM(monto),0) AS total_pagos FROM pagos_credito WHERE id_credito = ?`,
      [id_credito]
    );
    const pendienteCredito = Math.max(0, Number(cr.total) - Number(pc.total_pagos || 0));

    // 3) Saldo total de cliente (todas sus ventas a crédito)
    const [[sc]] = await conn.query(
      `
      SELECT
        COALESCE(SUM(v.total),0)           AS total_creditos,
        COALESCE(SUM(pp.total_pagos),0)    AS total_pagos
      FROM ventas v
      JOIN creditos c ON c.id_venta = v.id
      LEFT JOIN (
        SELECT id_credito, SUM(monto) AS total_pagos
        FROM pagos_credito
        GROUP BY id_credito
      ) pp ON pp.id_credito = c.id
      WHERE v.tipo_pago = 'credito'
        AND v.id_cliente = ?
      FOR UPDATE
      `,
      [clienteId]
    );
    const saldoClientePend = Math.max(0, Number(sc.total_creditos) - Number(sc.total_pagos));

    // 4) Reglas de negocio: no exceder pendientes
    if (monto > pendienteCredito + 1e-6) {
      await conn.rollback();
      return res.status(409).json({
        error: `El abono (${monto.toFixed(2)}) excede lo pendiente del crédito (${pendienteCredito.toFixed(2)}).`,
        pendiente_credito: Number(pendienteCredito.toFixed(2)),
        saldo_cliente: Number(saldoClientePend.toFixed(2)),
      });
    }
    if (monto > saldoClientePend + 1e-6) {
      await conn.rollback();
      return res.status(409).json({
        error: `El abono (${monto.toFixed(2)}) excede el saldo total pendiente del cliente (${saldoClientePend.toFixed(2)}).`,
        pendiente_credito: Number(pendienteCredito.toFixed(2)),
        saldo_cliente: Number(saldoClientePend.toFixed(2)),
      });
    }

    // 5) Insertar pago
    const [ins] = await conn.query(
      `
      INSERT INTO pagos_credito (id_credito, monto, tipo_pago, referencia, observaciones)
      VALUES (?, ?, ?, ?, ?)
      `,
      [id_credito, Number(monto.toFixed(2)), tipo_pago, referencia, observaciones]
    );

    // 6) Recalcular pendientes post-inserción
    const [[pc2]] = await conn.query(
      `SELECT COALESCE(SUM(monto),0) AS total_pagos FROM pagos_credito WHERE id_credito = ?`,
      [id_credito]
    );
    const pendienteCreditoNew = Math.max(0, Number(cr.total) - Number(pc2.total_pagos || 0));

    const [[sc2]] = await conn.query(
      `
      SELECT
        COALESCE(SUM(v.total),0)           AS total_creditos,
        COALESCE(SUM(pp.total_pagos),0)    AS total_pagos
      FROM ventas v
      JOIN creditos c ON c.id_venta = v.id
      LEFT JOIN (
        SELECT id_credito, SUM(monto) AS total_pagos
        FROM pagos_credito
        GROUP BY id_credito
      ) pp ON pp.id_credito = c.id
      WHERE v.tipo_pago = 'credito'
        AND v.id_cliente = ?
      `,
      [clienteId]
    );
    const saldoClientePendNew = Math.max(0, Number(sc2.total_creditos) - Number(sc2.total_pagos));

    await conn.commit();
    res.json({
      mensaje: 'Pago registrado',
      pago_id: ins.insertId,
      credito: {
        id: cr.id,
        pendiente_antes: Number(pendienteCredito.toFixed(2)),
        pendiente_despues: Number(pendienteCreditoNew.toFixed(2)),
      },
      cliente: {
        id: clienteId,
        saldo_antes: Number(saldoClientePend.toFixed(2)),
        saldo_despues: Number(saldoClientePendNew.toFixed(2)),
      }
    });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    console.error('pagarCredito', e);
    res.status(500).json({ error: 'Error al registrar pago' });
  } finally {
    conn.release();
  }
};
