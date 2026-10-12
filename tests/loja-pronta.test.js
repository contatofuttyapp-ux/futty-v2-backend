// Futty v2.0 — Rodada 31B: a loja só para testadores (PAGAMENTOS_TESTERS).
//
// `loja_pronta` = PAGAMENTOS_ATIVOS === 'true' OU o e-mail da conta autenticada está na lista PAGAMENTOS_TESTERS. Sem a variável, ninguém. O e-mail
// vem do usuário autenticado (nunca do cliente) e só vale confirmado. O helper é puro; o teste de rota prova que o GET /api/brilhantes/estado o usa.
//
// Uso: npm test  (ou: node --test tests/loja-pronta.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { emailsDosTestadores, ehTestador, lojaPronta } = require('../utils/lojaPronta');
const { carregar, subir } = require('./_rotas');

const CONFIRMADO = '2026-01-01T00:00:00Z';
const conta = (email, confirmado = CONFIRMADO) => ({ id: 'u1', email, email_confirmed_at: confirmado });

test('a lista: e-mails separados por vírgula, sem espaços e sem maiúsculas; vazia ou ausente = ninguém', () => {
  assert.deepEqual([...emailsDosTestadores({ PAGAMENTOS_TESTERS: ' Ana@x.com ,bia@y.com,, ' })], ['ana@x.com', 'bia@y.com']);
  assert.equal(emailsDosTestadores({}).size, 0);
  assert.equal(emailsDosTestadores({ PAGAMENTOS_TESTERS: '' }).size, 0);
  assert.equal(emailsDosTestadores({ PAGAMENTOS_TESTERS: ' , ,' }).size, 0);
});

test('sem a variável, ninguém é testador e a loja segue fechada', () => {
  assert.equal(lojaPronta(conta('ana@x.com'), {}), false);
  assert.equal(ehTestador(conta('ana@x.com'), {}), false);
});

test('com a variável, só o e-mail da lista abre a loja (maiúsculas e espaços não importam)', () => {
  const env = { PAGAMENTOS_TESTERS: 'ana@x.com, Bia@Y.com' };
  assert.equal(lojaPronta(conta('ana@x.com'), env), true);
  assert.equal(lojaPronta(conta('BIA@y.com'), env), true);
  assert.equal(lojaPronta(conta(' ana@x.com '), env), true);
  assert.equal(lojaPronta(conta('carla@x.com'), env), false);
  // nada de "contém" nem de domínio: o e-mail inteiro
  assert.equal(lojaPronta(conta('xana@x.com'), env), false);
  assert.equal(lojaPronta(conta('ana@x.com.evil.test'), env), false);
});

test('PAGAMENTOS_ATIVOS === "true" abre para todos, testador ou não; qualquer outro valor não', () => {
  assert.equal(lojaPronta(conta('qualquer@x.com'), { PAGAMENTOS_ATIVOS: 'true' }), true);
  assert.equal(lojaPronta(null, { PAGAMENTOS_ATIVOS: 'true' }), true);
  for (const v of ['false', 'TRUE', '1', 'sim', '']) assert.equal(lojaPronta(conta('qualquer@x.com'), { PAGAMENTOS_ATIVOS: v }), false, v);
});

test('e-mail sem confirmação não vale, e conta sem e-mail (ou usuário ausente) nunca é testador', () => {
  const env = { PAGAMENTOS_TESTERS: 'ana@x.com' };
  assert.equal(lojaPronta(conta('ana@x.com', null), env), false);
  assert.equal(lojaPronta({ id: 'u1', email: 'ana@x.com' }, env), false);
  assert.equal(lojaPronta({ id: 'u1', email_confirmed_at: CONFIRMADO }, env), false);
  assert.equal(lojaPronta({ id: 'u1', email: 123, email_confirmed_at: CONFIRMADO }, env), false);
  assert.equal(lojaPronta(null, env), false);
  assert.equal(lojaPronta(undefined, env), false);
});

test('GET /api/brilhantes/estado: loja_pronta vem do e-mail da conta autenticada, não do que o cliente manda', async (t) => {
  const antes = { ativos: process.env.PAGAMENTOS_ATIVOS, testers: process.env.PAGAMENTOS_TESTERS };
  t.after(() => {
    for (const [k, v] of [['PAGAMENTOS_ATIVOS', antes.ativos], ['PAGAMENTOS_TESTERS', antes.testers]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  delete process.env.PAGAMENTOS_ATIVOS;
  // o fake de login (tests/_rotas.js) monta o e-mail como "<usuário>@futtymock.com", já confirmado
  process.env.PAGAMENTOS_TESTERS = 'testador@futtymock.com';
  const { carregados } = carregar({ users: [{ id: 'testador' }, { id: 'comum' }], team_members: [], teams: [] }, ['routes/brilhantes']);
  const pedir = subir([carregados['routes/brilhantes']], t);

  const testador = await pedir('GET', '/api/brilhantes/estado', null, 'testador');
  assert.equal(testador.status, 200, JSON.stringify(testador.json));
  assert.equal(testador.json.loja_pronta, true);

  const comum = await pedir('GET', '/api/brilhantes/estado', null, 'comum');
  assert.equal(comum.json.loja_pronta, false);
  // o e-mail de outra pessoa mandado como cabeçalho ou parâmetro não vale nada
  const forjado = await pedir('GET', '/api/brilhantes/estado?email=testador@futtymock.com', null, 'comum', { 'x-email': 'testador@futtymock.com' });
  assert.equal(forjado.json.loja_pronta, false);

  // sem a variável, nem o testador abre a loja
  delete process.env.PAGAMENTOS_TESTERS;
  assert.equal((await pedir('GET', '/api/brilhantes/estado', null, 'testador')).json.loja_pronta, false);
  // e com a loja aberta para todos, abre para todos
  process.env.PAGAMENTOS_ATIVOS = 'true';
  assert.equal((await pedir('GET', '/api/brilhantes/estado', null, 'comum')).json.loja_pronta, true);
});
