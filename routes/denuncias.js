// Futty v2.0 — Denúncias + triagem IA (Tijolo 3, Fase B). Segue a SPEC-DENUNCIAS.
// Fluxo: denunciar (anti-abuso) → triagem (Fable/regras, leis duras) → auto-resolve
// OU fila do admin → decisão do admin → desfecho. Dono só vê agregados.
const express = require('express');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, getRole, getTeamBySlug } = require('../utils/db');
const { removerFicheirosPorUrl } = require('../utils/storage');
const { triar } = require('../utils/triagem');
const store = require('../utils/denunciaStore');

const router = express.Router();
const STORAGE_BUCKET = 'resenha';

function agoraISO() { return new Date().toISOString(); }

// Resolve equipa + conteúdo (para a triagem) a partir do alvo.
async function resolverAlvo(targetType, targetId) {
  if (targetType === 'post') {
    const { data: p } = await supabase.from('feed_posts').select('id, team_id, body').eq('id', targetId).maybeSingle();
    if (!p) throw new HttpError(404, 'Post não encontrado.');
    const { data: media } = await supabase.from('feed_post_media').select('url').eq('post_id', p.id);
    const urls = (media || []).map((m) => m.url);
    return { teamId: p.team_id, tipo: urls.length ? 'foto' : 'texto', conteudo: p.body || '[imagem]', urls };
  }
  if (targetType === 'comentario') {
    const { data: c } = await supabase.from('comentarios').select('id, parent_type, parent_id, body').eq('id', targetId).maybeSingle();
    if (!c) throw new HttpError(404, 'Comentário não encontrado.');
    let teamId = null;
    if (c.parent_type === 'post') {
      const { data: p } = await supabase.from('feed_posts').select('team_id').eq('id', c.parent_id).maybeSingle();
      teamId = p?.team_id || null;
    }
    return { teamId, tipo: 'texto', conteudo: c.body || '[comentário]', urls: [] };
  }
  if (targetType === 'perfil') {
    const { data: u } = await supabase.from('users').select('id, nome').eq('id', targetId).maybeSingle();
    if (!u) throw new HttpError(404, 'Perfil não encontrado.');
    return { teamId: null, tipo: 'perfil', conteudo: u.nome || '[perfil]', urls: [] };
  }
  throw new HttpError(400, 'Tipo de alvo inválido.');
}

// Remove de facto o conteúdo (só em "remover"). Best-effort no Storage.
async function removerConteudo(caso, urls) {
  if (caso.target_type === 'post') {
    await supabase.from('feed_posts').delete().eq('id', caso.target_id);
    if (urls && urls.length) await removerFicheirosPorUrl(STORAGE_BUCKET, urls);
  } else if (caso.target_type === 'comentario') {
    const now = agoraISO();
    await supabase.from('comentarios').update({ deleted_at: now, updated_at: now }).eq('id', caso.target_id);
  }
  // perfil: v1 não apaga a conta — fica registado (marca no log).
}

/**
 * POST /api/denuncias — denuncia (categoria + alvo). Anti-abuso + triagem + log.
 * Nunca devolve veredicto ao denunciante (protege alvo e denunciante).
 */
router.post(
  '/api/denuncias',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { target_type: targetType, target_id: targetId, categoria, descricao } = req.body || {};
    if (!targetId) throw new HttpError(400, 'Alvo em falta.');
    if (!store.CATEGORIAS.includes(categoria)) throw new HttpError(400, 'Categoria inválida.');

    const { teamId, tipo, conteudo, urls } = await resolverAlvo(targetType, targetId);
    const agora = agoraISO();

    // Anti-abuso: limite diário (menor é imune).
    const quota = await store.registarQuota(req.user.id, categoria, agora);
    if (!quota.ok) throw new HttpError(429, quota.motivo);

    // Idempotência leve: uma denúncia por (alvo, denunciante).
    if (await store.jaDenunciou(teamId, targetType, targetId, req.user.id)) {
      return res.json({ ok: true, ja: true });
    }

    const caso = store.novoCaso({ teamId, targetType, targetId, reporterId: req.user.id, categoria, descricao, pesoReporter: quota.peso, agoraISO: agora });

    // Triagem (Fable/regras). Contexto conservador, sem identidade em claro no log.
    const contexto = `equipa ${teamId || '—'}; denunciante peso ${quota.peso?.toFixed?.(2) || 1}`;
    const v = await triar({ categoria, tipo, conteudo, contexto });
    store.logar(caso, { quem: `triagem:${v.motor}`, tipo: 'triagem', quando: agoraISO(), decisao: v.decisao, confianca: v.confianca, justificativa: v.justificativa });

    if (v.decisao === 'escalar') {
      caso.estado = 'escalada'; caso.prioritaria = true;
    } else if (v.decisao === 'remover') {
      await removerConteudo(caso, urls);
      caso.estado = 'ia_removeu'; caso.resolvido_em = agoraISO();
      await store.ajustarPeso(req.user.id, true);
      store.logar(caso, { quem: 'ia', tipo: 'removido', quando: caso.resolvido_em });
    } else if (v.decisao === 'arquivar_improcedente') {
      caso.estado = 'ia_arquivou'; caso.resolvido_em = agoraISO();
      await store.ajustarPeso(req.user.id, false);
      store.logar(caso, { quem: 'ia', tipo: 'arquivado', quando: caso.resolvido_em });
    } else {
      caso.estado = 'fila';
    }

    await store.guardarCaso(caso);
    res.json({ ok: true });
  })
);

