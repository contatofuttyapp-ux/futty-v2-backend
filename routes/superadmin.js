// Futty v2.0 — Painel super-admin (gestão global de usuários e times).
// Todas as rotas exigem requireSuperAdmin. Montado sem prefixo em server.js
// (os paths /api/super/... são definidos aqui).
//
// ══ LEI DO DONO ══════════════════════════════════════════════════════════════
// A Super age sobre a PLATAFORMA (contas, times, suspensão), NUNCA sobre o
// CONTEÚDO (notas, votos, fotos). Moderação de conteúdo = SÓ pelo caminho
// registrado (denúncias → triagem → decisão em log append-only). Aqui não se vê
// nem se edita conteúdo de ninguém: só se suspende/reativa. Créditos e pacote
// de Brilhante têm rota própria (routes/gabinete.js, aba "Brilhantes") — não
// se mexe neles por aqui.
// ═════════════════════════════════════════════════════════════════════════════
const express = require('express');
const { requireSuperAdmin } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase } = require('../utils/db');
const { avatarEhFigurinhaNossa } = require('../utils/figurinhaRegra');
const plataforma = require('../utils/plataformaStore');
const { cotaBytesPorTime, bytesUsadosPorTodosOsTimes } = require('../utils/resenhaCota');
const selosCache = require('../utils/selosCache');
const { enviarNotificacao } = require('./push');
const { apagarUsuario } = require('../utils/apagarUsuario');
const { motivoParaNaoExcluir, emailMascarado, TIMES_PROTEGIDOS } = require('../utils/contaProtegida');
const acoes = require('../utils/acoesDoGabinete');
const { esquecerSessoesDe } = require('../middleware/auth');
const { nomePublico } = require('../utils/nomePublico');

const ehUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

/** Quem é a conta (para o log e para a proteção): id, e-mail, nomes e se é super-admin. null se não existe. */
async function contaPorId(id) {
  const { data, error } = await supabase.from('users').select('id, email, nome, nome_jogador, is_super_admin').eq('id', id).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  return data || null;
}

/** Os slugs dos times PROTEGIDOS de que cada conta é membro: Map(user_id → [slug]). Só esses importam para a proteção. */
async function timesProtegidosPorConta(ids = null) {
  const slugs = TIMES_PROTEGIDOS.map((t) => t.slug);
  const { data: times, error } = await supabase.from('teams').select('id, slug').in('slug', slugs);
  if (error) throw new HttpError(500, error.message);
  const mapa = new Map();
  if (!(times || []).length) return mapa;
  const slugPorTime = new Map(times.map((t) => [t.id, t.slug]));
  let q = supabase.from('team_members').select('team_id, user_id').in('team_id', [...slugPorTime.keys()]);
  if (ids) q = q.in('user_id', ids);
  const { data: vinculos, error: e2 } = await q;
  if (e2) throw new HttpError(500, e2.message);
  for (const v of vinculos || []) mapa.set(v.user_id, [...(mapa.get(v.user_id) || []), slugPorTime.get(v.team_id)]);
  return mapa;
}

/** Quem fez a ação, para o log: id e o nome público (nunca o e-mail do dono). */
async function quemFezNoGabinete(userId) {
  const { data } = await supabase.from('users').select('id, nome, nome_jogador').eq('id', userId).maybeSingle();
  return { id: userId, nome: data ? nomePublico(data) : null };
}
const alvoDoLog = (conta, id) => ({ id: conta?.id || id, apelido: conta ? nomePublico(conta) : null, email: emailMascarado(conta?.email) });

const router = express.Router();

/**
 * GET /api/super/users?page=1&limit=50 — lista paginada de usuários.
 * Devolve { users, page, limit, total }.
 */
