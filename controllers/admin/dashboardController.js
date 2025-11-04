// controllers/admin/dashboardController.js
import db from '../../config/db.js';

// 1) Ventas del día (AGREGADAS POR VENDEDOR, incluyendo vendedores con 0 hoy)
// controllers/admin/dashboardController.js

export const obtenerVentasDelDia = async (_req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        ven.id                                  AS vendedor_id,
        u.usuario                               AS vendedor_usuario,

        /* ---- CLIENTES (NO público) desde ventas ---- */
        SUM(
          CASE
            WHEN v.id IS NOT NULL
             AND NOT (c.clave = 'PUBLICO' OR v.id_cliente IS NULL)
            THEN 1 ELSE 0
          END
        )                                        AS tickets_clientes,
        SUM(
          CASE
            WHEN v.id IS NOT NULL
             AND NOT (c.clave = 'PUBLICO' OR v.id_cliente IS NULL)
            THEN COALESCE(v.total,0) ELSE 0
          END
        )                                        AS total_clientes,

        /* ---- PÚBLICO desde ventas ---- */
        SUM(
          CASE
            WHEN v.id IS NOT NULL
             AND (c.clave = 'PUBLICO' OR v.id_cliente IS NULL)
            THEN 1 ELSE 0
          END
        )                                        AS tickets_publico_ventas,
        SUM(
          CASE
            WHEN v.id IS NOT NULL
             AND (c.clave = 'PUBLICO' OR v.id_cliente IS NULL)
            THEN COALESCE(v.total,0) ELSE 0
          END
        )                                        AS total_publico_ventas,

        /* ---- PÚBLICO desde ventas_publico ---- */
        COUNT(vp.id)                              AS tickets_publico_vp,
        COALESCE(SUM(vp.total), 0)                AS total_publico_vp

      FROM vendedores ven
      JOIN usuarios u
        ON u.id = ven.id_usuario

      /* ventas del día (LEFT para incluir vendedores sin ventas) */
      LEFT JOIN ventas v
        ON v.id_vendedor = ven.id
       AND DATE(v.fecha) = CURDATE()
      LEFT JOIN clientes c
        ON c.id = v.id_cliente

      /* ventas_publico del día */
      LEFT JOIN ventas_publico vp
        ON vp.id_vendedor = ven.id
       AND DATE(vp.fecha) = CURDATE()

      GROUP BY ven.id, u.usuario
    `);

    const out = rows.map(r => {
      const tickets_publico =
        Number(r.tickets_publico_ventas || 0) + Number(r.tickets_publico_vp || 0);
      const total_publico =
        Number(r.total_publico_ventas || 0) + Number(r.total_publico_vp || 0);
      const tickets_clientes = Number(r.tickets_clientes || 0);
      const total_clientes   = Number(r.total_clientes || 0);

      return {
        vendedor_id: r.vendedor_id,
        vendedor_usuario: r.vendedor_usuario,
        tickets_clientes,
        total_clientes,
        tickets_publico,
        total_publico,
        tickets_totales: tickets_clientes + tickets_publico,
        total_ventas: total_clientes + total_publico,
      };
    });

    out.sort((a, b) => {
      const dt = Number(b.total_ventas || 0) - Number(a.total_ventas || 0);
      if (dt !== 0) return dt;
      return String(a.vendedor_usuario || '').localeCompare(String(b.vendedor_usuario || ''));
    });

    return res.json(out);
  } catch (error) {
    console.error('Error al obtener ventas del día (agregado, separados):', error);
    return res.status(500).json({ message: 'Error al obtener ventas del día' });
  }
};


// 2) Alertas de mantenimiento
export const obtenerAlertasMantenimiento = async (_req, res) => {
  try {
    const PROXIMO_PCT = Number(process.env.MANT_PORC_PROXIMO || 80);

    const [rows] = await db.execute(`
      SELECT 
        c.id, c.placa, c.marca, c.modelo, c.color, 
        c.kilometraje_actual, c.mantenimiento_km, IFNULL(c.ultimo_mantenimiento_km, 0) AS ultimo_mantenimiento_km
      FROM camionetas c
      WHERE c.activo = TRUE AND c.eliminado = FALSE
    `);

    const data = rows.map(r => {
      const avance = Math.max(0, r.kilometraje_actual - r.ultimo_mantenimiento_km);
      const pct = r.mantenimiento_km > 0 ? (avance / r.mantenimiento_km) * 100 : 0;

      let estado = 'OK';
      if (pct >= 100) estado = 'VENCIDO';
      else if (pct > PROXIMO_PCT) estado = 'PROXIMO';

      return {
        ...r,
        km_desde_ultimo_mantenimiento: avance,
        km_restantes: r.mantenimiento_km - avance,
        estado_mantenimiento: estado
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error al obtener alertas de mantenimiento:', error);
    res.status(500).json({ success: false, message: 'Error al obtener alertas de mantenimiento' });
  }
};

// 3) Productos más vendidos (con categoría)
export const productosMasVendidos = async (_req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT 
        p.id,
        p.nombre,
        COALESCE(cat.nombre, 'Sin categoría') AS categoria,
        SUM(dv.cantidad) AS total_vendido,
        ROUND(
          SUM(dv.cantidad) / NULLIF((SELECT SUM(cantidad) FROM detalle_venta), 0) * 100,
          2
        ) AS porcentaje
      FROM detalle_venta dv
      JOIN productos p ON dv.id_producto = p.id
      LEFT JOIN categorias_productos cat ON p.categoria_id = cat.id
      GROUP BY p.id, p.nombre, cat.nombre
      ORDER BY total_vendido DESC
      LIMIT 10
    `);

    res.json(rows);
  } catch (error) {
    console.error('Error productos más vendidos:', error);
    res.status(500).json({ message: 'Error al obtener productos más vendidos' });
  }
};

