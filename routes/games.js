// Futty v2.0 — Rotas de jogos: criação, confirmação, marcação, sorteio e votos.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, getTeamBySlug, getRole, ensureUserRow, loadGame, computeRatings } = require('../utils/db');
const { RATING_DEFAULT } = require('../utils/helpers');
const { executarSorteio } = require('../utils/sorteio');

const router = express.Router();

const round1 = (n) => Math.round(n * 10) / 10;
const NOMES_TIMES = ['Time A', 'Time B', 'Time C', 'Time D', 'Time E', 'Time F'];

/** POST /api/games — cria um jogo (só admin da equipa). */
router.post(
  '/api/games',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team_slug: teamSlug, data, local, jogadores_por_time: jogadoresPorTime } = req.body || {};
    if (!teamSlug || !data) throw new HttpError(400, 'Equipa e data são obrigatórias.');

    const porTime = parseInt(jogadoresPorTime, 10);
    if (!porTime || porTime < 1) throw new HttpError(400, 'Indica quantos jogadores por time.');

    const team = await getTeamBySlug(teamSlug, 'id, slug');
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem criar jogos.');

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
    if (error) throw new HttpError(500, error.message);

    res.status(201).json({ game });
  })
);

/** GET /api/teams/:slug/games — lista os jogos da equipa (com nº de confirmados). */
router.get(
  '/api/teams/:slug/games',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug, nome, cor');
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');

    const role = await getRole(team.id, req.user.id);
    if (!role) throw new HttpError(403, 'Não és membro desta equipa.');

    const { data: games, error } = await supabase
      .from('games')
      .select('id, data, local, status, num_times, jogadores_por_time, sorteio_realizado, campeao_time_index, created_at')
      .eq('team_id', team.id)
      .order('data', { ascending: false });
    if (error) throw new HttpError(500, error.message);

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
  })
);

/**
 * GET /api/games/my-invites — todos os jogos das equipas do utilizador.
 * Registado ANTES de /api/games/:id para não colidir com o param :id.
 */
router.get(
  '/api/games/my-invites',
  requireAuth,
  asyncHandler(async (req, res) => {
    // Equipas do utilizador
    const { data: memberships } = await supabase
      .from('team_members')
      .select('team_id, teams ( id, nome, slug )')
      .eq('user_id', req.user.id);
    const teamById = {};
    for (const m of memberships || []) {
      if (m.teams) teamById[m.team_id] = m.teams;
    }
    const teamIds = Object.keys(teamById);
    if (!teamIds.length) return res.json({ games: [] });

    // Jogos dessas equipas (data ASC)
    const { data: games, error } = await supabase
      .from('games')
      .select('id, team_id, data, local, status, sorteio_realizado')
      .in('team_id', teamIds)
      .order('data', { ascending: true });
    if (error) throw new HttpError(500, error.message);

    // Confirmados + o meu estado por jogo
    const ids = (games || []).map((g) => g.id);
    const counts = {};
    const myStatus = {};
    if (ids.length) {
      const { data: gp } = await supabase
        .from('game_players')
        .select('game_id, user_id, confirmado')
        .in('game_id', ids);
      for (const row of gp || []) {
        if (row.confirmado) counts[row.game_id] = (counts[row.game_id] || 0) + 1;
        if (row.user_id === req.user.id) myStatus[row.game_id] = row.confirmado ? 'going' : 'not_going';
      }
    }

    const now = Date.now();
    const list = (games || []).map((g) => {
      const past = g.data && new Date(g.data).getTime() < now;
      const finished = g.status === 'terminado' || g.status === 'cancelado' || past;
      const status = finished ? 'finished' : g.sorteio_realizado ? 'drawn' : 'scheduled';
      const team = teamById[g.team_id] || {};
      return {
        id: g.id,
        name: g.local || 'Jogo',
        date: g.data,
        location: g.local || null,
        confirmed_count: counts[g.id] || 0,
        status,
        user_status: myStatus[g.id] ?? null,
        team_id: g.team_id,
        team_name: team.nome || null,
        team_slug: team.slug || null,
      };
    });

    res.json({ games: list });
  })
);

