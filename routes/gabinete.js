// Futty v2.0 — Gabinete do Dono (/gabinete). Rota super-admin exclusiva.
// Camada de LEITURA agregada (série temporal, pulso, vida, marcos) + store editável
// (Operação/Publicidade). Lei da casa: o dono é CEGO ao conteúdo — só números.
// Receita (Stripe) e Publicidade (medição de ads) ainda não têm fonte real → "em breve"
// digno, SEM inventar números. Ver SPEC-GABINETE v3.
const express = require('express');
const { requireSuperAdmin } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase } = require('../utils/db');
const denunciaStore = require('../utils/denunciaStore');
const gabineteStore = require('../utils/gabineteStore');
const adsStore = require('../utils/adsStore');
const { ehMigracaoEmFalta } = require('../utils/direitoBrilhante');
const { enviarNotificacao } = require('./push');
const { KITS_IA } = require('./auth');
const pkg = require('../package.json');

const router = express.Router();

const DIA = 86400000;
const inicioDiaUTC = (d) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x; };

// 17-set: o custo por geração deixou de ser constante aqui. Ele é MEDIDO na fal
// a cada chamada (header `x-fal-billable-units`, ver utils/falFila.js) e somado
// em gasto_ia_diario — o Gabinete passa a dividir custo_cents por geracoes do
// próprio período. A constante antiga (1,7 cêntimos) mostrava ao dono um número
// 6,6× abaixo do real.
const TETO_DIARIO_CENTS = Number(process.env.TETO_DIARIO_CENTS) || 5000;

// Rate limiters ativos — manifesto estático, sincronizado à mão com server.js
// (apiLimiter/strictLimiter) e media.js/limiters.js (não há API pública do
// express-rate-limit para ler a config de volta de uma instância já criada).
const RATE_LIMITS_ATIVOS = [
  { rota: 'global · toda /api (exceto /api/media)', limite: process.env.NODE_ENV === 'production' ? '200/15min por IP' : '2000/15min por IP (dev)' },
  { rota: 'GET /api/media/:token', limite: '600/15min por IP' },
  { rota: 'POST /api/me/avatar[/ai]', limite: '20/15min por IP' },
  { rota: 'POST /api/teams/:slug/convite', limite: '10/hora por utilizador' },
  { rota: 'POST /api/push/.../broadcast + .../mensagem', limite: '20/hora por utilizador (partilhado)' },
  { rota: 'POST /api/denuncias + /api/feed/denuncias', limite: '20/hora por utilizador (partilhado)' },
  { rota: 'POST /api/diagnostico', limite: '10/hora por utilizador' },
];

// Série CUMULATIVA por semana (últimas 8): quantos existiam até ao fim de cada semana.
function cumulativoSemanal(datas, nSemanas = 8) {
  const agora = Date.now();
  const marcos = [];
  for (let i = nSemanas - 1; i >= 0; i -= 1) marcos.push(agora - i * 7 * DIA);
  const ts = (datas || []).map((d) => new Date(d).getTime()).filter((n) => !Number.isNaN(n));
  return marcos.map((fim) => ts.filter((t) => t <= fim).length);
}
// Contagem por DIA (últimos 7): mapa 'YYYY-MM-DD' → n.
function porDia(datas, nDias = 7) {
  const hoje = inicioDiaUTC(new Date()).getTime();
  const chaves = [];
  for (let i = nDias - 1; i >= 0; i -= 1) chaves.push(new Date(hoje - i * DIA).toISOString().slice(0, 10));
  const cont = Object.fromEntries(chaves.map((k) => [k, 0]));
  for (const d of datas || []) { const k = new Date(d).toISOString().slice(0, 10); if (k in cont) cont[k] += 1; }
  return { chaves, vals: chaves.map((k) => cont[k]) };
}

