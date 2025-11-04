// controllers/admin/plantillasRutaController.js
import db from '../../config/db.js';

/* =========================
   Helpers (LOCAL TIME)
   ========================= */

const pad2 = (n) => String(n).padStart(2,'0');
const formatLocalYMD = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const parseYMD = (s) => {
  if (!s) return null;
  const [y,m,d] = s.slice(0,10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m-1, d, 0,0,0,0); // LOCAL
};
const toYMD = (fecha) => {
  if (!fecha) throw new Error(`Fecha inválida: ${fecha}`);
  if (fecha instanceof Date) return formatLocalYMD(fecha);
  if (typeof fecha === 'string') {
    const p = parseYMD(fecha);
    if (p) return formatLocalYMD(p);
    const d = new Date(fecha);
    if (Number.isNaN(d.getTime())) throw new Error(`Fecha inválida: ${fecha}`);
    return formatLocalYMD(d);
  }
  const d = new Date(fecha);
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha inválida: ${fecha}`);
  return formatLocalYMD(d);
};

/** Garantiza una plantilla activa y retorna su id */
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

const inRangeDia = (n) => Number.isInteger(n) && n >= 1 && n <= 7;
const num = (v) => Number(v);

/** Convierte 1..7 (L..D) -> getDay() JS (0..6, 0=Dom) */
const dowToJs = (dia_semana) => ({1:1,2:2,3:3,4:4,5:5,6:6,7:0}[Number(dia_semana)]);
/** YYYY-MM-DD de Date LOCAL */
const dateOnly = (d) => formatLocalYMD(d);
/** 1..7 -> nombre */
const dayName = (d) => ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'][d-1];

/** Próxima fecha (>= hoy) que cae en dia_semana (1..7) en LOCAL TIME */
const nextDateForDow = (dia_semana, refDate = new Date()) => {
  const want = dowToJs(dia_semana);
  // NORMALIZA refDate a la medianoche LOCAL
  const base = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate());
  let add = want - base.getDay(); // 0..6
  if (add < 0) add += 7;          // trae hoy si coincide
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + add);
  return dateOnly(d);
};

/** Exclusividad: cliente NO debe estar en otra plantilla ACTIVA el mismo día */
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

/**
 * Si ya existe la PRÓXIMA ruta programada (mismo vendedor + próxima fecha que caiga en dia_semana),
 * ejecuta la función "apply(rutaId, fechaObjetivo)" para sincronizar (agregar/quitar/reordenar).
 * No toca rutas en_curso/finalizada.
 */
const syncNextProgramadaIfExists = async (conn, { vendedor_id, dia_semana, apply }) => {
  const fechaObjetivo = nextDateForDow(dia_semana, new Date()); // LOCAL
  const [[ruta]] = await conn.query(
    `SELECT id, estado FROM rutas_diarias WHERE id_vendedor=? AND fecha=? LIMIT 1`,
    [vendedor_id, fechaObjetivo]
  );
  if (!ruta || ruta.estado !== 'programada') {
    return { synced: false };
  }
  await apply(ruta.id, fechaObjetivo);
  return { synced: true, ruta_id: ruta.id, fecha: fechaObjetivo };
};

/* =========================================================
   GET /api/rutas/plantilla?vendedor_id=#
   -> Semana completa
   Respuesta: { id_plantilla, dias: {1:[],..,7:[]} }
   ========================================================= */
export const getPlantillaSemana = async (req, res) => {
  try {
    const vendedor_id = num(req.query.vendedor_id);
    if (!vendedor_id) return res.status(400).json({ error: 'vendedor_id es obligatorio' });

    const conn = await db.getConnection();
    try {
      const plantillaId = await ensurePlantillaActiva(conn, vendedor_id);

      const [rows] = await conn.query(
        `SELECT prc.dia_semana, prc.id_cliente, prc.orden, c.clave, c.nombre_empresa
           FROM plantilla_ruta_clientes prc
           JOIN clientes c ON c.id = prc.id_cliente
          WHERE prc.id_plantilla=?
          ORDER BY prc.dia_semana, prc.orden, prc.id`,
        [plantillaId]
      );

      const dias = {1:[],2:[],3:[],4:[],5:[],6:[],7:[]};
      for (const r of rows) {
        dias[r.dia_semana].push({
          id_cliente: r.id_cliente,
          orden: r.orden,
          clave: r.clave,
          nombre_empresa: r.nombre_empresa,
        });
      }

      res.json({ id_plantilla: plantillaId, dias });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('getPlantillaSemana', e);
    res.status(500).json({ error: 'Error al obtener plantilla' });
  }
};

/* =========================================================
   GET /api/rutas/plantilla/dia?vendedor_id=#&dia_semana=#
   -> Solo un día
   Respuesta: { id_plantilla, items: [] }
   ========================================================= */
export const getPlantillaDia = async (req, res) => {
  try {
    const vendedor_id = num(req.query.vendedor_id);
    const dia_semana  = num(req.query.dia_semana);
    if (!vendedor_id || !inRangeDia(dia_semana))
      return res.status(400).json({ error: 'vendedor_id y dia_semana (1..7) son obligatorios' });

    const conn = await db.getConnection();
    try {
      const plantillaId = await ensurePlantillaActiva(conn, vendedor_id);

      const [rows] = await conn.query(
        `SELECT prc.id, prc.id_cliente, prc.orden, c.clave, c.nombre_empresa
           FROM plantilla_ruta_clientes prc
           JOIN clientes c ON c.id = prc.id_cliente
          WHERE prc.id_plantilla=? AND prc.dia_semana=?
          ORDER BY prc.orden, prc.id`,
        [plantillaId, dia_semana]
      );

      res.json({ id_plantilla: plantillaId, items: rows });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('getPlantillaDia', e);
    res.status(500).json({ error: 'Error al obtener plantilla (día)' });
  }
};

/* =========================================================
   POST /api/rutas/plantilla/clientes
   Body: { vendedor_id, dia_semana, id_cliente }
   ========================================================= */
export const addClientePlantilla = async (req, res) => {
  const conn = await db.getConnection();
  try {
    const vendedor_id = num(req.body.vendedor_id);
    const dia_semana  = num(req.body.dia_semana);
    const id_cliente  = num(req.body.id_cliente);

    if (!vendedor_id || !inRangeDia(dia_semana) || !id_cliente)
      return res.status(400).json({ error: 'vendedor_id, dia_semana (1..7) e id_cliente son obligatorios' });

    await conn.beginTransaction();

    const plantillaId = await ensurePlantillaActiva(conn, vendedor_id);

    // ✅ Exclusividad por día entre vendedores (previo al insert)
    const disp = await clienteDisponibleParaDia(conn, id_cliente, dia_semana, vendedor_id);
    if (!disp.ok) {
      await conn.rollback();
      return res.status(409).json({
        error: `El cliente ya está asignado los ${dayName(dia_semana)} con ${disp.conflicto.vendedor_otro}`,
      });
    }

    // Orden siguiente
    const [[mx]] = await conn.query(
      `SELECT IFNULL(MAX(orden),0) AS m
         FROM plantilla_ruta_clientes
        WHERE id_plantilla=? AND dia_semana=?`,
      [plantillaId, dia_semana]
    );
    const next = Number(mx?.m || 0) + 1;

    await conn.query(
      `INSERT INTO plantilla_ruta_clientes (id_plantilla, dia_semana, id_cliente, orden)
       VALUES (?,?,?,?)`,
      [plantillaId, dia_semana, id_cliente, next]
    );

    // ✅ Reflejar en la PRÓXIMA ruta programada (si existe), evitando conflicto con otras rutas de esa fecha
    await syncNextProgramadaIfExists(conn, {
      vendedor_id,
      dia_semana,
      apply: async (rutaId, fechaObjetivo) => {
        // Evitar duplicar en esta ruta
        const [[eR]] = await conn.query(
          `SELECT id FROM rutas_clientes WHERE id_ruta=? AND id_cliente=? LIMIT 1`,
          [rutaId, id_cliente]
        );
        if (eR) return;

        // Evitar conflicto con otra ruta MISMA FECHA
        const [[conf]] = await conn.query(
          `SELECT rc.id
             FROM rutas_clientes rc
             JOIN rutas_diarias rd ON rd.id = rc.id_ruta
            WHERE rc.id_cliente=? AND rd.fecha=? AND rc.id_ruta<>? LIMIT 1`,
          [id_cliente, fechaObjetivo, rutaId]
        );
        if (conf) return;

        const [[mx2]] = await conn.query(
          `SELECT IFNULL(MAX(orden),0) AS m FROM rutas_clientes WHERE id_ruta=?`,
          [rutaId]
        );
        const ord = Number(mx2?.m || 0) + 1;

        await conn.query(
          `INSERT INTO rutas_clientes (id_ruta, id_cliente, orden) VALUES (?,?,?)`,
          [rutaId, id_cliente, ord]
        );
      }
    });

    await conn.commit();
    res.json({ ok: true, orden: next });
  } catch (e) {
    await conn.rollback();
    if (e?.sqlState === '45001') {
      return res.status(409).json({ error: e?.sqlMessage || 'El cliente ya tiene vendedor asignado para ese día' });
    }
    if (e?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Ese cliente ya está en la plantilla de ese día' });
    }
    console.error('addClientePlantilla', e);
    res.status(500).json({ error: 'Error al agregar cliente a plantilla' });
  } finally {
    conn.release();
  }
};

/* =========================================================
   PATCH /api/rutas/plantilla/reordenar
   Body soportado:
     A) { vendedor_id, dia_semana, items: [{ id_cliente, orden }, ...] }
     B) { vendedor_id, dia_semana, clientes: [id1, id2, ...] }  // orden = índice+1
   ========================================================= */
export const reorderPlantillaDia = async (req, res) => {
  const conn = await db.getConnection();
  try {
    const vendedor_id = num(req.body.vendedor_id);
    const dia_semana  = num(req.body.dia_semana);
    const items       = req.body.items;
    const clientes    = req.body.clientes;

    if (!vendedor_id || !inRangeDia(dia_semana))
      return res.status(400).json({ error: 'vendedor_id y dia_semana (1..7) son obligatorios' });

    let arr = [];
    if (Array.isArray(items) && items.length) {
      arr = items.map(it => ({
        id_cliente: num(it.id_cliente),
        orden:      num(it.orden),
      })).filter(x => x.id_cliente && x.orden);
    } else if (Array.isArray(clientes) && clientes.length) {
      arr = clientes.map((idc, idx) => ({
        id_cliente: num(idc),
        orden: idx + 1,
      })).filter(x => x.id_cliente);
    } else {
      return res.status(400).json({ error: 'Provee items[] o clientes[]' });
    }

    await conn.beginTransaction();
    const plantillaId = await ensurePlantillaActiva(conn, vendedor_id);

    for (const it of arr) {
      await conn.query(
        `UPDATE plantilla_ruta_clientes
            SET orden=?
          WHERE id_plantilla=? AND dia_semana=? AND id_cliente=?`,
        [it.orden, plantillaId, dia_semana, it.id_cliente]
      );
    }

    // Refleja el orden en la próxima ruta programada (si existe) para los pendientes (no escaneados)
    await syncNextProgramadaIfExists(conn, {
      vendedor_id,
      dia_semana,
      apply: async (rutaId) => {
        let pos = 1;
        for (const it of arr.sort((a,b)=>a.orden-b.orden)) {
          await conn.query(
            `UPDATE rutas_clientes
                SET orden=?
              WHERE id_ruta=? AND id_cliente=? AND scaneado=0`,
            [pos++, rutaId, it.id_cliente]
          );
        }
      }
    });

    await conn.commit();
    res.json({ ok: true, updated: arr.length });
  } catch (e) {
    await conn.rollback();
    console.error('reorderPlantillaDia', e);
    res.status(500).json({ error: 'Error al reordenar plantilla' });
  } finally {
    conn.release();
  }
};

/* =========================================================
   DELETE /api/rutas/plantilla/cliente
   Body: { vendedor_id, dia_semana, id_cliente }
   ========================================================= */
export const removeClientePlantilla = async (req, res) => {
  const conn = await db.getConnection();
  try {
    const vendedor_id = num(req.body.vendedor_id);
    const dia_semana  = num(req.body.dia_semana);
    const id_cliente  = num(req.body.id_cliente);

    if (!vendedor_id || !inRangeDia(dia_semana) || !id_cliente)
      return res.status(400).json({ error: 'vendedor_id, dia_semana (1..7) e id_cliente son obligatorios' });

    await conn.beginTransaction();
    const plantillaId = await ensurePlantillaActiva(conn, vendedor_id);

    const [r] = await conn.query(
      `DELETE FROM plantilla_ruta_clientes
        WHERE id_plantilla=? AND dia_semana=? AND id_cliente=?`,
      [plantillaId, dia_semana, id_cliente]
    );

    // Quitar también de la próxima ruta programada (si existe) solo si NO estaba escaneado
    await syncNextProgramadaIfExists(conn, {
      vendedor_id,
      dia_semana,
      apply: async (rutaId) => {
        const [[rc]] = await conn.query(
          `SELECT id, scaneado FROM rutas_clientes
            WHERE id_ruta=? AND id_cliente=? LIMIT 1`,
          [rutaId, id_cliente]
        );
        if (rc && Number(rc.scaneado) === 0) {
          await conn.query(`DELETE FROM rutas_clientes WHERE id=?`, [rc.id]);
        }
      }
    });

    await conn.commit();
    res.json({ ok: true, removed: r.affectedRows });
  } catch (e) {
    await conn.rollback();
    console.error('removeClientePlantilla', e);
    res.status(500).json({ error: 'Error al eliminar cliente de plantilla' });
  } finally {
    conn.release();
  }
};
