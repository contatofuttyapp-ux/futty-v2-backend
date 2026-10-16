// Futty v2.0 — Rotas de jogos: criação, confirmação, marcação, sorteio e votos.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, getTeamBySlug, getRole, ensureUserRow, loadGame, computeRatings, goleirosDoTime } = require('../utils/db');
const { jogadoresPorTimeDoTime } = require('../utils/jogadoresPorTime'); // o padrão do time
const { obterConvites } = require('../services/inicio');
const { RATING_DEFAULT } = require('../utils/helpers');
const { executarSorteio } = require('../utils/sorteio');
const { aplicarRostoPublico } = require('../utils/rostoPublico');
const { comAvataresAtuais } = require('../utils/avataresDoSorteio');
const { nomePublico, mapaDeNomesPublicos, comNomesPublicos } = require('../utils/nomePublico');
const { enviarNotificacao } = require('./push');
const { soOrganiza, idsQueSoOrganizam, MSG_SO_ORGANIZA } = require('../utils/soOrganiza');
const { fusoDoTime, dataCurtaNoFuso, partesNoFuso, instanteNoFuso } = require('../utils/fuso');
const { codigoDoSorteio, jogoDoCodigo } = require('../utils/sorteioCodigo'); // o link curto /s/<código>
const { registroDeSorteio, registroDeMontagem, resultadoAjustado, registroPublico, chaveDoJogador } = require('../utils/registroDoSorteio');
const { quantosTimes, escolhaDoCorpo, linhasDeGols, somaDeGols, placarDoCorpo, decidirResultado, resultadoJaAbriu } = require('../utils/resultadoDoJogo'); // quem ganhou: uma verdade só
const { anunciarResultado } = require('../utils/avisoDoResultado');
const { estadoDoJogo } = require('../utils/estadoDoJogo'); // o estado do jogo: uma regra só
const { textoCurto, ehUuid } = require('../utils/entrada'); // o que a pessoa digita: texto com teto, número em faixa
const { limparTimes, limparReservas } = require('../utils/timesDoCorpo'); // os times que o app manda à mão
const { registroDe } = require('../utils/registroDoSorteio');
const {
  JANELA_DESFAZER_MS, nomeNorm, todosOsJogadores, acharConvidado, convidadosDoJogo, membroNoResultado, trocarNoResultado, jogadorComConta,
  ehEsteConvidado, ehEsteMembro, trocarNoPlantel, podeDesfazer, associacaoAtiva, associacoesDesfaziveis, registroComAssociacoes,
} = require('../utils/associarJogador'); // o convidado sem app vira a conta de um membro
const campeonatos = require('../utils/campeonatoStore');
const selosCache = require('../utils/selosCache');
const { sincronizarPostDoCampeao } = require('../utils/postDoCampeao');

const router = express.Router();

const MSG_RESULTADO_FECHADO = 'O resultado abre 5 minutos depois do início do jogo.';
// O sorteio faz no máximo 28 jogadores em 4 times; um "jogadores por time" acima de 30 não existe.
const MAX_JOGADORES_POR_TIME = 30;

/** Quem fez a ação, com o nome de guerra DE AGORA — o selo grava este nome e não muda se a pessoa o trocar depois. */
async function quemFez(userId) {
  const { data } = await supabase.from('users').select('nome, nome_jogador').eq('id', userId).maybeSingle();
  // O registro do sorteio sai na página pública: o apelido (ou só o primeiro nome), nunca o nome completo.
  return { id: userId, nome: data ? nomePublico(data) : null };
}

const round1 = (n) => Math.round(n * 10) / 10;
const NOMES_TIMES = ['Time A', 'Time B', 'Time C', 'Time D', 'Time E', 'Time F'];

// Estado efetivo do jogo: a regra única em utils/estadoDoJogo.js (agendado · em curso · terminado · cancelado).
// Calculado a cada leitura, não depende de um write acertar a hora certa, nem de o sorteio ter sido feito cedo.
const statusEfetivoJogo = (game) => estadoDoJogo(game);

// Data curta (ex.: "12/06 · 20:30") para o corpo das notificações — no relógio do CAMPO (fuso do
// time), não no do servidor (o Cloud Run roda em UTC: "20:30" de São Paulo saía como "23:30").

/** IDs dos membros de uma equipa (para notificações). */
async function membrosDaEquipa(teamId) {
  const { data } = await supabase.from('team_members').select('user_id').eq('team_id', teamId);
  return (data || []).map((m) => m.user_id);
}

/** POST /api/games — cria um jogo (só admin da equipa). */
router.post(
  '/api/games',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team_slug: teamSlug, data, local, jogadores_por_time: jogadoresPorTime, historico } = req.body || {};
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
    // num_times fica por definir; é calculado no sorteio conforme os confirmados.
    const linha = {
      team_id: team.id,
      data: quando.toISOString(),
      local: localTexto || null,
      jogadores_por_time: porTime,
    };
    if (eHistorico) linha.historico = true; // coluna opcional (migração à mão); ver nota abaixo
    let insert = await supabase.from('games').insert(linha).select().single();
    // Resiliência: se a coluna `historico` ainda não existir (DDL por correr), repete sem ela.
    if (insert.error && eHistorico && /historico/i.test(insert.error.message || '')) {
      delete linha.historico;
      insert = await supabase.from('games').insert(linha).select().single();
    }
    if (insert.error) throw new HttpError(500, insert.error.message);
    const game = insert.data;

    const fuso = fusoDoTime(team);
    res.status(201).json({ game: { ...game, fuso } });

    // Notifica os membros — EXCETO em jogo histórico (silencioso por lei).
    if (!eHistorico) {
      membrosDaEquipa(team.id).then((memberIds) =>
        enviarNotificacao(memberIds, {
          title: '⚽ Novo jogo criado',
          body: `${team.nome || 'Seu time'} · ${dataCurtaNoFuso(game.data, fuso)}`,
          url: '/home',
        }, { categoria: 'jogos' }) // quem desligou "Jogos e presença" no Perfil fica de fora
      );
    }
  })
);

