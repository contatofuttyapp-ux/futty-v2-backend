// Futty v2.0 — o app DE VERDADE (server.js: CORS, helmet, limiters, JSON de 2 MB, login, todas as rotas, tratador de erros) por cima
// de um banco, um Storage e um Auth de MENTIRA, em memória. É o que deixa pentestar as rotas — inclusive as que escrevem — sem tocar no
// Supabase: o .env deste repo aponta para o único banco, o de produção (ver tests/_ajudaBanco.js), então este módulo
//   · nunca lê o .env (o dotenv vira no-op) e põe segredos de mentira no lugar;
//   · fecha toda saída de rede que não seja para 127.0.0.1 (fetch, http, https) e guarda cada tentativa em `tentativasDeRede`;
//   · só escuta em 127.0.0.1, nunca na rede da casa.
//
// Importante: este arquivo precisa ser o PRIMEIRO require do teste (antes de qualquer módulo do motor), senão o dotenv real já terá lido o .env.
//
// Uso:
//   const { subirApp, usuario } = require('./_appFalsa');
//   const app = await subirApp(t, { tabelas: { teams: [...], users: [...] }, usuarios: [usuario('U1', 'Pedro')] });
//   const r = await app.pedir('POST', '/api/games', { token: app.token('U1'), corpo: { ... } });
const Module = require('node:module');
const http = require('node:http');
const https = require('node:https');
const { criarSupabaseFalso } = require('./_supabaseFalso');

// ─── 1. O .env de verdade nunca entra ──────────────────────────────────────────────────────────────────────────────────────────
const dotenvReal = require.resolve('dotenv');
Module._cache[dotenvReal] = { id: dotenvReal, filename: dotenvReal, loaded: true, exports: { config: () => ({ parsed: {} }), parse: () => ({}) } };

const SEGREDO_DO_WEBHOOK = 'segredo-do-webhook-de-mentira';
const SEGREDO_DA_MIDIA = 'segredo-da-midia-de-mentira';
const URL_DO_BANCO = 'https://projeto-falso.supabase.test';

function prepararAmbiente({ producao = false } = {}) {
  for (const k of ['SENTRY_DSN', 'STRIPE_SECRET_KEY', 'RC_API_KEY', 'RC_ACEITAR_SANDBOX', 'ANTHROPIC_API_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT',
    'CLOUD_TASKS_QUEUE', 'URL_DO_SERVICO', 'INTERNO_SEGREDO', 'CLOUD_TASKS_SA_EMAIL', 'PAGAMENTOS_ATIVOS', 'CORS_ORIGINS', 'SUPABASE_SECRET_KEY',
    'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY', 'TETO_DIARIO_CENTS', 'FEED_COTA_BYTES_POR_TIME']) delete process.env[k];
  Object.assign(process.env, {
    NODE_ENV: producao ? 'production' : 'test',
    SUPABASE_URL: URL_DO_BANCO,
    SUPABASE_SERVICE_KEY: 'chave-secreta-de-mentira',
    MEDIA_TOKEN_SECRET: SEGREDO_DA_MIDIA,
    RC_WEBHOOK_SECRET: SEGREDO_DO_WEBHOOK,
    FAL_KEY: 'fal-de-mentira', // a rota de IA só precisa disto para chegar ao teste do direito; a rede está fechada
  });
}

// ─── 2. Rede fechada ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const tentativasDeRede = [];
const ehLocal = (host) => /^(127\.0\.0\.1|localhost|\[?::1\]?)$/i.test(String(host || ''));
const destinoDe = (args) => {
  const [a, b] = args;
  try {
    if (typeof a === 'string') return new URL(a).hostname;
    if (a instanceof URL) return a.hostname;
    if (a && typeof a === 'object' && !(typeof Request !== 'undefined' && a instanceof Request)) return a.hostname || (a.host ? String(a.host).split(':')[0] : null) || (b && b.hostname) || '';
    if (typeof Request !== 'undefined' && a instanceof Request) return new URL(a.url).hostname;
  } catch { /* cai no bloqueio */ }
  return '';
};
let redeFechada = false;
function fecharARede() {
  if (redeFechada) return;
  redeFechada = true;
  const fetchReal = globalThis.fetch;
  globalThis.fetch = (...args) => {
    const host = destinoDe(args);
    if (!ehLocal(host)) {
      tentativasDeRede.push(`fetch ${host || String(args[0])}`);
      return Promise.reject(new TypeError('fetch failed (rede fechada pela bancada)'));
    }
    return fetchReal(...args);
  };
  for (const modulo of [http, https]) {
    for (const metodo of ['request', 'get']) {
      const real = modulo[metodo];
      modulo[metodo] = function protegido(...args) {
        const host = destinoDe(args);
        if (!ehLocal(host)) {
          tentativasDeRede.push(`${modulo === https ? 'https' : 'http'} ${host || '?'}`);
          throw new Error('conexão recusada (rede fechada pela bancada)');
        }
        return real.apply(this, args);
      };
    }
  }
}

