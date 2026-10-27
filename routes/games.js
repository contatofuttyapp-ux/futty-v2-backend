// Futty v2.0 — Rotas de jogos: criar, listar, detalhe, resultado, presença, editar, cancelar e recorrentes. O sorteio compartilhado
// (jogoPublico), os times (sorteioDoJogo) e o "Associar jogador" (associarJogador) vivem em sub-roteadores montados aqui.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError, foraDoTime } = require('../utils/http');
const { supabase, getTeamBySlug, getRole, ensureUserRow, loadGame, computeRatings } = require('../utils/db');
const { jogadoresPorTimeDoTime } = require('../utils/jogadoresPorTime'); // o padrão do time
const { obterConvites } = require('../services/inicio');
const { RATING_DEFAULT } = require('../utils/helpers');
const { comAvataresAtuais } = require('../utils/avataresDoSorteio');
const { mapaDeNomesPublicos, comNomesPublicos } = require('../utils/nomePublico');
const { enviarNotificacao } = require('./push');
const { soOrganiza, idsQueSoOrganizam, MSG_SO_ORGANIZA } = require('../utils/soOrganiza');
const { fusoDoTime, dataCurtaNoFuso, partesNoFuso, instanteNoFuso } = require('../utils/fuso');
const { quantosTimes, escolhaDoCorpo, linhasDeGols, somaDeGols, placarDoCorpo, decidirResultado, resultadoJaAbriu } = require('../utils/resultadoDoJogo'); // quem ganhou: uma verdade só
const { anunciarResultado } = require('../utils/avisoDoResultado');
const { estadoDoJogo } = require('../utils/estadoDoJogo'); // o estado do jogo: uma regra só
const { textoCurto, ehUuid } = require('../utils/entrada'); // o que a pessoa digita: texto com teto, número em faixa
const { round1 } = require('../utils/ajudaDoJogo');
const { convidadosGuardados } = require('../utils/convidadosDoJogo'); // a lista de convidados sem app do jogo
const { sorteioPadrao, sorteioDoJogo, sorteioEscolhido, sorteioAoMudarOJogo, listaAberta, chamadosDoJogo, foiChamado } = require('../utils/chamadaDoJogo');
const { erroDaChamada, semColunasDaChamada, lerComChamada } = require('../utils/colunasDaChamada');
const { avisarJogo } = require('../utils/avisosDoJogo');
const { responderPresenca } = require('./rsvp');

const router = express.Router();

const MSG_RESULTADO_FECHADO = 'O resultado abre 5 minutos depois do início do jogo.';
// O sorteio faz no máximo 28 jogadores em 4 times; um "jogadores por time" acima de 30 não existe.
const MAX_JOGADORES_POR_TIME = 30;

// Estado efetivo do jogo: a regra única em utils/estadoDoJogo.js (agendado · em curso · terminado · cancelado).
// Calculado a cada leitura, não depende de um write acertar a hora certa, nem de o sorteio ter sido feito cedo.
const statusEfetivoJogo = (game) => estadoDoJogo(game);

// Data curta (ex.: "12/06 · 20:30") para o corpo das notificações — no relógio do CAMPO (fuso do
// time), não no do servidor (o Cloud Run roda em UTC: "20:30" de São Paulo saía como "23:30").

/** IDs dos membros de um time (para notificações). */
async function membrosDaEquipa(teamId) {
  const { data } = await supabase.from('team_members').select('user_id').eq('team_id', teamId);
  return (data || []).map((m) => m.user_id);
}

