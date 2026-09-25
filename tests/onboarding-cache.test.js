// Futty v2.0 — Teste do loop de onboarding ao pular a foto (VELOCIDADE 5).
//
// Causa: middleware/auth.js cacheia req.user por token (TTL 60s, "Velocidade
// 2"). POST /api/me/onboarding-completo grava user_metadata via admin API mas
// não tocava nesse cache — o GET /api/me seguinte, com o MESMO token, podia
// devolver onboarding_completo:false por até 60s, e o OnboardingGate do
// frontend mandava de volta para /onboarding. Com foto o fluxo demora mais
// que 60s e o cache já tinha expirado sozinho; sem foto ("deixar para
// depois") o loop acontecia sempre.
//
// Mesmo padrão de tests/excluir-conta.test.js: conta de teste descartável via
// SUPABASE_SERVICE_KEY, token real de signInWithPassword (o mesmo tipo que
// requireAuth valida) — não se mocka o Supabase nesta casa, testa-se contra
// ele.
//
// Uso: npm test  (ou: node --test tests/)
require('dotenv').config();
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@supabase/supabase-js');
const { app, supabase } = require('../server');

const { SUPABASE_URL } = process.env;
const SUPABASE_ANON_KEY = require('../utils/chavesSupabase').chavePublica();

let server;
let baseUrl;
let accessToken;
let testUserId;

before(async () => {
  if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_PUBLISHABLE_KEY (ou a antiga SUPABASE_ANON_KEY) em falta no .env — precisa dela para assinar sessão de teste.');

  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const email = `teste-onboarding-cache-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
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
});

after(async () => {
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

test('onboarding-completo com o MESMO token cacheado -> /api/me seguinte já vem true (sem loop)', async () => {
  // 1) GET /api/me primeiro: cacheia req.user (middleware/auth.js) com
  // onboarding_completo ainda ausente — é a mesma condição de quem acabou de
  // logar e caiu direto no /onboarding.
  const antes = await pedir('GET', '/api/me', { token: accessToken });
  assert.equal(antes.status, 200, `GET /api/me inicial devia dar 200, deu ${antes.status}`);
  const corpoAntes = await antes.json();
  assert.equal(corpoAntes.user.onboarding_completo, false, 'antes de concluir, onboarding_completo tem de ser false');

  // 2) POST onboarding-completo — com o MESMO token, dentro da janela de 60s
  // do cache. É o passo que "deixar para depois" atravessa em segundos.
  const post = await pedir('POST', '/api/me/onboarding-completo', { token: accessToken });
  assert.equal(post.status, 200, `POST onboarding-completo devia dar 200, deu ${post.status}`);
  const corpoPost = await post.json();
  assert.deepEqual(corpoPost, { onboarding_completo: true });

  // 3) GET /api/me de novo, mesmo token, sem esperar o TTL: sem a invalidação,
  // isto ainda devolvia false (cache stale) e o OnboardingGate mandava de
  // volta para /onboarding — o loop.
  const depois = await pedir('GET', '/api/me', { token: accessToken });
  assert.equal(depois.status, 200, `GET /api/me final devia dar 200, deu ${depois.status}`);
  const corpoDepois = await depois.json();
  assert.equal(corpoDepois.user.onboarding_completo, true, 'depois de concluir, o MESMO token já tem de ver onboarding_completo:true');
});

test('tour-visto com o MESMO token cacheado -> /api/me seguinte já vem true', async () => {
  const post = await pedir('POST', '/api/me/tour-visto', { token: accessToken });
  assert.equal(post.status, 200, `POST tour-visto devia dar 200, deu ${post.status}`);
  const corpoPost = await post.json();
  assert.deepEqual(corpoPost, { tour_inicio_visto: true });

  const depois = await pedir('GET', '/api/me', { token: accessToken });
  assert.equal(depois.status, 200);
  const corpoDepois = await depois.json();
  assert.equal(corpoDepois.user.tour_inicio_visto, true, 'o MESMO token já tem de ver tour_inicio_visto:true, sem esperar o TTL do cache');
});
