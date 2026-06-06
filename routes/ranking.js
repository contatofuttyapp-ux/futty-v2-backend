// Futty v2.0 — Ranking + perfil + votação (modelo definitivo).
// 1 voto por (votante, votado, equipa), permanente/atualizável, meias estrelas.
// Sem jogo de votação, sem períodos. Nota exibida em escala 6-10.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, requireTeamMember, ensureUserRow } = require('../utils/db');
const { round2, notaParaExibir } = require('../utils/helpers');
const { enviarNotificacao } = require('./push');

const router = express.Router();

// Mínimo de votos para a nota aparecer.
const MIN_VOTOS = 3;

// nota válida: número entre 0.5 e 5 em incrementos de 0.5.
function notaValida(n) {
  return Number.isFinite(n) && n >= 0.5 && n <= 5 && Number.isInteger(n * 2);
}

/**
 * Constrói o ranking da equipa (score ponderado, separado por categoria).
 * @returns {Promise<object[]>} ranking ordenado por score DESC com posicao.
 */
async function buildRanking(teamId, meUserId) {
  // Membros (+ stats + categoria)
  const { data: membros } = await supabase
    .from('team_members')
    .select('user_id, gols, artilharia, vitorias, destaque, categoria, visivel_ranking, users ( id, nome, email, avatar_url, cor_frame )')
    .eq('team_id', teamId);
  // Só membros visíveis no ranking (admin pode ocultar). Default visível.
  const rows = (membros || []).filter((m) => m.users && m.visivel_ranking !== false);

  // Votos da equipa (todos) — média + o meu voto por jogador.
  const { data: votos } = await supabase.from('votes').select('para_user_id, de_user_id, nota').eq('team_id', teamId);
  const agg = {};
  const minhaNota = {};
  for (const v of votos || []) {
    if (!agg[v.para_user_id]) agg[v.para_user_id] = { sum: 0, count: 0 };
    agg[v.para_user_id].sum += Number(v.nota);
    agg[v.para_user_id].count += 1;
    if (meUserId && v.de_user_id === meUserId) minhaNota[v.para_user_id] = Number(v.nota);
  }

  // Presença: confirmações no último mês.
  const { data: gameRows } = await supabase.from('games').select('id').eq('team_id', teamId);
  const gameIds = (gameRows || []).map((g) => g.id);
  const presCount = {};
  if (gameIds.length) {
    const presCut = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: gps } = await supabase
      .from('game_players')
      .select('user_id, created_at')
      .in('game_id', gameIds)
      .eq('confirmado', true)
      .gte('created_at', presCut);
    for (const gp of gps || []) presCount[gp.user_id] = (presCount[gp.user_id] || 0) + 1;
  }

  const base = rows.map((m) => {
    const u = m.users;
    const a = agg[u.id];
    const total = a ? a.count : 0;
    const notaInterna = total >= MIN_VOTOS ? a.sum / a.count : null;
    const ehGR = m.categoria === 'GR';
    const vitorias = m.vitorias || 0;
    const destaques = m.destaque || 0;
    const presenca = presCount[u.id] || 0;
    const gols = m.gols || 0;
    const artilharia = m.artilharia || 0;
    const notaNorm = notaInterna || 0; // 1-5 (0 se ainda sem nota)

    // Score ponderado por posição (valores brutos × peso).
    const score = ehGR
      ? notaNorm * 40 + vitorias * 35 + destaques * 15 + presenca * 10
      : notaNorm * 40 + vitorias * 20 + gols * 15 + artilharia * 12 + destaques * 8 + presenca * 5;

    return {
      user_id: u.id,
      sou_eu: meUserId != null && u.id === meUserId, // a própria linha do utilizador
      nome: u.nome || u.email,
      avatar_url: u.avatar_url || null,
      cor_frame: u.cor_frame || 'dourado',
      categoria: ehGR ? 'GR' : 'linha',
      nota: notaParaExibir(notaInterna), // exibida (6-10) ou null
      nota_interna: notaInterna, // 1-5 (uso interno: radar)
      total_votos: total,
      minha_nota: minhaNota[u.id] ?? null,
      vitorias,
      gols,
      artilharia,
      destaques,
      presenca,
      score: round2(score),
    };
  });

  base.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    if ((y.nota || 0) !== (x.nota || 0)) return (y.nota || 0) - (x.nota || 0);
    return x.nome.localeCompare(y.nome);
  });

  return base.map((b, i) => ({ ...b, posicao: i + 1 }));
}

/** GET /api/teams/:slug/ranking — ranking completo (sem períodos). */
router.get(
  '/api/teams/:slug/ranking',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    const ranking = await buildRanking(team.id, req.user.id);
    res.json({ team: { ...team, role }, ranking });
  })
);

/** GET /api/teams/:slug/jogador/:userId — perfil completo do jogador. */
router.get(
  '/api/teams/:slug/jogador/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    const ranking = await buildRanking(team.id, req.user.id);

    const jogador = ranking.find((r) => r.user_id === req.params.userId);
    if (!jogador) throw new HttpError(404, 'Jogador não encontrado nesta equipa.');

    // Posição entre quem tem nota (>= MIN_VOTOS votos)
    const comNota = ranking.filter((r) => r.nota != null);
    const posIdx = comNota.findIndex((r) => r.user_id === jogador.user_id);
    const posicao = posIdx >= 0 ? posIdx + 1 : null;

    // Radar 0-100 — normalizado pelos máximos reais do grupo.
    const maxReal = (key) => ranking.reduce((m, r) => Math.max(m, r[key]), 0);
    const pct = (v, m) => (m > 0 ? Math.round((v / m) * 100) : 0);
    const radar = {
      presenca: pct(jogador.presenca, maxReal('presenca')),
      gols: pct(jogador.gols, maxReal('gols')),
      artilharia: pct(jogador.artilharia, maxReal('artilharia')),
      vitorias: pct(jogador.vitorias, maxReal('vitorias')),
      notas: Math.round(((jogador.nota_interna || 0) / 5) * 100),
    };

    const { data: fotos } = await supabase
      .from('champion_photos')
      .select('*')
      .eq('team_id', team.id)
      .eq('user_id', jogador.user_id)
      .order('created_at', { ascending: false });
    const jogos_campeao = (fotos || []).map((f) => ({ foto: f.url, tipo: f.tipo || 'vitoria' }));

    res.json({
      team: { ...team, role },
      jogador: { ...jogador, posicao, total_com_nota: comNota.length },
      radar,
      jogos_campeao,
    });
  })
);

