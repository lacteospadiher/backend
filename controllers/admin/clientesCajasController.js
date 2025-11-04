// controllers/clientesCajasController.js
import db from '../../config/db.js';

/* ===========================
   Helpers
=========================== */
const ENVASES = {
  1: 'Caja chica',
  2: 'Caja grande',
  3: 'Cubeta',
};
const isValidEnvaseId = (id) => [1, 2, 3].includes(Number(id));

/** Arma SELECT UNPIVOT para clientes_cajas_mov -> filas (envase_id, cantidad, tipo, fecha, etc.) */
function sqlUnpivotMovimientosCliente(where = 'm.cliente_id = ?') {
  return `
    SELECT m.id AS id_mov, m.cliente_id, m.vendedor_id, m.tipo, m.created_at AS fecha,
           1 AS envase_id, m.cant_chica_aplica  AS cantidad
      FROM clientes_cajas_mov m WHERE ${where}
    UNION ALL
    SELECT m.id, m.cliente_id, m.vendedor_id, m.tipo, m.created_at,
           2, m.cant_grande_aplica
      FROM clientes_cajas_mov m WHERE ${where}
    UNION ALL
    SELECT m.id, m.cliente_id, m.vendedor_id, m.tipo, m.created_at,
           3, m.cant_cubeta_aplica
      FROM clientes_cajas_mov m WHERE ${where}
  `;
}

/** Lee (o crea virtualmente) el renglón de clientes_cajas_saldo para un cliente */
async function getSaldoRow(conn, clienteId) {
  const [[row]] = await conn.query(
    `SELECT * FROM clientes_cajas_saldo WHERE cliente_id = ?`,
    [clienteId]
  );
  if (row) return row;
  // Si no existe, regresamos objeto base (cero en todo)
  return {
    cliente_id: clienteId,
    debe_chica: 0,
    debe_grande: 0,
    debe_cubeta: 0,
    afavor_chica: 0,
    afavor_grande: 0,
    afavor_cubeta: 0,
    folio: 0,
  };
}

/** Aplica movimiento a saldos (JS) y devuelve nuevo estado + “aplicado” y “a favor generado” */
function applyMovimientoToSaldos({ tipo, envaseId, cantidad, saldos }) {
  const keyDebe =
    envaseId === 1 ? 'debe_chica' : envaseId === 2 ? 'debe_grande' : 'debe_cubeta';
  const keyAfavor =
    envaseId === 1
      ? 'afavor_chica'
      : envaseId === 2
      ? 'afavor_grande'
      : 'afavor_cubeta';

  const before = { debe: saldos[keyDebe], afavor: saldos[keyAfavor] };
  let cantAplica = 0;
  let afavorGenerado = 0;

  if (tipo === 'prestamo') {
    cantAplica = cantidad;
    saldos[keyDebe] = Number(saldos[keyDebe]) + cantAplica;
  } else {
    // recolección: primero contra lo que debe; excedente se va a favor
    const debeActual = Number(saldos[keyDebe]);
    if (cantidad <= debeActual) {
      cantAplica = cantidad;
      saldos[keyDebe] = debeActual - cantAplica;
    } else {
      cantAplica = cantidad;
      const excedente = cantidad - debeActual;
      saldos[keyDebe] = 0;
      saldos[keyAfavor] = Number(saldos[keyAfavor]) + excedente;
      afavorGenerado = excedente;
    }
  }

  const after = { debe: saldos[keyDebe], afavor: saldos[keyAfavor] };

  return { cantAplica, afavorGenerado, before, after };
}

/** Persiste/Upsert de saldos */
async function upsertSaldos(conn, saldos) {
  const {
    cliente_id,
    folio,
    debe_chica,
    debe_grande,
    debe_cubeta,
    afavor_chica,
    afavor_grande,
    afavor_cubeta,
  } = saldos;

  await conn.query(
    `
    INSERT INTO clientes_cajas_saldo
      (cliente_id, folio, debe_chica, debe_grande, debe_cubeta,
       afavor_chica, afavor_grande, afavor_cubeta, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      folio = VALUES(folio),
      debe_chica   = VALUES(debe_chica),
      debe_grande  = VALUES(debe_grande),
      debe_cubeta  = VALUES(debe_cubeta),
      afavor_chica = VALUES(afavor_chica),
      afavor_grande= VALUES(afavor_grande),
      afavor_cubeta= VALUES(afavor_cubeta),
      updated_at   = NOW()
    `,
    [
      cliente_id,
      folio,
      debe_chica,
      debe_grande,
      debe_cubeta,
      afavor_chica,
      afavor_grande,
      afavor_cubeta,
    ]
  );
}

