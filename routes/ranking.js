// Futty v2.0 — Ranking + perfil + votação (modelo definitivo).
// 1 voto por (votante, votado, time), permanente/atualizável, meias estrelas.
// Sem jogo de votação, sem períodos. Nota exibida em escala 6-10.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { marcarFase, medir } = require('../middleware/tempo');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, requireTeamMember, getTeamBySlug, getRole, ensureUserRow } = require('../utils/db');
const { obterVotacaoStatus, obterVotacoesPendentes } = require('../services/inicio');
const { agregadosDaEquipa, COLUNAS_JOGOS } = require('../utils/agregados');
const selosCache = require('../utils/selosCache');
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
 * Constrói o ranking do time (score ponderado, separado por categoria).
 * @param {object} [opts]
 * @param {Promise} [opts.jogosPromessa] leitura de `games` deste time já em voo
 *   (tem de trazer COLUNAS_JOGOS) — quem também precisa dos jogos partilha a sua
 *   em vez de mandar ler a mesma tabela outra vez.
 * @returns {Promise<object[]>} ranking ordenado por score DESC com posicao.
 */
async function buildRanking(teamId, meUserId, { jogosPromessa } = {}) {
  // Membros, votos e jogos só dependem de teamId — nenhum depende do resultado
  // dos outros (13-set, "Velocidade 3": eram 3 awaits em série).
  const [{ data: membros }, { data: votos }, { data: jogos }] = await Promise.all([
    // Membros (+ categoria). RANKING VIVO: os agregados gols/vitórias/artilharia/destaque
    // JÁ NÃO se leem de team_members (colunas legado, seed de testes, nunca alimentadas) —
    // são calculados na hora a partir da FONTE (gols_jogadores + resultados + artilheiro/
    // destaque), mais abaixo. Zero drift, zero DDL, sempre verdadeiro.
    supabase
      .from('team_members')
      .select('user_id, categoria, visivel_ranking, ativo, users ( id, nome, nome_jogador, email, avatar_url, foto_url, avatar_generico, cor_frame )')
      .eq('team_id', teamId),
    // Votos do time (todos) — média + o meu voto por jogador.
    supabase.from('votes').select('para_user_id, de_user_id, nota').eq('team_id', teamId),
    jogosPromessa || supabase.from('games').select(COLUNAS_JOGOS).eq('team_id', teamId),
  ]);
  const gameIds = (jogos || []).map((g) => g.id);

  // FLUIDEZ 2 (16-set): os golos (dentro dos agregados) e os jogos por jogador só
  // precisam dos gameIds — eram duas idas em série, agora saem juntas.
  const [{ golsMap, vitoriasMap, artilhariaMap, destaquesMap }, { data: gps }] = await Promise.all([
    // ── RANKING VIVO — os 4 eixos calculados da FONTE (helper partilhado; uma verdade). ──
    agregadosDaEquipa(teamId, { jogos: jogos || [] }),
    // Jogos TOTAIS por jogador (all-time, confirmados) — base dos RÁCIOS por jogo e da
    // FIDELIDADE. (Ranking v2: tudo por jogo, sem janela de 30 dias.)
    gameIds.length
      ? supabase.from('game_players').select('user_id').in('game_id', gameIds).eq('confirmado', true)
      : { data: [] },
  ]);
  const jogosMap = {};
  for (const gp of gps || []) jogosMap[gp.user_id] = (jogosMap[gp.user_id] || 0) + 1;

  // Só membros visíveis (admin pode ocultar) e activos. Default visível/activo.
  const rows = (membros || []).filter((m) => m.users && m.visivel_ranking !== false && m.ativo !== false);

  const agg = {};
  const minhaNota = {};
  for (const v of votos || []) {
    if (!agg[v.para_user_id]) agg[v.para_user_id] = { sum: 0, count: 0 };
    agg[v.para_user_id].sum += Number(v.nota);
    agg[v.para_user_id].count += 1;
    if (meUserId && v.de_user_id === meUserId) minhaNota[v.para_user_id] = Number(v.nota);
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

  // Normalização por eixo (÷ máximo do time nesse eixo). Fidelidade já é 0..1 absoluto.
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
      // Sem foto nem figurinha, a linha mostra o genérico que a pessoa ESCOLHEU (o mesmo da Presença e do
      // Início), não uma silhueta "?": Rodada 27.
      avatar_generico: u.avatar_generico || null,
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
    marcarFase(res, 'auth');
    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    marcarFase(res, 'time');
    const ranking = await buildRanking(team.id, req.user.id);
    marcarFase(res, 'ranking');
    res.json({ team: { ...team, role }, ranking });
  })
);

/** GET /api/teams/:slug/jogador/:userId — perfil completo do jogador.
 *
 * FLUIDEZ 2 (16-set): eram 18 consultas em 16 ondas EM SÉRIE — 1216 ms no iPhone,
 * 644 ms só de motor. Ficam 16 consultas em 4 ondas, e cada onda tem a sua fase no
 * Server-Timing (a rota não marcava fase nenhuma: o tempo do motor era opaco).
 * O corpo do JSON é o MESMO byte a byte — provado em scripts/bench-jogador-identico.js. */
