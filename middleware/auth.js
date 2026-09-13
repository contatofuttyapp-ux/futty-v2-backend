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

// Cache de sessão (12-set, "Velocidade 2"): supabase.auth.getUser(token) é uma
// ida à rede Supabase Auth em TODO pedido autenticado — motor em São Paulo,
// ~240ms de RTT para quem está longe. Chave = o token inteiro (não o user id —
// tokens diferentes do mesmo utilizador não colidem nem se pisam), TTL curto
// (60s) e um teto de entradas (limpa a mais antiga ao ultrapassar — Map
// preserva ordem de inserção) para não crescer sem fim num processo de longa
// duração. SÓ tokens válidos entram em cache: 401 continua imediato (token em
// falta/inválido nunca fica "esquecido" como bom, e a checagem nem chega a
// tocar o cache). Mesma filosofia do cache de suspensão em plataformaStore.js
// (TTL curto, fail-aberto do lado de fora, nada distribuído).
const SESSAO_CACHE_TTL_MS = 60_000;
const SESSAO_CACHE_MAX = 500;
const sessaoCache = new Map(); // token -> { user, expiraEm }

async function getUserCacheado(token) {
  const agora = Date.now();
  const hit = sessaoCache.get(token);
  if (hit) {
    if (hit.expiraEm > agora) return hit.user;
    sessaoCache.delete(token); // expirou o cache (não necessariamente o token)
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;

  if (sessaoCache.size >= SESSAO_CACHE_MAX) {
    sessaoCache.delete(sessaoCache.keys().next().value); // remove a mais antiga
  }
  sessaoCache.set(token, { user: data.user, expiraEm: agora + SESSAO_CACHE_TTL_MS });
  return data.user;
}

/**
 * Exige autenticação: valida o JWT e injeta req.user.
 * Lança HttpError(401) se faltar/for inválido.
 */
async function requireAuth(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) throw new HttpError(401, 'Token em falta.');
    const user = await getUserCacheado(token);
    if (!user) throw new HttpError(401, 'Sessão inválida.');
    req.user = user;
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
      const user = await getUserCacheado(token);
      if (user) req.user = user;
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
    const user = await getUserCacheado(token);
    if (!user) throw new HttpError(401, 'Sessão inválida.');
    req.user = user;
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

/**
 * Remove o token do pedido atual do cache de sessão — usado por DELETE /api/me
 * (14-set): sem isto, a conta já excluída continuava "autenticada" nesse
 * mesmo token por até SESSAO_CACHE_TTL_MS (60s), porque requireAuth nunca
 * voltaria a validar contra o Supabase dentro dessa janela.
 */
function invalidarSessaoDoPedido(req) {
  const token = bearerToken(req);
  if (token) sessaoCache.delete(token);
}

module.exports = { requireAuth, optionalAuth, requireSuperAdmin, invalidarSessaoDoPedido };
