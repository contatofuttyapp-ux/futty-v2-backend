// Futty v2.0 — Middleware de autenticação (valida o JWT do Supabase).
const { supabase } = require('../utils/db');
const { HttpError } = require('../utils/http');

/** Extrai o token "Bearer <token>" do header Authorization (ou null). */
function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/**
 * Exige autenticação: valida o JWT e injeta req.user.
 * Lança HttpError(401) se faltar/for inválido.
 */
async function requireAuth(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) throw new HttpError(401, 'Token em falta.');
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) throw new HttpError(401, 'Sessão inválida.');
    req.user = data.user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Autenticação opcional: popula req.user se houver token válido, mas nunca
 * bloqueia o pedido.
 */
async function optionalAuth(req, res, next) {
  try {
    const token = bearerToken(req);
    if (token) {
      const { data } = await supabase.auth.getUser(token);
      if (data?.user) req.user = data.user;
    }
  } catch {
    // ignora — autenticação opcional
  }
  next();
}

/**
 * Exige super-admin: valida o JWT (como requireAuth) e confirma a flag
 * public.users.is_super_admin. Lança 401 se a sessão for inválida, 403 se não
 * for super-admin. Usado só nas rotas /api/super/*.
 */
async function requireSuperAdmin(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) throw new HttpError(401, 'Token em falta.');
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) throw new HttpError(401, 'Sessão inválida.');
    req.user = data.user;
    const { data: perfil } = await supabase
      .from('users')
      .select('is_super_admin')
      .eq('id', req.user.id)
      .maybeSingle();
    if (!perfil?.is_super_admin) throw new HttpError(403, 'Acesso negado.');
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth, optionalAuth, requireSuperAdmin };
