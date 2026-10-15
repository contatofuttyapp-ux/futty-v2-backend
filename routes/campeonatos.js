// Futty v2.0 — Campeonatos (modelo N times).
// Auto-contido no Storage (utils/campeonatoStore) — DDL nenhum, ranking intocado.
// A rota antiga (routes/campeonato.js, 026 de 2 times fixos) fica intocada.
const express = require('express');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, requireTeamMember, getTeamBySlug, getRole } = require('../utils/db');
const store = require('../utils/campeonatoStore');
const selosCache = require('../utils/selosCache');
const { buildRanking } = require('./ranking');
const { sincronizarPostDoCampeao, apagarPostDoCampeao } = require('../utils/postDoCampeao');
const { textoCurto } = require('../utils/entrada');
const { urlDeAvatarValida } = require('../utils/validarUrl');
const { carregarNomesPublicos } = require('../utils/nomePublico');
const { MAX_GOLS } = require('../utils/resultadoDoJogo');

const router = express.Router();

// O nome do campeonato: texto de verdade, aparado e cortado em 60 (o campo do app já limita; um nome maior que isso sempre foi cortado).
const nomeDoCampeonato = (valor) => (valor == null ? '' : textoCurto(valor, Infinity, 'Nome do campeonato').slice(0, 60));

const MIN_TIMES = 2;
const MAX_TIMES = 8;

// O mínimo muda com o formato: "Todos contra todos + final" pede 3 times (com 2 ele nem aparece nas telas).
const minTimesDe = (formato) => store.MIN_TIMES_DO_FORMATO[formato] || MIN_TIMES;
const mensagemMinTimes = (formato) => (formato === 'pontos_final'
  ? `Este formato precisa de pelo menos ${minTimesDe(formato)} times.`
  : `Um campeonato precisa de pelo menos ${MIN_TIMES} times.`);

// Anexa a classificação (pontos), a pendência de empate (todos contra todos + final) e o campeão resolvido ao payload.
const enriquecer = (camp) => store.enriquecer(camp);

// O campeonato terminou (ou a final foi corrigida): a Resenha ganha UM post do campeão, ou o mesmo post é atualizado. O id do post
// fica no documento do campeonato; se a gravação do id falhar, a próxima sincronização o reencontra pela busca em `conteudo`.
async function postarOCampeao(team, camp, autorId) {
  const postId = await sincronizarPostDoCampeao({ supabase, team, camp, autorId });
  if (postId && postId !== camp.post_id) {
    camp.post_id = postId;
    await store.guardar(camp).catch((e) => console.error('[Futty] post_id do campeonato:', e.message));
  }
}

const SELO_DIAS = 30;
const HONRA_CAMP = { 1: 'CAMPEÃO', 2: 'VICE', 3: '3º LUGAR' };
const POS = { 1: '1º', 2: '2º', 3: '3º' };

/**
 * GET /api/me/selos — selos de honra do utilizador, lidos do Storage dos campeonatos + do ranking
 * (sem DDL).
 *  - campeonato: pódio 1º/2º/3º de campeonato terminado onde o user está no time —
 *    ATIVO até 30 dias, depois histórico (vitrine).
 *  - ranking: posição atual (1º/2º/3º) na equipa — VIVO (sem prazo; sai se cair).
 *  - artilheiro: os resultados do campeonato não guardam golos por jogador → dado
 *    inexistente hoje (v2 na SPEC).
 * Prioridade no cromo: campeonato > (artilheiro) > ranking.
 */
