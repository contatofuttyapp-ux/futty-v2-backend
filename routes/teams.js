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
    const { nome, cor, publica, localizacao, descricao } = req.body || {};
    if (!nome || !nome.trim()) throw new HttpError(400, 'O nome da equipa é obrigatório.');
    const corFinal = CORES_VALIDAS.includes(cor) ? cor : 'verde';
    const localizacaoFinal = localizacao ? String(localizacao).trim().slice(0, 100) : null;
    const descricaoFinal = descricao ? String(descricao).trim().slice(0, 300) : null;

    await ensureUserRow(req.user);

    // Cria a equipa (com retry se o slug colidir)
    let team = null;
    let lastError = null;
    for (let attempt = 0; attempt < 3 && !team; attempt += 1) {
      const slug = slugify(nome);
      const { data, error } = await supabase
        .from('teams')
        .insert({
          nome: nome.trim(),
          slug,
          cor: corFinal,
          criado_por: req.user.id,
          publica: !!publica,
          localizacao: localizacaoFinal,
          descricao: descricaoFinal,
        })
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

/**
 * GET /api/teams/explorar — equipas públicas (pesquisa por nome/cidade).
 * Registado ANTES de /api/teams/:slug para não colidir com o param :slug.
 */
router.get(
  '/api/teams/explorar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const loc = String(req.query.localizacao ?? '').trim();

    let query = supabase
      .from('teams')
      .select('id, nome, slug, cor, localizacao, descricao')
      .eq('publica', true);
    // q pesquisa em nome OU localização (a barra única diz "nome ou cidade").
    if (q) query = query.or(`nome.ilike.%${q}%,localizacao.ilike.%${q}%`);
    if (loc) query = query.ilike('localizacao', `%${loc}%`);

    const { data: teams, error } = await query;
    if (error) throw new HttpError(500, error.message);

    const ids = (teams || []).map((t) => t.id);
    const counts = {};
    const meus = new Set();
    if (ids.length) {
      const { data: mem } = await supabase.from('team_members').select('team_id, user_id').in('team_id', ids);
      for (const m of mem || []) {
        counts[m.team_id] = (counts[m.team_id] || 0) + 1;
        if (m.user_id === req.user.id) meus.add(m.team_id);
      }
    }
    const pendentes = new Set();
    if (ids.length) {
      const { data: reqs } = await supabase
        .from('team_join_requests')
        .select('team_id')
        .eq('user_id', req.user.id)
        .eq('status', 'pending')
        .in('team_id', ids);
      for (const r of reqs || []) pendentes.add(r.team_id);
    }

    const lista = (teams || [])
      .map((t) => ({
        id: t.id,
        nome: t.nome,
        slug: t.slug,
        cor: t.cor,
        localizacao: t.localizacao,
        descricao: t.descricao,
        membro_count: counts[t.id] || 0,
        ja_membro: meus.has(t.id),
        pedido_pendente: pendentes.has(t.id),
      }))
      .sort((a, b) => b.membro_count - a.membro_count);

    res.json({ teams: lista });
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

/** POST /api/teams/:slug/pedir-entrada — pedir entrada numa equipa pública. */
router.post(
  '/api/teams/:slug/pedir-entrada',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug, publica');
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');
    if (!team.publica) throw new HttpError(403, 'Esta equipa não é pública.');

    const role = await getRole(team.id, req.user.id);
    if (role) throw new HttpError(400, 'Já és membro desta equipa.');

    await ensureUserRow(req.user);
    const mensagem = req.body?.mensagem ? String(req.body.mensagem).trim().slice(0, 300) : null;

    const { data, error } = await supabase
      .from('team_join_requests')
      .insert({ team_id: team.id, user_id: req.user.id, mensagem, status: 'pending' })
      .select('id, status')
      .single();

    if (error) {
      // UNIQUE (team_id, user_id): já existe um pedido.
      if (error.code === '23505') {
        const { data: existente } = await supabase
          .from('team_join_requests')
          .select('id, status')
          .eq('team_id', team.id)
          .eq('user_id', req.user.id)
          .maybeSingle();
        // Se tinha sido rejeitado, reabre (volta a pending).
        if (existente?.status === 'rejected') {
          const { data: reaberto } = await supabase
            .from('team_join_requests')
            .update({ status: 'pending', mensagem, updated_at: new Date().toISOString() })
            .eq('id', existente.id)
            .select('id, status')
            .single();
          return res.json({ pedido: reaberto || existente });
        }
        return res.json({ pedido: existente || { id: null, status: 'pending' } });
      }
      throw new HttpError(500, error.message);
    }

    res.status(201).json({ pedido: data });
  })
);

/** GET /api/teams/:slug/pedidos — pedidos pendentes (só admin). */
router.get(
  '/api/teams/:slug/pedidos',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem ver os pedidos.');

    const { data, error } = await supabase
      .from('team_join_requests')
      .select('id, user_id, mensagem, created_at, users ( id, nome, avatar_url, nome_jogador )')
      .eq('team_id', team.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    if (error) throw new HttpError(500, error.message);

    const pedidos = (data || []).map((p) => ({
      id: p.id,
      user_id: p.user_id,
      nome: p.users?.nome || p.users?.nome_jogador || null,
      nome_jogador: p.users?.nome_jogador || null,
      avatar_url: p.users?.avatar_url || null,
      mensagem: p.mensagem,
      created_at: p.created_at,
    }));
    res.json({ pedidos });
  })
);

/** PATCH /api/teams/:slug/pedidos/:pedidoId — aprovar/rejeitar (só admin). */
router.patch(
  '/api/teams/:slug/pedidos/:pedidoId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const status = req.body?.status;
    if (!['approved', 'rejected'].includes(status)) throw new HttpError(400, 'status inválido.');

    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem decidir pedidos.');

    const { data: pedido } = await supabase
      .from('team_join_requests')
      .select('id, team_id, user_id, status')
      .eq('id', req.params.pedidoId)
      .maybeSingle();
    if (!pedido || pedido.team_id !== team.id) throw new HttpError(404, 'Pedido não encontrado.');

    // Aprovado → adiciona como membro (idempotente).
    if (status === 'approved') {
      const { error: me } = await supabase
        .from('team_members')
        .upsert({ team_id: team.id, user_id: pedido.user_id, role: 'member' }, { onConflict: 'user_id,team_id' });
      if (me) throw new HttpError(500, me.message);
    }

    const { data: updated, error } = await supabase
      .from('team_join_requests')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', pedido.id)
      .select('id, status, updated_at')
      .single();
    if (error) throw new HttpError(500, error.message);

    res.json({ pedido: updated });
  })
);

module.exports = router;
