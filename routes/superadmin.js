// Futty v2.0 — Painel super-admin (gestão global de utilizadores e equipas).
// Todas as rotas exigem requireSuperAdmin. Montado sem prefixo em server.js
// (os paths /api/super/... são definidos aqui).
const express = require('express');
const { requireSuperAdmin } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase } = require('../utils/db');

const router = express.Router();

const PLANOS = ['free', 'pro', 'elite'];

// Início do dia de hoje (UTC) em ISO — para contagens "hoje".
function inicioHojeUTC() {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
}

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
      .select('id, nome, email, plan, is_super_admin, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(off, off + limit - 1);
    if (error) throw new HttpError(500, error.message);

    res.json({ users: data || [], page, limit, total: count || 0 });
  })
);

/**
 * PATCH /api/super/users/:id/plano — muda o plano de qualquer utilizador.
 * Body: { plano: 'free' | 'pro' | 'elite' }.
 */
router.patch(
  '/api/super/users/:id/plano',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const plano = req.body?.plano;
    if (!PLANOS.includes(plano)) throw new HttpError(400, 'Plano inválido (free, pro ou elite).');

    const { data, error } = await supabase
      .from('users')
      .update({ plan: plano })
      .eq('id', req.params.id)
      .select('id, nome, email, plan, is_super_admin, created_at')
      .single();
    if (error) throw new HttpError(500, error.message);
    if (!data) throw new HttpError(404, 'Utilizador não encontrado.');

    res.json({ user: data });
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
 * GET /api/super/teams — lista todas as equipas com nr. de membros.
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

    res.json({
      teams: (teams || []).map((t) => ({ ...t, nr_membros: contagem[t.id] || 0 })),
    });
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
      throw new HttpError(400, 'Confirmação inválida. Envia { confirmar: "APAGAR" }.');
    }
    const { error } = await supabase.from('teams').delete().eq('id', req.params.id);
    if (error) throw new HttpError(500, error.message);

    res.json({ ok: true });
  })
);

/**
 * GET /api/super/stats — métricas globais para os cards do painel.
 */
router.get(
  '/api/super/stats',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const hoje = inicioHojeUTC();
    const contar = (tabela, aplicar) => {
      let q = supabase.from(tabela).select('id', { count: 'exact', head: true });
      if (aplicar) q = aplicar(q);
      return q;
    };

    const [totalUsers, totalTeams, usersPro, usersElite, usersHoje, teamsHoje] = await Promise.all([
      contar('users'),
      contar('teams'),
      contar('users', (q) => q.eq('plan', 'pro')),
      contar('users', (q) => q.eq('plan', 'elite')),
      contar('users', (q) => q.gte('created_at', hoje)),
      contar('teams', (q) => q.gte('created_at', hoje)),
    ]);

    const erro = [totalUsers, totalTeams, usersPro, usersElite, usersHoje, teamsHoje].find((r) => r.error);
    if (erro) throw new HttpError(500, erro.error.message);

    res.json({
      total_users: totalUsers.count || 0,
      total_teams: totalTeams.count || 0,
      users_pro: usersPro.count || 0,
      users_elite: usersElite.count || 0,
      users_hoje: usersHoje.count || 0,
      teams_hoje: teamsHoje.count || 0,
    });
  })
);

module.exports = router;