async function computeSelos(uid, teamIds) {
  const agora = Date.now();
  if (!teamIds.length) return [];

  // Uma query só, com .in(), traz o nome de todas as equipas
  // (em vez de uma query de nome POR equipa).
  const { data: teamsData } = await supabase.from('teams').select('id, nome').in('id', teamIds);
  const nomePorId = new Map((teamsData || []).map((t) => [t.id, t.nome]));

  // Era um `for` sequencial (await dentro do loop, com no-await-in-loop
  // desligado) — N equipas = N round-trips em SÉRIE ao motor em São Paulo
  // (~240ms cada, de Lisboa). Agora todas as equipas correm em PARALELO —
  // o tempo total passa a ser o da equipa mais lenta, não a soma de todas.
  const porEquipa = await Promise.all(
    teamIds.map(async (teamId) => {
      const equipaNome = nomePorId.get(teamId) || 'Time';
      const selosDaEquipa = [];

      const [camps, rk] = await Promise.all([
        store.listar(teamId),
        buildRanking(teamId, uid).catch(() => null), // ranking indisponível — ignora
      ]);

      // --- campeonato (pódio) ---
      for (const c of camps) {
        if (c.estado !== 'terminado') continue;
        const pod = store.podio(c);
        const meu = pod.find((p) => (p.time.jogadores || []).some((j) => j.user_id === uid));
        if (!meu) continue;
        const fim = c.terminado_em ? new Date(c.terminado_em).getTime() : new Date(c.criado_em).getTime();
        const dias = Math.floor((agora - fim) / 86400000);
        selosDaEquipa.push({
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
      // Quem ainda não jogou está no ranking, mas no fim e sem pódio: num time com menos de 3 jogadores com jogo
      // ele cairia no 3º lugar só por existir — o selo é de quem chegou lá jogando.
      const eu = (rk || []).find((r) => r.sou_eu);
      if (eu && eu.presenca > 0 && eu.posicao >= 1 && eu.posicao <= 3) {
        selosDaEquipa.push({
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

      return selosDaEquipa;
    })
  );
  const selos = porEquipa.flat();
  // Mesmo tipo + mesmo time só uma vez (ex.: "RANKING 1º" duplicado).
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

/** GET /api/me/selos — selos do próprio (todas as equipas). Cache: utils/selosCache.js. */
router.get(
  '/api/me/selos',
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.id;
    const { selos } = await selosCache.obter(uid, async () => {
      const { data: minhas, error } = await supabase.from('team_members').select('team_id').eq('user_id', uid);
      // Falha não entra no cache: sem isto, um soluço do banco deixava a pessoa sem selos por minutos.
      if (error) throw new HttpError(500, error.message);
      const teamIds = [...new Set((minhas || []).map((m) => m.team_id))];
      return { selos: await computeSelos(uid, teamIds), teamIds };
    });
    // Os selos mudam poucas vezes por semana (e o motor já os guarda 2 min): o navegador pode reaproveitar a
    // resposta por 30 s. `private` + `Vary: Authorization` — é de UMA pessoa, e outra conta no mesmo aparelho
    // nunca recebe a de quem saiu.
    res.set('Cache-Control', 'private, max-age=30');
    res.vary('Authorization');
    res.json({ selos });
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

    const gameId = typeof req.body?.game_id === 'string' ? req.body.game_id : '';
    if (!gameId) throw new HttpError(400, 'game_id em falta.');
    const formato = store.lerFormato(req.body?.formato);

    const { data: game } = await supabase.from('games').select('id, team_id, data, times_resultado').eq('id', gameId).maybeSingle();
    if (!game || game.team_id !== team.id) throw new HttpError(404, 'Jogo não encontrado neste time.');
    const timesSorteio = game.times_resultado?.times || [];
    if (timesSorteio.length < minTimesDe(formato)) {
      throw new HttpError(400, `Este jogo não tem times sorteados suficientes (mínimo ${minTimesDe(formato)}).`);
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

    // O nome é do admin (a tela o traz preenchido com "Campeonato <time>"); sem nome, o mesmo padrão. A data do jogo não entra no
    // nome: vai gravada em `origem_data` e a página do campeonato a mostra como subtítulo.
    const nome = nomeDoCampeonato(req.body?.nome) || `Campeonato ${team.nome}`.slice(0, 60);

    const origem = { game_id: game.id, assinatura: store.assinaturaDosTimes(timesSorteio), data: game.data || null };
    const camp = await store.criar(team.id, req.user.id, { nome, formato, nomes, plantel, origem });
    res.status(201).json({ campeonato: enriquecer(camp) });
  })
);

/**
 * GET /api/equipas/:slug/campeonatos/jogos-sorteados — só admin. Os jogos que "Pelo sorteio de um jogo" oferece (ver
 * store.jogosElegiveisParaCampeonato). Tem de vir ANTES do GET /:id, senão "jogos-sorteados" seria lido como um id.
 */
router.get(
  '/api/equipas/:slug/campeonatos/jogos-sorteados',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só o admin do time cria campeonatos.');
    const desde = new Date(Date.now() - store.JOGO_RECENTE_DIAS * 86400000).toISOString();
    const [{ data: jogos, error }, campeonatos] = await Promise.all([
      supabase
        .from('games')
        .select('id, data, local, status, cancelado, sorteio_realizado, times_resultado')
        .eq('team_id', team.id)
        .eq('sorteio_realizado', true)
        .gte('data', desde),
      store.listar(team.id),
    ]);
    if (error) throw new HttpError(500, error.message);
    const jogosElegiveis = store.jogosElegiveisParaCampeonato(jogos, campeonatos).slice(0, 10).map((g) => {
      const times = g.times_resultado.times;
      return {
        id: g.id, data: g.data, local: g.local || null, n_times: Math.min(times.length, MAX_TIMES),
        por_time: Math.max(...times.map((t) => (t.jogadores || []).length)),
      };
    });
    res.json({ jogos: jogosElegiveis });
  })
);

/**
 * POST /api/equipas/:slug/campeonatos — cria um campeonato com os times montados à mão (só admin). O "sortear direto" saiu: ele
 * pegava todos os membros do time (inclusive quem não vai) e sorteava sem as notas; o sorteio do jogo já faz isso direito.
 */
router.post(
  '/api/equipas/:slug/campeonatos',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só o admin do time cria campeonatos.');

    const b = req.body || {};
    if (b.modo === 'sorteio') {
      throw new HttpError(400, 'Para sortear, marque um jogo e sorteie por lá; no resultado do sorteio, toque em Criar campeonato.');
    }
    const nome = nomeDoCampeonato(b.nome);
    if (!nome) throw new HttpError(400, 'Dê um nome ao campeonato.');
    const formato = store.lerFormato(b.formato);

    // O nome de cada time cabe em 40 (o campo do app); texto de qualquer outro tipo é erro de quem mandou.
    const nomes = (Array.isArray(b.nomes) ? b.nomes : []).map((x) => textoCurto(x, 40, 'Nome do time')).filter(Boolean).slice(0, MAX_TIMES);
    if (nomes.length < minTimesDe(formato)) throw new HttpError(400, mensagemMinTimes(formato));
    // Composição à mão (OPCIONAL): plantel[i] = jogadores do time i
    // (membros por user_id + convidados por nome). Times só com nome continuam
    // válidos. Sanitiza: 22 por time, só campos conhecidos.
    let plantel;
    if (Array.isArray(b.plantel)) {
      // Quem tem conta tem de ser do time (um id de fora ganharia selo e card de campeão num time que não é o dele); o nome comprido de
      // um membro (até 60) é cortado em 40, como sempre; a foto só vale se for foto nossa — o resto vira "sem foto".
      const { data: doTime } = await supabase.from('team_members').select('user_id').eq('team_id', team.id);
      const ids = new Set((doTime || []).map((m) => m.user_id));
      plantel = nomes.map((_, i) => (Array.isArray(b.plantel[i]) ? b.plantel[i] : [])
        .slice(0, 22)
        .map((p) => {
          if (p !== null && typeof p !== 'object') throw new HttpError(400, 'Um dos jogadores veio num formato que não dá para ler.');
          const userId = p && p.user_id ? p.user_id : null;
          if (userId !== null && (typeof userId !== 'string' || !ids.has(userId))) throw new HttpError(400, 'Esse jogador não é do time.');
          return {
            user_id: userId,
            nome: (p && typeof p.nome === 'string' ? p.nome.trim().slice(0, 40) : '') || 'Jogador',
            avatar_url: p && p.avatar_url && urlDeAvatarValida(p.avatar_url, req) ? String(p.avatar_url) : null,
            convidado: !!(p && p.convidado),
          };
        }));
    }

    const camp = await store.criar(team.id, req.user.id, { nome, formato, nomes, plantel });
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
    // O placar é inteiro de 0 a 99 (duas casas, como no cartão do jogo): negativo, decimal, texto ou 999 é erro de digitação, não "0".
    const lerPlacar = (v) => {
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
      if (!Number.isInteger(n) || n < 0 || n > MAX_GOLS) throw new HttpError(400, 'Placar inválido.');
      return n;
    };
    const pa = lerPlacar(req.body?.placar_a);
    const pb = lerPlacar(req.body?.placar_b);

    // Placar empatado numa final ou num jogo do mata-mata só vale com o vencedor dos pênaltis (o placar fica como foi digitado).
    const penaltis = req.body?.penaltis_vencedor_id ? String(req.body.penaltis_vencedor_id) : null;

    const avisos = [];
    try {
      // Com o campeão coroado (e os selos já fora) só a FINAL pode ser corrigida; antes disso o motor barra o resto com a explicação.
      store.aplicarResultado(camp, req.params.cid, pa, pb, avisos, penaltis);
    } catch (e) {
      throw new HttpError(e.message === store.MSG_FINAL_JOGADA ? 409 : 400, e.message);
    }
    await store.guardar(camp);
    if (camp.estado === 'terminado') {
      selosCache.invalidarEquipa(team.id); // o último resultado coroou alguém (ou a final foi corrigida)
      await postarOCampeao(team, camp, req.user.id);
    }
    res.json({ campeonato: enriquecer(camp), avisos });
  })
);

/**
 * POST /api/equipas/:slug/campeonatos/:id/desempate — só admin. Todos contra todos + final: a tabela empatou na vaga da final
 * e nem o confronto direto separa; o admin toca no time que passa na frente. Body: { time_id }.
 */
router.post(
  '/api/equipas/:slug/campeonatos/:id/desempate',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team, role } = await requireTeamMember(req.params.slug, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só o admin decide o empate.');
    const camp = await store.obter(team.id, req.params.id);
    if (!camp) throw new HttpError(404, 'Campeonato não encontrado.');
    if (camp.estado === 'terminado') throw new HttpError(400, 'Campeonato já terminou.');

    const avisos = [];
    try {
      store.decidirEmpate(camp, String(req.body?.time_id || ''), avisos);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    await store.guardar(camp);
    res.json({ campeonato: enriquecer(camp), avisos });
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
    // Quem coroa o campeão aqui é a final, não o líder da tabela.
    if (camp.formato === 'pontos_final') throw new HttpError(400, 'Neste formato o campeão sai da final.');
    store.terminarPontos(camp);
    await store.guardar(camp);
    selosCache.invalidarEquipa(team.id);
    await postarOCampeao(team, camp, req.user.id);
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
    // O post do campeão não pode sobrar na Resenha apontando para um campeonato que não existe mais.
    const camp = await store.obter(team.id, req.params.id);
    if (camp) await apagarPostDoCampeao({ supabase, team, camp });
    await store.apagar(team.id, req.params.id);
    selosCache.invalidarEquipa(team.id); // se já tinha terminado, o selo sai junto
    res.json({ ok: true });
  })
);

/**
 * O documento do campeonato para quem NÃO está logado: o plantel dos times (e o do campeão) leva o apelido de cada jogador que tem conta,
 * nunca o nome completo. O plantel é um snapshot do sorteio (o nome de quando foi feito); aqui sai o de hoje. Convidado sem app mantém o
 * nome que o admin digitou. Não altera o documento recebido.
 */
async function comApelidosNoPlantel(doc) {
  const ids = [];
  for (const t of doc.times || []) for (const j of t.jogadores || []) if (j && j.user_id && !j.convidado) ids.push(j.user_id);
  if (!ids.length) return doc;
  const nomes = await carregarNomesPublicos(supabase, ids);
  if (!nomes.size) return doc;
  const trocar = (j) => (j && j.user_id && !j.convidado && nomes.has(j.user_id) ? { ...j, nome: nomes.get(j.user_id) } : j);
  const refazer = (t) => (t ? { ...t, jogadores: (t.jogadores || []).map(trocar) } : t);
  return { ...doc, times: (doc.times || []).map(refazer), campeao: refazer(doc.campeao) };
}

/** GET /api/p/campeonato/:slug/:id — vista pública (sem login) para o link. */
router.get(
  '/api/p/campeonato/:slug/:id',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, nome, slug, logo_url');
    if (!team) throw new HttpError(404, 'Time não encontrado.');
    const camp = await store.obter(team.id, req.params.id);
    if (!camp) throw new HttpError(404, 'Campeonato não encontrado.');
    // logo_url: og:image da prévia do link, quando o time tem logo.
    res.json({ campeonato: await comApelidosNoPlantel(enriquecer(camp)), equipa: { nome: team.nome, slug: team.slug, logo_url: team.logo_url || null } });
  })
);

module.exports = router;
