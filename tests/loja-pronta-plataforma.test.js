// Futty v2.0 — A loja ligada por plataforma (PAGAMENTOS_PLATAFORMAS + cabeçalho X-Futty-Plataforma).
//
// `loja_pronta` = PAGAMENTOS_ATIVOS === 'true' OU a plataforma do cabeçalho está em PAGAMENTOS_PLATAFORMAS. Cabeçalho ausente ou desconhecido não
// liga por plataforma. Sem a variável valem android e ios (as duas lojas vendem); definida e vazia = nenhuma. Não existe mais "testador": a conta
// não muda nada, só a plataforma. O cabeçalho só decide a vitrine.
//
// Uso: npm test  (ou: node --test tests/loja-pronta-plataforma.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plataformasLigadas, plataformaDoPedido, lojaPronta, lojaProntaDoPedido, linhaDaLoja } = require('../utils/lojaPronta');
const { carregar, subir, injetar } = require('./_rotas');

const pedidoCom = (valor) => ({ get: (n) => (n.toLowerCase() === 'x-futty-plataforma' ? valor : undefined) });

test('a lista de plataformas: vírgulas, sem espaços e sem maiúsculas; só ios, android e web; ausente = android e ios; vazia = nenhuma', () => {
  assert.deepEqual([...plataformasLigadas({ PAGAMENTOS_PLATAFORMAS: ' Android , IOS,, ' })], ['android', 'ios']);
  assert.deepEqual([...plataformasLigadas({ PAGAMENTOS_PLATAFORMAS: 'android,symbian,*,todas' })], ['android']);
  assert.deepEqual([...plataformasLigadas({})], ['android', 'ios'], 'sem a variável: as duas lojas');
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
  assert.equal(lojaPronta(env, 'android'), true);
  assert.equal(lojaPronta(env, 'ios'), false);
  assert.equal(lojaPronta(env, 'web'), false);
  // sem plataforma (cabeçalho ausente/desconhecido): não liga
  assert.equal(lojaPronta(env, null), false);
  assert.equal(lojaPronta(env), false);
  assert.equal(lojaPronta(env, 'symbian'), false);
  assert.equal(lojaPronta(env, ''), false);
});

test('lojaPronta: sem a variável, android e ios ligam e o site não; vazia fecha tudo; PAGAMENTOS_ATIVOS abre para todos', () => {
  assert.equal(lojaPronta({}, 'android'), true);
  assert.equal(lojaPronta({}, 'ios'), true);
  assert.equal(lojaPronta({}, 'web'), false);
  assert.equal(lojaPronta({}, null), false);
  for (const p of ['android', 'ios', 'web']) assert.equal(lojaPronta({ PAGAMENTOS_PLATAFORMAS: '' }, p), false, p);
  const env = { PAGAMENTOS_PLATAFORMAS: 'android, ios' };
  assert.equal(lojaPronta(env, 'IOS'), true);
  assert.equal(lojaPronta(env, 'web'), false);
  for (const p of ['android', 'ios', 'web', null]) assert.equal(lojaPronta({ ...env, PAGAMENTOS_ATIVOS: 'true' }, p), true, `aberta em ${p}`);
  assert.equal(lojaPronta({ PAGAMENTOS_ATIVOS: 'TRUE', PAGAMENTOS_PLATAFORMAS: 'android' }, 'ios'), false);
});

test('lojaProntaDoPedido: só o cabeçalho decide (a conta não muda nada)', () => {
  const env = { PAGAMENTOS_PLATAFORMAS: 'android' };
  const req = (email, plataforma) => ({ user: { id: 'u1', email, email_confirmed_at: '2026-01-01T00:00:00Z' }, get: pedidoCom(plataforma).get });
  assert.equal(lojaProntaDoPedido(req('a@x.com', 'android'), env), true);
  assert.equal(lojaProntaDoPedido(req('a@x.com', 'ios'), env), false);
  assert.equal(lojaProntaDoPedido(req('a@x.com', undefined), env), false);
  assert.equal(lojaProntaDoPedido({ get: pedidoCom('android').get }, env), true, 'sem user, a plataforma liga do mesmo jeito');
  assert.equal(lojaProntaDoPedido(undefined, env), false);
});

