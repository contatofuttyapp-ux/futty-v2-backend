// Futty v2.0 — Rotas de jogos: criação, confirmação, marcação, sorteio e votos.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, getTeamBySlug, getRole, ensureUserRow, loadGame, computeRatings, goleirosDoTime } = require('../utils/db');
const { obterConvites } = require('../services/inicio');
const { RATING_DEFAULT } = require('../utils/helpers');
const { executarSorteio } = require('../utils/sorteio');
const { aplicarRostoPublico } = require('../utils/rostoPublico');
const { enviarNotificacao } = require('./push');

const router = express.Router();

const round1 = (n) => Math.round(n * 10) / 10;
const NOMES_TIMES = ['Time A', 'Time B', 'Time C', 'Time D', 'Time E', 'Time F'];

// Estado efetivo do jogo (achado 9): "em_curso" só quando a hora do jogo já
// chegou e ainda não há resultado — nunca por causa do sorteio ter sido feito
// cedo. Calculado a cada leitura, não depende de um write acertar a hora certa.
function statusEfetivoJogo(game) {
  if (game.cancelado || game.status === 'cancelado') return 'cancelado';
  if ((game.resultado_nivel || 0) > 0) return 'terminado';
  const comecou = !!game.data && new Date(game.data).getTime() <= Date.now();
  return comecou ? 'em_curso' : 'agendado';
}

/** Data curta PT (ex.: "12/06 · 20:30") para o corpo das notificações. */
function dataCurtaPT(iso) {
  try {
    return new Date(iso).toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** IDs dos membros de uma equipa (para notificações). */
async function membrosDaEquipa(teamId) {
  const { data } = await supabase.from('team_members').select('user_id').eq('team_id', teamId);
  return (data || []).map((m) => m.user_id);
}

/** POST /api/games — cria um jogo (só admin da equipa). */
router.post(
  '/api/games',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team_slug: teamSlug, data, local, jogadores_por_time: jogadoresPorTime, historico } = req.body || {};
    if (!teamSlug || !data) throw new HttpError(400, 'Time e data são obrigatórios.');

    const porTime = parseInt(jogadoresPorTime, 10);
    if (!porTime || porTime < 1) throw new HttpError(400, 'Indique quantos jogadores por time.');

    const team = await getTeamBySlug(teamSlug, 'id, slug, nome');
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem criar jogos.');

    // LEI (jogo histórico/retroativo): carregamento de dados — NÃO notifica ninguém.
    const eHistorico = historico === true;
    // num_times fica por definir; é calculado no sorteio conforme os confirmados.
    const linha = {
      team_id: team.id,
      data: new Date(data).toISOString(),
      local: local?.trim() || null,
      jogadores_por_time: porTime,
    };
    if (eHistorico) linha.historico = true; // coluna opcional (migração à mão); ver nota abaixo
    let insert = await supabase.from('games').insert(linha).select().single();
    // Resiliência: se a coluna `historico` ainda não existir (DDL por correr), repete sem ela.
    if (insert.error && eHistorico && /historico/i.test(insert.error.message || '')) {
      delete linha.historico;
      insert = await supabase.from('games').insert(linha).select().single();
    }
    if (insert.error) throw new HttpError(500, insert.error.message);
    const game = insert.data;

    res.status(201).json({ game });

    // Notifica os membros — EXCETO em jogo histórico (silencioso por lei).
    if (!eHistorico) {
      membrosDaEquipa(team.id).then((memberIds) =>
        enviarNotificacao(memberIds, {
          title: '⚽ Novo jogo criado',
          body: `${team.nome || 'Seu time'} · ${dataCurtaPT(game.data)}`,
          url: '/home',
        })
      );
    }
  })
);

/** GET /api/teams/:slug/games — lista os jogos da equipa (com nº de confirmados). */
router.get(
  '/api/teams/:slug/games',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug, nome, cor');
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    const role = await getRole(team.id, req.user.id);
    if (!role) throw new HttpError(403, 'Não é membro deste time.');

    const { data: games, error } = await supabase
      .from('games')
      .select('id, data, local, status, resultado_nivel, num_times, jogadores_por_time, sorteio_realizado, campeao_time_index, cancelado, motivo_cancelamento, max_jogadores, created_at')
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

    const lista = (games || []).map((g) => ({
      ...g,
      status: statusEfetivoJogo(g),
      cancelado: !!g.cancelado || g.status === 'cancelado',
      confirmados: counts[g.id] || 0,
    }));
    res.json({ team: { ...team, role }, games: lista });
  })
);

