// Futty v2.0 — RODADA 30B (decisão do dono): convidado sem app entra no sorteio com nota 3, não 0.
//
// Com 0 o convidado caía quase sempre na reserva (o snake draft põe os piores por último). Sem histórico nenhum,
// ele fica igual a quem tem conta e ainda não recebeu voto: RATING_DEFAULT. O resto da conta do sorteio não muda.
//
// Uso: npm test  (ou: node --test tests/convidado-nota.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { executarSorteio } = require('../utils/sorteio');
const { RATING_DEFAULT } = require('../utils/helpers');

const membro = (id, rating = RATING_DEFAULT) => ({ user_id: id, nome: id, rating, goleiro: false, cabeca_chave: false });

test('o convidado entra com a nota de quem ainda não tem voto (3), não com 0', () => {
  assert.equal(RATING_DEFAULT, 3);
  const r = executarSorteio([membro('a'), membro('b'), membro('c')], 2, { seed: 1, convidados: ['Beto'] });
  const beto = [...r.times.flat(), ...r.reservas].find((j) => j.nome === 'Beto');
  assert.equal(beto.rating, 3);
  assert.equal(beto.convidado, true);
  assert.equal(beto.user_id, null);
});

test('com todos sem voto, o convidado não vai para a reserva por ser convidado (em 200 sorteios, entra em vários)', () => {
  let noTime = 0;
  for (let seed = 1; seed <= 200; seed += 1) {
    // 4 membros sem voto + 1 convidado, 2 por time: sobra 1 na reserva — antes, sempre o convidado.
    const r = executarSorteio([membro('a'), membro('b'), membro('c'), membro('d')], 2, { seed, convidados: ['Beto'] });
    if (r.times.flat().some((j) => j.nome === 'Beto')) noTime += 1;
  }
  assert.ok(noTime > 100, `o convidado entrou num time em ${noTime} de 200 sorteios`);
});

test('o mesmo seed continua dando o mesmo resultado (replay exato)', () => {
  const um = executarSorteio([membro('a'), membro('b'), membro('c'), membro('d')], 2, { seed: 77, convidados: ['Beto', 'Caio'] });
  const dois = executarSorteio([membro('a'), membro('b'), membro('c'), membro('d')], 2, { seed: 77, convidados: ['Beto', 'Caio'] });
  assert.deepEqual(um, dois);
});
