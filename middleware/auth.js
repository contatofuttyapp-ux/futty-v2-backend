// Futty v2.0 — Middleware de autenticação (valida o JWT do Supabase).
const { isAuthRetryableFetchError } = require('@supabase/supabase-js');
const { supabase } = require('../utils/db');
const { HttpError } = require('../utils/http');
const { criarCache } = require('../utils/cacheQuente');
const plataforma = require('../utils/plataformaStore');

// Mensagem digna para a conta suspensa (a Super age sobre a PLATAFORMA, nunca sobre
// o conteúdo). O frontend distingue pelo code 'CONTA_SUSPENSA' e mostra o ecrã próprio.
const MSG_SUSPENSO = 'Sua conta está suspensa. Se você acha que foi engano, fale com a gente.';

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
//
// Dedupe (15-set, "Velocidade 7A"): no arranque frio o app manda 3 pedidos com o
// MESMO token ao mesmo tempo, e cada um fazia o seu getUser. Agora os 3 esperam a
// mesma ida ao Supabase Auth (utils/cacheQuente.js).
//
// Renovação por trás (Velocidade 7A): passados os 60 s, a sessão conhecida sai
// NA HORA e a revalidação no Supabase corre em segundo plano. Duas travas:
//   · só se serve a sessão velha enquanto o PRÓPRIO token está no prazo (claim
//     exp) — é o mesmo que uma verificação local do JWT aceitaria. Token vencido
//     espera a resposta do Supabase, como antes;
//   · se a revalidação disser que o token deixou de valer, a entrada sai; se só
//     falhar a rede, a sessão fica (um soluço do Supabase não desloga ninguém).
const SESSAO_CACHE_TTL_MS = 60_000;
const SESSAO_CACHE_MAX = 500;
const sessoes = criarCache({
  nome: 'sessao',
  ttlMs: SESSAO_CACHE_TTL_MS,
  max: SESSAO_CACHE_MAX,
  guardarSe: (user) => !!user,
  servirVelhoSe: (user, token) => tokenNoPrazo(token),
});

function tokenNoPrazo(token) {
  try {
    const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof exp === 'number' && exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

/**
 * true se o motor já validou este token há pouco, sem ir à rede. É o que separa uma
 * sessão de verdade de um Authorization qualquer: os limiters gerais da /api só
 * tiram do balde por IP o pedido que passa neste teste (middleware/limiters.js).
 */
function sessaoConhecida(token) {
  return sessoes.espiar(token) !== undefined && tokenNoPrazo(token);
}

async function validarNoSupabase(token) {
  const { data, error } = await supabase.auth.getUser(token);
  if (error && isAuthRetryableFetchError(error)) throw error; // rede, não token inválido
  return error || !data?.user ? null : data.user;
}

async function getUserCacheado(token) {
  try {
    return await sessoes.obter(token, () => validarNoSupabase(token));
  } catch (erro) {
    // Sem sessão em cache e o Supabase não respondeu: 401, como sempre foi.
    if (isAuthRetryableFetchError(erro)) return null;
    throw erro;
  }
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
 *
 * Velocidade 7A: esquece também as sessões da MESMA conta em outros tokens
 * (outro aparelho). Com a renovação por trás, uma delas podia sair velha mais
 * uma vez — com a conta já apagada ou o onboarding já concluído.
 */
function invalidarSessaoDoPedido(req) {
  const token = bearerToken(req);
  if (token) sessoes.invalidar(token);
  const userId = req.user?.id;
  if (userId) sessoes.invalidarSe((user) => user.id === userId);
}

module.exports = { requireAuth, optionalAuth, requireSuperAdmin, invalidarSessaoDoPedido, getUserCacheado, bearerToken, sessaoConhecida };
