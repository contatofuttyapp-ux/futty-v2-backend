// Futty v2.0 — Middleware de autenticação (valida o JWT do Supabase).
const { supabase } = require('../utils/db');
const { HttpError } = require('../utils/http');
const plataforma = require('../utils/plataformaStore');

// Mensagem digna para a conta suspensa (a Super age sobre a PLATAFORMA, nunca sobre
// o conteúdo). O frontend distingue pelo code 'CONTA_SUSPENSA' e mostra o ecrã próprio.
const MSG_SUSPENSO = 'A tua conta está suspensa. Se achas que é engano, fala connosco.';

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
    // Gate de suspensão: conta suspensa NÃO entra (mensagem digna). Cache em memória
    // (TTL curto) → custo ~nulo; fail-open se o store falhar (não tranca ninguém).
    if (await plataforma.userSuspenso(req.user.id)) {
      throw new HttpError(403, MSG_SUSPENSO, 'CONTA_SUSPENSA');
    }
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