// ─── 3. Storage de mentira ─────────────────────────────────────────────────────────────────────────────────────────────────────
function criarStorageFalso() {
  const buckets = new Map(); // nome -> { public, arquivos: Map(caminho -> { corpo, tipo, em }) }
  const operacoes = []; // cada pedido ao Storage, na ordem: { op, bucket, caminho } — o teste confere o que o motor PEDIU, não só o que sobrou
  const semBucket = { data: null, error: { message: 'Bucket not found', statusCode: '404' } };
  const paraBuffer = (corpo) => (Buffer.isBuffer(corpo) ? corpo : corpo instanceof Uint8Array ? Buffer.from(corpo) : Buffer.from(String(corpo)));

  const api = {
    buckets,
    operacoes,
    async getBucket(nome) {
      const b = buckets.get(nome);
      return b ? { data: { id: nome, name: nome, public: b.public }, error: null } : semBucket;
    },
    async listBuckets() {
      return { data: [...buckets.entries()].map(([nome, b]) => ({ id: nome, name: nome, public: b.public })), error: null };
    },
    async createBucket(nome, opcoes = {}) {
      if (buckets.has(nome)) return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
      buckets.set(nome, { public: !!opcoes.public, arquivos: new Map() });
      return { data: { name: nome }, error: null };
    },
    async updateBucket(nome, opcoes = {}) {
      const b = buckets.get(nome);
      if (!b) return semBucket;
      if ('public' in opcoes) b.public = !!opcoes.public;
      return { data: { message: 'Successfully updated' }, error: null };
    },
    from(nome) {
      const existe = () => buckets.get(nome);
      return {
        async upload(caminho, corpo, opcoes = {}) {
          operacoes.push({ op: 'upload', bucket: nome, caminho });
          const b = existe();
          if (!b) return semBucket;
          if (b.arquivos.has(caminho) && !opcoes.upsert) return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
          b.arquivos.set(caminho, { corpo: paraBuffer(corpo), tipo: opcoes.contentType || 'application/octet-stream', em: new Date().toISOString() });
          return { data: { path: caminho }, error: null };
        },
        async download(caminho) {
          operacoes.push({ op: 'download', bucket: nome, caminho });
          const b = existe();
          const a = b?.arquivos.get(caminho);
          if (!a) return { data: null, error: { message: 'Object not found', statusCode: '404' } };
          return { data: { type: a.tipo, text: async () => a.corpo.toString('utf8'), arrayBuffer: async () => a.corpo.buffer.slice(a.corpo.byteOffset, a.corpo.byteOffset + a.corpo.byteLength) }, error: null };
        },
        async list(prefixo = '', opcoes = {}) {
          operacoes.push({ op: 'list', bucket: nome, caminho: prefixo });
          const b = existe();
          if (!b) return semBucket;
          const base = prefixo ? `${prefixo.replace(/\/+$/, '')}/` : '';
          const nomes = new Map();
          for (const [caminho, a] of b.arquivos) {
            if (!caminho.startsWith(base)) continue;
            const resto = caminho.slice(base.length);
            if (opcoes.search && !caminho.includes(opcoes.search)) continue;
            // Como o Supabase: uma "pasta" (o que vem antes da próxima barra) não tem id nem metadata; só o arquivo tem. O diagnóstico e outros
            // listam as pastas por esse id nulo.
            const primeiro = resto.split('/')[0];
            const ehPasta = resto.includes('/');
            nomes.set(primeiro, ehPasta
              ? { name: primeiro, id: null, updated_at: null, created_at: null, last_accessed_at: null, metadata: null }
              : { name: primeiro, id: caminho, updated_at: a.em, created_at: a.em, metadata: { size: a.corpo.length, mimetype: a.tipo } });
          }
          return { data: [...nomes.values()].slice(0, opcoes.limit || 100), error: null };
        },
        async remove(caminhos) {
          for (const c of caminhos) operacoes.push({ op: 'remove', bucket: nome, caminho: c });
          const b = existe();
          if (!b) return semBucket;
          for (const c of caminhos) b.arquivos.delete(c);
          return { data: caminhos.map((name) => ({ name })), error: null };
        },
        getPublicUrl: (caminho) => ({ data: { publicUrl: `${URL_DO_BANCO}/storage/v1/object/public/${nome}/${caminho}` } }),
        async createSignedUrl(caminho) { return { data: { signedUrl: `${URL_DO_BANCO}/storage/v1/object/sign/${nome}/${caminho}?token=falso` }, error: null }; },
        async createSignedUrls(caminhos) {
          return { data: caminhos.map((p) => ({ path: p, signedUrl: `${URL_DO_BANCO}/storage/v1/object/sign/${nome}/${p}?token=falso`, error: null })), error: null };
        },
      };
    },
  };
  return api;
}