router.get(
  '/api/super/users',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const off = (page - 1) * limit;

    // Ordem alfabética pelo nome (Rodada 30E, item 2): a colação do Postgres não é exatamente a do
    // Intl.Collator('pt-BR') do frontend, por isso a página final é reordenada lá; aqui a ordem só
    // precisa ser TOTAL (com 'id' de desempate) para nenhuma pessoa repetir ou pular entre páginas.
    const { data, count, error } = await supabase
      .from('users')
      .select('id, nome, nome_jogador, email, brilhante_creditos, avatar_url, is_super_admin, created_at', { count: 'exact' })
      .order('nome', { ascending: true })
      .order('id', { ascending: true })
      .range(off, off + limit - 1);
    if (error) throw new HttpError(500, error.message);

    // Estado de suspensão (store de plataforma, sem DDL) anexado a cada linha; e, por linha, se a conta pode ser excluída
    // (`protegida` = o motivo de não poder, ou null) — o Gabinete só mostra "Excluir" para quem pode.
    const [{ users: susUsers }, protegidosPorConta] = await Promise.all([
      plataforma.conjuntos(),
      timesProtegidosPorConta((data || []).map((u) => u.id)),
    ]);
    // (SPEC-FIGURINHA-3) Não há `plan`: o que se vê aqui é o direito
    // de Brilhante (créditos e se já tem uma), pela mesma regra do resto do app
    // (o avatar atual ser um arquivo de figurinha nosso — não avatar_url ≠ foto_url,
    // que contava a foto do Google). Sem avatar_url no
    // payload de volta: é detalhe de implementação, não algo que a tela precise
    // mostrar.
    const users = (data || []).map(({ avatar_url, ...u }) => ({
      ...u,
      suspenso: susUsers.has(u.id),
      tem_brilhante: avatarEhFigurinhaNossa(avatar_url),
      protegida: motivoParaNaoExcluir({ conta: u, quemPede: req.user.id, slugsDosTimes: protegidosPorConta.get(u.id) || [] }),
    }));

    res.json({ users, page, limit, total: count || 0 });
  })
);

/**
 * PATCH /api/super/users/:id/suspender — suspende/reativa uma conta via FLAG de
 * plataforma. Body: { suspenso: true|false }. NÃO apaga nada, NÃO vê o conteúdo do
 * usuário. Conta suspensa deixa de entrar (gate em requireAuth → 403 digno).
 */
router.patch(
  '/api/super/users/:id/suspender',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const suspenso = req.body?.suspenso === true;
    // Salvaguarda: a Super não se suspende a si própria (evita auto-trancar-se fora).
    if (suspenso && req.params.id === req.user.id) {
      throw new HttpError(400, 'Você não pode suspender a sua própria conta.');
    }
    await plataforma.definirUser(req.params.id, suspenso);
    const [conta, por] = await Promise.all([contaPorId(req.params.id).catch(() => null), quemFezNoGabinete(req.user.id)]);
    await acoes.registrar({ acao: suspenso ? 'suspender_conta' : 'reativar_conta', por, alvo: alvoDoLog(conta, req.params.id) });
    res.json({ id: req.params.id, suspenso });
  })
);

/**
 * DELETE /api/super/users/:id — exclui a conta de outra pessoa pelo Gabinete. Body: { confirmar: 'EXCLUIR' }.
 * A exclusão é a MESMA de DELETE /api/me (utils/apagarUsuario.js: sucessão dos times, Storage, logs, Auth) — nunca uma segunda versão.
 * Recusa (403, CONTA_PROTEGIDA) as contas de utils/contaProtegida.js: a do próprio dono, super-admins, a demo das lojas, os revisores
 * da Apple e os membros dos times protegidos. Fica no log de ações do Gabinete.
 */
router.delete(
  '/api/super/users/:id',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!ehUuid(id)) throw new HttpError(404, 'Conta não encontrada.');
    const conta = await contaPorId(id);
    if (!conta) throw new HttpError(404, 'Conta não encontrada.');

    const protegidos = await timesProtegidosPorConta([id]);
    const motivo = motivoParaNaoExcluir({ conta, quemPede: req.user.id, slugsDosTimes: protegidos.get(id) || [] });
    if (motivo) throw new HttpError(403, motivo, 'CONTA_PROTEGIDA');
    if (req.body?.confirmar !== 'EXCLUIR') {
      throw new HttpError(400, 'Confirmação obrigatória: envie { confirmar: "EXCLUIR" }.');
    }

    const por = await quemFezNoGabinete(req.user.id);
    const resultado = await apagarUsuario(id);
    // A pessoa não volta a entrar com uma sessão que este motor ainda tinha guardada; e uma suspensão dela já não tem a quem valer.
    esquecerSessoesDe(id);
    try {
      if (await plataforma.userSuspenso(id)) await plataforma.definirUser(id, false);
    } catch (e) {
      console.warn('[super] excluir conta: a suspensão antiga ficou na lista (a conta já não existe):', e?.message || e);
    }
    const noLog = await acoes.registrar({
      acao: 'excluir_conta',
      por,
      alvo: alvoDoLog(conta, id),
      detalhe: { times_apagados: resultado.timesApagados.length, times_passados_adiante: resultado.timesTransferidos.length, fotos_removidas: resultado.fotosRemovidas },
    });

    res.json({
      ok: true,
      apelido: nomePublico(conta),
      times_apagados: resultado.timesApagados,
      times_passados_adiante: resultado.timesTransferidos.map((t) => t.slug),
      fotos_removidas: resultado.fotosRemovidas,
      no_log: noLog,
    });
  })
);