/** POST /api/games — cria um jogo (só admin do time). */
router.post(
  '/api/games',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team_slug: teamSlug, data, local, jogadores_por_time: jogadoresPorTime, historico, sorteio_em: sorteioPedido, chamados: chamadosPedido } = req.body || {};
    if (!teamSlug || !data) throw new HttpError(400, 'Time e data são obrigatórios.');

    const team = await getTeamBySlug(teamSlug, 'id, slug, nome');
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    // Sem número no pedido, o jogo nasce com o padrão do time (Ajustes); com número, é o "mudar só neste jogo".
    const porTime = jogadoresPorTime == null || jogadoresPorTime === '' ? jogadoresPorTimeDoTime(team) : parseInt(jogadoresPorTime, 10);
    if (!porTime || porTime < 1) throw new HttpError(400, 'Indique quantos jogadores por time.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem criar jogos.');

    // O que o admin digitou, conferido antes de gravar: data que existe, local com teto, jogadores por time em faixa.
    if (typeof data !== 'string' && typeof data !== 'number') throw new HttpError(400, 'Data inválida.');
    const quando = new Date(data);
    if (Number.isNaN(quando.getTime())) throw new HttpError(400, 'Data inválida.');
    const localTexto = textoCurto(local, 120, 'Local');
    if (porTime > MAX_JOGADORES_POR_TIME) throw new HttpError(400, `Jogadores por time: use um número de 1 a ${MAX_JOGADORES_POR_TIME}.`);

    // LEI (jogo histórico/retroativo): carregamento de dados — NÃO notifica ninguém.
    const eHistorico = historico === true;

    // A chamada (utils/chamadaDoJogo.js): a hora do sorteio (sem ela, 1 h antes do jogo) e quem é chamado (sem lista, todo o elenco).
    let sorteioEm = null;
    let chamados = null;
    if (!eHistorico) {
      if (sorteioPedido != null && sorteioPedido !== '') {
        const s = sorteioEscolhido(sorteioPedido, quando.toISOString());
        if (s.erro) throw new HttpError(400, s.erro);
        sorteioEm = s.iso;
      } else {
        sorteioEm = sorteioPadrao(quando.toISOString());
      }
      if (chamadosPedido != null) {
        if (!Array.isArray(chamadosPedido) || chamadosPedido.some((id) => !ehUuid(id))) throw new HttpError(400, 'Lista de chamados inválida.');
        const [elenco, organizam] = await Promise.all([membrosDaEquipa(team.id), idsQueSoOrganizam(team.id)]);
        const quemJoga = elenco.filter((id) => !organizam.has(id));
        const escolhidos = [...new Set(chamadosPedido)].filter((id) => quemJoga.includes(id));
        if (!escolhidos.length) throw new HttpError(400, 'Escolha pelo menos uma pessoa para chamar.');
        // Escolheu todo mundo que joga = o elenco inteiro (quem entrar depois também é chamado).
        chamados = escolhidos.length === quemJoga.length ? null : escolhidos;
      }
    }

    // num_times fica por definir; é calculado no sorteio conforme os confirmados.
    const linha = {
      team_id: team.id,
      data: quando.toISOString(),
      local: localTexto || null,
      jogadores_por_time: porTime,
      ...(sorteioEm ? { sorteio_em: sorteioEm } : {}),
      ...(chamados ? { chamados } : {}),
    };
    if (eHistorico) linha.historico = true; // coluna opcional (migração à mão); ver nota abaixo
    let insert = await supabase.from('games').insert(linha).select().single();
    // Resiliência: colunas que ainda não existem no banco (`historico`; `sorteio_em`/`chamados` antes da 089) — repete sem elas.
    if (insert.error && erroDaChamada(insert.error)) {
      if (chamados) throw new HttpError(503, 'Escolher quem chamar ainda não está disponível. Chame o elenco inteiro.', 'CHAMADA_INDISPONIVEL');
      insert = await supabase.from('games').insert(semColunasDaChamada(linha)).select().single();
    }
    if (insert.error && eHistorico && /historico/i.test(insert.error.message || '')) {
      delete linha.historico;
      insert = await supabase.from('games').insert(linha).select().single();
    }
    if (insert.error) throw new HttpError(500, insert.error.message);
    const game = insert.data;

    const fuso = fusoDoTime(team);
    res.status(201).json({ game: { ...game, fuso, sorteio_em: sorteioDoJogo(game) } });

    // O jogo nasce chamando: quem foi chamado recebe o "Você vai?" — EXCETO em jogo histórico (silencioso por lei).
    if (!eHistorico) {
      Promise.all([membrosDaEquipa(team.id), idsQueSoOrganizam(team.id)])
        .then(([elenco, organizam]) => avisarJogo('criado', { game, team: { ...team, fuso }, ids: chamadosDoJogo(game, elenco, organizam), autorId: req.user.id }))
        .catch((e) => console.warn('[games] aviso do jogo criado:', e.message));
    }
  })
);

/** GET /api/teams/:slug/games — lista os jogos do time (com nº de confirmados). */
router.get(
  '/api/teams/:slug/games',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug, nome, cor');
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    const role = await getRole(team.id, req.user.id);
    if (!role) throw foraDoTime();

    // A chamada (sorteio_em, chamados) vem junto; sem a migração 089 a leitura repete sem elas (utils/colunasDaChamada.js).
    const { data: games, error } = await lerComChamada((extra) => supabase
      .from('games')
      .select('id, data, local, status, resultado_nivel, num_times, jogadores_por_time, sorteio_realizado, campeao_time_index, time_vencedor, cancelado, motivo_cancelamento, max_jogadores, created_at' + extra)
      .eq('team_id', team.id)
      .order('data', { ascending: false }));
    if (error) throw new HttpError(500, error.message);

    // Confirmados por jogo: a presença vive em game_players (a porta única da presença, routes/rsvp.js, grava lá e em rsvp_respostas).
    const ids = (games || []).map((g) => g.id);
    const counts = {};
    const { data: gp } = ids.length
      ? await supabase.from('game_players').select('game_id, confirmado').in('game_id', ids)
      : { data: [] };
    for (const row of gp || []) {
      if (row.confirmado) counts[row.game_id] = (counts[row.game_id] || 0) + 1;
    }

    const lista = (games || []).map(({ chamados, ...g }) => ({
      ...g,
      status: statusEfetivoJogo(g),
      cancelado: !!g.cancelado || g.status === 'cancelado',
      confirmados: counts[g.id] || 0,
      // A hora do sorteio (a lista fecha nela), se ainda dá para responder e quem foi chamado (null = o elenco inteiro). Só o admin vê quem.
      sorteio_em: sorteioDoJogo(g),
      lista_aberta: listaAberta(g),
      ...(role === 'admin' ? { chamados: Array.isArray(chamados) ? chamados : null } : {}),
    }));
    res.json({ team: { ...team, fuso: fusoDoTime(team), role }, games: lista });
  })
);

