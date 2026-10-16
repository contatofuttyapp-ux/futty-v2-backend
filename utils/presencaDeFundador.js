// Futty v2.0 — PRESENÇA DE FUNDADOR. Um time que já jogava antes de entrar no app guarda uma data de corte (`teams.presenca_fundador_ate`,
// migração 083): todo membro que joga — inclusive quem entrar no time depois — conta como presente em todo jogo do time cujo DIA, no relógio do
// time, vai até essa data, inclusive. Depois dela, a presença é a de sempre (game_players.confirmado).
//
// A regra é LIDA, nunca gravada: nenhuma linha nasce em game_players. Assim a lista de presença dos jogos, o sorteio e os avisos continuam
// falando só de quem respondeu; quem entra amanhã (por convite, pedido ou SQL) ganha as presenças sem ninguém rodar nada; e apagar a data
// desfaz tudo. Quem soma presença (ranking, vitrine, estatísticas do admin, Início) passa por aqui — uma verdade só.
//
// Só valem jogos não cancelados e que já começaram: um jogo marcado para o dia do corte só conta depois do horário dele.
// Quem só organiza o time (`joga = false`) não joga, então não ganha presença — quem chama já tira essas pessoas da lista de membros.
// Sem a migração 083 a coluna não existe: a leitura falha, a regra fica desligada (um aviso no log) e o resto segue como era.
const { supabase } = require('./db');
const { partesNoFuso, normalizarFuso } = require('./fuso');

let avisou = false;
function avisar(mensagem) {
  if (avisou) return;
  avisou = true;
  console.warn('[presencaDeFundador] leitura de teams.presenca_fundador_ate falhou (migração 083 aplicada?) — regra desligada:', mensagem);
}

const dois = (n) => String(n).padStart(2, '0');

/** A regra a partir da linha do time: { ate: 'AAAA-MM-DD', fuso } ou null (sem data de corte). */
function corteDaLinha(time) {
  const ate = String(time?.presenca_fundador_ate ?? '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(ate)) return null;
  return { ate: ate.slice(0, 10), fuso: normalizarFuso(time.fuso) };
}

/** O dia do jogo no relógio do time, 'AAAA-MM-DD' (compara como texto). */
function diaDoJogo(iso, fuso) {
  const p = partesNoFuso(iso, fuso);
  return p ? `${p.ano}-${dois(p.mes)}-${dois(p.dia)}` : null;
}

/** Os ids dos jogos em que a presença de fundador vale: não cancelados, já começados e com o dia até a data de corte, inclusive. */
function jogosDeFundador(jogos, corte, agora = Date.now()) {
  if (!corte) return [];
  return (jogos || [])
    .filter((g) => {
      if (!g?.id || !g.data || g.cancelado || g.status === 'cancelado') return false;
      const inicio = new Date(g.data).getTime();
      if (!Number.isFinite(inicio) || inicio > agora) return false;
      const dia = diaDoJogo(g.data, corte.fuso);
      return !!dia && dia <= corte.ate;
    })
    .map((g) => g.id);
}

/**
 * As linhas de presença ({ game_id, user_id, confirmado }) com as de fundador somadas: cada pessoa de `userIds` em cada jogo de `jogoIds`,
 * sem duplicar quem já tem a presença confirmada naquele jogo. As linhas somadas levam `fundador: true`. Não altera o recebido.
 */
function comPresencaDeFundador(linhas, jogoIds, userIds) {
  const base = linhas || [];
  if (!jogoIds?.length || !userIds?.length) return base;
  const confirmadas = new Set(base.filter((l) => l?.confirmado).map((l) => `${l.game_id}|${l.user_id}`));
  const extra = [];
  for (const gameId of jogoIds) {
    for (const userId of userIds) {
      if (userId && !confirmadas.has(`${gameId}|${userId}`)) extra.push({ game_id: gameId, user_id: userId, confirmado: true, fundador: true });
    }
  }
  return extra.length ? [...base, ...extra] : base;
}

/** Quantos jogos DIFERENTES cada pessoa tem com presença confirmada: { user_id: n }. */
function presencasPorPessoa(linhas) {
  const porPessoa = {};
  for (const l of linhas || []) {
    if (!l?.confirmado || !l.user_id || !l.game_id) continue;
    (porPessoa[l.user_id] ||= new Set()).add(l.game_id);
  }
  return Object.fromEntries(Object.entries(porPessoa).map(([id, jogos]) => [id, jogos.size]));
}

/** Os jogos de fundador de UM time (ids). Sem data de corte, [] com uma leitura só. */
async function jogosDeFundadorDoTime(teamId, { agora = Date.now() } = {}) {
  if (!teamId) return [];
  const { data: time, error } = await supabase.from('teams').select('presenca_fundador_ate, fuso').eq('id', teamId).maybeSingle();
  if (error) { avisar(error.message); return []; }
  const corte = corteDaLinha(time);
  if (!corte) return [];
  const { data: jogos } = await supabase.from('games').select('id, data, status, cancelado').eq('team_id', teamId);
  return jogosDeFundador(jogos, corte, agora);
}

/**
 * Os jogos de fundador de UMA pessoa, somando todos os times em que ela joga (fora os que só organiza). Para o total de jogos do Início.
 * Sem time com data de corte, [] com uma leitura só (o /api/me é o caminho mais quente do app). O /api/inicio já leu os vínculos da pessoa
 * (com o time e as colunas novas dele) e quem só organiza: passa os dois e a leitura de team_members não se repete.
 * @param {{ vinculos?: Array<{ team_id: string, teams: object }>, soOrganiza?: Set<string>, agora?: number }} [opts]
 */
async function jogosDeFundadorDaPessoa(userId, { vinculos = null, soOrganiza = null, agora = Date.now() } = {}) {
  if (!userId) return [];
  let minhas = vinculos ? vinculos.map((v) => ({ team_id: v.team_id, joga: !soOrganiza?.has(v.team_id), teams: v.teams })) : null;
  if (!minhas) {
    const { data, error } = await supabase
      .from('team_members')
      .select('team_id, joga, teams ( presenca_fundador_ate, fuso )')
      .eq('user_id', userId);
    if (error) { avisar(error.message); return []; }
    minhas = data || [];
  }
  const meus = minhas
    .filter((m) => m.joga !== false)
    .map((m) => ({ id: m.team_id, corte: corteDaLinha(m.teams) }))
    .filter((t) => t.corte);
  if (!meus.length) return [];
  const { data: jogos } = await supabase.from('games').select('id, team_id, data, status, cancelado').in('team_id', meus.map((t) => t.id));
  return meus.flatMap((t) => jogosDeFundador((jogos || []).filter((g) => g.team_id === t.id), t.corte, agora));
}

module.exports = {
  corteDaLinha,
  diaDoJogo,
  jogosDeFundador,
  comPresencaDeFundador,
  presencasPorPessoa,
  jogosDeFundadorDoTime,
  jogosDeFundadorDaPessoa,
};