/** GET /api/super/acoes — as últimas ações do Gabinete sobre contas (suspender, reativar, excluir), a mais recente primeiro. */
router.get(
  '/api/super/acoes',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    try {
      res.json({ acoes: await acoes.ultimas(30) });
    } catch (e) {
      console.error('[super] log de ações ilegível:', e?.message || e);
      throw new HttpError(503, 'Não deu para ler o log de ações agora.');
    }
  })
);

/**
 * PATCH /api/super/users/:id/ban — suspende/reativa uma conta via ban nativo
 * do Supabase Auth. Body: { banned: true|false }.
 * Nota: tokens já emitidos só deixam de funcionar no próximo refresh (~1h).
 */
router.patch(
  '/api/super/users/:id/ban',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const banned = req.body?.banned === true;
    const { error } = await supabase.auth.admin.updateUserById(req.params.id, {
      ban_duration: banned ? '876000h' : 'none', // ~100 anos ≈ permanente
    });
    if (error) throw new HttpError(500, error.message);

    res.json({ banned });
  })
);

// O Supabase devolve no máximo 1.000 linhas por resposta (o teto do PostgREST). Uma consulta sem paginação
// corta a lista de times e a contagem de membros calado. Lê em páginas de 1.000 com .range até uma página vir menor.
// A ordem tem de ser TOTAL para as páginas não se repetirem nem pularem linhas: quem chama termina o .order() com 'id'.
const PAGINA_SUPABASE = 1000;
async function lerTudo(consulta) {
  const linhas = [];
  for (let de = 0; ; de += PAGINA_SUPABASE) {
    const { data, error } = await consulta().range(de, de + PAGINA_SUPABASE - 1);
    if (error) throw new HttpError(500, error.message);
    linhas.push(...(data || []));
    if (!data || data.length < PAGINA_SUPABASE) return linhas;
  }
}

/**
 * GET /api/super/teams — lista todos os times com nr. de membros e uso de
 * mídia da Resenha (cota de 500 MB por time). Lê tudo, sem teto de 1.000.
 */
router.get(
  '/api/super/teams',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const teams = await lerTudo(() => supabase
      .from('teams')
      .select('id, slug, nome, created_at')
      .order('created_at', { ascending: false })
      .order('id'));

    // Contagem de membros: TODOS os vínculos (em páginas) e tally em JS, sem N+1.
    const membros = await lerTudo(() => supabase.from('team_members').select('team_id').order('id'));
    const contagem = {};
    for (const m of membros) contagem[m.team_id] = (contagem[m.team_id] || 0) + 1;

    const [{ equipas: susEquipas }, bytesPorTime] = await Promise.all([
      plataforma.conjuntos(),
      bytesUsadosPorTodosOsTimes(), // {} se a migração 053 ainda não rodou (fail-open, já avisa no log)
    ]);
    const cotaMb = Math.round(cotaBytesPorTime() / (1024 * 1024));
    res.json({
      teams: teams.map((t) => {
        const bytes = bytesPorTime[t.id];
        return {
          ...t,
          nr_membros: contagem[t.id] || 0,
          suspensa: susEquipas.has(t.id),
          // null = migração 053 ainda não rodou; o Gabinete mostra "—" nesse caso.
          midia_mb: bytes != null ? Math.round((bytes / (1024 * 1024)) * 10) / 10 : null,
          midia_cota_mb: cotaMb,
        };
      }),
    });
  })
);

/**
 * PATCH /api/super/teams/:id/suspender — suspende/reativa um time via FLAG de
 * plataforma. Body: { suspensa: true|false }. NÃO edita o interior do time. Time
 * suspensa fica invisível na descoberta e inacessível (getTeamBySlug devolve 404).
 */
