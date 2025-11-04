import bcrypt from 'bcryptjs';
import db from '../../config/db.js';

const MAX_INTENTOS = 5;
const BLOQUEO_MINUTOS = 15;
const now = () => new Date();

export const verifyAdminPin = async (req, res) => {
  try {
    const user = req.user; // { id, rol } desde verificarJwt
    const ALLOWED_ROLES = [2, 4]; // Cargador o SuperAdmin

    if (!ALLOWED_ROLES.includes(user?.rol)) {
      return res.status(403).json({ ok:false, msg:'No tienes permisos para esta acción' });
    }

    // SuperAdmin pasa sin pedir PIN
    if (user.rol === 4) {
      return res.json({ ok:true, msg:'OK (bypass superadmin)' });
    }

    const { pin } = req.body || {};
    if (!pin || typeof pin !== 'string' || !pin.trim()) {
      return res.status(400).json({ ok:false, msg:'PIN requerido' });
    }
    const pinTrim = pin.trim();

    // Busca el registro de cargador ligado al usuario autenticado
    const [rows] = await db.query(
      `SELECT id, pin_hash, pin_intentos, pin_bloqueado_hasta
         FROM cargadores
        WHERE id_usuario = ?`,
      [user.id]
    );
    const carg = rows?.[0];
    if (!carg) return res.status(403).json({ ok:false, msg:'No eres un cargador válido' });

    // ¿bloqueado temporalmente?
    if (carg.pin_bloqueado_hasta && new Date(carg.pin_bloqueado_hasta) > now()) {
      return res.status(423).json({
        ok:false,
        msg:'PIN bloqueado temporalmente. Inténtalo más tarde.',
        locked_until: new Date(carg.pin_bloqueado_hasta).toISOString(),
      });
    }

    if (!carg.pin_hash) {
      return res.status(409).json({ ok:false, msg:'Este cargador no tiene PIN configurado' });
    }

    const ok = await bcrypt.compare(pinTrim, carg.pin_hash);
    if (!ok) {
      const intentos = (Number(carg.pin_intentos) || 0) + 1;
      const bloquearHasta = intentos >= MAX_INTENTOS
        ? new Date(now().getTime() + BLOQUEO_MINUTOS * 60 * 1000)
        : null;

      await db.query(
        `UPDATE cargadores
            SET pin_intentos = ?,
                pin_bloqueado_hasta = CASE WHEN ? IS NOT NULL THEN ? ELSE pin_bloqueado_hasta END
          WHERE id = ?`,
        [intentos, bloquearHasta, bloquearHasta, carg.id]
      );

      return res.status(401).json({
        ok:false,
        msg:'PIN incorrecto',
        remaining_attempts: Math.max(MAX_INTENTOS - intentos, 0),
        ...(bloquearHasta ? { locked_until: bloquearHasta.toISOString() } : {}),
      });
    }

    // Éxito: limpia intentos/bloqueo
    await db.query(
      `UPDATE cargadores
          SET pin_intentos = 0,
              pin_bloqueado_hasta = NULL
        WHERE id = ?`,
      [carg.id]
    );

    return res.json({ ok:true, msg:'PIN correcto' });
  } catch (error) {
    console.error('Error en verifyAdminPin:', error);
    return res.status(500).json({ ok:false, msg:'Error del servidor' });
  }
};
