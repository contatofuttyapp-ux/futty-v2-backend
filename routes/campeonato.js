// Futty v2.0 — Campeonato / torneio: 2 times fixos que acumulam pontos ao longo
// de várias jornadas. Cada jornada regista um resultado (vitória/empate).
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, getTeamBySlug, getRole } = require('../utils/db');

const router = express.Router();

// Determina o campeão pelos pontos (empate se iguais).
function campeaoPorPontos(pontosA, pontosB) {
  if (pontosA > pontosB) return 'A';
  if (pontosB > pontosA) return 'B';
  return 'empate';
}

// Carrega um campeonato pelo id e garante que o utilizador é admin da equipa.
async function campeonatoComoAdmin(req) {
  const { data: camp } = await supabase.from('campeonatos').select('*').eq('id', req.params.id).maybeSingle();
  if (!camp) throw new HttpError(404, 'Campeonato não encontrado.');
  const role = await getRole(camp.team_id, req.user.id);
  if (role !== 'admin') throw new HttpError(403, 'Só admins podem gerir o campeonato.');
  return camp;
}

/** POST /api/equipas/:slug/campeonato — cria um campeonato (só admin). */
router.post(
  '/api/equipas/:slug/campeonato',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');
    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem criar campeonatos.');

    // Só 1 activo por equipa.
    const { data: existente } = await supabase
      .from('campeonatos')
      .select('id')
      .eq('team_id', team.id)
      .eq('estado', 'ativo')
      .maybeSingle();
    if (existente) throw new HttpError(400, 'Já existe um campeonato activo. Termina-o antes de criar outro.');

    const b = req.body || {};
    const nome = String(b.nome || '').trim();
    if (!nome) throw new HttpError(400, 'Indica o nome do campeonato.');
    const nj = Number(b.num_jornadas);
    const numJornadas = Number.isInteger(nj) && nj > 0 ? nj : 8;

    const insert = {
      team_id: team.id,
      nome: nome.slice(0, 80),
      num_jornadas: numJornadas,
      time_a_nome: (b.time_a_nome ? String(b.time_a_nome).trim().slice(0, 40) : '') || 'Time A',
      time_b_nome: (b.time_b_nome ? String(b.time_b_nome).trim().slice(0, 40) : '') || 'Time B',
    };
    const { data: campeonato, error } = await supabase.from('campeonatos').insert(insert).select().single();
    if (error) throw new HttpError(500, error.message);

    res.json({ campeonato });
  })
);

/** GET /api/equipas/:slug/campeonato — campeonato activo da equipa + jornadas. */
router.get(
  '/api/equipas/:slug/campeonato',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Equipa não encontrada.');
    const role = await getRole(team.id, req.user.id);
    if (!role) throw new HttpError(403, 'Não és membro desta equipa.');

    const { data: campeonato } = await supabase
      .from('campeonatos')
      .select('*')
      .eq('team_id', team.id)
      .eq('estado', 'ativo')
      .order('criado_em', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!campeonato) return res.json({ campeonato: null });

    const { data: jornadas } = await supabase
      .from('campeonato_jornadas')
      .select('*')
      .eq('campeonato_id', campeonato.id)
      .order('numero', { ascending: true });

    res.json({ campeonato, jornadas: jornadas || [] });
  })
);

/** POST /api/campeonato/:id/jornada — regista o resultado de uma jornada (só admin). */
router.post(
  '/api/campeonato/:id/jornada',
  requireAuth,
  asyncHandler(async (req, res) => {
    const camp = await campeonatoComoAdmin(req);
    if (camp.estado !== 'ativo') throw new HttpError(400, 'O campeonato já terminou.');

    const b = req.body || {};
    if (!['A', 'B', 'empate'].includes(b.vencedor)) throw new HttpError(400, 'Indica o vencedor da jornada.');
    const pa = Number(b.placar_a);
    const pb = Number(b.placar_b);
    const placarA = Number.isInteger(pa) && pa >= 0 ? pa : null;
    const placarB = Number.isInteger(pb) && pb >= 0 ? pb : null;

    const numero = (camp.jornadas_jogadas || 0) + 1;
    if (numero > camp.num_jornadas) throw new HttpError(400, 'Todas as jornadas já foram jogadas.');

    const { data: jornada, error: jErr } = await supabase
      .from('campeonato_jornadas')
      .insert({ campeonato_id: camp.id, game_id: b.game_id || null, numero, vencedor: b.vencedor, placar_a: placarA, placar_b: placarB })
      .select()
      .single();
    if (jErr) throw new HttpError(500, jErr.message);

    // Acumula pontos/estatísticas a partir do estado atual.
    const patch = {
      time_a_pontos: camp.time_a_pontos,
      time_b_pontos: camp.time_b_pontos,
      time_a_vitorias: camp.time_a_vitorias,
      time_b_vitorias: camp.time_b_vitorias,
      time_a_empates: camp.time_a_empates,
      time_b_empates: camp.time_b_empates,
      time_a_derrotas: camp.time_a_derrotas,
      time_b_derrotas: camp.time_b_derrotas,
      jornadas_jogadas: numero,
    };
    if (b.vencedor === 'A') {
      patch.time_a_pontos += 3;
      patch.time_a_vitorias += 1;
      patch.time_b_derrotas += 1;
    } else if (b.vencedor === 'B') {
      patch.time_b_pontos += 3;
      patch.time_b_vitorias += 1;
      patch.time_a_derrotas += 1;
    } else {
      patch.time_a_pontos += 1;
      patch.time_b_pontos += 1;
      patch.time_a_empates += 1;
      patch.time_b_empates += 1;
    }

    // Última jornada → termina e define o campeão.
    if (numero >= camp.num_jornadas) {
      patch.estado = 'terminado';
      patch.campeao = campeaoPorPontos(patch.time_a_pontos, patch.time_b_pontos);
    }

    const { data: campeonato, error: cErr } = await supabase.from('campeonatos').update(patch).eq('id', camp.id).select().single();
    if (cErr) throw new HttpError(500, cErr.message);

    res.json({ jornada, campeonato });
  })
);

/** POST /api/campeonato/:id/terminar — termina antecipadamente (só admin). */
router.post(
  '/api/campeonato/:id/terminar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const camp = await campeonatoComoAdmin(req);
    if (camp.estado === 'terminado') throw new HttpError(400, 'O campeonato já terminou.');

    const campeao = campeaoPorPontos(camp.time_a_pontos, camp.time_b_pontos);
    const { data: campeonato, error } = await supabase
      .from('campeonatos')
      .update({ estado: 'terminado', campeao })
      .eq('id', camp.id)
      .select()
      .single();
    if (error) throw new HttpError(500, error.message);

    res.json({ campeonato });
  })
);

module.exports = router;
