// Velocidade 7A (15-set) — utils/cacheQuente.js, sem rede.
//
// O relatório do Diagnóstico mostrou a "manada": 3 pedidos simultâneos no
// arranque frio, cada um pagando a mesma falha de cache. Aqui fica travado que
// quem chega junto espera a MESMA ida à rede.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarCache } = require('../utils/cacheQuente');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function buscaContada(valor, demoraMs = 20) {
  const b = async () => {
    b.chamadas += 1;
    const n = b.chamadas;
    await dormir(demoraMs);
    return typeof valor === 'function' ? valor(n) : valor;
  };
  b.chamadas = 0;
  return b;
}

test('3 chamadas simultâneas com a mesma chave → 1 ida à rede', async () => {
  const cache = criarCache({ ttlMs: 60_000 });
  const buscar = buscaContada('v');
  const r = await Promise.all([cache.obter('k', buscar), cache.obter('k', buscar), cache.obter('k', buscar)]);
  assert.deepEqual(r, ['v', 'v', 'v']);
  assert.equal(buscar.chamadas, 1, 'cada pedido foi à rede sozinho (manada)');
});

test('chaves diferentes não se misturam', async () => {
  const cache = criarCache({ ttlMs: 60_000 });
  const buscar = buscaContada((n) => `v${n}`);
  const [a, b] = await Promise.all([cache.obter('a', buscar), cache.obter('b', buscar)]);
  assert.notEqual(a, b);
  assert.equal(buscar.chamadas, 2);
});

test('dentro do TTL a leitura seguinte não vai à rede', async () => {
  const cache = criarCache({ ttlMs: 60_000 });
  const buscar = buscaContada('v');
  await cache.obter('k', buscar);
  await cache.obter('k', buscar);
  assert.equal(buscar.chamadas, 1);
});

test('erro chega a todos os que esperavam e não fica em cache', async () => {
  const cache = criarCache({ ttlMs: 60_000 });
  let chamadas = 0;
  const falhar = async () => { chamadas += 1; await dormir(10); throw new Error('rede caiu'); };
  const r = await Promise.allSettled([cache.obter('k', falhar), cache.obter('k', falhar)]);
  assert.equal(chamadas, 1);
  assert.ok(r.every((x) => x.status === 'rejected'));
  assert.equal(await cache.obter('k', async () => 'voltou'), 'voltou', 'o erro ficou preso no cache');
});

test('guardarSe=false entrega o valor mas não guarda', async () => {
  const cache = criarCache({ ttlMs: 60_000, guardarSe: (v) => v != null });
  const buscar = buscaContada(null);
  assert.equal(await cache.obter('k', buscar), null);
  await cache.obter('k', buscar);
  assert.equal(buscar.chamadas, 2, 'um resultado inválido ficou guardado');
});

test('invalidar durante a viagem: o resultado velho não entra no cache', async () => {
  const cache = criarCache({ ttlMs: 60_000 });
  const velha = cache.obter('k', buscaContada('velho', 30));
  cache.invalidar('k');
  assert.equal(await velha, 'velho', 'quem já esperava recebe o que pediu');
  assert.equal(await cache.obter('k', async () => 'novo'), 'novo', 'o valor velho ressuscitou depois do invalidar');
});

test('definir durante a viagem: a escrita ganha da leitura que já viajava', async () => {
  const cache = criarCache({ ttlMs: 60_000 });
  const velha = cache.obter('k', buscaContada('velho', 30));
  cache.definir('k', 'gravado');
  await velha;
  assert.equal(await cache.obter('k', async () => 'rede'), 'gravado');
});

test('teto de entradas: sai a mais antiga', async () => {
  const cache = criarCache({ ttlMs: 60_000, max: 2 });
  await cache.obter('a', async () => 1);
  await cache.obter('b', async () => 2);
  await cache.obter('c', async () => 3);
  let foiARede = false;
  await cache.obter('a', async () => { foiARede = true; return 1; });
  assert.ok(foiARede, 'a entrada mais antiga devia ter saído');
});
