// controllers/vendedor/scannerController.js
import db from '../../config/db.js';

/** Lee vendedorId del JWT o lo resuelve por el usuario */
async function getVendedorId(req, conn) {
  // 1) si ya viene explícito
  const directo =
    Number(
      req.user?.vendedorId ??
      req.user?.id_vendedor ??
      req.body?.idVendedor ??
      req.query?.idVendedor ??
      req.params?.vendedorId
    ) || null;
  if (directo) return directo;

  // 2) si sólo tenemos el id de usuario autenticado
  const userId = Number(req.user?.id || 0);
  if (!userId) return null;
  const [[row]] = await conn.query(
    'SELECT id FROM vendedores WHERE id_usuario=? LIMIT 1',
    [userId]
  );
  return row?.id || null;
}

const normCode = (s) => String(s ?? '').trim();

/** ========== 1) VALIDAR CÓDIGO ========== */
/** POST /validar  { codigo } -> cliente básico */
export async function validarCodigo(req, res) {
  const conn = await db.getConnection();
  try {
    const codigo = normCode(req.body?.codigo ?? req.params?.codigo);
    if (!codigo) return res.status(400).json({ ok: false, msg: 'Falta código' });

    const [rows] = await conn.query(
      `SELECT c.id,
              c.clave,
              c.nombre_empresa  AS nombre,
              c.permite_credito,
              c.pricing_mode,
              c.codigo_qr
         FROM clientes c
        WHERE c.activo=1 AND c.eliminado=0
          AND (c.codigo_qr = ? OR c.clave = ?)
        LIMIT 1`,
      [codigo, codigo]
    );

    if (!rows.length) return res.status(404).json({ ok: false, msg: 'Código no encontrado' });
    return res.json({ ok: true, data: rows[0] });
  } catch (e) {
    return res.status(500).json({ ok: false, msg: e?.message || 'Error validando' });
  } finally {
    try { conn.release(); } catch {}
  }
}

/** GET /cliente/:codigo -> alias GET */
export async function getClientePorCodigo(req, res) {
  req.body = { codigo: req.params?.codigo };
  return validarCodigo(req, res);
}

/** ========== 2) MARCAR ESCANEO EN LA RUTA ========== */
/**
 * POST /marcar-escaneo
 * body: { codigo?, clienteId?, rutaId? }
 * - Si no mandas rutaId, toma/crea la ruta de HOY del vendedor autenticado.
 * - Asegura la parada y marca scaneado=1, fecha_scaneo=NOW().
 * - Registra un movimiento de ruta (escaneo_qr=1).
 */
export async function marcarEscaneo(req, res) {
  const conn = await db.getConnection();
  try {
    const vendedorId = await getVendedorId(req, conn);
    if (!vendedorId) return res.status(400).json({ ok: false, msg: 'Falta vendedor (JWT o parámetro)' });

    // Resolver cliente
    let clienteId = Number(req.body?.clienteId || 0) || null;
    if (!clienteId) {
      const codigo = normCode(req.body?.codigo);
      if (!codigo) return res.status(400).json({ ok: false, msg: 'Falta clienteId o codigo' });
      const [[c]] = await conn.query(
        `SELECT id FROM clientes WHERE (codigo_qr=? OR clave=?) AND activo=1 AND eliminado=0 LIMIT 1`,
        [codigo, codigo]
      );
      if (!c) return res.status(404).json({ ok: false, msg: 'Cliente no encontrado para el código' });
      clienteId = c.id;
    }

    // Resolver ruta del día
    let rutaId = Number(req.body?.rutaId || 0) || null;
    if (!rutaId) {
      const [[r]] = await conn.query(
        `SELECT id FROM rutas_diarias WHERE id_vendedor=? AND fecha=CURDATE() LIMIT 1`,
        [vendedorId]
      );
      if (r) {
        rutaId = r.id;
      } else {
        // crea/precarga la ruta del día para este vendedor y vuelve a buscar
        await conn.query(`CALL sp_preload_rutas(CURDATE(), ?)`, [vendedorId]);
        const [[r2]] = await conn.query(
          `SELECT id FROM rutas_diarias WHERE id_vendedor=? AND fecha=CURDATE() LIMIT 1`,
          [vendedorId]
        );
        rutaId = r2?.id || null;
      }
    }
    if (!rutaId) return res.status(404).json({ ok: false, msg: 'No existe ruta del día para este vendedor' });

    await conn.beginTransaction();

    // Asegurar la parada en la ruta
    const [[parada]] = await conn.query(
      `SELECT id, scaneado FROM rutas_clientes WHERE id_ruta=? AND id_cliente=? LIMIT 1`,
      [rutaId, clienteId]
    );

    if (!parada) {
      const [[ordenRow]] = await conn.query(
        `SELECT COALESCE(MAX(orden),0)+1 AS nextOrden FROM rutas_clientes WHERE id_ruta=?`,
        [rutaId]
      );
      const nextOrden = Number(ordenRow?.nextOrden || 1);

      await conn.query(
        `INSERT INTO rutas_clientes (id_ruta, id_cliente, orden, scaneado, fecha_scaneo)
         VALUES (?, ?, ?, 1, NOW())
         ON DUPLICATE KEY UPDATE scaneado=VALUES(scaneado), fecha_scaneo=VALUES(fecha_scaneo)`,
        [rutaId, clienteId, nextOrden]
      );
    } else if (!parada.scaneado) {
      await conn.query(
        `UPDATE rutas_clientes
            SET scaneado=1, fecha_scaneo=NOW()
          WHERE id=?`,
        [parada.id]
      );
    }

    // Registrar movimiento — columnas existentes en tu DDL
    await conn.query(
      `INSERT INTO movimientos_ruta (id_ruta, id_cliente, tipo_movimiento, escaneo_qr)
       VALUES (?, ?, 'visita_extra', 1)`,
      [rutaId, clienteId]
    );

    await conn.commit();
    return res.json({ ok: true, data: { rutaId, clienteId } });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    return res.status(500).json({ ok: false, msg: e?.message || 'Error marcando escaneo' });
  } finally {
    try { conn.release(); } catch {}
  }
}
