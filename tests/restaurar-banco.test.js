// Manutenção 26-set (item B.6) — a lógica de restauro (utils/restauro.js), sem rede: mesmo
// padrão de tests/orfaos.test.js (lógica pura testada isolada; scripts/restaurar-banco.js só
// roda contra o Supabase real quando alguém pede). O cliente aqui é um objeto falso — nunca
// toca o Supabase de verdade.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ORDEM_TABELAS, emLotes, ordemRestauro, restaurarTabela, executarRestauro } = require('../utils/restauro');

function clienteFalso({ falharEm } = {}) {
  const chamadas = [];
  return {
    chamadas,
    from(nome) {
      return {
        upsert(lote) {
          chamadas.push({ tabela: nome, tamanho: lote.length });
          if (falharEm && falharEm.tabela === nome && chamadas.filter((c) => c.tabela === nome).length === falharEm.naChamada) {
            return Promise.resolve({ error: { message: 'upsert falhou (simulado)' } });
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

test('ordemRestauro respeita a ordem de dependência (users antes de teams antes de team_members)', () => {
  const ordem = ordemRestauro(['team_members', 'brilhantes_time', 'teams', 'users']);
  assert.deepEqual(ordem, ['users', 'teams', 'team_members', 'brilhantes_time']);
});

test('ordemRestauro com --tudo (todas as tabelas) devolve ORDEM_TABELAS inteira', () => {
  assert.deepEqual(ordemRestauro(ORDEM_TABELAS), ORDEM_TABELAS);
});

test('ordemRestauro ignora nome desconhecido (fora de ORDEM_TABELAS)', () => {
  assert.deepEqual(ordemRestauro(['users', 'tabela_que_nao_existe']), ['users']);
});

test('emLotes: 1200 linhas em lotes de 500 -> 500 + 500 + 200', () => {
  const linhas = Array.from({ length: 1200 }, (_, i) => ({ id: i }));
  const lotes = emLotes(linhas);
  assert.equal(lotes.length, 3);
  assert.deepEqual(lotes.map((l) => l.length), [500, 500, 200]);
});

test('emLotes: linhas vazias -> zero lotes', () => {
  assert.deepEqual(emLotes([]), []);
});

test('sem --gravar: restaurarTabela NÃO chama upsert, mas devolve a contagem certa', async () => {
  const cliente = clienteFalso();
  const linhas = Array.from({ length: 750 }, (_, i) => ({ id: i }));
  const r = await restaurarTabela(cliente, 'users', linhas, { gravar: false });
  assert.deepEqual(r, { tabela: 'users', linhas: 750, lotes: 2, gravado: false });
  assert.equal(cliente.chamadas.length, 0, 'simulação não pode tocar o cliente');
});

test('com --gravar: um lote por chamada de upsert, na tabela certa', async () => {
  const cliente = clienteFalso();
  const linhas = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
  const r = await restaurarTabela(cliente, 'teams', linhas, { gravar: true });
  assert.deepEqual(r, { tabela: 'teams', linhas: 1000, lotes: 2, gravado: true });
  assert.equal(cliente.chamadas.length, 2);
  assert.ok(cliente.chamadas.every((c) => c.tabela === 'teams' && c.tamanho === 500));
});

test('executarRestauro roda as tabelas pedidas na ordem de dependência', async () => {
  const cliente = clienteFalso();
  const dados = {
    team_members: [{ id: 1 }],
    users: [{ id: 1 }, { id: 2 }],
    teams: [{ id: 1 }],
  };
  const resultados = await executarRestauro(cliente, dados, { gravar: true });
  assert.deepEqual(resultados.map((r) => r.tabela), ['users', 'teams', 'team_members']);
  assert.deepEqual(cliente.chamadas.map((c) => c.tabela), ['users', 'teams', 'team_members']);
});

test('erro no meio de um lote para tudo: sai antes das tabelas seguintes, sem engolir o erro', async () => {
  // 2 lotes em 'teams' (1000 linhas / 500) — falha no 2º lote de 'teams'.
  const cliente = clienteFalso({ falharEm: { tabela: 'teams', naChamada: 2 } });
  const dados = {
    users: [{ id: 1 }],
    teams: Array.from({ length: 1000 }, (_, i) => ({ id: i })),
    team_members: [{ id: 1 }], // nunca deve rodar — vem depois de teams na ordem
  };
  await assert.rejects(
    () => executarRestauro(cliente, dados, { gravar: true }),
    /teams: upsert falhou \(simulado\)/
  );
  const tabelasChamadas = [...new Set(cliente.chamadas.map((c) => c.tabela))];
  assert.deepEqual(tabelasChamadas, ['users', 'teams'], 'team_members não pode ter rodado depois da falha em teams');
  assert.equal(cliente.chamadas.filter((c) => c.tabela === 'teams').length, 2, 'para no lote que falhou, não tenta um 3º');
});