// 4) Vendedores con más ventas (histórico/parametrizable)
export const vendedoresMasVentas = async (req, res) => {
  const { municipio_id } = req.query;
  try {
    let filtro = '';
    const params = [];
    if (municipio_id) {
      filtro = `AND ven.id_municipio = ?`;
      params.push(municipio_id);
    }

    const [rows] = await db.execute(
      `
      SELECT ven.id, u.usuario, COUNT(v.id) AS tickets, SUM(v.total) AS total_ventas
      FROM ventas v
      JOIN vendedores ven ON v.id_vendedor = ven.id
      JOIN usuarios u    ON ven.id_usuario = u.id
      WHERE 1=1 ${filtro}
      GROUP BY ven.id, u.usuario
      ORDER BY total_ventas DESC
      LIMIT 10
      `,
      params
    );

    res.json(rows);
  } catch (error) {
    console.error('Error vendedores más ventas:', error);
    res.status(500).json({ message: 'Error al obtener vendedores con más ventas' });
  }
};

// 5) Clientes destacados por municipio
export const clientesDestacadosPorMunicipio = async (_req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        m.id AS municipio_id,
        m.nombre AS municipio,
        c.id AS cliente_id,
        c.nombre_empresa,
        SUM(v.total) AS total_compras
      FROM clientes c
      JOIN municipios m ON c.id_municipio = m.id
      JOIN ventas v     ON v.id_cliente = c.id
      GROUP BY m.id, c.id
      ORDER BY m.id, total_compras DESC
    `);

    const destacados = [];
    let lastMunicipio = null;

    for (const fila of rows) {
      if (fila.municipio_id !== lastMunicipio) {
        destacados.push(fila);
        lastMunicipio = fila.municipio_id;
      }
    }

    res.json(destacados);
  } catch (error) {
    console.error('Error clientes destacados por municipio:', error);
    res.status(500).json({ message: 'Error al obtener clientes destacados' });
  }
};

// 6) Catálogo de municipios
export const obtenerMunicipios = async (_req, res) => {
  try {
    const [municipios] = await db.execute(`SELECT id, nombre FROM municipios ORDER BY nombre`);
    res.json(municipios);
  } catch (error) {
    console.error('Error obteniendo municipios:', error);
    res.status(500).json({ message: 'Error al obtener municipios' });
  }
};

// 7) Créditos por cobrar (igual que antes)
export const creditosResumen = async (req, res) => {
  const { municipio_id } = req.query;

  try {
    const params = [];
    let filtroMunicipio = '';
    if (municipio_id) {
      filtroMunicipio = 'AND c.id_municipio = ?';
      params.push(Number(municipio_id));
    }

    const [rows] = await db.execute(
      `
      WITH pagos AS (
        SELECT id_credito, SUM(monto) AS total_pagos
        FROM pagos_credito
        GROUP BY id_credito
      )
      SELECT
        c.id                         AS cliente_id,
        c.clave,
        c.nombre_empresa,
        c.telefono,
        m.id                         AS municipio_id,
        m.nombre                     AS municipio,
        TRIM(BOTH ', ' FROM COALESCE(
          GROUP_CONCAT(DISTINCT u.usuario SEPARATOR ', '),
          ''
        ))                          AS vendedor,
        SUM(v.total)                                   AS total_creditos,
        SUM(COALESCE(p.total_pagos, 0))                AS total_pagos,
        SUM(v.total) - SUM(COALESCE(p.total_pagos,0))  AS saldo_pendiente
      FROM ventas v
      JOIN creditos cr       ON cr.id_venta   = v.id
      LEFT JOIN pagos  p     ON p.id_credito  = cr.id
      JOIN clientes c        ON c.id          = v.id_cliente
      LEFT JOIN municipios m ON m.id          = c.id_municipio
      LEFT JOIN vendedores ven ON ven.id      = v.id_vendedor
      LEFT JOIN usuarios u     ON u.id        = ven.id_usuario
      WHERE v.tipo_pago = 'credito'
        ${filtroMunicipio}
      GROUP BY
        c.id, c.clave, c.nombre_empresa, c.telefono,
        m.id, m.nombre
      HAVING (SUM(v.total) - SUM(COALESCE(p.total_pagos,0))) > 0.009
      ORDER BY saldo_pendiente DESC, c.nombre_empresa ASC
      LIMIT 300
      `,
      params
    );

    const resp = rows.map(r => ({
      ...r,
      clave: r.clave ?? `CLI-${String(r.cliente_id).padStart(6, '0')}`,
    }));

    return res.json(resp);
  } catch (error) {
    console.error('creditosResumen SQL ERROR:', error.code, error.sqlMessage || error.message);
    return res.status(500).json({ message: 'Error al obtener créditos por cobrar' });
  }
};

// 8) Top clientes
export const clientesTopDestacados = async (_req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        c.id AS cliente_id,
        c.nombre_empresa,
        SUM(v.total)               AS total_compras,
        COUNT(*)                   AS tickets,
        SUM(CASE WHEN v.tipo_pago='credito' THEN v.total ELSE 0 END) AS total_credito
      FROM ventas v
      JOIN clientes c ON c.id = v.id_cliente
      WHERE v.total > 0
      GROUP BY c.id, c.nombre_empresa
      ORDER BY total_compras DESC
      LIMIT 10
    `);
    return res.json(rows);
  } catch (error) {
    console.error('clientesTopDestacados ERROR:', error.code, error.sqlMessage || error.message);
    return res.status(500).json({ message: 'Error al obtener top de clientes destacados' });
  }
};