test('a linha do log na subida diz onde a loja abre (para conferir depois de um deploy)', () => {
  assert.equal(linhaDaLoja({}), '[Futty] loja: plataformas=android,ios (padrão, sem a variável), ativos=false');
  assert.equal(linhaDaLoja({ PAGAMENTOS_PLATAFORMAS: 'android,ios' }), '[Futty] loja: plataformas=android,ios, ativos=false');
  assert.equal(linhaDaLoja({ PAGAMENTOS_PLATAFORMAS: '', PAGAMENTOS_ATIVOS: 'true' }), '[Futty] loja: plataformas=nenhuma, ativos=true');
  assert.equal(linhaDaLoja({ PAGAMENTOS_PLATAFORMAS: 'ios', PAGAMENTOS_ATIVOS: 'sim' }), '[Futty] loja: plataformas=ios, ativos=false');
});

/** Pede `rota` e devolve o loja_pronta do payload. */
async function lojaNa(pedir, rota, usuario, plataforma) {
  const cabecalhos = plataforma === undefined ? {} : { 'x-futty-plataforma': plataforma };
  const r = await pedir('GET', rota, null, usuario, cabecalhos);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return rota.includes('inicio') ? r.json.brilhante.loja_pronta : r.json.loja_pronta;
}

test('rotas /api/brilhantes/estado e /api/inicio: a plataforma decide, a conta não; sem a variável android e ios', async (t) => {
  const antes = { ativos: process.env.PAGAMENTOS_ATIVOS, plataformas: process.env.PAGAMENTOS_PLATAFORMAS };
  t.after(() => {
    for (const [k, v] of [['PAGAMENTOS_ATIVOS', antes.ativos], ['PAGAMENTOS_PLATAFORMAS', antes.plataformas]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  delete process.env.PAGAMENTOS_ATIVOS;
  delete process.env.PAGAMENTOS_PLATAFORMAS;

  const restaurar = [
    injetar('utils/gabineteStore', { ler: async () => ({ ads_ativo: false }) }),
    injetar('utils/denunciaStore', { aoGravar: () => {}, listarEquipa: async () => [] }),
  ];
  const { carregados } = carregar({
    users: [{ id: 'ana', nome: 'Ana' }, { id: 'comum', nome: 'Comum' }],
    teams: [], team_members: [], games: [], rsvp_respostas: [], rsvp_espera: [], votes: [], team_join_requests: [],
  }, ['routes/brilhantes', 'routes/inicio', 'services/inicio']);
  for (const r of restaurar.reverse()) r();
  const pedir = subir([carregados['routes/brilhantes'], carregados['routes/inicio']], t);

  for (const rota of ['/api/brilhantes/estado', '/api/inicio']) {
    // sem a variável: as duas lojas abrem, o site e o pedido sem cabeçalho não
    for (const [p, esperado] of [['android', true], ['ios', true], ['web', false], [undefined, false], ['windows', false]]) {
      for (const quem of ['ana', 'comum']) assert.equal(await lojaNa(pedir, rota, quem, p), esperado, `${rota} sem a variável, ${quem} em ${p}`);
    }

    process.env.PAGAMENTOS_PLATAFORMAS = 'android';
    assert.equal(await lojaNa(pedir, rota, 'comum', 'android'), true, `${rota}: android liga`);
    assert.equal(await lojaNa(pedir, rota, 'comum', 'ANDROID'), true, `${rota}: caixa não importa`);
    assert.equal(await lojaNa(pedir, rota, 'comum', 'ios'), false, `${rota}: ios não`);
    assert.equal(await lojaNa(pedir, rota, 'comum', 'web'), false, `${rota}: web não`);
    assert.equal(await lojaNa(pedir, rota, 'comum', undefined), false, `${rota}: sem cabeçalho não`);

    process.env.PAGAMENTOS_PLATAFORMAS = '';
    for (const p of ['android', 'ios', 'web', undefined]) assert.equal(await lojaNa(pedir, rota, 'comum', p), false, `${rota} vazia, ${p}`);
    delete process.env.PAGAMENTOS_PLATAFORMAS;
  }

  // loja aberta para todos continua abrindo para todos, com ou sem cabeçalho
  process.env.PAGAMENTOS_ATIVOS = 'true';
  process.env.PAGAMENTOS_PLATAFORMAS = '';
  for (const rota of ['/api/brilhantes/estado', '/api/inicio']) {
    for (const p of ['ios', 'web', undefined]) assert.equal(await lojaNa(pedir, rota, 'comum', p), true, `${rota} aberta, ${p}`);
  }

  // o /estado não fala mais de testador
  const estado = await pedir('GET', '/api/brilhantes/estado', null, 'ana', { 'x-futty-plataforma': 'ios' });
  assert.equal('testador_loja' in estado.json, false);
});
