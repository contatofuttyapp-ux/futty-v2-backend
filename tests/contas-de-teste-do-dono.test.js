// Futty v2.0 — Quem sai na limpeza das contas de teste do dono (scripts/limpar-usuarios-teste.js --do-dono) e quem fica. Só a regra, sem banco.
//
// Uso: npm test  (ou: node --test tests/contas-de-teste-do-dono.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { separarContasDeTeste } = require('../utils/contasDeTesteDoDono');

let n = 0;
const c = (email, extra = {}) => ({ id: `id-${(n += 1)}`, email, nome: 'Alguém', nome_jogador: 'Alguém', created_at: '2026-10-05T12:00:00Z', ...extra });

test('saem os apelidos "+…" do Gmail do dono; ficam a pessoal dele, o Chavo, a demo, os revisores da Apple, os da Missa e os outros', () => {
  const teste1 = c('phferreiraborgesbackup+teste1@gmail.com');
  const teste23 = c('PhFerreiraBorgesBackup+teste23@Gmail.com', { nome: '', nome_jogador: '' });
  const pessoal = c('phferreiraborgesbackup@gmail.com');
  const chavo = c('contatofuttyapp@gmail.com', { is_super_admin: true });
  const demo = c('demo-loja@futtymock.com');
  const apple = c('abc@privaterelay.appleid.com', { nome: 'John Apple', nome_jogador: '' });
  const missaComMais = c('phferreiraborgesbackup+missa@gmail.com');
  const gente = c('wesley@gmail.com');
  const parecido = c('xphferreiraborgesbackup+teste@gmail.com');
  const slugsPorConta = new Map([[missaComMais.id, ['missa-de-quinta-ogqq6']]]);
  const r = separarContasDeTeste([teste1, teste23, pessoal, chavo, demo, apple, missaComMais, gente, parecido], { slugsPorConta });
  assert.deepEqual(r.saem.map((x) => x.email).sort(), [teste1.email, teste23.email].sort());
  assert.deepEqual(r.ficam.map((f) => [f.conta.email, f.motivo]), [[missaComMais.email, 'Membro do Missa de Quinta: o time está protegido.']]);
  assert.deepEqual(r.paraConferir, []);
});

test('as "(sem nome)" recentes aparecem para conferir e só saem com o e-mail dado pelo dono (--incluir)', () => {
  const semNome1 = c('pedro.relay1@privaterelay.appleid.com', { nome: '', nome_jogador: null, created_at: '2026-10-16T21:00:00Z' });
  const semNome2 = c('outra@gmail.com', { nome: ' ', nome_jogador: '', created_at: '2026-09-29T10:00:00Z' });
  const antiga = c('antiga@gmail.com', { nome: '', nome_jogador: '', created_at: '2026-08-01T10:00:00Z' });
  const demoSemNome = c('x@futtymock.com', { nome: '', nome_jogador: '' });
  const r = separarContasDeTeste([semNome1, semNome2, antiga, demoSemNome]);
  assert.deepEqual(r.saem, []);
  assert.deepEqual(r.paraConferir.map((x) => x.email), [semNome2.email, semNome1.email], 'da mais antiga para a mais nova; a de agosto e a da demo não');

  const r2 = separarContasDeTeste([semNome1, semNome2, antiga], { incluir: ['Pedro.Relay1@privaterelay.appleid.com', 'nao-existe@gmail.com'] });
  assert.deepEqual(r2.saem.map((x) => x.email), [semNome1.email]);
  assert.deepEqual(r2.paraConferir.map((x) => x.email), [semNome2.email]);
  assert.deepEqual(r2.incluirSemConta, ['nao-existe@gmail.com'], 'e-mail pedido que não existe é avisado, não ignorado calado');
});

test('--incluir nunca passa por cima da proteção', () => {
  const chavo = c('contatofuttyapp@gmail.com');
  const demo = c('demo-loja@futtymock.com');
  const r = separarContasDeTeste([chavo, demo], { incluir: [chavo.email, demo.email] });
  assert.deepEqual(r.saem, []);
  assert.equal(r.ficam.length, 2);
});
