  // controllers/admin/rutasController.js
  import db from '../../config/db.js';

  /* ===========================
    Helpers internos del módulo
    =========================== */

  // YYYY-MM-DD en horario LOCAL (no UTC)
  const ymdLocal = (d) => {
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) throw new Error(`Fecha inválida: ${d}`);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const todayStr = () => ymdLocal(new Date());

  /** Normaliza a 'YYYY-MM-DD' en horario LOCAL */
  const toYMD = (fecha) => {
    if (fecha instanceof Date) return ymdLocal(fecha);
    if (typeof fecha === 'string') return fecha.slice(0, 10);
    return ymdLocal(new Date(fecha));
  };

  /** 1..7 (Lunes..Domingo) */
  const dow1_7 = (fecha) => {
    let d;
    if (fecha instanceof Date) {
      d = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate(), 0, 0, 0, 0);
    } else if (typeof fecha === 'string') {
      const s = fecha.slice(0, 10);
      const [y, m, day] = s.split('-').map(Number);
      d = new Date(y, (m || 1) - 1, day || 1, 0, 0, 0, 0); // local midnight
    } else {
      d = new Date(fecha);
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    }
    if (Number.isNaN(d.getTime())) throw new Error(`Fecha inválida para dow1_7: ${fecha}`);
    const js = d.getDay(); // 0..6 (Dom..Sáb)
    return js === 0 ? 7 : js;
  };

  const dayName = (d) => ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'][d-1];

  /** Garantiza una plantilla activa para el vendedor y devuelve su id */
  const ensurePlantillaActiva = async (conn, id_vendedor) => {
    const [[p]] = await conn.query(
      `SELECT id FROM plantillas_ruta WHERE id_vendedor=? AND activo=1 LIMIT 1`,
      [id_vendedor]
    );
    if (p) return p.id;
    const [ins] = await conn.query(
      `INSERT INTO plantillas_ruta (id_vendedor, nombre, activo) VALUES (?,?,1)`,
      [id_vendedor, 'Default']
    );
    return ins.insertId;
  };

  /** Verifica exclusividad de cliente por día (entre vendedores) */
  const clienteDisponibleParaDia = async (conn, id_cliente, dia_semana, vendedor_actual_id = null) => {
    const [rows] = await conn.query(
      `SELECT pr.id AS plantilla_id, v.id AS vendedor_id, u.nombre AS vendedor_nombre
        FROM plantilla_ruta_clientes prc
        JOIN plantillas_ruta pr ON pr.id = prc.id_plantilla AND pr.activo=1
        JOIN vendedores v  ON v.id = pr.id_vendedor
        JOIN usuarios  u  ON u.id = v.id_usuario
        WHERE prc.id_cliente=? AND prc.dia_semana=?`,
      [id_cliente, dia_semana]
    );
    if (!rows.length) return { ok: true };
    const conflict = rows.find(r => vendedor_actual_id ? r.vendedor_id !== Number(vendedor_actual_id) : true);
    if (conflict) {
      return {
        ok: false,
        conflicto: { vendedor_otro: conflict.vendedor_nombre, plantilla_id: conflict.plantilla_id }
      };
    }
    return { ok: true };
  };

  /** Crea ruta del día desde plantilla si no existe. Devuelve id_ruta */
  const ensureRutaDiaria = async (id_vendedor, fecha, externalConn = null) => {
    const conn = externalConn || await db.getConnection();
    const localTx = !externalConn;
    try {
      if (localTx) await conn.beginTransaction();

      const fechaStr = toYMD(fecha); // LOCAL
      const [[r0]] = await conn.query(
        `SELECT id FROM rutas_diarias WHERE id_vendedor=? AND fecha=? LIMIT 1`,
        [id_vendedor, fechaStr]
      );
      if (r0) {
        if (localTx) await conn.commit();
        return r0.id;
      }

      const plantillaId = await ensurePlantillaActiva(conn, id_vendedor);
      const dia = dow1_7(fechaStr);

      const [insRuta] = await conn.query(
        `INSERT INTO rutas_diarias (id_vendedor, fecha, estado, regreso_confirmado)
        VALUES (?,?, 'programada', 0)`,
        [id_vendedor, fechaStr]
      );
      const rutaId = insRuta.insertId;

      // No insertar clientes ya asignados en otra ruta del mismo día
      const [stops] = await conn.query(
        `SELECT prc.id_cliente, prc.orden
          FROM plantilla_ruta_clientes prc
          WHERE prc.id_plantilla=? AND prc.dia_semana=?
            AND NOT EXISTS (
              SELECT 1
                FROM rutas_clientes rc
                JOIN rutas_diarias rd ON rd.id = rc.id_ruta
              WHERE rc.id_cliente = prc.id_cliente
                AND rd.fecha = ?
            )
          ORDER BY prc.orden`,
        [plantillaId, dia, fechaStr]
      );

      if (stops.length) {
        const values = stops.map((s) => [rutaId, s.id_cliente, s.orden]);
        await conn.query(
          `INSERT INTO rutas_clientes (id_ruta, id_cliente, orden) VALUES ?`,
          [values]
        );
      }

      if (localTx) await conn.commit();
      return rutaId;
    } catch (e) {
      if (localTx) await conn.rollback();
      throw e;
    } finally {
      if (!externalConn) conn.release();
    }
  };

  // ===========================
  // Helper: KPIs de ventas tolerante al esquema
  // ===========================
  async function kpiVentasPorRuta({ rutaId, fecha, vendedorId }) {
    const [cols] = await db.query(
      `SELECT COLUMN_NAME AS c
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ventas'`
    );
    const has = (name) => cols.some(r => r.c === name);

    const hasRutaId   = has('ruta_id');
    const hasIdRuta   = has('id_ruta');
    const hasTotal    = has('total');
    const hasTotalNet = has('total_neto');

    const totalExpr = hasTotal ? 'IFNULL(SUM(total),0)'
                    : hasTotalNet ? 'IFNULL(SUM(total_neto),0)'
                    : '0';

    if (hasRutaId) {
      const [[row]] = await db.query(
        `SELECT COUNT(*) AS n, ${totalExpr} AS total
          FROM ventas
          WHERE ruta_id=?`,
        [rutaId]
      );
      return row || { n: 0, total: 0 };
    }
    if (hasIdRuta) {
      const [[row]] = await db.query(
        `SELECT COUNT(*) AS n, ${totalExpr} AS total
          FROM ventas
          WHERE id_ruta=?`,
        [rutaId]
      );
      return row || { n: 0, total: 0 };
    }

    const hasFechaVenta = has('fecha_venta');
    const hasFecha      = has('fecha');
    const fechaCol = hasFechaVenta ? 'fecha_venta'
                  : hasFecha      ? 'fecha'
                  : null;

    const fechaStr = toYMD(fecha); // LOCAL

    if (!fechaCol) {
      const [[row]] = await db.query(
        `SELECT COUNT(*) AS n, ${totalExpr} AS total
          FROM ventas
          WHERE id_vendedor=?`,
        [vendedorId]
      );
      return row || { n: 0, total: 0 };
    }

    const [[row]] = await db.query(
      `SELECT COUNT(*) AS n, ${totalExpr} AS total
        FROM ventas
        WHERE id_vendedor=? AND DATE(${fechaCol}) = ?`,
      [vendedorId, fechaStr]
    );
    return row || { n: 0, total: 0 };
  }

  /** Sincroniza una ruta con su plantilla del día (agrega faltantes si no chocan con otras rutas) */
  const syncRutaConPlantilla = async ({ rutaId, vendedorId, fechaStr }) => {
    const dia = dow1_7(fechaStr);

    const [[pl]] = await db.query(
      `SELECT id FROM plantillas_ruta WHERE id_vendedor=? AND activo=1 LIMIT 1`,
      [vendedorId]
    );
    if (!pl) return { inserted: 0, conflicts: [] };

    const [ins] = await db.query(
      `
      INSERT INTO rutas_clientes (id_ruta, id_cliente, orden)
      SELECT ?, prc.id_cliente, prc.orden
        FROM plantilla_ruta_clientes prc
      WHERE prc.id_plantilla = ?
        AND prc.dia_semana   = ?
        AND NOT EXISTS (
              SELECT 1
                FROM rutas_clientes rc
                JOIN rutas_diarias rd ON rd.id = rc.id_ruta
              WHERE rc.id_cliente = prc.id_cliente
                AND rd.fecha = ?
        )
        AND NOT EXISTS (
              SELECT 1 FROM rutas_clientes rc
              WHERE rc.id_ruta=? AND rc.id_cliente=prc.id_cliente
        )
      `,
      [rutaId, pl.id, dia, fechaStr, rutaId]
    );

    const [conflicts] = await db.query(
      `
      SELECT c.id, c.clave, c.nombre_empresa, rd.id AS ruta_otro_id, u.nombre AS vendedor_otro
        FROM plantilla_ruta_clientes prc
        JOIN clientes c          ON c.id  = prc.id_cliente
        JOIN plantillas_ruta pr  ON pr.id = prc.id_plantilla
        JOIN rutas_clientes rc   ON rc.id_cliente = c.id
        JOIN rutas_diarias rd    ON rd.id = rc.id_ruta AND rd.fecha = ?
        JOIN vendedores v        ON v.id  = rd.id_vendedor
        JOIN usuarios  u         ON u.id  = v.id_usuario
      WHERE pr.id = ?
        AND prc.dia_semana = ?
        AND rd.id <> ?
      `,
      [fechaStr, pl.id, dia, rutaId]
    );

    return { inserted: ins.affectedRows || 0, conflicts };
  };

  /** Agrega cliente a RUTA (fecha) y a PLANTILLA (día semana) con validación cross-vendedor */
  const addClienteAHoyYPlantilla = async (
    id_vendedor,
    id_cliente,
    fecha = todayStr(),
    externalConn = null
  ) => {
    const conn = externalConn || await db.getConnection();
    const localTx = !externalConn;
    try {
      if (localTx) await conn.beginTransaction();

      const fechaStr = toYMD(fecha); // LOCAL
      const rutaId = await ensureRutaDiaria(id_vendedor, fechaStr, conn);
      const dia = dow1_7(fechaStr);

      const disp = await clienteDisponibleParaDia(conn, id_cliente, dia, id_vendedor);
      if (!disp.ok) {
        const err = new Error(`El cliente ya está asignado los ${dayName(dia)} con ${disp.conflicto.vendedor_otro}`);
        err.statusCode = 409; // CONFLICT
        err.sqlState = '45001';
        throw err;
      }

      const [[exist]] = await conn.query(
        `SELECT id FROM rutas_clientes WHERE id_ruta=? AND id_cliente=?`,
        [rutaId, id_cliente]
      );
      if (!exist) {
        const [[mx]] = await conn.query(
          `SELECT IFNULL(MAX(orden),0) AS m FROM rutas_clientes WHERE id_ruta=?`,
          [rutaId]
        );
        const ord = Number(mx?.m || 0) + 1;
        await conn.query(
          `INSERT INTO rutas_clientes (id_ruta, id_cliente, orden) VALUES (?,?,?)`,
          [rutaId, id_cliente, ord]
        );
        await conn.query(
          `INSERT INTO movimientos_ruta (id_ruta, id_cliente, tipo_movimiento, fecha)
          VALUES (?, ?, 'cliente_agregado', NOW())`,
          [rutaId, id_cliente]
        );
      }

      const plantillaId = await ensurePlantillaActiva(conn, id_vendedor);
      const [[existP]] = await conn.query(
        `SELECT id FROM plantilla_ruta_clientes
        WHERE id_plantilla=? AND dia_semana=? AND id_cliente=? LIMIT 1`,
        [plantillaId, dia, id_cliente]
      );
      if (!existP) {
        const [[mxp]] = await conn.query(
          `SELECT IFNULL(MAX(orden),0) AS m
            FROM plantilla_ruta_clientes
            WHERE id_plantilla=? AND dia_semana=?`,
          [plantillaId, dia]
        );
        const ordP = Number(mxp?.m || 0) + 1;
        await conn.query(
          `INSERT INTO plantilla_ruta_clientes (id_plantilla, dia_semana, id_cliente, orden)
          VALUES (?,?,?,?)`,
          [plantillaId, dia, id_cliente, ordP]
        );
      }

      if (localTx) await conn.commit();
      return { ok: true, ruta_id: rutaId };
    } catch (e) {
      if (localTx) await conn.rollback();
      throw e;
    } finally {
      if (!externalConn) conn.release();
    }
  };

  /** Precargar semana L..S para uno o todos los vendedores con plantilla activa */
  const preloadSemanaSvc = async ({ fecha_lunes, vendedor_id = null }) => {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      let vendedores = [];
      if (vendedor_id) {
        vendedores = [{ id: Number(vendedor_id) }];
      } else {
        const [rows] = await conn.query(
          `SELECT DISTINCT id_vendedor AS id FROM plantillas_ruta WHERE activo=1`
        );
        vendedores = rows;
      }

      const lunesStr = toYMD(fecha_lunes); // LOCAL
      const base = new Date(lunesStr + 'T00:00:00');
      const dias = [0, 1, 2, 3, 4, 5].map((d) => {
        const dte = new Date(base.getFullYear(), base.getMonth(), base.getDate() + d, 0, 0, 0, 0);
        return ymdLocal(dte);
      });

      const creadas = [];
      for (const v of vendedores) {
        for (const f of dias) {
          const rutaId = await ensureRutaDiaria(v.id, f, conn);
          creadas.push({ vendedor_id: v.id, fecha: f, ruta_id: rutaId });
        }
      }

      await conn.commit();
      return { ok: true, creadas };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  };

  /* ===========================
    Endpoints
    =========================== */

  // GET /api/rutas/plantilla/disponibles?dia_semana=1..7&vendedor_id=?&q=&limit=
  export const clientesDisponiblesPlantilla = async (req, res) => {
    try {
      const dia_semana = Number(req.query.dia_semana);
      const q = (req.query.q || '').trim();
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));

      if (!dia_semana || dia_semana < 1 || dia_semana > 7) {
        return res.status(400).json({ error: 'dia_semana (1..7) es obligatorio' });
      }

      const params = [dia_semana];
      let where = `c.activo=1 AND c.eliminado=0`;

      if (q) {
        const like = `%${q}%`;
        where += ` AND (c.clave LIKE ? OR c.nombre_empresa LIKE ? OR c.telefono LIKE ?)`;
        params.push(like, like, like);
      }

      const sql = `
        SELECT c.id, c.clave, c.nombre_empresa, c.telefono
          FROM clientes c
        WHERE ${where}
          AND NOT EXISTS (
                SELECT 1
                  FROM plantilla_ruta_clientes prc
                  JOIN plantillas_ruta pr ON pr.id = prc.id_plantilla
                WHERE pr.activo=1
                  AND prc.dia_semana = ?
                  AND prc.id_cliente = c.id
          )
        ORDER BY c.nombre_empresa IS NULL, c.nombre_empresa, c.id
        LIMIT ${limit}
      `;

      const [rows] = await db.query(sql, q ? [ ...params.slice(0, -1), params.at(-1), dia_semana ] : [ ...params, dia_semana ]);
      res.json(rows);
    } catch (e) {
      console.error('clientesDisponiblesPlantilla', e);
      res.status(500).json({ error: 'Error al listar clientes disponibles' });
    }
  };

  // GET /api/rutas?fecha=YYYY-MM-DD&vendedor_id=#
  export const obtenerRutaDelDia = async (req, res) => {
    try {
      const { fecha, vendedor_id } = req.query;
      if (!fecha || !vendedor_id) {
        return res
          .status(400)
          .json({ error: 'fecha y vendedor_id son obligatorios' });
      }

      const fechaStr = toYMD(fecha); // LOCAL
      const vendId = Number(vendedor_id);

      const rutaId = await ensureRutaDiaria(vendId, fechaStr);

      const { inserted, conflicts } = await syncRutaConPlantilla({
        rutaId,
        vendedorId: vendId,
        fechaStr,
      });

      const [[ruta]] = await db.query(
        `SELECT r.*, u.nombre AS vendedor
          FROM rutas_diarias r
          JOIN vendedores v ON v.id = r.id_vendedor
          JOIN usuarios  u ON u.id = v.id_usuario
          WHERE r.id = ?`,
        [rutaId]
      );

      const [paradas] = await db.query(
        `SELECT rc.id, rc.id_cliente, c.clave, c.nombre_empresa, rc.orden, rc.scaneado, rc.fecha_scaneo
          FROM rutas_clientes rc
          JOIN clientes c ON c.id = rc.id_cliente
          WHERE rc.id_ruta=?
          ORDER BY rc.orden, rc.id`,
        [rutaId]
      );

      res.json({ ruta, paradas, meta: { synced_inserted: inserted, conflictos: conflicts } });
    } catch (e) {
      console.error('obtenerRutaDelDia', e);
      res.status(500).json({ error: 'Error al obtener ruta' });
    }
  };

  // POST /api/rutas/preload-dia { fecha, vendedor_id? }
  export const preloadDia = async (req, res) => {
    const conn = await db.getConnection();
    try {
      const { fecha, vendedor_id } = req.body;
      if (!fecha) return res.status(400).json({ error: 'fecha es obligatoria' });

      await conn.beginTransaction();

      let vendedores = [];
      if (vendedor_id) {
        vendedores = [{ id: Number(vendedor_id) }];
      } else {
        const [rows] = await conn.query(
          `SELECT DISTINCT id_vendedor AS id FROM plantillas_ruta WHERE activo=1`
        );
        vendedores = rows;
      }

      const fechaStr = toYMD(fecha); // LOCAL
      const creadas = [];
      for (const v of vendedores) {
        const id = await ensureRutaDiaria(v.id, fechaStr, conn);
        creadas.push({ vendedor_id: v.id, ruta_id: id, fecha: fechaStr });
      }

      await conn.commit();
      res.json({ ok: true, creadas });
    } catch (e) {
      await conn.rollback();
      console.error('preloadDia', e);
      res.status(500).json({ error: 'Error al precargar rutas del día' });
    } finally {
      conn.release();
    }
  };

  // POST /api/rutas/preload-semana { fecha_lunes, vendedor_id? }
  export const preloadSemana = async (req, res) => {
    try {
      const { fecha_lunes, vendedor_id } = req.body;
      if (!fecha_lunes)
        return res
          .status(400)
          .json({ error: 'fecha_lunes es obligatoria (lunes de la semana)' });
      const r = await preloadSemanaSvc({
        fecha_lunes: toYMD(fecha_lunes), // LOCAL
        vendedor_id: vendedor_id ? Number(vendedor_id) : null,
      });
      res.json(r);
    } catch (e) {
      console.error('preloadSemana', e);
      res.status(500).json({ error: 'Error al precargar semana' });
    }
  };

  // PATCH /api/rutas/:id/iniciar
  export const iniciarRuta = async (req, res) => {
    try {
      const { id } = req.params;
      const [r] = await db.query(
        `UPDATE rutas_diarias
            SET estado='en_curso', inicio_en=NOW(), regreso_confirmado=0
          WHERE id=? AND estado IN ('programada','en_curso')`,
        [id]
      );
      if (!r.affectedRows)
        return res
          .status(404)
          .json({ error: 'Ruta no encontrada o ya finalizada' });
      res.json({ ok: true });
    } catch (e) {
      console.error('iniciarRuta', e);
      res.status(500).json({ error: 'Error al iniciar ruta' });
    }
  };

  // PATCH /api/rutas/:id/finalizar { observaciones? }
  export const finalizarRuta = async (req, res) => {
    try {
      const { id } = req.params;
      const { observaciones = null } = req.body;
      const [r] = await db.query(
        `UPDATE rutas_diarias
            SET estado='finalizada',
                termino_en=NOW(),
                regreso_confirmado=1,
                fecha_regreso=NOW(),
                observaciones = COALESCE(?, observaciones)
          WHERE id=? AND estado IN ('programada','en_curso')`,
        [observaciones, id]
      );
      if (!r.affectedRows)
        return res.status(404).json({ error: 'Ruta no encontrada' });
      res.json({ ok: true });
    } catch (e) {
      console.error('finalizarRuta', e);
      res.status(500).json({ error: 'Error al finalizar ruta' });
    }
  };

  // PATCH /api/rutas/:id/reiniciar
  export const reiniciarRuta = async (req, res) => {
    const conn = await db.getConnection();
    try {
      const { id } = req.params;
      await conn.beginTransaction();

      await conn.query(
        `UPDATE rutas_clientes SET scaneado=0, fecha_scaneo=NULL WHERE id_ruta=?`,
        [id]
      );
      await conn.query(
        `UPDATE rutas_diarias
            SET estado='programada', inicio_en=NULL, termino_en=NULL,
                regreso_confirmado=0, fecha_regreso=NULL, observaciones=NULL
          WHERE id=? AND estado <> 'finalizada'`,
        [id]
      );

      await conn.commit();
      res.json({ ok: true });
    } catch (e) {
      await conn.rollback();
      console.error('reiniciarRuta', e);
      res.status(500).json({ error: 'Error al reiniciar ruta' });
    } finally {
      conn.release();
    }
  };

  // POST /api/rutas/:id/clientes { id_cliente, orden? }
  export const agregarClienteRuta = async (req, res) => {
    const conn = await db.getConnection();
    try {
      const { id } = req.params;
      const { id_cliente, orden } = req.body;
      if (!id_cliente)
        return res.status(400).json({ error: 'id_cliente es obligatorio' });

      await conn.beginTransaction();

      const [[ruta]] = await conn.query(
        `SELECT id, id_vendedor, fecha FROM rutas_diarias WHERE id=?`,
        [id]
      );
      if (!ruta) {
        await conn.rollback();
        return res.status(404).json({ error: 'Ruta no encontrada' });
      }

      const dia = dow1_7(ruta.fecha);
      const disp = await clienteDisponibleParaDia(conn, id_cliente, dia, ruta.id_vendedor);
      if (!disp.ok) {
        await conn.rollback();
        return res.status(409).json({
          error: `El cliente ya está asignado los ${dayName(dia)} con ${disp.conflicto.vendedor_otro}`
        });
      }

      const [[exist]] = await conn.query(
        `SELECT id FROM rutas_clientes WHERE id_ruta=? AND id_cliente=?`,
        [id, id_cliente]
      );
      if (!exist) {
        let ord = orden;
        if (!ord) {
          const [[mx]] = await conn.query(
            `SELECT IFNULL(MAX(orden),0) AS m FROM rutas_clientes WHERE id_ruta=?`,
            [id]
          );
          ord = Number(mx?.m || 0) + 1;
        }
        await conn.query(
          `INSERT INTO rutas_clientes (id_ruta, id_cliente, orden) VALUES (?,?,?)`,
          [id, id_cliente, ord]
        );
        await conn.query(
          `INSERT INTO movimientos_ruta (id_ruta, id_cliente, tipo_movimiento, fecha)
          VALUES (?, ?, 'cliente_agregado', NOW())`,
          [id, id_cliente]
        );
      }

      const plantillaId = await ensurePlantillaActiva(conn, ruta.id_vendedor);
      const [[existP]] = await conn.query(
        `SELECT id FROM plantilla_ruta_clientes
        WHERE id_plantilla=? AND dia_semana=? AND id_cliente=? LIMIT 1`,
        [plantillaId, dia, id_cliente]
      );
      if (!existP) {
        const [[mxp]] = await conn.query(
          `SELECT IFNULL(MAX(orden),0) AS m
            FROM plantilla_ruta_clientes
            WHERE id_plantilla=? AND dia_semana=?`,
          [plantillaId, dia]
        );
        const ordP = Number(mxp?.m || 0) + 1;
        await conn.query(
          `INSERT INTO plantilla_ruta_clientes (id_plantilla, dia_semana, id_cliente, orden)
          VALUES (?,?,?,?)`,
          [plantillaId, dia, id_cliente, ordP]
        );
      }

      await conn.commit();
      res.json({ ok: true });
    } catch (e) {
      await conn.rollback();
      if (e?.statusCode === 409 || e?.sqlState === '45001') {
        return res.status(409).json({ error: e.message });
      }
      if (e?.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'El cliente ya está en la ruta de hoy' });
      }
      console.error('agregarClienteRuta', e);
      res.status(500).json({ error: 'Error al agregar cliente' });
    } finally {
      conn.release();
    }
  };

  // POST /api/rutas/:id/scan { payload?:string, cliente_id?:number }
  export const scanClienteRuta = async (req, res) => {
    const conn = await db.getConnection();
    try {
      const { id } = req.params;
      const { payload, cliente_id } = req.body;

      let cid = cliente_id;
      if (!cid && payload) {
        try {
          const p = JSON.parse(payload);
          if (p?.t === 'cliente' && Number(p?.id)) cid = Number(p.id);
        } catch { /* payload inválido */ }
      }
      if (!cid)
        return res
          .status(400)
          .json({ error: 'cliente_id o payload (QR) requerido' });

      await conn.beginTransaction();

      const [[ruta]] = await conn.query(
        `SELECT id, id_vendedor, fecha FROM rutas_diarias WHERE id=?`,
        [id]
      );
      if (!ruta) {
        await conn.rollback();
        return res.status(404).json({ error: 'Ruta no encontrada' });
      }

      const dia = dow1_7(ruta.fecha);
      const disp = await clienteDisponibleParaDia(conn, cid, dia, ruta.id_vendedor);
      if (!disp.ok) {
        await conn.rollback();
        return res.status(409).json({
          error: `El cliente ya está asignado los ${dayName(dia)} con ${disp.conflicto.vendedor_otro}`
        });
      }

      await addClienteAHoyYPlantilla(ruta.id_vendedor, cid, ruta.fecha, conn);

      await conn.query(
        `UPDATE rutas_clientes SET scaneado=1, fecha_scaneo=NOW() WHERE id_ruta=? AND id_cliente=?`,
        [id, cid]
      );

      await conn.query(
        `INSERT INTO movimientos_ruta (id_ruta, id_cliente, tipo_movimiento, escaneo_qr, fecha)
        VALUES (?, ?, 'visita_extra', 1, NOW())`,
        [id, cid]
      );

      await conn.commit();
      res.json({ ok: true });
    } catch (e) {
      await conn.rollback();
      if (e?.statusCode === 409 || e?.sqlState === '45001') {
        return res.status(409).json({ error: e.message });
      }
      if (e?.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'El cliente ya está en esta ruta' });
      }
      console.error('scanClienteRuta', e);
      res.status(500).json({ error: 'Error al registrar escaneo' });
    } finally {
      conn.release();
    }
  };

  // GET /api/rutas/:id/resumen
  export const resumenRuta = async (req, res) => {
    try {
      const { id } = req.params;

      const [[ruta]] = await db.query(
        `SELECT r.*, u.nombre AS vendedor
          FROM rutas_diarias r
          JOIN vendedores v ON v.id = r.id_vendedor
          JOIN usuarios  u ON u.id = v.id_usuario
          WHERE r.id=?`,
        [id]
      );
      if (!ruta) {
        return res.status(404).json({ error: 'Ruta no encontrada' });
      }

      const kv = await kpiVentasPorRuta({
        rutaId: id,
        fecha: ruta.fecha,
        vendedorId: ruta.id_vendedor,
      });

      const [[vis]] = await db.query(
        `SELECT
            SUM(CASE WHEN scaneado=1 THEN 1 ELSE 0 END) AS visitados,
            SUM(CASE WHEN scaneado=0 THEN 1 ELSE 0 END) AS pendientes
          FROM rutas_clientes
          WHERE id_ruta=?`,
        [id]
      );

      res.json({
        ruta,
        kpis: {
          ventas_count: Number(kv?.n || 0),
          ventas_total: Number(kv?.total || 0),
          visitados: Number(vis?.visitados || 0),
          pendientes: Number(vis?.pendientes || 0),
        },
      });
    } catch (e) {
      console.error('resumenRuta Error:', e);
      res.status(500).json({ error: 'Error al obtener resumen' });
    }
  };