/** GET /api/super/gabinete — pulso + crescimento + vida + marcos (agregados, sem PII). */
router.get(
  '/api/super/gabinete',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const hojeISO = inicioDiaUTC(new Date()).toISOString();
    const amanhaISO = new Date(inicioDiaUTC(new Date()).getTime() + DIA).toISOString();

    const [usersRes, teamsRes, campsRes, gamesRes, postsRes] = await Promise.all([
      supabase.from('users').select('created_at'),
      supabase.from('teams').select('id, nome, created_at'),
      // A coluna de data desta tabela é `criado_em` (migração 026), não `created_at`:
      // com o nome errado o PostgREST devolvia erro, `camps` caía para [] e o
      // gráfico de campeonatos ficava eternamente a zero (15-set).
      supabase.from('campeonatos').select('nome, estado, campeao, criado_em'),
      supabase.from('games').select('data, created_at, sorteio_realizado'),
      supabase.from('feed_posts').select('created_at'),
    ]);
    const users = usersRes.data || [];
    const teams = teamsRes.data || [];
    const camps = campsRes.data || [];
    const games = gamesRes.data || [];
    const posts = postsRes.data || [];

    // ── PULSO DO DIA ──
    const usersHoje = users.filter((u) => u.created_at >= hojeISO).length;
    const jogosHoje = games.filter((g) => g.data && g.data >= hojeISO && g.data < amanhaISO).length;
    // denúncias ABERTAS (sem resolução) — agregado, zero conteúdo.
    let denunciasAbertas = 0;
    try {
      const ids = teams.map((t) => t.id); ids.push('_sem');
      const listas = await Promise.all(ids.map((t) => denunciaStore.listarEquipa(t)));
      denunciasAbertas = listas.flat().filter((c) => !c.resolvido_em).length;
    } catch { denunciasAbertas = 0; }

    // ── CRESCIMENTO (8 semanas, cumulativo) ──
    const semanas = Array.from({ length: 8 }, (_, i) => `S${i + 1}`);
    const crescimento = {
      semanas,
      users: cumulativoSemanal(users.map((u) => u.created_at)),
      equipas: cumulativoSemanal(teams.map((t) => t.created_at)),
      camp: cumulativoSemanal(camps.map((c) => c.criado_em)),
    };

    // ── VIDA (7 dias) ──
    const vPosts = porDia(posts.map((p) => p.created_at));
    const vSorteios = porDia(games.filter((g) => g.sorteio_realizado).map((g) => g.created_at));
    const vJogos = porDia(games.map((g) => g.data || g.created_at));
    const vida = {
      dias: vPosts.chaves.map((k) => k.slice(5)), // MM-DD
      posts: vPosts.vals,
      sorteios: vSorteios.vals,
      jogos: vJogos.vals,
    };

    // ── MARCOS (reais: campeões + equipas novas) ──
    const marcos = [];
    camps.filter((c) => c.estado === 'terminado' && c.campeao)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 3)
      .forEach((c) => marcos.push({ ic: '🏆', t: `${c.campeao} sagrou-se campeã`, d: c.nome || 'Campeonato' }));
    teams.slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 3)
      .forEach((t) => marcos.push({ ic: '🛡', t: `Nova equipa: ${t.nome}`, d: (t.created_at || '').slice(0, 10) }));
    if (users.length >= 10) {
      const marco = Math.floor(users.length / 10) * 10;
      marcos.push({ ic: '🎉', t: `${marco}+ utilizadores`, d: `total atual: ${users.length}` });
    }

    res.json({
      pulso: { users_hoje: usersHoje, jogos_hoje: jogosHoje, denuncias_abertas: denunciasAbertas, mrr: null },
      crescimento,
      vida,
      marcos,
      receita_disponivel: false, // Stripe sem MRR real → "em breve" digno
      publicidade_disponivel: false, // medição de ads (impressão/clique) ainda não existe
    });
  })
);

/** GET /api/super/gabinete/operacao — custos/registos/cobertura/campanhas/toggles (store). */
router.get(
  '/api/super/gabinete/operacao',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    res.json(await gabineteStore.ler());
  })
);

