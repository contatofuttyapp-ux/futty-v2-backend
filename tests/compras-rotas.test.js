// Pagamentos P1 — as rotas de compra (routes/compras.js), sem banco e sem rede.
//
// O que isto prova:
//   1. webhook sem o segredo (ou com o errado) → 401 e nada gravado;
//   2. compra `minha` credita 10 e o MESMO evento reenviado não credita de novo;
//   3. `pacote` com team_id nos atributos do assinante liga o time do dono;
//   4. tipo desconhecido → 200 e linha 'ignorada' (auditoria);
//   5. app_user_id que não é usuário → 200 e 'ignorada' (o RevenueCat não repete para sempre);
//   6. sandbox marca ambiente='sandbox' (e some com RC_ACEITAR_SANDBOX=false);
//   7. reembolso (CANCELLATION/CUSTOMER_SUPPORT) desfaz; banco fora → 500 (a loja reenvia);
//   8. no servidor de verdade a rota está montada, fora do limiter geral, com o dela (120/min).
//
// Uso: npm test  (ou: node --test tests/compras-rotas.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { criarRotasCompras, segredoConfere, PRODUTOS_LOJA } = require('../routes/compras');
const { criarCompras } = require('../utils/compras');
const { criarSupabaseFalso } = require('./_supabaseFalso');

const SEGREDO = 'segredo-de-teste-0123456789abcdef0123456789abcdef';
const PESSOA = '22222222-2222-2222-2222-222222222222';
const DONO = '33333333-3333-3333-3333-333333333333';
const ADMIN = '44444444-4444-4444-4444-444444444444';
const TIME = '11111111-1111-1111-1111-111111111111';