/**
 * GET /api/games/my-invites — todos os jogos dos times do usuário.
 * Registrado ANTES de /api/games/:id para não colidir com o param :id.
 */
// Lógica em services/inicio.js#obterConvites — a MESMA função que GET /api/inicio
// usa, para o JSON nunca divergir entre as duas rotas.
router.get(
  '/api/games/my-invites',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await obterConvites(req.user.id));
  })
);

/** GET /api/games/:id — detalhes do jogo (jogadores, ratings, o meu estado). */
router.get(
  '/api/games/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (!role) throw foraDoTime();

    // Estas 4 leituras não dependem umas das outras (só de game.id/
    // game.teams.id, já conhecidos) — em paralelo, não uma round-trip a seguir à
    // outra.
    const [gpResult, inativosResult, golsResult, votosResult] = await Promise.all([
      supabase
        .from('game_players')
        .select('confirmado, goleiro, cabeca_chave, users ( id, nome, nome_jogador, email, avatar_url, avatar_generico )')
        .eq('game_id', game.id),
      // Inativos do time: preservados no histórico mas fora do sorteio.
      supabase.from('team_members').select('user_id').eq('team_id', game.teams.id).eq('ativo', false),
      // Gols por jogador (só relevante no nível 3 do resultado).
      game.resultado_nivel === 3
        ? supabase.from('gols_jogadores').select('user_id, time, gols, convidado_nome, users ( id, nome )').eq('game_id', game.id)
        : Promise.resolve({ data: [] }),
      supabase.from('votes').select('id', { count: 'exact', head: true }).eq('game_id', game.id).eq('de_user_id', req.user.id),
    ]);
    const gp = gpResult.data;
    const inativos = new Set((inativosResult.data || []).map((m) => m.user_id));
    // Convidado sem app não tem users (sem conta): o nome vem de convidado_nome, gravado no PATCH /resultado.
    const gols = (golsResult.data || []).map((g) => ({ user_id: g.user_id || null, time: g.time, gols: g.gols || 0, nome: g.users?.nome || g.convidado_nome || null }));
    const votosCount = votosResult.count;

    // computeRatings precisa dos userIds vindos de gp — este fica sequencial.
    const userIds = (gp || []).map((p) => p.users?.id).filter(Boolean);
    const ratings = await computeRatings(game.teams.id, userIds);

    const players = (gp || [])
      .filter((p) => p.users && !inativos.has(p.users.id))
      .map((p) => ({
        user_id: p.users.id,
        nome: p.users.nome_jogador || p.users.nome || 'Jogador',
        avatar_url: p.users.avatar_url || null,
        avatar_generico: p.users.avatar_generico || null,
        confirmado: p.confirmado,
        goleiro: p.goleiro,
        cabeca_chave: p.cabeca_chave,
        rating: round1(ratings[p.users.id] ?? RATING_DEFAULT),
      }));

    const meu = players.find((p) => p.user_id === req.user.id) || null;

    // O sorteio guardou o avatar de quando foi feito; quem trocou a foto depois aparece com a de hoje
    // (utils/avataresDoSorteio.js). Vem do mesmo game_players que a lista de presença: sem ida nova.
    const timesResultado = comNomesPublicos(
      comAvataresAtuais(game.times_resultado, new Map((gp || []).filter((p) => p.users).map((p) => [p.users.id, p.users.avatar_url || null]))),
      // O cartão 9:16 sai do app para o WhatsApp: quem tem conta leva o apelido (ou o primeiro nome), como na página pública.
      mapaDeNomesPublicos((gp || []).map((p) => p.users).filter(Boolean)),
    );

    const team = game.teams;
    res.json({
      team: { id: team.id, slug: team.slug, nome: team.nome, cor: team.cor, fuso: fusoDoTime(team), role },
      game: {
        id: game.id,
        data: game.data,
        local: game.local,
        status: statusEfetivoJogo(game),
        num_times: game.num_times,
        jogadores_por_time: game.jogadores_por_time,
        max_jogadores: game.max_jogadores ?? null,
        sorteio_realizado: game.sorteio_realizado,
        // A chamada: a hora do sorteio (a lista fecha nela) e se ainda dá para responder (utils/chamadaDoJogo.js).
        sorteio_em: sorteioDoJogo(game),
        lista_aberta: listaAberta(game),
        // Quem foi chamado: null = todo o elenco. Só o admin vê a lista (é ele quem chama mais gente).
        ...(role === 'admin' ? { chamados: Array.isArray(game.chamados) ? game.chamados : null } : {}),
        times_resultado: timesResultado,
        historico: !!game.historico,
        // Cancelamento.
        cancelado: !!game.cancelado || game.status === 'cancelado',
        motivo_cancelamento: game.motivo_cancelamento || null,
        // Resultado do jogo (4 níveis).
        resultado_nivel: game.resultado_nivel || 0,
        time_vencedor: game.time_vencedor || null,
        placar_a: game.placar_a ?? null,
        placar_b: game.placar_b ?? null,
        // Campos de resultado (para pré-preencher a edição no painel de admin).
        campeao_time_index: game.campeao_time_index,
        campeao_foto_url: game.campeao_foto_url,
        artilheiro_user_id: game.artilheiro_user_id,
        artilheiro_gols: game.artilheiro_gols,
        destaque_user_id: game.destaque_user_id,
        destaque_titulo: game.destaque_titulo,
        rodada_user_id: game.rodada_user_id,
        rodada_foto_url: game.rodada_foto_url,
      },
      players,
      // Os convidados sem app do jogo, com as marcas do sorteio: é a lista "Alguém sem o app vai jogar?" de quem organiza
      // (utils/convidadosDoJogo.js). Só o admin edita e sorteia; os outros veem os convidados nos times.
      ...(role === 'admin' ? { convidados: convidadosGuardados(game) } : {}),
      gols,
      meuEstado: meu
        ? { confirmado: meu.confirmado, goleiro: meu.goleiro, cabeca_chave: meu.cabeca_chave }
        : null,
      chamado: foiChamado(game, req.user.id),
      jaVotei: (votosCount || 0) > 0,
    });
  })
);