/** GET /api/teams/:slug/games — lista os jogos da equipa (com nº de confirmados). */
router.get(
  '/api/teams/:slug/games',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug, nome, cor');
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    const role = await getRole(team.id, req.user.id);
    if (!role) throw new HttpError(403, 'Não é membro deste time.');

    const { data: games, error } = await supabase
      .from('games')
      .select('id, data, local, status, resultado_nivel, num_times, jogadores_por_time, sorteio_realizado, campeao_time_index, time_vencedor, cancelado, motivo_cancelamento, max_jogadores, rsvp_aberto, rsvp_fechado, created_at')
      .eq('team_id', team.id)
      .order('data', { ascending: false });
    if (error) throw new HttpError(500, error.message);

    // Contagem de confirmados por jogo: enquanto o RSVP está aberto e ainda não
    // fechado, a presença de verdade vive em rsvp_respostas — game_players só é sincronizado no
    // "Fechar presença" (routes/rsvp.js). Fora disso (sem RSVP, ou já fechado), vale game_players,
    // como sempre (o "Vou" simples de Jogo.jsx/Inicio.jsx escreve direto nele).
    const ids = (games || []).map((g) => g.id);
    const idsComRsvpAberto = new Set((games || []).filter((g) => g.rsvp_aberto && !g.rsvp_fechado).map((g) => g.id));
    const idsSemRsvpAberto = ids.filter((id) => !idsComRsvpAberto.has(id));
    const counts = {};
    const [gpResult, rsvpResult] = await Promise.all([
      idsSemRsvpAberto.length
        ? supabase.from('game_players').select('game_id, confirmado').in('game_id', idsSemRsvpAberto)
        : Promise.resolve({ data: [] }),
      idsComRsvpAberto.size
        ? supabase.from('rsvp_respostas').select('game_id, status').in('game_id', [...idsComRsvpAberto])
        : Promise.resolve({ data: [] }),
    ]);
    for (const row of gpResult.data || []) {
      if (row.confirmado) counts[row.game_id] = (counts[row.game_id] || 0) + 1;
    }
    for (const row of rsvpResult.data || []) {
      if (row.status === 'confirmado') counts[row.game_id] = (counts[row.game_id] || 0) + 1;
    }

    const lista = (games || []).map((g) => ({
      ...g,
      status: statusEfetivoJogo(g),
      cancelado: !!g.cancelado || g.status === 'cancelado',
      confirmados: counts[g.id] || 0,
    }));
    res.json({ team: { ...team, fuso: fusoDoTime(team), role }, games: lista });
  })
);

/**
 * GET /api/games/my-invites — todos os jogos das equipas do utilizador.
 * Registado ANTES de /api/games/:id para não colidir com o param :id.
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
    if (!role) throw new HttpError(403, 'Não é membro deste time.');

    // Estas 4 leituras não dependem umas das outras (só de game.id/
    // game.teams.id, já conhecidos) — em paralelo, não uma round-trip a seguir à
    // outra.
    const [gpResult, inativosResult, golsResult, votosResult] = await Promise.all([
      supabase
        .from('game_players')
        .select('confirmado, goleiro, cabeca_chave, users ( id, nome, nome_jogador, email, avatar_url, avatar_generico )')
        .eq('game_id', game.id),
      // Inactivos da equipa: preservados no histórico mas fora do sorteio.
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
      gols,
      meuEstado: meu
        ? { confirmado: meu.confirmado, goleiro: meu.goleiro, cabeca_chave: meu.cabeca_chave }
        : null,
      jaVotei: (votosCount || 0) > 0,
    });
  })
);

/**
 * POST /api/games/:id/link-curto — o código do link curto do sorteio (futtyapp.com.br/s/<código>), criado na primeira vez.
 * Qualquer membro do time (quem compartilha o sorteio no grupo). { codigo } — null sem a migração 078: o app manda o link longo.
 */
router.post(
  '/api/games/:id/link-curto',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');
    const role = await getRole(game.team_id, req.user.id);
    if (!role) throw new HttpError(403, 'Você não é membro deste time.');
    res.json({ codigo: await codigoDoSorteio(supabase, game.id) });
  })
);

/**
 * GET /api/s/:codigo — para onde o link curto do sorteio leva: { slug, gameId } (sem login, como a vista pública /api/p/).
 * O app troca /s/<código> por /p/<slug>/<id>, a página de sempre. Código inexistente (ou sem a 078) = 404.
 */
router.get(
  '/api/s/:codigo',
  asyncHandler(async (req, res) => {
    const gameId = await jogoDoCodigo(supabase, req.params.codigo);
    const game = gameId ? await loadGame(gameId) : null;
    if (!game || !game.teams) throw new HttpError(404, 'Esse sorteio não existe.');
    res.json({ slug: game.teams.slug, gameId: game.id });
  })
);

/**
 * GET /api/p/:gameId — vista pública do sorteio (sem auth, para partilha/telão).
 * Devolve só o essencial: nome da equipa, times do sorteio e o resultado.
 */
