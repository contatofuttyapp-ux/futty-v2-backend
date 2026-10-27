// Futty v2.0 — Convites e pedidos de entrada: gerar e aceitar convite (link curto incluso), o convite pendente da instalação,
// pedir entrada num time público e a fila de pedidos do admin, e a lista de convites do time. Montadas por routes/teams.js.

const express = require('express');
const crypto = require('crypto');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { conviteLimiter, criarLimiteDeConvitePendente } = require('../middleware/limiters');
const { ipRealDoPedido } = require('../utils/cloudflareIps');
const { registrarPendente, pendentesDaRede, plataformaValida } = require('../utils/convitePendente'); // o convite que atravessa a instalação
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, getTeamBySlug, getRole, ensureUserRow, requireTeamMember } = require('../utils/db');
const { obterPedidos } = require('../services/inicio');
const { nomePublico } = require('../utils/nomePublico');
const plataforma = require('../utils/plataformaStore');
const selosCache = require('../utils/selosCache');
const { idsQueSoOrganizam } = require('../utils/soOrganiza');
const { enviarNotificacao } = require('./push'); // o "Você entrou no <time>!" do aceite de pedido
const { chamarQuemEntrou } = require('../utils/avisosDoJogo'); // quem entra no time é chamado para os jogos do elenco inteiro
const { criarCodigo, convitePorParametro, codigosDosConvites } = require('../utils/conviteCodigo'); // o link curto /c/<código>
const { fusoDoTime, lerComFuso } = require('../utils/fuso'); // o fuso do time
const { escudoDoTime } = require('../utils/escudo'); // o escudo do time

const router = express.Router();

// Decisão do dono: o link é "de grupo" — o MESMO link serve pra todo mundo, vale 30 dias e o admin
// cancela quando quiser (DELETE /api/teams/:slug/convites/:id).
const CONVITE_DIAS = 30;

/**
 * POST /api/teams/:slug/convite — gera um token de convite (qualquer membro) e, junto, o código do link
 * curto /c/<código>.
 */
router.post(
  '/api/teams/:slug/convite',
  requireAuth,
  conviteLimiter,
  asyncHandler(async (req, res) => {
    const { team } = await requireTeamMember(req.params.slug, req.user.id);

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + CONVITE_DIAS * 86400000).toISOString();

    const { data: convite, error } = await supabase
      .from('convites')
      .insert({ team_id: team.id, token, criado_por: req.user.id, expires_at: expiresAt })
      .select('id, token, expires_at')
      .single();
    if (error) throw new HttpError(500, error.message);

    // O link curto. `codigo` é null quando a migração 072 ainda não foi aplicada — o convite vale pelo
    // link longo, como sempre.
    const codigo = await criarCodigo(supabase, convite.id);

    res.status(201).json({ token: convite.token, codigo, expires_at: convite.expires_at });
  })
);

/**
 * GET /api/teams/:slug/convite/atual — o link de convite ATUAL do time (o mais recente; qualquer membro, como quem gera): a tela
 * "Convidar" mostra ele com "vale até dd/mm (X dias)", ou "vencido" (e aí só o "Gerar link novo"). { convite: null } se o time
 * nunca gerou link (ou o admin revogou todos).
 */
router.get(
  '/api/teams/:slug/convite/atual',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { team } = await requireTeamMember(req.params.slug, req.user.id);
    const { data: c, error } = await supabase
      .from('convites')
      .select('id, token, expires_at')
      .eq('team_id', team.id)
      // O mais novo é o que vence por último (todo link nasce valendo 30 dias): não depende da coluna created_at.
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!c) return res.json({ convite: null });
    const codigos = await codigosDosConvites(supabase, [c.id]);
    const vencido = !c.expires_at || new Date(c.expires_at).getTime() <= Date.now();
    res.json({ convite: { token: c.token, codigo: codigos[c.id] || null, expires_at: c.expires_at, vencido } });
  })
);

/**
 * GET /api/convite/:token — valida um convite (público; auth opcional). O parâmetro é o token longo
 * (uuid) OU o código curto de /c/<código>. Devolve sempre 200 com { valido, motivo, ... }.
 */
