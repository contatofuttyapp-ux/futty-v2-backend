// Velocidade 7A (15-set) — cache de GET /api/me/selos (utils/selosCache.js), sem rede.
//
// computeSelos custava 515-525 ms de motor por pedido. Fica em cache por
// usuário, e quem o esquece são os eventos que mexem nos selos: campeonato
// terminado, voto, entrada/saída de time.
const { test } = require('node:test');
const assert = require('node:assert/strict');

function carregar() {
  delete require.cache[require.resolve('../utils/selosCache')];
  return require('../utils/selosCache');
}

function calculo(teamIds, selos = [{ id: 'rank:t1' }]) {
  const c = async () => {
    c.chamadas += 1;
    return { selos, teamIds };
  };
  c.chamadas = 0;
  return c;
}

test('segunda leitura dentro dos 2 min não recalcula', async () => {
  const selosCache = carregar();
  const calc = calculo(['t1']);
  await selosCache.obter('u1', calc);
  const { selos } = await selosCache.obter('u1', calc);
  assert.deepEqual(selos, [{ id: 'rank:t1' }]);
  assert.equal(calc.chamadas, 1);
});

test('voto ou campeonato num time esquece os selos de quem é desse time — e só deles', async () => {
  const selosCache = carregar();
  const doTime = calculo(['t1', 't2']);
  const deFora = calculo(['t3']);
  await selosCache.obter('u1', doTime);
  await selosCache.obter('u2', deFora);
  selosCache.invalidarEquipa('t2');
  await selosCache.obter('u1', doTime);
  await selosCache.obter('u2', deFora);
  assert.equal(doTime.chamadas, 2, 'o membro do time continuou vendo selos velhos');
  assert.equal(deFora.chamadas, 1, 'quem não é do time recalculou à toa');
});

test('entrar num time esquece a pessoa, mesmo com o time ainda fora da lista dela', async () => {
  const selosCache = carregar();
  const calc = calculo(['t1']);
  await selosCache.obter('u1', calc);
  selosCache.invalidarMembro('t-novo', 'u1');
  await selosCache.obter('u1', calc);
  assert.equal(calc.chamadas, 2);
});

test('3 pedidos simultâneos de selos → 1 cálculo', async () => {
  const selosCache = carregar();
  let chamadas = 0;
  const lento = async () => {
    chamadas += 1;
    await new Promise((r) => setTimeout(r, 20));
    return { selos: [], teamIds: [] };
  };
  await Promise.all([selosCache.obter('u1', lento), selosCache.obter('u1', lento), selosCache.obter('u1', lento)]);
  assert.equal(chamadas, 1);
});
