// Futty v2.0 — Bloqueio entre jogadores (exigência Apple UGC 1.2). Bloquear é
// SEMPRE do próprio, nunca notifica o bloqueado, e é bidirecional na prática: a
// Resenha deixa de mostrar posts/comentários de QUALQUER lado da relação (ver
// utils/blocksStore.js). Tabela `user_blocks` — DDL em db/migrations/041_user_blocks.sql.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase } = require('../utils/db');

const router = express.Router();

/** POST /api/blocks — bloqueia outro jogador. Body: { blocked_id }. Silencioso. */
router.post(
  '/api/blocks',
  requireAuth,
  asyncHandler(async (req, res) => {
    const blockedId = String(req.body?.blocked_id || '');
    if (!blockedId) throw new HttpError(400, 'blocked_id em falta.');
    if (blockedId === req.user.id) throw new HttpError(400, 'Você não pode bloquear a si mesmo.');

    const { error } = await supabase
      .from('user_blocks')
      .upsert({ blocker_id: req.user.id, blocked_id: blockedId }, { onConflict: 'blocker_id,blocked_id' });
    if (error) throw new HttpError(500, error.message);

    res.json({ ok: true }); // nunca notifica o bloqueado
  })
);

/** DELETE /api/blocks/:blockedId — desbloqueia. */
router.delete(
  '/api/blocks/:blockedId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { error } = await supabase
      .from('user_blocks')
      .delete()
      .eq('blocker_id', req.user.id)
      .eq('blocked_id', req.params.blockedId);
    if (error) throw new HttpError(500, error.message);
    res.json({ ok: true });
  })
);

/** GET /api/blocks — lista quem EU bloqueei (Perfil → Privacidade). */
router.get(
  '/api/blocks',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data: rows, error } = await supabase
      .from('user_blocks')
      .select('blocked_id, created_at')
      .eq('blocker_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw new HttpError(500, error.message);

    const ids = (rows || []).map((r) => r.blocked_id);
    let userMap = {};
    if (ids.length) {
      const { data: users } = await supabase.from('users').select('id, nome, nome_jogador, avatar_url').in('id', ids);
      userMap = Object.fromEntries((users || []).map((u) => [u.id, u]));
    }
    res.json({
      bloqueados: (rows || []).map((r) => ({
        id: r.blocked_id,
        nome: userMap[r.blocked_id]?.nome_jogador || userMap[r.blocked_id]?.nome || 'Jogador',
        avatar_url: userMap[r.blocked_id]?.avatar_url || null,
        bloqueado_em: r.created_at,
      })),
    });
  })
);

module.exports = router;