router.get(
  '/api/p/:gameId',
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.gameId);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    let gols = [];
    if (game.resultado_nivel === 3) {
      const { data } = await supabase
        .from('gols_jogadores')
        .select('user_id, gols, users ( nome, nome_jogador )')
        .eq('game_id', game.id);
      // O apelido, não o nome completo: quem recebe o link não é do time.
      gols = (data || []).map((g) => ({ user_id: g.user_id, gols: g.gols || 0, nome: g.users ? nomePublico(g.users) : null }));
    }

    // PRIVACIDADE /p/ (Opção B): decide POR JOGADOR se o rosto entra — adulto E
    // consentimento → URL do proxy público; senão silhueta (fail-closed). O snapshot
    // times_resultado só tem user_id/avatar_url, por isso juntamos os donos aqui.
    if (game.times_resultado) {
      const ids = new Set();
      const colher = (j) => { if (j && j.user_id) ids.add(j.user_id); };
      (game.times_resultado.times || []).forEach((t) => (t.jogadores || []).forEach(colher));
      (game.times_resultado.reservas || []).forEach(colher);
      const original = game.times_resultado.registro?.original;
      (original?.times || []).forEach((t) => (t.jogadores || []).forEach(colher));
      (original?.reservas || []).forEach(colher);
      // Quem sorteou/ajustou também aparece no selo do registro: os nomes deles seguem a mesma regra do apelido.
      const reg = game.times_resultado.registro;
      [reg?.por, ...((reg?.ajustes) || []).map((a) => a?.por)].forEach((p) => { if (p && p.id) ids.add(p.id); });
      const usersById = new Map();
      if (ids.size) {
        // Se a coluna mostrar_rosto_publico ainda não existir (DDL por correr), a query
        // devolve erro → mapa vazio → TODOS caem em silhueta (fail-closed, seguro).
        const { data: donos } = await supabase
          .from('users')
          .select('id, nome, nome_jogador, birthdate, mostrar_rosto_publico, avatar_url')
          .in('id', [...ids]);
        (donos || []).forEach((u) => usersById.set(u.id, u));
      }
      // A foto de hoje, não a de quando o sorteio foi feito (utils/avataresDoSorteio.js); a regra de
      // privacidade abaixo decide depois se ela pode aparecer.
      game.times_resultado = comAvataresAtuais(game.times_resultado, new Map([...usersById].map(([id, u]) => [id, u.avatar_url || null])));
      // O apelido de hoje, nunca o nome completo (utils/nomePublico.js): o snapshot guarda o nome de quando o sorteio foi feito.
      const nomesPublicos = mapaDeNomesPublicos([...usersById.values()]);
      game.times_resultado = comNomesPublicos(game.times_resultado, nomesPublicos);
      aplicarRostoPublico(game.times_resultado, usersById, `${req.protocol}://${req.get('host')}`);
      if (game.times_resultado.registro) game.times_resultado = { ...game.times_resultado, registro: registroPublico(game.times_resultado.registro, nomesPublicos) };
    }

    res.json({
      // logo_url: a prévia do link (functions/_shared/previaDoLink.js) usa o
      // logo do time como og:image quando existe — "o mínimo" para a prévia parar de ser genérica.
      // cidade: o rabicho do fuso ("horário de São Paulo") precisa dela.
      // cor: o resultado já montado (DrawnTeams) pinta o cabeçalho de cada time com ela.
      equipa: { nome: game.teams.nome, slug: game.teams.slug, cor: game.teams.cor || null, fuso: fusoDoTime(game.teams), cidade: game.teams.cidade || null, logo_url: game.teams.logo_url || null },
      // jogo: quando e onde — a informação que quem recebe o link no grupo foi mesmo procurar,
      // além do time e dos times sorteados.
      jogo: { data: game.data || null, local: game.local || null },
      times_resultado: game.times_resultado || null,
      resultado: {
        nivel: game.resultado_nivel || 0,
        time_vencedor: game.time_vencedor || null,
        placar_a: game.placar_a ?? null,
        placar_b: game.placar_b ?? null,
        gols,
      },
    });
  })
);

/**
 * POST /api/games/:id/partilha-declarada — TERMO de quem partilha (1-clique).
 * Registo de auditoria: quem copiou/partilhou o link declarou ter o direito de o
 * fazer. NÃO altera a privacidade (a regra de rosto é independente e sempre ligada);
 * é só a cobertura legal. Idempotente (upsert por game+user).
 */
router.post(
  '/api/games/:id/partilha-declarada',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');
    // só quem tem papel na equipa (membro/admin) pode declarar a partilha
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
    if (!role) throw new HttpError(403, 'Não é membro deste time.');
    // Quem só organiza o time não entra na lista de presença (desmarcar continua valendo).
    if (confirmado && (await soOrganiza(game.teams.id, req.user.id))) throw new HttpError(403, MSG_SO_ORGANIZA);

    await ensureUserRow(req.user);

    let ehGoleiro = !!goleiro;
    if (goleiro == null) {
      const { data: linha } = await supabase
        .from('game_players')
        .select('goleiro')
        .eq('game_id', game.id)
        .eq('user_id', req.user.id)
        .maybeSingle();
      ehGoleiro = linha ? !!linha.goleiro : (await goleirosDoTime(game.teams.id, [req.user.id])).has(req.user.id);
    }

    const { error } = await supabase.from('game_players').upsert(
      { game_id: game.id, user_id: req.user.id, confirmado: !!confirmado, goleiro: ehGoleiro },
      { onConflict: 'game_id,user_id' }
    );
    if (error) throw new HttpError(500, error.message);

    res.json({ meuEstado: { confirmado: !!confirmado, goleiro: ehGoleiro } });
  })
);

/**
 * POST /api/games/:id/presencas — ADMIN marca quem jogou (jogo manual/retroativo).
 * Distinto do self-confirm: aqui o ADMIN da equipa marca a presença de TERCEIROS a
 * partir de uma checklist. Autoritativo: os user_id enviados ficam confirmados; os
 * membros confirmados que NÃO vierem na lista são desmarcados (a lista é a verdade).
 * Body: { jogadores: [{ user_id, goleiro? }] }. Só membros da equipa entram.
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
    // valida que cada user_id é membro da equipa
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

/**
 * POST /api/games/:id/times-manuais — ADMIN define os times À MÃO (jogo manual/retroativo).
 * Grava direto em times_resultado (mesma forma que o sorteio produz) SEM passar pelo
 * endpoint de sorteio e SEM `seed` (sem replay/cerimónia — LEI). Convidados sem app
 * entram como nome solto (user_id null). Membros têm de estar confirmados (presenças
 * marcadas primeiro). NÃO notifica.
 * Body: { times: [{ nome, jogadores:[{user_id?, nome, avatar_url?, convidado?}] }], reservas? }
 */