// O sorteio compartilhado: link curto, /api/s/:codigo e a página pública (routes/jogoPublico.js).
router.use(require('./jogoPublico'));

/**
 * POST /api/games/:id/partilha-declarada — TERMO de quem partilha (1-clique).
 * Registro de auditoria: quem copiou/partilhou o link declarou ter o direito de o
 * fazer. NÃO altera a privacidade (a regra de rosto é independente e sempre ligada);
 * é só a cobertura legal. Idempotente (upsert por game+user).
 */
router.post(
  '/api/games/:id/partilha-declarada',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');
    // só quem tem papel no time (membro/admin) pode declarar o compartilhamento
    const role = await getRole(game.teams.id, req.user.id);
    if (!role) throw new HttpError(403, 'Sem permissão para compartilhar este sorteio.');
    const { error } = await supabase
      .from('share_declarations')
      .upsert({ game_id: game.id, user_id: req.user.id }, { onConflict: 'game_id,user_id' });
    if (error) throw new HttpError(500, error.message);
    res.json({ ok: true });
  })
);

/** PATCH /api/games/:id/resultado — define o resultado do jogo (só admin). */
router.patch(
  '/api/games/:id/resultado',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');
    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem definir o resultado.');

    // O resultado abre 5 minutos depois do início do jogo — exceto jogo histórico/retroativo (criado como "Já aconteceu"), que não tem essa trava.
    if (!resultadoJaAbriu(game)) throw new HttpError(400, MSG_RESULTADO_FECHADO);

    const b = req.body || {};
    // `nivel` é do app antigo (4 níveis de detalhe escolhidos à mão); o app novo não manda e o motor deduz do que veio. `nivel: 0` é "limpar".
    const nivelPedido = b.nivel === undefined ? null : Number(b.nivel);
    if (nivelPedido !== null && ![0, 1, 2, 3].includes(nivelPedido)) throw new HttpError(400, 'Nível de resultado inválido.');
    const limpar = nivelPedido === 0;

    // Quem ganhou: o campeão é a verdade e `time_vencedor` sai dele (utils/resultadoDoJogo.js). Os apps que ainda mandam só
    // `time_vencedor` ('A' | 'B' | 'empate') dizem a mesma coisa pelo outro nome. Com gols lançados, os gols decidem (a soma por time é o
    // placar e o placar define o vencedor); sem gols, vale o placar digitado; sem placar, o vencedor tocado.
    const escolha = limpar ? { campeaoIdx: null, empate: false, informado: false } : escolhaDoCorpo(b);
    if (nivelPedido >= 1 && !escolha.informado) throw new HttpError(400, 'Indique quem venceu.');
    const linhas = limpar ? [] : linhasDeGols(game.times_resultado, b.gols, new Set(await membrosDaEquipa(game.teams.id)));
    const { porTime, temGols } = somaDeGols(linhas);
    const decisao = decidirResultado({
      nTimes: quantosTimes(game.times_resultado),
      campeaoIdx: escolha.campeaoIdx,
      empate: escolha.empate,
      placar: limpar || nivelPedido === 1 ? null : placarDoCorpo(b),
      golsPorTime: porTime,
      temGols,
    });
    const patch = {
      resultado_nivel: decisao.resultado_nivel,
      campeao_time_index: decisao.campeao_time_index,
      time_vencedor: decisao.time_vencedor,
      placar_a: decisao.placar_a,
      placar_b: decisao.placar_b,
    };

    const { data: updated, error } = await supabase.from('games').update(patch).eq('id', game.id).select().single();
    if (error) throw new HttpError(500, error.message);

    // O jogo passou → reset das ausências antecipadas (para o próximo jogo).
    await supabase.from('team_members').update({ ausente_proximo: false }).eq('team_id', game.teams.id).eq('ausente_proximo', true);

    // Os gols mandados substituem os de antes: limpa sempre e reinsere o que veio.
    await supabase.from('gols_jogadores').delete().eq('game_id', game.id);
    if (linhas.length) {
      const { error: gErr } = await supabase.from('gols_jogadores').insert(linhas.map((l) => ({ game_id: game.id, ...l })));
      if (gErr) throw new HttpError(500, gErr.message);
    }

    res.json({ game: { ...updated, fuso: fusoDoTime(game.teams) } });

    // Avisa o time (fire-and-forget) — só quando o jogo ganha o primeiro resultado; corrigir o que já foi anunciado não avisa de novo.
    anunciarResultado({ antes: game, depois: updated, local: game.local, membros: () => membrosDaEquipa(game.teams.id), enviar: enviarNotificacao });
  })
);

