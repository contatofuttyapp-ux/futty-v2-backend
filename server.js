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

// =====================================================================
// JOGOS / SORTEIO (Fase 5)
// =====================================================================

const RATING_DEFAULT = 3; // jogadores sem votos ficam no meio da escala (1-5)

// Calcula o rating (média das notas recebidas) de cada user_id na equipa.
async function computeRatings(teamId, userIds) {
  const acc = {};
  userIds.forEach((id) => {
    acc[id] = { sum: 0, count: 0 };
  });

  if (userIds.length) {
    const { data } = await supabase
      .from('votes')
      .select('para_user_id, nota')
      .eq('team_id', teamId)
      .in('para_user_id', userIds);

    for (const v of data || []) {
      if (acc[v.para_user_id]) {
        acc[v.para_user_id].sum += v.nota;
        acc[v.para_user_id].count += 1;
      }
    }
  }

  const out = {};
  for (const id of userIds) {
    const { sum, count } = acc[id];
    out[id] = count ? sum / count : RATING_DEFAULT;
  }
  return out;
}

// Snake draft: ordena por rating desc e distribui A,B,C,C,B,A,A,...
function snakeDraft(players, numTimes) {
  const teams = Array.from({ length: numTimes }, () => []);
  let idx = 0;
  let dir = 1;
  for (const p of players) {
    teams[idx].push(p);
    if (dir === 1) {
      if (idx === numTimes - 1) dir = -1;
      else idx += 1;
    } else if (idx === 0) dir = 1;
    else idx -= 1;
  }
  return teams;
}

// Carrega um jogo com a sua equipa
async function loadGame(id) {
  const { data } = await supabase
    .from('games')
    .select('*, teams ( id, slug, nome, cor )')
    .eq('id', id)
    .maybeSingle();
  return data;
}

// Devolve a role do utilizador na equipa (ou null se não for membro)
async function getRole(teamId, userId) {
  const { data } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .maybeSingle();
  return data?.role || null;
}

// POST /api/games — criar jogo (só admin da equipa)
app.post('/api/games', requireAuth, async (req, res) => {
  const { team_slug, data, local, jogadores_por_time } = req.body || {};

  if (!team_slug || !data) {
    return res.status(400).json({ error: 'Equipa e data são obrigatórias.' });
  }

  const porTime = parseInt(jogadores_por_time, 10);
  if (!porTime || porTime < 1) {
    return res.status(400).json({ error: 'Indica quantos jogadores por time.' });
  }

  const { data: team } = await supabase
    .from('teams')
    .select('id, slug')
    .eq('slug', team_slug)
    .maybeSingle();

  if (!team) {
    return res.status(404).json({ error: 'Equipa não encontrada.' });
  }

  const role = await getRole(team.id, req.user.id);
  if (role !== 'admin') {
    return res.status(403).json({ error: 'Só admins podem criar jogos.' });
  }

  // num_times fica por definir; é calculado no sorteio conforme os confirmados.
  const { data: game, error } = await supabase
    .from('games')
    .insert({
      team_id: team.id,
      data: new Date(data).toISOString(),
      local: local?.trim() || null,
      jogadores_por_time: porTime,
    })
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json({ game });
});

// GET /api/teams/:slug/games — lista de jogos da equipa
app.get('/api/teams/:slug/games', requireAuth, async (req, res) => {
  const { data: team } = await supabase
    .from('teams')
    .select('id, slug, nome, cor')
    .eq('slug', req.params.slug)
    .maybeSingle();

  if (!team) {
    return res.status(404).json({ error: 'Equipa não encontrada.' });
  }

  const role = await getRole(team.id, req.user.id);
  if (!role) {
    return res.status(403).json({ error: 'Não és membro desta equipa.' });
  }

  const { data: games, error } = await supabase
    .from('games')
    .select('id, data, local, status, num_times, jogadores_por_time, sorteio_realizado, created_at')
    .eq('team_id', team.id)
    .order('data', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Contagem de confirmados por jogo
  const ids = (games || []).map((g) => g.id);
  const counts = {};
  if (ids.length) {
    const { data: gp } = await supabase
      .from('game_players')
      .select('game_id, confirmado')
      .in('game_id', ids);
    for (const row of gp || []) {
      if (row.confirmado) counts[row.game_id] = (counts[row.game_id] || 0) + 1;
    }
  }

  const lista = (games || []).map((g) => ({ ...g, confirmados: counts[g.id] || 0 }));

  res.json({ team: { ...team, role }, games: lista });
});

// GET /api/games/:id — detalhes do jogo
app.get('/api/games/:id', requireAuth, async (req, res) => {
  const game = await loadGame(req.params.id);
  if (!game || !game.teams) {
    return res.status(404).json({ error: 'Jogo não encontrado.' });
  }

  const role = await getRole(game.teams.id, req.user.id);
  if (!role) {
    return res.status(403).json({ error: 'Não és membro desta equipa.' });
  }

  const { data: gp } = await supabase
    .from('game_players')
    .select('confirmado, goleiro, users ( id, nome, email )')
    .eq('game_id', game.id);

  const userIds = (gp || []).map((p) => p.users?.id).filter(Boolean);
  const ratings = await computeRatings(game.teams.id, userIds);

  const players = (gp || [])
    .filter((p) => p.users)
    .map((p) => ({
      user_id: p.users.id,
      nome: p.users.nome || p.users.email,
      confirmado: p.confirmado,
      goleiro: p.goleiro,
      rating: Math.round((ratings[p.users.id] ?? RATING_DEFAULT) * 10) / 10,
    }));

  const meu = players.find((p) => p.user_id === req.user.id) || null;

  const team = game.teams;
  res.json({
    team: { id: team.id, slug: team.slug, nome: team.nome, cor: team.cor, role },
    game: {
      id: game.id,
      data: game.data,
      local: game.local,
      status: game.status,
      num_times: game.num_times,
      jogadores_por_time: game.jogadores_por_time,
      sorteio_realizado: game.sorteio_realizado,
      times_resultado: game.times_resultado,
    },
    players,
    meuEstado: meu ? { confirmado: meu.confirmado, goleiro: meu.goleiro } : null,
  });
});

// POST /api/games/:id/confirmar — confirmar/cancelar presença
app.post('/api/games/:id/confirmar', requireAuth, async (req, res) => {
  const { confirmado = true, goleiro = false } = req.body || {};

  const game = await loadGame(req.params.id);
  if (!game || !game.teams) {
    return res.status(404).json({ error: 'Jogo não encontrado.' });
  }

  const role = await getRole(game.teams.id, req.user.id);
  if (!role) {
    return res.status(403).json({ error: 'Não és membro desta equipa.' });
  }

  // Garante a linha em users
  await supabase
    .from('users')
    .upsert({ id: req.user.id, email: req.user.email }, { onConflict: 'id' });

  const { error } = await supabase
    .from('game_players')
    .upsert(
      {
        game_id: game.id,
        user_id: req.user.id,
        confirmado: !!confirmado,
        goleiro: !!goleiro,
      },
      { onConflict: 'game_id,user_id' }
    );

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ meuEstado: { confirmado: !!confirmado, goleiro: !!goleiro } });
});

