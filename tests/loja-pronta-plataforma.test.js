// Futty v2.0 — Rodada 31H: a loja ligada por plataforma (PAGAMENTOS_PLATAFORMAS + cabeçalho X-Futty-Plataforma).
//
// `loja_pronta` = PAGAMENTOS_ATIVOS === 'true' OU a plataforma do cabeçalho está em PAGAMENTOS_PLATAFORMAS OU a conta é de testador. Cabeçalho
// ausente ou desconhecido não liga por plataforma; sem a variável, ninguém é ligado por plataforma. O cabeçalho só decide a vitrine.
//
// Uso: npm test  (ou: node --test tests/loja-pronta-plataforma.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plataformasLigadas, plataformaDoPedido, lojaPronta, lojaProntaDoPedido } = require('../utils/lojaPronta');
const { carregar, subir, injetar } = require('./_rotas');

const CONFIRMADO = '2026-01-01T00:00:00Z';
const conta = (email) => ({ id: 'u1', email, email_confirmed_at: CONFIRMADO });
const pedidoCom = (valor) => ({ get: (n) => (n.toLowerCase() === 'x-futty-plataforma' ? valor : undefined) });

test('a lista de plataformas: vírgulas, sem espaços e sem maiúsculas; só ios, android e web; vazia ou ausente = nenhuma', () => {
  assert.deepEqual([...plataformasLigadas({ PAGAMENTOS_PLATAFORMAS: ' Android , IOS,, ' })], ['android', 'ios']);
  assert.deepEqual([...plataformasLigadas({ PAGAMENTOS_PLATAFORMAS: 'android,symbian,*,todas' })], ['android']);
  assert.equal(plataformasLigadas({}).size, 0);
  assert.equal(plataformasLigadas({ PAGAMENTOS_PLATAFORMAS: '' }).size, 0);
  assert.equal(plataformasLigadas({ PAGAMENTOS_PLATAFORMAS: ' , ,' }).size, 0);
});

test('o cabeçalho: ios, android e web valem (qualquer caixa); ausente ou desconhecido = null', () => {
  assert.equal(plataformaDoPedido(pedidoCom('android')), 'android');
  assert.equal(plataformaDoPedido(pedidoCom(' iOS ')), 'ios');
  assert.equal(plataformaDoPedido(pedidoCom('WEB')), 'web');
  for (const v of [undefined, '', 'windows', 'android,ios', 'null', 'undefined']) assert.equal(plataformaDoPedido(pedidoCom(v)), null, String(v));
  assert.equal(plataformaDoPedido(null), null);
  assert.equal(plataformaDoPedido({}), null);
  // sem req.get (um objeto cru), lê o cabeçalho minúsculo
  assert.equal(plataformaDoPedido({ headers: { 'x-futty-plataforma': 'ios' } }), 'ios');
});

test('lojaPronta: android liga, ios não, web não, quando a lista é "android"', () => {
  const env = { PAGAMENTOS_PLATAFORMAS: 'android' };
  assert.equal(lojaPronta(conta('qualquer@x.com'), env, 'android'), true);
  assert.equal(lojaPronta(conta('qualquer@x.com'), env, 'ios'), false);
  assert.equal(lojaPronta(conta('qualquer@x.com'), env, 'web'), false);
  // sem plataforma (cabeçalho ausente/desconhecido): não liga
  assert.equal(lojaPronta(conta('qualquer@x.com'), env, null), false);
  assert.equal(lojaPronta(conta('qualquer@x.com'), env), false);
  assert.equal(lojaPronta(conta('qualquer@x.com'), env, 'symbian'), false);
  assert.equal(lojaPronta(conta('qualquer@x.com'), env, ''), false);
});

test('lojaPronta: sem a variável ninguém é ligado por plataforma; a lista pode ter mais de uma', () => {
  for (const p of ['android', 'ios', 'web']) assert.equal(lojaPronta(conta('a@x.com'), {}, p), false, p);
  for (const p of ['android', 'ios', 'web']) assert.equal(lojaPronta(conta('a@x.com'), { PAGAMENTOS_PLATAFORMAS: '' }, p), false, p);
  const env = { PAGAMENTOS_PLATAFORMAS: 'android, ios' };
  assert.equal(lojaPronta(null, env, 'android'), true, 'a plataforma liga mesmo sem conta identificada no helper');
  assert.equal(lojaPronta(conta('a@x.com'), env, 'IOS'), true);
  assert.equal(lojaPronta(conta('a@x.com'), env, 'web'), false);
});

test('lojaPronta: testador abre em qualquer plataforma (ou sem cabeçalho); PAGAMENTOS_ATIVOS abre para todos', () => {
  const env = { PAGAMENTOS_PLATAFORMAS: 'android', PAGAMENTOS_TESTERS: 'ana@x.com' };
  for (const p of ['android', 'ios', 'web', null, 'symbian']) assert.equal(lojaPronta(conta('ana@x.com'), env, p), true, `testador em ${p}`);
  assert.equal(lojaPronta(conta('outra@x.com'), env, 'ios'), false);
  for (const p of ['android', 'ios', 'web', null]) assert.equal(lojaPronta(conta('qualquer@x.com'), { ...env, PAGAMENTOS_ATIVOS: 'true' }, p), true, `aberta em ${p}`);
  assert.equal(lojaPronta(conta('qualquer@x.com'), { PAGAMENTOS_ATIVOS: 'TRUE', PAGAMENTOS_PLATAFORMAS: 'android' }, 'ios'), false);
});