/**
 * GET /api/games/my-invites — todos os jogos das equipas do utilizador.
 * Registado ANTES de /api/games/:id para não colidir com o param :id.
 */
// Lógica em services/inicio.js#obterConvites — a MESMA função que GET /api/inicio
// usa, para o JSON nunca divergir entre as duas rotas.
router.get(
  '/api/games/my-invites',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await obterConvites(req.user.id));
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
    if (!role) throw new HttpError(403, 'Não é membro deste time.');

    // Achado 3/23: estas 4 leituras não dependem umas das outras (só de game.id/
    // game.teams.id, já conhecidos) — corriam em série, uma round-trip a seguir à
    // outra. Em paralelo.
    const [gpResult, inativosResult, golsResult, votosResult] = await Promise.all([
      supabase
        .from('game_players')
        .select('confirmado, goleiro, cabeca_chave, users ( id, nome, nome_jogador, email, avatar_url, avatar_generico )')
        .eq('game_id', game.id),
      // Inactivos da equipa: preservados no histórico mas fora do sorteio.
      supabase.from('team_members').select('user_id').eq('team_id', game.teams.id).eq('ativo', false),
      // Gols por jogador (só relevante no nível 3 do resultado).
      game.resultado_nivel === 3
        ? supabase.from('gols_jogadores').select('user_id, time, gols, users ( id, nome )').eq('game_id', game.id)
        : Promise.resolve({ data: [] }),
      supabase.from('votes').select('id', { count: 'exact', head: true }).eq('game_id', game.id).eq('de_user_id', req.user.id),
    ]);
    const gp = gpResult.data;
    const inativos = new Set((inativosResult.data || []).map((m) => m.user_id));
    const gols = (golsResult.data || []).map((g) => ({ user_id: g.user_id, time: g.time, gols: g.gols || 0, nome: g.users?.nome || null }));
    const votosCount = votosResult.count;

    // computeRatings precisa dos userIds vindos de gp — este fica sequencial.
    const userIds = (gp || []).map((p) => p.users?.id).filter(Boolean);
    const ratings = await computeRatings(game.teams.id, userIds);

    const players = (gp || [])
      .filter((p) => p.users && !inativos.has(p.users.id))
      .map((p) => ({
        user_id: p.users.id,
        nome: p.users.nome_jogador || p.users.nome || 'Jogador',
        avatar_url: p.users.avatar_url || null,
        avatar_generico: p.users.avatar_generico || null,
        confirmado: p.confirmado,
        goleiro: p.goleiro,
        cabeca_chave: p.cabeca_chave,
        rating: round1(ratings[p.users.id] ?? RATING_DEFAULT),
      }));

    const meu = players.find((p) => p.user_id === req.user.id) || null;

    const team = game.teams;
    res.json({
      team: { id: team.id, slug: team.slug, nome: team.nome, cor: team.cor, role },
      game: {
        id: game.id,
        data: game.data,
        local: game.local,
        status: statusEfetivoJogo(game),
        num_times: game.num_times,
        jogadores_por_time: game.jogadores_por_time,
        max_jogadores: game.max_jogadores ?? null,
        sorteio_realizado: game.sorteio_realizado,
        times_resultado: game.times_resultado,
        historico: !!game.historico,
        // Cancelamento.
        cancelado: !!game.cancelado || game.status === 'cancelado',
        motivo_cancelamento: game.motivo_cancelamento || null,
        // Resultado do jogo (4 níveis).
        resultado_nivel: game.resultado_nivel || 0,
        time_vencedor: game.time_vencedor || null,
        placar_a: game.placar_a ?? null,
        placar_b: game.placar_b ?? null,
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
      gols,
      meuEstado: meu
        ? { confirmado: meu.confirmado, goleiro: meu.goleiro, cabeca_chave: meu.cabeca_chave }
        : null,
      jaVotei: (votosCount || 0) > 0,
    });
  })
);

/**
 * GET /api/p/:gameId — vista pública do sorteio (sem auth, para partilha/telão).
 * Devolve só o essencial: nome da equipa, times do sorteio e o resultado.
 */