/** PUT /api/super/gabinete/operacao — grava os dados editáveis à mão do dono. */
router.put(
  '/api/super/gabinete/operacao',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    if (!req.body || typeof req.body !== 'object') throw new HttpError(400, 'Dados inválidos.');
    res.json(await gabineteStore.gravar(req.body));
  })
);

/** GET /api/super/gabinete/publicidade — campanhas + métricas (imp/cli/CTR/dias) + alertas. */
router.get(
  '/api/super/gabinete/publicidade',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const store = await gabineteStore.ler();
    // As impressões vivem num acumulador em memória que só desce ao Storage de
    // 30 em 30 s (Velocidade 6A). Aqui o dono quer o número certo AGORA, por
    // isso força o flush antes de ler — é uma tela de dono, não um caminho quente.
    await adsStore.descarregar();
    const metricas = await adsStore.ler();
    const hoje = inicioDiaUTC(new Date()).toISOString().slice(0, 10);
    const campanhas = (store.campanhas || []).map((c) => {
      const t = adsStore.totais(metricas, c.id);
      const ctr = t.imp ? Number((t.cli / t.imp * 100).toFixed(1)) : 0;
      const diasRestantes = c.fim ? Math.max(0, Math.round((new Date(c.fim) - new Date(hoje)) / DIA)) : null;
      return { ...c, imp: t.imp, cli: t.cli, ctr, dias_restantes: diasRestantes };
    });
    const alertas = [];
    campanhas.forEach((c) => {
      if (c.estado === 'ativa' && c.dias_restantes != null && c.dias_restantes < 7) alertas.push(`"${c.nome}" expira em ${c.dias_restantes}d`);
      if (c.estado === 'ativa' && c.imp > 0 && c.cli === 0) alertas.push(`"${c.nome}" sem cliques`);
    });
    res.json({ campanhas, toggles: store.toggles || {}, alertas });
  })
);

// Lê uma chave de app_config (JSON em texto). Fail-soft: tabela pode não
// existir ainda em ambientes antigos, ou a chave nunca ter sido gravada.
async function lerAppConfig(chave) {
  try {
    const { data } = await supabase.from('app_config').select('valor').eq('chave', chave).maybeSingle();
    if (!data?.valor) return null;
    try { return JSON.parse(data.valor); } catch { return null; }
  } catch {
    return null;
  }
}

// Soma geracoes/custo_cents de gasto_ia_diario entre duas datas ISO (inclusive).
async function somaGastoIA(desdeISO, ateISO) {
  try {
    const { data } = await supabase.from('gasto_ia_diario').select('geracoes, custo_cents').gte('dia', desdeISO).lte('dia', ateISO);
    return (data || []).reduce((acc, l) => ({ qtd: acc.qtd + (l.geracoes || 0), custo_cents: acc.custo_cents + (l.custo_cents || 0) }), { qtd: 0, custo_cents: 0 });
  } catch {
    return { qtd: 0, custo_cents: 0 };
  }
}

/**
 * GET /api/super/gabinete/resumo — payload único para as 5 abas do Gabinete 2.0
 * (SPEC em PAINEL-E-CUSTOS.md secção 6). Cobre Visão geral, Dinheiro, Segurança
 * e Registros & prazos. A aba Pessoas & times NÃO vem aqui — continua a usar
 * /api/super/users, /api/super/teams e /api/super/denuncias/fila (paginação e
 * ações próprias; empacotar isso num payload só faria a página recarregar tudo
 * a cada suspensão/decisão).
 */