test('lojaProntaDoPedido: usa req.user e o cabeçalho', () => {
  const env = { PAGAMENTOS_PLATAFORMAS: 'android', PAGAMENTOS_TESTERS: 'ana@x.com' };
  const req = (email, plataforma) => ({ user: conta(email), get: pedidoCom(plataforma).get });
  assert.equal(lojaProntaDoPedido(req('a@x.com', 'android'), env), true);
  assert.equal(lojaProntaDoPedido(req('a@x.com', 'ios'), env), false);
  assert.equal(lojaProntaDoPedido(req('a@x.com', undefined), env), false);
  assert.equal(lojaProntaDoPedido(req('ana@x.com', 'ios'), env), true);
  assert.equal(lojaProntaDoPedido({ get: pedidoCom('android').get }, env), true, 'sem user, a plataforma liga do mesmo jeito');
  assert.equal(lojaProntaDoPedido(undefined, env), false);
});

/** Pede `rota` e devolve o loja_pronta do payload. */
async function lojaNa(pedir, rota, usuario, plataforma) {
  const cabecalhos = plataforma === undefined ? {} : { 'x-futty-plataforma': plataforma };
  const r = await pedir('GET', rota, null, usuario, cabecalhos);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return rota.includes('inicio') ? r.json.brilhante.loja_pronta : r.json.loja_pronta;
}

test('rotas /api/brilhantes/estado e /api/inicio: android liga, ios não, web não, testador sempre', async (t) => {
  const antes = { ativos: process.env.PAGAMENTOS_ATIVOS, testers: process.env.PAGAMENTOS_TESTERS, plataformas: process.env.PAGAMENTOS_PLATAFORMAS };
  t.after(() => {
    for (const [k, v] of [['PAGAMENTOS_ATIVOS', antes.ativos], ['PAGAMENTOS_TESTERS', antes.testers], ['PAGAMENTOS_PLATAFORMAS', antes.plataformas]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  delete process.env.PAGAMENTOS_ATIVOS;
  process.env.PAGAMENTOS_TESTERS = 'testador@futtymock.com';
  delete process.env.PAGAMENTOS_PLATAFORMAS;

  const restaurar = [
    injetar('utils/gabineteStore', { ler: async () => ({ ads_ativo: false }) }),
    injetar('utils/denunciaStore', { aoGravar: () => {}, listarEquipa: async () => [] }),
  ];
  const { carregados } = carregar({
    users: [{ id: 'testador', nome: 'Testador' }, { id: 'comum', nome: 'Comum' }],
    teams: [], team_members: [], games: [], rsvp_respostas: [], rsvp_espera: [], votes: [], team_join_requests: [],
  }, ['routes/brilhantes', 'routes/inicio', 'services/inicio']);
  for (const r of restaurar.reverse()) r();
  const pedir = subir([carregados['routes/brilhantes'], carregados['routes/inicio']], t);

  for (const rota of ['/api/brilhantes/estado', '/api/inicio']) {
    // sem a variável PAGAMENTOS_PLATAFORMAS: nenhuma plataforma abre a loja a quem não é testador
    for (const p of ['android', 'ios', 'web', undefined]) assert.equal(await lojaNa(pedir, rota, 'comum', p), false, `${rota} sem a variável, ${p}`);

    process.env.PAGAMENTOS_PLATAFORMAS = 'android';
    assert.equal(await lojaNa(pedir, rota, 'comum', 'android'), true, `${rota}: android liga`);
    assert.equal(await lojaNa(pedir, rota, 'comum', 'ANDROID'), true, `${rota}: caixa não importa`);
    assert.equal(await lojaNa(pedir, rota, 'comum', 'ios'), false, `${rota}: ios não`);
    assert.equal(await lojaNa(pedir, rota, 'comum', 'web'), false, `${rota}: web não`);
    assert.equal(await lojaNa(pedir, rota, 'comum', undefined), false, `${rota}: sem cabeçalho não`);
    assert.equal(await lojaNa(pedir, rota, 'comum', 'windows'), false, `${rota}: cabeçalho desconhecido não`);
    // testador: sempre, em qualquer plataforma e sem cabeçalho
    for (const p of ['android', 'ios', 'web', undefined, 'windows']) assert.equal(await lojaNa(pedir, rota, 'testador', p), true, `${rota}: testador em ${p}`);
    // o cabeçalho não faz de ninguém um testador
    delete process.env.PAGAMENTOS_PLATAFORMAS;
  }

  // loja aberta para todos continua abrindo para todos, com ou sem cabeçalho
  process.env.PAGAMENTOS_ATIVOS = 'true';
  for (const rota of ['/api/brilhantes/estado', '/api/inicio']) {
    for (const p of ['ios', 'web', undefined]) assert.equal(await lojaNa(pedir, rota, 'comum', p), true, `${rota} aberta, ${p}`);
  }

  // a plataforma liga a vitrine, mas não faz de ninguém um testador (o detalhe técnico da compra continua só do testador)
  delete process.env.PAGAMENTOS_ATIVOS;
  process.env.PAGAMENTOS_PLATAFORMAS = 'android';
  const estado = await pedir('GET', '/api/brilhantes/estado', null, 'comum', { 'x-futty-plataforma': 'android' });
  assert.equal(estado.json.loja_pronta, true);
  assert.equal(estado.json.testador_loja, false);
});