router.get(
  '/api/p/:gameId',
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.gameId);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    let gols = [];
    if (game.resultado_nivel === 3) {
      const { data } = await supabase
        .from('gols_jogadores')
        .select('user_id, gols, users ( nome )')
        .eq('game_id', game.id);
      gols = (data || []).map((g) => ({ user_id: g.user_id, gols: g.gols || 0, nome: g.users?.nome || null }));
    }

    // PRIVACIDADE /p/ (Opção B): decide POR JOGADOR se o rosto entra — adulto E
    // consentimento → URL do proxy público; senão silhueta (fail-closed). O snapshot
    // times_resultado só tem user_id/avatar_url, por isso juntamos os donos aqui.
    if (game.times_resultado) {
      const ids = new Set();
      const colher = (j) => { if (j && j.user_id) ids.add(j.user_id); };
      (game.times_resultado.times || []).forEach((t) => (t.jogadores || []).forEach(colher));
      (game.times_resultado.reservas || []).forEach(colher);
      const usersById = new Map();
      if (ids.size) {
        // Se a coluna mostrar_rosto_publico ainda não existir (DDL por correr), a query
        // devolve erro → mapa vazio → TODOS caem em silhueta (fail-closed, seguro).
        const { data: donos } = await supabase
          .from('users')
          .select('id, birthdate, mostrar_rosto_publico')
          .in('id', [...ids]);
        (donos || []).forEach((u) => usersById.set(u.id, u));
      }
      aplicarRostoPublico(game.times_resultado, usersById, `${req.protocol}://${req.get('host')}`);
    }

    res.json({
      equipa: { nome: game.teams.nome, slug: game.teams.slug },
      times_resultado: game.times_resultado || null,
      resultado: {
        nivel: game.resultado_nivel || 0,
        time_vencedor: game.time_vencedor || null,
        placar_a: game.placar_a ?? null,
        placar_b: game.placar_b ?? null,
        gols,
      },
    });
  })
);

/**
 * POST /api/games/:id/partilha-declarada — TERMO de quem partilha (1-clique).
 * Registo de auditoria: quem copiou/partilhou o link declarou ter o direito de o
 * fazer. NÃO altera a privacidade (a regra de rosto é independente e sempre ligada);
 * é só a cobertura legal. Idempotente (upsert por game+user).
 */
router.post(
  '/api/games/:id/partilha-declarada',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');
    // só quem tem papel na equipa (membro/admin) pode declarar a partilha
    const role = await getRole(game.teams.id, req.user.id);
    if (!role) throw new HttpError(403, 'Sem permissão para compartilhar este sorteio.');
    const { error } = await supabase
      .from('share_declarations')
      .upsert({ game_id: game.id, user_id: req.user.id }, { onConflict: 'game_id,user_id' });
    if (error) throw new HttpError(500, error.message);
    res.json({ ok: true });
  })
);

