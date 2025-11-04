// controllers/vendedor/prestamosCajasController.js
import db from '../../config/db.js';

async function resolveClienteId({ clienteId, codigoQR }) {
  const idNum = Number(clienteId);
  if (Number.isFinite(idNum) && idNum > 0) return idNum;

  if (codigoQR) {
    const [[row]] = await db.query(
      'SELECT id FROM clientes WHERE codigo_qr = ? AND eliminado = 0',
      [codigoQR]
    );
    if (row?.id) return Number(row.id);
  }
  return null;
}
const toInt = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);

/** GET /api/vendedor/prestamos-cajas/saldo?clienteId=### | ?codigoQR=... */
export async function getSaldoCliente(req, res) {
  try {
    const clienteId = await resolveClienteId({
      clienteId: req.query.clienteId,
      codigoQR: req.query.codigoQR,
    });
    if (!clienteId) return res.status(400).json({ ok: false, error: 'clienteId o codigoQR requerido' });

    const [[s]] = await db.query(
      `SELECT * FROM clientes_cajas_saldo WHERE cliente_id = ?`,
      [clienteId]
    );

    const [[cli]] = await db.query(
      `SELECT id, nombre_empresa AS nombre, codigo_qr FROM clientes WHERE id = ?`,
      [clienteId]
    );

    res.json({
      ok: true,
      cliente: cli || { id: clienteId },
      saldo: s || {
        cliente_id: clienteId,
        debe_chica: 0, debe_grande: 0, debe_cubeta: 0,
        afavor_chica: 0, afavor_grande: 0, afavor_cubeta: 0,
        folio: 0, updated_at: null,
      },
    });
  } catch (e) {
    console.error('[getSaldoCliente]', e);
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
}

/** GET /api/vendedor/prestamos-cajas/historial?clienteId=### | ?codigoQR=...&limit=100 */
export async function getHistorialCliente(req, res) {
  try {
    const clienteId = await resolveClienteId({
      clienteId: req.query.clienteId,
      codigoQR: req.query.codigoQR,
    });
    if (!clienteId) return res.status(400).json({ ok: false, error: 'clienteId o codigoQR requerido' });

    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);

    const [rows] = await db.query(
      `SELECT * FROM clientes_cajas_mov
        WHERE cliente_id = ?
     ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      [clienteId, limit]
    );

    res.json({ ok: true, items: rows });
  } catch (e) {
    console.error('[getHistorialCliente]', e);
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
}

/**
 * POST /api/vendedor/prestamos-cajas/movimientos
 * body: {
 *   clienteId?: number, codigoQR?: string,
 *   vendedorId?: number,
 *   tipo: 'prestamo' | 'recoleccion',
 *   chica?: number, grande?: number, cubeta?: number,
 *   observacion?: string
 * }
 */
export async function registrarMovimiento(req, res) {
  const {
    clienteId: cliRaw,
    codigoQR,
    vendedorId,
    tipo,
    chica = 0,
    grande = 0,
    cubeta = 0,
    observacion = null,
  } = req.body || {};

  const tipoNorm = String(tipo || '').toLowerCase();
  if (!['prestamo', 'recoleccion'].includes(tipoNorm)) {
    return res.status(400).json({ ok: false, error: "tipo inválido (prestamo|recoleccion)" });
  }
  const c = toInt(chica), g = toInt(grande), b = toInt(cubeta);
  if (c <= 0 && g <= 0 && b <= 0) {
    return res.status(400).json({ ok: false, error: 'Ingresa al menos una cantidad > 0' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const clienteId = await resolveClienteId({ clienteId: cliRaw, codigoQR });
    if (!clienteId) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: 'Cliente no encontrado' });
    }

    // Saldos actuales con lock
    const [[s]] = await conn.query(
      `SELECT * FROM clientes_cajas_saldo WHERE cliente_id = ? FOR UPDATE`,
      [clienteId]
    );

    const curDebeC = s ? Number(s.debe_chica) : 0;
    const curDebeG = s ? Number(s.debe_grande) : 0;
    const curDebeB = s ? Number(s.debe_cubeta) : 0;
    const curFavC  = s ? Number(s.afavor_chica) : 0;
    const curFavG  = s ? Number(s.afavor_grande) : 0;
    const curFavB  = s ? Number(s.afavor_cubeta) : 0;
    const curFolio = s ? Number(s.folio) : 0;

    let aplC = c, aplG = g, aplB = b;
    let nuevoDebeC, nuevoDebeG, nuevoDebeB;
    let genFavC = 0, genFavG = 0, genFavB = 0;
    let nuevoFavC = curFavC, nuevoFavG = curFavG, nuevoFavB = curFavB;

    if (tipoNorm === 'prestamo') {
      nuevoDebeC = curDebeC + aplC;
      nuevoDebeG = curDebeG + aplG;
      nuevoDebeB = curDebeB + aplB;
    } else {
      // recolección: resta; excedente se vuelca a aFavor
      const rawC = curDebeC - aplC;
      const rawG = curDebeG - aplG;
      const rawB = curDebeB - aplB;

      genFavC = Math.max(0, -rawC);
      genFavG = Math.max(0, -rawG);
      genFavB = Math.max(0, -rawB);

      nuevoDebeC = Math.max(0, rawC);
      nuevoDebeG = Math.max(0, rawG);
      nuevoDebeB = Math.max(0, rawB);

      nuevoFavC = curFavC + genFavC;
      nuevoFavG = curFavG + genFavG;
      nuevoFavB = curFavB + genFavB;
    }

    const nuevoFolio = curFolio + 1;

    // UPSERT saldo
    await conn.query(
      `INSERT INTO clientes_cajas_saldo
         (cliente_id, debe_chica, debe_grande, debe_cubeta,
          afavor_chica, afavor_grande, afavor_cubeta, folio)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         debe_chica=VALUES(debe_chica),
         debe_grande=VALUES(debe_grande),
         debe_cubeta=VALUES(debe_cubeta),
         afavor_chica=VALUES(afavor_chica),
         afavor_grande=VALUES(afavor_grande),
         afavor_cubeta=VALUES(afavor_cubeta),
         folio=VALUES(folio)`,
      [
        clienteId,
        nuevoDebeC, nuevoDebeG, nuevoDebeB,
        nuevoFavC,  nuevoFavG,  nuevoFavB,
        nuevoFolio,
      ]
    );

    // Historial
    await conn.query(
      `INSERT INTO clientes_cajas_mov
        (cliente_id, vendedor_id, tipo,
         cant_chica_solic, cant_grande_solic, cant_cubeta_solic,
         cant_chica_aplica, cant_grande_aplica, cant_cubeta_aplica,
         saldo_antes_chica, saldo_antes_grande, saldo_antes_cubeta,
         saldo_despues_chica, saldo_despues_grande, saldo_despues_cubeta,
         afavor_generado_chica, afavor_generado_grande, afavor_generado_cubeta,
         afavor_antes_chica, afavor_antes_grande, afavor_antes_cubeta,
         afavor_despues_chica, afavor_despues_grande, afavor_despues_cubeta,
         folio, observacion)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        clienteId, vendedorId || null, tipoNorm,
        c, g, b,
        aplC, aplG, aplB,
        curDebeC, curDebeG, curDebeB,
        nuevoDebeC, nuevoDebeG, nuevoDebeB,
        genFavC, genFavG, genFavB,
        curFavC, curFavG, curFavB,
        nuevoFavC, nuevoFavG, nuevoFavB,
        nuevoFolio, observacion,
      ]
    );

    await conn.commit();

    res.json({
      ok: true,
      clienteId,
      folio: nuevoFolio,
      saldo: {
        debeChica:  nuevoDebeC,
        debeGrande: nuevoDebeG,
        debeCubeta: nuevoDebeB,
        aFavorChica:  nuevoFavC,
        aFavorGrande: nuevoFavG,
        aFavorCubeta: nuevoFavB,
      },
    });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    console.error('[registrarMovimiento]', e);
    res.status(500).json({ ok: false, error: 'Error al registrar movimiento' });
  } finally {
    conn.release();
  }
}