/** POST /api/games/:id/jogador — admin marca goleiro / cabeça de chave. */
router.post(
  '/api/games/:id/jogador',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { user_id: userId, goleiro, cabeca_chave: cabecaChave } = req.body || {};
    if (!userId) throw new HttpError(400, 'user_id em falta.');
    if (!ehUuid(userId)) throw new HttpError(400, 'user_id inválido.');

    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem marcar jogadores.');

    const patch = {};
    if (typeof goleiro === 'boolean') patch.goleiro = goleiro;
    if (typeof cabecaChave === 'boolean') patch.cabeca_chave = cabecaChave;
    if (!Object.keys(patch).length) throw new HttpError(400, 'Nada para atualizar.');

    const { data: updated, error } = await supabase
      .from('game_players')
      .update(patch)
      .eq('game_id', game.id)
      .eq('user_id', userId)
      .select('user_id, goleiro, cabeca_chave')
      .maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!updated) throw new HttpError(404, 'Esse jogador não está confirmado neste jogo.');

    res.json({ jogador: updated });
  })
);

/**
 * POST /api/games/:id/confirmar — confirma/cancela a própria presença.
 * `goleiro` é opcional. Sem ele no body, vale o que já estiver
 * marcado naquele jogo (pelo jogador ou pelo admin) e, se ainda não houver
 * linha, a flag do time (team_members.categoria === 'GR').
 */
router.post(
  '/api/games/:id/confirmar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { confirmado = true, goleiro } = req.body || {};

    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (!role) throw foraDoTime();
    // Quem só organiza o time não entra na lista de presença (desmarcar continua valendo).
    if (confirmado && (await soOrganiza(game.teams.id, req.user.id))) throw new HttpError(403, MSG_SO_ORGANIZA);

    await ensureUserRow(req.user);

    // Sair da lista nunca é bloqueado para quem só organiza (pode ter confirmado antes de mudar de papel): sai do elenco e da lista.
    if (!confirmado && (await soOrganiza(game.teams.id, req.user.id))) {
      await supabase.from('game_players').update({ confirmado: false }).eq('game_id', game.id).eq('user_id', req.user.id);
      await supabase.from('rsvp_respostas').delete().eq('game_id', game.id).eq('user_id', req.user.id);
      return res.json({ meuEstado: { confirmado: false, goleiro: false } });
    }

    // Só trocar o "sou goleiro" de quem já respondeu (a resposta não muda) vale mesmo com a lista fechada: é marca do sorteio.
    const { data: linha } = await supabase.from('game_players').select('confirmado, goleiro').eq('game_id', game.id).eq('user_id', req.user.id).maybeSingle();
    if (linha && !!linha.confirmado === !!confirmado && goleiro != null) {
      const { error } = await supabase.from('game_players').update({ goleiro: !!goleiro }).eq('game_id', game.id).eq('user_id', req.user.id);
      if (error) throw new HttpError(500, error.message);
      return res.json({ meuEstado: { confirmado: !!confirmado, goleiro: !!goleiro } });
    }

    // Mudar a resposta é "Vou / Não vou": a MESMA porta da lista de presença (routes/rsvp.js) — lista aberta, só quem foi chamado.
    const r = await responderPresenca({ game, userId: req.user.id, status: confirmado ? 'confirmado' : 'recusado', goleiro: goleiro == null ? null : !!goleiro });
    if (r.espera) return res.json({ meuEstado: { confirmado: false, goleiro: !!goleiro }, espera: true, posicao: r.posicao });
    res.json({ meuEstado: { confirmado: !!confirmado, goleiro: r.goleiro } });
  })
);

/**
 * POST /api/games/:id/presencas — ADMIN marca quem jogou (jogo manual/retroativo).
 * Distinto do self-confirm: aqui o ADMIN do time marca a presença de TERCEIROS a
 * partir de uma checklist. Autoritativo: os user_id enviados ficam confirmados; os
 * membros confirmados que NÃO vierem na lista são desmarcados (a lista é a verdade).
 * Body: { jogadores: [{ user_id, goleiro? }] }. Só membros do time entram.
 */
router.post(
  '/api/games/:id/presencas',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');
    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem marcar presenças por outros.');

    const lista = Array.isArray(req.body?.jogadores) ? req.body.jogadores : [];
    // valida que cada user_id é membro do time
    const { data: membros } = await supabase.from('team_members').select('user_id').eq('team_id', game.teams.id);
    const membroIds = new Set((membros || []).map((m) => m.user_id));
    // Quem só organiza o time não joga — não entra no elenco nem pela checklist do admin.
    const organizam = await idsQueSoOrganizam(game.teams.id);
    const escolhidos = [];
    for (const j of lista) {
      if (j && j.user_id && membroIds.has(j.user_id) && !organizam.has(j.user_id)) escolhidos.push({ game_id: game.id, user_id: j.user_id, confirmado: true, goleiro: !!j.goleiro });
    }
    const escolhidosSet = new Set(escolhidos.map((e) => e.user_id));

    if (escolhidos.length) {
      const { error } = await supabase.from('game_players').upsert(escolhidos, { onConflict: 'game_id,user_id' });
      if (error) throw new HttpError(500, error.message);
    }
    // desmarca (confirmado=false) os que estavam confirmados e não vieram na lista
    const { data: atuais } = await supabase.from('game_players').select('user_id, confirmado').eq('game_id', game.id).eq('confirmado', true);
    const remover = (atuais || []).filter((p) => !escolhidosSet.has(p.user_id)).map((p) => p.user_id);
    if (remover.length) {
      await supabase.from('game_players').update({ confirmado: false }).eq('game_id', game.id).in('user_id', remover);
    }
    res.json({ ok: true, confirmados: escolhidos.length });
  })
);