router.get(
  '/api/super/gabinete/resumo',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const agora = new Date();
    const hoje = inicioDiaUTC(agora);
    const hojeISO = hoje.toISOString();
    const seteDiasISO = new Date(hoje.getTime() - 7 * DIA).toISOString();
    const hojeDia = hojeISO.slice(0, 10);
    const primeiroDiaMes = `${hojeDia.slice(0, 7)}-01`;

    const [usersRes, gamesRes, teamsRes, gastoHoje, gastoMes, iaFreeze, ultimoBackup, op] = await Promise.all([
      supabase.from('users').select('created_at'),
      supabase.from('games').select('created_at').gte('created_at', seteDiasISO),
      supabase.from('teams').select('id'),
      somaGastoIA(hojeDia, hojeDia),
      somaGastoIA(primeiroDiaMes, hojeDia),
      lerAppConfig('ia_freeze'),
      lerAppConfig('ultimo_backup'),
      gabineteStore.ler(),
    ]);
    const users = usersRes.data || [];
    const teams = teamsRes.data || [];

    // Denúncias abertas — mesmo agregado do /api/super/gabinete (zero conteúdo).
    let denunciasAbertas = 0;
    try {
      const ids = teams.map((t) => t.id); ids.push('_sem');
      const listas = await Promise.all(ids.map((t) => denunciaStore.listarEquipa(t)));
      denunciasAbertas = listas.flat().filter((c) => !c.resolvido_em).length;
    } catch { denunciasAbertas = 0; }

    // Banco trancado — chama a função da migração 050. Se ainda não existir
    // (PGRST202/undefined function), devolve "a_confirmar" em vez de arriscar
    // um verde/vermelho errado.
    let bancoTrancado = { estado: 'a_confirmar', tabelas_sem_rls: null, policies_users: null };
    try {
      const { data, error } = await supabase.rpc('gabinete_rls_status');
      if (!error && data) {
        const semRls = data.tabelas_sem_rls || [];
        const okPolicies = (data.policies_users || 0) === 0;
        bancoTrancado = {
          estado: semRls.length === 0 && okPolicies ? 'verde' : 'vermelho',
          tabelas_sem_rls: semRls,
          policies_users: data.policies_users ?? 0,
        };
      }
    } catch { /* função ainda não existe — fica "a_confirmar" */ }

    const custosVencidos = (op.custos_fixos || []).filter((c) => !c.pago && c.proxima_data && c.proxima_data < hojeDia);

    const precisaDeVoce = [];
    if (denunciasAbertas > 0) precisaDeVoce.push({ tipo: 'denuncia', texto: `${denunciasAbertas} denúncia${denunciasAbertas > 1 ? 's' : ''} aberta${denunciasAbertas > 1 ? 's' : ''} para revisar` });
    if (custosVencidos.length) precisaDeVoce.push({ tipo: 'custo', texto: `${custosVencidos.length} custo${custosVencidos.length > 1 ? 's' : ''} fixo${custosVencidos.length > 1 ? 's' : ''} com data vencida` });
    if (iaFreeze) precisaDeVoce.push({ tipo: 'freeze', texto: `IA travada sozinha: ${iaFreeze.motivo || 'atividade suspeita'}` });

    res.json({
      visao_geral: {
        usuarios_novos_hoje: users.filter((u) => u.created_at >= hojeISO).length,
        usuarios_novos_7d: users.filter((u) => u.created_at >= seteDiasISO).length,
        jogos_criados_7d: (gamesRes.data || []).length,
        figurinhas_hoje: { qtd: gastoHoje.qtd, custo_usd: Number((gastoHoje.custo_cents / 100).toFixed(2)) },
        figurinhas_mes: { qtd: gastoMes.qtd, custo_usd: Number((gastoMes.custo_cents / 100).toFixed(2)) },
        denuncias_abertas: denunciasAbertas,
        ia: { freeze: !!iaFreeze, motivo: iaFreeze?.motivo || null },
        servidor: { versao: pkg.version, uptime_s: Math.round(process.uptime()) },
      },
      precisa_de_voce: precisaDeVoce,
      dinheiro: {
        custos_fixos: op.custos_fixos || [],
        cambio_usd_eur: op.cambio_usd_eur ?? gabineteStore.SEED.cambio_usd_eur,
        ia_mes: {
          gasto_usd: Number((gastoMes.custo_cents / 100).toFixed(2)),
          teto_diario_usd: Number((TETO_DIARIO_CENTS / 100).toFixed(2)),
          gasto_hoje_usd: Number((gastoHoje.custo_cents / 100).toFixed(2)),
          // Custo REAL do período (o que a fal cobrou ÷ o que se gerou), não uma
          // constante. Sem gerações no mês, mostra 0 — não inventa média.
          custo_por_geracao_usd: gastoMes.qtd ? Number((gastoMes.custo_cents / gastoMes.qtd / 100).toFixed(4)) : 0,
          custo_por_geracao_etiqueta: 'custo real (fal)',
          freeze: !!iaFreeze,
        },
      },
      seguranca: {
        banco_trancado: bancoTrancado,
        ultimo_backup: ultimoBackup,
        proximo_backup: 'segunda-feira 09:00',
        rate_limit: RATE_LIMITS_ATIVOS,
        kill_switch_ia: { freeze: !!iaFreeze, motivo: iaFreeze?.motivo || null, desde: iaFreeze?.desde || null },
        manual: op.seguranca_manual || gabineteStore.SEED.seguranca_manual,
      },
      registros: op.registros || [],
    });
  })
);

