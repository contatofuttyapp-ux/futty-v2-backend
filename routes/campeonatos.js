// Futty v2.0 — Campeonatos (modelo N times). Vaga 11B.
// Auto-contido no Storage (utils/campeonatoStore) — DDL nenhum, ranking intocado.
// A rota antiga (routes/campeonato.js, 026 de 2 times fixos) fica intocada.
const express = require('express');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, requireTeamMember, getTeamBySlug, getRole } = require('../utils/db');
const store = require('../utils/campeonatoStore');
const { buildRanking } = require('./ranking');

const router = express.Router();

const MIN_TIMES = 2;
const MAX_TIMES = 8;

// Anexa a classificação (pontos) e o campeão resolvido ao payload.
function enriquecer(camp) {
  const campeao = camp.campeao_time_id ? camp.times.find((t) => t.id === camp.campeao_time_id) || null : null;
  const out = { ...camp, campeao };
  if (camp.formato === 'pontos') out.classificacao = store.classificacao(camp);
  return out;
}

const SELO_DIAS = 30;
const HONRA_CAMP = { 1: 'CAMPEÃO', 2: 'VICE', 3: '3º LUGAR' };
const POS = { 1: '1º', 2: '2º', 3: '3º' };

/**
 * GET /api/me/selos — (Vaga 11C) selos de honra do utilizador, lidos do Storage
 * dos campeonatos + do ranking (sem DDL). A faixa antiga morreu.
 *  - campeonato: pódio 1º/2º/3º de campeonato terminado onde o user está no time —
 *    ATIVO até 30 dias, depois histórico (vitrine).
 *  - ranking: posição atual (1º/2º/3º) na equipa — VIVO (sem prazo; sai se cair).
 *  - artilheiro: os resultados do campeonato não guardam golos por jogador → dado
 *    inexistente hoje (v2 na SPEC).
 * Prioridade no cromo: campeonato > (artilheiro) > ranking.
 */
async function computeSelos(uid, teamIds) {
  const agora = Date.now();
  const selos = [];
  {
    for (const teamId of teamIds) {
      const { data: team } = await supabase.from('teams').select('nome').eq('id', teamId).maybeSingle(); // eslint-disable-line no-await-in-loop
      const equipaNome = team?.nome || 'Time';

      // --- campeonato (pódio) ---
      const camps = await store.listar(teamId); // eslint-disable-line no-await-in-loop
      for (const c of camps) {
        if (c.estado !== 'terminado') continue;
        const pod = store.podio(c);
        const meu = pod.find((p) => (p.time.jogadores || []).some((j) => j.user_id === uid));
        if (!meu) continue;
        const fim = c.terminado_em ? new Date(c.terminado_em).getTime() : new Date(c.criado_em).getTime();
        const dias = Math.floor((agora - fim) / 86400000);
        selos.push({
          id: `camp:${c.id}`,
          fonte: 'campeonato',
          tier: meu.tier,
          label: HONRA_CAMP[meu.pos],
          sub: c.nome,
          ativa: dias <= SELO_DIAS,
          dias_restantes: Math.max(0, SELO_DIAS - dias),
          historico: dias > SELO_DIAS,
          terminado_em: c.terminado_em || c.criado_em,
          prioridade: 1,
        });
      }

      // --- ranking (posição atual, vivo) ---
      try {
        const rk = await buildRanking(teamId, uid); // eslint-disable-line no-await-in-loop
        const eu = (rk || []).find((r) => r.sou_eu);
        if (eu && eu.posicao >= 1 && eu.posicao <= 3) {
          selos.push({
            id: `rank:${teamId}`,
            fonte: 'ranking',
            tier: { 1: 'ouro', 2: 'prata', 3: 'bronze' }[eu.posicao],
            label: `RANKING ${POS[eu.posicao]}`,
            sub: equipaNome,
            ativa: true,
            vivo: true,
            historico: false,
            prioridade: 3,
          });
        }
      } catch { /* ranking indisponível — ignora */ }
    }
  }
  // Achado 12: mesmo tipo + mesmo time só uma vez (ex.: "RANKING 1º" duplicado).
  // `id` já é único por time (rank:<teamId>) ou por campeonato (camp:<campId>).
  const vistos = new Set();
  const semDuplicados = selos.filter((s) => {
    if (vistos.has(s.id)) return false;
    vistos.add(s.id);
    return true;
  });
  // ordena: prioridade (campeonato antes de ranking), depois ativos, depois recência.
  semDuplicados.sort((a, b) => (a.prioridade - b.prioridade)
    || ((b.ativa ? 1 : 0) - (a.ativa ? 1 : 0))
    || String(b.terminado_em || '').localeCompare(String(a.terminado_em || '')));
  return semDuplicados;
}

/** GET /api/me/selos — selos do próprio (todas as equipas). */
router.get(
  '/api/me/selos',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data: minhas } = await supabase.from('team_members').select('team_id').eq('user_id', req.user.id);
    const teamIds = [...new Set((minhas || []).map((m) => m.team_id))];
    res.json({ selos: await computeSelos(req.user.id, teamIds) });
  })
);