/** PATCH /api/games/:id/resultado — define o resultado do jogo (só admin). */
router.patch(
  '/api/games/:id/resultado',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');
    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem definir o resultado.');

    // Achado 9: sem resultado antes do jogo acontecer — exceto jogo histórico/
    // retroativo (criado como "Já aconteceu"), que não tem essa trava.
    const jaComecou = !!game.data && new Date(game.data).getTime() <= Date.now();
    if (!jaComecou && !game.historico) {
      throw new HttpError(400, 'O resultado só pode ser registrado depois do início do jogo.');
    }

    const b = req.body || {};
    const nivel = Number(b.nivel);
    if (![0, 1, 2, 3].includes(nivel)) throw new HttpError(400, 'Nível de resultado inválido.');

    const patch = { resultado_nivel: nivel, time_vencedor: null, placar_a: null, placar_b: null };

    if (nivel >= 1) {
      if (!['A', 'B', 'empate'].includes(b.time_vencedor)) throw new HttpError(400, 'Indique quem venceu.');
      patch.time_vencedor = b.time_vencedor;
    }
    if (nivel >= 2) {
      const pa = Number(b.placar_a);
      const pb = Number(b.placar_b);
      if (!Number.isInteger(pa) || pa < 0 || !Number.isInteger(pb) || pb < 0) throw new HttpError(400, 'Placar inválido.');
      patch.placar_a = pa;
      patch.placar_b = pb;
    }

    const { data: updated, error } = await supabase.from('games').update(patch).eq('id', game.id).select().single();
    if (error) throw new HttpError(500, error.message);

    // O jogo passou → reset das ausências antecipadas (para o próximo jogo).
    await supabase.from('team_members').update({ ausente_proximo: false }).eq('team_id', game.teams.id).eq('ausente_proximo', true);

    // Gols só existem no nível 3 — limpa sempre e reinsere se for o caso.
    await supabase.from('gols_jogadores').delete().eq('game_id', game.id);
    if (nivel === 3 && Array.isArray(b.gols)) {
      const times = game.times_resultado?.times || [];
      const timeDe = {};
      (times[0]?.jogadores || []).forEach((j) => { timeDe[j.user_id] = 'A'; });
      (times[1]?.jogadores || []).forEach((j) => { timeDe[j.user_id] = 'B'; });
      const rows = b.gols
        .filter((g) => g && g.user_id)
        .map((g) => ({ game_id: game.id, user_id: g.user_id, gols: Math.max(0, Number(g.gols) || 0), time: timeDe[g.user_id] || null }));
      if (rows.length) {
        const { error: gErr } = await supabase.from('gols_jogadores').insert(rows);
        if (gErr) throw new HttpError(500, gErr.message);
      }
    }

    res.json({ game: updated });
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

/**
 * POST /api/games/:id/confirmar — confirma/cancela a própria presença.
 * Rodada 9: `goleiro` é opcional. Sem ele no body, vale o que já estiver
 * marcado naquele jogo (pelo jogador ou pelo admin) e, se ainda não houver
 * linha, a flag do time (Rodada 10B: team_members.categoria === 'GR').
 */
router.post(
  '/api/games/:id/confirmar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { confirmado = true, goleiro } = req.body || {};

    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (!role) throw new HttpError(403, 'Não é membro deste time.');

    await ensureUserRow(req.user);

    let ehGoleiro = !!goleiro;
    if (goleiro == null) {
      const { data: linha } = await supabase
        .from('game_players')
        .select('goleiro')
        .eq('game_id', game.id)
        .eq('user_id', req.user.id)
        .maybeSingle();
      ehGoleiro = linha ? !!linha.goleiro : (await goleirosDoTime(game.teams.id, [req.user.id])).has(req.user.id);
    }

    const { error } = await supabase.from('game_players').upsert(
      { game_id: game.id, user_id: req.user.id, confirmado: !!confirmado, goleiro: ehGoleiro },
      { onConflict: 'game_id,user_id' }
    );
    if (error) throw new HttpError(500, error.message);

    res.json({ meuEstado: { confirmado: !!confirmado, goleiro: ehGoleiro } });
  })
);

/**
 * POST /api/games/:id/presencas — ADMIN marca quem jogou (jogo manual/retroativo).
 * Distinto do self-confirm: aqui o ADMIN da equipa marca a presença de TERCEIROS a
 * partir de uma checklist. Autoritativo: os user_id enviados ficam confirmados; os
 * membros confirmados que NÃO vierem na lista são desmarcados (a lista é a verdade).
 * Body: { jogadores: [{ user_id, goleiro? }] }. Só membros da equipa entram.
 */
router.post(
  '/api/games/:id/presencas',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');
    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem marcar presenças por outros.');

    const lista = Array.isArray(req.body?.jogadores) ? req.body.jogadores : [];
    // valida que cada user_id é membro da equipa
    const { data: membros } = await supabase.from('team_members').select('user_id').eq('team_id', game.teams.id);
    const membroIds = new Set((membros || []).map((m) => m.user_id));
    const escolhidos = [];
    for (const j of lista) {
      if (j && j.user_id && membroIds.has(j.user_id)) escolhidos.push({ game_id: game.id, user_id: j.user_id, confirmado: true, goleiro: !!j.goleiro });
    }
    const escolhidosSet = new Set(escolhidos.map((e) => e.user_id));

    if (escolhidos.length) {
      const { error } = await supabase.from('game_players').upsert(escolhidos, { onConflict: 'game_id,user_id' });
      if (error) throw new HttpError(500, error.message);
    }
    // desmarca (confirmado=false) os que estavam confirmados e não vieram na lista
    const { data: atuais } = await supabase.from('game_players').select('user_id, confirmado').eq('game_id', game.id).eq('confirmado', true);
    const remover = (atuais || []).filter((p) => !escolhidosSet.has(p.user_id)).map((p) => p.user_id);
    if (remover.length) {
      await supabase.from('game_players').update({ confirmado: false }).eq('game_id', game.id).in('user_id', remover);
    }
    res.json({ ok: true, confirmados: escolhidos.length });
  })
);