router.post(
  '/api/games/:id/times-manuais',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');
    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem definir os times.');

    const times = limparTimes(req.body?.times, req, (i) => NOMES_TIMES[i] || `Time ${i + 1}`);
    const reservas = limparReservas(req.body?.reservas, req);
    const todos = [...times.flatMap((t) => t.jogadores || []), ...reservas];
    const ids = todos.map((j) => j.user_id).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Há jogadores repetidos entre os times.');

    // Membros (com user_id) têm de estar confirmados neste jogo (presenças marcadas antes).
    const { data: gp } = await supabase.from('game_players').select('user_id').eq('game_id', game.id).eq('confirmado', true);
    const confirmados = new Set((gp || []).map((p) => p.user_id));
    for (const id of ids) {
      if (!confirmados.has(id)) throw new HttpError(400, 'Marque as presenças antes: todos os jogadores com conta devem estar confirmados.');
    }

    const tr = {
      num_times: times.length,
      total_jogadores: ids.length + todos.filter((j) => !j.user_id).length,
      manual: true, // sem seed → sem cerimónia/replay (o frontend gateia por seed)
      times,
      reservas,
      registro: registroDeMontagem(await quemFez(req.user.id), new Date().toISOString(), game.times_resultado),
    };

    // Status só vira "em_curso" se a hora do jogo já passou — sorteio
    // feito com antecedência (ou times definidos à mão) não adianta o estado.
    const jaComecou = !!game.data && new Date(game.data).getTime() <= Date.now();
    const patchStatus = jaComecou && game.status !== 'cancelado' ? { status: 'em_curso' } : {};

    const { data: updated, error } = await supabase
      .from('games')
      .update({ times_resultado: tr, num_times: tr.times.length, sorteio_realizado: true, ...patchStatus })
      .eq('id', game.id)
      .select('id, times_resultado, num_times, sorteio_realizado, status')
      .single();
    if (error) throw new HttpError(500, error.message);
    res.json({ game: { ...updated, fuso: fusoDoTime(game.teams) } });
  })
);

/** POST /api/games/:id/sortear — sorteio inteligente dos times (só admin). */
router.post(
  '/api/games/:id/sortear',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem fazer o sorteio.');

    // Jogadores por time: o body pode sobrepor o valor guardado no jogo.
    const { jogadoresIds, jogadoresPorTime } = req.body || {};
    let porTime = game.jogadores_por_time;
    const pptBody = Number(jogadoresPorTime);
    if (Number.isInteger(pptBody) && pptBody >= 1) porTime = pptBody;
    if (!porTime || porTime < 1) {
      throw new HttpError(400, 'Defina os jogadores por time antes de sortear.');
    }

    const usarSubset = Array.isArray(jogadoresIds) && jogadoresIds.length > 0;
    if (usarSubset) {
      // Valida que todos os IDs pertencem à equipa do jogo.
      const { data: membros } = await supabase
        .from('team_members')
        .select('user_id')
        .eq('team_id', game.teams.id)
        .in('user_id', jogadoresIds);
      const validos = new Set((membros || []).map((m) => m.user_id));
      if (jogadoresIds.some((uid) => !validos.has(uid))) {
        throw new HttpError(400, 'Alguns jogadores indicados não pertencem ao time.');
      }
    }

    let gpQuery = supabase
      .from('game_players')
      .select('goleiro, cabeca_chave, users ( id, nome, nome_jogador, email, avatar_url )')
      .eq('game_id', game.id)
      .eq('confirmado', true);
    if (usarSubset) gpQuery = gpQuery.in('user_id', jogadoresIds);
    const { data: gp } = await gpQuery;

    // Exclui jogadores inactivos do sorteio (ficam no histórico, não jogam).
    const { data: inativosRows } = await supabase
      .from('team_members')
      .select('user_id')
      .eq('team_id', game.teams.id)
      .eq('ativo', false);
    const inativos = new Set((inativosRows || []).map((m) => m.user_id));
    // O sorteio só recebe quem joga — quem só organiza o time fica de fora (utils/soOrganiza.js).
    const organizam = await idsQueSoOrganizam(game.teams.id);
    const confirmados = (gp || []).filter((p) => p.users && !inativos.has(p.users.id) && !organizam.has(p.users.id));

    // (o mínimo de 2 times valida-se mais abaixo, já com os convidados contados)

    const userIds = confirmados.map((p) => p.users.id);
    const ratings = await computeRatings(game.teams.id, userIds);
    const toPlayer = (p) => ({
      user_id: p.users.id,
      nome: nomePublico(p.users), // o snapshot alimenta o cartão 9:16 e a página pública: apelido, ou só o primeiro nome
      avatar_url: p.users.avatar_url || null,
      rating: round1(ratings[p.users.id] ?? RATING_DEFAULT),
      goleiro: p.goleiro,
      cabeca_chave: p.cabeca_chave,
    });

    const all = confirmados.map(toPlayer);

    // CONVIDADOS SEM APP (SPEC-SORTEIO §11): nomes soltos do organizador — entram
    // no sorteio como linha, sem user_id, zero impacto em users/ranking.
    const convidados = Array.isArray(req.body?.convidados)
      ? req.body.convidados.map((n) => (typeof n === 'string' ? n.trim().slice(0, 40) : '')).filter(Boolean).slice(0, 28)
      : [];

    // TECTOS FORMAIS (SPEC-SORTEIO §14): 3..28 participantes; 2..4 times.
    const totalParticipantes = all.length + convidados.length;
    if (totalParticipantes < 3) {
      throw new HttpError(400, 'São precisos pelo menos 3 jogadores para sortear.');
    }
    if (Math.floor(totalParticipantes / porTime) < 2) {
      throw new HttpError(400, `São precisos pelo menos ${porTime * 2} jogadores (${porTime} por time) para formar 2 times. Há ${totalParticipantes} (confirmados + convidados).`);
    }
    if (totalParticipantes > 28) {
      throw new HttpError(400, 'Máximo de 28 jogadores por sorteio (28 = 4 times de 7).');
    }
    if (Math.floor(totalParticipantes / porTime) < 2) {
      throw new HttpError(400, );
    }
    if (Math.floor(totalParticipantes / porTime) > 4) {
      throw new HttpError(400, 'Máximo de 4 times por sorteio: aumente os jogadores por time.');
    }

    // Sorteio: lógica completa em utils/sorteio.js (goleiros/cabeças 1 por time,
    // excesso vira linha, linha por snake draft, sobra vai para reservas).
    // A SEMENTE (SPEC §10) fica no resultado → replay exacto da animação.
    const sorteio = executarSorteio(all, porTime, { convidados });

    const avisos = [];
    const totalGoleiros = all.filter((p) => p.goleiro).length;
    if (totalGoleiros > 0 && totalGoleiros < sorteio.numTimes) {
      avisos.push(
        `Há ${totalGoleiros} goleiro(s) para ${sorteio.numTimes} times: ${sorteio.numTimes - totalGoleiros} time(s) ficam sem goleiro.`
      );
    }

    const times = sorteio.times.map((jogadores, i) => {
      const media = jogadores.length
        ? jogadores.reduce((s, j) => s + j.rating, 0) / jogadores.length
        : 0;
      return {
        nome: NOMES_TIMES[i] || `Time ${i + 1}`,
        rating_medio: Math.round(media * 100) / 100,
        jogadores,
      };
    });

    const resultado = {
      num_times: sorteio.numTimes,
      total_jogadores: confirmados.length + convidados.length,
      convidados_total: convidados.length,
      seed: sorteio.seed, // replay EXACTO da animação (SPEC-SORTEIO §10)
      avisos,
      times,
      reservas: sorteio.reservas,
      registro: registroDeSorteio(await quemFez(req.user.id), new Date().toISOString(), game.times_resultado),
    };

    // Status só vira "em_curso" se a hora do jogo já passou — sorteio
    // feito com antecedência não adianta o estado (fica "agendado" + chip de
    // times sorteados no frontend).
    const jaComecou = !!game.data && new Date(game.data).getTime() <= Date.now();
    const patchStatus = jaComecou && game.status !== 'cancelado' ? { status: 'em_curso' } : {};

    const { data: updated, error } = await supabase
      .from('games')
      .update({ jogadores_por_time: porTime, num_times: sorteio.numTimes, sorteio_realizado: true, times_resultado: resultado, ...patchStatus })
      .eq('id', game.id)
      .select()
      .single();
    if (error) throw new HttpError(500, error.message);

    res.json({
      game: {
        id: updated.id,
        fuso: fusoDoTime(game.teams),
        num_times: sorteio.numTimes,
        sorteio_realizado: true,
        times_resultado: resultado,
        status: updated.status,
      },
    });

    // Notifica os confirmados do jogo (fire-and-forget).
    const confirmadosIds = confirmados.map((p) => p.users.id);
    enviarNotificacao(confirmadosIds, {
      title: '🎲 Sorteio realizado!',
      body: `O sorteio de ${game.local || 'Jogo'} está pronto`,
      url: `/time/${game.teams.slug}/jogo/${game.id}`,
    }, { categoria: 'jogos' });
  })
);