// Os times do jogo: à mão, sorteio e troca (routes/sorteioDoJogo.js).
router.use(require('./sorteioDoJogo'));

// NOTA: a votação por jogo (POST /api/games/:id/votar) foi removida — o novo
// modelo é 1 voto por (votante, votado, time), gerido em routes/ranking.js.

/**
 * PATCH /api/games/:id — edita um jogo não sorteado (só admin).
 * Body opcional: { date, time, location, players_per_team }.
 * date + time combinam-se na coluna única `data` (timestamptz).
 */
router.patch(
  '/api/games/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem editar o jogo.');
    if (game.sorteio_realizado) throw new HttpError(400, 'Não pode editar um jogo já sorteado.');

    const b = req.body || {};
    const patch = {};

    // Recombina data/hora (a coluna `data` guarda ambas). Data e hora são as do CAMPO — lidas e escritas no
    // fuso do time, nunca no do servidor (UTC no Cloud Run: "20:00" virava 17:00 em São Paulo) nem no do
    // aparelho de quem edita.
    if ('date' in b || 'time' in b) {
      const fuso = fusoDoTime(game.teams);
      const base = partesNoFuso(game.data, fuso);
      const pad = (n) => String(n).padStart(2, '0');
      const datePart = b.date
        ? String(b.date).slice(0, 10)
        : (base ? `${base.ano}-${pad(base.mes)}-${pad(base.dia)}` : '');
      const timePart = b.time ? String(b.time).slice(0, 5) : (base ? `${pad(base.hora)}:${pad(base.minuto)}` : '');
      const combinado = instanteNoFuso(datePart, timePart, fuso);
      if (!combinado) throw new HttpError(400, 'Data/hora inválida.');
      patch.data = combinado.toISOString();
    }
    if ('location' in b) patch.local = textoCurto(b.location, 120, 'Local') || null;
    if ('players_per_team' in b) {
      const n = parseInt(b.players_per_team, 10);
      if (!Number.isFinite(n) || n < 1 || n > MAX_JOGADORES_POR_TIME) throw new HttpError(400, 'players_per_team inválido.');
      patch.jogadores_por_time = n;
    }

    // A hora do sorteio (a lista fecha nela), no relógio do time como a do jogo. Sem ela no pedido, mudar a data/hora do jogo leva o
    // sorteio junto se ele estava no "1 h antes" (utils/chamadaDoJogo.js#sorteioAoMudarOJogo).
    const fuso = fusoDoTime(game.teams);
    const dataFinal = patch.data || game.data;
    if ('sorteio_date' in b || 'sorteio_time' in b) {
      const base = partesNoFuso(sorteioDoJogo(game), fuso);
      const pad = (n) => String(n).padStart(2, '0');
      const dia = b.sorteio_date ? String(b.sorteio_date).slice(0, 10) : (base ? `${base.ano}-${pad(base.mes)}-${pad(base.dia)}` : '');
      const hora = b.sorteio_time ? String(b.sorteio_time).slice(0, 5) : (base ? `${pad(base.hora)}:${pad(base.minuto)}` : '');
      const instante = instanteNoFuso(dia, hora, fuso);
      if (!instante) throw new HttpError(400, 'Hora do sorteio inválida.');
      const s = sorteioEscolhido(instante.toISOString(), dataFinal);
      if (s.erro) throw new HttpError(400, s.erro);
      patch.sorteio_em = s.iso;
    } else if (patch.data && patch.data !== new Date(game.data).toISOString()) {
      patch.sorteio_em = sorteioAoMudarOJogo({ sorteioAntigo: game.sorteio_em || null, dataAntiga: game.data, dataNova: patch.data });
    }

    if (!Object.keys(patch).length) throw new HttpError(400, 'Nada para atualizar.');

    let r = await supabase.from('games').update(patch).eq('id', game.id).select().single();
    if (r.error && erroDaChamada(r.error)) r = await supabase.from('games').update(semColunasDaChamada(patch)).eq('id', game.id).select().single();
    const { data: updated, error } = r;
    if (error) throw new HttpError(500, error.message);
    res.json({ game: { ...updated, fuso, sorteio_em: sorteioDoJogo(updated) } });

    // Mudou a data, a hora ou o local: quem foi chamado fica sabendo (a hora do sorteio sozinha, ou o número por time, não avisa ninguém).
    const mudouData = patch.data && new Date(patch.data).getTime() !== new Date(game.data).getTime();
    const mudouLocal = 'local' in patch && (patch.local || null) !== (game.local || null);
    if (mudouData || mudouLocal) {
      Promise.all([membrosDaEquipa(game.teams.id), idsQueSoOrganizam(game.teams.id)])
        .then(([elenco, organizam]) => avisarJogo('mudou', {
          game: updated, team: game.teams, ids: chamadosDoJogo(updated, elenco, organizam), autorId: req.user.id,
          detalhe: { antes: { data: game.data, local: game.local || null }, depois: { data: updated.data, local: updated.local || null } },
        }))
        .catch((e) => console.warn('[games] aviso do jogo que mudou:', e.message));
    }
  })
);