router.get(
  '/api/convite/:token',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const convite = await convitePorParametro(supabase, req.params.token, 'id, team_id, criado_por, expires_at');

    if (!convite) {
      return res.json({ valido: false, motivo: 'nao_encontrado', team: null });
    }

    // O time, quem convidou, os usos e o papel de quem abre só dependem do CONVITE, que já foi lido — saem
    // juntos: 2 idas no total (o convite, depois estas ao mesmo tempo; de Lisboa, cada ida a São Paulo custa
    // ~300 ms). O select do time leva também logo_url e cor_fundo, para a página do convite mostrar o escudo
    // de verdade.
    // A página mostra 3 fatos para dar vontade de entrar — quantos já estão no time, quando é o
    // próximo jogo e de que cidade. Entram na MESMA leva (a cidade vem no select do time; a contagem e o
    // próximo jogo são duas consultas a mais, em paralelo): continuam 2 idas no total.
    const [{ data: team }, { data: inviter }, { data: usosRows }, role, { count: membrosTotal }, { data: proximo }, organizam] = await Promise.all([
      // O fuso do time vai junto — o "próximo jogo" da página do convite é lido no relógio do campo.
      lerComFuso((novas) => supabase
        .from('teams')
        .select(novas ? `id, nome, slug, cor, logo_url, cor_fundo, cidade, ${novas}` : 'id, nome, slug, cor, logo_url, cor_fundo, cidade')
        .eq('id', convite.team_id)
        .single()),
      supabase
        .from('users')
        .select('nome, nome_jogador')
        .eq('id', convite.criado_por)
        .maybeSingle(),
      // O link é reutilizável: não há motivo 'usado', só 'expirado' (ou 'nao_encontrado',
      // acima) barra. `usos` é best-effort (migração 058); sem ela, 0 — nunca derruba a validação do convite.
      supabase.from('convite_usos').select('user_id').eq('convite_id', convite.id),
      req.user ? getRole(convite.team_id, req.user.id) : null,
      supabase.from('team_members').select('user_id', { count: 'exact', head: true }).eq('team_id', convite.team_id),
      // Próximo jogo = o primeiro ainda agendado daqui pra frente (cancelado/terminado não contam). Só a DATA sai
      // daqui: o local do jogo nunca vai para quem só tem o link.
      supabase
        .from('games')
        .select('data')
        .eq('team_id', convite.team_id)
        .eq('status', 'agendado')
        .gte('data', new Date().toISOString())
        .order('data', { ascending: true })
        .limit(1)
        .maybeSingle(),
      idsQueSoOrganizam(convite.team_id), // o fato é "N jogadores" — quem só organiza não conta
    ]);

    const motivo = new Date(convite.expires_at).getTime() < Date.now() ? 'expirado' : null;
    const usos = (usosRows || []).length;
    const jaMembro = !!(req.user && team && role);

    res.json({
      valido: motivo === null,
      motivo,
      autenticado: !!req.user,
      jaMembro,
      convidadoPor: inviter ? nomePublico(inviter) : null, // a página do convite é pública: o apelido, nunca o nome completo
      expires_at: convite.expires_at,
      usos,
      // Os fatos da página: `membros` é a contagem, `proximoJogo` o instante do próximo jogo agendado
      // (ISO; o app o escreve como data curta no fuso de quem olha) ou null, `cidade` o texto que o admin
      // declarou.
      membros: Math.max(0, (membrosTotal ?? 0) - organizam.size),
      proximoJogo: proximo?.data || null,
      fuso: fusoDoTime(team), // o instante do próximo jogo se lê neste fuso (o do campo)
      cidade: team?.cidade || null,
      team: team ? { nome: team.nome, slug: team.slug, ...escudoDoTime(team), logo_url: team.logo_url || null, cor_fundo: team.cor_fundo || null, fuso: fusoDoTime(team) } : null,
    });
  })
);

/**
 * POST /api/convite/:token/aceitar — entra no time pelo convite. `:token` é o uuid ou o
 * código curto. O link é reutilizável: o convite não é consumido — quem entra fica registrado em
 * `convite_usos` (migração 058, best-effort) e o mesmo convite segue valendo para a próxima pessoa
 * até `expires_at`. Quem já é membro recebe `jaMembro: true` sem novo registro.
 */
