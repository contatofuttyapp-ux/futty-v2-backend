// Futty v2.0 — A presença do jogo: "Vou / Não vou".
//
// O jogo nasce CHAMANDO (utils/chamadaDoJogo.js): a lista está aberta desde que o jogo existe e fecha sozinha na hora do sorteio (ou quando
// o admin sorteia antes, ou o jogo é cancelado). Não há "abrir presença", "fechar presença" nem prazo. Cada resposta vale na hora para o
// sorteio: grava na lista (rsvp_respostas, com a fila de espera quando o jogo tem lotação) E no elenco do jogo (game_players.confirmado,
// que é o que o sorteio lê) — antes, o elenco só se acertava quando o admin "fechava a presença".
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError, foraDoTime } = require('../utils/http');
const { supabase, getRole, loadGame, goleirosDoTime } = require('../utils/db');
const { obterRsvp } = require('../services/inicio');
const { enviarNotificacao } = require('./push');
const { soOrganiza, MSG_SO_ORGANIZA } = require('../utils/soOrganiza');
const { fusoDoTime, dataCurtaNoFuso } = require('../utils/fuso');
const { listaAberta, foiChamado } = require('../utils/chamadaDoJogo');

const router = express.Router();

const MSG_LISTA_FECHADA = 'A lista deste jogo já fechou.';
const MSG_NAO_CHAMADO = 'Você não foi chamado para este jogo.';

/**
 * O elenco do jogo (game_players) acompanha a resposta: "Vou" = confirmado, "Não vou" (ou a fila de espera) = fora. Quem já tem linha
 * mantém o goleiro que ele ou o admin marcaram; quem entra agora herda a marca do time (team_members.categoria === 'GR'), a não ser que
 * o pedido diga o goleiro (o /api/games/:id/confirmar antigo pode dizer).
 */
async function acertarElenco(game, userId, confirmado, goleiro = null) {
  let ehGoleiro = goleiro;
  if (ehGoleiro == null) {
    const { data: linha } = await supabase.from('game_players').select('goleiro').eq('game_id', game.id).eq('user_id', userId).maybeSingle();
    ehGoleiro = linha ? !!linha.goleiro : (await goleirosDoTime(game.teams.id, [userId])).has(userId);
  }
  const { error } = await supabase
    .from('game_players')
    .upsert({ game_id: game.id, user_id: userId, confirmado: !!confirmado, goleiro: !!ehGoleiro }, { onConflict: 'game_id,user_id' });
  if (error) throw new HttpError(500, error.message);
  return !!ehGoleiro;
}

/** Tira a pessoa da fila de espera (se estiver) e quem estava atrás avança uma posição. */
async function sairDaFila(game, userId) {
  const { data: minha } = await supabase.from('rsvp_espera').select('id, posicao').eq('game_id', game.id).eq('user_id', userId).maybeSingle();
  if (!minha) return false;
  await supabase.from('rsvp_espera').delete().eq('id', minha.id);
  const { data: restantes } = await supabase.from('rsvp_espera').select('id, posicao').eq('game_id', game.id).gt('posicao', minha.posicao);
  for (const r of restantes || []) {
    await supabase.from('rsvp_espera').update({ posicao: r.posicao - 1 }).eq('id', r.id);
  }
  return true;
}

/**
 * Promove o primeiro da lista de espera de um jogo (se houver vaga libertada): confirma-o (na lista e no elenco), tira-o da fila e
 * avisa por push.
 */
async function promoverDaEspera(game) {
  const { data: primeiro } = await supabase
    .from('rsvp_espera')
    .select('id, user_id, posicao')
    .eq('game_id', game.id)
    .order('posicao', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!primeiro) return;

  await supabase
    .from('rsvp_respostas')
    .upsert(
      { game_id: game.id, user_id: primeiro.user_id, status: 'confirmado', respondido_em: new Date().toISOString() },
      { onConflict: 'game_id,user_id' }
    );
  await acertarElenco(game, primeiro.user_id, true);
  await sairDaFila(game, primeiro.user_id);

  enviarNotificacao([primeiro.user_id], {
    title: '✅ Vaga disponível!',
    body: `Você entrou no jogo de ${dataCurtaNoFuso(game.data, fusoDoTime(game.teams))}.`,
    url: `/time/${game.teams.slug}/jogo/${game.id}`,
  }, { categoria: 'jogos' });
}

/**
 * A resposta de uma pessoa a um jogo — a ÚNICA porta ("Vou / Não vou" do Início, do aviso e da página do jogo, e o /confirmar antigo).
 * `status`: 'confirmado' | 'recusado'. Devolve { ok, status, goleiro } ou { ok, espera: true, posicao } (jogo cheio).
 */
