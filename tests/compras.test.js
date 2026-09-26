// Pagamentos P1 — a regra de crédito (utils/compras.js), sem banco.
//
// O que isto prova, tudo sobre DINHEIRO:
//   1. a Minha Figurinha credita 10 e grava UMA linha em compras;
//   2. a mesma transação duas vezes credita UMA vez (idempotência — o RevenueCat reenvia);
//   3. pacote de quem não é dono do time → erro, nada gravado, nada ligado;
//   4. manto sem pacote ativo → erro;
//   5. reembolso desfaz o crédito (nunca abaixo de 0) e só desliga o pacote que a própria
//      loja ligou, sem apagar o histórico de brilhantes_time;
//   6. a concessão do Gabinete vira linha 'gabinete' com preço 0.
//
// Uso: npm test  (ou: node --test tests/compras.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarCompras, ErroCompra, MINHA_GERACOES } = require('../utils/compras');
const { criarSupabaseFalso } = require('./_supabaseFalso');

const PESSOA = '22222222-2222-2222-2222-222222222222';
const DONO = '33333333-3333-3333-3333-333333333333';
const TIME = '11111111-1111-1111-1111-111111111111';

function montar(extra = {}, opcoes = {}) {
  const avisos = [];
  const { cliente, tabelas } = criarSupabaseFalso({
    users: [{ id: PESSOA, brilhante_creditos: 0 }, { id: DONO, brilhante_creditos: 0 }],
    teams: [{ id: TIME, nome: 'Missa de Quinta', brilhante_ativo: false, brilhante_kit: null, brilhante_origem: null }],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin' }, { team_id: TIME, user_id: PESSOA, role: 'member' }],
    pedidos_ativacao: [],
    brilhantes_time: [],
    compras: [],
    ...extra,
  }, opcoes);
  const compras = criarCompras({ supabase: cliente, notificar: (ids, payload) => avisos.push({ ids, payload }) });
  return { compras, tabelas, avisos };
}

const minha = (extra = {}) => ({ userId: PESSOA, produto: 'minha', loja: 'app_store', transacaoId: 'tx-1', precoUsd: 1.99, moeda: 'BRL', preco: 9.9, ...extra });

test('minha → +10 créditos, uma linha creditada, pedido resolvido e push ao comprador', async () => {
  const { compras, tabelas, avisos } = montar({
    pedidos_ativacao: [{ id: 'p1', user_id: PESSOA, team_id: null, produto: 'minha', estado: 'pendente' }],
  });
  const r = await compras.aplicarCompra(minha());
  assert.equal(r.repetida, false);
  assert.equal(r.creditos, MINHA_GERACOES);
  assert.equal(MINHA_GERACOES, 10);
  assert.equal(tabelas.users.find((u) => u.id === PESSOA).brilhante_creditos, 10);
  assert.equal(tabelas.compras.length, 1);
  assert.equal(tabelas.compras[0].estado, 'creditada');
  assert.ok(tabelas.compras[0].creditada_em, 'creditada_em marcado depois do efeito');
  assert.equal(tabelas.pedidos_ativacao[0].estado, 'ativado');
  assert.deepEqual(avisos[0].ids, [PESSOA]);
});

test('a MESMA transação duas vezes credita uma vez só', async () => {
  const { compras, tabelas } = montar();
  await compras.aplicarCompra(minha());
  const r2 = await compras.aplicarCompra(minha());
  assert.equal(r2.repetida, true);
  assert.equal(tabelas.users.find((u) => u.id === PESSOA).brilhante_creditos, 10, 'nada de crédito em dobro');
  assert.equal(tabelas.compras.length, 1);
});

test('a corrida (a linha aparece entre a leitura e a gravação) também não credita em dobro', async () => {
  // Simula a outra entrega a gravar primeiro: a leitura não vê nada, o insert bate no índice.
  let primeiraLeitura = true; // a leitura passou vazia; a outra grava bem antes do nosso insert
  const { compras, tabelas } = montar({}, {
    falhar: (tabela, op) => {
      if (tabela === 'compras' && op === 'insert' && primeiraLeitura) {
        primeiraLeitura = false;
        tabelas.compras.push({ id: 'outra', loja: 'app_store', transacao_id: 'tx-1', produto: 'minha', estado: 'creditada' });
      }
      return null;
    },
  });
  const r = await compras.aplicarCompra(minha());
  assert.equal(r.repetida, true);
  assert.equal(tabelas.users.find((u) => u.id === PESSOA).brilhante_creditos, 0);
});

