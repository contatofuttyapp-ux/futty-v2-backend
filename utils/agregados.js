// Futty v2.0 — Agregados VIVOS de desempenho, calculados SEMPRE da fonte.
// UMA só verdade no app: golos (gols_jogadores) · vitórias (times_resultado A/B ×
// time_vencedor) · artilharia (games.artilheiro_user_id) · destaques (games.destaque_user_id).
// Conta jogos NORMAIS, MANUAIS e HISTÓRICOS por igual. As colunas legado em team_members
// (gols/vitorias/artilharia/destaque) são VESTIGIAIS — ninguém as lê (ver SPEC-EQUIPAS).
const { supabase } = require('./db');

// Colunas de `games` que estes agregados precisam. Exportadas porque quem já lê a
// tabela (o perfil do jogador lê-a para o histórico) manda as linhas em `opts.jogos`
// em vez de deixar a mesma leitura acontecer duas vezes — `times_resultado` é JSON
// gordo e viajava a dobrar.
const COLUNAS_JOGOS = 'id, times_resultado, resultado_nivel, time_vencedor, artilheiro_user_id, destaque_user_id';

/** Mapas {user_id: n} dos 4 eixos, para um time. Devolve também os gameIds.
 * @param {object} [opts]
 * @param {object[]} [opts.jogos] linhas de `games` deste time já lidas (têm de
 *   trazer COLUNAS_JOGOS); com elas, não se repete a consulta. */
async function agregadosDaEquipa(teamId, { jogos } = {}) {
  const golsMap = {}; const vitoriasMap = {}; const artilhariaMap = {}; const destaquesMap = {};
  const gameRows = Array.isArray(jogos)
    ? jogos
    : (await supabase.from('games').select(COLUNAS_JOGOS).eq('team_id', teamId)).data;
  const gameIds = (gameRows || []).map((g) => g.id);
  if (!gameIds.length) return { golsMap, vitoriasMap, artilhariaMap, destaquesMap, gameIds };

  const { data: golsRows } = await supabase.from('gols_jogadores').select('user_id, gols').in('game_id', gameIds);
  for (const g of golsRows || []) if (g.user_id) golsMap[g.user_id] = (golsMap[g.user_id] || 0) + (g.gols || 0);
  for (const g of gameRows || []) {
    if (g.artilheiro_user_id) artilhariaMap[g.artilheiro_user_id] = (artilhariaMap[g.artilheiro_user_id] || 0) + 1;
    if (g.destaque_user_id) destaquesMap[g.destaque_user_id] = (destaquesMap[g.destaque_user_id] || 0) + 1;
    if (g.resultado_nivel >= 1 && (g.time_vencedor === 'A' || g.time_vencedor === 'B') && g.times_resultado) {
      const idx = g.time_vencedor === 'A' ? 0 : 1;
      const js = g.times_resultado.times?.[idx]?.jogadores || [];
      for (const j of js) if (j.user_id) vitoriasMap[j.user_id] = (vitoriasMap[j.user_id] || 0) + 1;
    }
  }
  return { golsMap, vitoriasMap, artilhariaMap, destaquesMap, gameIds };
}

/** Total de golos de um jogador — todos os jogos, todas as times (para o /api/me). */
async function golosDoJogador(userId) {
  const { data } = await supabase.from('gols_jogadores').select('gols').eq('user_id', userId);
  return (data || []).reduce((s, r) => s + (r.gols || 0), 0);
}

module.exports = { agregadosDaEquipa, golosDoJogador, COLUNAS_JOGOS };
