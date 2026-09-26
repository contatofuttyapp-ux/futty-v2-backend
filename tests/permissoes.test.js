// Futty v2.0 — Testes de permissão (SEGURANCA-REVISAO-10SET.md secção 3,
// item 8). node:test puro (builtin do Node, sem dependência nova). Sobe o
// app numa porta livre e confirma:
//   1. sem token       -> 401 em 10 rotas de dados
//   2. token de quem NÃO é membro -> 403 nas 6 rotas sensíveis listadas
//   3. rotas públicas  -> nunca 401 (200 ou 404, conforme o caso)
//
// A conta de teste nasce via SUPABASE_SERVICE_KEY (auth.admin.createUser +
// signInWithPassword com o cliente ANON, para sacar um access_token real —
// o mesmo tipo que requireAuth valida) e morre no fim (after), mesmo que um
// teste falhe a meio.
//
// Uso: npm test  (ou: node --test tests/)
require('dotenv').config();
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@supabase/supabase-js');
const { app, supabase } = require('../server');
const { COM_BANCO, MOTIVO_SKIP } = require('./_ajudaBanco');

const { SUPABASE_URL } = process.env;
const SUPABASE_ANON_KEY = require('../utils/chavesSupabase').chavePublica();

let server;
let baseUrl;
let accessToken;
let testUserId;
let teamSlugReal;
let gameIdReal;

before(async () => {
  if (!COM_BANCO) return;
  if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_PUBLISHABLE_KEY (ou a antiga SUPABASE_ANON_KEY) em falta no .env — precisa dela para assinar sessão de teste.');

  // Sobe o app numa porta livre (server.js só faz o próprio app.listen()
  // quando corrido diretamente — ver require.main === module em server.js).
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Conta de teste descartável. email_confirm:true porque o projeto tem
  // "Confirm email" ligado (SEGURANCA-REVISAO-10SET.md secção 4) — sem isso
  // signInWithPassword recusava por e-mail não confirmado.
  const email = `teste-permissoes-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
  const password = `Fx7!${crypto.randomUUID()}`;
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (createErr) throw createErr;
  testUserId = created.user.id;

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({ email, password });
  if (signInErr) throw signInErr;
  accessToken = signIn.session.access_token;

  // Recursos reais já existentes na base — a conta de teste NUNCA foi membro
  // deles. Precisam existir para os pedidos chegarem ao check de permissão
  // em vez de pararem num 404 (time/jogo não encontrado) antes.
  const { data: umTeam } = await supabase.from('teams').select('slug').limit(1).maybeSingle();
  const { data: umGame } = await supabase.from('games').select('id').limit(1).maybeSingle();
  teamSlugReal = umTeam?.slug;
  gameIdReal = umGame?.id;
  if (!teamSlugReal || !gameIdReal) {
    throw new Error('Precisa de pelo menos 1 time e 1 jogo já existentes na base para estes testes correrem.');
  }
});

after(async () => {
  if (!COM_BANCO) return;
  if (testUserId) await supabase.auth.admin.deleteUser(testUserId).catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
});

function pedir(metodo, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, {
    method: metodo,
    headers,
    body: metodo === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}

// ─── 1. Sem token → 401 em 10 rotas de dados ────────────────────────────────
test('sem token -> 401 em 10 rotas de dados', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const rotas = [
    ['GET', '/api/teams'],
    ['GET', () => `/api/teams/${teamSlugReal}`],
    ['GET', () => `/api/games/${gameIdReal}`],
    ['POST', '/api/games'],
    ['PATCH', () => `/api/games/${gameIdReal}`],
    ['GET', () => `/api/teams/${teamSlugReal}/membros`],
    ['POST', '/api/feed/posts'],
    ['POST', '/api/denuncias'],
    ['POST', '/api/push/subscribe'],
    ['GET', '/api/super/users'],
  ];
  assert.equal(rotas.length, 10);
  for (const [metodo, pathOuFn] of rotas) {
    const path = typeof pathOuFn === 'function' ? pathOuFn() : pathOuFn;
    const res = await pedir(metodo, path);
    assert.equal(res.status, 401, `${metodo} ${path} devia dar 401, deu ${res.status}`);
  }
});

// ─── 2. Token de quem NÃO é membro → 403 nas rotas sensíveis ────────────────
test('token de quem nao e membro -> 403 nas rotas sensiveis', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const casos = [
    ['GET', () => `/api/teams/${teamSlugReal}`],
    ['GET', () => `/api/games/${gameIdReal}`],
    ['GET', () => `/api/teams/${teamSlugReal}/membros`],
    ['PATCH', () => `/api/games/${gameIdReal}`, {}],
    ['POST', '/api/games', () => ({ team_slug: teamSlugReal, data: new Date(Date.now() + 86400000).toISOString(), jogadores_por_time: 5 })],
    ['GET', '/api/super/users'],
  ];
  assert.equal(casos.length, 6);
  for (const [metodo, pathOuFn, bodyOuFn] of casos) {
    const path = typeof pathOuFn === 'function' ? pathOuFn() : pathOuFn;
    const body = typeof bodyOuFn === 'function' ? bodyOuFn() : bodyOuFn;
    const res = await pedir(metodo, path, { token: accessToken, body });
    assert.equal(res.status, 403, `${metodo} ${path} devia dar 403, deu ${res.status}`);
  }
});

// ─── Gabinete 2.0: GET /api/super/gabinete/resumo ───────────────────────────
test('GET /api/super/gabinete/resumo -> 401 sem token, 403 com utilizador comum', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const semToken = await pedir('GET', '/api/super/gabinete/resumo');
  assert.equal(semToken.status, 401, `sem token devia dar 401, deu ${semToken.status}`);

  const comUmComum = await pedir('GET', '/api/super/gabinete/resumo', { token: accessToken });
  assert.equal(comUmComum.status, 403, `com utilizador comum devia dar 403, deu ${comUmComum.status}`);
});

// ─── GET /api/inicio (agregado da tela Início, 11-set) ──────────────────────
test('GET /api/inicio -> 401 sem token', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const semToken = await pedir('GET', '/api/inicio');
  assert.equal(semToken.status, 401, `sem token devia dar 401, deu ${semToken.status}`);
});

// ─── 3. Rotas públicas → nunca 401 ──────────────────────────────────────────
test('rotas publicas -> nunca 401', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const casos = [
    ['GET', '/api/health'],
    ['GET', () => `/api/p/${gameIdReal}`],
    ['GET', '/api/convite/token-que-nao-existe'],
  ];
  for (const [metodo, pathOuFn] of casos) {
    const path = typeof pathOuFn === 'function' ? pathOuFn() : pathOuFn;
    const res = await pedir(metodo, path);
    assert.notEqual(res.status, 401, `${metodo} ${path} nunca devia dar 401, deu ${res.status}`);
    assert.ok([200, 404].includes(res.status), `${metodo} ${path} devia dar 200 ou 404, deu ${res.status}`);
  }
});
