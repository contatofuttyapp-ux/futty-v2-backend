// Futty v2.0 — Painel super-admin (gestão global de utilizadores e equipas).
// Todas as rotas exigem requireSuperAdmin. Montado sem prefixo em server.js
// (os paths /api/super/... são definidos aqui).
//
// ══ LEI DO DONO ══════════════════════════════════════════════════════════════
// A Super age sobre a PLATAFORMA (contas, times, suspensão), NUNCA sobre o
// CONTEÚDO (notas, votos, fotos). Moderação de conteúdo = SÓ pelo caminho
// registado (denúncias → triagem → decisão em log append-only). Aqui não se vê
// nem se edita conteúdo de ninguém: só se suspende/reativa. Créditos e pacote
// de Brilhante têm rota própria (routes/gabinete.js, aba "Brilhantes") — não
// se mexe neles por aqui.
// ═════════════════════════════════════════════════════════════════════════════
const express = require('express');
const { requireSuperAdmin } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase } = require('../utils/db');
const { avatarEhFigurinhaNossa } = require('../utils/figurinhaRegra');
const plataforma = require('../utils/plataformaStore');
const { cotaBytesPorTime, bytesUsadosPorTodosOsTimes } = require('../utils/resenhaCota');

const router = express.Router();

/**
 * GET /api/super/users?page=1&limit=50 — lista paginada de utilizadores.
 * Devolve { users, page, limit, total }.
 */
router.get(
  '/api/super/users',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const off = (page - 1) * limit;

    const { data, count, error } = await supabase
      .from('users')
      .select('id, nome, email, brilhante_creditos, avatar_url, is_super_admin, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(off, off + limit - 1);
    if (error) throw new HttpError(500, error.message);

    // Estado de suspensão (store de plataforma, sem DDL) anexado a cada linha.
    const { users: susUsers } = await plataforma.conjuntos();
    // 22-set (SPEC-FIGURINHA-3): `plan` saiu — o que resta ver aqui é o direito
    // de Brilhante (créditos e se já tem uma), pela mesma regra do resto do app
    // (o avatar atual ser um arquivo de figurinha nosso; Hotfix 26, antes era
    // avatar_url ≠ foto_url e a foto do Google contava). Sem avatar_url no
    // payload de volta: é detalhe de implementação, não algo que a tela precise
    // mostrar.
    const users = (data || []).map(({ avatar_url, ...u }) => ({
      ...u,
      suspenso: susUsers.has(u.id),
      tem_brilhante: avatarEhFigurinhaNossa(avatar_url),
    }));

    res.json({ users, page, limit, total: count || 0 });
  })
);

/**
 * PATCH /api/super/users/:id/suspender — suspende/reativa uma conta via FLAG de
 * plataforma. Body: { suspenso: true|false }. NÃO apaga nada, NÃO vê o conteúdo do
 * utilizador. Conta suspensa deixa de entrar (gate em requireAuth → 403 digno).
 */
router.patch(
  '/api/super/users/:id/suspender',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const suspenso = req.body?.suspenso === true;
    // Salvaguarda: a Super não se suspende a si própria (evita auto-trancar-se fora).
    if (suspenso && req.params.id === req.user.id) {
      throw new HttpError(400, 'Você não pode suspender a sua própria conta.');
    }
    await plataforma.definirUser(req.params.id, suspenso);
    res.json({ id: req.params.id, suspenso });
  })
);

/**
 * PATCH /api/super/users/:id/ban — suspende/reativa uma conta via ban nativo
 * do Supabase Auth. Body: { banned: true|false }.
 * Nota: tokens já emitidos só deixam de funcionar no próximo refresh (~1h).
 */
router.patch(
  '/api/super/users/:id/ban',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const banned = req.body?.banned === true;
    const { error } = await supabase.auth.admin.updateUserById(req.params.id, {
      ban_duration: banned ? '876000h' : 'none', // ~100 anos ≈ permanente
    });
    if (error) throw new HttpError(500, error.message);

    res.json({ banned });
  })
);

/**
 * GET /api/super/teams — lista todas as equipas com nr. de membros e uso de
 * mídia da Resenha (Rodada 15: cota de 500 MB por time).
 */
router.get(
  '/api/super/teams',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { data: teams, error } = await supabase
      .from('teams')
      .select('id, slug, nome, created_at')
      .order('created_at', { ascending: false });
    if (error) throw new HttpError(500, error.message);

    // Contagem de membros numa só query (evita N+1) e tally em JS.
    const { data: membros, error: mErr } = await supabase.from('team_members').select('team_id');
    if (mErr) throw new HttpError(500, mErr.message);
    const contagem = {};
    for (const m of membros || []) contagem[m.team_id] = (contagem[m.team_id] || 0) + 1;

    const [{ equipas: susEquipas }, bytesPorTime] = await Promise.all([
      plataforma.conjuntos(),
      bytesUsadosPorTodosOsTimes(), // {} se a migração 053 ainda não rodou (fail-open, já avisa no log)
    ]);
    const cotaMb = Math.round(cotaBytesPorTime() / (1024 * 1024));
    res.json({
      teams: (teams || []).map((t) => {
        const bytes = bytesPorTime[t.id];
        return {
          ...t,
          nr_membros: contagem[t.id] || 0,
          suspensa: susEquipas.has(t.id),
          // null = migração 053 ainda não rodou; o Gabinete mostra "—" nesse caso.
          midia_mb: bytes != null ? Math.round((bytes / (1024 * 1024)) * 10) / 10 : null,
          midia_cota_mb: cotaMb,
        };
      }),
    });
  })
);

/**
 * PATCH /api/super/teams/:id/suspender — suspende/reativa uma equipa via FLAG de
 * plataforma. Body: { suspensa: true|false }. NÃO edita o interior da equipa. Equipa
 * suspensa fica invisível na descoberta e inacessível (getTeamBySlug devolve 404).
 */
router.patch(
  '/api/super/teams/:id/suspender',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const suspensa = req.body?.suspensa === true;
    await plataforma.definirEquipa(req.params.id, suspensa);
    res.json({ id: req.params.id, suspensa });
  })
);

/**
 * DELETE /api/super/teams/:id — apaga uma equipa (cascade nas FKs).
 * Exige confirmação explícita no body: { confirmar: 'APAGAR' }.
 */
router.delete(
  '/api/super/teams/:id',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    if (req.body?.confirmar !== 'APAGAR') {
      throw new HttpError(400, 'Confirmação inválida. Envie { confirmar: "APAGAR" }.');
    }
    const { error } = await supabase.from('teams').delete().eq('id', req.params.id);
    if (error) throw new HttpError(500, error.message);

    res.json({ ok: true });
  })
);

// GET /api/super/stats existiu para os cards do /super de 16 secções
// (métricas incluíam users_pro/users_elite). Órfã desde o Gabinete 2.0 (a
// Visão Geral usa /api/super/gabinete/resumo) — nenhum frontend a chama.
// Removida nesta varredura em vez de só trocar `plan` por outra coisa:
// ninguém a lê.

module.exports = router;