/**
 * POST /api/games/:id/times-manuais — ADMIN define os times À MÃO (jogo manual/retroativo).
 * Grava direto em times_resultado (mesma forma que o sorteio produz) SEM passar pelo
 * endpoint de sorteio e SEM `seed` (sem replay/cerimónia — LEI). Convidados sem app
 * entram como nome solto (user_id null). Membros têm de estar confirmados (presenças
 * marcadas primeiro). NÃO notifica.
 * Body: { times: [{ nome, jogadores:[{user_id?, nome, avatar_url?, convidado?}] }], reservas? }
 */
router.post(
  '/api/games/:id/times-manuais',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');
    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem definir os times.');

    const times = Array.isArray(req.body?.times) ? req.body.times : null;
    if (!times || !times.length) throw new HttpError(400, 'Indique os times.');
    const reservas = Array.isArray(req.body?.reservas) ? req.body.reservas : [];
    for (const t of times) {
      if (!Array.isArray(t.jogadores) || t.jogadores.length < 1) throw new HttpError(400, 'Cada time deve ter pelo menos 1 jogador.');
    }
    const todos = [...times.flatMap((t) => t.jogadores || []), ...reservas];
    const ids = todos.map((j) => j.user_id).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Há jogadores repetidos entre os times.');

    // Membros (com user_id) têm de estar confirmados neste jogo (presenças marcadas antes).
    const { data: gp } = await supabase.from('game_players').select('user_id').eq('game_id', game.id).eq('confirmado', true);
    const confirmados = new Set((gp || []).map((p) => p.user_id));
    for (const id of ids) {
      if (!confirmados.has(id)) throw new HttpError(400, 'Marque as presenças antes: todos os jogadores com conta devem estar confirmados.');
    }

    const nomear = (t, i) => ({
      nome: (t.nome || NOMES_TIMES[i] || `Time ${i + 1}`),
      jogadores: (t.jogadores || []).map((j) => ({
        user_id: j.user_id || null,
        convidado: j.convidado || undefined,
        nome: j.nome,
        avatar_url: j.avatar_url || null,
      })),
    });
    const tr = {
      num_times: times.length,
      total_jogadores: ids.length + todos.filter((j) => !j.user_id).length,
      manual: true, // sem seed → sem cerimónia/replay (o frontend gateia por seed)
      times: times.map(nomear),
      reservas: reservas.map((j) => ({ user_id: j.user_id || null, convidado: j.convidado || undefined, nome: j.nome, avatar_url: j.avatar_url || null })),
    };

    // Achado 9: status só vira "em_curso" se a hora do jogo já passou — sorteio
    // feito com antecedência (ou times definidos à mão) não adianta o estado.
    const jaComecou = !!game.data && new Date(game.data).getTime() <= Date.now();
    const patchStatus = jaComecou && game.status !== 'cancelado' ? { status: 'em_curso' } : {};

    const { data: updated, error } = await supabase
      .from('games')
      .update({ times_resultado: tr, num_times: tr.times.length, sorteio_realizado: true, ...patchStatus })
      .eq('id', game.id)
      .select('id, times_resultado, num_times, sorteio_realizado, status')
      .single();
    if (error) throw new HttpError(500, error.message);
    res.json({ game: updated });
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

    // Jogadores por time: o body pode sobrepor o valor guardado no jogo.
    const { jogadoresIds, jogadoresPorTime } = req.body || {};
    let porTime = game.jogadores_por_time;
    const pptBody = Number(jogadoresPorTime);
    if (Number.isInteger(pptBody) && pptBody >= 1) porTime = pptBody;
    if (!porTime || porTime < 1) {
      throw new HttpError(400, 'Defina os jogadores por time antes de sortear.');
    }

    const usarSubset = Array.isArray(jogadoresIds) && jogadoresIds.length > 0;
    if (usarSubset) {
      // Valida que todos os IDs pertencem à equipa do jogo.
      const { data: membros } = await supabase
        .from('team_members')
        .select('user_id')
        .eq('team_id', game.teams.id)
        .in('user_id', jogadoresIds);
      const validos = new Set((membros || []).map((m) => m.user_id));
      if (jogadoresIds.some((uid) => !validos.has(uid))) {
        throw new HttpError(400, 'Alguns jogadores indicados não pertencem ao time.');
      }
    }

    let gpQuery = supabase
      .from('game_players')
      .select('goleiro, cabeca_chave, users ( id, nome, nome_jogador, email, avatar_url )')
      .eq('game_id', game.id)
      .eq('confirmado', true);
    if (usarSubset) gpQuery = gpQuery.in('user_id', jogadoresIds);
    const { data: gp } = await gpQuery;

    // Exclui jogadores inactivos do sorteio (ficam no histórico, não jogam).
    const { data: inativosRows } = await supabase
      .from('team_members')
      .select('user_id')
      .eq('team_id', game.teams.id)
      .eq('ativo', false);
    const inativos = new Set((inativosRows || []).map((m) => m.user_id));
    const confirmados = (gp || []).filter((p) => p.users && !inativos.has(p.users.id));

    // (o mínimo de 2 times valida-se mais abaixo, já com os convidados contados)

    const userIds = confirmados.map((p) => p.users.id);
    const ratings = await computeRatings(game.teams.id, userIds);
    const toPlayer = (p) => ({
      user_id: p.users.id,
      nome: p.users.nome_jogador || p.users.nome || 'Jogador',
      avatar_url: p.users.avatar_url || null,
      rating: round1(ratings[p.users.id] ?? RATING_DEFAULT),
      goleiro: p.goleiro,
      cabeca_chave: p.cabeca_chave,
    });

    const all = confirmados.map(toPlayer);

    // CONVIDADOS SEM APP (SPEC-SORTEIO §11): nomes soltos do organizador — entram
    // no sorteio como linha, sem user_id, zero impacto em users/ranking.
    const convidados = Array.isArray(req.body?.convidados)
      ? req.body.convidados.map((n) => String(n).trim()).filter(Boolean).slice(0, 28)
      : [];

    // TECTOS FORMAIS (SPEC-SORTEIO §14): 3..28 participantes; 2..4 times.
    const totalParticipantes = all.length + convidados.length;
    if (totalParticipantes < 3) {
      throw new HttpError(400, 'São precisos pelo menos 3 jogadores para sortear.');
    }
    if (Math.floor(totalParticipantes / porTime) < 2) {
      throw new HttpError(400, `São precisos pelo menos ${porTime * 2} jogadores (${porTime} por time) para formar 2 times. Há ${totalParticipantes} (confirmados + convidados).`);
    }
    if (totalParticipantes > 28) {
      throw new HttpError(400, 'Máximo de 28 jogadores por sorteio (28 = 4 times de 7).');
    }
    if (Math.floor(totalParticipantes / porTime) < 2) {
      throw new HttpError(400, );
    }
    if (Math.floor(totalParticipantes / porTime) > 4) {
      throw new HttpError(400, 'Máximo de 4 times por sorteio: aumente os jogadores por time.');
    }

    // Sorteio: lógica completa em utils/sorteio.js (goleiros/cabeças 1 por time,
    // excesso vira linha, linha por snake draft, sobra vai para reservas).
    // A SEMENTE (SPEC §10) fica no resultado → replay exacto da animação.
    const sorteio = executarSorteio(all, porTime, { convidados });

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
      total_jogadores: confirmados.length + convidados.length,
      convidados_total: convidados.length,
      seed: sorteio.seed, // replay EXACTO da animação (SPEC-SORTEIO §10)
      avisos,
      times,
      reservas: sorteio.reservas,
    };

    // Achado 9: status só vira "em_curso" se a hora do jogo já passou — sorteio
    // feito com antecedência não adianta o estado (fica "agendado" + chip de
    // times sorteados no frontend).
    const jaComecou = !!game.data && new Date(game.data).getTime() <= Date.now();
    const patchStatus = jaComecou && game.status !== 'cancelado' ? { status: 'em_curso' } : {};

    const { data: updated, error } = await supabase
      .from('games')
      .update({ jogadores_por_time: porTime, num_times: sorteio.numTimes, sorteio_realizado: true, times_resultado: resultado, ...patchStatus })
      .eq('id', game.id)
      .select()
      .single();
    if (error) throw new HttpError(500, error.message);

    res.json({
      game: {
        id: updated.id,
        num_times: sorteio.numTimes,
        sorteio_realizado: true,
        times_resultado: resultado,
        status: updated.status,
      },
    });

    // Notifica os confirmados do jogo (fire-and-forget).
    const confirmadosIds = confirmados.map((p) => p.users.id);
    enviarNotificacao(confirmadosIds, {
      title: '🎲 Sorteio realizado!',
      body: `O sorteio de ${game.local || 'Jogo'} está pronto`,
      url: `/equipa/${game.teams.slug}/jogo/${game.id}`,
    });
  })
);

