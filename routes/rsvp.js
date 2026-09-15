// Futty v2.0 — RSVP: confirmação de presença com prazo.
// O admin abre/fecha o RSVP de um jogo; os membros respondem (confirmado/
// recusado) enquanto estiver aberto e dentro do prazo.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, getRole, loadGame, goleirosDoTime } = require('../utils/db');
const { obterRsvp } = require('../services/inicio');
const { enviarNotificacao } = require('./push');

const router = express.Router();

/** Data curta PT (ex.: "12/06 · 20:30") para o corpo das notificações. */
function dataCurtaPT(iso) {
  try {
    return new Date(iso).toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * Promove o primeiro da lista de espera de um jogo (se houver vaga libertada):
 * confirma-o, remove-o da fila, reorganiza as posições e notifica-o por push.
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
  await supabase.from('rsvp_espera').delete().eq('id', primeiro.id);

  // Reorganiza as posições dos restantes (todos os que estavam atrás avançam 1).
  const { data: restantes } = await supabase
    .from('rsvp_espera')
    .select('id, posicao')
    .eq('game_id', game.id)
    .gt('posicao', primeiro.posicao);
  for (const r of restantes || []) {
    await supabase.from('rsvp_espera').update({ posicao: r.posicao - 1 }).eq('id', r.id);
  }

  enviarNotificacao([primeiro.user_id], {
    title: '✅ Vaga disponível!',
    body: `Você foi confirmado para o jogo de ${dataCurtaPT(game.data)}. Confirme sua presença no app.`,
    url: `/equipa/${game.teams.slug}`,
  });
}

// Carrega o jogo e garante que o utilizador é admin da equipa.
async function jogoComoAdmin(req) {
  const game = await loadGame(req.params.gameId);
  if (!game) throw new HttpError(404, 'Jogo não encontrado.');
  const role = await getRole(game.teams.id, req.user.id);
  if (role !== 'admin') throw new HttpError(403, 'Só admins podem gerir o RSVP.');
  return game;
}

// Carrega o jogo e garante que o utilizador é membro da equipa.
async function jogoComoMembro(req) {
  const game = await loadGame(req.params.gameId);
  if (!game) throw new HttpError(404, 'Jogo não encontrado.');
  const role = await getRole(game.teams.id, req.user.id);
  if (!role) throw new HttpError(403, 'Não é membro deste time.');
  return game;
}

/** POST /api/jogos/:gameId/rsvp/abrir — admin abre o RSVP com um prazo. */
router.post(
  '/api/jogos/:gameId/rsvp/abrir',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await jogoComoAdmin(req);
    const { prazo } = req.body || {};
    const prazoData = prazo ? new Date(prazo) : null;
    if (!prazoData || Number.isNaN(prazoData.getTime())) throw new HttpError(400, 'Prazo inválido.');
    if (prazoData.getTime() <= Date.now()) throw new HttpError(400, 'O prazo deve ser no futuro.');

    const { data: updated, error } = await supabase
      .from('games')
      .update({ rsvp_aberto: true, rsvp_prazo: prazoData.toISOString(), rsvp_fechado: false })
      .eq('id', game.id)
      .select()
      .single();
    if (error) throw new HttpError(500, error.message);

    // Auto-preenche 'recusado' para quem já declarou ausência ao próximo jogo.
    // ignoreDuplicates → não sobrescreve quem entretanto já tenha respondido.
    const { data: ausentes } = await supabase
      .from('team_members')
      .select('user_id')
      .eq('team_id', game.teams.id)
      .eq('ausente_proximo', true);
    const ausenteRows = (ausentes || [])
      .filter((m) => m.user_id)
      .map((m) => ({ game_id: game.id, user_id: m.user_id, status: 'recusado', respondido_em: new Date().toISOString() }));
    if (ausenteRows.length) {
      await supabase.from('rsvp_respostas').upsert(ausenteRows, { onConflict: 'game_id,user_id', ignoreDuplicates: true });
    }

    res.json({ game: updated });
  })
);

