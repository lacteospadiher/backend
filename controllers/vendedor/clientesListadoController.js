// controllers/vendedor/clientesListadoController.js
import db from '../../config/db.js';

const norm = (v) => (v ?? '').toString().trim();

/** 1..7 -> 'Lunes'..'Domingo' */
const DAY = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];

function mapDiasVisita(gc) {
  if (!gc) return [];
  // gc viene como "1,3,5" => ["Lunes","Miércoles","Viernes"]
  return [...new Set(gc.split(',').map(s => Number(s)).filter(n => n>=1 && n<=7).map(n => DAY[n-1]))];
}

/**
 * GET /api/vendedor/clientes/listado
 *
 * Filtros:
 *  - ?q=texto
 *  - ?vendedor=Nombre del vendedor (usuarios.nombre)
 *  - ?vendedor_id=ID del vendedor (vendedores.id)
 *  - ?mine=1  (solo clientes creados por req.user.id)
 *
 * Respuesta: { ok:true, data:[ ...ClienteUI ] }
 */
export async function listarClientesMovil(req, res) {
  try {
    // auth mínimo: si viene JWT, podrás usar ?mine=1
    const userId = Number(req.user?.id || 0) || null;

    const q = norm(req.query?.q);
    const vendedorName = norm(req.query?.vendedor);
    const vendedorId = Number(req.query?.vendedor_id || 0) || null;
    const mine = String(req.query?.mine || '') === '1';

    const params = [];
    // Subquery: vendedor actual por cliente (de plantillas activas)
    // y días de visita (group_concat de 1..7)
    const sql = `
      SELECT
        c.id,
        c.clave,
        c.nombre_empresa         AS nombre,
        c.telefono,
        c.correo,
        c.codigo_qr,
        DATE_FORMAT(c.fecha_registro, '%Y-%m-%d %H:%i:%s') AS fecha_registro,
        c.calle_numero,
        c.colonia,
        c.codigo_postal,
        c.latitud,
        c.longitud,
        e.nombre AS estado,
        m.nombre AS municipio,
        vend.nombre AS vendedor_nombre,
        dv.dias_gc
      FROM clientes c
      LEFT JOIN estados    e ON e.id = c.id_estado
      LEFT JOIN municipios m ON m.id = c.id_municipio
      /* vendedor dueño de la plantilla */
      LEFT JOIN (
        SELECT prc.id_cliente, MAX(pr.id_vendedor) AS vendedor_id
        FROM plantilla_ruta_clientes prc
        JOIN plantillas_ruta pr ON pr.id = prc.id_plantilla AND pr.activo=1
        GROUP BY prc.id_cliente
      ) AS own ON own.id_cliente = c.id
      LEFT JOIN vendedores v ON v.id = own.vendedor_id
      LEFT JOIN usuarios vend ON vend.id = v.id_usuario
      /* días de visita */
      LEFT JOIN (
        SELECT prc.id_cliente, GROUP_CONCAT(DISTINCT prc.dia_semana ORDER BY prc.dia_semana) AS dias_gc
        FROM plantilla_ruta_clientes prc
        JOIN plantillas_ruta pr ON pr.id = prc.id_plantilla AND pr.activo=1
        GROUP BY prc.id_cliente
      ) AS dv ON dv.id_cliente = c.id
      WHERE c.activo=1 AND c.eliminado=0
      ${mine && userId ? 'AND c.id_usuario_creador = ?' : ''}
      ${q ? `AND (c.nombre_empresa LIKE ? OR c.telefono LIKE ? OR c.clave LIKE ? OR c.codigo_qr LIKE ?)` : ''}
      ${vendedorId ? `AND own.vendedor_id = ?` : ''}
      ${!vendedorId && vendedorName ? `AND vend.nombre = ?` : ''}
      ORDER BY c.id ASC
      LIMIT 500
    `;

    if (mine && userId) params.push(userId);
    if (q) {
      const qq = `%${q}%`;
      params.push(qq, qq, qq, qq);
    }
    if (vendedorId) params.push(vendedorId);
    if (!vendedorId && vendedorName) params.push(vendedorName);

    const [rows] = await db.query(sql, params);

    const data = rows.map(r => ({
      docId: String(r.id),
      clienteId: r.clave || null,
      clienteNumero: Number(r.id),
      codigoQR: r.codigo_qr || null,
      diasVisita: mapDiasVisita(r.dias_gc),
      direccion: {
        calle: r.calle_numero || null,
        codigoPostal: r.codigo_postal || null,
        colonia: r.colonia || null,
        estado: r.estado || null,
        municipio: r.municipio || null,
        nombre: null,
        numero: null
      },
      fechaRegistro: r.fecha_registro || null,
      nombre: r.nombre || null,
      telefono: r.telefono || null,
      ubicacion: {
        lat: r.latitud != null ? Number(r.latitud) : null,
        lng: r.longitud != null ? Number(r.longitud) : null,
      },
      vendedor: r.vendedor_nombre || null
    }));

    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ ok: false, msg: e?.message || 'Error listando clientes' });
  }
}
