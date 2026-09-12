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
const pkg = require('../package.json');

const router = express.Router();

const DIA = 86400000;
const inicioDiaUTC = (d) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x; };

// Custo por geração de figurinha IA — mesma constante de utils/antiAbusoIA.js
// (não importada de lá para não puxar routes/push.js, que essa dependência
// arrasta consigo — o resumo é só leitura).
const CUSTO_GERACAO_CENTS = 1.7;
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
      supabase.from('campeonatos').select('nome, estado, campeao, created_at'),
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
      camp: cumulativoSemanal(camps.map((c) => c.created_at)),
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
          custo_por_geracao_usd: CUSTO_GERACAO_CENTS / 100,
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

module.exports = router;
