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

const router = express.Router();

const DIA = 86400000;
const inicioDiaUTC = (d) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x; };

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

module.exports = router;