// POST /api/games/:id/sortear — fazer o sorteio (só admin)
app.post('/api/games/:id/sortear', requireAuth, async (req, res) => {
  const game = await loadGame(req.params.id);
  if (!game || !game.teams) {
    return res.status(404).json({ error: 'Jogo não encontrado.' });
  }

  const role = await getRole(game.teams.id, req.user.id);
  if (role !== 'admin') {
    return res.status(403).json({ error: 'Só admins podem fazer o sorteio.' });
  }

  const porTime = game.jogadores_por_time;
  if (!porTime || porTime < 1) {
    return res.status(400).json({ error: 'Define os jogadores por time antes de sortear.' });
  }

  // Jogadores confirmados
  const { data: gp } = await supabase
    .from('game_players')
    .select('goleiro, users ( id, nome, email )')
    .eq('game_id', game.id)
    .eq('confirmado', true);

  const confirmados = (gp || []).filter((p) => p.users);

  // Nº de times calculado automaticamente: confirmados / jogadores por time.
  // Os jogadores que sobram são distribuídos pelos times existentes (snake draft),
  // sem criar um time incompleto.
  const numTimes = Math.floor(confirmados.length / porTime);
  if (numTimes < 2) {
    return res.status(400).json({
      error: `São precisos pelo menos ${porTime * 2} jogadores confirmados (${porTime} por time) para formar 2 times. Há ${confirmados.length} confirmados.`,
    });
  }

  const userIds = confirmados.map((p) => p.users.id);
  const ratings = await computeRatings(game.teams.id, userIds);

  const toPlayer = (p) => ({
    user_id: p.users.id,
    nome: p.users.nome || p.users.email,
    rating: Math.round((ratings[p.users.id] ?? RATING_DEFAULT) * 10) / 10,
    goleiro: p.goleiro,
  });

  // Separar goleiros dos jogadores de linha, ordenar por rating desc
  const goleiros = confirmados
    .filter((p) => p.goleiro)
    .map(toPlayer)
    .sort((a, b) => b.rating - a.rating);
  const linha = confirmados
    .filter((p) => !p.goleiro)
    .map(toPlayer)
    .sort((a, b) => b.rating - a.rating);

  // Cabeças de chave distribuídos via snake draft (melhores espalhados pelos times)
  const teamsArr = snakeDraft(linha, numTimes);

  // Goleiros: um por time (round-robin pelos melhores); extras entram à vez
  goleiros.forEach((g, i) => {
    teamsArr[i % numTimes].push(g);
  });

  const nomesTimes = ['Time A', 'Time B', 'Time C', 'Time D', 'Time E', 'Time F'];
  const times = teamsArr.map((jogadores, i) => {
    const media = jogadores.length
      ? jogadores.reduce((s, j) => s + j.rating, 0) / jogadores.length
      : 0;
    return {
      nome: nomesTimes[i] || `Time ${i + 1}`,
      rating_medio: Math.round(media * 100) / 100,
      jogadores,
    };
  });

  const resultado = {
    num_times: numTimes,
    total_jogadores: confirmados.length,
    times,
  };

  const { data: updated, error } = await supabase
    .from('games')
    .update({
      num_times: numTimes,
      sorteio_realizado: true,
      times_resultado: resultado,
      status: 'em_curso',
    })
    .eq('id', game.id)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({
    game: {
      id: updated.id,
      num_times: numTimes,
      sorteio_realizado: true,
      times_resultado: resultado,
      status: updated.status,
    },
  });
});

const port = PORT || 3001;
app.listen(port, () => {
  console.log(`[Futty] Servidor a correr em http://localhost:${port}`);
  console.log(`[Futty] Health check: http://localhost:${port}/health`);
});

module.exports = { app, supabase };