/** PATCH /api/games/:id/times — ajuste manual dos times pós-sorteio (só admin). */
router.patch(
  '/api/games/:id/times',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem ajustar os times.');

    const corpoTimes = req.body?.times_resultado;
    if (!corpoTimes || !Array.isArray(corpoTimes.times)) throw new HttpError(400, 'times_resultado inválido.');
    // Do corpo só valem os times e as reservas, reconstruídos com tipo e teto (utils/timesDoCorpo.js); cada time tem pelo menos 1 jogador.
    const tr = { times: limparTimes(corpoTimes.times, req, (i) => NOMES_TIMES[i] || `Time ${i + 1}`) };
    const reservas = limparReservas(corpoTimes.reservas, req);

    // Recolhe todos os jogadores (times + reservas) e valida duplicados. Quem tem conta, pelo id; o convidado sem app
    // (sem id), pelo nome — é por ele que o registro do ajuste o reconhece (utils/registroDoSorteio.js), e dois "Beto"
    // no mesmo resultado viram uma pessoa só nas trocas.
    const todos = [...tr.times.flatMap((t) => t.jogadores || []), ...reservas];
    const ids = todos.map((j) => j.user_id).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Há jogadores repetidos entre os times.');
    const nomesDeConvidados = todos.filter((j) => j && !j.user_id).map((j) => String(j.nome || '').trim().toLowerCase());
    const repetido = nomesDeConvidados.find((n, i) => nomesDeConvidados.indexOf(n) !== i);
    if (repetido != null) {
      const nome = todos.find((j) => j && !j.user_id && String(j.nome || '').trim().toLowerCase() === repetido)?.nome || repetido;
      throw new HttpError(400, `O convidado "${String(nome).trim()}" aparece duas vezes nos times.`);
    }

    // Todos têm de ser confirmados deste jogo.
    const { data: gp } = await supabase
      .from('game_players')
      .select('user_id')
      .eq('game_id', game.id)
      .eq('confirmado', true);
    const confirmados = new Set((gp || []).map((p) => p.user_id));
    for (const id of ids) {
      if (!confirmados.has(id)) throw new HttpError(400, 'Todos os jogadores devem estar confirmados no jogo.');
    }

    // Do corpo só valem os times e as reservas: o registro (quem sorteou, o original, os ajustes) é do motor —
    // um app que mandasse o resultado sem ele apagaria a marca do ajuste.
    const novo = resultadoAjustado(game.times_resultado, { times: tr.times, reservas }, await quemFez(req.user.id), new Date().toISOString());
    novo.total_jogadores = tr.times.reduce((s, t) => s + (t.jogadores || []).length, 0);

    const { data: updated, error } = await supabase
      .from('games')
      .update({ times_resultado: novo, num_times: novo.times.length })
      .eq('id', game.id)
      .select('times_resultado')
      .single();
    if (error) throw new HttpError(500, error.message);

    res.json({ times_resultado: updated.times_resultado });
  })
);

