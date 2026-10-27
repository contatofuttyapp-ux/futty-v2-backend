// Futty v2.0 — utils/chamadaDoJogo.js, a regra pura (Rodada 32H): a hora do sorteio, a lista aberta e quem foi chamado.
//
// Uso: npm test  (ou: node --test tests/chamada-do-jogo.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../utils/chamadaDoJogo');

const AGORA = Date.parse('2026-10-29T15:00:00Z');
const H = 3600 * 1000;
const iso = (ms) => new Date(AGORA + ms).toISOString();

test('sorteio de fábrica: 1 h antes do jogo; jogo marcado em cima da hora → na hora do jogo (a lista não nasce fechada)', () => {
  assert.equal(c.sorteioPadrao(iso(5 * H), AGORA), iso(4 * H));
  assert.equal(c.sorteioPadrao(iso(30 * 60 * 1000), AGORA), iso(30 * 60 * 1000));
  assert.equal(c.sorteioPadrao('lixo', AGORA), null);
  assert.equal(c.sorteioDoJogo({ data: iso(5 * H) }), iso(4 * H), 'sem a coluna gravada: 1 h antes');
  assert.equal(c.sorteioDoJogo({ data: iso(5 * H), sorteio_em: iso(2 * H) }), iso(2 * H));
});

test('lista aberta: até a hora do sorteio (exclusiva); fecha ao sortear, ao cancelar e quando o jogo começa', () => {
  const g = { data: iso(5 * H), sorteio_em: iso(2 * H) };
  assert.equal(c.listaAberta(g, AGORA), true);
  assert.equal(c.listaAberta(g, AGORA + 2 * H - 1), true);
  assert.equal(c.listaAberta(g, AGORA + 2 * H), false, 'na hora do sorteio, fechou');
  assert.equal(c.listaAberta({ ...g, sorteio_realizado: true }, AGORA), false, 'o admin sorteou antes');
  assert.equal(c.listaAberta({ ...g, cancelado: true }, AGORA), false);
  assert.equal(c.listaAberta({ ...g, status: 'cancelado' }, AGORA), false);
  assert.equal(c.listaAberta({ data: iso(-H), sorteio_em: iso(H) }, AGORA), false, 'o jogo já começou');
  assert.equal(c.listaAberta(null, AGORA), false);
});

test('chamados: NULL = o elenco inteiro (menos quem só organiza); com lista, só os escolhidos que ainda são do time', () => {
  const elenco = ['a', 'b', 'c', 'org'];
  const org = new Set(['org']);
  assert.deepEqual(c.chamadosDoJogo({}, elenco, org), ['a', 'b', 'c']);
  assert.deepEqual(c.chamadosDoJogo({ chamados: ['b', 'saiu'] }, elenco, org), ['b']);
  assert.equal(c.foiChamado({}, 'qualquer'), true);
  assert.equal(c.foiChamado({ chamados: ['b'] }, 'a'), false);
});

test('a hora do sorteio escolhida: instante de verdade, não depois do jogo, não no passado', () => {
  assert.deepEqual(c.sorteioEscolhido(iso(H), iso(5 * H), AGORA), { iso: iso(H) });
  assert.deepEqual(c.sorteioEscolhido(iso(5 * H), iso(5 * H), AGORA), { iso: iso(5 * H) }, 'na hora do jogo vale');
  assert.match(c.sorteioEscolhido(iso(6 * H), iso(5 * H), AGORA).erro, /antes do jogo/);
  assert.match(c.sorteioEscolhido(iso(-H), iso(5 * H), AGORA).erro, /já passou/);
  assert.match(c.sorteioEscolhido('ontem', iso(5 * H), AGORA).erro, /inválida/);
});

test('o jogo mudou de hora: o sorteio de fábrica anda junto; o escolhido fica (se ainda cabe antes do jogo)', () => {
  const dataAntiga = iso(5 * H);
  const dataNova = iso(8 * H);
  assert.equal(c.sorteioAoMudarOJogo({ sorteioAntigo: null, dataAntiga, dataNova }, AGORA), iso(7 * H));
  assert.equal(c.sorteioAoMudarOJogo({ sorteioAntigo: iso(4 * H), dataAntiga, dataNova }, AGORA), iso(7 * H), 'era 1 h antes: anda');
  assert.equal(c.sorteioAoMudarOJogo({ sorteioAntigo: iso(2 * H), dataAntiga, dataNova }, AGORA), iso(2 * H), 'escolhido: fica');
  assert.equal(c.sorteioAoMudarOJogo({ sorteioAntigo: iso(2 * H), dataAntiga, dataNova: iso(H) }, AGORA), iso(H), 'o jogo novo é antes do sorteio: volta ao de fábrica (em cima da hora = na hora do jogo)');
});