/** PATCH /api/games/:id/times — ajuste manual dos times pós-sorteio (só admin). */
router.patch(
  '/api/games/:id/times',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem ajustar os times.');

    const tr = req.body?.times_resultado;
    if (!tr || !Array.isArray(tr.times)) throw new HttpError(400, 'times_resultado inválido.');

    const reservas = Array.isArray(tr.reservas) ? tr.reservas : [];

    // Cada time tem pelo menos 1 jogador.
    for (const t of tr.times) {
      if (!Array.isArray(t.jogadores) || t.jogadores.length < 1) {
        throw new HttpError(400, 'Cada time deve ter pelo menos 1 jogador.');
      }
    }

    // Recolhe todos os jogadores (times + reservas) e valida duplicados.
    const todos = [...tr.times.flatMap((t) => t.jogadores || []), ...reservas];
    const ids = todos.map((j) => j.user_id).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Há jogadores repetidos entre os times.');

    // Todos têm de ser confirmados deste jogo.
    const { data: gp } = await supabase
      .from('game_players')
      .select('user_id')
      .eq('game_id', game.id)
      .eq('confirmado', true);
    const confirmados = new Set((gp || []).map((p) => p.user_id));
    for (const id of ids) {
      if (!confirmados.has(id)) throw new HttpError(400, 'Todos os jogadores devem estar confirmados no jogo.');
    }

    const { data: updated, error } = await supabase
      .from('games')
      .update({ times_resultado: tr, num_times: tr.times.length })
      .eq('id', game.id)
      .select('times_resultado')
      .single();
    if (error) throw new HttpError(500, error.message);

    res.json({ times_resultado: updated.times_resultado });
  })
);