/* ===========================
   GET /api/clientes/:clienteId/cajas/saldo
=========================== */
export const saldoCajasCliente = async (req, res) => {
  try {
    const { clienteId } = req.params;
    const id = Number(clienteId);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'clienteId inválido' });
    }

    const [rows] = await db.query(
      `
      SELECT
        t.envase_id         AS id_tipo_caja,
        e.nombre            AS nombre,
        COALESCE(SUM(CASE WHEN t.tipo='prestamo'    THEN t.cantidad END),0) AS prestadas,
        COALESCE(SUM(CASE WHEN t.tipo='recoleccion' THEN t.cantidad END),0) AS recolectadas,
        COALESCE(SUM(CASE
            WHEN t.tipo='prestamo'    THEN  t.cantidad
            WHEN t.tipo='recoleccion' THEN -t.cantidad
          END),0) AS saldo
      FROM (
        ${sqlUnpivotMovimientosCliente('m.cliente_id = ?')}
      ) AS t
      JOIN envase e ON e.id = t.envase_id
      WHERE t.cantidad > 0
      GROUP BY t.envase_id, e.nombre
      ORDER BY t.envase_id
      `,
      [id, id, id, id, id, id]
    );

    return res.json(rows);
  } catch (e) {
    console.error('saldoCajasCliente', e);
    res.status(500).json({ error: 'Error al obtener saldo de cajas' });
  }
};

/* ===========================
   GET /api/clientes/:clienteId/cajas/movimientos
=========================== */
export const movimientosCajasCliente = async (req, res) => {
  try {
    const { clienteId } = req.params;
    const id = Number(clienteId);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'clienteId inválido' });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = (page - 1) * limit;

    const [rows] = await db.query(
      `
      SELECT
        t.id_mov AS id,
        t.fecha,
        t.tipo,
        t.cantidad,
        t.envase_id         AS id_tipo_caja,
        e.nombre            AS tipo_caja,
        t.vendedor_id,
        -- nombre mostrado con fallback
        COALESCE(u.nombre, CONCAT('Vendedor #', t.vendedor_id)) AS vendedor_display
      FROM (
        ${sqlUnpivotMovimientosCliente('m.cliente_id = ?')}
      ) AS t
      JOIN envase e    ON e.id = t.envase_id
      LEFT JOIN vendedores ve ON ve.id = t.vendedor_id
      LEFT JOIN usuarios   u  ON u.id = ve.id_usuario
      WHERE t.cantidad > 0
      ORDER BY t.fecha DESC, t.id_mov DESC
      LIMIT ? OFFSET ?
      `,
      [id, id, id, id, id, id, limit, offset]
    );

    return res.json(rows);
  } catch (e) {
    console.error('movimientosCajasCliente', e);
    res.status(500).json({ error: 'Error al obtener movimientos de cajas' });
  }
};

