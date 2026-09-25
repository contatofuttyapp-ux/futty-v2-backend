// Rodada 28 (bloco H) — custo real por time e por mês (utils/custoPorTime.js). Sem rede.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mesEmBrasilia, custoDoTimePorMes } = require('../utils/custoPorTime');

test('o mês é o de Brasília: 01h30 UTC do dia 1º ainda é o mês anterior', () => {
  assert.equal(mesEmBrasilia('2026-10-01T01:30:00Z'), '2026-09');
  assert.equal(mesEmBrasilia('2026-10-01T03:30:00Z'), '2026-10');
  assert.equal(mesEmBrasilia('lixo'), null);
});

test('por time e por mês: gerações contadas, custo somado, sem custo à parte, mais recente primeiro', () => {
  const r = custoDoTimePorMes([
    { team_id: 'A', custo_cents: 11, created_at: '2026-09-10T15:00:00Z' },
    { team_id: 'A', custo_cents: 12, created_at: '2026-09-20T15:00:00Z' },
    { team_id: 'A', custo_cents: null, created_at: '2026-10-02T12:00:00Z' },
    { team_id: 'A', custo_cents: 14, created_at: '2026-10-03T12:00:00Z' },
    { team_id: 'B', custo_cents: 11, created_at: '2026-09-11T12:00:00Z' },
    { team_id: null, custo_cents: 99, created_at: '2026-09-11T12:00:00Z' }, // crédito, não é de time
  ]);
  assert.deepEqual(r, {
    A: [
      { mes: '2026-10', geracoes: 2, custo_usd: 0.14, sem_custo: 1 },
      { mes: '2026-09', geracoes: 2, custo_usd: 0.23, sem_custo: 0 },
    ],
    B: [{ mes: '2026-09', geracoes: 1, custo_usd: 0.11, sem_custo: 0 }],
  });
});
