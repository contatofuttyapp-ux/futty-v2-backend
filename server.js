// Futty v2.0 — Backend (Express + Supabase)
require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, PORT } = process.env;

// Validação básica de configuração
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    '[Futty] ERRO: faltam variáveis de ambiente. Verifica o .env (SUPABASE_URL e SUPABASE_SERVICE_KEY).'
  );
  process.exit(1);
}

// Cliente admin (service_role) — uso exclusivo no servidor, ignora RLS.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    service: 'futty-backend',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    supabase: 'unknown',
  };

  // Testa ligação ao Supabase (uma query leve à tabela users)
  try {
    const { error } = await supabase.from('users').select('id', { count: 'exact', head: true });
    health.supabase = error ? 'error' : 'connected';
    if (error) health.supabaseError = error.message;
  } catch (err) {
    health.supabase = 'error';
    health.supabaseError = err.message;
  }

  res.json(health);
});

// Raiz
app.get('/', (req, res) => {
  res.json({ name: 'Futty v2.0 API', status: 'running' });
});

// =====================================================================
// AUTENTICAÇÃO
// Middleware: valida o JWT do utilizador (Authorization: Bearer <token>)
// enviado pelo frontend e injeta req.user.
// =====================================================================
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Token em falta.' });
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Sessão inválida.' });
  }

  req.user = data.user;
  next();
}

// Middleware opcional: popula req.user se houver token válido, sem bloquear.
async function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    const { data } = await supabase.auth.getUser(token);
    if (data?.user) req.user = data.user;
  }
  next();
}

