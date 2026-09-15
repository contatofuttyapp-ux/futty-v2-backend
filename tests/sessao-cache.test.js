// Velocidade 7A (15-set) — cache de sessão do middleware/auth.js, sem rede.
//
// O supabase.auth.getUser é trocado por um falso que conta chamadas, e o relógio
// (Date) é controlado pelo teste para atravessar os 60 s do TTL sem esperar.
const { test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { AuthApiError, AuthRetryableFetchError } = require('@supabase/supabase-js');

const AGORA = Date.UTC(2026, 8, 15, 12, 0, 0);
const caminhoDb = require.resolve('../utils/db');

function authFalso() {
  const f = {
    chamadas: 0,
    demoraMs: 20,
    resposta: () => ({ data: { user: { id: 'u1', user_metadata: {} } }, error: null }),
    async getUser(token) {
      f.chamadas += 1;
      const responder = f.resposta; // o que valia quando o pedido saiu
      await new Promise((r) => setTimeout(r, f.demoraMs));
      return responder(token);
    },
  };
  return f;
}

function carregarAuth(auth) {
  require.cache[caminhoDb] = { id: caminhoDb, filename: caminhoDb, loaded: true, exports: { supabase: { auth } } };
  for (const m of ['../middleware/auth', '../utils/plataformaStore']) delete require.cache[require.resolve(m)];
  return require('../middleware/auth');
}

/** JWT só com o que o cache lê (exp); a assinatura quem confere é o Supabase. */
function token(venceEmS, marca = 'a') {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', exp: Math.floor(AGORA / 1000) + venceEmS })}.${marca}`;
}

const pedidoCom = (tk) => ({ headers: { authorization: `Bearer ${tk}` }, user: { id: 'u1' } });

beforeEach(() => mock.timers.enable({ apis: ['Date'], now: AGORA }));
afterEach(() => mock.timers.reset());

test('passados os 60 s, a sessão sai na hora e o Supabase é consultado por trás', async () => {
  const auth = authFalso();
  const { getUserCacheado } = carregarAuth(auth);
  const tk = token(3600);
  assert.equal((await getUserCacheado(tk)).id, 'u1');
  mock.timers.tick(61_000);
  auth.demoraMs = 200;
  const t0 = performance.now();
  assert.equal((await getUserCacheado(tk)).id, 'u1');
  assert.ok(performance.now() - t0 < 100, 'o pedido esperou a revalidação');
  assert.equal(auth.chamadas, 2, 'a revalidação por trás não aconteceu');
});

test('token vencido não sai do cache velho: espera o Supabase', async () => {
  const auth = authFalso();
  const { getUserCacheado } = carregarAuth(auth);
  const tk = token(30); // o token vence daqui a 30 s
  await getUserCacheado(tk);
  mock.timers.tick(61_000); // cache vencido E token vencido
  auth.resposta = () => ({ data: { user: null }, error: new AuthApiError('invalid JWT: token is expired', 403, 'bad_jwt') });
  assert.equal(await getUserCacheado(tk), null, 'um token vencido foi aceito pelo cache');
  assert.equal(auth.chamadas, 2);
});

test('revalidação diz que o token não vale mais: o pedido seguinte já é 401', async () => {
  const auth = authFalso();
  const { getUserCacheado } = carregarAuth(auth);
  const tk = token(3600);
  await getUserCacheado(tk);
  mock.timers.tick(61_000);
  auth.resposta = () => ({ data: { user: null }, error: new AuthApiError('User not found', 404, 'user_not_found') });
  assert.equal((await getUserCacheado(tk)).id, 'u1'); // sai a velha, revalida por trás
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(await getUserCacheado(tk), null, 'a sessão continuou valendo depois de o Supabase a recusar');
});

test('Supabase fora do ar na revalidação: a sessão fica', async (t) => {
  t.mock.method(console, 'error', () => {});
  const auth = authFalso();
  const { getUserCacheado } = carregarAuth(auth);
  const tk = token(3600);
  await getUserCacheado(tk);
  mock.timers.tick(61_000);
  auth.resposta = () => ({ data: { user: null }, error: new AuthRetryableFetchError('fetch failed', 0) });
  assert.equal((await getUserCacheado(tk)).id, 'u1');
  await new Promise((r) => setTimeout(r, 40)); // a revalidação falha
  assert.equal((await getUserCacheado(tk))?.id, 'u1', 'um soluço de rede deslogou a pessoa');
});

test('sem sessão em cache e Supabase fora do ar: null (401), como antes', async () => {
  const auth = authFalso();
  auth.resposta = () => ({ data: { user: null }, error: new AuthRetryableFetchError('fetch failed', 0) });
  const { getUserCacheado } = carregarAuth(auth);
  assert.equal(await getUserCacheado(token(3600)), null);
});

test('invalidarSessaoDoPedido apaga na hora, mesmo com revalidação em voo', async () => {
  const auth = authFalso();
  const { getUserCacheado, invalidarSessaoDoPedido } = carregarAuth(auth);
  const tk = token(3600);
  await getUserCacheado(tk);
  mock.timers.tick(61_000);
  auth.demoraMs = 50;
  await getUserCacheado(tk); // sai a velha e sai uma revalidação com o metadata antigo
  invalidarSessaoDoPedido(pedidoCom(tk)); // ex.: POST /api/me/onboarding-completo
  auth.demoraMs = 5;
  auth.resposta = () => ({ data: { user: { id: 'u1', user_metadata: { onboarding_completo: true } } }, error: null });
  assert.equal((await getUserCacheado(tk)).user_metadata.onboarding_completo, true, 'serviu a sessão velha depois do invalidar');
  await new Promise((r) => setTimeout(r, 70)); // a revalidação antiga chega agora
  assert.equal((await getUserCacheado(tk)).user_metadata.onboarding_completo, true, 'a revalidação antiga gravou por cima');
});

test('invalidarSessaoDoPedido esquece a mesma conta em outros tokens (outro aparelho)', async () => {
  const auth = authFalso();
  const { getUserCacheado, invalidarSessaoDoPedido } = carregarAuth(auth);
  const celular = token(3600, 'celular');
  const web = token(3600, 'web');
  await getUserCacheado(celular);
  await getUserCacheado(web);
  assert.equal(auth.chamadas, 2);
  invalidarSessaoDoPedido(pedidoCom(celular)); // ex.: DELETE /api/me no celular
  await getUserCacheado(web);
  assert.equal(auth.chamadas, 3, 'a sessão do outro aparelho continuou em cache');
});