// NOTA: a votação por jogo (POST /api/games/:id/votar) foi removida — o novo
// modelo é 1 voto por (votante, votado, equipa), gerido em routes/ranking.js.

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

    if (!Object.keys(patch).length) throw new HttpError(400, 'Nada para atualizar.');

    const { data: updated, error } = await supabase.from('games').update(patch).eq('id', game.id).select().single();
    if (error) throw new HttpError(500, error.message);
    res.json({ game: { ...updated, fuso: fusoDoTime(game.teams) } });
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

    // Notifica todos os membros da equipa (fire-and-forget, após responder).
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

    // Jogos já existentes da equipa (para detetar colisões ± 1 hora).
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

    if (aInserir.length) {
      const { error } = await supabase.from('games').insert(aInserir);
      if (error) throw new HttpError(500, error.message);
    }

    res.status(201).json({ criados: aInserir.length, datas: criadas, ignorados, fuso });

    // Notifica os membros se algo foi criado (fire-and-forget).
    if (aInserir.length) {
      membrosDaEquipa(team.id).then((memberIds) =>
        enviarNotificacao(memberIds, {
          title: '⚽ Novos jogos agendados',
          body: `${team.nome || 'Seu time'} · ${aInserir.length} jogos nas próximas semanas`,
          url: '/home',
        }, { categoria: 'jogos' })
      );
    }
  })
);

// ─── Associar jogador: o convidado sem app vira a conta de um membro do time ────────────────────────────────────────
// A troca vive em utils/associarJogador.js. Aqui a ORDEM das gravações: gols, presença e campeonatos primeiro, e o `times_resultado` por
// último — é ele que diz "já foi associado", então um pedido que caiu no meio simplesmente se repete e termina o serviço (cada passo é
// idempotente). Sem transação no PostgREST, é isto que mantém o jogo inteiro ou intacto.

const MSG_SO_ADMIN_ASSOCIA = 'Só admins podem associar jogadores.';

/** Os membros do time como a lista "Associar jogador" os mostra: apelido e foto, nunca o e-mail. */
async function membrosParaAssociar(teamId) {
  // Uma leitura que falha é erro, não "ninguém no time": a janela mostraria a lista vazia como se fosse verdade.
  const { data, error } = await supabase
    .from('team_members')
    .select('user_id, users ( id, nome, nome_jogador, avatar_url, avatar_generico )')
    .eq('team_id', teamId);
  if (error) throw new HttpError(500, error.message);
  return (data || []).filter((m) => m.users).map((m) => ({
    user_id: m.user_id,
    nome: nomePublico(m.users),
    avatar_url: m.users.avatar_url || null,
    avatar_generico: m.users.avatar_generico || null,
  }));
}

/** As linhas de gols do jogo: as de quem tem conta (user_id) e as dos convidados (pelo nome). */
async function golsDoJogo(gameId) {
  const { data } = await supabase.from('gols_jogadores').select('id, user_id, convidado_nome').eq('game_id', gameId);
  return data || [];
}

/** Os campeonatos que nasceram do sorteio deste jogo (comparando com o `times_resultado` que o jogo tem AGORA). */
async function campeonatosDoSorteio(team, game) {
  const todos = await campeonatos.listar(team.id);
  return todos.filter((c) => campeonatos.campeonatoVemDoSorteio(c, game));
}

/** Grava o plantel trocado de um campeonato (e atualiza o post do campeão, se já houve campeão). */
async function guardarCampeonatoAssociado(team, camp, autorId, novaAssinatura) {
  if (camp.origem_game_id) camp.origem_assinatura = novaAssinatura;
  if (camp.estado === 'terminado') {
    const postId = await sincronizarPostDoCampeao({ supabase, team, camp, autorId });
    if (postId) camp.post_id = postId;
  }
  await campeonatos.guardar(camp);
}

/**
 * GET /api/games/:id/associar-jogador — só admin. O que a tela "Associar jogador" precisa: os convidados sem app do jogo, os membros do
 * time (com o motivo de quem não pode ser escolhido) e as associações que ainda dá para desfazer.
 */
router.get(
  '/api/games/:id/associar-jogador',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');
    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, MSG_SO_ADMIN_ASSOCIA);

    const tr = game.times_resultado;
    const [membros, gols, jogosDoTime] = await Promise.all([membrosParaAssociar(game.teams.id), golsDoJogo(game.id), jogosDoTimeComTimes(game.teams.id)]);
    const comGols = new Set(gols.map((g) => g.user_id).filter(Boolean));
    const lista = membros.map((m) => {
      const motivo = membroNoResultado(tr, m.user_id) ? 'Já está neste jogo' : comGols.has(m.user_id) ? 'Já tem gols neste jogo' : null;
      return { ...m, disponivel: !motivo, motivo };
    }).sort((a, b) => (Number(b.disponivel) - Number(a.disponivel)) || a.nome.localeCompare(b.nome, 'pt-BR'));
    // `outros_jogos`: em quantos OUTROS jogos do time o mesmo nome aparece como convidado — é o "Associar em todos?" da tela.
    const convidados = convidadosDoJogo(tr).map((c) => ({ ...c, outros_jogos: outrosJogosDoConvidado(jogosDoTime, game.id, c.nome).length }));

    res.json({ convidados, membros: lista, desfaziveis: associacoesDesfaziveis(tr) });
  })
);

/**
 * Os outros jogos do time em que há um convidado sem app com este nome (a mesma regra de nome do Associar: nomeNorm), o mais recente
 * primeiro. Jogo cancelado não conta. `jogos` = os jogos do time com sorteio, já lidos (uma leitura serve a todos os convidados).
 */
function outrosJogosDoConvidado(jogos, gameId, nome) {
  return (jogos || [])
    .filter((g) => g.id !== gameId && !g.cancelado && g.status !== 'cancelado' && acharConvidado(g.times_resultado, nome))
    .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')));
}

