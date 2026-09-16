// Futty v2.0 — Camada de acesso à base de dados (cliente Supabase + helpers).
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { HttpError } = require('./http');
const { RATING_DEFAULT } = require('./helpers');

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[Futty] ERRO: faltam SUPABASE_URL / SUPABASE_SERVICE_KEY no .env.');
  process.exit(1);
}

// Cliente admin (service_role) — uso exclusivo no servidor, ignora RLS.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Procura uma equipa pelo slug. Devolve null se não existir OU se estiver
 *  suspensa pela plataforma (equipa suspensa = invisível e inativa em TODAS as
 *  rotas de equipa; a Super mexe pelo team.id, por isso mantém o controlo).
 *  Lazy-require do store para evitar dependência circular (plataformaStore → db). */
async function getTeamBySlug(slug, columns = 'id, nome, slug, cor, criado_por, created_at') {
  const cols = /(^|,\s*)id(\s*,|$)/.test(columns) ? columns : `id, ${columns}`;
  const { data } = await supabase.from('teams').select(cols).eq('slug', slug).maybeSingle();
  if (!data) return null;
  // eslint-disable-next-line global-require
  const plataforma = require('./plataformaStore');
  if (data.id && (await plataforma.equipaSuspensa(data.id))) return null;
  return data;
}

/** Procura um utilizador pelo id. Devolve null se não existir. */
async function getUserById(id, columns = 'id, nome, nome_jogador, email, avatar_url, avatar_generico') {
  const { data } = await supabase.from('users').select(columns).eq('id', id).maybeSingle();
  return data || null;
}

/** Role do utilizador na equipa ('admin' | 'member') ou null se não for membro. */
async function getRole(teamId, userId) {
  const { data } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .maybeSingle();
  return data?.role || null;
}

// Memo em memória (13-set, "Velocidade 3"): ensureUserRow é chamado em TODO
// /api/me (obterMe) — um upsert por pedido, mesmo quando a linha já existe há
// muito. Chave inclui email/birthdate: se algum mudar (troca de email,
// birthdate preenchida tardiamente) o próximo pedido volta a fazer upsert
// mesmo dentro da janela — nunca "esquece" um dado novo por causa do cache.
// TTL 10min, teto de 2000 chaves (LRU: remove a mais antiga ao ultrapassar —
// mesma filosofia do cache de sessão em middleware/auth.js).
const ENSURE_USER_TTL_MS = 10 * 60 * 1000;
const ENSURE_USER_MAX = 2000;
const ensureUserCache = new Map(); // `${id}:${email}:${birthdate}` -> expiraEm

/** Garante que existe a linha em public.users (o trigger pode não ter corrido).
 * Persiste também a birthdate enviada no signUp (user_metadata) quando válida —
 * é a forma de capturar a data do registo, já que o registo é feito via Supabase
 * Auth no frontend (não há POST /api/auth/register). */
async function ensureUserRow(user) {
  const row = { id: user.id, email: user.email };
  const bd = user.user_metadata?.birthdate;
  if (typeof bd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(bd)) row.birthdate = bd;

  const chave = `${row.id}:${row.email || ''}:${row.birthdate || ''}`;
  const agora = Date.now();
  const expiraEm = ensureUserCache.get(chave);
  if (expiraEm && expiraEm > agora) return; // já garantido há menos de 10min

  await supabase.from('users').upsert(row, { onConflict: 'id' });

  if (ensureUserCache.size >= ENSURE_USER_MAX) {
    ensureUserCache.delete(ensureUserCache.keys().next().value); // remove a mais antiga
  }
  ensureUserCache.set(chave, agora + ENSURE_USER_TTL_MS);
}

/** Garante o bucket público "avatars" no Storage (idempotente). Corre no arranque. */
async function ensureAvatarsBucket() {
  const { data: existente } = await supabase.storage.getBucket('avatars');
  if (existente) return;
  const { error } = await supabase.storage.createBucket('avatars', {
    public: true,
    fileSizeLimit: '5MB',
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  });
  // Se já existir (corrida entre processos), ignora; resto é avisado.
  if (error && !/exist/i.test(error.message)) {
    console.error('[Futty] Falha ao criar bucket "avatars":', error.message);
  }
}

/**
 * Carrega a equipa pelo slug e valida que o utilizador é membro.
 * Lança HttpError(404) se não existir, HttpError(403) se não for membro.
 * @returns {Promise<{team: object, role: string}>}
 */
async function requireTeamMember(slug, userId) {
  const team = await getTeamBySlug(slug, 'id, slug, nome, cor');
  if (!team) throw new HttpError(404, 'Equipa não encontrada.');
  const role = await getRole(team.id, userId);
  if (!role) throw new HttpError(403, 'Não és membro desta equipa.');
  return { team, role };
}

/** Carrega um jogo com a equipa associada (game.teams). Null se não existir. */
async function loadGame(id) {
  const { data } = await supabase
    .from('games')
    .select('*, teams ( id, slug, nome, cor )')
    .eq('id', id)
    .maybeSingle();
  return data || null;
}

/** Jogo atual de votação: o mais recente sorteado e em curso/terminado. */
async function currentVotingGame(teamId) {
  const { data } = await supabase
    .from('games')
    .select('id, local, data, status')
    .eq('team_id', teamId)
    .eq('sorteio_realizado', true)
    .in('status', ['em_curso', 'terminado'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

/**
 * Calcula o rating (média das notas recebidas) de cada user_id na equipa.
 * Quem não tem votos fica com RATING_DEFAULT.
 * @returns {Promise<Record<string, number>>} mapa user_id -> rating
 */
async function computeRatings(teamId, userIds) {
  const acc = {};
  userIds.forEach((id) => {
    acc[id] = { sum: 0, count: 0 };
  });

  if (userIds.length) {
    const { data } = await supabase
      .from('votes')
      .select('para_user_id, nota')
      .eq('team_id', teamId)
      .in('para_user_id', userIds);
    for (const v of data || []) {
      if (acc[v.para_user_id]) {
        acc[v.para_user_id].sum += v.nota;
        acc[v.para_user_id].count += 1;
      }
    }
  }

  const out = {};
  for (const id of userIds) {
    const { sum, count } = acc[id];
    out[id] = count ? sum / count : RATING_DEFAULT;
  }
  return out;
}

/**
 * Rodada 9: quem é goleiro DO TIME. É o padrão de cada jogo: quem confirma sem
 * dizer nada entra como goleiro.
 * Rodada 10B: a fonte passa a ser SÓ team_members.categoria ('GR'). A coluna
 * `posicao` ('GL'|null) era a mesma decisão guardada duas vezes — o dono
 * decidiu manter uma só, e é esta (é a que já mandava no ranking).
 * @param {string} teamId
 * @param {string[]} [userIds] restringe a consulta (omitir = time inteiro)
 * @returns {Promise<Set<string>>} user_ids marcados como goleiro no time
 */
async function goleirosDoTime(teamId, userIds) {
  if (userIds && !userIds.length) return new Set();
  let q = supabase.from('team_members').select('user_id').eq('team_id', teamId).eq('categoria', 'GR');
  if (userIds) q = q.in('user_id', userIds);
  const { data } = await q;
  return new Set((data || []).map((m) => m.user_id).filter(Boolean));
}

module.exports = {
  supabase,
  getTeamBySlug,
  getUserById,
  getRole,
  ensureUserRow,
  ensureAvatarsBucket,
  requireTeamMember,
  loadGame,
  currentVotingGame,
  computeRatings,
  goleirosDoTime,
};