/** GET /api/games/:id — detalhes do jogo (jogadores, ratings, o meu estado). */
router.get(
  '/api/games/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (!role) throw new HttpError(403, 'Não és membro desta equipa.');

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
        rating: round1(ratings[p.users.id] ?? RATING_DEFAULT),
      }));

    const meu = players.find((p) => p.user_id === req.user.id) || null;

    const { count: votosCount } = await supabase
      .from('votes')
      .select('id', { count: 'exact', head: true })
      .eq('game_id', game.id)
      .eq('de_user_id', req.user.id);

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
        // Campos de resultado (para pré-preencher a edição no painel de admin).
        campeao_time_index: game.campeao_time_index,
        campeao_foto_url: game.campeao_foto_url,
        artilheiro_user_id: game.artilheiro_user_id,
        artilheiro_gols: game.artilheiro_gols,
        destaque_user_id: game.destaque_user_id,
        destaque_titulo: game.destaque_titulo,
        rodada_user_id: game.rodada_user_id,
        rodada_foto_url: game.rodada_foto_url,
      },
      players,
      meuEstado: meu
        ? { confirmado: meu.confirmado, goleiro: meu.goleiro, cabeca_chave: meu.cabeca_chave }
        : null,
      jaVotei: (votosCount || 0) > 0,
    });
  })
);

/** POST /api/games/:id/jogador — admin marca goleiro / cabeça de chave. */
router.post(
  '/api/games/:id/jogador',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { user_id: userId, goleiro, cabeca_chave: cabecaChave } = req.body || {};
    if (!userId) throw new HttpError(400, 'user_id em falta.');

    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem marcar jogadores.');

    const patch = {};
    if (typeof goleiro === 'boolean') patch.goleiro = goleiro;
    if (typeof cabecaChave === 'boolean') patch.cabeca_chave = cabecaChave;
    if (!Object.keys(patch).length) throw new HttpError(400, 'Nada para atualizar.');

    const { data: updated, error } = await supabase
      .from('game_players')
      .update(patch)
      .eq('game_id', game.id)
      .eq('user_id', userId)
      .select('user_id, goleiro, cabeca_chave')
      .maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!updated) throw new HttpError(404, 'Esse jogador não está confirmado neste jogo.');

    res.json({ jogador: updated });
  })
);

/** POST /api/games/:id/confirmar — confirma/cancela a própria presença. */
router.post(
  '/api/games/:id/confirmar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { confirmado = true, goleiro = false } = req.body || {};

    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (!role) throw new HttpError(403, 'Não és membro desta equipa.');

    await ensureUserRow(req.user);

    const { error } = await supabase.from('game_players').upsert(
      { game_id: game.id, user_id: req.user.id, confirmado: !!confirmado, goleiro: !!goleiro },
      { onConflict: 'game_id,user_id' }
    );
    if (error) throw new HttpError(500, error.message);

    res.json({ meuEstado: { confirmado: !!confirmado, goleiro: !!goleiro } });
  })
);