/** Os jogos do time com sorteio (ou times anotados): o que "Associar em todos" percorre. */
async function jogosDoTimeComTimes(teamId) {
  const { data, error } = await supabase.from('games').select('id, data, status, cancelado, times_resultado').eq('team_id', teamId).not('times_resultado', 'is', null);
  if (error) throw new HttpError(500, error.message);
  return data || [];
}

/**
 * A associação num jogo: o convidado sem app `nomeConvidado` passa a ser o membro. Devolve o que a rota responde; lança HttpError quando
 * não dá (o membro já está no jogo, já tem gols nele, o convidado não está lá). `campeonatosDoTime`: a lista já lida, para "Associar em
 * todos" não reler o Storage a cada jogo.
 */
async function associarNoJogo({ game, team, nomeConvidado, userId, membro, autorId, por, campeonatosDoTime = null }) {
  const tr = game.times_resultado;
  const achado = acharConvidado(tr, nomeConvidado);
  if (!achado) {
    // Já foi feito (o pedido caiu depois de gravar, ou o admin tocou duas vezes): não há o que repetir.
    const feita = associacaoAtiva(tr, userId);
    if (feita && nomeNorm(feita.convidado?.nome) === nomeNorm(nomeConvidado)) {
      return { ok: true, ja_associado: true, user_id: userId, nome: membro.nome, convidado_nome: feita.convidado?.nome || nomeConvidado };
    }
    if (todosOsJogadores(tr).some((j) => j.user_id && nomeNorm(j.nome) === nomeNorm(nomeConvidado))) {
      throw new HttpError(400, 'Esse jogador já tem conta; não precisa associar.');
    }
    throw new HttpError(404, 'Esse convidado não está neste jogo.');
  }
  if (membroNoResultado(tr, userId)) throw new HttpError(400, `${membro.nome} já está neste jogo; um jogador não ocupa duas vagas.`);

  const [gols, presencaAntes] = await Promise.all([
    golsDoJogo(game.id),
    supabase.from('game_players').select('user_id, confirmado').eq('game_id', game.id).eq('user_id', userId).maybeSingle().then((r) => r.data || null),
  ]);

  const agora = new Date().toISOString();
  const { tr: novoTr } = trocarNoResultado(tr, ehEsteConvidado(nomeConvidado), (j) => jogadorComConta(j, membro));
  const novaAssinatura = campeonatos.assinaturaDosTimes(novoTr.times);

  // 1) os gols do convidado ganham a conta (uma conta só tem uma linha de gols por jogo: se o membro já tem a dele, não dá para juntar)
  const golsDele = gols.filter((g) => !g.user_id && nomeNorm(g.convidado_nome) === nomeNorm(nomeConvidado)).map((g) => g.id);
  if (golsDele.length && gols.some((g) => g.user_id === userId)) throw new HttpError(400, `${membro.nome} já tem gols neste jogo.`);
  if (golsDele.length) {
    const { error } = await supabase.from('gols_jogadores').update({ user_id: userId, convidado_nome: null }).in('id', golsDele);
    if (error) throw new HttpError(500, error.message);
  }

  // 2) a presença: o mesmo registro que o ranking e a lista de presença já usam (um por jogo e jogador, sem duplicar)
  if (!presencaAntes) {
    const { error } = await supabase.from('game_players').insert({ game_id: game.id, user_id: userId, confirmado: true, goleiro: achado.jogador.goleiro === true });
    if (error) throw new HttpError(500, error.message);
  } else if (!presencaAntes.confirmado) {
    const { error } = await supabase.from('game_players').update({ confirmado: true }).eq('game_id', game.id).eq('user_id', userId);
    if (error) throw new HttpError(500, error.message);
  }

  // 3) o elenco dos campeonatos nascidos deste sorteio: é ele que dá o selo (campeão, vice, 3º) e o "Você é campeão!"
  let nCampeonatos = 0;
  const doSorteio = campeonatosDoTime
    ? campeonatosDoTime.filter((c) => campeonatos.campeonatoVemDoSorteio(c, game))
    : await campeonatosDoSorteio(team, game);
  for (const camp of doSorteio) {
    const { camp: novo, trocou } = trocarNoPlantel(camp, ehEsteConvidado(nomeConvidado), () => ({ user_id: userId, nome: membro.nome, avatar_url: membro.avatar_url, convidado: false }));
    if (!trocou) continue;
    await guardarCampeonatoAssociado(team, novo, autorId, novaAssinatura);
    nCampeonatos += 1;
  }

  // 4) o sorteio do jogo, por último (é o que marca "feito"); o registro guarda quem fez, quando e o que havia antes, para o Desfazer
  const antes = Array.isArray(tr?.registro?.associacoes) ? tr.registro.associacoes : [];
  const associacao = {
    por,
    em: agora,
    user_id: userId,
    nome: membro.nome,
    convidado: achado.jogador,
    onde: achado.reserva ? { reserva: true } : { time: achado.time },
    presenca_antes: presencaAntes ? !!presencaAntes.confirmado : null,
    gols: golsDele.length,
  };
  novoTr.registro = registroComAssociacoes(novoTr.registro || registroDe(tr), [...antes, associacao]);
  const { error: erroJogo } = await supabase.from('games').update({ times_resultado: novoTr }).eq('id', game.id);
  if (erroJogo) throw new HttpError(500, erroJogo.message);

  return {
    ok: true, ja_associado: false, user_id: userId, nome: membro.nome, convidado_nome: achado.jogador.nome,
    gols: golsDele.length, campeonatos: nCampeonatos, desfazer_ate: new Date(new Date(agora).getTime() + JANELA_DESFAZER_MS).toISOString(),
  };
}