// Gera um slug a partir do nome (sem acentos, minúsculas, com sufixo aleatório)
function slugify(nome) {
  const base = nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base || 'equipa'}-${suffix}`;
}

const CORES_VALIDAS = ['verde', 'azul', 'vermelho', 'preto'];

// =====================================================================
// TEAMS
// =====================================================================

// POST /api/teams — cria equipa e adiciona o criador como admin
app.post('/api/teams', requireAuth, async (req, res) => {
  const { nome, cor } = req.body || {};

  if (!nome || !nome.trim()) {
    return res.status(400).json({ error: 'O nome da equipa é obrigatório.' });
  }
  const corFinal = CORES_VALIDAS.includes(cor) ? cor : 'verde';

  // Garante que existe a linha em public.users (caso o trigger não tenha corrido)
  await supabase
    .from('users')
    .upsert({ id: req.user.id, email: req.user.email }, { onConflict: 'id' });

  // Cria a equipa (com retry se o slug colidir)
  let team = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3 && !team; attempt++) {
    const slug = slugify(nome);
    const { data, error } = await supabase
      .from('teams')
      .insert({ nome: nome.trim(), slug, cor: corFinal, criado_por: req.user.id })
      .select()
      .single();

    if (!error) {
      team = data;
    } else if (error.code === '23505') {
      lastError = error; // slug duplicado -> tenta de novo
    } else {
      return res.status(500).json({ error: error.message });
    }
  }

  if (!team) {
    return res
      .status(500)
      .json({ error: lastError?.message || 'Não foi possível criar a equipa.' });
  }

  // Adiciona o criador como admin
  const { error: memberError } = await supabase.from('team_members').insert({
    user_id: req.user.id,
    team_id: team.id,
    role: 'admin',
  });

  if (memberError) {
    // rollback: remove a equipa criada
    await supabase.from('teams').delete().eq('id', team.id);
    return res.status(500).json({ error: memberError.message });
  }

  res.status(201).json({ team });
});

// GET /api/teams — lista as equipas de que o utilizador é membro
app.get('/api/teams', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('team_members')
    .select('role, teams ( id, nome, slug, cor, criado_por, created_at )')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const teams = (data || [])
    .filter((row) => row.teams)
    .map((row) => ({ ...row.teams, role: row.role }));

  res.json({ teams });
});

// GET /api/teams/:slug — detalhes da equipa + membros (só para membros)
app.get('/api/teams/:slug', requireAuth, async (req, res) => {
  const { data: team, error: teamError } = await supabase
    .from('teams')
    .select('id, nome, slug, cor, criado_por, created_at')
    .eq('slug', req.params.slug)
    .single();

  if (teamError || !team) {
    return res.status(404).json({ error: 'Equipa não encontrada.' });
  }

  // Confirma que o utilizador pertence à equipa
  const { data: membership } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', team.id)
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (!membership) {
    return res.status(403).json({ error: 'Não és membro desta equipa.' });
  }

  // Lista de membros com dados do utilizador
  const { data: rawMembers, error: membersError } = await supabase
    .from('team_members')
    .select('role, created_at, users ( id, nome, email, avatar_url )')
    .eq('team_id', team.id)
    .order('created_at', { ascending: true });

  if (membersError) {
    return res.status(500).json({ error: membersError.message });
  }

  const members = (rawMembers || []).map((m) => ({
    id: m.users?.id,
    nome: m.users?.nome,
    email: m.users?.email,
    avatar_url: m.users?.avatar_url,
    role: m.role,
    created_at: m.created_at,
  }));

  res.json({ team: { ...team, role: membership.role }, members });
});

// =====================================================================
// CONVITES (Fase 4)
// =====================================================================

const CONVITE_DIAS = 7;

// POST /api/teams/:slug/convite — gera um token de convite (membros da equipa)
app.post('/api/teams/:slug/convite', requireAuth, async (req, res) => {
  const { data: team, error: teamError } = await supabase
    .from('teams')
    .select('id, slug, nome, cor')
    .eq('slug', req.params.slug)
    .single();

  if (teamError || !team) {
    return res.status(404).json({ error: 'Equipa não encontrada.' });
  }

  // Confirma que o utilizador é membro da equipa
  const { data: membership } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', team.id)
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (!membership) {
    return res.status(403).json({ error: 'Não és membro desta equipa.' });
  }

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + CONVITE_DIAS * 24 * 60 * 60 * 1000).toISOString();

  const { data: convite, error } = await supabase
    .from('convites')
    .insert({ team_id: team.id, token, criado_por: req.user.id, expires_at: expiresAt })
    .select('token, expires_at')
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json({ token: convite.token, expires_at: convite.expires_at });
});

// GET /api/convite/:token — valida o convite (público; auth opcional para saber se já é membro)
app.get('/api/convite/:token', optionalAuth, async (req, res) => {
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

  // O utilizador autenticado já é membro?
  let jaMembro = false;
  if (req.user && team) {
    const { data: m } = await supabase
      .from('team_members')
      .select('id')
      .eq('team_id', team.id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    jaMembro = !!m;
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
});

// POST /api/convite/:token/aceitar — associa o utilizador à equipa e marca o token como usado
app.post('/api/convite/:token/aceitar', requireAuth, async (req, res) => {
  const { data: convite } = await supabase
    .from('convites')
    .select('id, team_id, usado_por, expires_at')
    .eq('token', req.params.token)
    .maybeSingle();

  if (!convite) {
    return res.status(404).json({ error: 'Convite não encontrado.' });
  }

  const { data: team } = await supabase
    .from('teams')
    .select('id, slug, nome, cor')
    .eq('id', convite.team_id)
    .single();

  if (!team) {
    return res.status(404).json({ error: 'Equipa não encontrada.' });
  }

  // Garante que existe a linha em public.users
  await supabase
    .from('users')
    .upsert({ id: req.user.id, email: req.user.email }, { onConflict: 'id' });

  // Já é membro? -> idempotente, não consome o convite
  const { data: existing } = await supabase
    .from('team_members')
    .select('id')
    .eq('team_id', team.id)
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (existing) {
    return res.json({
      jaMembro: true,
      team: { slug: team.slug, nome: team.nome, cor: team.cor },
    });
  }

  // Valida o estado do convite (apenas para novos membros)
  if (convite.usado_por) {
    return res.status(400).json({ error: 'Este convite já foi utilizado.' });
  }
  if (new Date(convite.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'Este convite expirou.' });
  }

  // Adiciona como membro
  const { error: memberError } = await supabase
    .from('team_members')
    .insert({ user_id: req.user.id, team_id: team.id, role: 'member' });

  if (memberError) {
    if (memberError.code === '23505') {
      // corrida: entretanto já se tornou membro
      return res.json({
        jaMembro: true,
        team: { slug: team.slug, nome: team.nome, cor: team.cor },
      });
    }
    return res.status(500).json({ error: memberError.message });
  }

  // Marca o convite como usado
  await supabase.from('convites').update({ usado_por: req.user.id }).eq('id', convite.id);

  res.status(201).json({
    jaMembro: false,
    team: { slug: team.slug, nome: team.nome, cor: team.cor },
  });
});

const port = PORT || 3001;
app.listen(port, () => {
  console.log(`[Futty] Servidor a correr em http://localhost:${port}`);
  console.log(`[Futty] Health check: http://localhost:${port}/health`);
});

module.exports = { app, supabase };