router.post(
  '/api/convite/:token/aceitar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const convite = await convitePorParametro(supabase, req.params.token, 'id, team_id, expires_at');
    if (!convite) throw new HttpError(404, 'Convite não encontrado.');

    const { data: team } = await supabase
      .from('teams')
      .select('id, slug, nome, cor')
      .eq('id', convite.team_id)
      .single();
    if (!team) throw new HttpError(404, 'Time não encontrado.');

    await ensureUserRow(req.user);

    // `id`: o Onboarding marca as boas-vindas do time como vistas (`futty_onboarding_<id>`) logo que a
    // pessoa entra.
    const teamResumo = { id: team.id, slug: team.slug, nome: team.nome, cor: team.cor };

    // Já é membro? -> idempotente, não registra novo uso do convite
    const existingRole = await getRole(team.id, req.user.id);
    if (existingRole) {
      return res.json({ jaMembro: true, team: teamResumo });
    }

    // Valida o estado do convite (apenas para novos membros). O
    // link é reutilizável: só a validade importa, não se já foi usado antes.
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
    selosCache.invalidarMembro(team.id, req.user.id);
    // Os jogos que chamam o elenco inteiro passam a chamar quem entrou (e avisam agora).
    chamarQuemEntrou(team.id, req.user.id);

    // Registra o uso (migração 058) em vez de marcar o convite como consumido: o link continua
    // válido para a próxima pessoa. Fail-safe de propósito: tabela ausente ou 23505 (mesma pessoa
    // aceitando de novo, corrida) nunca podem derrubar uma entrada que já valeu (o INSERT em
    // team_members acima já commitou).
    const { error: usoError } = await supabase.from('convite_usos').insert({ convite_id: convite.id, user_id: req.user.id });
    if (usoError && usoError.code !== '23505') {
      console.warn('[convite] convite_usos indisponível (migração 058 aplicada?):', usoError.message);
    }

    res.status(201).json({ jaMembro: false, team: teamResumo });
  })
);

const convitePendenteLimiter = criarLimiteDeConvitePendente();

/**
 * POST /api/convite/:token/pendente — a página do convite abriu no navegador de um celular (público, sem sessão). Body:
 * { plataforma: 'ios' | 'android' }. O motor guarda o convite com a rede de quem abriu (utils/convitePendente.js) por 2 h, para o
 * app o achar depois da instalação. Sempre 204: a resposta não diz se o convite existe nem se foi guardado.
 */
router.post(
  '/api/convite/:token/pendente',
  convitePendenteLimiter,
  asyncHandler(async (req, res) => {
    const daLoja = plataformaValida(req.body?.plataforma);
    if (daLoja) {
      const convite = await convitePorParametro(supabase, req.params.token, 'id, expires_at');
      if (convite && new Date(convite.expires_at).getTime() >= Date.now()) {
        await registrarPendente({ conviteId: convite.id, ip: ipRealDoPedido(req), plataforma: daLoja });
      }
    }
    res.status(204).end();
  })
);

/**
 * GET /api/convite-pendente?plataforma=ios|android — quem acabou de se cadastrar pergunta se abriu um convite no navegador deste
 * celular. Devolve { convites: [{ token, team, convidadoPor }] }: os convites válidos da mesma rede e plataforma nas últimas 2 h, um por
 * time, sem os times de que a pessoa já é membro. `token` é o código curto (ou o token longo) — o app aceita com o POST de sempre.
 * A plataforma vem da query; sem ela, do cabeçalho X-Futty-Plataforma do app.
 */
router.get(
  '/api/convite-pendente',
  requireAuth,
  asyncHandler(async (req, res) => {
    const daLoja = plataformaValida(req.query.plataforma) || plataformaValida(req.get('x-futty-plataforma'));
    const ids = daLoja ? await pendentesDaRede({ ip: ipRealDoPedido(req), plataforma: daLoja }) : [];
    if (!ids.length) return res.json({ convites: [] });

    const agora = Date.now();
    const [{ data: convites }, { data: vinculos }, codigos] = await Promise.all([
      supabase.from('convites').select('id, token, team_id, criado_por, expires_at').in('id', ids),
      supabase.from('team_members').select('team_id').eq('user_id', req.user.id),
      codigosDosConvites(supabase, ids),
    ]);
    const jaSou = new Set((vinculos || []).map((v) => v.team_id));
    const ordem = new Map(ids.map((id, i) => [id, i]));
    const vivos = (convites || [])
      .filter((c) => new Date(c.expires_at).getTime() >= agora && !jaSou.has(c.team_id))
      .sort((a, b) => ordem.get(a.id) - ordem.get(b.id));
    // Um por time: o mais recente (dois links do mesmo time são o mesmo convite para quem chega).
    const porTime = new Map();
    for (const c of vivos) if (!porTime.has(c.team_id)) porTime.set(c.team_id, c);
    const escolhidos = [...porTime.values()];
    if (!escolhidos.length) return res.json({ convites: [] });

    const { equipas: suspensas } = await plataforma.conjuntos();
    const [{ data: times }, { data: quem }] = await Promise.all([
      supabase.from('teams').select('id, nome, slug, logo_url, cor_fundo').in('id', escolhidos.map((c) => c.team_id)),
      supabase.from('users').select('id, nome, nome_jogador').in('id', escolhidos.map((c) => c.criado_por).filter(Boolean)),
    ]);
    const timePorId = new Map((times || []).map((t) => [t.id, t]));
    const quemPorId = new Map((quem || []).map((u) => [u.id, u]));
    res.json({
      convites: escolhidos
        .filter((c) => timePorId.has(c.team_id) && !suspensas.has(c.team_id))
        .map((c) => {
          const t = timePorId.get(c.team_id);
          const u = quemPorId.get(c.criado_por);
          return {
            token: codigos[c.id] || c.token,
            team: { id: t.id, nome: t.nome, slug: t.slug, logo_url: t.logo_url || null, cor_fundo: t.cor_fundo || null },
            convidadoPor: u ? nomePublico(u) : null,
          };
        }),
    });
  })
);

