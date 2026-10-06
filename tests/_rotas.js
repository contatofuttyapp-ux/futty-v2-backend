// Futty v2.0 — o cenário comum dos testes de ROTA sem banco e sem rede (Rodada 29B, E): um Supabase falso em memória e
// um `utils/db` falso por baixo, injetados no cache de módulos ANTES de a rota ser carregada (o mesmo truque de
// tests/convite-rota.test.js), e um express para fazer os pedidos de verdade. O que cada teste varia são as tabelas.
//
// Importante: os módulos que guardam o `supabase` na hora do require (utils/soOrganiza, services/inicio, utils/agregados,
// utils/direitoBrilhante…) são recarregados com o falso por baixo e soltos no fim — sem isso o primeiro teste do processo
// prendia o seu banco nos seguintes.
const path = require('node:path');
const express = require('express');
const { criarSupabaseFalso } = require('./_supabaseFalso');
const { HttpError } = require('../utils/http');

const RECARREGAR = [
  'utils/soOrganiza', 'utils/agregados', 'utils/direitoBrilhante', 'services/inicio', 'utils/cidade',
  'routes/rsvp', 'routes/games', 'routes/ranking', 'routes/teams', 'routes/brilhantes',
  'utils/geracaoJobs', 'routes/figurinhaJob', 'routes/auth', 'routes/inicio', 'routes/feed', 'utils/blocksStore',
  'routes/superadmin', 'utils/resenhaCota', 'utils/plataformaStore', // Rodada 29Y: guardam o supabase no require, como os de cima
];
const caminho = (m) => require.resolve(`../${m}`);

function injetar(modulo, exports) {
  const c = caminho(modulo);
  const antigo = require.cache[c];
  require.cache[c] = { id: c, filename: c, loaded: true, path: path.dirname(c), children: [], paths: [], exports };
  return () => { if (antigo) require.cache[c] = antigo; else delete require.cache[c]; };
}

/** O utils/db falso, em cima do Supabase falso: só o que as rotas e serviços de equipa leem. */
function dbFalso(cliente) {
  const umaLinha = async (tabela, filtro, colunas = '*') => {
    let q = cliente.from(tabela).select(colunas);
    for (const [k, v] of Object.entries(filtro)) q = q.eq(k, v);
    const { data } = await q.maybeSingle();
    return data || null;
  };
  const getRole = async (teamId, userId) => (await umaLinha('team_members', { team_id: teamId, user_id: userId }))?.role || null;
  // `colunas` chega ao falso (e.cols): um teste pode simular "esta coluna não existe" numa leitura (migração por aplicar).
  const getTeamBySlug = async (slug, colunas) => umaLinha('teams', { slug }, colunas || '*');
  return {
    supabase: cliente,
    getRole,
    getTeamBySlug,
    getUserById: async (id) => umaLinha('users', { id }),
    ensureUserRow: async () => {},
    requireTeamMember: async (slug, userId) => {
      const team = await getTeamBySlug(slug);
      if (!team) throw new HttpError(404, 'Time não encontrado.');
      const role = await getRole(team.id, userId);
      if (!role) throw new HttpError(403, 'Você não é membro deste time.');
      return { team, role };
    },
    loadGame: async (id) => {
      const game = await umaLinha('games', { id });
      if (!game) return null;
      // Com o time embutido na linha do jogo (como o PostgREST devolve o embed) é UMA ida; sem ele, a segunda consulta.
      return { ...game, teams: game.teams || await umaLinha('teams', { id: game.team_id }) };
    },
    goleirosDoTime: async (teamId, ids) => {
      const { data } = await cliente.from('team_members').select('user_id').eq('team_id', teamId).eq('categoria', 'GR');
      const gr = new Set((data || []).map((m) => m.user_id));
      return new Set((ids || []).filter((id) => gr.has(id)));
    },
    computeRatings: async () => ({}),
  };
}

/**
 * Carrega os módulos pedidos com o banco falso por baixo.
 * @param {object} tabelas  linhas iniciais por tabela (ver criarSupabaseFalso)
 * @param {string[]} modulos  caminhos relativos à raiz do backend, ex.: ['routes/rsvp']
 * @returns {{ carregados: object, cliente: object, tabelas: object }}
 */
function carregar(tabelas, modulos, opcoes = {}) {
  const { cliente, tabelas: vivas } = criarSupabaseFalso(tabelas, opcoes);
  const passaAdiante = (_req, _res, next) => next();
  const exigirLogin = (req, _res, next) => {
    const quem = req.get('x-teste-usuario');
    if (!quem) return next(new HttpError(401, 'Sem sessão.'));
    req.user = { id: quem, email: `${quem}@futtymock.com`, email_confirmed_at: '2026-01-01T00:00:00Z', app_metadata: {} };
    return next();
  };
  const notificacoes = [];
  const restaurar = [
    injetar('utils/db', dbFalso(cliente)),
    // `requireSuperAdmin` (Rodada 29Y): o gate de super-admin não é o que estes testes provam; quem chega logado passa.
    injetar('middleware/auth', { requireAuth: exigirLogin, requireSuperAdmin: exigirLogin, optionalAuth: passaAdiante, invalidarSessaoDoPedido: () => {} }),
    // `opcoes.push(ids, payload)` troca o gravador padrão (um teste que quer um push que falha, por exemplo).
    injetar('routes/push', { enviarNotificacao: opcoes.push || ((ids, payload) => { notificacoes.push({ ids, payload }); }) }),
    injetar('utils/nsfwFilter', { filtroNSFWFailClosed: passaAdiante, filtroNSFW: passaAdiante }),
  ];
  const limpar = () => { for (const m of RECARREGAR) delete require.cache[caminho(m)]; };
  limpar();
  const carregados = {};
  for (const m of modulos) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    carregados[m] = require(`../${m}`);
  }
  limpar();
  for (const r of restaurar.reverse()) r();
  return { carregados, cliente, tabelas: vivas, notificacoes };
}

/** Sobe um express com os routers e devolve um `pedir(metodo, rota, corpo, usuario)`. */
function subir(routers, t) {
  const app = express();
  app.use(express.json());
  for (const r of routers) app.use(r);
  // Igual ao server.js: o código de um HttpError vai no corpo (é por ele que o app escolhe a mensagem).
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) }));
  const servidor = app.listen(0);
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;
  return async (metodo, rota, corpo, usuario = null, cabecalhos = {}) => {
    const r = await fetch(`${base}${rota}`, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...(usuario ? { 'x-teste-usuario': usuario } : {}), ...cabecalhos },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
}

module.exports = { carregar, subir, dbFalso, injetar };