/**
 * POST /api/games/:id/chamar — o admin chama mais gente para um jogo que não chamou o elenco inteiro. Body: { user_ids: [...] }.
 * Quem é chamado agora recebe o "Você vai?" (e o push) na hora. Jogo que chama o elenco inteiro já chama todo mundo (409).
 */
router.post(
  '/api/games/:id/chamar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');
    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins chamam gente para o jogo.');
    if (!listaAberta(game)) throw new HttpError(409, 'A lista deste jogo já fechou.', 'LISTA_FECHADA');
    if (!Array.isArray(game.chamados)) throw new HttpError(409, 'Este jogo já chama o elenco inteiro.', 'ELENCO_INTEIRO');
    const pedidos = req.body?.user_ids;
    if (!Array.isArray(pedidos) || !pedidos.length || pedidos.some((id) => !ehUuid(id))) throw new HttpError(400, 'Escolha quem chamar.');
    const [elenco, organizam] = await Promise.all([membrosDaEquipa(game.teams.id), idsQueSoOrganizam(game.teams.id)]);
    const podem = new Set(elenco.filter((id) => !organizam.has(id)));
    const novos = [...new Set(pedidos)].filter((id) => podem.has(id) && !game.chamados.includes(id));
    if (!novos.length) return res.json({ chamados: game.chamados, novos: [] });
    const todos = [...game.chamados, ...novos];
    const { error } = await supabase.from('games').update({ chamados: todos }).eq('id', game.id);
    if (error) throw new HttpError(500, error.message);
    res.json({ chamados: todos, novos });
    avisarJogo('chamado', { game, team: game.teams, ids: novos, autorId: req.user.id }).catch(() => {});
  })
);

/**
 * DELETE /api/games/:id — apaga um jogo futuro sem confirmações (só admin).
 * Se houver confirmações → 409 (deve cancelar-se, não apagar).
 */
router.delete(
  '/api/games/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem excluir jogos.');

    if (!game.data || new Date(game.data).getTime() <= Date.now()) {
      throw new HttpError(400, 'Só pode excluir jogos futuros.');
    }

    const { count } = await supabase
      .from('game_players')
      .select('id', { count: 'exact', head: true })
      .eq('game_id', game.id)
      .eq('confirmado', true);
    if ((count || 0) > 0) {
      throw new HttpError(409, 'Este jogo já tem jogadores confirmados. Cancele-o em vez de excluí-lo.');
    }

    const { error } = await supabase.from('games').delete().eq('id', game.id);
    if (error) throw new HttpError(500, error.message);
    res.json({ deleted: true });
  })
);

/**
 * POST /api/games/:id/cancelar — cancela um jogo não terminado (só admin).
 * Marca status 'cancelado' + cancelado_at (compat. com filtros existentes) e
 * a flag cancelado + motivo_cancelamento. Notifica todos os membros por push.
 * Body: { motivo?: string }.
 */
router.post(
  '/api/games/:id/cancelar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem cancelar jogos.');
    if (game.status === 'terminado') throw new HttpError(400, 'Não pode cancelar um jogo terminado.');

    const motivo = String(req.body?.motivo || '').trim().slice(0, 300) || null;

    const { data: updated, error } = await supabase
      .from('games')
      .update({ status: 'cancelado', cancelado_at: new Date().toISOString(), cancelado: true, motivo_cancelamento: motivo })
      .eq('id', game.id)
      .select()
      .single();
    if (error) throw new HttpError(500, error.message);

    res.json({ ok: true, game: { ...updated, fuso: fusoDoTime(game.teams) } });

    // Notifica todos os membros do time (fire-and-forget, após responder).
    const membros = await membrosDaEquipa(game.teams.id);
    const corpo = `O jogo de ${dataCurtaNoFuso(game.data, fusoDoTime(game.teams))} foi cancelado.` + (motivo ? ` Motivo: ${motivo}` : '');
    enviarNotificacao(membros, {
      title: 'Jogo cancelado ❌',
      body: corpo,
      url: `/time/${game.teams.slug}`,
    }, { categoria: 'jogos' });
  })
);

/**
 * PATCH /api/games/:id/capacidade — define o máximo de jogadores (só admin).
 * Body: { max_jogadores: number|null }. null/0/vazio = sem limite.
 */
router.patch(
  '/api/games/:id/capacidade',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem definir a capacidade.');

    const raw = req.body?.max_jogadores;
    let max = null;
    if (raw !== null && raw !== undefined && raw !== '') {
      if (typeof raw !== 'number' && typeof raw !== 'string') throw new HttpError(400, 'Máximo de jogadores inválido.');
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Máximo de jogadores inválido.');
      max = n;
    }

    const { error } = await supabase.from('games').update({ max_jogadores: max }).eq('id', game.id);
    if (error) throw new HttpError(500, error.message);
    res.json({ ok: true, max_jogadores: max });
  })
);