// ─── 4. O cliente do Supabase de mentira: banco + Storage + Auth ───────────────────────────────────────────────────────────────
// Os embeds do PostgREST (`teams ( id, nome )` dentro de um select de games…) que as rotas usam. Muitos-para-um: a linha ganha o objeto.
const RELACOES = {
  games: { teams: { tabela: 'teams', local: 'team_id', remota: 'id' } },
  team_members: { users: { tabela: 'users', local: 'user_id', remota: 'id' }, teams: { tabela: 'teams', local: 'team_id', remota: 'id' } },
  game_players: { users: { tabela: 'users', local: 'user_id', remota: 'id' } },
  comentarios: { users: { tabela: 'users', local: 'author_id', remota: 'id' } },
  feed_posts: { users: { tabela: 'users', local: 'author_id', remota: 'id' } },
  gols_jogadores: { users: { tabela: 'users', local: 'user_id', remota: 'id' } },
  convite_codigos: { convites: { tabela: 'convites', local: 'convite_id', remota: 'id' } },
  team_join_requests: { users: { tabela: 'users', local: 'user_id', remota: 'id' }, teams: { tabela: 'teams', local: 'team_id', remota: 'id' } },
};

function criarClienteFalso(tabelas, opcoes = {}) {
  const { cliente, tabelas: vivas } = criarSupabaseFalso(tabelas, { relacoes: RELACOES, ...(opcoes.falso || {}) });
  const storage = criarStorageFalso();
  const sessoes = new Map(); // token -> user
  const chamadasAdmin = [];
  cliente.storage = storage;
  cliente.auth = {
    async getUser(token) {
      const user = sessoes.get(token);
      return user ? { data: { user }, error: null } : { data: { user: null }, error: { status: 401, name: 'AuthApiError', message: 'invalid JWT' } };
    },
    admin: {
      async deleteUser(id) { chamadasAdmin.push(['deleteUser', id]); return { data: null, error: null }; },
      async updateUserById(id, atributos) { chamadasAdmin.push(['updateUserById', id, atributos]); return { data: { user: { id } }, error: null }; },
    },
  };
  return { cliente, tabelas: vivas, storage, sessoes, chamadasAdmin };
}

// Um JWT que o motor aceita ler (o `exp` está lá longe), mesmo sem assinatura de verdade — quem valida é o getUser falso.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwtDe = (id) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: id, exp: 4102444800 })}.assinatura-de-mentira`; // exp fixo (2100): o mesmo id dá sempre o mesmo token

/** Uma pessoa de mentira: a linha de `users` e o que o Auth devolve para o token dela. */
function usuario(id, nome, extra = {}) {
  return { id, nome: `${nome} da Silva`, nome_jogador: nome, email: `${id}@futtymock.com`, ...extra };
}


// ─── 5. Subir o app ────────────────────────────────────────────────────────────────────────────────────────────────────────────
let appCarregado = false;

/**
 * Sobe o app UMA vez por processo (cada arquivo de teste roda no seu) e devolve a bancada. Entre um teste e outro, `reiniciar()` troca os
 * dados; no fim do arquivo, `after(() => app.fechar())`.
 * @param {object} [o]
 * @param {boolean} [o.producao]  NODE_ENV=production (tetos de produção, sem CORS de dev)
 */