/** GET /api/equipas/:slug/jogador/:userId/selos — selos de um jogador NESTA equipa
 * (vitrine). O viewer tem de ser membro; só conta os selos desta equipa. */
router.get(
  '/api/equipas/:slug/jogador/:userId/selos',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team } = await requireTeamMember(req.params.slug, req.user.id);
    res.json({ selos: await computeSelos(req.params.userId, [team.id]) });
  })
);

/** GET /api/equipas/:slug/campeonatos — lista (membro). */
router.get(
  '/api/equipas/:slug/campeonatos',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team } = await requireTeamMember(req.params.slug, req.user.id);
    const camps = await store.listar(team.id);
    res.json({
      campeonatos: camps.map((c) => ({
        id: c.id, nome: c.nome, formato: c.formato, estado: c.estado,
        n_times: c.times.length, criado_em: c.criado_em,
        campeao: c.campeao_time_id ? (c.times.find((t) => t.id === c.campeao_time_id)?.nome || null) : null,
      })),
    });
  })
);

// Nomes-cor dos times do campeonato-de-sorteio — a mesma identidade que o admin
// acabou de ver na cerimónia (CerimoniaSorteio.MARCA_TIME). Cicla se houver mais
// de 4 times (o KITS do campeonatoStore também cicla, mesma ordem de cor).
const NOMES_COR_SORTEIO = ['Time Ouro', 'Time Roxo', 'Time Prata', 'Time Bronze'];

/**
 * POST /api/equipas/:slug/campeonatos/de-sorteio — cria um campeonato REUSANDO os
 * times de um jogo já sorteado (SPEC-CAMPEONATOS "a partir de times sorteados").
 * Body: { game_id, formato }. O admin só escolhe o formato — plantéis e nomes vêm
 * do times_resultado do jogo (adaptador; estruturas compatíveis, ver spec).
 */
router.post(
  '/api/equipas/:slug/campeonatos/de-sorteio',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só o admin do time cria campeonatos.');

    const gameId = String(req.body?.game_id || '');
    if (!gameId) throw new HttpError(400, 'game_id em falta.');
    const formato = req.body?.formato === 'mata' ? 'mata' : 'pontos';

    const { data: game } = await supabase.from('games').select('id, team_id, data, times_resultado').eq('id', gameId).maybeSingle();
    if (!game || game.team_id !== team.id) throw new HttpError(404, 'Jogo não encontrado neste time.');
    const timesSorteio = game.times_resultado?.times || [];
    if (timesSorteio.length < MIN_TIMES) {
      throw new HttpError(400, `Este jogo não tem times sorteados suficientes (mínimo ${MIN_TIMES}).`);
    }

    // Cap 2-8 (limite do campeonato) — corta o excesso se o sorteio tiver mais.
    const times = timesSorteio.slice(0, MAX_TIMES);
    const nomes = times.map((_, i) => NOMES_COR_SORTEIO[i % NOMES_COR_SORTEIO.length]);
    // Adaptador: jogador do sorteio (user_id/nome/rating/goleiro/cabeca_chave/avatar_url)
    // → plantel do campeonato (só os campos que o campeonato conhece).
    const plantel = times.map((t) => (t.jogadores || []).slice(0, 22).map((j) => ({
      user_id: j.user_id || null,
      nome: j.nome || 'Jogador',
      avatar_url: j.avatar_url || null,
      convidado: !!j.convidado,
    })));

    const dataJogo = game.data ? new Date(game.data).toLocaleDateString('pt-BR') : null;
    const nome = dataJogo ? `Campeonato do sorteio · ${dataJogo}` : 'Campeonato do sorteio';

    const camp = await store.criar(team.id, req.user.id, { nome, formato, usar_sorteio: false, nomes, plantel });
    res.status(201).json({ campeonato: enriquecer(camp) });
  })
);