async function responderPresenca({ game, userId, status, goleiro = null }) {
  if (!['confirmado', 'recusado'].includes(status)) throw new HttpError(400, 'Estado inválido.');
  // Quem só organiza o time não entra na lista de presença.
  if (await soOrganiza(game.teams.id, userId)) throw new HttpError(403, MSG_SO_ORGANIZA);
  if (!listaAberta(game)) throw new HttpError(409, MSG_LISTA_FECHADA, 'LISTA_FECHADA');
  if (!foiChamado(game, userId)) throw new HttpError(403, MSG_NAO_CHAMADO, 'NAO_CHAMADO');

  const { data: anterior } = await supabase
    .from('rsvp_respostas')
    .select('status')
    .eq('game_id', game.id)
    .eq('user_id', userId)
    .maybeSingle();
  const eraConfirmado = anterior?.status === 'confirmado';

  // Lotação: se o jogo já estiver cheio, "Vou" entra na lista de espera (fora do elenco até abrir vaga).
  if (status === 'confirmado' && game.max_jogadores != null && !eraConfirmado) {
    const { count } = await supabase
      .from('rsvp_respostas')
      .select('user_id', { count: 'exact', head: true })
      .eq('game_id', game.id)
      .eq('status', 'confirmado')
      .neq('user_id', userId);
    if ((count || 0) >= game.max_jogadores) {
      const { data: jaNaFila } = await supabase.from('rsvp_espera').select('posicao').eq('game_id', game.id).eq('user_id', userId).maybeSingle();
      if (jaNaFila) return { ok: true, espera: true, posicao: jaNaFila.posicao };

      await supabase.from('rsvp_respostas').delete().eq('game_id', game.id).eq('user_id', userId);
      await acertarElenco(game, userId, false, goleiro);
      const { data: ultima } = await supabase
        .from('rsvp_espera')
        .select('posicao')
        .eq('game_id', game.id)
        .order('posicao', { ascending: false })
        .limit(1)
        .maybeSingle();
      const posicao = (ultima?.posicao || 0) + 1;
      const { error: espErr } = await supabase
        .from('rsvp_espera')
        .upsert({ game_id: game.id, user_id: userId, posicao }, { onConflict: 'game_id,user_id' });
      if (espErr) throw new HttpError(500, espErr.message);
      return { ok: true, espera: true, posicao };
    }
  }

  const { error } = await supabase
    .from('rsvp_respostas')
    .upsert({ game_id: game.id, user_id: userId, status, respondido_em: new Date().toISOString() }, { onConflict: 'game_id,user_id' });
  if (error) throw new HttpError(500, error.message);
  const ehGoleiro = await acertarElenco(game, userId, status === 'confirmado', goleiro);

  // "Não vou" de quem estava na fila: sai da fila. "Não vou" de quem estava confirmado: abre vaga para o 1º da fila.
  if (status === 'recusado') {
    await sairDaFila(game, userId);
    if (eraConfirmado) await promoverDaEspera(game);
  }
  return { ok: true, status, goleiro: ehGoleiro };
}

// Carrega o jogo e garante que o usuário é membro do time.
async function jogoComoMembro(req) {
  const game = await loadGame(req.params.gameId);
  if (!game) throw new HttpError(404, 'Jogo não encontrado.');
  const role = await getRole(game.teams.id, req.user.id);
  if (!role) throw foraDoTime();
  return { game, role };
}

/**
 * POST /api/jogos/:gameId/rsvp/abrir e /rsvp/fechar — não existem mais como ação (a lista abre quando o jogo nasce e fecha na hora do
 * sorteio). Ficam respondendo o jogo como está, sem mudar nada, para o app antigo (até a atualização chegar) não dar erro na tela.
 */
for (const acao of ['abrir', 'fechar']) {
  router.post(
    `/api/jogos/:gameId/rsvp/${acao}`,
    requireAuth,
    asyncHandler(async (req, res) => {
      const { game, role } = await jogoComoMembro(req);
      if (role !== 'admin') throw new HttpError(403, 'Só admins podem gerir a presença.');
      const { teams, ...semTime } = game;
      res.json({ game: { ...semTime, fuso: fusoDoTime(teams), rsvp_aberto: listaAberta(game), rsvp_fechado: !listaAberta(game) } });
    })
  );
}

/** POST /api/jogos/:gameId/rsvp/responder — "Vou" (confirmado) ou "Não vou" (recusado). */
router.post(
  '/api/jogos/:gameId/rsvp/responder',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { game } = await jogoComoMembro(req);
    const r = await responderPresenca({ game, userId: req.user.id, status: req.body?.status });
    res.json(r.espera ? { ok: true, espera: true, posicao: r.posicao } : { ok: true, status: r.status });
  })
);

/** POST /api/jogos/:gameId/rsvp/sair-espera — jogador sai da lista de espera. */
router.post(
  '/api/jogos/:gameId/rsvp/sair-espera',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { game } = await jogoComoMembro(req);
    await sairDaFila(game, req.user.id);
    res.json({ ok: true });
  })
);

/**
 * GET /api/jogos/:gameId/rsvp — estado + listas (confirmados/recusados/pendentes).
 * Lógica em services/inicio.js#obterRsvp — a MESMA função que GET /api/inicio
 * usa, para o JSON nunca divergir entre as duas rotas.
 */
router.get(
  '/api/jogos/:gameId/rsvp',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await obterRsvp(req.params.gameId, req.user.id));
  })
);

module.exports = router;
module.exports.responderPresenca = responderPresenca;
module.exports.MSG_LISTA_FECHADA = MSG_LISTA_FECHADA;
