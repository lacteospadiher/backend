// controllers/vendedor/noVentaController.js
import db from '../../config/db.js';

async function getVendedorId(req, conn) {
  const directo =
    Number(
      req.user?.vendedorId ??
      req.user?.id_vendedor ??
      req.body?.idVendedor ??
      req.query?.idVendedor ??
      req.params?.vendedorId
    ) || null;
  if (directo) return directo;

  const userId = Number(req.user?.id || 0);
  if (!userId) return null;

  const [[row]] = await conn.query(
    'SELECT id FROM vendedores WHERE id_usuario=? LIMIT 1',
    [userId]
  );
  return row?.id || null;
}

const norm = (s) => (s == null ? '' : String(s).trim());

/** GET /api/vendedor/no-venta/motivos (opcional: para cargar catálogo en la app) */
export async function listarMotivos(req, res) {
  try {
    const [rows] = await db.query(
      `SELECT clave, descripcion FROM motivos_no_venta_catalogo WHERE activo=1 ORDER BY id`
    );
    return res.json({ ok: true, data: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, msg: e?.message || 'Error listando motivos' });
  }
}

/**
 * POST /api/vendedor/no-venta
 * body: {
 *   codigo?: string,        // QR/clave del cliente (alternativa a clienteId)
 *   clienteId?: number,
 *   motivos: string[],      // requerido (>=1) -> textos o claves
 *   latitud?: number,
 *   longitud?: number,
 *   observaciones?: string
 * }
 */
export async function registrarNoVenta(req, res) {
  const conn = await db.getConnection();
  try {
    const vendedorId = await getVendedorId(req, conn);
    if (!vendedorId) return res.status(400).json({ ok: false, msg: 'Falta vendedor (JWT o parámetro)' });

    // Resolver cliente
    let clienteId = Number(req.body?.clienteId || 0) || null;
    let codigo = norm(req.body?.codigo);
    if (!clienteId && !codigo) {
      return res.status(400).json({ ok: false, msg: 'Debes enviar clienteId o codigo' });
    }
    if (!clienteId) {
      const [[c]] = await conn.query(
        `SELECT id FROM clientes
          WHERE (codigo_qr=? OR clave=?)
            AND activo=1 AND eliminado=0
          LIMIT 1`,
        [codigo, codigo]
      );
      if (!c) return res.status(404).json({ ok: false, msg: 'Cliente no encontrado para el código' });
      clienteId = c.id;
    }

    // Validar motivos
    const motivos = Array.isArray(req.body?.motivos) ? req.body.motivos : [];
    if (!motivos.length) return res.status(400).json({ ok: false, msg: 'Debes enviar al menos un motivo' });

    const latitud  = req.body?.latitud  != null ? Number(req.body.latitud)  : null;
    const longitud = req.body?.longitud != null ? Number(req.body.longitud) : null;
    const observaciones = norm(req.body?.observaciones);

    // Ruta del día (si existe)
    const [[ruta]] = await conn.query(
      `SELECT id FROM rutas_diarias WHERE id_vendedor=? AND fecha=CURDATE() LIMIT 1`,
      [vendedorId]
    );
    const rutaId = ruta?.id || null;

    const [result] = await conn.query(
      `INSERT INTO visitas_no_venta
       (id_vendedor, id_cliente, ruta_id, latitud, longitud, motivos_json, observaciones)
       VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?)`,
      [
        vendedorId,
        clienteId,
        rutaId,
        latitud,
        longitud,
        JSON.stringify(motivos),
        observaciones || null
      ]
    );

    return res.json({
      ok: true,
      data: {
        id: result.insertId,
        vendedorId,
        clienteId,
        rutaId
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, msg: e?.message || 'Error registrando no venta' });
  } finally {
    try { conn.release(); } catch {}
  }
}