// ═══════════════════════════════════════════════════════════════════════════
// FIGURINHAS BRILHANTES (SPEC-FIGURINHA-3 §7 — bloco 2, 22-set)
//
// Enquanto a compra na loja não existe, é AQUI que o pedido vira produto: a
// pessoa toca em "Pedir ativação" (Planos/Figurinha), o pedido cai em
// `pedidos_ativacao`, e o dono ativa à mão nesta aba.
//
// Ativar o pacote NÃO gera nada em lote (§5, geração preguiçosa): cada membro
// gera quando abre o app. É o que impede um time de 25 custar US$2,80 na hora
// da ativação com metade das pessoas a nunca abrir o Futty outra vez.
//
// Depende da migração 054 (tudo) e da 055 (só o motivo da recusa). Sem a 054
// estas rotas dizem `indisponivel: true` em vez de listas vazias — uma lista
// vazia afirmaria "não há pedidos", que é uma mentira diferente de "ainda não
// dá para saber".
// ═══════════════════════════════════════════════════════════════════════════

const KITS_DISPONIVEIS = Object.entries(KITS_IA || {}).filter(([, k]) => k?.ativo).map(([id]) => id);
const PRODUTO_LABEL = { pacote: 'Pacote do time', manto: 'Manto próprio', minha: 'Minha Brilhante' };

/** Mapa id → linha, para juntar pedidos a pessoas/times sem embeds do PostgREST. */
function porId(linhas) {
  return Object.fromEntries((linhas || []).map((l) => [l.id, l]));
}

/** Resolve pedidos pendentes (estado 'ativado'). Best-effort: nunca derruba a ativação. */
async function resolverPedidos(filtro) {
  try {
    let q = supabase.from('pedidos_ativacao').update({ estado: 'ativado', resolvido_em: new Date().toISOString() }).eq('estado', 'pendente');
    for (const [col, val] of Object.entries(filtro)) q = q.eq(col, val);
    const { error } = await q;
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn('[gabinete/brilhantes] pedidos não resolvidos:', e.message);
  }
}

/**
 * GET /api/super/gabinete/brilhantes — as três listas da aba:
 * pedidos pendentes (com quem pediu e de que time), times com pacote ou com
 * pedido (uso e custo real somado de `brilhantes_time`), e pessoas com crédito.
 */
