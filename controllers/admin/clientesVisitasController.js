// controllers/admin/clientesVisitasController.js
import db from '../../config/db.js';

const normDate = (s, end = '00:00:00') =>
  /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? `${s} ${end}` : s;

const normalizeEstado = (v) => {
  const s = String(v ?? '').toLowerCase();
  if (['cancel', 'cancelada'].some(k => s.includes(k))) return 'cancelada';
  if (['done','realizada','completada','complete','completed'].some(k => s.includes(k))) return 'completada';
  if (!s) return '';
  return 'pendiente';
};

export const getVisitasPorCliente = async (req, res) => {
  try {
    const clienteId = Number(req.params.id);
    if (!Number.isFinite(clienteId) || clienteId <= 0) {
      return res.status(400).json({ error: 'cliente_id inválido' });
    }

    const desde  = normDate(req.query.desde, '00:00:00');
    const hasta  = normDate(req.query.hasta, '23:59:59');
    const estado = normalizeEstado(req.query.estado);

    let sql = `
      SELECT
        rc.id                                               AS id,
        rc.id_cliente                                       AS cliente_id,
        cli.clave                                           AS cliente_clave,
        cli.nombre_empresa                                  AS cliente_nombre,
        rd.id_vendedor                                      AS vendedor_id,
        COALESCE(u.nombre, CONCAT('Vendedor #', rd.id_vendedor)) AS vendedor_nombre,
        CONCAT(rd.fecha, ' 12:00:00')                       AS fecha_programada,   -- DATETIME friendly
        CASE 
          WHEN rc.scaneado = 1 OR rc.fecha_scaneo IS NOT NULL THEN 'completada'
          ELSE 'pendiente'
        END                                                 AS estado,
        rc.fecha_scaneo                                     AS fecha_realizacion,
        NULL                                                AS notas,
        rd.estado                                           AS estado_ruta,
        rc.orden                                            AS orden_ruta
      FROM rutas_clientes rc
      JOIN rutas_diarias rd   ON rd.id = rc.id_ruta
      JOIN clientes cli       ON cli.id = rc.id_cliente
      LEFT JOIN vendedores v  ON v.id = rd.id_vendedor
      LEFT JOIN usuarios u    ON u.id = v.id_usuario
      WHERE rc.id_cliente = ?
    `;

    const params = [clienteId];

    if (desde) { sql += ` AND rd.fecha >= DATE(?)`; params.push(desde); }
    if (hasta) { sql += ` AND rd.fecha <= DATE(?)`; params.push(hasta); }

    if (estado === 'completada') {
      sql += ` AND (rc.scaneado = 1 OR rc.fecha_scaneo IS NOT NULL)`;
    } else if (estado === 'pendiente') {
      sql += ` AND (rc.scaneado = 0 AND rc.fecha_scaneo IS NULL)`;
    } else if (estado === 'cancelada') {
      sql += ` AND 1=0`; 
      sql += ` AND 1=0`;
    }

    sql += ` ORDER BY rd.fecha DESC, rc.orden ASC, rc.id DESC LIMIT 1000`;

    const [rows] = await db.query(sql, params);
    return res.json(rows); // arreglo plano para tu FE
  } catch (e) {
    console.error('getVisitasPorCliente: ', {
      code: e.code, errno: e.errno, sqlState: e.sqlState, sqlMessage: e.sqlMessage, message: e.message
    });
    return res.status(500).json({ error: 'Error consultando visitas', detail: e.sqlMessage || e.message });
  }
};