/**
 * POST /api/teams/:slug/jogos/recorrentes — cria N jogos semanais de uma vez,
 * num dia da semana / hora fixos (só admin). Sem cron: geração imediata.
 * Body: { dia_semana: 0-6, hora: "HH:MM", local?, semanas: 4|8|12 }.
 * Salta datas que colidem com jogos já existentes (± 1 hora).
 */
router.post(
  '/api/teams/:slug/jogos/recorrentes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug, nome');
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem criar jogos.');

    const { dia_semana: diaSemana, hora, local, semanas } = req.body || {};
    const dia = Number(diaSemana);
    if (!Number.isInteger(dia) || dia < 0 || dia > 6) throw new HttpError(400, 'Dia da semana inválido (0-6).');
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hora || ''));
    if (!m) throw new HttpError(400, 'Hora inválida (formato HH:MM).');
    const horas = Number(m[1]);
    const minutos = Number(m[2]);
    if (horas > 23 || minutos > 59) throw new HttpError(400, 'Hora inválida.');
    const n = Number(semanas);
    if (![4, 8, 12].includes(n)) throw new HttpError(400, 'Semanas deve ser 4, 8 ou 12.');

    // Próximas N datas para o dia da semana escolhido (a partir de hoje). "hoje", o dia da semana e a hora
    // são os do CAMPO (fuso do time), não os do servidor — o Cloud Run roda em UTC, e "quinta 20:00" saía
    // às 17:00 de São Paulo.
    const fuso = fusoDoTime(team);
    const hojeNoCampo = partesNoFuso(new Date(), fuso);
    const horaTexto = `${String(horas).padStart(2, '0')}:${String(minutos).padStart(2, '0')}`;
    // O dia do calendário `k` dias depois de hoje (aritmética em UTC só para somar dias: sem fuso, sem horário de verão).
    const diaDoCalendario = (k) => {
      const d = new Date(Date.UTC(hojeNoCampo.ano, hojeNoCampo.mes - 1, hojeNoCampo.dia + k));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    };
    // Avança até ao próximo dia da semana (inclui hoje se ainda for no futuro).
    let deslocamento = (dia - hojeNoCampo.diaDaSemana + 7) % 7;
    if (instanteNoFuso(diaDoCalendario(deslocamento), horaTexto, fuso).getTime() <= Date.now()) deslocamento += 7;
    const datas = [];
    for (let i = 0; i < n; i += 1) {
      datas.push(instanteNoFuso(diaDoCalendario(deslocamento + 7 * i), horaTexto, fuso));
    }

    // Jogos já existentes do time (para detectar colisões ± 1 hora).
    const primeira = datas[0];
    const ultima = datas[datas.length - 1];
    const { data: existentes } = await supabase
      .from('games')
      .select('data')
      .eq('team_id', team.id)
      .gte('data', new Date(primeira.getTime() - 3600000).toISOString())
      .lte('data', new Date(ultima.getTime() + 3600000).toISOString());
    const existentesTs = (existentes || []).map((g) => new Date(g.data).getTime());
    const colide = (d) => existentesTs.some((ts) => Math.abs(ts - d.getTime()) <= 3600000);

    const porTime = jogadoresPorTimeDoTime(team); // o padrão do time (sem ele, 5); o admin ajusta depois por jogo.
    const aInserir = [];
    const criadas = [];
    let ignorados = 0;
    for (const d of datas) {
      if (colide(d)) {
        ignorados += 1;
        continue;
      }
      aInserir.push({ team_id: team.id, data: d.toISOString(), local: local?.trim() || null, jogadores_por_time: porTime });
      criadas.push(d.toISOString());
    }

    let inseridos = [];
    if (aInserir.length) {
      const { data, error } = await supabase.from('games').insert(aInserir).select('id, data, local');
      if (error) throw new HttpError(500, error.message);
      inseridos = data || [];
    }

    res.status(201).json({ criados: aInserir.length, datas: criadas, ignorados, fuso });

    // Cada jogo nasce chamando o elenco (sorteio 1 h antes de cada um). O aviso é UM só para a série (não um push por semana),
    // registrado no primeiro jogo, pelo mesmo cano dos outros avisos de jogo.
    if (inseridos.length) {
      Promise.all([membrosDaEquipa(team.id), idsQueSoOrganizam(team.id)])
        .then(([elenco, organizam]) => avisarJogo('criado', {
          game: inseridos[0], team: { ...team, fuso }, ids: elenco.filter((id) => !organizam.has(id)), autorId: req.user.id,
          detalhe: { recorrentes: inseridos.map((g) => g.id) },
          payload: { title: '⚽ Novos jogos agendados', body: `${team.nome || 'Seu time'} · ${inseridos.length} jogos nas próximas semanas. Você vai? Responda no app.`, url: '/home' },
        }))
        .catch((e) => console.warn('[games] aviso dos recorrentes:', e.message));
    }
  })
);

// "Associar jogador" (routes/associarJogador.js).
router.use(require('./associarJogador'));

module.exports = router;
