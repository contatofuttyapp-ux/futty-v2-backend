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

/** Procura uma equipa pelo slug. Devolve null se não existir. */
async function getTeamBySlug(slug, columns = 'id, nome, slug, cor, criado_por, created_at') {
  const { data } = await supabase.from('teams').select(columns).eq('slug', slug).maybeSingle();
  return data || null;
}

/** Procura um utilizador pelo id. Devolve null se não existir. */
async function getUserById(id, columns = 'id, nome, email, avatar_url') {
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

/** Garante que existe a linha em public.users (o trigger pode não ter corrido). */
async function ensureUserRow(user) {
  await supabase.from('users').upsert({ id: user.id, email: user.email }, { onConflict: 'id' });
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

module.exports = {
  supabase,
  getTeamBySlug,
  getUserById,
  getRole,
  ensureUserRow,
  requireTeamMember,
  loadGame,
  currentVotingGame,
  computeRatings,
};
