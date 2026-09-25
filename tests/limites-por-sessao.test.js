// Futty v2.0 — Limites por IP e por sessão (hotfix 25, 25-set).
//
// Incidente real: o celular do dono levou "Muitos pedidos" no onboarding porque o
// IP da casa esgotou o balde geral (200/15 min), e no dia do time 20 celulares
// numa quadra dividem um IP de Wi-Fi ou de operadora (CGNAT). Este teste tranca:
//   1. o IP real (CF-Connecting-IP, senão req.ip) é a chave da rede grossa;
//   2. pedido de sessão conhecida NÃO conta no balde por IP, e cada sessão tem o seu;
//   3. um Authorization falso não escapa do balde por IP (senão o teto por IP seria de enfeite);
//   4. avatar conta por pessoa e mídia por IP real, fora dos baldes gerais;
//   5. os tetos combinados: 1500 por IP, 600 por sessão, 20 no avatar, 2000 na mídia;
//   6. as rotas de verdade (server.js, media.js) usam tudo isso.
// Sem rede: nada aqui chama o Supabase.
require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const {
  criarLimitesDaApi,
  criarLimiteDeAvatar,
  criarLimiteDeMidia,
  chaveDaSessao,
  limitesPara,
  LIMITES,
} = require('../middleware/limiters');
const { bearerToken } = require('../middleware/auth');
const { app: appReal } = require('../server');

// Tetos pequenos para o teste bater neles: 3 por IP, 2 por sessão, 2 no avatar, 3 na mídia.
const LIM = { janelaMs: 60_000, apiPorIp: 3, apiPorSessao: 2, avatar: 2, midia: 3 };