router.get(
  '/api/teams/:slug/jogador/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    marcarFase(res, 'auth');
    const userId = req.params.userId;

    // ── ONDA 1 — só o slug se conhece; o team.id abre todo o resto.
    // O select traz JÁ logo_url/cor_fundo/mostrar_gols, que eram uma SEGUNDA leitura
    // da mesma linha de `teams`. A ordem das colunas é a ordem das chaves do `team:`
    // na resposta (o PostgREST devolve pela ordem do select) — não mexer sem olhar
    // para o JSON.
    const team = await getTeamBySlug(req.params.slug, 'id, slug, nome, cor, logo_url, cor_fundo, mostrar_gols');
    if (!team) throw new HttpError(404, 'Time não encontrado.');
    marcarFase(res, 'time');

    // ── ONDA 2 — tudo o que só depende do team.id (e de quem pede).
    // Os jogos do time servem o histórico DAQUI e os agregados do ranking: uma
    // leitura só, partilhada. O construtor do PostgREST dispara uma consulta nova a
    // cada `.then`, por isso vira promessa de verdade antes de ser passada adiante.
    const jogosP = Promise.resolve(
      supabase
        .from('games')
        .select(`${COLUNAS_JOGOS}, data, status, cancelado, campeao_time_index, rodada_user_id`)
        .eq('team_id', team.id)
    );
    // O ranking atravessa as ondas 2 e 3 (é a parte mais pesada) — daí a medida própria.
    const rankingP = medir(res, 'ranking', buildRanking(team.id, req.user.id, { jogosPromessa: jogosP }));
    rankingP.catch(() => {}); // se a onda 2 sair por 403, ninguém fica com a rejeição na mão

    const [role, { data: fotos }, { data: votosRecebidos }, { data: minhasEquipas }, { data: equipasDele }, { data: teamGames }] = await Promise.all([
      getRole(team.id, req.user.id),
      supabase
        .from('champion_photos')
        .select('*')
        .eq('team_id', team.id)
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),
      // Evolução: média progressiva dos votos recebidos (escala exibida via notaParaExibir).
      // Estes votos também estão nos votos do time que o buildRanking lê, mas aproveitar
      // aqueles mudaria a ORDEM dos empates de data (a ordenação é estável) e com ela a
      // curva — os votos semeados de uma vez partilham o mesmo instante. Fica consulta própria.
      supabase.from('votes').select('nota, updated_at, created_at').eq('team_id', team.id).eq('para_user_id', userId),
      // Escudos: times em comum entre o visitante e o jogador (viewer ∩ jogador).
      // O acesso a este perfil já exige ser membro de :slug, por isso a atividade
      // mostrada é a deste time — quem não partilha time nem chega aqui. Duas
      // consultas e não uma com `.in('user_id', [...])`: assim a ordem dos ids de
      // `partilhadasIds` é a mesma de antes, e com ela a ordem de equipas_partilhadas.
      supabase.from('team_members').select('team_id').eq('user_id', req.user.id),
      supabase.from('team_members').select('team_id').eq('user_id', userId),
      jogosP,
    ]);
    if (!role) throw new HttpError(403, 'Você não é membro deste time.');
    marcarFase(res, 'onda2');

    const games = teamGames || [];
    const gameIds = games.map((g) => g.id);
    const meusIds = new Set((minhasEquipas || []).map((m) => m.team_id));
    const partilhadasIds = [...new Set((equipasDele || []).map((m) => m.team_id).filter((id) => meusIds.has(id)))];

    // ── ONDA 3 — precisa dos gameIds e dos times partilhados (onda 2). O ranking
    // acaba aqui: arrancou na onda 2 e ainda lhe faltava uma ida (golos + presenças).
    const [ranking, { data: parts }, { data: eqs }, { data: posts }] = await Promise.all([
      rankingP,
      // Participações do jogador nos jogos do time.
      gameIds.length
        ? supabase.from('game_players').select('game_id, confirmado').eq('user_id', userId).in('game_id', gameIds)
        : { data: [] },
      partilhadasIds.length
        ? supabase.from('teams').select('id, nome, slug, cor').in('id', partilhadasIds)
        : { data: [] },
      // Atividade social: posts do jogador NOS times partilhados.
      partilhadasIds.length
        ? supabase
          .from('feed_posts')
          .select('id, team_id, body, created_at')
          .eq('author_id', userId)
          .in('team_id', partilhadasIds)
          .order('created_at', { ascending: false })
          .limit(5)
        : { data: [] },
    ]);
    marcarFase(res, 'onda3');

    const jogador = ranking.find((r) => r.user_id === userId);
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

    const jogos_campeao = (fotos || []).map((f) => ({ foto: f.url, tipo: f.tipo || 'vitoria' }));

    const mostrarGols = team.mostrar_gols !== false; // default TRUE
    // Flag OFF (time casual): gols+artilharia saem do radar → o polígono adapta-se
    // (5→3 eixos no front). O tile de Gols e a conquista de Artilheiro escondem-se no
    // front via team.mostrar_gols.
    if (!mostrarGols) { radar.gols = null; radar.artilharia = null; }

    const gameById = Object.fromEntries(games.map((g) => [g.id, g]));
    const agora = Date.now();
    const partSet = new Set();
    let jogosConfirmados = 0;
    for (const p of parts || []) {
      partSet.add(p.game_id);
      // Achado 10: só conta jogos já ENCERRADOS — presença num jogo futuro não
      // infla a estatística "jogos".
      const g = gameById[p.game_id];
      const cancelado = !!g?.cancelado || g?.status === 'cancelado';
      const encerrado = !!g && !cancelado && (g.status === 'terminado' || (!!g.data && new Date(g.data).getTime() <= agora));
      if (p.confirmado && encerrado) jogosConfirmados += 1;
    }

    const noTimeCampeao = (g) => {
      if (g.campeao_time_index == null) return false;
      const t = g.times_resultado?.times?.[g.campeao_time_index];
      return !!t && Array.isArray(t.jogadores) && t.jogadores.some((j) => j.user_id === userId);
    };
    // Sem campeão definido → 'empate' (resultado neutro).
    const resultadoDe = (g) => (g.campeao_time_index == null ? 'empate' : noTimeCampeao(g) ? 'vitoria' : 'derrota');

    // Conquistas (carreira — todos os jogos do time).
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

    const ordenados = (votosRecebidos || [])
      .map((v) => ({ ts: v.updated_at || v.created_at, nota: Number(v.nota) }))
      .filter((v) => v.ts && Number.isFinite(v.nota))
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));
    let soma = 0;
    const evolucao = ordenados.map((v, i) => {
      soma += v.nota;
      return { data: v.ts, nota: notaParaExibir(soma / (i + 1)) };
    });

    const equipas_partilhadas = partilhadasIds.length ? (eqs || []) : [];

    // ── ONDA 4 — fotos e comentários dos posts; só os postIds (onda 3) as abrem.
    const postIds = (posts || []).map((p) => p.id);
    const mediaByPost = {};
    const comCount = {};
    if (postIds.length) {
      const [{ data: media }, { data: coms }] = await Promise.all([
        supabase.from('feed_post_media').select('post_id, url, media_type, position').in('post_id', postIds),
        supabase.from('comentarios').select('parent_id').eq('parent_type', 'post').in('parent_id', postIds).is('deleted_at', null),
      ]);
      for (const m of media || []) (mediaByPost[m.post_id] ||= []).push(m);
      for (const c of coms || []) comCount[c.parent_id] = (comCount[c.parent_id] || 0) + 1;
    }
    marcarFase(res, 'onda4');

    let atividade = [];
    if (partilhadasIds.length) {
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
      team: { ...team, role },
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
 * GET /api/teams/:slug/votacao-status — progresso de votação do usuário.
 * { total, votados, faltam, pedido_revotacao }
 */
// Lógica em services/inicio.js#obterVotacaoStatus — a MESMA função que GET
// /api/inicio usa, para o JSON nunca divergir entre as duas rotas.
router.get(
  '/api/teams/:slug/votacao-status',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await obterVotacaoStatus(req.params.slug, req.user.id));
  })
);