/**
 * Chegou pedido de entrada → push para os admins do time ("Fulano quer entrar no <time>"), que leva à aba
 * Elenco, onde se aceita. Tipo "pedidos" em Perfil → Notificações: quem desligou não recebe. Nunca lança.
 */
function avisarAdminsDoPedido(team, userId) {
  Promise.resolve().then(async () => {
    const [{ data: admins }, { data: quem }, { data: time }] = await Promise.all([
      supabase.from('team_members').select('user_id').eq('team_id', team.id).eq('role', 'admin'),
      supabase.from('users').select('nome, nome_jogador').eq('id', userId).maybeSingle(),
      supabase.from('teams').select('nome').eq('id', team.id).maybeSingle(),
    ]);
    const ids = (admins || []).map((a) => a.user_id).filter((id) => id && id !== userId);
    if (!ids.length) return;
    const nome = quem?.nome_jogador || quem?.nome || 'Alguém';
    await enviarNotificacao(ids, {
      title: `${nome} quer entrar no ${time?.nome || 'seu time'}`,
      body: 'Toque para aceitar ou recusar.',
      url: `/time/${team.slug}?aba=elenco`,
    }, { categoria: 'pedidos' });
  }).catch(() => {});
}

/** POST /api/teams/:slug/pedir-entrada — pedir entrada num time público. */
router.post(
  '/api/teams/:slug/pedir-entrada',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug, modo_visibilidade');
    if (!team) throw new HttpError(404, 'Time não encontrado.');
    if (team.modo_visibilidade === 'privado') throw new HttpError(403, 'Este time não é público.');

    const role = await getRole(team.id, req.user.id);
    if (role) throw new HttpError(400, 'Você já é membro deste time.');

    await ensureUserRow(req.user);

    // Time aberto: entra já como membro, sem pedido pendente.
    if (team.modo_visibilidade === 'publico_aberto') {
      const { error: me } = await supabase
        .from('team_members')
        .upsert({ team_id: team.id, user_id: req.user.id, role: 'member' }, { onConflict: 'user_id,team_id' });
      if (me) throw new HttpError(500, me.message);
      selosCache.invalidarMembro(team.id, req.user.id);
      chamarQuemEntrou(team.id, req.user.id);
      return res.status(201).json({ entrou: true });
    }

    const mensagem = req.body?.mensagem ? String(req.body.mensagem).trim().slice(0, 300) : null;
    const avisar = () => avisarAdminsDoPedido(team, req.user.id); // fire-and-forget, nunca atrasa nem derruba o pedido

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
          avisar();
          return res.json({ pedido: reaberto || existente });
        }
        return res.json({ pedido: existente || { id: null, status: 'pending' } });
      }
      throw new HttpError(500, error.message);
    }

    avisar();
    res.status(201).json({ pedido: data });
  })
);

/** DELETE /api/teams/:slug/pedir-entrada — cancela o MEU pedido pendente. */
router.delete(
  '/api/teams/:slug/pedir-entrada',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');
    const { error } = await supabase
      .from('team_join_requests')
      .delete()
      .eq('team_id', team.id)
      .eq('user_id', req.user.id)
      .eq('status', 'pending');
    if (error) throw new HttpError(500, error.message);
    res.json({ ok: true });
  })
);

/**
 * GET /api/me/pedidos — os MEUS pedidos de entrada visíveis no app (ciclo v1,
 * sem push): desfechos (approved/rejected ainda não dispensados) E os que ainda
 * estão PENDING (P1-4 — o candidato via o pendente só no Explorar). O Início
 * separa: pending → card "pedido pendente · cancelar"; resto → desfecho.
 */
router.get(
  '/api/me/pedidos',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await obterPedidos(req.user.id));
  })
);

/** DELETE /api/me/pedidos/:id — dispensa o desfecho (apaga a MINHA linha). */
router.delete(
  '/api/me/pedidos/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { error } = await supabase
      .from('team_join_requests')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .in('status', ['approved', 'rejected']);
    if (error) throw new HttpError(500, error.message);
    res.json({ ok: true });
  })
);