test('pacote do DONO liga o time com a origem da loja e avisa os membros quando já há uniforme', async () => {
  const { compras, tabelas, avisos } = montar({
    teams: [{ id: TIME, nome: 'Missa de Quinta', brilhante_ativo: false, brilhante_kit: 'dark-gold', brilhante_origem: null }],
    pedidos_ativacao: [{ id: 'p2', user_id: DONO, team_id: TIME, produto: 'pacote', estado: 'pendente' }],
  });
  const r = await compras.aplicarCompra({ userId: DONO, teamId: TIME, produto: 'pacote', loja: 'play_store', transacaoId: 'GPA.1' });
  assert.equal(r.kitId, 'dark-gold');
  const t = tabelas.teams[0];
  assert.equal(t.brilhante_ativo, true);
  assert.equal(t.brilhante_origem, 'play_store');
  assert.ok(t.brilhante_ativado_em);
  assert.equal(tabelas.pedidos_ativacao[0].estado, 'ativado');
  assert.deepEqual(avisos[0].ids.sort(), [DONO, PESSOA].sort());
});

test('pacote sem uniforme escolhido liga com kit null e avisa só o dono', async () => {
  const { compras, tabelas, avisos } = montar();
  const r = await compras.aplicarCompra({ userId: DONO, teamId: TIME, produto: 'pacote', loja: 'app_store', transacaoId: 'tx-p' });
  assert.equal(r.kitId, null);
  assert.equal(tabelas.teams[0].brilhante_ativo, true);
  assert.equal(tabelas.teams[0].brilhante_kit, null);
  assert.deepEqual(avisos[0].ids, [DONO]);
});

test('pacote de quem NÃO é dono → NAO_E_DONO, nada gravado e o time fica desligado', async () => {
  const { compras, tabelas } = montar();
  await assert.rejects(
    compras.aplicarCompra({ userId: PESSOA, teamId: TIME, produto: 'pacote', loja: 'app_store', transacaoId: 'tx-x' }),
    (e) => e instanceof ErroCompra && e.codigo === 'NAO_E_DONO',
  );
  assert.equal(tabelas.compras.length, 0);
  assert.equal(tabelas.teams[0].brilhante_ativo, false);
});

test('pacote sem time → SEM_TIME', async () => {
  const { compras } = montar();
  await assert.rejects(
    compras.aplicarCompra({ userId: DONO, produto: 'pacote', loja: 'app_store', transacaoId: 'tx-y' }),
    (e) => e.codigo === 'SEM_TIME',
  );
});

test('manto sem pacote ativo → SEM_PACOTE; com pacote grava e deixa o pedido pendente', async () => {
  const { compras, tabelas } = montar({
    pedidos_ativacao: [{ id: 'p3', user_id: DONO, team_id: TIME, produto: 'manto', estado: 'pendente' }],
  });
  await assert.rejects(
    compras.aplicarCompra({ userId: DONO, teamId: TIME, produto: 'manto', loja: 'app_store', transacaoId: 'tx-m' }),
    (e) => e.codigo === 'SEM_PACOTE',
  );
  assert.equal(tabelas.compras.length, 0);

  tabelas.teams[0].brilhante_ativo = true;
  await compras.aplicarCompra({ userId: DONO, teamId: TIME, produto: 'manto', loja: 'app_store', transacaoId: 'tx-m' });
  assert.equal(tabelas.compras.length, 1);
  assert.equal(tabelas.teams[0].manto_proprio, undefined, 'o manto continua manual (fase 2)');
  assert.equal(tabelas.pedidos_ativacao[0].estado, 'pendente', 'o pedido do manto fica para o dono aprovar');
});