/** POST /api/equipas/:slug/campeonatos — cria (só admin). */
router.post(
  '/api/equipas/:slug/campeonatos',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só o admin do time cria campeonatos.');

    const b = req.body || {};
    const nome = String(b.nome || '').trim();
    if (!nome) throw new HttpError(400, 'Dê um nome ao campeonato.');
    const formato = b.formato === 'mata' ? 'mata' : 'pontos';
    const modo = b.modo === 'sorteio' ? 'sorteio' : 'manual';

    let opts;
    if (modo === 'sorteio') {
      const numTimes = Math.floor(Number(b.num_times) || 0);
      if (numTimes < MIN_TIMES || numTimes > MAX_TIMES) throw new HttpError(400, `Escolha entre ${MIN_TIMES} e ${MAX_TIMES} times.`);
      // plantel = membros da equipa + convidados sem app (só nome; zero users).
      const { data: membros } = await supabase
        .from('team_members')
        .select('user_id, users ( nome_jogador, nome, avatar_url )')
        .eq('team_id', team.id);
      const participantes = (membros || []).map((m) => ({
        user_id: m.user_id,
        nome: m.users?.nome_jogador || m.users?.nome || 'Jogador',
        avatar_url: m.users?.avatar_url || null,
        rating: 3, convidado: false,
      }));
      const convidados = (Array.isArray(b.convidados) ? b.convidados : [])
        .map((x) => String(x || '').trim()).filter(Boolean).slice(0, 40)
        .map((nomeC) => ({ user_id: null, nome: nomeC.slice(0, 40), avatar_url: null, rating: 3, convidado: true }));
      const todos = participantes.concat(convidados);
      if (todos.length < numTimes) throw new HttpError(400, 'Poucos jogadores para tantos times.');
      opts = {
        nome, formato, usar_sorteio: true, num_times: numTimes,
        participantes: todos, seed: b.seed ? Math.floor(Number(b.seed)) : undefined,
        nomes: Array.isArray(b.nomes) ? b.nomes.map((x) => String(x || '').slice(0, 40)) : undefined,
      };
    } else {
      const nomes = (Array.isArray(b.nomes) ? b.nomes : []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, MAX_TIMES);
      if (nomes.length < MIN_TIMES) throw new HttpError(400, `Um campeonato precisa de pelo menos ${MIN_TIMES} times.`);
      // Composição à mão (Vaga 11C, OPCIONAL): plantel[i] = jogadores do time i
      // (membros por user_id + convidados por nome). Times só com nome continuam
      // válidos. Sanitiza: 22 por time, só campos conhecidos.
      let plantel;
      if (Array.isArray(b.plantel)) {
        plantel = nomes.map((_, i) => (Array.isArray(b.plantel[i]) ? b.plantel[i] : [])
          .slice(0, 22)
          .map((p) => ({
            user_id: p && p.user_id ? String(p.user_id) : null,
            nome: String((p && p.nome) || '').trim().slice(0, 40) || 'Jogador',
            avatar_url: p && p.avatar_url ? String(p.avatar_url) : null,
            convidado: !!(p && p.convidado),
          })));
      }
      opts = { nome, formato, usar_sorteio: false, nomes, plantel };
    }

    const camp = await store.criar(team.id, req.user.id, opts);
    res.status(201).json({ campeonato: enriquecer(camp) });
  })
);

/** GET /api/equipas/:slug/campeonatos/:id — detalhe (membro). */
router.get(
  '/api/equipas/:slug/campeonatos/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team } = await requireTeamMember(req.params.slug, req.user.id);
    const camp = await store.obter(team.id, req.params.id);
    if (!camp) throw new HttpError(404, 'Campeonato não encontrado.');
    res.json({ campeonato: enriquecer(camp) });
  })
);

/** POST /api/equipas/:slug/campeonatos/:id/confrontos/:cid/resultado — só admin. */
router.post(
  '/api/equipas/:slug/campeonatos/:id/confrontos/:cid/resultado',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só o admin lança resultados.');
    const camp = await store.obter(team.id, req.params.id);
    if (!camp) throw new HttpError(404, 'Campeonato não encontrado.');
    if (camp.estado === 'terminado') throw new HttpError(400, 'Campeonato já terminou.');

    const pa = Math.max(0, Math.floor(Number(req.body?.placar_a)));
    const pb = Math.max(0, Math.floor(Number(req.body?.placar_b)));
    if (!Number.isFinite(pa) || !Number.isFinite(pb)) throw new HttpError(400, 'Placar inválido.');

    try {
      store.aplicarResultado(camp, req.params.cid, pa, pb);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    await store.guardar(camp);
    res.json({ campeonato: enriquecer(camp) });
  })
);

/** POST /api/equipas/:slug/campeonatos/:id/terminar — coroa o líder (pontos, admin). */
router.post(
  '/api/equipas/:slug/campeonatos/:id/terminar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só o admin termina o campeonato.');
    const camp = await store.obter(team.id, req.params.id);
    if (!camp) throw new HttpError(404, 'Campeonato não encontrado.');
    store.terminarPontos(camp);
    await store.guardar(camp);
    res.json({ campeonato: enriquecer(camp) });
  })
);

/** DELETE /api/equipas/:slug/campeonatos/:id — apaga (só admin). */
router.delete(
  '/api/equipas/:slug/campeonatos/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só o admin exclui campeonatos.');
    await store.apagar(team.id, req.params.id);
    res.json({ ok: true });
  })
);

/** GET /api/p/campeonato/:slug/:id — vista pública (sem login) para o link. */
router.get(
  '/api/p/campeonato/:slug/:id',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, nome, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');
    const camp = await store.obter(team.id, req.params.id);
    if (!camp) throw new HttpError(404, 'Campeonato não encontrado.');
    res.json({ campeonato: enriquecer(camp), equipa: { nome: team.nome, slug: team.slug } });
  })
);

module.exports = router;
