// Futty v2.0 — RSVP: confirmação de presença com prazo.
// O admin abre/fecha o RSVP de um jogo; os membros respondem (confirmado/
// recusado) enquanto estiver aberto e dentro do prazo.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, getRole, loadGame } = require('../utils/db');

const router = express.Router();

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
  if (!role) throw new HttpError(403, 'Não és membro desta equipa.');
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
    if (prazoData.getTime() <= Date.now()) throw new HttpError(400, 'O prazo tem de ser no futuro.');

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
    const { data: confirmados } = await supabase
      .from('rsvp_respostas')
      .select('user_id')
      .eq('game_id', game.id)
      .eq('status', 'confirmado');
    const rows = (confirmados || []).map((r) => ({ game_id: game.id, user_id: r.user_id, confirmado: true }));
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

    const { error } = await supabase
      .from('rsvp_respostas')
      .upsert(
        { game_id: game.id, user_id: req.user.id, status, respondido_em: new Date().toISOString() },
        { onConflict: 'game_id,user_id' }
      );
    if (error) throw new HttpError(500, error.message);
    res.json({ ok: true, status });
  })
);

/** GET /api/jogos/:gameId/rsvp — estado + listas (confirmados/recusados/pendentes). */
router.get(
  '/api/jogos/:gameId/rsvp',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await jogoComoMembro(req);

    // Membros da equipa.
    const { data: membros } = await supabase
      .from('team_members')
      .select('users ( id, nome, nome_jogador, avatar_url )')
      .eq('team_id', game.teams.id);
    const users = (membros || []).map((m) => m.users).filter(Boolean);

    // Respostas já dadas.
    const { data: respostas } = await supabase
      .from('rsvp_respostas')
      .select('user_id, status')
      .eq('game_id', game.id);
    const statusPorUser = {};
    (respostas || []).forEach((r) => {
      statusPorUser[r.user_id] = r.status;
    });

    res.json({
      rsvp_aberto: game.rsvp_aberto || false,
      rsvp_prazo: game.rsvp_prazo || null,
      rsvp_fechado: game.rsvp_fechado || false,
      confirmados: users.filter((u) => statusPorUser[u.id] === 'confirmado'),
      recusados: users.filter((u) => statusPorUser[u.id] === 'recusado'),
      pendentes: users.filter((u) => !statusPorUser[u.id]),
    });
  })
);

module.exports = router;
