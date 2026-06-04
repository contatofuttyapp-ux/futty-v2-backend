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

module.exports = { requireAuth, optionalAuth };