/** POST /api/games/:id/sortear — sorteio inteligente dos times (só admin). */
router.post(
  '/api/games/:id/sortear',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem fazer o sorteio.');

    const porTime = game.jogadores_por_time;
    if (!porTime || porTime < 1) {
      throw new HttpError(400, 'Define os jogadores por time antes de sortear.');
    }

    const { data: gp } = await supabase
      .from('game_players')
      .select('goleiro, cabeca_chave, users ( id, nome, email, avatar_url )')
      .eq('game_id', game.id)
      .eq('confirmado', true);
    const confirmados = (gp || []).filter((p) => p.users);

    // Nº de times = confirmados / jogadores por time. Os que sobram são
    // distribuídos pelos times existentes (snake draft), sem time incompleto.
    const numTimes = Math.floor(confirmados.length / porTime);
    if (numTimes < 2) {
      throw new HttpError(
        400,
        `São precisos pelo menos ${porTime * 2} jogadores confirmados (${porTime} por time) para formar 2 times. Há ${confirmados.length} confirmados.`
      );
    }

    const userIds = confirmados.map((p) => p.users.id);
    const ratings = await computeRatings(game.teams.id, userIds);
    const toPlayer = (p) => ({
      user_id: p.users.id,
      nome: p.users.nome || p.users.email,
      avatar_url: p.users.avatar_url || null,
      rating: round1(ratings[p.users.id] ?? RATING_DEFAULT),
      goleiro: p.goleiro,
      cabeca_chave: p.cabeca_chave,
    });

    const all = confirmados.map(toPlayer);

    // Sorteio: lógica completa em utils/sorteio.js (goleiros/cabeças 1 por time,
    // excesso vira linha, linha por snake draft, sobra vai para reservas).
    const sorteio = executarSorteio(all, porTime);

    const avisos = [];
    const totalGoleiros = all.filter((p) => p.goleiro).length;
    if (totalGoleiros > 0 && totalGoleiros < sorteio.numTimes) {
      avisos.push(
        `Há ${totalGoleiros} goleiro(s) para ${sorteio.numTimes} times: ${sorteio.numTimes - totalGoleiros} time(s) ficam sem goleiro.`
      );
    }

    const times = sorteio.times.map((jogadores, i) => {
      const media = jogadores.length
        ? jogadores.reduce((s, j) => s + j.rating, 0) / jogadores.length
        : 0;
      return {
        nome: NOMES_TIMES[i] || `Time ${i + 1}`,
        rating_medio: Math.round(media * 100) / 100,
        jogadores,
      };
    });

    const resultado = {
      num_times: sorteio.numTimes,
      total_jogadores: confirmados.length,
      avisos,
      times,
      reservas: sorteio.reservas,
    };

    const { data: updated, error } = await supabase
      .from('games')
      .update({ num_times: numTimes, sorteio_realizado: true, times_resultado: resultado, status: 'em_curso' })
      .eq('id', game.id)
      .select()
      .single();
    if (error) throw new HttpError(500, error.message);

    res.json({
      game: {
        id: updated.id,
        num_times: numTimes,
        sorteio_realizado: true,
        times_resultado: resultado,
        status: updated.status,
      },
    });
  })
);

/** POST /api/games/:id/votar — regista votos (1-5) nos confirmados, uma vez por jogo. */
router.post(
  '/api/games/:id/votar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { votos } = req.body || {};
    if (!Array.isArray(votos) || votos.length === 0) {
      throw new HttpError(400, 'Não há votos para registar.');
    }

    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (!role) throw new HttpError(403, 'Não és membro desta equipa.');

    if (game.status !== 'em_curso' && game.status !== 'terminado') {
      throw new HttpError(400, 'A votação abre depois do sorteio do jogo.');
    }

    const { count: jaVotou } = await supabase
      .from('votes')
      .select('id', { count: 'exact', head: true })
      .eq('game_id', game.id)
      .eq('de_user_id', req.user.id);
    if ((jaVotou || 0) > 0) throw new HttpError(400, 'Já votaste neste jogo.');

    const { data: gp } = await supabase
      .from('game_players')
      .select('user_id')
      .eq('game_id', game.id)
      .eq('confirmado', true);
    const confirmadosIds = new Set((gp || []).map((p) => p.user_id));

    await ensureUserRow(req.user);

    const rows = [];
    for (const v of votos) {
      const para = v?.para_user_id;
      const nota = parseInt(v?.nota, 10);
      if (!para || para === req.user.id) continue; // não vota em si próprio
      if (!confirmadosIds.has(para)) continue; // só jogadores confirmados
      if (!(nota >= 1 && nota <= 5)) continue; // nota válida
      rows.push({ de_user_id: req.user.id, para_user_id: para, team_id: game.teams.id, game_id: game.id, nota });
    }
    if (rows.length === 0) {
      throw new HttpError(400, 'Nenhum voto válido (1 a 5, em jogadores confirmados).');
    }

    const { error } = await supabase.from('votes').insert(rows);
    if (error) throw new HttpError(500, error.message);

    res.status(201).json({ registados: rows.length });
  })
);

