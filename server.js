// Futty v2.0 — Backend (Express + Supabase)
require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
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

// Ficheiros estáticos (fotos de campeão, etc.) em /uploads
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

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

// Baralha um array in-place (Fisher-Yates).
function fisherYates(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Ordena por rating desc; dentro de jogadores com o MESMO rating a ordem é
// aleatória. Baralha primeiro (Fisher-Yates) e depois faz um sort estável por
// rating — como o sort do JS é estável, a ordem aleatória mantém-se em empates.
// Assim "Sortear novamente" dá times diferentes mesmo com ratings iguais.
function orderByRatingDesc(players) {
  const arr = fisherYates(players.slice());
  arr.sort((a, b) => b.rating - a.rating);
  return arr;
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
    .select('confirmado, goleiro, cabeca_chave, users ( id, nome, email )')
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
      cabeca_chave: p.cabeca_chave,
      rating: Math.round((ratings[p.users.id] ?? RATING_DEFAULT) * 10) / 10,
    }));

  const meu = players.find((p) => p.user_id === req.user.id) || null;

  // Já votei neste jogo?
  const { count: votosCount } = await supabase
    .from('votes')
    .select('id', { count: 'exact', head: true })
    .eq('game_id', game.id)
    .eq('de_user_id', req.user.id);
  const jaVotei = (votosCount || 0) > 0;

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
    meuEstado: meu
      ? { confirmado: meu.confirmado, goleiro: meu.goleiro, cabeca_chave: meu.cabeca_chave }
      : null,
    jaVotei,
  });
});