test('reembolso da minha desconta 10, nunca abaixo de 0, e é idempotente', async () => {
  const { compras, tabelas } = montar();
  await compras.aplicarCompra(minha());
  tabelas.users.find((u) => u.id === PESSOA).brilhante_creditos = 3; // gastou 7
  const r = await compras.reembolsar({ loja: 'app_store', transacaoId: 'tx-1' });
  assert.equal(r.repetida, false);
  assert.equal(tabelas.users.find((u) => u.id === PESSOA).brilhante_creditos, 0);
  assert.equal(tabelas.compras[0].estado, 'reembolsada');
  const r2 = await compras.reembolsar({ loja: 'app_store', transacaoId: 'tx-1' });
  assert.equal(r2.repetida, true);
  assert.deepEqual(await compras.reembolsar({ loja: 'app_store', transacaoId: 'nao-existe' }), { encontrada: false });
});

test('reembolso do pacote desliga só o que a própria loja ligou e nunca apaga brilhantes_time', async () => {
  const { compras, tabelas } = montar({
    brilhantes_time: [{ team_id: TIME, user_id: PESSOA, geracoes: 2 }],
  });
  await compras.aplicarCompra({ userId: DONO, teamId: TIME, produto: 'pacote', loja: 'app_store', transacaoId: 'tx-p' });
  const r = await compras.reembolsar({ loja: 'app_store', transacaoId: 'tx-p' });
  assert.equal(r.pacoteDesligado, true);
  assert.equal(tabelas.teams[0].brilhante_ativo, false);
  assert.equal(tabelas.brilhantes_time.length, 1, 'o histórico fica');

  // O Gabinete religou depois: um reembolso atrasado de outra compra da loja não desliga.
  const outro = montar();
  await outro.compras.aplicarCompra({ userId: DONO, teamId: TIME, produto: 'pacote', loja: 'app_store', transacaoId: 'tx-p' });
  outro.tabelas.teams[0].brilhante_origem = 'gabinete';
  const r2 = await outro.compras.reembolsar({ loja: 'app_store', transacaoId: 'tx-p' });
  assert.equal(r2.pacoteDesligado, false);
  assert.equal(outro.tabelas.teams[0].brilhante_ativo, true);
});

test('Gabinete: quantidade livre, kit escolhido e preço 0; sem dono exigido', async () => {
  const { compras, tabelas } = montar();
  const r = await compras.aplicarCompra({ userId: PESSOA, produto: 'minha', loja: 'gabinete', transacaoId: 'gab-1', quantidade: 3, preco: 0, precoUsd: 0 });
  assert.equal(r.creditos, 3);
  const p = await compras.aplicarCompra({ userId: PESSOA, teamId: TIME, produto: 'pacote', loja: 'gabinete', transacaoId: 'gab-2', kitId: 'dark-purple' });
  assert.equal(p.kitId, 'dark-purple');
  assert.equal(tabelas.teams[0].brilhante_origem, 'gabinete');
  assert.equal(tabelas.compras.filter((c) => c.loja === 'gabinete').length, 2);
});

test('na LOJA a quantidade e o kit do corpo são ignorados (a Minha dá sempre 10)', async () => {
  const { compras } = montar();
  const r = await compras.aplicarCompra(minha({ quantidade: 25 }));
  assert.equal(r.creditos, 10);
});

test('Gabinete sem a 064 (tabela em falta) credita na mesma; a loja NÃO', async () => {
  const semTabela = (tabela) => (tabela === 'compras' ? { code: 'PGRST205', message: "Could not find the table 'public.compras' in the schema cache" } : null);
  const g = montar({}, { falhar: semTabela });
  const r = await g.compras.aplicarCompra({ userId: PESSOA, produto: 'minha', loja: 'gabinete', transacaoId: 'gab-1', quantidade: 2 });
  assert.equal(r.creditos, 2);
  assert.equal(r.compraId, null);

  const l = montar({}, { falhar: semTabela });
  await assert.rejects(l.compras.aplicarCompra(minha()), /compras/);
  assert.equal(l.tabelas.users.find((u) => u.id === PESSOA).brilhante_creditos, 0);
});

test('se o crédito falha, a linha é apagada (o reenvio da loja consegue creditar)', async () => {
  const { compras, tabelas } = montar({}, { semRpc: true, falhar: (tabela, op) => (tabela === 'users' && op === 'update' ? { message: 'banco fora do ar' } : null) });
  await assert.rejects(compras.aplicarCompra(minha()), /fora do ar/);
  assert.equal(tabelas.compras.length, 0);
});
