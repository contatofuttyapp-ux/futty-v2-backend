// Futty v2.0 — Os times do jogo: montar à mão, sortear e trocar os times. Montadas por routes/games.js.

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, getRole, loadGame, computeRatings } = require('../utils/db');
const { RATING_DEFAULT } = require('../utils/helpers');
const { pedidoNaReguaDe10 } = require('../utils/notaDoVoto');
const { executarSorteio } = require('../utils/sorteio');
const { nomePublico } = require('../utils/nomePublico');
const { enviarNotificacao } = require('./push');
const { idsQueSoOrganizam } = require('../utils/soOrganiza');
const { fusoDoTime } = require('../utils/fuso');
const { registroDeSorteio, registroDeMontagem, resultadoAjustado } = require('../utils/registroDoSorteio');
const { limparTimes, limparReservas } = require('../utils/timesDoCorpo'); // os times que o app manda à mão
const { quemFez, round1 } = require('../utils/ajudaDoJogo');
const { MAX_CONVIDADOS, limparConvidados, convidadosGuardados, nomeRepetido, semAColuna } = require('../utils/convidadosDoJogo'); // os convidados sem app guardados no jogo

const router = express.Router();

// O número de cada jogador no sorteio (rating, rating_medio) é uma foto da nota naquele dia. Resultado com esta marca está na régua de
// 0 a 10; o que foi gravado antes dela está em estrelas (0,5 a 5) e as telas leem × 2.
const ESCALA_NOTA = 10;

const NOMES_TIMES = ['Time A', 'Time B', 'Time C', 'Time D', 'Time E', 'Time F'];

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
      escala_nota: ESCALA_NOTA,
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

/**
 * PUT /api/games/:id/convidados — ADMIN grava a lista de convidados sem app do jogo ("Alguém sem o app vai jogar?"), com as marcas do
 * sorteio. A lista inteira substitui a de antes (é o que a tela mostra). Não mexe nos times já sorteados: vale para o próximo sorteio.
 * Body: { convidados: [{ nome, goleiro?, cabeca_chave? }] }
 */
router.put(
  '/api/games/:id/convidados',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');
    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem mudar os convidados.');

    if (!Array.isArray(req.body?.convidados)) throw new HttpError(400, 'Mande a lista de convidados.');
    if (req.body.convidados.length > MAX_CONVIDADOS) throw new HttpError(400, `Máximo de ${MAX_CONVIDADOS} convidados por jogo.`);
    const convidados = limparConvidados(req.body.convidados);
    // Dois convidados com o mesmo nome viram uma pessoa só nos times, nos gols e no Associar: o admin põe um sobrenome ou um apelido.
    const repetido = nomeRepetido(convidados);
    if (repetido) throw new HttpError(400, `"${repetido}" já está na lista. Use um sobrenome ou apelido para diferenciar.`);

    const { error } = await supabase.from('games').update({ convidados }).eq('id', game.id);
    if (semAColuna(error)) throw new HttpError(503, 'Essa opção ainda não está disponível.');
    if (error) throw new HttpError(500, error.message);
    res.json({ convidados });
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
      // Valida que todos os IDs pertencem ao time do jogo.
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

    // Exclui jogadores inativos do sorteio (ficam no histórico, não jogam).
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

    // CONVIDADOS SEM APP (SPEC-SORTEIO §11): sem user_id, zero impacto em users/ranking. Os que o pedido traz (o app antigo manda
    // só os nomes; o novo, com goleiro e cabeça de chave) ou, sem lista no pedido, os guardados no jogo — é o "Sortear de novo" sem
    // digitar tudo de novo (utils/convidadosDoJogo.js).
    const convidados = Array.isArray(req.body?.convidados) ? limparConvidados(req.body.convidados) : convidadosGuardados(game);

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
    if (Math.floor(totalParticipantes / porTime) > 4) {
      throw new HttpError(400, 'Máximo de 4 times por sorteio: aumente os jogadores por time.');
    }

    // Sorteio: lógica completa em utils/sorteio.js (goleiros/cabeças 1 por time,
    // excesso vira linha, linha por snake draft, sobra vai para reservas).
    // A SEMENTE (SPEC §10) fica no resultado → replay exacto da animação.
    const sorteio = executarSorteio(all, porTime, { convidados });

    const avisos = [];
    const totalGoleiros = all.filter((p) => p.goleiro).length + convidados.filter((c) => c.goleiro).length;
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
      escala_nota: ESCALA_NOTA,
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

    // A lista usada fica guardada no jogo (recarregar a página e o "Sortear de novo" partem dela). Sem a coluna (a migração 087 ainda
    // não rodou) o sorteio grava igual, sem ela: a lista continua dentro do sorteio, que é de onde o motor a lê nesse caso.
    const gravarSorteio = (comLista) => supabase
      .from('games')
      .update({ jogadores_por_time: porTime, num_times: sorteio.numTimes, sorteio_realizado: true, times_resultado: resultado, ...patchStatus, ...(comLista ? { convidados } : {}) })
      .eq('id', game.id)
      .select()
      .single();
    let gravado = await gravarSorteio(true);
    if (semAColuna(gravado.error)) gravado = await gravarSorteio(false);
    const { data: updated, error } = gravado;
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
    // As telas novas mandam o número de cada jogador já na régua de 10 (o sorteio antigo, em estrelas, elas leem × 2 antes de editar).
    if (pedidoNaReguaDe10(req)) novo.escala_nota = ESCALA_NOTA;

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

module.exports = router;
