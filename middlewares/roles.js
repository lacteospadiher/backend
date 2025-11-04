// middlewares/roles.js
export function getRolId(u) {
  if (!u) return 0;
  const cand = [u.rol_id, u.rol, u.role, u?.usuario?.rol_id, u?.usuario?.rol];
  for (const raw of cand) {
    if (raw == null) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    const s = String(raw || '').toLowerCase();
    if (s.includes('super')) return 4;
    if (s.includes('admin')) return 1;
    if (s.includes('carg')) return 2;
    if (s.includes('vend')) return 3;
    if (s.includes('devol')) return 5;
    if (s.includes('pedid')) return 6;
  }
  return 0;
}

/** Exige rol dentro de la lista permitida (usa getRolId) */
export function requireAnyRole(allowed = []) {
  return (req, res, next) => {
    try {
      const user = req.user || req.auth || req.session?.user;
      if (!user) return res.status(401).json({ error: 'No autenticado' });
      const rolId = getRolId(user);
      if (allowed.includes(rolId)) return next();
      return res.status(403).json({ error: 'No autorizado' });
    } catch {
      return res.status(500).json({ error: 'Error de autorización' });
    }
  };
}

/** (opcional) Solo SuperAdmin = 4 */
export function requireSuperAdmin(req, res, next) {
  try {
    const user = req.user || req.auth || req.session?.user;
    if (!user) return res.status(401).json({ error: 'No autenticado' });
    const rolId = getRolId(user);
    if (rolId === 4) return next();
    return res.status(403).json({ error: 'No autorizado' });
  } catch (e) {
    return res.status(500).json({ error: 'Error de autorización' });
  }
}
