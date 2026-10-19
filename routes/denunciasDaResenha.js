// Futty v2.0 — Denúncias da Resenha: denunciar, a fila do admin do time e resolver. Montadas por routes/feed.js.

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { denunciaLimiter } = require('../middleware/limiters');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, getRole, ensureUserRow } = require('../utils/db');
const { targetTeamId } = require('../utils/ajudaDaResenha');

const router = express.Router();

// Motivos de denúncia (igual ao CHECK da migração 009).
const DENUNCIA_MOTIVOS = ['linguagem_inapropriada', 'spam', 'conteudo_ofensivo', 'outro'];

// =====================================================================
// DENÚNCIAS
// =====================================================================

/**
 * POST /api/feed/denuncias — denuncia um comentário ou post.
 * UNIQUE (target, reporter) garante uma denúncia por usuário (23505 → idempotente).
 */
router.post(
  '/api/feed/denuncias',
  requireAuth,
  denunciaLimiter,
  asyncHandler(async (req, res) => {
    const { target_type: targetType, target_id: targetId, motivo, descricao } = req.body || {};
    if (!['comentario', 'post'].includes(targetType)) throw new HttpError(400, 'target_type inválido.');
    if (!targetId) throw new HttpError(400, 'target_id é obrigatório.');
    if (!DENUNCIA_MOTIVOS.includes(motivo)) throw new HttpError(400, 'Motivo inválido.');
    const desc = descricao == null ? null : String(descricao).trim().slice(0, 500) || null;

    const teamId = await targetTeamId(targetType, targetId);
    if (!teamId) throw new HttpError(404, 'Alvo não encontrado.');
    const role = await getRole(teamId, req.user.id);
    if (!role) throw new HttpError(403, 'Você não é membro deste time.');

    await ensureUserRow(req.user);

    const { error } = await supabase
      .from('denuncias')
      .insert({ target_type: targetType, target_id: targetId, reporter_id: req.user.id, motivo, descricao: desc });
    if (error) {
      if (error.code === '23505') return res.json({ reported: true }); // já denunciado — idempotente
      throw new HttpError(500, error.message);
    }
    res.json({ reported: true });
  })
);

/**
 * GET /api/feed/denuncias — denúncias por resolver dos times onde o
 * usuário é admin. Inclui o conteúdo denunciado e o nome do reporter.
 */
router.get(
  '/api/feed/denuncias',
  requireAuth,
  asyncHandler(async (req, res) => {
    // Times onde sou admin.
    const { data: adminRows } = await supabase
      .from('team_members')
      .select('team_id')
      .eq('user_id', req.user.id)
      .eq('role', 'admin');
    const adminTeams = new Set((adminRows || []).map((r) => r.team_id));
    if (!adminTeams.size) return res.json({ denuncias: [] });

    const { data: rows, error } = await supabase
      .from('denuncias')
      .select('id, target_type, target_id, motivo, descricao, reporter_id, created_at')
      .eq('resolvida', false)
      .order('created_at', { ascending: true });
    if (error) throw new HttpError(500, error.message);

    // Filtra pelas denúncias cujo alvo pertence a um time que administro.
    const visiveis = [];
    for (const d of rows || []) {
      const teamId = await targetTeamId(d.target_type, d.target_id);
      if (teamId && adminTeams.has(teamId)) visiveis.push(d);
    }

    // Nomes dos reporters.
    const reporterIds = [...new Set(visiveis.map((d) => d.reporter_id).filter(Boolean))];
    const repMap = {};
    if (reporterIds.length) {
      const { data: us } = await supabase.from('users').select('id, nome, nome_jogador, email').in('id', reporterIds);
      for (const u of us || []) repMap[u.id] = u.nome_jogador || u.nome || 'Jogador';
    }

    // Conteúdo denunciado (texto do comentário/post).
    const comIds = visiveis.filter((d) => d.target_type === 'comentario').map((d) => d.target_id);
    const postIds = visiveis.filter((d) => d.target_type === 'post').map((d) => d.target_id);
    const conteudo = {};
    if (comIds.length) {
      const { data: cs } = await supabase.from('comentarios').select('id, body').in('id', comIds);
      for (const c of cs || []) conteudo[`comentario:${c.id}`] = c.body;
    }
    if (postIds.length) {
      const { data: ps } = await supabase.from('feed_posts').select('id, body').in('id', postIds);
      for (const p of ps || []) conteudo[`post:${p.id}`] = p.body;
    }

    const denuncias = visiveis.map((d) => ({
      id: d.id,
      target_type: d.target_type,
      target_id: d.target_id,
      motivo: d.motivo,
      descricao: d.descricao,
      reporter_nome: d.reporter_id ? repMap[d.reporter_id] || null : null,
      created_at: d.created_at,
      conteudo: conteudo[`${d.target_type}:${d.target_id}`] ?? null,
    }));
    res.json({ denuncias });
  })
);

/**
 * PATCH /api/feed/denuncias/:id/resolver — resolve uma denúncia (só admin da
 * time do alvo). Body: { apagar_conteudo }. Se true: soft-delete do
 * comentário ou apaga o post.
 */
router.patch(
  '/api/feed/denuncias/:id/resolver',
  requireAuth,
  asyncHandler(async (req, res) => {
    const apagar = !!(req.body && req.body.apagar_conteudo);

    const { data: d } = await supabase
      .from('denuncias')
      .select('id, target_type, target_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!d) throw new HttpError(404, 'Denúncia não encontrada.');

    const teamId = await targetTeamId(d.target_type, d.target_id);
    if (!teamId) throw new HttpError(404, 'Alvo não encontrado.');
    const role = await getRole(teamId, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem resolver denúncias.');

    if (apagar) {
      if (d.target_type === 'comentario') {
        const now = new Date().toISOString();
        await supabase.from('comentarios').update({ deleted_at: now, updated_at: now }).eq('id', d.target_id);
      } else if (d.target_type === 'post') {
        await supabase.from('feed_posts').delete().eq('id', d.target_id);
      }
    }

    const { error } = await supabase.from('denuncias').update({ resolvida: true }).eq('id', d.id);
    if (error) throw new HttpError(500, error.message);
    res.json({ resolvida: true });
  })
);

module.exports = router;
