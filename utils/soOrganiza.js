// Futty v2.0 — Rodada 29B (E): "SÓ ORGANIZO". Quem administra o time mas não joga (`team_members.joga = false`, migração 067)
// administra tudo — jogos, sorteio, resultados, Resenha — e fica FORA do que é de jogador:
//   · a lista de presença (RSVP e "confirmar") e o sorteio;
//   · o ranking;
//   · a conta do pacote do time (os 25 jogadores e as gerações).
//
// Este módulo é a leitura dessa regra, feita de propósito em consultas pequenas e à parte (em vez de pôr `joga` dentro dos
// selects grandes de membros): sem a migração 067 a coluna não existe, e um select com ela derrubaria a página do time, o
// ranking e o sorteio de TODO mundo. Aqui, coluna ausente (ou qualquer falha de leitura) = ninguém só organiza, com um
// aviso no log, e o app segue como era até a migração ser aplicada.
const { supabase: supabaseDoMotor } = require('./db');

function criarSoOrganiza({ supabase = supabaseDoMotor } = {}) {
  let avisou = false;
  const avisar = (mensagem) => {
    if (avisou) return;
    avisou = true;
    console.warn('[soOrganiza] leitura de team_members.joga falhou (migração 067 aplicada?) — tratando todos como jogadores:', mensagem);
  };

  /** Ids dos membros de UM time que só organizam. */
  async function idsQueSoOrganizam(teamId) {
    const { data, error } = await supabase.from('team_members').select('user_id').eq('team_id', teamId).eq('joga', false);
    if (error) { avisar(error.message); return new Set(); }
    return new Set((data || []).map((m) => m.user_id).filter(Boolean));
  }

  /** Esta pessoa só organiza este time? */
  async function soOrganiza(teamId, userId) {
    if (!teamId || !userId) return false;
    const { data, error } = await supabase
      .from('team_members').select('user_id').eq('team_id', teamId).eq('user_id', userId).eq('joga', false).maybeSingle();
    if (error) { avisar(error.message); return false; }
    return !!data;
  }

  /** Os times em que esta pessoa só organiza (ids). */
  async function timesEmQueSoOrganiza(userId) {
    if (!userId) return new Set();
    const { data, error } = await supabase.from('team_members').select('team_id').eq('user_id', userId).eq('joga', false);
    if (error) { avisar(error.message); return new Set(); }
    return new Set((data || []).map((m) => m.team_id).filter(Boolean));
  }

  /** De vários times de uma vez: Map teamId → Set de quem só organiza. */
  async function organizadoresPorTime(teamIds) {
    const mapa = new Map();
    if (!teamIds?.length) return mapa;
    const { data, error } = await supabase.from('team_members').select('team_id, user_id').in('team_id', teamIds).eq('joga', false);
    if (error) { avisar(error.message); return mapa; }
    for (const m of data || []) {
      if (!mapa.has(m.team_id)) mapa.set(m.team_id, new Set());
      mapa.get(m.team_id).add(m.user_id);
    }
    return mapa;
  }

  return { idsQueSoOrganizam, soOrganiza, timesEmQueSoOrganiza, organizadoresPorTime };
}

/** A mensagem de quem só organiza e tenta entrar numa lista de jogadores. */
const MSG_SO_ORGANIZA = 'Você só organiza este time, então não entra na lista de presença nem no sorteio. Para jogar, mude em "Meu papel" nas configurações do time.';

module.exports = { criarSoOrganiza, MSG_SO_ORGANIZA, ...criarSoOrganiza() };
