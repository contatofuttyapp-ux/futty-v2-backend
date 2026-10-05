// Futty v2.0 — RODADA 29Y (2): GET /api/super/teams conta certo acima de 1.000 linhas (sem banco, sem rede).
//
// O Supabase corta cada resposta em 1.000 linhas. A lista de equipas e a contagem de membros saíam numa consulta sem paginação:
// passado o milésimo vínculo, "Membros" e a ordem por membros mentiam calados. Aqui o Supabase falso tem o MESMO teto
// (tetoLinhas: 1000) e prova:
//   · o teto é real no falso: a consulta ingênua devolve 1.000 (senão este teste não provaria nada);
//   · cada equipa sai com a contagem exata do banco inteiro (2.350 vínculos em 3 equipas, uma com 1.700);
//   · a lista passa do milésimo time: a equipa de número 1.003 aparece, com a contagem certa;
//   · exatamente 2.000 vínculos (duas páginas cheias) não entram em loop nem perdem a última página.
//
// Uso: npm test  (ou: node --test tests/superadmin-contagem.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');

const TETO = 1000;
const SUPER = 'super-1';

// Equipas com ids em ordem (zero à esquerda) e created_at DECRESCENTE: a de índice 0 é a mais nova, como a rota devolve.
function equipas(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `team-${String(i).padStart(4, '0')}`,
    slug: `time-${i}`,
    nome: `Time ${i}`,
    created_at: new Date(Date.UTC(2026, 0, 1) - i * 60000).toISOString(),
  }));
}

// Vínculos a partir de [[teamId, quantos], …]; ids com zero à esquerda, para a ordem por id ser a ordem de inserção.
function vinculos(porTime) {
  const linhas = [];
  let n = 0;
  for (const [team_id, quantos] of porTime) {
    for (let k = 0; k < quantos; k += 1) {
      n += 1;
      linhas.push({ id: `vinc-${String(n).padStart(6, '0')}`, team_id, user_id: `user-${n}` });
    }
  }
  return linhas;
}

function rotaComTeto(tabelas) {
  const { carregados, cliente } = carregar(tabelas, ['routes/superadmin'], { tetoLinhas: TETO });
  return { cliente, router: carregados['routes/superadmin'] };
}

test('a lista passa do milésimo time e a contagem bate com o banco inteiro (não só com as primeiras 1.000 linhas)', async (t) => {
  const TIMES = equipas(1003);
  const tabelas = {
    teams: TIMES,
    team_members: vinculos([[TIMES[0].id, 1700], [TIMES[1].id, 500], [TIMES[1002].id, 150]]), // 2.350 vínculos
  };
  const { cliente, router } = rotaComTeto(tabelas);

  // Sem paginação a consulta de sempre cortaria em 1.000: o teto está no falso de verdade, não só no comentário.
  const ingenua = await cliente.from('team_members').select('team_id');
  assert.equal(ingenua.data.length, TETO, 'o Supabase falso corta em 1.000 linhas por resposta');

  const r = await subir([router], t)('GET', '/api/super/teams', null, SUPER);
  assert.equal(r.status, 200);
  assert.equal(r.json.teams.length, 1003, 'todas as equipas, não só as primeiras 1.000');

  const porId = Object.fromEntries(r.json.teams.map((x) => [x.id, x]));
  assert.equal(porId[TIMES[0].id].nr_membros, 1700);
  assert.equal(porId[TIMES[1].id].nr_membros, 500);
  assert.equal(porId[TIMES[500].id].nr_membros, 0, 'equipa sem vínculo continua com 0');
  assert.equal(porId[TIMES[1002].id].nr_membros, 150, 'a equipa que fica depois do milésimo sai com a contagem certa');
  assert.equal(r.json.teams.reduce((soma, x) => soma + x.nr_membros, 0), 2350, 'nenhum vínculo some nem se repete entre páginas');
  assert.deepEqual(r.json.teams.map((x) => x.id), TIMES.map((x) => x.id), 'a ordem de criação é a da tabela, página após página');
});

test('exatamente 2.000 vínculos (duas páginas cheias): a terceira vem vazia e a leitura para', async (t) => {
  const TIMES = equipas(1);
  const { router } = rotaComTeto({ teams: TIMES, team_members: vinculos([[TIMES[0].id, 2000]]) });

  const r = await subir([router], t)('GET', '/api/super/teams', null, SUPER);
  assert.equal(r.status, 200);
  assert.equal(r.json.teams[0].nr_membros, 2000);
});