/**
 * GET /api/me/votacoes-pendentes — (P1-3) agrega, em TODOS os times do
 * usuário, onde ainda há avaliações por dar. Alimenta o banner do Início —
 * a votação deixa de ser invisível fora do Ranking.
 * { pendentes: [{ slug, nome, faltam, pedido_revotacao }] } (só as com trabalho).
 */
// Lógica em services/inicio.js#obterVotacoesPendentes — a MESMA função que GET
// /api/inicio usa, para o JSON nunca divergir entre as duas rotas.
router.get(
  '/api/me/votacoes-pendentes',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await obterVotacoesPendentes(req.user.id));
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

    // O votado tem de ser membro do time (visível no ranking).
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
    selosCache.invalidarEquipa(team.id); // a nota mexe no ranking → selo "RANKING 1º"

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
    selosCache.invalidarEquipa(team.id);
    res.json({ deleted: true, count: count || 0 });
  })
);

/** DELETE /api/teams/:slug/votos — zera TODOS os votos do time (admin). */
router.delete(
  '/api/teams/:slug/votos',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem zerar votos.');

    const { count } = await supabase.from('votes').select('id', { count: 'exact', head: true }).eq('team_id', team.id);
    const { error } = await supabase.from('votes').delete().eq('team_id', team.id);
    if (error) throw new HttpError(500, error.message);
    selosCache.invalidarEquipa(team.id);
    res.json({ deleted: true, count: count || 0 });
  })
);

module.exports = router;
module.exports.buildRanking = buildRanking;
