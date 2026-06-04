// Futty v2.0 — Rotas de autenticação / utilizador.
// (O login/registo é feito no frontend via Supabase Auth; aqui expomos o perfil.)
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');
const { supabase, ensureUserRow, getUserById } = require('../utils/db');
const { round2 } = require('../utils/helpers');

const router = express.Router();

/**
 * GET /api/me — devolve o utilizador autenticado + stats agregadas.
 * Garante também a linha em public.users (caso o trigger não tenha corrido).
 */
router.get(
  '/api/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    await ensureUserRow(req.user);
    const perfil = await getUserById(userId);

    // Stats agregadas (todas as equipas):
    // jogos = presenças confirmadas; gols = soma; nota = média dos votos recebidos.
    const { count: jogos } = await supabase
      .from('game_players')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('confirmado', true);

    const { data: tmRows } = await supabase.from('team_members').select('gols').eq('user_id', userId);
    const gols = (tmRows || []).reduce((sum, r) => sum + (r.gols || 0), 0);

    const { data: voteRows } = await supabase.from('votes').select('nota').eq('para_user_id', userId);
    const nota = voteRows && voteRows.length
      ? round2(voteRows.reduce((sum, v) => sum + v.nota, 0) / voteRows.length)
      : null;

    res.json({
      user: {
        id: userId,
        email: req.user.email,
        nome: perfil?.nome || null,
        avatar_url: perfil?.avatar_url || null,
      },
      stats: { nota, jogos: jogos || 0, gols },
    });
  })
);

module.exports = router;