/** GET /api/denuncias/fila?slug= — fila do admin da equipa (ambíguos + escalados). */
router.get(
  '/api/denuncias/fila',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(String(req.query.slug || ''));
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');
    if ((await getRole(team.id, req.user.id)) !== 'admin') throw new HttpError(403, 'Só o admin da equipa.');

    const casos = await store.listarEquipa(team.id);
    const fila = casos
      .filter((c) => c.estado === 'fila' || c.estado === 'escalada')
      .sort((a, b) => (b.prioritaria - a.prioritaria) || a.criado_em.localeCompare(b.criado_em));

    // Anexa um preview mínimo (borrado no cliente). Média assinada pelo middleware.
    const out = await Promise.all(fila.map(async (c) => {
      let preview_texto = null; let preview_media = null;
      if (c.target_type === 'post') {
        const { data: p } = await supabase.from('feed_posts').select('body').eq('id', c.target_id).maybeSingle();
        preview_texto = p?.body || null;
        const { data: m } = await supabase.from('feed_post_media').select('url').eq('post_id', c.target_id).limit(1);
        preview_media = m?.[0]?.url || null;
      } else if (c.target_type === 'comentario') {
        const { data: cm } = await supabase.from('comentarios').select('body').eq('id', c.target_id).maybeSingle();
        preview_texto = cm?.body || null;
      }
      return {
        id: c.id, categoria: c.categoria, target_type: c.target_type, tipo_alvo: c.target_type,
        prioritaria: c.prioritaria, estado: c.estado, criado_em: c.criado_em,
        preview_texto, preview_media,
      };
    }));
    res.json({ fila: out, total: out.length });
  })
);

/** POST /api/denuncias/:id/decidir — admin decide (remover|manter|avisar). */
router.post(
  '/api/denuncias/:id/decidir',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { slug, acao } = req.body || {};
    if (!['remover', 'manter', 'avisar'].includes(acao)) throw new HttpError(400, 'Ação inválida.');
    const team = await getTeamBySlug(String(slug || ''));
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');
    if ((await getRole(team.id, req.user.id)) !== 'admin') throw new HttpError(403, 'Só o admin da equipa.');

    const caso = await store.obterCaso(team.id, req.params.id);
    if (!caso) throw new HttpError(404, 'Denúncia não encontrada.');
    if (caso.estado === 'resolvida') return res.json({ ok: true, ja: true });

    if (acao === 'remover') {
      const { urls } = await resolverAlvo(caso.target_type, caso.target_id).catch(() => ({ urls: [] }));
      await removerConteudo(caso, urls);
      await store.ajustarPeso(caso.reporter_id, true);
    } else if (acao === 'avisar') {
      await store.ajustarPeso(caso.reporter_id, true); // procedente (aviso ao autor = fora do v1)
    } else {
      await store.ajustarPeso(caso.reporter_id, false); // manter = improcedente
    }
    caso.estado = 'resolvida';
    caso.resolvido_em = agoraISO();
    store.logar(caso, { quem: `admin:${req.user.id}`, tipo: acao, quando: caso.resolvido_em });
    await store.guardarCaso(caso);
    res.json({ ok: true });
  })
);

/** GET /api/denuncias/meus-desfechos — nº de denúncias MINHAS já analisadas (sem
 *  veredicto). Alimenta a notificação discreta no Início. */
router.get(
  '/api/denuncias/meus-desfechos',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data: membros } = await supabase.from('team_members').select('team_id').eq('user_id', req.user.id);
    const teamIds = (membros || []).map((m) => m.team_id);
    let n = 0;
    for (const tid of teamIds) {
      const casos = await store.listarEquipa(tid);
      n += casos.filter((c) => c.reporter_id === req.user.id && c.resolvido_em).length;
    }
    res.json({ total: n }); // só a contagem — nunca o veredicto
  })
);

/** GET /api/denuncias/agregados — SÓ super-admin (dono). Zero conteúdo, só números. */
router.get(
  '/api/denuncias/agregados',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { data: teams } = await supabase.from('teams').select('id');
    const ids = (teams || []).map((t) => t.id);
    ids.push('_sem'); // casos sem equipa (perfil)
    res.json(await store.agregados(ids));
  })
);

module.exports = router;