router.get(
  '/api/super/gabinete/brilhantes',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    try {
      const { data: pedidosRaw, error: erroPedidos } = await supabase
        .from('pedidos_ativacao')
        .select('id, team_id, user_id, produto, estado, criado_em')
        .eq('estado', 'pendente')
        .order('criado_em', { ascending: true }); // é uma FILA: o mais velho primeiro
      if (erroPedidos) throw new Error(erroPedidos.message);
      const pedidosPendentes = pedidosRaw || [];

      const COLS_TIME = 'id, nome, slug, brilhante_ativo, brilhante_kit, brilhante_ativado_em, brilhante_limite, manto_proprio';
      const { data: ativos, error: erroAtivos } = await supabase.from('teams').select(COLS_TIME).eq('brilhante_ativo', true);
      if (erroAtivos) throw new Error(erroAtivos.message);

      // Os times que ainda não têm pacote mas têm pedido em cima da mesa —
      // sem eles o dono via o pedido sem saber de que time está a falar.
      const jaListados = new Set((ativos || []).map((t) => t.id));
      const idsPorPedido = [...new Set(pedidosPendentes.map((p) => p.team_id).filter((id) => id && !jaListados.has(id)))];
      let comPedido = [];
      if (idsPorPedido.length) {
        const { data } = await supabase.from('teams').select(COLS_TIME).in('id', idsPorPedido);
        comPedido = data || [];
      }
      const timesTodos = [...(ativos || []), ...comPedido];
      const idsTimes = timesTodos.map((t) => t.id);

      // Uso e custo REAL por time (a mesma verdade do gasto_ia_diario: o que a
      // fal cobrou, gravado por geração). `sem_custo` conta as linhas antigas
      // sem custo gravado, para o total não se fazer passar por completo.
      const uso = {};
      const membros = {};
      if (idsTimes.length) {
        const [{ data: linhas }, { data: equipas }] = await Promise.all([
          supabase.from('brilhantes_time').select('team_id, custo_cents').in('team_id', idsTimes),
          supabase.from('team_members').select('team_id, user_id').in('team_id', idsTimes),
        ]);
        for (const l of linhas || []) {
          const u = uso[l.team_id] || (uso[l.team_id] = { geradas: 0, custo_cents: 0, sem_custo: 0 });
          u.geradas += 1;
          if (l.custo_cents == null) u.sem_custo += 1;
          else u.custo_cents += Number(l.custo_cents) || 0;
        }
        for (const m of equipas || []) membros[m.team_id] = (membros[m.team_id] || 0) + 1;
      }

      // Quem pediu (nome/e-mail) — lookup direto, sem embed: o Gabinete já lê
      // assim nas outras abas e um embed errado devolve lista vazia em silêncio.
      const idsPessoas = [...new Set(pedidosPendentes.map((p) => p.user_id).filter(Boolean))];
      let donos = {};
      if (idsPessoas.length) {
        const { data } = await supabase.from('users').select('id, nome_jogador, email').in('id', idsPessoas);
        donos = porId(data);
      }
      const timesPorId = porId(timesTodos);

      const { data: comCredito, error: erroCredito } = await supabase
        .from('users')
        .select('id, nome_jogador, email, brilhante_creditos, presente_criador_em')
        .gt('brilhante_creditos', 0)
        .order('brilhante_creditos', { ascending: false });
      if (erroCredito) throw new Error(erroCredito.message);

      res.json({
        indisponivel: false,
        kits: KITS_DISPONIVEIS,
        pedidos: pedidosPendentes.map((p) => ({
          id: p.id,
          produto: p.produto,
          produto_label: PRODUTO_LABEL[p.produto] || p.produto,
          // O manto é fase 2 (§8): aparece na fila com etiqueta e SEM botão de
          // ativar. Nada que finja funcionar — regra da casa.
          fase2: p.produto === 'manto',
          estado: p.estado,
          criado_em: p.criado_em,
          user_id: p.user_id,
          nome: donos[p.user_id]?.nome_jogador || null,
          email: donos[p.user_id]?.email || null,
          team_id: p.team_id,
          time: timesPorId[p.team_id]?.nome || null,
          time_slug: timesPorId[p.team_id]?.slug || null,
        })),
        times: timesTodos.map((t) => {
          const u = uso[t.id] || { geradas: 0, custo_cents: 0, sem_custo: 0 };
          return {
            id: t.id,
            nome: t.nome,
            slug: t.slug,
            brilhante_ativo: !!t.brilhante_ativo,
            brilhante_kit: t.brilhante_kit || null,
            brilhante_ativado_em: t.brilhante_ativado_em || null,
            limite: Number(t.brilhante_limite) || 25,
            manto_proprio: !!t.manto_proprio,
            membros: membros[t.id] || 0,
            geradas: u.geradas,
            custo_usd: Number((u.custo_cents / 100).toFixed(2)),
            geradas_sem_custo: u.sem_custo,
            tem_pedido: pedidosPendentes.some((p) => p.team_id === t.id),
          };
        }),
        pessoas: (comCredito || []).map((u) => ({
          id: u.id,
          nome: u.nome_jogador || null,
          email: u.email,
          creditos: Number(u.brilhante_creditos) || 0,
          presente_criador_em: u.presente_criador_em || null,
        })),
      });
    } catch (e) {
      if (!ehMigracaoEmFalta(e.message)) throw e;
      console.warn('[gabinete/brilhantes] migração 054 em falta:', e.message);
      res.json({ indisponivel: true, motivo: 'A migração 054 ainda não foi corrida no Supabase.', kits: KITS_DISPONIVEIS, pedidos: [], times: [], pessoas: [] });
    }
  }),
);