/** GET /api/teams/:slug/pedidos — pedidos pendentes (só admin). */
router.get(
  '/api/teams/:slug/pedidos',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');

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

    const team = await getTeamBySlug(req.params.slug, 'id, slug, nome');
    if (!team) throw new HttpError(404, 'Time não encontrado.');

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
      selosCache.invalidarMembro(team.id, pedido.user_id);
      chamarQuemEntrou(team.id, pedido.user_id);
    }

    const { data: updated, error } = await supabase
      .from('team_join_requests')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', pedido.id)
      .select('id, status, updated_at')
      .single();
    if (error) throw new HttpError(500, error.message);

    // Quem foi aceito recebe o push e abre o time já com as boas-vindas (`?entrou=1` → Time.jsx). Só na 1ª
    // aprovação (um 2º toque do admin não avisa de novo), com o aceite já gravado e ANTES de responder (no
    // Cloud Run a CPU fica estrangulada depois da resposta). O push nunca derruba o aceite — falha vira
    // log — e não segura o admin: espera no máximo 4 s.
    if (status === 'approved' && pedido.status !== 'approved') {
      let teto;
      try {
        await Promise.race([
          Promise.resolve(enviarNotificacao([pedido.user_id], {
            title: `Você entrou no time ${team.nome}!`,
            body: 'Confirme presença e veja o próximo jogo.',
            url: `/time/${team.slug}?entrou=1`,
          })),
          new Promise((resolve) => { teto = setTimeout(resolve, 4000); }),
        ]);
      } catch (e) {
        console.warn('[teams] push do aceite de pedido falhou (o aceite foi gravado):', e?.message || e);
      } finally {
        clearTimeout(teto);
      }
    }

    res.json({ pedido: updated });
  })
);

/** GET /api/teams/:slug/convites — convites ativos (não usados, não expirados). */
router.get(
  '/api/teams/:slug/convites',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');
    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem ver os convites.');

    // Sem o .is('usado_por', null): o link reutilizável continua
    // "ativo" mesmo depois de usado; só a validade (expires_at) tira da lista.
    const nowIso = new Date().toISOString();
    const { data: convites, error } = await supabase
      .from('convites')
      .select('id, token, created_at, expires_at, criado_por')
      .eq('team_id', team.id)
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: false });
    if (error) throw new HttpError(500, error.message);

    // Nomes dos criadores (criado_por).
    const ids = [...new Set((convites || []).map((c) => c.criado_por).filter(Boolean))];
    const nomeMap = {};
    if (ids.length) {
      const { data: us } = await supabase.from('users').select('id, nome, nome_jogador').in('id', ids);
      for (const u of us || []) nomeMap[u.id] = u.nome_jogador || u.nome || 'Jogador';
    }

    // "N entraram por este link" — uma query só (in convite_id), contada em
    // memória. Best-effort (migração 058): sem ela, todos ficam em 0.
    const conviteIds = (convites || []).map((c) => c.id);
    const usosMap = {};
    if (conviteIds.length) {
      const { data: usos } = await supabase.from('convite_usos').select('convite_id').in('convite_id', conviteIds);
      for (const u of usos || []) usosMap[u.convite_id] = (usosMap[u.convite_id] || 0) + 1;
    }

    // O código do link curto (migração 072): best-effort — sem a tabela, o admin segue com o link longo.
    const codigosMap = await codigosDosConvites(supabase, conviteIds);

    const lista = (convites || []).map((c) => ({
      id: c.id,
      token: c.token,
      codigo: codigosMap[c.id] || null,
      criado_por_nome: c.criado_por ? nomeMap[c.criado_por] || null : null,
      created_at: c.created_at,
      expires_at: c.expires_at,
      usos: usosMap[c.id] || 0,
    }));
    res.json({ convites: lista });
  })
);

/** DELETE /api/teams/:slug/convites/:conviteId — revoga um convite (só admin). */
router.delete(
  '/api/teams/:slug/convites/:conviteId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');
    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem revogar convites.');

    const { data: conv } = await supabase
      .from('convites')
      .select('id, team_id')
      .eq('id', req.params.conviteId)
      .maybeSingle();
    if (!conv || conv.team_id !== team.id) throw new HttpError(404, 'Convite não encontrado.');

    const { error } = await supabase.from('convites').delete().eq('id', conv.id);
    if (error) throw new HttpError(500, error.message);
    res.json({ deleted: true });
  })
);

module.exports = router;
