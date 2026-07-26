// Futty v2.0 — Agregados VIVOS de desempenho, calculados SEMPRE da fonte.
// UMA só verdade no app: golos (gols_jogadores) · vitórias (times_resultado A/B ×
// time_vencedor) · artilharia (games.artilheiro_user_id) · destaques (games.destaque_user_id).
// Conta jogos NORMAIS, MANUAIS e HISTÓRICOS por igual. As colunas legado em team_members
// (gols/vitorias/artilharia/destaque) são VESTIGIAIS — ninguém as lê (ver SPEC-EQUIPAS).
const { supabase } = require('./db');

/** Mapas {user_id: n} dos 4 eixos, para uma equipa. Devolve também os gameIds. */
async function agregadosDaEquipa(teamId) {
  const golsMap = {}; const vitoriasMap = {}; const artilhariaMap = {}; const destaquesMap = {};
  const { data: gameRows } = await supabase
    .from('games')
    .select('id, times_resultado, resultado_nivel, time_vencedor, artilheiro_user_id, destaque_user_id')
    .eq('team_id', teamId);
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

/** Total de golos de um jogador — todos os jogos, todas as equipas (para o /api/me). */
async function golosDoJogador(userId) {
  const { data } = await supabase.from('gols_jogadores').select('gols').eq('user_id', userId);
  return (data || []).reduce((s, r) => s + (r.gols || 0), 0);
}

module.exports = { agregadosDaEquipa, golosDoJogador };