/**
 * POST /api/games/:id/associar-jogador — só admin. O convidado sem app `convidado_nome` do jogo passa a ser o membro `user_id`: no
 * sorteio (mesma posição e time), nos gols, na presença e no plantel dos campeonatos que nasceram deste sorteio. Idempotente.
 * Body: { convidado_nome, user_id, em_todos? }
 * `em_todos: true` faz o mesmo em cada OUTRO jogo do time em que há um convidado com o mesmo nome (cada jogo com o seu Desfazer de 24 h).
 * Um jogo em que não dá (o membro já está nele, já tem gols nele) fica de fora e volta em `em_todos.pulados`, com o motivo.
 */
router.post(
  '/api/games/:id/associar-jogador',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');
    const team = game.teams;
    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, MSG_SO_ADMIN_ASSOCIA);

    const nomeConvidado = textoCurto(req.body?.convidado_nome, 60, 'Nome do convidado');
    const userId = req.body?.user_id;
    if (!nomeConvidado) throw new HttpError(400, 'Indique qual convidado.');
    if (!ehUuid(userId)) throw new HttpError(400, 'Indique quem vai ocupar a vaga.');

    // O membro tem de ser DESTE time: a conta de outro time não ganharia selo nem presença aqui.
    const membro = (await membrosParaAssociar(team.id)).find((m) => m.user_id === userId);
    if (!membro) throw new HttpError(403, 'Esse jogador não é do time.');

    const por = await quemFez(req.user.id);
    const emTodos = req.body?.em_todos === true;
    const campeonatosDoTime = emTodos ? await campeonatos.listar(team.id) : null;
    const resposta = await associarNoJogo({ game, team, nomeConvidado, userId, membro, autorId: req.user.id, por, campeonatosDoTime });

    if (emTodos) {
      // Só nomes iguais (nomeNorm) e só neste time; um jogo de cada vez, para a presença e o plantel nunca brigarem entre si.
      const outros = outrosJogosDoConvidado(await jogosDoTimeComTimes(team.id), game.id, nomeConvidado);
      let associados = 0;
      const pulados = [];
      for (const g of outros) {
        try {
          await associarNoJogo({ game: g, team, nomeConvidado, userId, membro, autorId: req.user.id, por, campeonatosDoTime });
          associados += 1;
        } catch (e) {
          if (!(e instanceof HttpError) || e.status >= 500) console.error('[associar em todos] jogo', g.id, e?.message || e);
          pulados.push({ game_id: g.id, data: g.data, motivo: e instanceof HttpError && e.status < 500 ? e.message : 'Não deu para gravar este jogo agora.' });
        }
      }
      resposta.em_todos = { associados, pulados };
    }

    selosCache.invalidarMembro(team.id, userId);
    selosCache.invalidarEquipa(team.id);
    res.json(resposta);
  })
);

/**
 * POST /api/games/:id/associar-jogador/desfazer — só admin, até 24 h depois. Devolve o convidado ao lugar dele: sorteio, gols, presença
 * (só se foi a associação que a criou) e plantel dos campeonatos. Idempotente.
 * Body: { user_id }
 */
router.post(
  '/api/games/:id/associar-jogador/desfazer',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');
    const team = game.teams;
    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, MSG_SO_ADMIN_ASSOCIA);

    const userId = req.body?.user_id;
    if (!ehUuid(userId)) throw new HttpError(400, 'Indique qual jogador.');

    const tr = game.times_resultado;
    const lista = Array.isArray(tr?.registro?.associacoes) ? tr.registro.associacoes : [];
    const ultima = [...lista].reverse().find((a) => a?.user_id === userId);
    if (!ultima) throw new HttpError(404, 'Esse jogador não foi associado neste jogo.');
    if (ultima.desfeita_em) return res.json({ ok: true, ja_desfeito: true, user_id: userId });
    if (!podeDesfazer(ultima)) throw new HttpError(400, 'O Desfazer vale por 24 horas depois de associar.');

    const convidado = ultima.convidado;
    const { tr: novoTr, trocou } = trocarNoResultado(tr, ehEsteMembro(userId), () => convidado);
    if (!trocou) throw new HttpError(400, 'Esse jogador já não está nos times deste jogo.');
    const novaAssinatura = campeonatos.assinaturaDosTimes(novoTr.times);

    const golsDele = (await golsDoJogo(game.id)).filter((g) => g.user_id === userId).map((g) => g.id);
    if (golsDele.length) {
      const { error } = await supabase.from('gols_jogadores').update({ user_id: null, convidado_nome: convidado.nome }).in('id', golsDele);
      if (error) throw new HttpError(500, error.message);
    }

    // a presença só sai se foi a associação que a criou (ou que a confirmou); a que já existia fica como estava
    if (ultima.presenca_antes === null) {
      await supabase.from('game_players').delete().eq('game_id', game.id).eq('user_id', userId);
    } else if (ultima.presenca_antes === false) {
      await supabase.from('game_players').update({ confirmado: false }).eq('game_id', game.id).eq('user_id', userId);
    }

    let nCampeonatos = 0;
    for (const camp of await campeonatosDoSorteio(team, game)) {
      const { camp: novo, trocou: mexeu } = trocarNoPlantel(camp, ehEsteMembro(userId), () => ({ user_id: null, nome: convidado.nome, avatar_url: convidado.avatar_url || null, convidado: true }));
      if (!mexeu) continue;
      await guardarCampeonatoAssociado(team, novo, req.user.id, novaAssinatura);
      nCampeonatos += 1;
    }

    novoTr.registro = registroComAssociacoes(novoTr.registro, lista.map((a) => (a === ultima ? { ...a, desfeita_em: new Date().toISOString() } : a)));
    const { error: erroJogo } = await supabase.from('games').update({ times_resultado: novoTr }).eq('id', game.id);
    if (erroJogo) throw new HttpError(500, erroJogo.message);

    selosCache.invalidarMembro(team.id, userId);
    selosCache.invalidarEquipa(team.id);
    res.json({ ok: true, ja_desfeito: false, user_id: userId, convidado_nome: convidado.nome, gols: golsDele.length, campeonatos: nCampeonatos });
  })
);

module.exports = router;
