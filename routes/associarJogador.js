// Futty v2.0 — "Associar jogador": o convidado sem app de um jogo vira a conta de um membro do time (e o desfazer). Montadas por
// routes/games.js.

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, getRole, loadGame } = require('../utils/db');
const { nomePublico } = require('../utils/nomePublico');
const { textoCurto, ehUuid } = require('../utils/entrada'); // o que a pessoa digita: texto com teto, número em faixa
const { registroDe } = require('../utils/registroDoSorteio');
const {
  JANELA_DESFAZER_MS, nomeNorm, todosOsJogadores, acharConvidado, convidadosDoJogo, membroNoResultado, trocarNoResultado, jogadorComConta,
  ehEsteConvidado, ehEsteMembro, trocarNoPlantel, podeDesfazer, associacaoAtiva, associacoesDesfaziveis, registroComAssociacoes,
} = require('../utils/associarJogador'); // o convidado sem app vira a conta de um membro
const campeonatos = require('../utils/campeonatoStore');
const selosCache = require('../utils/selosCache');
const { sincronizarPostDoCampeao } = require('../utils/postDoCampeao');
const { quemFez } = require('../utils/ajudaDoJogo');

const router = express.Router();

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