router.patch(
  '/api/super/teams/:id/suspender',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const suspensa = req.body?.suspensa === true;
    await plataforma.definirEquipa(req.params.id, suspensa);
    res.json({ id: req.params.id, suspensa });
  })
);

/**
 * DELETE /api/super/teams/:id — apaga um time (cascade nas FKs).
 * Exige confirmação explícita no body: { confirmar: 'APAGAR' }.
 */
router.delete(
  '/api/super/teams/:id',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    if (req.body?.confirmar !== 'APAGAR') {
      throw new HttpError(400, 'Confirmação inválida. Envie { confirmar: "APAGAR" }.');
    }
    const { error } = await supabase.from('teams').delete().eq('id', req.params.id);
    if (error) throw new HttpError(500, error.message);

    res.json({ ok: true });
  })
);

/**
 * GET /api/super/contas-sem-time — quem criou conta e não está em time nenhum (o convite que se perdeu, o cadastro feito antes de
 * abrir o link). Devolve { contas, times }: as contas da mais nova para a mais antiga e a lista de times para o "Pôr no time…".
 * Só dados de plataforma (nome, apelido, e-mail, quando entrou) — nada do conteúdo da pessoa.
 */
router.get(
  '/api/super/contas-sem-time',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const [users, vinculos, teams, { users: suspensos, equipas: suspensas }] = await Promise.all([
      lerTudo(() => supabase.from('users').select('id, nome, nome_jogador, email, created_at').order('created_at', { ascending: false }).order('id')),
      lerTudo(() => supabase.from('team_members').select('user_id').order('id')),
      lerTudo(() => supabase.from('teams').select('id, slug, nome').order('nome', { ascending: true }).order('id')),
      plataforma.conjuntos(),
    ]);
    const comTime = new Set(vinculos.map((v) => v.user_id));
    res.json({
      contas: users.filter((u) => !comTime.has(u.id)).map((u) => ({ ...u, suspenso: suspensos.has(u.id) })),
      times: teams.filter((t) => !suspensas.has(t.id)),
    });
  })
);

/**
 * POST /api/super/contas-sem-time/:userId/time — põe a conta no time escolhido, como membro (o mesmo que aceitar o convite). Body:
 * { team_id }. Quem entrou recebe o push "Você entrou no time …", que abre o time com as boas-vindas. Conta que já é do time: 409.
 */
router.post(
  '/api/super/contas-sem-time/:userId/time',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const teamId = String(req.body?.team_id || '');
    if (!teamId || teamId.length > 64) throw new HttpError(400, 'Escolha o time.');
    const [{ data: u }, { data: team }] = await Promise.all([
      supabase.from('users').select('id').eq('id', req.params.userId).maybeSingle(),
      supabase.from('teams').select('id, slug, nome').eq('id', teamId).maybeSingle(),
    ]);
    if (!u) throw new HttpError(404, 'Conta não encontrada.');
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    const { error } = await supabase.from('team_members').insert({ user_id: u.id, team_id: team.id, role: 'member' });
    if (error) {
      if (error.code === '23505') throw new HttpError(409, `A conta já é do ${team.nome}.`);
      throw new HttpError(500, error.message);
    }
    selosCache.invalidarMembro(team.id, u.id);

    // O push nunca derruba a entrada (já gravada) e não segura o Gabinete mais que 4 s.
    let teto;
    try {
      await Promise.race([
        Promise.resolve(enviarNotificacao([u.id], {
          title: `Você entrou no time ${team.nome}!`,
          body: 'Confirme presença e veja o próximo jogo.',
          url: `/time/${team.slug}?entrou=1`,
        })),
        new Promise((resolve) => { teto = setTimeout(resolve, 4000); }),
      ]);
    } catch (e) {
      console.warn('[super] push de "Pôr no time" falhou (a entrada foi gravada):', e?.message || e);
    } finally {
      clearTimeout(teto);
    }

    res.status(201).json({ ok: true, team: { id: team.id, slug: team.slug, nome: team.nome } });
  })
);

// GET /api/super/stats existiu para os cards do /super de 16 secções
// (métricas incluíam users_pro/users_elite). Órfã desde o Gabinete 2.0 (a
// Visão Geral usa /api/super/gabinete/resumo) — nenhum frontend a chama.
// Removida nesta varredura em vez de só trocar `plan` por outra coisa:
// ninguém a lê.

module.exports = router;