// NOTA: a votação por jogo (POST /api/games/:id/votar) foi removida — o novo
// modelo é 1 voto por (votante, votado, equipa), gerido em routes/ranking.js.

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
    if (game.sorteio_realizado) throw new HttpError(400, 'Não pode editar um jogo já sorteado.');

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
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem excluir jogos.');

    if (!game.data || new Date(game.data).getTime() <= Date.now()) {
      throw new HttpError(400, 'Só pode excluir jogos futuros.');
    }

    const { count } = await supabase
      .from('game_players')
      .select('id', { count: 'exact', head: true })
      .eq('game_id', game.id)
      .eq('confirmado', true);
    if ((count || 0) > 0) {
      throw new HttpError(409, 'Este jogo já tem jogadores confirmados. Cancele-o em vez de excluí-lo.');
    }

    const { error } = await supabase.from('games').delete().eq('id', game.id);
    if (error) throw new HttpError(500, error.message);
    res.json({ deleted: true });
  })
);

/**
 * POST /api/games/:id/cancelar — cancela um jogo não terminado (só admin).
 * Marca status 'cancelado' + cancelado_at (compat. com filtros existentes) e
 * a flag cancelado + motivo_cancelamento. Notifica todos os membros por push.
 * Body: { motivo?: string }.
 */
router.post(
  '/api/games/:id/cancelar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem cancelar jogos.');
    if (game.status === 'terminado') throw new HttpError(400, 'Não pode cancelar um jogo terminado.');

    const motivo = String(req.body?.motivo || '').trim().slice(0, 300) || null;

    const { data: updated, error } = await supabase
      .from('games')
      .update({ status: 'cancelado', cancelado_at: new Date().toISOString(), cancelado: true, motivo_cancelamento: motivo })
      .eq('id', game.id)
      .select()
      .single();
    if (error) throw new HttpError(500, error.message);

    res.json({ ok: true, game: updated });

    // Notifica todos os membros da equipa (fire-and-forget, após responder).
    const membros = await membrosDaEquipa(game.teams.id);
    const corpo = `O jogo de ${dataCurtaPT(game.data)} foi cancelado.` + (motivo ? ` Motivo: ${motivo}` : '');
    enviarNotificacao(membros, {
      title: 'Jogo cancelado ❌',
      body: corpo,
      url: `/equipa/${game.teams.slug}`,
    });
  })
);