/**
 * POST /api/super/gabinete/brilhantes/ativar-pacote { teamId, kitId } — liga o
 * pacote do time no uniforme escolhido, resolve os pedidos 'pacote' pendentes
 * desse time e avisa os membros. Ninguém é gerado aqui (geração preguiçosa).
 */
router.post(
  '/api/super/gabinete/brilhantes/ativar-pacote',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const teamId = String(req.body?.teamId || '');
    const kitId = String(req.body?.kitId || '');
    if (!teamId) throw new HttpError(400, 'Escolha o time.');
    if (!KITS_DISPONIVEIS.includes(kitId)) throw new HttpError(400, `Uniforme inválido. Um de: ${KITS_DISPONIVEIS.join(', ')}.`);

    try {
      const { data: time, error: erroLer } = await supabase.from('teams').select('id, nome, slug, brilhante_ativo').eq('id', teamId).maybeSingle();
      if (erroLer) throw new Error(erroLer.message);
      if (!time) throw new HttpError(404, 'Time não encontrado.');

      const { error } = await supabase
        .from('teams')
        .update({ brilhante_ativo: true, brilhante_kit: kitId, brilhante_ativado_em: new Date().toISOString() })
        .eq('id', teamId);
      if (error) throw new Error(error.message);

      await resolverPedidos({ team_id: teamId, produto: 'pacote' });

      // Aviso aos membros: o cartão dourado já está lá quando abrirem, mas é o
      // push que os faz abrir. Fire-and-forget — nunca derruba a ativação.
      const { data: membros } = await supabase.from('team_members').select('user_id').eq('team_id', teamId);
      const ids = (membros || []).map((m) => m.user_id).filter(Boolean);
      enviarNotificacao(ids, {
        title: 'Sua Figurinha Brilhante foi liberada ✨',
        body: `O ${time.nome} ativou as Brilhantes. Abra e gere a sua.`,
        url: '/figurinha',
      });

      console.log('[gabinete/brilhantes] pacote ativado', { teamId, kitId, membros: ids.length });
      res.json({ ok: true, team_id: teamId, kit_id: kitId, membros_avisados: ids.length });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (ehMigracaoEmFalta(e.message)) throw new HttpError(503, 'A migração 054 ainda não foi corrida no Supabase.', 'MIGRACAO_EM_FALTA');
      throw new HttpError(500, e.message);
    }
  }),
);

/**
 * POST /api/super/gabinete/brilhantes/creditos { userId, quantidade } — soma
 * créditos à pessoa (a "Minha Brilhante" dá 2), resolve o pedido 'minha'
 * pendente dela e avisa.
 */