const servidores = [];
async function subir(app) {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  servidores.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
after(async () => {
  await Promise.all(servidores.map((s) => new Promise((resolve) => s.close(resolve))));
});

/** O app com os mesmos limiters do server.js, tetos pequenos e as sessões "conhecidas" à escolha do teste. */
async function montar(conhecidas = []) {
  const sabidas = new Set(conhecidas);
  const app = express();
  app.set('trust proxy', 1);
  app.use('/api', ...criarLimitesDaApi({ tokenDoPedido: bearerToken, sessaoConhecida: (t) => sabidas.has(t), limites: LIM }));
  app.use('/api/me/avatar', criarLimiteDeAvatar({ tokenDoPedido: bearerToken, limites: LIM }));
  app.get('/api/ping', (req, res) => res.json({ ok: true }));
  app.post('/api/me/avatar', (req, res) => res.json({ ok: true }));
  app.get('/api/media/:t', criarLimiteDeMidia({ limites: LIM }), (req, res) => res.json({ ok: true }));
  return subir(app);
}

async function bater(base, rota, { ip, token, metodo = 'GET' } = {}) {
  const headers = {};
  if (ip) headers['cf-connecting-ip'] = ip;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${rota}`, { method: metodo, headers });
  await res.arrayBuffer();
  return res;
}
/** Os status de `n` pedidos seguidos. */
async function rajada(base, rota, n, opcoes) {
  const status = [];
  for (let i = 0; i < n; i += 1) status.push((await bater(base, rota, opcoes)).status);
  return status;
}

test('os tetos combinados: 1500 por IP, 600 por sessão, 20 no avatar, 2000 na mídia (em produção)', () => {
  assert.deepEqual(limitesPara(true), { janelaMs: 15 * 60 * 1000, apiPorIp: 1500, apiPorSessao: 600, avatar: 20, midia: 2000 });
  // Fora de produção sobem, como sempre foi (o dono + o Claude + o hot-reload numa tarde de teste).
  const dev = limitesPara(false);
  assert.ok(dev.apiPorIp >= 1500 && dev.apiPorSessao >= 600, `o teto de dev não pode ser menor que o de produção: ${JSON.stringify(dev)}`);
});

test('chaveDaSessao = "sessao:" + os 16 primeiros hex do sha256 do token, sem o token dentro', () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.assinatura';
  const esperada = `sessao:${crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
  assert.equal(chaveDaSessao(token), esperada);
  assert.ok(!chaveDaSessao(token).includes(token), 'o token não pode ficar na chave');
  assert.notEqual(chaveDaSessao('outro-token'), chaveDaSessao(token), 'tokens diferentes, baldes diferentes');
});

test('IP: cada IP (CF-Connecting-IP) tem o seu balde; o de um não gasta o do outro', async () => {
  const base = await montar();
  assert.deepEqual(await rajada(base, '/api/ping', 4, { ip: '198.51.100.1' }), [200, 200, 200, 429]);
  assert.deepEqual(await rajada(base, '/api/ping', 3, { ip: '198.51.100.2' }), [200, 200, 200], 'o outro IP não podia ser barrado');
});

test('IP: sem CF-Connecting-IP vale o req.ip (direto no Cloud Run), num balde à parte do dos que trazem o header', async () => {
  const base = await montar();
  assert.deepEqual(await rajada(base, '/api/ping', 4), [200, 200, 200, 429]);
  assert.deepEqual(await rajada(base, '/api/ping', 1, { ip: '198.51.100.9' }), [200], 'quem traz o header tem o próprio balde');
});

test('pedido de sessão CONHECIDA não conta no balde por IP', async () => {
  const base = await montar(['token-a']);
  // A sessão gasta o balde DELA (2) e leva 429 no terceiro...
  assert.deepEqual(await rajada(base, '/api/ping', 3, { ip: '198.51.100.3', token: 'token-a' }), [200, 200, 429]);
  // ...mas o balde por IP do mesmo IP está intacto: os 3 pedidos anônimos passam.
  assert.deepEqual(await rajada(base, '/api/ping', 3, { ip: '198.51.100.3' }), [200, 200, 200], 'os pedidos da sessão gastaram o balde por IP');
});

test('cada sessão tem o seu balde: duas pessoas no mesmo IP não se misturam', async () => {
  const base = await montar(['token-a', 'token-b']);
  assert.deepEqual(await rajada(base, '/api/ping', 3, { ip: '198.51.100.4', token: 'token-a' }), [200, 200, 429]);
  assert.deepEqual(await rajada(base, '/api/ping', 2, { ip: '198.51.100.4', token: 'token-b' }), [200, 200], 'a outra sessão não podia ser barrada');
});

test('o incidente: com o balde do IP esgotado, quem tem sessão conhecida continua usando o app', async () => {
  const base = await montar(['token-a']);
  assert.deepEqual(await rajada(base, '/api/ping', 4, { ip: '198.51.100.5' }), [200, 200, 200, 429], 'o IP tinha de estar esgotado');
  assert.deepEqual(await rajada(base, '/api/ping', 2, { ip: '198.51.100.5', token: 'token-a' }), [200, 200], 'o celular com sessão não pode levar "Muitos pedidos"');
});

test('um Authorization FALSO não escapa do balde por IP (cada token falso não ganha um balde novo)', async () => {
  const base = await montar(['token-a']);
  const status = [];
  for (let i = 0; i < 5; i += 1) status.push((await bater(base, '/api/ping', { ip: '198.51.100.6', token: `falso-${i}` })).status);
  assert.deepEqual(status, [200, 200, 200, 429, 429], 'token desconhecido tem de contar no balde por IP');
  // Nem um Authorization de outro esquema (não é Bearer).
  const res = await fetch(`${base}/api/ping`, { headers: { 'cf-connecting-ip': '198.51.100.6', authorization: 'Basic abc' } });
  assert.equal(res.status, 429, 'Authorization que não é Bearer conta no balde por IP');
});

test('OPTIONS não conta em balde nenhum', async () => {
  const base = await montar();
  for (let i = 0; i < 10; i += 1) await bater(base, '/api/ping', { ip: '198.51.100.7', metodo: 'OPTIONS' });
  assert.deepEqual(await rajada(base, '/api/ping', 3, { ip: '198.51.100.7' }), [200, 200, 200]);
});

test('avatar: conta por PESSOA, não por IP (20 celulares no mesmo Wi-Fi não se barram)', async () => {
  const base = await montar(['token-a', 'token-b']);
  const ip = '198.51.100.8';
  assert.deepEqual(await rajada(base, '/api/me/avatar', 3, { ip, token: 'token-a', metodo: 'POST' }), [200, 200, 429]);
  assert.deepEqual(await rajada(base, '/api/me/avatar', 2, { ip, token: 'token-b', metodo: 'POST' }), [200, 200], 'a 2ª pessoa do mesmo IP tem a cota dela');
});

test('avatar: sem Authorization cai no IP real', async () => {
  const base = await montar();
  assert.deepEqual(await rajada(base, '/api/me/avatar', 3, { ip: '198.51.100.20', metodo: 'POST' }), [200, 200, 429]);
  assert.deepEqual(await rajada(base, '/api/me/avatar', 2, { ip: '198.51.100.21', metodo: 'POST' }), [200, 200], 'outro IP, outro balde');
});

test('mídia: por CF-Connecting-IP, e fora dos baldes gerais da /api', async () => {
  const base = await montar();
  const ip = '198.51.100.30';
  assert.deepEqual(await rajada(base, '/api/media/x', 4, { ip }), [200, 200, 200, 429]);
  assert.deepEqual(await rajada(base, '/api/media/x', 3, { ip: '198.51.100.31' }), [200, 200, 200], 'outro IP, outro balde de mídia');
  // A mídia esgotada não gastou o balde geral do mesmo IP.
  assert.deepEqual(await rajada(base, '/api/ping', 3, { ip }), [200, 200, 200]);
});

// ─── As rotas de verdade (server.js, routes/media.js) ────────────────────────────
// Sem sessão nem rede: o 404 de uma rota que não existe já passou pelos limiters, e o
// que eles carimbam nos headers (RateLimit-Limit/Remaining) mostra QUAL balde contou.
const numero = (res, nome) => Number(res.headers.get(nome));

test('server.js: pedido anônimo conta no balde por IP, com o CF-Connecting-IP como chave', async () => {
  const base = await subir(appReal);
  const a1 = await bater(base, '/api/rota-que-nao-existe-hotfix25', { ip: '203.0.113.10' });
  const a2 = await bater(base, '/api/rota-que-nao-existe-hotfix25', { ip: '203.0.113.10' });
  const b1 = await bater(base, '/api/rota-que-nao-existe-hotfix25', { ip: '203.0.113.11' });
  assert.equal(numero(a1, 'ratelimit-limit'), LIMITES.apiPorIp, 'o limite geral por IP não está no server.js');
  assert.equal(numero(a2, 'ratelimit-remaining'), numero(a1, 'ratelimit-remaining') - 1, 'o 2º pedido do mesmo IP tem de gastar 1');
  assert.equal(numero(b1, 'ratelimit-remaining'), numero(a1, 'ratelimit-remaining'), 'outro IP tem o próprio balde (a chave é o CF-Connecting-IP)');
});

test('server.js: Authorization falso conta no balde por IP, não no da sessão', async () => {
  const base = await subir(appReal);
  const r1 = await bater(base, '/api/rota-que-nao-existe-hotfix25', { ip: '203.0.113.20', token: 'token-falso-1' });
  const r2 = await bater(base, '/api/rota-que-nao-existe-hotfix25', { ip: '203.0.113.20', token: 'token-falso-2' });
  assert.equal(numero(r1, 'ratelimit-limit'), LIMITES.apiPorIp, 'um token falso não pode cair no balde da sessão');
  assert.equal(numero(r2, 'ratelimit-remaining'), numero(r1, 'ratelimit-remaining') - 1, 'dois tokens falsos do mesmo IP gastam o MESMO balde');
});

test('routes/media.js: o balde de mídia é por CF-Connecting-IP e o teto é o de LIMITES', async () => {
  const base = await subir(appReal);
  const a1 = await bater(base, '/api/media/token-invalido', { ip: '203.0.113.30' });
  const a2 = await bater(base, '/api/media/token-invalido', { ip: '203.0.113.30' });
  const b1 = await bater(base, '/api/media/token-invalido', { ip: '203.0.113.31' });
  assert.equal(a1.status, 403, 'token inválido devolve 403 (o limiter roda antes)');
  assert.equal(numero(a1, 'ratelimit-limit'), LIMITES.midia);
  assert.equal(numero(a2, 'ratelimit-remaining'), numero(a1, 'ratelimit-remaining') - 1);
  assert.equal(numero(b1, 'ratelimit-remaining'), numero(a1, 'ratelimit-remaining'), 'outro IP, outro balde de mídia');
});

test('server.js: o avatar conta por sessão (teto 20), separado do balde do IP', async () => {
  const base = await subir(appReal);
  // Uma subrota que não existe: o limiter do avatar cobre tudo sob /api/me/avatar e o 404
  // vem depois, sem passar pelo requireAuth (nada de ida ao Supabase com token falso).
  const rota = '/api/me/avatar/nao-existe/hotfix25';
  const anonimo1 = await bater(base, rota, { ip: '203.0.113.40' });
  const anonimo2 = await bater(base, rota, { ip: '203.0.113.40' });
  const pessoaA = await bater(base, rota, { ip: '203.0.113.40', token: 'token-falso-a' });
  const pessoaB = await bater(base, rota, { ip: '203.0.113.40', token: 'token-falso-b' });
  assert.equal(numero(anonimo1, 'ratelimit-limit'), LIMITES.avatar);
  assert.equal(numero(anonimo2, 'ratelimit-remaining'), numero(anonimo1, 'ratelimit-remaining') - 1, 'sem Authorization o balde é o do IP');
  assert.equal(numero(pessoaA, 'ratelimit-remaining'), LIMITES.avatar - 1, 'cada pessoa tem a cota inteira, separada do IP');
  assert.equal(numero(pessoaB, 'ratelimit-remaining'), LIMITES.avatar - 1, 'a 2ª pessoa do mesmo IP também');
});