/**
 * PATCH /api/games/:id — edita um jogo não sorteado (só admin).
 * Body opcional: { date, time, location, players_per_team }.
 * date + time combinam-se na coluna única `data` (timestamptz).
 */
router.patch(
  '/api/games/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem editar o jogo.');
    if (game.sorteio_realizado) throw new HttpError(400, 'Não podes editar um jogo já sorteado.');

    const b = req.body || {};
    const patch = {};

    // Recombina data/hora (a coluna `data` guarda ambas).
    if ('date' in b || 'time' in b) {
      const base = new Date(game.data);
      const pad = (n) => String(n).padStart(2, '0');
      const datePart = b.date
        ? String(b.date).slice(0, 10)
        : `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
      const timePart = b.time ? String(b.time).slice(0, 5) : `${pad(base.getHours())}:${pad(base.getMinutes())}`;
      const combinado = new Date(`${datePart}T${timePart}:00`);
      if (Number.isNaN(combinado.getTime())) throw new HttpError(400, 'Data/hora inválida.');
      patch.data = combinado.toISOString();
    }
    if ('location' in b) patch.local = b.location ? String(b.location).trim() : null;
    if ('players_per_team' in b) {
      const n = parseInt(b.players_per_team, 10);
      if (!Number.isFinite(n) || n < 1) throw new HttpError(400, 'players_per_team inválido.');
      patch.jogadores_por_time = n;
    }

    if (!Object.keys(patch).length) throw new HttpError(400, 'Nada para atualizar.');

    const { data: updated, error } = await supabase.from('games').update(patch).eq('id', game.id).select().single();
    if (error) throw new HttpError(500, error.message);
    res.json({ game: updated });
  })
);

/**
 * DELETE /api/games/:id — apaga um jogo futuro sem confirmações (só admin).
 * Se houver confirmações → 409 (deve cancelar-se, não apagar).
 */
router.delete(
  '/api/games/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem apagar jogos.');

    if (!game.data || new Date(game.data).getTime() <= Date.now()) {
      throw new HttpError(400, 'Só podes apagar jogos futuros.');
    }

    const { count } = await supabase
      .from('game_players')
      .select('id', { count: 'exact', head: true })
      .eq('game_id', game.id)
      .eq('confirmado', true);
    if ((count || 0) > 0) {
      throw new HttpError(409, 'Este jogo já tem jogadores confirmados. Cancela-o em vez de o apagar.');
    }

    const { error } = await supabase.from('games').delete().eq('id', game.id);
    if (error) throw new HttpError(500, error.message);
    res.json({ deleted: true });
  })
);

/**
 * PATCH /api/games/:id/cancelar — cancela um jogo não terminado (só admin).
 * Usa status 'cancelado' (valor PT permitido pelo CHECK) + cancelado_at.
 */
router.patch(
  '/api/games/:id/cancelar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem cancelar jogos.');
    if (game.status === 'terminado') throw new HttpError(400, 'Não podes cancelar um jogo terminado.');

    const { data: updated, error } = await supabase
      .from('games')
      .update({ status: 'cancelado', cancelado_at: new Date().toISOString() })
      .eq('id', game.id)
      .select()
      .single();
    if (error) throw new HttpError(500, error.message);
    res.json({ game: updated });
  })
);

module.exports = router;
