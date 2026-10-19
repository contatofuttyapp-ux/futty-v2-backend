// Futty v2.0 — A conversa da Resenha: reações e comentários (com menções). Montadas por routes/feed.js.

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, getRole, ensureUserRow, getUserById } = require('../utils/db');
const { midiaEhDe } = require('../utils/validarUrl');
const { conjuntoMutuo } = require('../utils/blocksStore');
const { parentTeamId, targetTeamId, reacoesParaTargets } = require('../utils/ajudaDaResenha');

const router = express.Router();

// Os 7 emojis permitidos (igual ao CHECK — ver migração 036 que adiciona 🍿).
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '😡', '🍿'];

const COMENTARIO_MEDIA = ['image', 'gif'];

// Regex de menção: @<uuid> dentro do corpo do comentário.
const MENTION_RE = /@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

// =====================================================================
// REAÇÕES
// =====================================================================

/**
 * POST /api/feed/reacoes — toggle de reação num target.
 * Body: { target_type, target_id, emoji }. Mesmo emoji apaga; emoji
 * diferente atualiza; inexistente cria.
 */
router.post(
  '/api/feed/reacoes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { target_type: targetType, target_id: targetId, emoji } = req.body || {};
    if (!['comentario', 'game', 'post'].includes(targetType)) throw new HttpError(400, 'target_type inválido.');
    if (!targetId) throw new HttpError(400, 'target_id é obrigatório.');
    if (!REACTION_EMOJIS.includes(emoji)) throw new HttpError(400, 'Emoji não permitido.');

    const teamId = await targetTeamId(targetType, targetId);
    if (!teamId) throw new HttpError(404, 'Alvo não encontrado.');
    const role = await getRole(teamId, req.user.id);
    if (!role) throw new HttpError(403, 'Você não é membro deste time.');

    await ensureUserRow(req.user);

    const { data: existing } = await supabase
      .from('reacoes')
      .select('id, emoji')
      .eq('target_type', targetType)
      .eq('target_id', targetId)
      .eq('user_id', req.user.id)
      .maybeSingle();

    let minha = emoji;
    if (existing) {
      if (existing.emoji === emoji) {
        await supabase.from('reacoes').delete().eq('id', existing.id); // toggle off
        minha = null;
      } else {
        await supabase.from('reacoes').update({ emoji }).eq('id', existing.id);
        minha = emoji;
      }
    } else {
      const { error } = await supabase
        .from('reacoes')
        .insert({ target_type: targetType, target_id: targetId, user_id: req.user.id, emoji });
      if (error) throw new HttpError(500, error.message);
    }

    const map = await reacoesParaTargets(targetType, [targetId], req.user.id);
    res.json({ emoji: minha, contagem_reacoes: map[targetId]?.contagem || {} });
  })
);

// =====================================================================
// COMENTÁRIOS
// =====================================================================

/**
 * GET /api/feed/comentarios/:parentType/:parentId — lista comentários
 * (ASC). Os apagados vêm como { id, deleted: true } para preservar threads.
 */
router.get(
  '/api/feed/comentarios/:parentType/:parentId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { parentType, parentId } = req.params;
    if (!['game', 'post'].includes(parentType)) throw new HttpError(400, 'parentType inválido.');

    const teamId = await parentTeamId(parentType, parentId);
    if (!teamId) throw new HttpError(404, 'Alvo não encontrado.');
    const role = await getRole(teamId, req.user.id);
    if (!role) throw new HttpError(403, 'Você não é membro deste time.');

    // Bloqueio entre jogadores: comentários de quem está bloqueado/me bloqueou não existem para mim.
    const bloqueados = await conjuntoMutuo(req.user.id);

    const { data: rows } = await supabase
      .from('comentarios')
      .select('id, body, author_id, reply_to, mentioned_user_ids, created_at, deleted_at')
      .eq('parent_type', parentType)
      .eq('parent_id', parentId)
      .order('created_at', { ascending: true });
    const all = (rows || []).filter((c) => !bloqueados.has(c.author_id));
    const visiveis = all.filter((c) => !c.deleted_at);
    const ids = visiveis.map((c) => c.id);

    // Anexos dos comentários visíveis
    const anexosBy = {};
    if (ids.length) {
      const { data: ax } = await supabase
        .from('comentario_anexos')
        .select('comentario_id, url, media_type, position')
        .in('comentario_id', ids)
        .order('position', { ascending: true });
      for (const a of ax || []) {
        (anexosBy[a.comentario_id] ||= []).push({ url: a.url, media_type: a.media_type, position: a.position });
      }
    }

    // Autores
    const userIds = [...new Set(visiveis.map((c) => c.author_id).filter(Boolean))];
    const userMap = {};
    if (userIds.length) {
      const { data: us } = await supabase.from('users').select('id, nome, nome_jogador, email, avatar_url').in('id', userIds);
      for (const u of us || []) userMap[u.id] = u;
    }

    // Reações dos comentários
    const reac = await reacoesParaTargets('comentario', ids, req.user.id);

    const comentarios = all.map((c) => {
      if (c.deleted_at) return { id: c.id, deleted: true };
      const u = userMap[c.author_id];
      return {
        id: c.id,
        body: c.body,
        author_id: c.author_id,
        author_nome: u ? u.nome_jogador || u.nome || 'Jogador' : null,
        author_avatar_url: u?.avatar_url || null,
        reply_to: c.reply_to,
        mentioned_user_ids: c.mentioned_user_ids || [],
        created_at: c.created_at,
        anexos: anexosBy[c.id] || [],
        contagem_reacoes: reac[c.id]?.contagem || {},
        minha_reacao: reac[c.id]?.minha || null,
      };
    });

    res.json({ comentarios });
  })
);

