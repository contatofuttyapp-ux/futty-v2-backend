// Futty v2.0 — Testes de DELETE /api/me (exclusão de conta, LGPD/exigência
// das lojas). Mesmo padrão de tests/permissoes.test.js: sobe o app numa porta
// livre, cria uma conta de teste descartável e confirma:
//   1. sem { confirmacao: 'EXCLUIR' } no corpo -> 400, conta continua existindo
//   2. com a confirmação certa -> 200 { ok: true }
//   3. o MESMO token, depois de excluída -> 401 em GET /api/me (a exclusão
//      também invalida o cache de sessão — middleware/auth.js — senão o token
//      continuaria "válido" por até 60s mesmo com a conta já apagada)
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
let jaExcluida = false; // after() só tenta apagar de novo se o teste 2 não chegou a rodar

before(async () => {
  if (!COM_BANCO) return;
  if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_PUBLISHABLE_KEY (ou a antiga SUPABASE_ANON_KEY) em falta no .env — precisa dela para assinar sessão de teste.');

  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const email = `teste-excluir-conta-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
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
  if (!COM_BANCO) return;
  if (testUserId && !jaExcluida) await supabase.auth.admin.deleteUser(testUserId).catch(() => {});
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

test('DELETE /api/me sem confirmacao -> 400, conta continua existindo', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const semCorpo = await pedir('DELETE', '/api/me', { token: accessToken });
  assert.equal(semCorpo.status, 400, `sem corpo devia dar 400, deu ${semCorpo.status}`);

  const confirmacaoErrada = await pedir('DELETE', '/api/me', { token: accessToken, body: { confirmacao: 'sim' } });
  assert.equal(confirmacaoErrada.status, 400, `confirmação errada devia dar 400, deu ${confirmacaoErrada.status}`);

  // A conta não foi tocada — /api/me continua respondendo 200 com o mesmo token.
  const me = await pedir('GET', '/api/me', { token: accessToken });
  assert.equal(me.status, 200, `conta devia continuar acessível após 400, deu ${me.status}`);
});

test('DELETE /api/me com confirmacao correta -> 200, e o mesmo token passa a dar 401', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const res = await pedir('DELETE', '/api/me', { token: accessToken, body: { confirmacao: 'EXCLUIR' } });
  assert.equal(res.status, 200, `devia dar 200, deu ${res.status}`);
  const corpo = await res.json();
  assert.deepEqual(corpo, { ok: true });
  jaExcluida = true;

  const me = await pedir('GET', '/api/me', { token: accessToken });
  assert.equal(me.status, 401, `token da conta excluída devia dar 401 em /api/me, deu ${me.status}`);
});