/** POST /api/jogos/:gameId/rsvp/fechar — admin fecha o RSVP. */
router.post(
  '/api/jogos/:gameId/rsvp/fechar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await jogoComoAdmin(req);
    const { data: updated, error } = await supabase
      .from('games')
      .update({ rsvp_fechado: true })
      .eq('id', game.id)
      .select()
      .single();
    if (error) throw new HttpError(500, error.message);

    // Sincroniza os confirmados via RSVP para game_players (alimenta o sorteio
    // sem o admin ter de adicionar os jogadores manualmente).
    // Rodada 9: quem já tem linha no jogo mantém o `goleiro` que ele ou o admin
    // marcaram; quem entra agora herda a flag do time (posicao === 'GL').
    const { data: confirmados } = await supabase
      .from('rsvp_respostas')
      .select('user_id')
      .eq('game_id', game.id)
      .eq('status', 'confirmado');
    const ids = (confirmados || []).map((r) => r.user_id).filter(Boolean);
    const { data: jaNoJogo } = ids.length
      ? await supabase.from('game_players').select('user_id, goleiro').eq('game_id', game.id).in('user_id', ids)
      : { data: [] };
    const goleiroAtual = new Map((jaNoJogo || []).map((g) => [g.user_id, !!g.goleiro]));
    const goleirosTime = await goleirosDoTime(game.teams.id, ids);
    const rows = ids.map((userId) => ({
      game_id: game.id,
      user_id: userId,
      confirmado: true,
      goleiro: goleiroAtual.has(userId) ? goleiroAtual.get(userId) : goleirosTime.has(userId),
    }));
    if (rows.length) {
      const { error: gpErr } = await supabase.from('game_players').upsert(rows, { onConflict: 'game_id,user_id' });
      if (gpErr) throw new HttpError(500, gpErr.message);
    }

    res.json({ game: updated });
  })
);

/** POST /api/jogos/:gameId/rsvp/responder — membro confirma/recusa presença. */
router.post(
  '/api/jogos/:gameId/rsvp/responder',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await jogoComoMembro(req);
    const { status } = req.body || {};
    if (!['confirmado', 'recusado'].includes(status)) throw new HttpError(400, 'Estado inválido.');
    if (!game.rsvp_aberto || game.rsvp_fechado) throw new HttpError(400, 'O RSVP não está aberto.');
    if (!game.rsvp_prazo || new Date(game.rsvp_prazo).getTime() <= Date.now()) {
      throw new HttpError(400, 'O prazo do RSVP já passou.');
    }

    // Estado anterior (para saber se uma vaga foi libertada ao recusar).
    const { data: anterior } = await supabase
      .from('rsvp_respostas')
      .select('status')
      .eq('game_id', game.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    const eraConfirmado = anterior?.status === 'confirmado';

    // Capacidade: se o jogo já estiver cheio, entra na lista de espera.
    if (status === 'confirmado' && game.max_jogadores != null) {
      const { count } = await supabase
        .from('rsvp_respostas')
        .select('user_id', { count: 'exact', head: true })
        .eq('game_id', game.id)
        .eq('status', 'confirmado')
        .neq('user_id', req.user.id);
      if ((count || 0) >= game.max_jogadores) {
        // Já está na fila? Devolve a posição atual sem reordenar.
        const { data: jaNaFila } = await supabase
          .from('rsvp_espera')
          .select('posicao')
          .eq('game_id', game.id)
          .eq('user_id', req.user.id)
          .maybeSingle();
        if (jaNaFila) return res.json({ ok: true, espera: true, posicao: jaNaFila.posicao });

        // Garante que não fica também marcado como confirmado/recusado.
        await supabase.from('rsvp_respostas').delete().eq('game_id', game.id).eq('user_id', req.user.id);

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
          .upsert({ game_id: game.id, user_id: req.user.id, posicao }, { onConflict: 'game_id,user_id' });
        if (espErr) throw new HttpError(500, espErr.message);
        return res.json({ ok: true, espera: true, posicao });
      }
    }

    const { error } = await supabase
      .from('rsvp_respostas')
      .upsert(
        { game_id: game.id, user_id: req.user.id, status, respondido_em: new Date().toISOString() },
        { onConflict: 'game_id,user_id' }
      );
    if (error) throw new HttpError(500, error.message);

    // Se um confirmado recusou, libertou uma vaga → promove o 1º da espera.
    if (status === 'recusado' && eraConfirmado) {
      await promoverDaEspera(game);
    }

    res.json({ ok: true, status });
  })
);

/** POST /api/jogos/:gameId/rsvp/sair-espera — jogador sai da lista de espera. */
router.post(
  '/api/jogos/:gameId/rsvp/sair-espera',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await jogoComoMembro(req);

    const { data: minha } = await supabase
      .from('rsvp_espera')
      .select('id, posicao')
      .eq('game_id', game.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (!minha) return res.json({ ok: true });

    await supabase.from('rsvp_espera').delete().eq('id', minha.id);

    // Reorganiza as posições de quem estava atrás.
    const { data: restantes } = await supabase
      .from('rsvp_espera')
      .select('id, posicao')
      .eq('game_id', game.id)
      .gt('posicao', minha.posicao);
    for (const r of restantes || []) {
      await supabase.from('rsvp_espera').update({ posicao: r.posicao - 1 }).eq('id', r.id);
    }

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