async function montar({ aceitarSandbox = true, falhar = null } = {}, t) {
  const avisos = [];
  const notificar = (ids, payload) => avisos.push({ ids, payload });
  const { cliente, tabelas } = criarSupabaseFalso({
    users: [
      { id: PESSOA, brilhante_creditos: 0, rc_app_user_id: null },
      { id: DONO, brilhante_creditos: 0, rc_app_user_id: null },
      { id: ADMIN, brilhante_creditos: 0, is_super_admin: true },
    ],
    teams: [{ id: TIME, nome: 'Missa de Quinta', brilhante_ativo: false, brilhante_kit: 'dark-gold', brilhante_origem: null }],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin' }, { team_id: TIME, user_id: PESSOA, role: 'member' }],
    pedidos_ativacao: [],
    compras: [],
  }, { falhar });
  const app = express();
  app.use(express.json());
  app.use(criarRotasCompras({
    supabase: cliente,
    compras: criarCompras({ supabase: cliente, notificar }),
    segredo: SEGREDO,
    aceitarSandbox,
    notificar,
    limiteWebhook: (req, res, next) => next(),
  }));
  const servidor = app.listen(0);
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const postar = async (evento, { auth = `Bearer ${SEGREDO}` } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = auth;
    const r = await fetch(`${base}/api/compras/webhook/revenuecat`, { method: 'POST', headers, body: JSON.stringify({ api_version: '1.0', event: evento }) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { tabelas, avisos, postar, base };
}

const evento = (extra = {}) => ({
  id: 'evt-1',
  type: 'NON_RENEWING_PURCHASE',
  app_user_id: PESSOA,
  original_app_user_id: PESSOA,
  aliases: [PESSOA],
  product_id: 'futty_minha',
  transaction_id: '2000000123',
  original_transaction_id: '2000000123',
  store: 'APP_STORE',
  environment: 'PRODUCTION',
  currency: 'BRL',
  price: 1.79,
  price_in_purchased_currency: 9.9,
  purchased_at_ms: 1790000000000,
  subscriber_attributes: {},
  ...extra,
});

const creditos = (tabelas, id) => tabelas.users.find((u) => u.id === id).brilhante_creditos;

test('segredoConfere: aceita "Bearer x" e "x", recusa errado, vazio e sem segredo configurado', () => {
  assert.equal(segredoConfere(`Bearer ${SEGREDO}`, SEGREDO), true);
  assert.equal(segredoConfere(SEGREDO, SEGREDO), true);
  assert.equal(segredoConfere('Bearer outro', SEGREDO), false);
  assert.equal(segredoConfere('', SEGREDO), false);
  assert.equal(segredoConfere(`Bearer ${SEGREDO}`, undefined), false, 'sem segredo no ambiente ninguém passa');
});

test('os product_ids das lojas', () => {
  assert.deepEqual(PRODUTOS_LOJA, { futty_minha: 'minha', futty_pacote: 'pacote', futty_manto: 'manto' });
});

test('webhook sem token ou com token errado → 401 e nada gravado', async (t) => {
  const { postar, tabelas } = await montar({}, t);
  assert.equal((await postar(evento(), { auth: null })).status, 401);
  assert.equal((await postar(evento(), { auth: 'Bearer errado' })).status, 401);
  assert.equal(tabelas.compras.length, 0);
  assert.equal(creditos(tabelas, PESSOA), 0);
});

test('minha credita 10; o MESMO evento reenviado não credita de novo', async (t) => {
  const { postar, tabelas, avisos } = await montar({}, t);
  const r1 = await postar(evento());
  assert.equal(r1.status, 200);
  assert.equal(r1.json.estado, 'creditada');
  assert.equal(creditos(tabelas, PESSOA), 10);
  const c = tabelas.compras[0];
  assert.equal(c.loja, 'app_store');
  assert.equal(c.ambiente, 'producao');
  assert.equal(c.preco, 9.9);
  assert.equal(c.preco_usd, 1.79);
  assert.equal(c.moeda, 'BRL');
  assert.equal(c.evento_id, 'evt-1');
  assert.deepEqual(avisos.at(-1).ids, [PESSOA], 'push ao comprador');

  const r2 = await postar(evento());
  assert.equal(r2.status, 200);
  assert.equal(r2.json.estado, 'repetida');
  assert.equal(creditos(tabelas, PESSOA), 10, 'nada de crédito em dobro');
  assert.equal(tabelas.compras.length, 1);
});

test('pacote com team_id nos atributos do assinante liga o time do dono', async (t) => {
  const { postar, tabelas } = await montar({}, t);
  const r = await postar(evento({
    id: 'evt-p', app_user_id: DONO, original_app_user_id: DONO, aliases: [], product_id: 'futty_pacote',
    transaction_id: 'GPA.3300-0000', store: 'PLAY_STORE',
    subscriber_attributes: { team_id: { value: TIME, updated_at_ms: 1790000000000 } },
  }));
  assert.equal(r.status, 200);
  assert.equal(r.json.estado, 'creditada');
  assert.equal(tabelas.teams[0].brilhante_ativo, true);
  assert.equal(tabelas.teams[0].brilhante_origem, 'play_store');
  assert.equal(tabelas.compras[0].team_id, TIME);
  assert.equal(tabelas.users.find((u) => u.id === DONO).rc_app_user_id, DONO, 'id do RevenueCat guardado');
});

test('pacote pago por quem não é dono → 200, ignorada com o motivo, e o dono da casa é avisado', async (t) => {
  const { postar, tabelas, avisos } = await montar({}, t);
  const r = await postar(evento({ product_id: 'futty_pacote', subscriber_attributes: { team_id: { value: TIME } } }));
  assert.equal(r.status, 200);
  assert.equal(r.json.estado, 'ignorada');
  assert.equal(r.json.motivo, 'NAO_E_DONO');
  assert.equal(tabelas.teams[0].brilhante_ativo, false);
  assert.equal(tabelas.compras[0].estado, 'ignorada');
  assert.ok(avisos.some((a) => a.ids.includes(ADMIN)), 'push ao super-admin');
});

test('tipo desconhecido → 200 e linha ignorada com o payload guardado', async (t) => {
  const { postar, tabelas } = await montar({}, t);
  const r = await postar(evento({ id: 'evt-x', type: 'SUBSCRIPTION_PAUSED' }));
  assert.equal(r.status, 200);
  assert.equal(r.json.estado, 'ignorada');
  const c = tabelas.compras[0];
  assert.equal(c.estado, 'ignorada');
  assert.equal(c.transacao_id, 'evento:evt-x', 'nunca ocupa a transação da compra');
  assert.equal(c.payload.event.type, 'SUBSCRIPTION_PAUSED');
  assert.equal(creditos(tabelas, PESSOA), 0);
});

test('app_user_id que não é usuário → 200, ignorada, sem crédito, super-admin avisado', async (t) => {
  const { postar, tabelas, avisos } = await montar({}, t);
  const r = await postar(evento({ app_user_id: '$RCAnonymousID:abc', original_app_user_id: '$RCAnonymousID:abc', aliases: [] }));
  assert.equal(r.status, 200);
  assert.equal(r.json.motivo, 'USUARIO_DESCONHECIDO');
  assert.equal(tabelas.compras[0].estado, 'ignorada');
  assert.equal(tabelas.compras[0].user_id, null);
  assert.ok(avisos.some((a) => a.ids.includes(ADMIN)));
});

test('TEST → 200 e nada gravado', async (t) => {
  const { postar, tabelas } = await montar({}, t);
  const r = await postar({ id: 'evt-t', type: 'TEST', app_user_id: 'x' });
  assert.equal(r.status, 200);
  assert.equal(tabelas.compras.length, 0);
});

test('SANDBOX credita marcando o ambiente; com RC_ACEITAR_SANDBOX=false fica ignorada', async (t) => {
  const aceita = await montar({}, t);
  await aceita.postar(evento({ environment: 'SANDBOX' }));
  assert.equal(aceita.tabelas.compras[0].ambiente, 'sandbox');
  assert.equal(creditos(aceita.tabelas, PESSOA), 10);

  const recusa = await montar({ aceitarSandbox: false }, t);
  const r = await recusa.postar(evento({ environment: 'SANDBOX' }));
  assert.equal(r.json.motivo, 'SANDBOX_DESLIGADO');
  assert.equal(creditos(recusa.tabelas, PESSOA), 0);
});

test('reembolso (CANCELLATION por CUSTOMER_SUPPORT) desconta; UNSUBSCRIBE não', async (t) => {
  const { postar, tabelas } = await montar({}, t);
  await postar(evento());
  const nao = await postar(evento({ id: 'evt-u', type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' }));
  assert.equal(nao.json.estado, 'ignorada');
  assert.equal(creditos(tabelas, PESSOA), 10);
  const sim = await postar(evento({ id: 'evt-r', type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' }));
  assert.equal(sim.json.estado, 'reembolsada');
  assert.equal(creditos(tabelas, PESSOA), 0);
  assert.equal(tabelas.compras.find((c) => c.transacao_id === '2000000123').estado, 'reembolsada');
});

test('banco fora do ar → 500 (o RevenueCat reenvia) e nada creditado', async (t) => {
  const { postar, tabelas } = await montar({ falhar: (tabela) => (tabela === 'compras' ? { message: 'connection refused' } : null) }, t);
  const r = await postar(evento());
  assert.equal(r.status, 500);
  assert.equal(creditos(tabelas, PESSOA), 0);
});

test('no servidor de verdade: rota montada, 401 sem segredo, fora do limiter geral (conta no dela, 120)', async (t) => {
  const { app } = require('../server');
  const servidor = app.listen(0);
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const r = await fetch(`${base}/api/compras/webhook/revenuecat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer errado' }, body: '{"event":{"type":"TEST"}}',
  });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('ratelimit-limit'), '120', 'o webhook devia contar só no limiter dele');
  const outra = await fetch(`${base}/api/rota-inexistente-p1`);
  assert.notEqual(outra.headers.get('ratelimit-limit'), '120', 'o limiter geral continua valendo no resto da /api');
});

// ─── Parte D: o app pergunta e restaura ──────────────────────────────────────

/** App de teste com sessão falsa (req.user = PESSOA) e fetch do RevenueCat mockado. */
async function montarApp({ rcApiKey = 'sk_teste', respostaRc = null, compras: linhas = [] } = {}, t) {
  const pedidosRc = [];
  const { cliente, tabelas } = criarSupabaseFalso({
    users: [{ id: PESSOA, brilhante_creditos: 0 }, { id: DONO, brilhante_creditos: 0 }],
    teams: [{ id: TIME, nome: 'Missa de Quinta', brilhante_ativo: false, brilhante_kit: null }],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin' }],
    pedidos_ativacao: [],
    compras: linhas,
  });
  const app = express();
  app.use(express.json());
  app.use(criarRotasCompras({
    supabase: cliente,
    compras: criarCompras({ supabase: cliente, notificar: () => {} }),
    segredo: SEGREDO,
    notificar: () => {},
    limiteWebhook: (req, res, next) => next(),
    rcApiKey,
    buscar: async (url, opts) => {
      pedidosRc.push({ url, auth: opts?.headers?.Authorization });
      return { ok: true, json: async () => respostaRc };
    },
    autenticar: (req, res, next) => { req.user = { id: PESSOA }; next(); },
  }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message, code: err.code }));
  const servidor = app.listen(0);
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const sincronizar = async (corpo) => {
    const r = await fetch(`${base}/api/compras/sincronizar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    return { status: r.status, json: await r.json() };
  };
  return { tabelas, pedidosRc, sincronizar, base };
}

const rcCom = (itens) => ({ subscriber: { non_subscriptions: itens, subscriber_attributes: {} } });

test('sincronizar sem RC_API_KEY → 503 COMPRAS_INDISPONIVEL', async (t) => {
  const { sincronizar } = await montarApp({ rcApiKey: null }, t);
  const r = await sincronizar({ nonSubscriptionTransactions: [{ productIdentifier: 'futty_minha', transactionIdentifier: '1' }] });
  assert.equal(r.status, 503);
  assert.equal(r.json.code, 'COMPRAS_INDISPONIVEL');
});

test('sincronizar credita SÓ o que o RevenueCat confirma — o corpo sozinho não vale nada', async (t) => {
  const { sincronizar, tabelas, pedidosRc } = await montarApp({
    respostaRc: rcCom({ futty_minha: [{ id: 'rc-1', store_transaction_id: '2000000999', store: 'app_store', is_sandbox: false }] }),
  }, t);
  const r = await sincronizar({
    customerInfo: {
      nonSubscriptionTransactions: [
        { productIdentifier: 'futty_minha', transactionIdentifier: '2000000999' },
        { productIdentifier: 'futty_minha', transactionIdentifier: 'inventada-pelo-app' },
      ],
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.creditadas, 1);
  assert.equal(r.json.nao_confirmadas, 1);
  assert.equal(creditos(tabelas, PESSOA), 10);
  assert.equal(pedidosRc[0].url, `https://api.revenuecat.com/v1/subscribers/${PESSOA}`);
  assert.equal(pedidosRc[0].auth, 'Bearer sk_teste');

  // De novo (ou o webhook depois): já existe, não credita e nem pergunta ao RevenueCat.
  const r2 = await sincronizar({ nonSubscriptionTransactions: [{ productIdentifier: 'futty_minha', transactionIdentifier: '2000000999' }] });
  assert.equal(r2.json.ja_existiam, 1);
  assert.equal(creditos(tabelas, PESSOA), 10);
  assert.equal(pedidosRc.length, 1);
});

test('sincronizar: produto de outro dono (pacote sem ser dono) fica em recusadas', async (t) => {
  const { sincronizar, tabelas } = await montarApp({
    respostaRc: rcCom({ futty_pacote: [{ id: 'rc-2', store_transaction_id: 'GPA.1', store: 'play_store', is_sandbox: true }] }),
  }, t);
  const r = await sincronizar({ teamId: TIME, nonSubscriptionTransactions: [{ transactionIdentifier: 'GPA.1' }] });
  assert.equal(r.json.creditadas, 0);
  assert.deepEqual(r.json.recusadas, [{ transacao: 'GPA.1', produto: 'pacote', codigo: 'NAO_E_DONO' }]);
  assert.equal(tabelas.teams[0].brilhante_ativo, false);
});

test('minhas: lista as compras da pessoa, sem as ignoradas nem as dos outros', async (t) => {
  const { base } = await montarApp({
    compras: [
      { id: 'c1', user_id: PESSOA, produto: 'minha', loja: 'app_store', preco: 9.9, moeda: 'BRL', estado: 'creditada', criada_em: '2026-09-20T10:00:00Z' },
      { id: 'c2', user_id: PESSOA, produto: 'minha', loja: 'outra', estado: 'ignorada', criada_em: '2026-09-21T10:00:00Z' },
      { id: 'c3', user_id: DONO, produto: 'pacote', loja: 'play_store', estado: 'creditada', criada_em: '2026-09-22T10:00:00Z' },
    ],
  }, t);
  const r = await fetch(`${base}/api/compras/minhas`);
  const json = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(json.compras.map((c) => c.id), ['c1']);
});

test('P2: a Minha Figurinha não leva o team_id que ficou no assinante depois de um pacote', async (t) => {
  const { postar, tabelas } = await montar({}, t);
  const r = await postar(evento({ id: 'evt-m', transaction_id: 'tx-minha-com-time', subscriber_attributes: { team_id: { value: TIME } } }));
  assert.equal(r.json.estado, 'creditada');
  assert.equal(tabelas.compras[0].team_id, null);
});
