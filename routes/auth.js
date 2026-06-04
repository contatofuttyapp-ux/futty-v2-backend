// Futty v2.0 — Rotas de autenticação / utilizador.
// (O login/registo é feito no frontend via Supabase Auth; aqui expomos o perfil.)
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');
const { ensureUserRow, getUserById } = require('../utils/db');

const router = express.Router();

/**
 * GET /api/me — devolve o utilizador autenticado.
 * Garante também a linha em public.users (caso o trigger não tenha corrido).
 */
router.get(
  '/api/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    await ensureUserRow(req.user);
    const perfil = await getUserById(req.user.id);
    res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
        nome: perfil?.nome || null,
        avatar_url: perfil?.avatar_url || null,
      },
    });
  })
);

module.exports = router;