router.post(
  '/api/super/gabinete/brilhantes/creditos',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const userId = String(req.body?.userId || '');
    const quantidade = Number(req.body?.quantidade);
    if (!userId) throw new HttpError(400, 'Escolha a pessoa.');
    if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 25) {
      throw new HttpError(400, 'Quantidade tem de ser um número inteiro de 1 a 25.');
    }

    try {
      const { data: pessoa, error: erroLer } = await supabase
        .from('users').select('id, email, nome_jogador, brilhante_creditos').eq('id', userId).maybeSingle();
      if (erroLer) throw new Error(erroLer.message);
      if (!pessoa) throw new HttpError(404, 'Pessoa não encontrada.');

      // Soma lida-e-escrita, como o debitar(): o PostgREST não faz `x = x + n`
      // sem uma função no banco, e duas mãos de dono na mesma conta ao mesmo
      // segundo não é um cenário real.
      const novo = (Number(pessoa.brilhante_creditos) || 0) + quantidade;
      const { error } = await supabase.from('users').update({ brilhante_creditos: novo }).eq('id', userId);
      if (error) throw new Error(error.message);

      await resolverPedidos({ user_id: userId, produto: 'minha' });

      enviarNotificacao([userId], {
        title: 'Sua Figurinha Brilhante foi liberada ✨',
        body: novo === 1 ? 'Você tem 1 geração. Abra e faça a sua.' : `Você tem ${novo} gerações. Abra e faça a sua.`,
        url: '/figurinha',
      });

      console.log('[gabinete/brilhantes] créditos dados', { userId, quantidade, total: novo });
      res.json({ ok: true, user_id: userId, creditos: novo });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (ehMigracaoEmFalta(e.message)) throw new HttpError(503, 'A migração 054 ainda não foi corrida no Supabase.', 'MIGRACAO_EM_FALTA');
      throw new HttpError(500, e.message);
    }
  }),
);

/**
 * POST /api/super/gabinete/brilhantes/recusar { pedidoId, motivo } — fecha o
 * pedido com o motivo, que volta para a tela de quem pediu. Sem a migração 055
 * o estado é gravado na mesma e a resposta diz que o motivo não ficou
 * (`motivo_guardado: false`) — o Gabinete mostra isso em vez de fingir.
 */
router.post(
  '/api/super/gabinete/brilhantes/recusar',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const pedidoId = String(req.body?.pedidoId || '');
    const motivo = String(req.body?.motivo || '').trim().slice(0, 280);
    if (!pedidoId) throw new HttpError(400, 'Pedido em falta.');
    if (!motivo) throw new HttpError(400, 'Escreva o motivo — quem pediu vai ler isto.');

    const base = { estado: 'recusado', resolvido_em: new Date().toISOString() };
    try {
      const { data, error } = await supabase
        .from('pedidos_ativacao').update({ ...base, motivo }).eq('id', pedidoId).select('id, user_id, produto').maybeSingle();
      if (error) throw Object.assign(new Error(error.message), { semColuna: /motivo/i.test(error.message) });
      if (!data) throw new HttpError(404, 'Pedido não encontrado.');
      console.log('[gabinete/brilhantes] pedido recusado', { pedidoId });
      return res.json({ ok: true, pedido_id: pedidoId, motivo_guardado: true });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      // A 055 (coluna `motivo`) ainda não foi corrida: recusa na mesma — deixar
      // o pedido eternamente pendente seria pior do que perder o texto — e diz
      // a verdade a quem chamou.
      if (e.semColuna) {
        const { data, error } = await supabase
          .from('pedidos_ativacao').update(base).eq('id', pedidoId).select('id').maybeSingle();
        if (error) throw new HttpError(500, error.message);
        if (!data) throw new HttpError(404, 'Pedido não encontrado.');
        console.warn('[gabinete/brilhantes] recusado SEM motivo (migração 055 em falta)', { pedidoId });
        return res.json({ ok: true, pedido_id: pedidoId, motivo_guardado: false });
      }
      if (ehMigracaoEmFalta(e.message)) throw new HttpError(503, 'A migração 054 ainda não foi corrida no Supabase.', 'MIGRACAO_EM_FALTA');
      throw new HttpError(500, e.message);
    }
  }),
);

module.exports = router;
