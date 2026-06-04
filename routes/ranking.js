// Futty v2.0 — Rotas de ranking, perfil do jogador e votação.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, requireTeamMember, ensureUserRow, currentVotingGame } = require('../utils/db');
const { round2, periodoCutoffISO } = require('../utils/helpers');

const router = express.Router();

// Pesos do score (idênticos à v1): somam 100.
const RANKING_PESOS = { media: 40, vitorias: 20, artilharia: 12, gols: 10, destaque: 8, presenca: 10 };

/**
 * Constrói o ranking completo da equipa (score ponderado). Reutilizado pelo perfil.
 * Goleiros: gols/artilharia valem 3x no SCORE, mas mostram-se os números reais.
 * @returns {Promise<{ranking: object[], vgame: object|null, votaveis: string[]}>}
 */
async function buildRanking(teamId, periodo, meUserId) {
  // Membros (+ stats)
  const { data: membros } = await supabase
    .from('team_members')
    .select('gols, artilharia, vitorias, destaque, users ( id, nome, email, avatar_url )')
    .eq('team_id', teamId);
  const rows = (membros || []).filter((m) => m.users);

  // Votos no período (média de notas)
  const cutoff = periodoCutoffISO(periodo);
  let votesQuery = supabase.from('votes').select('para_user_id, nota, created_at').eq('team_id', teamId);
  if (cutoff) votesQuery = votesQuery.gte('created_at', cutoff);
  const { data: votos } = await votesQuery;
  const voteAgg = {};
  for (const v of votos || []) {
    if (!voteAgg[v.para_user_id]) voteAgg[v.para_user_id] = { sum: 0, count: 0 };
    voteAgg[v.para_user_id].sum += v.nota;
    voteAgg[v.para_user_id].count += 1;
  }

  // Jogos da equipa (para presença e goleiros)
  const { data: gameRows } = await supabase.from('games').select('id').eq('team_id', teamId);
  const gameIds = (gameRows || []).map((g) => g.id);

  // Presença: confirmações no último mês
  const presCount = {};
  const goleiroSet = new Set();
  if (gameIds.length) {
    const presCut = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: gps } = await supabase
      .from('game_players')
      .select('user_id, created_at')
      .in('game_id', gameIds)
      .eq('confirmado', true)
      .gte('created_at', presCut);
    for (const gp of gps || []) presCount[gp.user_id] = (presCount[gp.user_id] || 0) + 1;

    // Quem foi goleiro em pelo menos um jogo (bónus 3x no score)
    const { data: gks } = await supabase
      .from('game_players')
      .select('user_id')
      .in('game_id', gameIds)
      .eq('goleiro', true);
    for (const r of gks || []) goleiroSet.add(r.user_id);
  }

  // Jogo atual de votação: a minha nota + jogadores votáveis (confirmados)
  const vgame = await currentVotingGame(teamId);
  const minhaNotaPor = {};
  let votaveis = [];
  if (vgame) {
    const { data: conf } = await supabase
      .from('game_players')
      .select('user_id')
      .eq('game_id', vgame.id)
      .eq('confirmado', true);
    votaveis = (conf || []).map((c) => c.user_id).filter((idu) => idu !== meUserId);

    if (meUserId) {
      const { data: meus } = await supabase
        .from('votes')
        .select('para_user_id, nota')
        .eq('game_id', vgame.id)
        .eq('de_user_id', meUserId);
      for (const v of meus || []) minhaNotaPor[v.para_user_id] = v.nota;
    }
  }

  // Valores base por jogador (números reais para mostrar; *_efetivo para o score)
  const base = rows.map((m) => {
    const u = m.users;
    const a = voteAgg[u.id];
    const media = a && a.count ? a.sum / a.count : 0;
    const isGoleiro = goleiroSet.has(u.id);
    const gols = m.gols || 0;
    const artilharia = m.artilharia || 0;
    return {
      user_id: u.id,
      nome: u.nome || u.email,
      avatar_url: u.avatar_url || null,
      media_votos: round2(media),
      votos: a ? a.count : 0,
      vitorias: m.vitorias || 0,
      gols,
      artilharia,
      destaque: m.destaque || 0,
      presenca: presCount[u.id] || 0,
      minha_nota: minhaNotaPor[u.id] ?? null,
      is_goleiro: isGoleiro,
      gols_efetivos: isGoleiro ? gols * 3 : gols,
      artilharia_efetiva: isGoleiro ? artilharia * 3 : artilharia,
    };
  });

  // Máximos do grupo para normalizar (gols/artilharia pelos efetivos)
  const maxOf = (key) => base.reduce((m, b) => Math.max(m, b[key]), 0);
  const maxVit = maxOf('vitorias');
  const maxArt = maxOf('artilharia_efetiva');
  const maxGols = maxOf('gols_efetivos');
  const maxDest = maxOf('destaque');
  const maxPres = maxOf('presenca');
  const norm = (v, m) => (m > 0 ? v / m : 0);

  const ranking = base
    .map((b) => {
      const mediaPontos = RANKING_PESOS.media * (b.media_votos / 5);
      const vitoriasPontos = RANKING_PESOS.vitorias * norm(b.vitorias, maxVit);
      const artilhariaPontos = RANKING_PESOS.artilharia * norm(b.artilharia_efetiva, maxArt);
      const golsPontos = RANKING_PESOS.gols * norm(b.gols_efetivos, maxGols);
      const destaquePontos = RANKING_PESOS.destaque * norm(b.destaque, maxDest);
      const presencaPontos = RANKING_PESOS.presenca * norm(b.presenca, maxPres);
      const score =
        mediaPontos + vitoriasPontos + artilhariaPontos + golsPontos + destaquePontos + presencaPontos;
      return {
        ...b,
        media_pontos: round2(mediaPontos),
        vitorias_pontos: round2(vitoriasPontos),
        artilharia_pontos: round2(artilhariaPontos),
        gols_pontos: round2(golsPontos),
        destaque_pontos: round2(destaquePontos),
        presenca_pontos: round2(presencaPontos),
        score: round2(score),
      };
    })
    .sort((x, y) => {
      if (y.score !== x.score) return y.score - x.score;
      if (y.media_votos !== x.media_votos) return y.media_votos - x.media_votos;
      return x.nome.localeCompare(y.nome);
    });

  return { ranking, vgame, votaveis };
}

