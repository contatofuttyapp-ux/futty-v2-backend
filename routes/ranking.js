// Futty v2.0 — Ranking + perfil + votação (modelo definitivo).
// 1 voto por (votante, votado, equipa), permanente/atualizável, meias estrelas.
// Sem jogo de votação, sem períodos. Nota exibida em escala 6-10.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, requireTeamMember, ensureUserRow } = require('../utils/db');
const { agregadosDaEquipa } = require('../utils/agregados');
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
  // Membros (+ categoria). RANKING VIVO: os agregados gols/vitórias/artilharia/destaque
  // JÁ NÃO se leem de team_members (colunas legado, seed de testes, nunca alimentadas) —
  // são calculados na hora a partir da FONTE (gols_jogadores + resultados + artilheiro/
  // destaque), mais abaixo. Zero drift, zero DDL, sempre verdadeiro.
  const { data: membros } = await supabase
    .from('team_members')
    .select('user_id, categoria, visivel_ranking, ativo, users ( id, nome, nome_jogador, email, avatar_url, foto_url, cor_frame )')
    .eq('team_id', teamId);
  // Só membros visíveis (admin pode ocultar) e activos. Default visível/activo.
  const rows = (membros || []).filter((m) => m.users && m.visivel_ranking !== false && m.ativo !== false);

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

  // ── RANKING VIVO — os 4 eixos calculados da FONTE (helper partilhado; uma verdade). ──
  const { golsMap, vitoriasMap, artilhariaMap, destaquesMap, gameIds } = await agregadosDaEquipa(teamId);

  // Jogos TOTAIS por jogador (all-time, confirmados) — base dos RÁCIOS por jogo e da
  // FIDELIDADE. (Ranking v2: tudo por jogo, sem janela de 30 dias.)
  const jogosMap = {};
  if (gameIds.length) {
    const { data: gps } = await supabase.from('game_players').select('user_id').in('game_id', gameIds).eq('confirmado', true);
    for (const gp of gps || []) jogosMap[gp.user_id] = (jogosMap[gp.user_id] || 0) + 1;
  }

  // ── RANKING v2 — TUDO por jogo, mín. 3 jogos para entrar. Cada eixo NORMALIZADO
  // (0..1) antes de ponderar → os pesos são verdade. Rácios por jogo (não totais) →
  // o veterano não "acumula" vantagem; a fidelidade (jogos totais) SATURA aos 30. ──
  const MIN_JOGOS = 3;
  const elig = rows.map((m) => {
    const u = m.users;
    const a = agg[u.id];
    const total = a ? a.count : 0;
    const notaInterna = total >= MIN_VOTOS ? a.sum / a.count : null;
    const jogos = jogosMap[u.id] || 0;
    const vitorias = vitoriasMap[u.id] || 0;
    const gols = golsMap[u.id] || 0;
    const artilharia = artilhariaMap[u.id] || 0;
    const destaques = destaquesMap[u.id] || 0;
    return {
      u, m, total, notaInterna, jogos, vitorias, gols, artilharia, destaques,
      ehGR: m.categoria === 'GR',
      nota: notaInterna || 0, // 0 se ainda sem 3 votos (não pontua no eixo nota)
      winrate: jogos ? vitorias / jogos : 0,
      golosJogo: jogos ? gols / jogos : 0,
      artJogo: jogos ? artilharia / jogos : 0,
      destJogo: jogos ? destaques / jogos : 0,
      fidelidade: Math.min(jogos, 30) / 30, // satura aos 30 — 200 não supera 30
    };
  }).filter((p) => p.jogos >= MIN_JOGOS);

  // Normalização por eixo (÷ máximo da equipa nesse eixo). Fidelidade já é 0..1 absoluto.
  const maxDe = (f) => Math.max(1e-9, ...elig.map(f));
  const mNota = maxDe((p) => p.nota); const mWin = maxDe((p) => p.winrate);
  const mGol = maxDe((p) => p.golosJogo); const mArt = maxDe((p) => p.artJogo); const mDest = maxDe((p) => p.destJogo);

  const base = elig.map((p) => {
    const u = p.u;
    const notaN = p.nota / mNota; const winN = p.winrate / mWin;
    const golN = p.golosJogo / mGol; const artN = p.artJogo / mArt; const destN = p.destJogo / mDest;
    // Pesos que somam 1 (os "verdade" pedidos): linha 25/25/20/10/10/10 · GR 25/35/25/15.
    const score = p.ehGR
      ? notaN * 0.25 + winN * 0.35 + destN * 0.25 + p.fidelidade * 0.15
      : notaN * 0.25 + winN * 0.25 + golN * 0.20 + artN * 0.10 + destN * 0.10 + p.fidelidade * 0.10;
    return {
      user_id: u.id,
      sou_eu: meUserId != null && u.id === meUserId,
      nome: u.nome || 'Jogador',
      nome_jogador: u.nome_jogador || null,
      avatar_url: u.avatar_url || null,
      foto_url: u.foto_url || null,
      cor_frame: u.cor_frame || 'dourado',
      categoria: p.ehGR ? 'GR' : 'linha',
      nota: notaParaExibir(p.notaInterna),
      nota_interna: p.notaInterna,
      total_votos: p.total,
      minha_nota: minhaNota[u.id] ?? null,
      vitorias: p.vitorias,
      gols: p.gols,
      artilharia: p.artilharia,
      destaques: p.destaques,
      presenca: p.jogos, // agora = jogos TOTAIS
      score: round2(score * 100), // 0..100 legível
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
    if (!jogador) throw new HttpError(404, 'Jogador não encontrado neste time.');

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

    const userId = req.params.userId;

    // Logo/cor de fundo da equipa (não vêm do requireTeamMember).
    const { data: teamExtra } = await supabase
      .from('teams')
      .select('logo_url, cor_fundo, mostrar_gols')
      .eq('id', team.id)
      .maybeSingle();
    const mostrarGols = teamExtra?.mostrar_gols !== false; // default TRUE
    // Flag OFF (equipa casual): gols+artilharia saem do radar → o polígono adapta-se
    // (5→3 eixos no front). O tile de Gols e a conquista de Artilheiro escondem-se no
    // front via team.mostrar_gols.
    if (!mostrarGols) { radar.gols = null; radar.artilharia = null; }

    // Jogos da equipa (com campos de resultado) + participações do jogador.
    const { data: teamGames } = await supabase
      .from('games')
      .select('id, data, status, cancelado, times_resultado, campeao_time_index, artilheiro_user_id, destaque_user_id, rodada_user_id')
      .eq('team_id', team.id);
    const games = teamGames || [];
    const gameIds = games.map((g) => g.id);

    const gameById = Object.fromEntries(games.map((g) => [g.id, g]));
    const agora = Date.now();
    const partSet = new Set();
    let jogosConfirmados = 0;
    if (gameIds.length) {
      const { data: parts } = await supabase
        .from('game_players')
        .select('game_id, confirmado')
        .eq('user_id', userId)
        .in('game_id', gameIds);
      for (const p of parts || []) {
        partSet.add(p.game_id);
        // Achado 10: só conta jogos já ENCERRADOS — presença num jogo futuro não
        // infla a estatística "jogos".
        const g = gameById[p.game_id];
        const cancelado = !!g?.cancelado || g?.status === 'cancelado';
        const encerrado = !!g && !cancelado && (g.status === 'terminado' || (!!g.data && new Date(g.data).getTime() <= agora));
        if (p.confirmado && encerrado) jogosConfirmados += 1;
      }
    }

    const noTimeCampeao = (g) => {
      if (g.campeao_time_index == null) return false;
      const t = g.times_resultado?.times?.[g.campeao_time_index];
      return !!t && Array.isArray(t.jogadores) && t.jogadores.some((j) => j.user_id === userId);
    };
    // Sem campeão definido → 'empate' (resultado neutro).
    const resultadoDe = (g) => (g.campeao_time_index == null ? 'empate' : noTimeCampeao(g) ? 'vitoria' : 'derrota');

    // Conquistas (carreira — todos os jogos da equipa).
    const conquistas = {
      campeao: games.filter((g) => noTimeCampeao(g)).length,
      artilheiro: games.filter((g) => g.artilheiro_user_id === userId).length,
      destaque: games.filter((g) => g.destaque_user_id === userId).length,
      rodada: games.filter((g) => g.rodada_user_id === userId).length,
      jogos_total: jogosConfirmados,
      gols_total: jogador.gols || 0,
      vitorias_total: jogador.vitorias || 0,
    };

    // Histórico: últimos 10 jogos em que participou (não cancelados), data DESC.
    const historico = games
      .filter((g) => partSet.has(g.id) && g.status !== 'cancelado')
      .sort((a, b) => new Date(b.data) - new Date(a.data))
      .slice(0, 10)
      .map((g) => ({
        game_id: g.id,
        data: g.data,
        status: g.status,
        resultado: resultadoDe(g),
        foi_artilheiro: g.artilheiro_user_id === userId,
        foi_destaque: g.destaque_user_id === userId,
        foi_rodada: g.rodada_user_id === userId,
      }));

    // Evolução: média progressiva dos votos recebidos (escala exibida via notaParaExibir).
    const { data: votosRecebidos } = await supabase
      .from('votes')
      .select('nota, updated_at, created_at')
      .eq('team_id', team.id)
      .eq('para_user_id', userId);
    const ordenados = (votosRecebidos || [])
      .map((v) => ({ ts: v.updated_at || v.created_at, nota: Number(v.nota) }))
      .filter((v) => v.ts && Number.isFinite(v.nota))
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));
    let soma = 0;
    const evolucao = ordenados.map((v, i) => {
      soma += v.nota;
      return { data: v.ts, nota: notaParaExibir(soma / (i + 1)) };
    });

    // Escudos: equipas em comum entre o visitante e o jogador (viewer ∩ jogador).
    // O acesso a este perfil já exige ser membro de :slug (requireTeamMember), por isso
    // a actividade mostrada é a desta equipa — quem não partilha equipa nem chega aqui.
    const { data: minhasEquipas } = await supabase.from('team_members').select('team_id').eq('user_id', req.user.id);
    const { data: equipasDele } = await supabase.from('team_members').select('team_id').eq('user_id', userId);
    const meusIds = new Set((minhasEquipas || []).map((m) => m.team_id));
    const partilhadasIds = [...new Set((equipasDele || []).map((m) => m.team_id).filter((id) => meusIds.has(id)))];
    let equipas_partilhadas = [];
    if (partilhadasIds.length) {
      const { data: eqs } = await supabase.from('teams').select('id, nome, slug, cor').in('id', partilhadasIds);
      equipas_partilhadas = eqs || [];
    }

    // Actividade social: posts do jogador NAS equipas partilhadas (+ fotos + nº comentários).
    let atividade = [];
    if (partilhadasIds.length) {
      const { data: posts } = await supabase
        .from('feed_posts')
        .select('id, team_id, body, created_at')
        .eq('author_id', userId)
        .in('team_id', partilhadasIds)
        .order('created_at', { ascending: false })
        .limit(5);
      const postIds = (posts || []).map((p) => p.id);
      const mediaByPost = {};
      const comCount = {};
      if (postIds.length) {
        const { data: media } = await supabase.from('feed_post_media').select('post_id, url, media_type, position').in('post_id', postIds);
        for (const m of media || []) (mediaByPost[m.post_id] ||= []).push(m);
        const { data: coms } = await supabase.from('comentarios').select('parent_id').eq('parent_type', 'post').in('parent_id', postIds).is('deleted_at', null);
        for (const c of coms || []) comCount[c.parent_id] = (comCount[c.parent_id] || 0) + 1;
      }
      const nomeEq = Object.fromEntries(equipas_partilhadas.map((e) => [e.id, e.nome]));
      atividade = (posts || []).map((p) => ({
        id: p.id,
        team_nome: nomeEq[p.team_id] || null,
        body: p.body,
        created_at: p.created_at,
        media: (mediaByPost[p.id] || []).sort((a, b) => a.position - b.position).map((m) => ({ url: m.url, media_type: m.media_type })),
        comentarios_total: comCount[p.id] || 0,
      }));
    }

    res.json({
      team: { ...team, ...(teamExtra || {}), role },
      jogador: { ...jogador, posicao, total_com_nota: comNota.length },
      radar,
      jogos_campeao,
      conquistas,
      historico,
      evolucao,
      equipas_partilhadas,
      atividade,
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

/**
 * GET /api/me/votacoes-pendentes — (P1-3) agrega, em TODAS as equipas do
 * utilizador, onde ainda há avaliações por dar. Alimenta o banner do Início —
 * a votação deixa de ser invisível fora do Ranking.
 * { pendentes: [{ slug, nome, faltam, pedido_revotacao }] } (só as com trabalho).
 */
router.get(
  '/api/me/votacoes-pendentes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const { data: minhas } = await supabase.from('team_members').select('team_id').eq('user_id', uid);
    const teamIds = [...new Set((minhas || []).map((m) => m.team_id))];
    if (!teamIds.length) return res.json({ pendentes: [] });

    const { data: teams } = await supabase
      .from('teams')
      .select('id, slug, nome, revotar_pedido_em')
      .in('id', teamIds);
    const { data: votos } = await supabase
      .from('votes')
      .select('team_id, para_user_id, updated_at')
      .eq('de_user_id', uid)
      .in('team_id', teamIds);

    // Achado 21: só pede avaliação de quem o usuário REALMENTE jogou junto — jogos
    // já ENCERRADOS em que ambos estiveram confirmados. "Todo mundo do time" incluía
    // gente que ele nunca viu em campo (ou o próprio usuário sem jogo nenhum ainda).
    const { data: jogosDasEquipas } = await supabase
      .from('games')
      .select('id, team_id, data, status, cancelado')
      .in('team_id', teamIds);
    const agora = Date.now();
    const teamIdByGame = {};
    const encerradoIds = [];
    for (const g of jogosDasEquipas || []) {
      teamIdByGame[g.id] = g.team_id;
      const cancelado = !!g.cancelado || g.status === 'cancelado';
      const encerrado = !cancelado && (g.status === 'terminado' || (!!g.data && new Date(g.data).getTime() <= agora));
      if (encerrado) encerradoIds.push(g.id);
    }
    const { data: minhasPresencas } = encerradoIds.length
      ? await supabase.from('game_players').select('game_id').eq('user_id', uid).eq('confirmado', true).in('game_id', encerradoIds)
      : { data: [] };
    const meusGameIds = [...new Set((minhasPresencas || []).map((p) => p.game_id))];
    const { data: colegasPresencas } = meusGameIds.length
      ? await supabase.from('game_players').select('game_id, user_id').eq('confirmado', true).in('game_id', meusGameIds)
      : { data: [] };
    const colegasPorTeam = {}; // team_id -> Set(user_id) de quem jogou junto
    for (const p of colegasPresencas || []) {
      if (p.user_id === uid) continue;
      const tid = teamIdByGame[p.game_id];
      if (!tid) continue;
      (colegasPorTeam[tid] = colegasPorTeam[tid] || new Set()).add(p.user_id);
    }

    const pendentes = [];
    for (const t of teams || []) {
      const elegiveis = colegasPorTeam[t.id] || new Set();
      const total = elegiveis.size;
      const meus = (votos || []).filter((v) => v.team_id === t.id && elegiveis.has(v.para_user_id));
      const votados = new Set(meus.map((v) => v.para_user_id)).size;
      const faltam = Math.max(0, total - votados);
      const maxUpdated = meus.reduce((mx, v) => Math.max(mx, v.updated_at ? new Date(v.updated_at).getTime() : 0), 0);
      const pedidoEm = t.revotar_pedido_em ? new Date(t.revotar_pedido_em).getTime() : 0;
      const pedido_revotacao = total > 0 && pedidoEm > 0 && pedidoEm > maxUpdated;
      if (total > 0 && (faltam > 0 || pedido_revotacao)) {
        pendentes.push({ slug: t.slug, nome: t.nome, faltam, pedido_revotacao });
      }
    }
    // Mais urgente primeiro: pedido de revotação do admin, depois mais faltas.
    pendentes.sort((a, b) => (b.pedido_revotacao - a.pedido_revotacao) || (b.faltam - a.faltam));
    res.json({ pendentes });
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
    if (paraUserId === req.user.id) throw new HttpError(400, 'Não pode votar em você mesmo.');
    if (!notaValida(nota)) throw new HttpError(400, 'A nota deve ser entre 0.5 e 5 (incrementos de 0.5).');

    // O votado tem de ser membro da equipa (visível no ranking).
    const { data: alvo } = await supabase
      .from('team_members')
      .select('id')
      .eq('team_id', team.id)
      .eq('user_id', paraUserId)
      .maybeSingle();
    if (!alvo) throw new HttpError(400, 'Esse jogador não é membro deste time.');

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
        title: '⭐ Atualize a sua nota',
        body: 'O admin pediu que atualizem as notas',
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
module.exports.buildRanking = buildRanking;
