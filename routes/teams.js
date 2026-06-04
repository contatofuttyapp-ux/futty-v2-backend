// Futty v2.0 — Rotas de equipas e convites.
const express = require('express');
const crypto = require('crypto');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, getTeamBySlug, getRole, ensureUserRow, requireTeamMember } = require('../utils/db');
const { slugify } = require('../utils/helpers');

const router = express.Router();

const CORES_VALIDAS = ['verde', 'azul', 'vermelho', 'preto'];
const CONVITE_DIAS = 7;

/** POST /api/teams — cria uma equipa e adiciona o criador como admin. */
router.post(
  '/api/teams',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { nome, cor } = req.body || {};
    if (!nome || !nome.trim()) throw new HttpError(400, 'O nome da equipa é obrigatório.');
    const corFinal = CORES_VALIDAS.includes(cor) ? cor : 'verde';

    await ensureUserRow(req.user);

    // Cria a equipa (com retry se o slug colidir)
    let team = null;
    let lastError = null;
    for (let attempt = 0; attempt < 3 && !team; attempt += 1) {
      const slug = slugify(nome);
      const { data, error } = await supabase
        .from('teams')
        .insert({ nome: nome.trim(), slug, cor: corFinal, criado_por: req.user.id })
        .select()
        .single();
      if (!error) team = data;
      else if (error.code === '23505') lastError = error; // slug duplicado -> tenta de novo
      else throw new HttpError(500, error.message);
    }
    if (!team) throw new HttpError(500, lastError?.message || 'Não foi possível criar a equipa.');

    // Adiciona o criador como admin (rollback se falhar)
    const { error: memberError } = await supabase
      .from('team_members')
      .insert({ user_id: req.user.id, team_id: team.id, role: 'admin' });
    if (memberError) {
      await supabase.from('teams').delete().eq('id', team.id);
      throw new HttpError(500, memberError.message);
    }

    res.status(201).json({ team });
  })
);

/** GET /api/teams — lista as equipas de que o utilizador é membro. */
router.get(
  '/api/teams',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from('team_members')
      .select('role, teams ( id, nome, slug, cor, criado_por, created_at )')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: true });
    if (error) throw new HttpError(500, error.message);

    const teams = (data || [])
      .filter((row) => row.teams)
      .map((row) => ({ ...row.teams, role: row.role }));
    res.json({ teams });
  })
);

/** GET /api/teams/:slug — detalhes da equipa + lista de membros (só membros). */
router.get(
  '/api/teams/:slug',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug);
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');

    const role = await getRole(team.id, req.user.id);
    if (!role) throw new HttpError(403, 'Não és membro desta equipa.');

    const { data: rawMembers, error } = await supabase
      .from('team_members')
      .select('role, created_at, users ( id, nome, email, avatar_url )')
      .eq('team_id', team.id)
      .order('created_at', { ascending: true });
    if (error) throw new HttpError(500, error.message);

    const members = (rawMembers || []).map((m) => ({
      id: m.users?.id,
      nome: m.users?.nome,
      email: m.users?.email,
      avatar_url: m.users?.avatar_url,
      role: m.role,
      created_at: m.created_at,
    }));

    res.json({ team: { ...team, role }, members });
  })
);

/** POST /api/teams/:slug/convite — gera um token de convite (qualquer membro). */
router.post(
  '/api/teams/:slug/convite',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team } = await requireTeamMember(req.params.slug, req.user.id);

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + CONVITE_DIAS * 86400000).toISOString();

    const { data: convite, error } = await supabase
      .from('convites')
      .insert({ team_id: team.id, token, criado_por: req.user.id, expires_at: expiresAt })
      .select('token, expires_at')
      .single();
    if (error) throw new HttpError(500, error.message);

    res.status(201).json({ token: convite.token, expires_at: convite.expires_at });
  })
);

/**
 * GET /api/convite/:token — valida um convite (público; auth opcional).
 * Devolve sempre 200 com { valido, motivo, ... }.
 */
router.get(
  '/api/convite/:token',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { data: convite } = await supabase
      .from('convites')
      .select('id, team_id, criado_por, usado_por, expires_at')
      .eq('token', req.params.token)
      .maybeSingle();

    if (!convite) {
      return res.json({ valido: false, motivo: 'nao_encontrado', team: null });
    }

    const { data: team } = await supabase
      .from('teams')
      .select('id, nome, slug, cor')
      .eq('id', convite.team_id)
      .single();
    const { data: inviter } = await supabase
      .from('users')
      .select('nome, email')
      .eq('id', convite.criado_por)
      .maybeSingle();

    let motivo = null;
    if (convite.usado_por) motivo = 'usado';
    else if (new Date(convite.expires_at).getTime() < Date.now()) motivo = 'expirado';

    let jaMembro = false;
    if (req.user && team) {
      const role = await getRole(team.id, req.user.id);
      jaMembro = !!role;
    }

    res.json({
      valido: motivo === null,
      motivo,
      autenticado: !!req.user,
      jaMembro,
      convidadoPor: inviter?.nome || inviter?.email || null,
      expires_at: convite.expires_at,
      team: team ? { nome: team.nome, slug: team.slug, cor: team.cor } : null,
    });
  })
);

/** POST /api/convite/:token/aceitar — entra na equipa e consome o convite. */
router.post(
  '/api/convite/:token/aceitar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data: convite } = await supabase
      .from('convites')
      .select('id, team_id, usado_por, expires_at')
      .eq('token', req.params.token)
      .maybeSingle();
    if (!convite) throw new HttpError(404, 'Convite não encontrado.');

    const { data: team } = await supabase
      .from('teams')
      .select('id, slug, nome, cor')
      .eq('id', convite.team_id)
      .single();
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');

    await ensureUserRow(req.user);

    const teamResumo = { slug: team.slug, nome: team.nome, cor: team.cor };

    // Já é membro? -> idempotente, não consome o convite
    const existingRole = await getRole(team.id, req.user.id);
    if (existingRole) {
      return res.json({ jaMembro: true, team: teamResumo });
    }

    // Valida o estado do convite (apenas para novos membros)
    if (convite.usado_por) throw new HttpError(400, 'Este convite já foi utilizado.');
    if (new Date(convite.expires_at).getTime() < Date.now()) {
      throw new HttpError(400, 'Este convite expirou.');
    }

    // Adiciona como membro
    const { error: memberError } = await supabase
      .from('team_members')
      .insert({ user_id: req.user.id, team_id: team.id, role: 'member' });
    if (memberError) {
      if (memberError.code === '23505') {
        return res.json({ jaMembro: true, team: teamResumo }); // corrida: já é membro
      }
      throw new HttpError(500, memberError.message);
    }

    // Marca o convite como usado
    await supabase.from('convites').update({ usado_por: req.user.id }).eq('id', convite.id);

    res.status(201).json({ jaMembro: false, team: teamResumo });
  })
);

module.exports = router;