// POST /api/games/:id/jogador — admin marca um jogador como goleiro/cabeça de chave
app.post('/api/games/:id/jogador', requireAuth, async (req, res) => {
  const { user_id, goleiro, cabeca_chave } = req.body || {};
  if (!user_id) {
    return res.status(400).json({ error: 'user_id em falta.' });
  }

  const game = await loadGame(req.params.id);
  if (!game || !game.teams) {
    return res.status(404).json({ error: 'Jogo não encontrado.' });
  }

  const role = await getRole(game.teams.id, req.user.id);
  if (role !== 'admin') {
    return res.status(403).json({ error: 'Só admins podem marcar jogadores.' });
  }

  const patch = {};
  if (typeof goleiro === 'boolean') patch.goleiro = goleiro;
  if (typeof cabeca_chave === 'boolean') patch.cabeca_chave = cabeca_chave;
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'Nada para atualizar.' });
  }

  const { data: updated, error } = await supabase
    .from('game_players')
    .update(patch)
    .eq('game_id', game.id)
    .eq('user_id', user_id)
    .select('user_id, goleiro, cabeca_chave')
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: error.message });
  }
  if (!updated) {
    return res.status(404).json({ error: 'Esse jogador não está confirmado neste jogo.' });
  }

  res.json({ jogador: updated });
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
    .select('goleiro, cabeca_chave, users ( id, nome, email )')
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
    cabeca_chave: p.cabeca_chave,
  });

  const all = confirmados.map(toPlayer);

  // Grupos por prioridade: goleiros -> cabeças de chave -> linha. Ordenados por
  // rating desc com desempate aleatório (sem votos => ratings iguais => aleatório).
  const goleiros = orderByRatingDesc(all.filter((p) => p.goleiro));
  const cabecas = orderByRatingDesc(all.filter((p) => p.cabeca_chave && !p.goleiro));
  const linhaBase = all.filter((p) => !p.goleiro && !p.cabeca_chave);

  const teamsArr = Array.from({ length: numTimes }, () => []);
  const avisos = [];

  // 1) GOLEIROS — um por time (ordem de times aleatória). Excesso vira linha.
  const goleirosAssign = goleiros.slice(0, numTimes);
  const goleirosExtra = goleiros.slice(numTimes);
  fisherYates([...teamsArr]).forEach((time, i) => {
    if (goleirosAssign[i]) time.push(goleirosAssign[i]);
  });
  // Só avisa quando há goleiros marcados mas não chegam para todos os times.
  // (Sem goleiros marcados não gera aviso — marcar goleiro é opcional.)
  if (goleiros.length > 0 && goleiros.length < numTimes) {
    avisos.push(
      `Há ${goleiros.length} goleiro(s) para ${numTimes} times: ${numTimes - goleiros.length} time(s) ficam sem goleiro.`
    );
  }
  if (goleirosExtra.length) {
    avisos.push(`${goleirosExtra.length} goleiro(s) a mais entram como jogadores de linha.`);
  }

  // 2) CABEÇAS DE CHAVE — um por time (ordem aleatória). Excesso entra na linha.
  const cabecasAssign = cabecas.slice(0, numTimes);
  const cabecasExtra = cabecas.slice(numTimes);
  fisherYates([...teamsArr]).forEach((time, i) => {
    if (cabecasAssign[i]) time.push(cabecasAssign[i]);
  });

  // 3) LINHA (com excessos de goleiros/cabeças) — snake draft por rating desc.
  const linha = orderByRatingDesc(linhaBase.concat(goleirosExtra, cabecasExtra));
  const linhaDraft = snakeDraft(linha, numTimes);
  fisherYates([...teamsArr]).forEach((time, i) => {
    time.push(...linhaDraft[i]);
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
    avisos,
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

// POST /api/games/:id/votar — votar nos jogadores (1 a 5), uma vez por jogo
app.post('/api/games/:id/votar', requireAuth, async (req, res) => {
  const { votos } = req.body || {};
  if (!Array.isArray(votos) || votos.length === 0) {
    return res.status(400).json({ error: 'Não há votos para registar.' });
  }

  const game = await loadGame(req.params.id);
  if (!game || !game.teams) {
    return res.status(404).json({ error: 'Jogo não encontrado.' });
  }

  const role = await getRole(game.teams.id, req.user.id);
  if (!role) {
    return res.status(403).json({ error: 'Não és membro desta equipa.' });
  }

  // Só se pode votar após o jogo (em curso ou terminado)
  if (game.status !== 'em_curso' && game.status !== 'terminado') {
    return res.status(400).json({ error: 'A votação abre depois do sorteio do jogo.' });
  }

  // Um voto por jogo
  const { count: jaVotou } = await supabase
    .from('votes')
    .select('id', { count: 'exact', head: true })
    .eq('game_id', game.id)
    .eq('de_user_id', req.user.id);
  if ((jaVotou || 0) > 0) {
    return res.status(400).json({ error: 'Já votaste neste jogo.' });
  }

  // Jogadores confirmados (só se pode votar nestes, e não em si próprio)
  const { data: gp } = await supabase
    .from('game_players')
    .select('user_id')
    .eq('game_id', game.id)
    .eq('confirmado', true);
  const confirmadosIds = new Set((gp || []).map((p) => p.user_id));

  await supabase
    .from('users')
    .upsert({ id: req.user.id, email: req.user.email }, { onConflict: 'id' });

  const rows = [];
  for (const v of votos) {
    const para = v?.para_user_id;
    const nota = parseInt(v?.nota, 10);
    if (!para || para === req.user.id) continue; // não vota em si próprio
    if (!confirmadosIds.has(para)) continue; // só jogadores confirmados
    if (!(nota >= 1 && nota <= 5)) continue; // nota válida
    rows.push({
      de_user_id: req.user.id,
      para_user_id: para,
      team_id: game.teams.id,
      game_id: game.id,
      nota,
    });
  }

  if (rows.length === 0) {
    return res.status(400).json({ error: 'Nenhum voto válido (1 a 5, em jogadores confirmados).' });
  }

  const { error } = await supabase.from('votes').insert(rows);
  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json({ registados: rows.length });
});

// =====================================================================
// RANKING (pesos da v1)
// =====================================================================
const RANKING_PESOS = { media: 40, vitorias: 20, artilharia: 12, gols: 10, destaque: 8, presenca: 10 };
const round2 = (n) => Math.round(n * 100) / 100;

function periodoCutoffISO(periodo) {
  const now = Date.now();
  if (periodo === 'semana') return new Date(now - 7 * 86400000).toISOString();
  if (periodo === 'mes') return new Date(now - 30 * 86400000).toISOString();
  return null; // geral
}

// Carrega a equipa e valida que o utilizador é membro (responde e devolve null se não).
async function requireTeamMember(req, res) {
  const { data: team } = await supabase
    .from('teams')
    .select('id, slug, nome, cor')
    .eq('slug', req.params.slug)
    .maybeSingle();
  if (!team) {
    res.status(404).json({ error: 'Equipa não encontrada.' });
    return null;
  }
  const role = await getRole(team.id, req.user.id);
  if (!role) {
    res.status(403).json({ error: 'Não és membro desta equipa.' });
    return null;
  }
  return { team, role };
}

// Jogo atual de votação: mais recente sorteado, em curso/terminado.
async function currentVotingGame(teamId) {
  const { data } = await supabase
    .from('games')
    .select('id, local, data, status')
    .eq('team_id', teamId)
    .eq('sorteio_realizado', true)
    .in('status', ['em_curso', 'terminado'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

// Constrói o ranking completo (score ponderado). Reutilizado pelo perfil.
async function buildRanking(teamId, periodo, meUserId) {
  // Membros (+ stats)
  const { data: membros } = await supabase
    .from('team_members')
    .select('gols, artilharia, vitorias, destaque, users ( id, nome, email, avatar_url )')
    .eq('team_id', teamId);
  const rows = (membros || []).filter((m) => m.users);

  // Votos no período (média de notas)
  const cutoff = periodoCutoffISO(periodo);
  let vq = supabase.from('votes').select('para_user_id, nota, created_at').eq('team_id', teamId);
  if (cutoff) vq = vq.gte('created_at', cutoff);
  const { data: votos } = await vq;
  const voteAgg = {};
  for (const v of votos || []) {
    if (!voteAgg[v.para_user_id]) voteAgg[v.para_user_id] = { sum: 0, count: 0 };
    voteAgg[v.para_user_id].sum += v.nota;
    voteAgg[v.para_user_id].count += 1;
  }

  // Presença: confirmações no último mês (game_players.created_at)
  const presCut = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: gameRows } = await supabase.from('games').select('id').eq('team_id', teamId);
  const gameIds = (gameRows || []).map((g) => g.id);
  const presCount = {};
  if (gameIds.length) {
    const { data: gps } = await supabase
      .from('game_players')
      .select('user_id, created_at')
      .in('game_id', gameIds)
      .eq('confirmado', true)
      .gte('created_at', presCut);
    for (const gp of gps || []) presCount[gp.user_id] = (presCount[gp.user_id] || 0) + 1;
  }

  // Quem foi goleiro em pelo menos um jogo da equipa (gols/artilharia valem 3x no score)
  const goleiroSet = new Set();
  if (gameIds.length) {
    const { data: gks } = await supabase
      .from('game_players')
      .select('user_id')
      .in('game_id', gameIds)
      .eq('goleiro', true);
    for (const r of gks || []) goleiroSet.add(r.user_id);
  }

  // Jogo atual de votação: minha nota + lista de jogadores votáveis (confirmados)
  const vgame = await currentVotingGame(teamId);
  const minhaNotaPor = {};
  let votaveis = [];
  if (vgame) {
    const { data: conf } = await supabase
      .from('game_players')
      .select('user_id')
      .eq('game_id', vgame.id)
      .eq('confirmado', true);
    votaveis = (conf || []).map((c) => c.user_id).filter((idu) => idu !== meUserId);

    if (meUserId) {
      const { data: meus } = await supabase
        .from('votes')
        .select('para_user_id, nota')
        .eq('game_id', vgame.id)
        .eq('de_user_id', meUserId);
      for (const v of meus || []) minhaNotaPor[v.para_user_id] = v.nota;
    }
  }

  // Valores base por jogador. Goleiros: gols/artilharia valem 3x no SCORE,
  // mas os números mostrados (gols/artilharia) são sempre os reais.
  const base = rows.map((m) => {
    const u = m.users;
    const a = voteAgg[u.id];
    const media = a && a.count ? a.sum / a.count : 0;
    const isGoleiro = goleiroSet.has(u.id);
    const gols = m.gols || 0;
    const artilharia = m.artilharia || 0;
    return {
      user_id: u.id,
      nome: u.nome || u.email,
      avatar_url: u.avatar_url || null,
      media_votos: round2(media),
      votos: a ? a.count : 0,
      vitorias: m.vitorias || 0,
      gols, // real (mostrado)
      artilharia, // real (mostrado)
      destaque: m.destaque || 0,
      presenca: presCount[u.id] || 0,
      minha_nota: minhaNotaPor[u.id] ?? null,
      is_goleiro: isGoleiro,
      gols_efetivos: isGoleiro ? gols * 3 : gols, // usado no score
      artilharia_efetiva: isGoleiro ? artilharia * 3 : artilharia, // usado no score
    };
  });

  // Máximos do grupo para normalizar (gols/artilharia normalizados pelos efetivos)
  const maxOf = (key) => base.reduce((m, b) => Math.max(m, b[key]), 0);
  const maxVit = maxOf('vitorias');
  const maxArt = maxOf('artilharia_efetiva');
  const maxGols = maxOf('gols_efetivos');
  const maxDest = maxOf('destaque');
  const maxPres = maxOf('presenca');
  const norm = (v, m) => (m > 0 ? v / m : 0);

  const ranking = base
    .map((b) => {
      const media_pontos = RANKING_PESOS.media * (b.media_votos / 5);
      const vitorias_pontos = RANKING_PESOS.vitorias * norm(b.vitorias, maxVit);
      const artilharia_pontos = RANKING_PESOS.artilharia * norm(b.artilharia_efetiva, maxArt);
      const gols_pontos = RANKING_PESOS.gols * norm(b.gols_efetivos, maxGols);
      const destaque_pontos = RANKING_PESOS.destaque * norm(b.destaque, maxDest);
      const presenca_pontos = RANKING_PESOS.presenca * norm(b.presenca, maxPres);
      const score =
        media_pontos + vitorias_pontos + artilharia_pontos + gols_pontos + destaque_pontos + presenca_pontos;
      return {
        ...b,
        media_pontos: round2(media_pontos),
        vitorias_pontos: round2(vitorias_pontos),
        artilharia_pontos: round2(artilharia_pontos),
        gols_pontos: round2(gols_pontos),
        destaque_pontos: round2(destaque_pontos),
        presenca_pontos: round2(presenca_pontos),
        score: round2(score),
      };
    })
    .sort((x, y) => {
      if (y.score !== x.score) return y.score - x.score;
      if (y.media_votos !== x.media_votos) return y.media_votos - x.media_votos;
      return x.nome.localeCompare(y.nome);
    });

  return { ranking, vgame, votaveis, maxes: { maxVit, maxArt, maxGols, maxDest, maxPres } };
}

// GET /api/teams/:slug/ranking?periodo=semana|mes|geral
app.get('/api/teams/:slug/ranking', requireAuth, async (req, res) => {
  const ctx = await requireTeamMember(req, res);
  if (!ctx) return;
  const { team, role } = ctx;

  const periodo = ['semana', 'mes', 'geral'].includes(req.query.periodo) ? req.query.periodo : 'geral';
  const { ranking, vgame, votaveis } = await buildRanking(team.id, periodo, req.user.id);

  res.json({
    team: { ...team, role },
    periodo,
    votacao: vgame ? { game_id: vgame.id, game_label: vgame.local || 'Jogo', votaveis } : null,
    ranking,
  });
});

// GET /api/teams/:slug/jogador/:userId — perfil completo do jogador
app.get('/api/teams/:slug/jogador/:userId', requireAuth, async (req, res) => {
  const ctx = await requireTeamMember(req, res);
  if (!ctx) return;
  const { team, role } = ctx;

  const { ranking } = await buildRanking(team.id, 'geral', req.user.id);
  const jogador = ranking.find((r) => r.user_id === req.params.userId);
  if (!jogador) {
    return res.status(404).json({ error: 'Jogador não encontrado nesta equipa.' });
  }

  // Posição no ranking entre quem tem média (votos > 0)
  const comMedia = ranking.filter((r) => r.votos > 0);
  const posIdx = comMedia.findIndex((r) => r.user_id === jogador.user_id);
  const posicao = posIdx >= 0 ? posIdx + 1 : null;

  // Radar 0-100 — normalizado pelos máximos REAIS do grupo (números mostrados)
  const maxReal = (key) => ranking.reduce((m, r) => Math.max(m, r[key]), 0);
  const pct = (v, m) => (m > 0 ? Math.round((v / m) * 100) : 0);
  const radar = {
    presenca: pct(jogador.presenca, maxReal('presenca')),
    gols: pct(jogador.gols, maxReal('gols')),
    artilharia: pct(jogador.artilharia, maxReal('artilharia')),
    vitorias: pct(jogador.vitorias, maxReal('vitorias')),
    notas: Math.round((jogador.media_votos / 5) * 100),
  };

  // Fotos de jogos onde foi campeão
  const { data: fotos } = await supabase
    .from('champion_photos')
    .select('url, created_at')
    .eq('team_id', team.id)
    .eq('user_id', jogador.user_id)
    .order('created_at', { ascending: false });
  const jogos_campeao = (fotos || []).map((f) => ({ foto: f.url }));

  res.json({
    team: { ...team, role },
    jogador: { ...jogador, posicao, total_com_media: comMedia.length },
    radar,
    jogos_campeao,
  });
});

// GET /api/teams/:slug/votacao-status — progresso de votação do jogo atual
app.get('/api/teams/:slug/votacao-status', requireAuth, async (req, res) => {
  const ctx = await requireTeamMember(req, res);
  if (!ctx) return;
  const { team } = ctx;

  const vgame = await currentVotingGame(team.id);
  if (!vgame) {
    return res.json({ game_id: null, total_colegas: 0, ja_votou_em: 0, percentagem: 100, faltam: 0 });
  }

  const { data: gp } = await supabase
    .from('game_players')
    .select('user_id')
    .eq('game_id', vgame.id)
    .eq('confirmado', true);
  const colegas = (gp || []).map((p) => p.user_id).filter((idu) => idu !== req.user.id);

  const { data: meus } = await supabase
    .from('votes')
    .select('para_user_id')
    .eq('game_id', vgame.id)
    .eq('de_user_id', req.user.id);
  const votados = new Set((meus || []).map((v) => v.para_user_id));

  const total = colegas.length;
  const jaVotouEm = colegas.filter((idu) => votados.has(idu)).length;
  const percentagem = total > 0 ? Math.round((jaVotouEm / total) * 100) : 100;

  res.json({
    game_id: vgame.id,
    total_colegas: total,
    ja_votou_em: jaVotouEm,
    percentagem,
    faltam: total - jaVotouEm,
  });
});

// POST /api/teams/:slug/votar — vota (ou altera) a nota de um colega no jogo atual
app.post('/api/teams/:slug/votar', requireAuth, async (req, res) => {
  const ctx = await requireTeamMember(req, res);
  if (!ctx) return;
  const { team } = ctx;

  const { para_user_id } = req.body || {};
  const nota = parseInt(req.body?.nota, 10);
  if (!para_user_id || para_user_id === req.user.id) {
    return res.status(400).json({ error: 'Voto inválido.' });
  }
  if (!(nota >= 1 && nota <= 5)) {
    return res.status(400).json({ error: 'A nota tem de ser entre 1 e 5.' });
  }

  const vgame = await currentVotingGame(team.id);
  if (!vgame) {
    return res.status(400).json({ error: 'Não há jogo aberto para votação.' });
  }

  const { data: gpRow } = await supabase
    .from('game_players')
    .select('id')
    .eq('game_id', vgame.id)
    .eq('user_id', para_user_id)
    .eq('confirmado', true)
    .maybeSingle();
  if (!gpRow) {
    return res.status(400).json({ error: 'Esse jogador não está confirmado no jogo.' });
  }

  await supabase
    .from('users')
    .upsert({ id: req.user.id, email: req.user.email }, { onConflict: 'id' });

  const { error } = await supabase
    .from('votes')
    .upsert(
      { de_user_id: req.user.id, para_user_id, team_id: team.id, game_id: vgame.id, nota },
      { onConflict: 'de_user_id,para_user_id,game_id' }
    );
  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ ok: true, minha_nota: nota });
});

const port = PORT || 3001;
app.listen(port, () => {
  console.log(`[Futty] Servidor a correr em http://localhost:${port}`);
  console.log(`[Futty] Health check: http://localhost:${port}/health`);
});

module.exports = { app, supabase };