/**
 * GET /api/teams/:slug/votacao-status — progresso de votação do utilizador.
 * { total, votados, faltam, pedido_revotacao }
 */
router.get(
  '/api/teams/:slug/votacao-status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team } = await requireTeamMember(req.params.slug, req.user.id);

    const { data: membros } = await supabase.from('team_members').select('user_id').eq('team_id', team.id);
    const total = (membros || []).filter((m) => m.user_id !== req.user.id).length;

    const { data: meus } = await supabase
      .from('votes')
      .select('para_user_id, updated_at')
      .eq('team_id', team.id)
      .eq('de_user_id', req.user.id);
    const votados = new Set((meus || []).map((v) => v.para_user_id)).size;

    const { data: teamRow } = await supabase.from('teams').select('revotar_pedido_em').eq('id', team.id).maybeSingle();
    const pedidoEm = teamRow?.revotar_pedido_em ? new Date(teamRow.revotar_pedido_em).getTime() : 0;
    const maxUpdated = (meus || []).reduce((mx, v) => Math.max(mx, v.updated_at ? new Date(v.updated_at).getTime() : 0), 0);
    const pedido_revotacao = pedidoEm > 0 && pedidoEm > maxUpdated;

    res.json({ total, votados, faltam: Math.max(0, total - votados), pedido_revotacao });
  })
);

/** POST /api/teams/:slug/votar — vota/atualiza a nota de um membro. */
router.post(
  '/api/teams/:slug/votar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team } = await requireTeamMember(req.params.slug, req.user.id);

    const paraUserId = req.body?.para_user_id;
    const nota = Number(req.body?.nota);
    if (!paraUserId) throw new HttpError(400, 'Voto inválido.');
    if (paraUserId === req.user.id) throw new HttpError(400, 'Não podes votar em ti próprio.');
    if (!notaValida(nota)) throw new HttpError(400, 'A nota tem de ser entre 0.5 e 5 (incrementos de 0.5).');

    // O votado tem de ser membro da equipa (visível no ranking).
    const { data: alvo } = await supabase
      .from('team_members')
      .select('id')
      .eq('team_id', team.id)
      .eq('user_id', paraUserId)
      .maybeSingle();
    if (!alvo) throw new HttpError(400, 'Esse jogador não é membro desta equipa.');

    await ensureUserRow(req.user);

    const { data, error } = await supabase
      .from('votes')
      .upsert(
        { de_user_id: req.user.id, para_user_id: paraUserId, team_id: team.id, nota, game_id: null, updated_at: new Date().toISOString() },
        { onConflict: 'de_user_id,para_user_id,team_id' }
      )
      .select('para_user_id, nota, updated_at')
      .single();
    if (error) throw new HttpError(500, error.message);

    res.json({ voto: data });
  })
);

/** POST /api/teams/:slug/pedir-revotacao — pede a todos para revotarem (admin). */
router.post(
  '/api/teams/:slug/pedir-revotacao',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem pedir revotação.');

    const { error } = await supabase.from('teams').update({ revotar_pedido_em: new Date().toISOString() }).eq('id', team.id);
    if (error) throw new HttpError(500, error.message);
    res.json({ pedido: true });

    // Notifica os membros que ainda não votaram (fire-and-forget).
    Promise.all([
      supabase.from('team_members').select('user_id').eq('team_id', team.id),
      supabase.from('votes').select('de_user_id').eq('team_id', team.id),
    ]).then(([membros, votos]) => {
      const votaram = new Set((votos.data || []).map((v) => v.de_user_id));
      const naoVotaramIds = (membros.data || []).map((m) => m.user_id).filter((id) => !votaram.has(id));
      return enviarNotificacao(naoVotaramIds, {
        title: '⭐ Actualize a sua nota',
        body: 'O admin pediu que actualizem as notas',
        url: `/equipa/${team.slug}/ranking`,
      });
    });
  })
);

/** DELETE /api/teams/:slug/votos/:userId — zera votos RECEBIDOS por um jogador (admin). */
router.delete(
  '/api/teams/:slug/votos/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem zerar votos.');

    const { count } = await supabase
      .from('votes')
      .select('id', { count: 'exact', head: true })
      .eq('team_id', team.id)
      .eq('para_user_id', req.params.userId);
    const { error } = await supabase.from('votes').delete().eq('team_id', team.id).eq('para_user_id', req.params.userId);
    if (error) throw new HttpError(500, error.message);
    res.json({ deleted: true, count: count || 0 });
  })
);

/** DELETE /api/teams/:slug/votos — zera TODOS os votos da equipa (admin). */
router.delete(
  '/api/teams/:slug/votos',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem zerar votos.');

    const { count } = await supabase.from('votes').select('id', { count: 'exact', head: true }).eq('team_id', team.id);
    const { error } = await supabase.from('votes').delete().eq('team_id', team.id);
    if (error) throw new HttpError(500, error.message);
    res.json({ deleted: true, count: count || 0 });
  })
);

module.exports = router;