/* ===========================
   POST /api/clientes/:clienteId/cajas/movimiento
=========================== */
export const registrarMovimientoCajas = async (req, res) => {
  const conn = await db.getConnection();
  try {
    const { clienteId } = req.params;
    const idCliente = Number(clienteId);
    const { id_tipo_caja, tipo, cantidad, id_vendedor } = req.body;

    if (!Number.isInteger(idCliente) || idCliente <= 0) {
      return res.status(400).json({ error: 'clienteId inválido' });
    }
    if (!isValidEnvaseId(Number(id_tipo_caja))) {
      return res
        .status(400)
        .json({ error: 'id_tipo_caja inválido (1=chica, 2=grande, 3=cubeta)' });
    }
    if (!['prestamo', 'recoleccion'].includes(tipo)) {
      return res.status(400).json({ error: 'tipo inválido' });
    }
    const qty = Number(cantidad);
    if (!Number.isInteger(qty) || qty <= 0) {
      return res
        .status(400)
        .json({ error: 'cantidad debe ser entero positivo' });
    }
    if (!id_vendedor) {
      return res.status(400).json({ error: 'id_vendedor es obligatorio' });
    }

    await conn.beginTransaction();

    // Validaciones de existencia
    const [[cli]] = await conn.query(
      `SELECT id FROM clientes WHERE id=? AND eliminado=0`,
      [idCliente]
    );
    if (!cli) {
      await conn.rollback();
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const [[env]] = await conn.query(`SELECT id FROM envase WHERE id=?`, [
      id_tipo_caja,
    ]);
    if (!env) {
      await conn.rollback();
      return res.status(404).json({ error: 'Envase no encontrado' });
    }

    const [[vend]] = await conn.query(
      `SELECT id FROM vendedores WHERE id=? AND activo=1 AND eliminado=0`,
      [id_vendedor]
    );
    if (!vend) {
      await conn.rollback();
      return res
        .status(404)
        .json({ error: 'Vendedor no encontrado o inactivo' });
    }

    // Lee saldos actuales (o base “en memoria” si aún no existe la fila)
    const saldos = await getSaldoRow(conn, idCliente);

    // Aplica movimiento en memoria
    const { cantAplica, afavorGenerado, before, after } = applyMovimientoToSaldos({
      tipo,
      envaseId: Number(id_tipo_caja),
      cantidad: qty,
      saldos,
    });

    // Incrementa folio
    saldos.folio = Number(saldos.folio || 0) + 1;

    // Persiste saldos
    await upsertSaldos(conn, saldos);

    // Inserta en bitácora clientes_cajas_mov (usando columnas por envase)
    const campos = {
      cant_chica_solic: 0,
      cant_grande_solic: 0,
      cant_cubeta_solic: 0,
      cant_chica_aplica: 0,
      cant_grande_aplica: 0,
      cant_cubeta_aplica: 0,
      saldo_antes_chica: saldos.debe_chica,
      saldo_antes_grande: saldos.debe_grande,
      saldo_antes_cubeta: saldos.debe_cubeta,
      saldo_despues_chica: saldos.debe_chica,
      saldo_despues_grande: saldos.debe_grande,
      saldo_despues_cubeta: saldos.debe_cubeta,
      afavor_generado_chica: 0,
      afavor_generado_grande: 0,
      afavor_generado_cubeta: 0,
      afavor_antes_chica: saldos.afavor_chica,
      afavor_antes_grande: saldos.afavor_grande,
      afavor_antes_cubeta: saldos.afavor_cubeta,
      afavor_despues_chica: saldos.afavor_chica,
      afavor_despues_grande: saldos.afavor_grande,
      afavor_despues_cubeta: saldos.afavor_cubeta,
    };

    const setFor = (envaseId, kind, value) => {
      if (envaseId === 1) campos[`cant_chica_${kind}`] = value;
      if (envaseId === 2) campos[`cant_grande_${kind}`] = value;
      if (envaseId === 3) campos[`cant_cubeta_${kind}`] = value;
    };

    setFor(Number(id_tipo_caja), 'solic', qty);
    setFor(Number(id_tipo_caja), 'aplica', cantAplica);
    if (afavorGenerado > 0) {
      if (Number(id_tipo_caja) === 1) campos.afavor_generado_chica = afavorGenerado;
      if (Number(id_tipo_caja) === 2) campos.afavor_generado_grande = afavorGenerado;
      if (Number(id_tipo_caja) === 3) campos.afavor_generado_cubeta = afavorGenerado;
    }

    // Ajusta “antes/después” reales en la bitácora para el envase tocado
    const patchAntes = (envaseId, k, v) => {
      if (envaseId === 1) campos[`saldo_${k}_chica`] = v;
      if (envaseId === 2) campos[`saldo_${k}_grande`] = v;
      if (envaseId === 3) campos[`saldo_${k}_cubeta`] = v;
    };
    const patchAfavorAntes = (envaseId, k, v) => {
      if (envaseId === 1) campos[`afavor_${k}_chica`] = v;
      if (envaseId === 2) campos[`afavor_${k}_grande`] = v;
      if (envaseId === 3) campos[`afavor_${k}_cubeta`] = v;
    };

    patchAntes(Number(id_tipo_caja), 'antes', before.debe);
    patchAntes(Number(id_tipo_caja), 'despues', after.debe);
    patchAfavorAntes(Number(id_tipo_caja), 'antes', before.afavor);
    patchAfavorAntes(Number(id_tipo_caja), 'despues', after.afavor);

    const [ins] = await conn.query(
      `
      INSERT INTO clientes_cajas_mov
        (cliente_id, vendedor_id, tipo,
         cant_chica_solic, cant_grande_solic, cant_cubeta_solic,
         cant_chica_aplica, cant_grande_aplica, cant_cubeta_aplica,
         saldo_antes_chica, saldo_antes_grande, saldo_antes_cubeta,
         saldo_despues_chica, saldo_despues_grande, saldo_despues_cubeta,
         afavor_generado_chica, afavor_generado_grande, afavor_generado_cubeta,
         afavor_antes_chica, afavor_antes_grande, afavor_antes_cubeta,
         afavor_despues_chica, afavor_despues_grande, afavor_despues_cubeta,
         folio, observacion, created_at)
      VALUES
        (?, ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, NULL, NOW())
      `,
      [
        idCliente,
        id_vendedor,
        tipo,
        campos.cant_chica_solic,
        campos.cant_grande_solic,
        campos.cant_cubeta_solic,
        campos.cant_chica_aplica,
        campos.cant_grande_aplica,
        campos.cant_cubeta_aplica,
        campos.saldo_antes_chica ?? before.debe,
        campos.saldo_antes_grande ?? before.debe,
        campos.saldo_antes_cubeta ?? before.debe,
        campos.saldo_despues_chica ?? after.debe,
        campos.saldo_despues_grande ?? after.debe,
        campos.saldo_despues_cubeta ?? after.debe,
        campos.afavor_generado_chica,
        campos.afavor_generado_grande,
        campos.afavor_generado_cubeta,
        campos.afavor_antes_chica ?? before.afavor,
        campos.afavor_antes_grande ?? before.afavor,
        campos.afavor_antes_cubeta ?? before.afavor,
        campos.afavor_despues_chica ?? after.afavor,
        campos.afavor_despues_grande ?? after.afavor,
        campos.afavor_despues_cubeta ?? after.afavor,
        saldos.folio,
      ]
    );

    await conn.commit();
    return res.json({
      ok: true,
      movimiento_id: ins.insertId,
      aplicado: cantAplica,
      afavor_generado: afavorGenerado,
      saldo_after: {
        chica: saldos.debe_chica,
        grande: saldos.debe_grande,
        cubeta: saldos.debe_cubeta,
      },
      afavor_after: {
        chica: saldos.afavor_chica,
        grande: saldos.afavor_grande,
        cubeta: saldos.afavor_cubeta,
      },
      folio: saldos.folio,
    });
  } catch (e) {
    await conn.rollback();
    console.error('registrarMovimientoCajas', e);
    res.status(500).json({ error: 'Error al registrar movimiento de cajas' });
  } finally {
    conn.release();
  }
};

/* ===========================
   GET /api/clientes/:clienteId/cajas/detalle
=========================== */
export const detalleCajasCliente = async (req, res) => {
  try {
    const { clienteId } = req.params;
    const id = Number(clienteId);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'clienteId inválido' });
    }

    // Movimientos expandiendo por envase (sólo con cantidad > 0) ordenados cronológicamente
    const [movs] = await db.query(
      `
      SELECT
        t.id_mov AS id,
        t.cliente_id,
        t.envase_id,
        e.nombre AS tipo_nombre,
        t.vendedor_id,
        -- nombre mostrado con fallback
        COALESCE(u.nombre, CONCAT('Vendedor #', t.vendedor_id))  AS vendedor_nombre,
        t.cantidad,
        t.tipo AS movimiento,      -- 'prestamo' | 'recoleccion'
        t.fecha
      FROM (
        ${sqlUnpivotMovimientosCliente('m.cliente_id = ?')}
      ) t
      JOIN envase e ON e.id = t.envase_id
      LEFT JOIN vendedores ve ON ve.id = t.vendedor_id
      LEFT JOIN usuarios   u  ON u.id = ve.id_usuario
      WHERE t.cantidad > 0
      ORDER BY t.envase_id, t.fecha, t.id_mov
      `,
      [id, id, id, id, id, id]
    );

    // Resumen + FIFO
    const resumenMap = new Map(); // envase_id -> {prestadas, recolectadas, saldo}
    const queues = new Map(); // envase_id -> [{...prestamo pendiente...}]

    for (const row of movs) {
      const envId = row.envase_id;
      if (!resumenMap.has(envId)) {
        resumenMap.set(envId, {
          id_tipo_caja: envId,
          nombre: row.tipo_nombre,
          prestadas: 0,
          recolectadas: 0,
          saldo: 0,
        });
      }
      const res = resumenMap.get(envId);
      const q = queues.get(envId) || [];
      const qty = Number(row.cantidad) || 0;

      if (row.movimiento === 'prestamo') {
        res.prestadas += qty;
        res.saldo += qty;
        q.push({
          id_movimiento: row.id,
          tipo_caja_id: envId,
          tipo_nombre: row.tipo_nombre,
          vendedor_id: row.vendedor_id || null,
          prestado_por: row.vendedor_nombre || null,
          fecha_prestamo: row.fecha,
          cantidad: qty,
        });
      } else {
        res.recolectadas += qty;
        res.saldo -= qty;
        let toConsume = qty;
        while (toConsume > 0 && q.length) {
          const loan = q[0];
          const use = Math.min(loan.cantidad, toConsume);
          loan.cantidad -= use;
          toConsume -= use;
          if (loan.cantidad <= 0) q.shift();
        }
        queues.set(envId, q);
      }

      queues.set(envId, q);
    }

    const pendientes = [];
    for (const [, arr] of queues) {
      for (const loan of arr) {
        if (loan.cantidad > 0) pendientes.push(loan);
      }
    }
    pendientes.sort(
      (a, b) => new Date(a.fecha_prestamo) - new Date(b.fecha_prestamo)
    );

    const resumen = Array.from(resumenMap.values()).sort(
      (a, b) => a.id_tipo_caja - b.id_tipo_caja
    );

    return res.json({ cliente_id: id, pendientes, resumen });
  } catch (e) {
    console.error('detalleCajasCliente', e);
    res.status(500).json({ error: 'Error al obtener detalle de cajas' });
  }
};