async function subirApp({ producao = false } = {}) {
  if (appCarregado) throw new Error('subirApp: o app só carrega uma vez por processo (cada arquivo de teste roda no seu). Use app.reiniciar() entre os testes.');
  appCarregado = true;
  prepararAmbiente({ producao });
  fecharARede();

  const falso = criarClienteFalso({});

  // O @supabase/supabase-js de mentira: o createClient devolve o falso; o resto do módulo (isAuthRetryableFetchError…) é o de verdade.
  const real = require('@supabase/supabase-js');
  const caminhoSupabase = require.resolve('@supabase/supabase-js');
  Module._cache[caminhoSupabase] = { id: caminhoSupabase, filename: caminhoSupabase, loaded: true, exports: { ...real, createClient: () => falso.cliente } };
  // O NSFWJS (TensorFlow) não carrega: o filtro de imagem explícita é de outro teste.
  const caminhoNsfw = require.resolve('../utils/nsfwFilter');
  const passa = (_req, _res, next) => next();
  Module._cache[caminhoNsfw] = { id: caminhoNsfw, filename: caminhoNsfw, loaded: true, exports: { filtroNSFW: passa, filtroNSFWFailClosed: passa, carregarModelo: async () => {}, classificar: async () => ({}), backendAtivo: () => 'falso', LIMIAR: 0.75, MSG: 'x' } };

  // eslint-disable-next-line global-require
  const { app } = require('../server');
  const servidor = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1');
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });
  const base = `http://127.0.0.1:${servidor.address().port}`;

  /**
   * Troca TODOS os dados: tabelas, Storage, sessões. Os caches do motor (sessão 60 s, Início 30 s…) continuam — por isso cada teste usa
   * ids novos de time e de pessoa, ou apelidos diferentes.
   * @param {object} [o]
   * @param {Record<string, object[]>} [o.tabelas]  linhas iniciais por tabela
   * @param {object[]} [o.usuarios]    pessoas (de `usuario(...)`): viram linhas de `users` e ganham um token
   * @param {string[]} [o.superAdmins] ids dos super-admins (users.is_super_admin = true)
   */
  function reiniciar({ tabelas = {}, usuarios = [], superAdmins = [] } = {}) {
    for (const k of Object.keys(falso.tabelas)) delete falso.tabelas[k];
    const linhasDeUsuarios = usuarios.map((u) => ({ ...u, ...(superAdmins.includes(u.id) ? { is_super_admin: true } : {}) }));
    const dados = { ...tabelas, users: [...(tabelas.users || []), ...linhasDeUsuarios] };
    for (const [nome, linhas] of Object.entries(dados)) falso.tabelas[nome] = linhas.map((l) => ({ ...l }));
    falso.storage.buckets.clear();
    falso.storage.operacoes.length = 0;
    falso.sessoes.clear();
    falso.chamadasAdmin.length = 0;
    for (const u of usuarios) falso.sessoes.set(jwtDe(u.id), { id: u.id, email: u.email, email_confirmed_at: '2026-01-01T00:00:00Z', app_metadata: {}, user_metadata: {} });
  }

  /** Cria os buckets como estão no projeto de verdade (todos privados, menos `ads`). */
  function criarBucketsDoProjeto() {
    for (const nome of ['avatars', 'resenha', 'campeonatos', 'denuncias']) falso.storage.buckets.set(nome, { public: false, arquivos: new Map() });
    falso.storage.buckets.set('ads', { public: true, arquivos: new Map() });
  }

  /**
   * @param {string} metodo
   * @param {string} rota
   * @param {{ token?: string|null, corpo?: any, bruto?: string|Buffer, tipo?: string, cabecalhos?: object, form?: FormData }} [o]
   *   `corpo` vira JSON; `bruto` é o corpo cru (JSON torto); `form` é um multipart.
   */
  async function pedir(metodo, rota, { token = null, corpo, bruto, tipo, cabecalhos = {}, form } = {}) {
    const headers = { ...cabecalhos };
    if (token) headers.authorization = `Bearer ${token}`;
    let body;
    if (form) body = form;
    else if (bruto !== undefined) { body = bruto; headers['content-type'] = tipo || 'application/json'; }
    else if (corpo !== undefined) { body = JSON.stringify(corpo); headers['content-type'] = tipo || 'application/json'; }
    const r = await fetch(`${base}${rota}`, { method: metodo, headers, body, redirect: 'manual' });
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* não era JSON */ }
    return { status: r.status, json, texto, cabecalhos: r.headers };
  }

  reiniciar();
  return {
    base,
    app,
    pedir,
    reiniciar,
    criarBucketsDoProjeto,
    cliente: falso.cliente,
    tabelas: falso.tabelas,
    storage: falso.storage,
    chamadasAdmin: falso.chamadasAdmin,
    tentativasDeRede,
    token: (id) => jwtDe(id),
    /** Abre uma sessão para uma pessoa que não veio em `usuarios` (devolve o token). */
    abrirSessao: (u) => { falso.sessoes.set(jwtDe(u.id), { id: u.id, email: u.email, email_confirmed_at: '2026-01-01T00:00:00Z', app_metadata: {}, user_metadata: {} }); return jwtDe(u.id); },
    fechar: () => new Promise((resolve) => { servidor.closeAllConnections?.(); servidor.close(() => resolve()); }),
  };
}

module.exports = { subirApp, usuario, jwtDe, criarStorageFalso, criarClienteFalso, tentativasDeRede, SEGREDO_DO_WEBHOOK, SEGREDO_DA_MIDIA, URL_DO_BANCO, RELACOES, prepararAmbiente, fecharARede };