/** GET /api/teams/:slug/ranking?periodo=semana|mes|geral */
router.get(
  '/api/teams/:slug/ranking',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    const periodo = ['semana', 'mes', 'geral'].includes(req.query.periodo) ? req.query.periodo : 'geral';
    const { ranking, vgame, votaveis } = await buildRanking(team.id, periodo, req.user.id);

    res.json({
      team: { ...team, role },
      periodo,
      votacao: vgame ? { game_id: vgame.id, game_label: vgame.local || 'Jogo', votaveis } : null,
      ranking,
    });
  })
);

/** GET /api/teams/:slug/jogador/:userId — perfil completo do jogador. */
router.get(
  '/api/teams/:slug/jogador/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    const { ranking } = await buildRanking(team.id, 'geral', req.user.id);

    const jogador = ranking.find((r) => r.user_id === req.params.userId);
    if (!jogador) throw new HttpError(404, 'Jogador não encontrado nesta equipa.');

    // Posição entre quem tem média (votos > 0)
    const comMedia = ranking.filter((r) => r.votos > 0);
    const posIdx = comMedia.findIndex((r) => r.user_id === jogador.user_id);
    const posicao = posIdx >= 0 ? posIdx + 1 : null;

    // Radar 0-100 — normalizado pelos máximos REAIS do grupo
    const maxReal = (key) => ranking.reduce((m, r) => Math.max(m, r[key]), 0);
    const pct = (v, m) => (m > 0 ? Math.round((v / m) * 100) : 0);
    const radar = {
      presenca: pct(jogador.presenca, maxReal('presenca')),
      gols: pct(jogador.gols, maxReal('gols')),
      artilharia: pct(jogador.artilharia, maxReal('artilharia')),
      vitorias: pct(jogador.vitorias, maxReal('vitorias')),
      notas: Math.round((jogador.media_votos / 5) * 100),
    };

    // Galeria (select * tolera a coluna "tipo" não migrada)
    const { data: fotos } = await supabase
      .from('champion_photos')
      .select('*')
      .eq('team_id', team.id)
      .eq('user_id', jogador.user_id)
      .order('created_at', { ascending: false });
    const jogos_campeao = (fotos || []).map((f) => ({ foto: f.url, tipo: f.tipo || 'vitoria' }));

    res.json({
      team: { ...team, role },
      jogador: { ...jogador, posicao, total_com_media: comMedia.length },
      radar,
      jogos_campeao,
    });
  })
);

/** GET /api/teams/:slug/votacao-status — progresso de votação no jogo atual. */
router.get(
  '/api/teams/:slug/votacao-status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team } = await requireTeamMember(req.params.slug, req.user.id);

    const vgame = await currentVotingGame(team.id);
    if (!vgame) {
      return res.json({ game_id: null, total_colegas: 0, ja_votou_em: 0, percentagem: 100, faltam: 0 });
    }

    const { data: gp } = await supabase
      .from('game_players')
      .select('user_id')
      .eq('game_id', vgame.id)
      .eq('confirmado', true);
    const colegas = (gp || []).map((p) => p.user_id).filter((idu) => idu !== req.user.id);

    const { data: meus } = await supabase
      .from('votes')
      .select('para_user_id')
      .eq('game_id', vgame.id)
      .eq('de_user_id', req.user.id);
    const votados = new Set((meus || []).map((v) => v.para_user_id));

    const total = colegas.length;
    const jaVotouEm = colegas.filter((idu) => votados.has(idu)).length;
    const percentagem = total > 0 ? Math.round((jaVotouEm / total) * 100) : 100;

    res.json({ game_id: vgame.id, total_colegas: total, ja_votou_em: jaVotouEm, percentagem, faltam: total - jaVotouEm });
  })
);

/** POST /api/teams/:slug/votar — vota/altera a nota de um colega no jogo atual. */
router.post(
  '/api/teams/:slug/votar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team } = await requireTeamMember(req.params.slug, req.user.id);

    const paraUserId = req.body?.para_user_id;
    const nota = parseInt(req.body?.nota, 10);
    if (!paraUserId || paraUserId === req.user.id) throw new HttpError(400, 'Voto inválido.');
    if (!(nota >= 1 && nota <= 5)) throw new HttpError(400, 'A nota tem de ser entre 1 e 5.');

    const vgame = await currentVotingGame(team.id);
    if (!vgame) throw new HttpError(400, 'Não há jogo aberto para votação.');

    const { data: gpRow } = await supabase
      .from('game_players')
      .select('id')
      .eq('game_id', vgame.id)
      .eq('user_id', paraUserId)
      .eq('confirmado', true)
      .maybeSingle();
    if (!gpRow) throw new HttpError(400, 'Esse jogador não está confirmado no jogo.');

    await ensureUserRow(req.user);

    const { error } = await supabase
      .from('votes')
      .upsert(
        { de_user_id: req.user.id, para_user_id: paraUserId, team_id: team.id, game_id: vgame.id, nota },
        { onConflict: 'de_user_id,para_user_id,game_id' }
      );
    if (error) throw new HttpError(500, error.message);

    res.json({ ok: true, minha_nota: nota });
  })
);

module.exports = router;
