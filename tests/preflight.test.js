// Futty v2.0 — Teste do preflight (VELOCIDADE 4).
//
// O app nativo estava "surreal de devagar" em Lisboa. Uma das causas: cada
// chamada à API levava um OPTIONS antes, e sem Access-Control-Max-Age o
// browser/WebView repete esse OPTIONS em TODAS as chamadas. De Lisboa para
// São Paulo é ~250 ms de ida e volta por pedido, só a pedir licença.
//
// Este teste tranca as três coisas que fazem o preflight ser barato:
//   1. responde 204 (sem corpo)
//   2. traz Access-Control-Max-Age (o browser guarda e não repete)
//   3. as origens do app nativo (iOS capacitor://localhost, Android
//      https://localhost) são aceites SEM depender da variável CORS_ORIGINS
//
// Não toca no Supabase nem em rota autenticada nenhuma: o preflight morre no
// primeiro middleware, que é exactamente o que se quer provar.
//
// Uso: npm test  (ou: node --test tests/)
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

// O pedido que o WebView faz antes de um GET /api/me com Authorization.
function preflight(origin, rota = '/api/me') {
  return fetch(`${baseUrl}${rota}`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
}

const ORIGENS_NATIVAS = [
  ['iOS', 'capacitor://localhost'],
  ['Android', 'https://localhost'],
];

for (const [plataforma, origin] of ORIGENS_NATIVAS) {
  test(`preflight do ${plataforma} (${origin}): 204 + Max-Age + origem ecoada`, async () => {
    const res = await preflight(origin);

    assert.equal(res.status, 204, 'o preflight tem de responder 204 (sem corpo)');

    const maxAge = res.headers.get('access-control-max-age');
    assert.ok(maxAge, 'falta Access-Control-Max-Age — sem ele o preflight repete a cada pedido');
    assert.ok(Number(maxAge) >= 600, `Max-Age curto demais (${maxAge}s); o mínimo útil é 600s`);

    assert.equal(
      res.headers.get('access-control-allow-origin'),
      origin,
      'a origem do app nativo tem de ser aceite sem depender de CORS_ORIGINS'
    );

    // Sem isto o WebView recusa mandar o Bearer token na chamada real.
    const permitidos = (res.headers.get('access-control-allow-headers') || '').toLowerCase();
    assert.ok(permitidos.includes('authorization'), 'o preflight tem de permitir o header Authorization');
  });
}

test('preflight não é contado pelo rate limiter', async () => {
  // Se o OPTIONS passasse pelo limiter, cada chamada gastaria dois lugares do
  // tecto em vez de um. O limiter responde 429 quando estoura; aqui o que se
  // confirma é que uma rajada de preflights continua toda a 204.
  const rajada = await Promise.all(Array.from({ length: 25 }, () => preflight('capacitor://localhost')));
  for (const res of rajada) {
    assert.equal(res.status, 204, 'preflight não pode levar 429 — não é pedido de dados');
  }
});

test('origem desconhecida não recebe autorização', async () => {
  const res = await preflight('https://site-que-nao-e-nosso.example');
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'só as origens da casa podem ser ecoadas');
});