/** POST /api/feed/comentarios — cria um comentário (membro do time). */
router.post(
  '/api/feed/comentarios',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { parent_type: parentType, parent_id: parentId, body, reply_to: replyTo, anexos } = req.body || {};
    if (!['game', 'post'].includes(parentType)) throw new HttpError(400, 'parent_type inválido.');
    if (!parentId) throw new HttpError(400, 'parent_id é obrigatório.');
    if (body != null && typeof body !== 'string') throw new HttpError(400, 'O comentário precisa ser texto.');
    const texto = String(body ?? '').trim();
    if (!texto) throw new HttpError(400, 'O comentário não pode estar vazio.');
    if (texto.length > 500) throw new HttpError(400, 'Máximo 500 caracteres.');

    const teamId = await parentTeamId(parentType, parentId);
    if (!teamId) throw new HttpError(404, 'Alvo não encontrado.');
    const role = await getRole(teamId, req.user.id);
    if (!role) throw new HttpError(403, 'Você não é membro deste time.');

    // Os anexos valem o mesmo que a mídia de um post: do Storage da Resenha e subida por quem comenta (a v1 do app só manda texto).
    const anexosPedidos = (Array.isArray(anexos) ? anexos : []).filter((a) => a && a.url).slice(0, 8);
    if (anexosPedidos.some((a) => !midiaEhDe(a.url, req, req.user.id))) throw new HttpError(400, 'URL de mídia inválida.');

    // reply_to tem de pertencer ao mesmo parent
    if (replyTo) {
      const { data: parent } = await supabase
        .from('comentarios')
        .select('id, parent_type, parent_id')
        .eq('id', replyTo)
        .maybeSingle();
      if (!parent || parent.parent_type !== parentType || parent.parent_id !== parentId) {
        throw new HttpError(400, 'Comentário a responder inválido.');
      }
    }

    // Menções @<uuid> extraídas do corpo
    const mentioned = [...new Set([...texto.matchAll(MENTION_RE)].map((m) => m[1].toLowerCase()))];

    await ensureUserRow(req.user);

    const { data: c, error } = await supabase
      .from('comentarios')
      .insert({
        parent_type: parentType,
        parent_id: parentId,
        author_id: req.user.id,
        body: texto,
        reply_to: replyTo || null,
        mentioned_user_ids: mentioned,
      })
      .select()
      .single();
    if (error) throw new HttpError(500, error.message);

    // Anexos (máx 8)
    const anexoRows = anexosPedidos
      .map((a, i) => ({
        comentario_id: c.id,
        url: String(a.url),
        media_type: COMENTARIO_MEDIA.includes(a.media_type) ? a.media_type : 'image',
        position: i,
      }));
    let savedAnexos = [];
    if (anexoRows.length) {
      const { data: aa, error: ae } = await supabase
        .from('comentario_anexos')
        .insert(anexoRows)
        .select('url, media_type, position');
      if (ae) throw new HttpError(500, ae.message);
      savedAnexos = aa || [];
    }

    const author = await getUserById(req.user.id);
    res.status(201).json({
      comentario: {
        id: c.id,
        body: c.body,
        author_id: c.author_id,
        author_nome: author?.nome_jogador || author?.nome || 'Jogador',
        author_avatar_url: author?.avatar_url || null,
        reply_to: c.reply_to,
        mentioned_user_ids: c.mentioned_user_ids || [],
        created_at: c.created_at,
        anexos: savedAnexos,
        contagem_reacoes: {},
        minha_reacao: null,
      },
    });
  })
);

/**
 * DELETE /api/feed/comentarios/:comentarioId — soft delete (autor ou admin).
 * Marca deleted_at/updated_at; não apaga fisicamente (preserva threads).
 */
router.delete(
  '/api/feed/comentarios/:comentarioId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data: c } = await supabase
      .from('comentarios')
      .select('id, parent_type, parent_id, author_id, deleted_at')
      .eq('id', req.params.comentarioId)
      .maybeSingle();
    if (!c) throw new HttpError(404, 'Comentário não encontrado.');

    const teamId = await parentTeamId(c.parent_type, c.parent_id);
    const role = teamId ? await getRole(teamId, req.user.id) : null;
    if (!role) throw new HttpError(403, 'Você não é membro deste time.');
    if (c.author_id !== req.user.id && role !== 'admin') {
      throw new HttpError(403, 'Só o autor ou um admin pode excluir.');
    }

    const now = new Date().toISOString();
    const { error } = await supabase
      .from('comentarios')
      .update({ deleted_at: now, updated_at: now })
      .eq('id', c.id);
    if (error) throw new HttpError(500, error.message);
    res.json({ deleted: true });
  })
);

module.exports = router;