/**
 * PATCH /api/games/:id/capacidade — define o máximo de jogadores (só admin).
 * Body: { max_jogadores: number|null }. null/0/vazio = sem limite.
 */
router.patch(
  '/api/games/:id/capacidade',
  requireAuth,
  asyncHandler(async (req, res) => {
    const game = await loadGame(req.params.id);
    if (!game || !game.teams) throw new HttpError(404, 'Jogo não encontrado.');

    const role = await getRole(game.teams.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem definir a capacidade.');

    const raw = req.body?.max_jogadores;
    let max = null;
    if (raw !== null && raw !== undefined && raw !== '') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Máximo de jogadores inválido.');
      max = n;
    }

    const { error } = await supabase.from('games').update({ max_jogadores: max }).eq('id', game.id);
    if (error) throw new HttpError(500, error.message);
    res.json({ ok: true, max_jogadores: max });
  })
);

/**
 * POST /api/teams/:slug/jogos/recorrentes — cria N jogos semanais de uma vez,
 * num dia da semana / hora fixos (só admin). Sem cron: geração imediata.
 * Body: { dia_semana: 0-6, hora: "HH:MM", local?, semanas: 4|8|12 }.
 * Salta datas que colidem com jogos já existentes (± 1 hora).
 */
router.post(
  '/api/teams/:slug/jogos/recorrentes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug, nome');
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem criar jogos.');

    const { dia_semana: diaSemana, hora, local, semanas } = req.body || {};
    const dia = Number(diaSemana);
    if (!Number.isInteger(dia) || dia < 0 || dia > 6) throw new HttpError(400, 'Dia da semana inválido (0-6).');
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hora || ''));
    if (!m) throw new HttpError(400, 'Hora inválida (formato HH:MM).');
    const horas = Number(m[1]);
    const minutos = Number(m[2]);
    if (horas > 23 || minutos > 59) throw new HttpError(400, 'Hora inválida.');
    const n = Number(semanas);
    if (![4, 8, 12].includes(n)) throw new HttpError(400, 'Semanas deve ser 4, 8 ou 12.');

    // Próximas N datas para o dia da semana escolhido (a partir de hoje).
    const datas = [];
    const cursor = new Date();
    cursor.setHours(horas, minutos, 0, 0);
    // Avança até ao próximo dia da semana (inclui hoje se ainda for no futuro).
    const avancarDias = (dia - cursor.getDay() + 7) % 7;
    cursor.setDate(cursor.getDate() + avancarDias);
    if (cursor.getTime() <= Date.now()) cursor.setDate(cursor.getDate() + 7);
    for (let i = 0; i < n; i += 1) {
      datas.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 7);
    }

    // Jogos já existentes da equipa (para detetar colisões ± 1 hora).
    const primeira = datas[0];
    const ultima = datas[datas.length - 1];
    const { data: existentes } = await supabase
      .from('games')
      .select('data')
      .eq('team_id', team.id)
      .gte('data', new Date(primeira.getTime() - 3600000).toISOString())
      .lte('data', new Date(ultima.getTime() + 3600000).toISOString());
    const existentesTs = (existentes || []).map((g) => new Date(g.data).getTime());
    const colide = (d) => existentesTs.some((ts) => Math.abs(ts - d.getTime()) <= 3600000);

    const porTime = 5; // valor por defeito; o admin ajusta depois por jogo.
    const aInserir = [];
    const criadas = [];
    let ignorados = 0;
    for (const d of datas) {
      if (colide(d)) {
        ignorados += 1;
        continue;
      }
      aInserir.push({ team_id: team.id, data: d.toISOString(), local: local?.trim() || null, jogadores_por_time: porTime });
      criadas.push(d.toISOString());
    }

    if (aInserir.length) {
      const { error } = await supabase.from('games').insert(aInserir);
      if (error) throw new HttpError(500, error.message);
    }

    res.status(201).json({ criados: aInserir.length, datas: criadas, ignorados });

    // Notifica os membros se algo foi criado (fire-and-forget).
    if (aInserir.length) {
      membrosDaEquipa(team.id).then((memberIds) =>
        enviarNotificacao(memberIds, {
          title: '⚽ Novos jogos agendados',
          body: `${team.nome || 'Seu time'} · ${aInserir.length} jogos nas próximas semanas`,
          url: '/home',
        })
      );
    }
  })
);

module.exports = router;
