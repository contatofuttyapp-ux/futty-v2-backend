// Futty v2.0 — RODADA 30E (item 2): GET /api/super/users sai em ordem alfabética pelo nome, com 'id' de
// desempate — sem isso, duas pessoas com o mesmo nome (ou o Postgres reordenando por created_at por baixo)
// podiam repetir ou pular entre páginas, como o comentário de /api/super/teams já alertava para o 'id'.
//
// A colação exata (acento/maiúscula pt-BR) é do Intl.Collator do frontend (scripts/unidade — Gabinete,
// Pessoas); aqui só a ordem TOTAL da paginação, sem banco, sem rede.
//
// Uso: npm test  (ou: node --test tests/super-users-ordem-alfabetica.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');

const SUPER = 'super-1';

// created_at embaralhado de propósito: se a rota ainda ordenasse por created_at (como antes desta rodada),
// a ordem alfabética abaixo falharia.
function pessoas() {
  const nomes = ['Bruno', 'Ana', 'Carla', 'Eduardo', 'Diego', 'Fernanda'];
  return nomes.map((nome, i) => ({
    id: `user-${String(i).padStart(4, '0')}`,
    nome,
    email: `${nome.toLowerCase()}@futtymock.com`,
    is_super_admin: false,
    created_at: new Date(Date.UTC(2026, 0, 1) - i * 60000).toISOString(),
  }));
}

test('a lista de pessoas sai em ordem alfabética pelo nome, não pela data de criação', async (t) => {
  const { carregados } = carregar({ users: pessoas() }, ['routes/superadmin']);
  const r = await subir([carregados['routes/superadmin']], t)('GET', '/api/super/users?page=1&limit=50', null, SUPER);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.users.map((u) => u.nome), ['Ana', 'Bruno', 'Carla', 'Diego', 'Eduardo', 'Fernanda']);
});

test('a ordem é TOTAL entre páginas: ninguém repete nem some ao virar a página', async (t) => {
  const { carregados } = carregar({ users: pessoas() }, ['routes/superadmin']);
  const chamar = subir([carregados['routes/superadmin']], t);
  const p1 = await chamar('GET', '/api/super/users?page=1&limit=2', null, SUPER);
  const p2 = await chamar('GET', '/api/super/users?page=2&limit=2', null, SUPER);
  const p3 = await chamar('GET', '/api/super/users?page=3&limit=2', null, SUPER);
  const seguidos = [...p1.json.users, ...p2.json.users, ...p3.json.users].map((u) => u.nome);
  assert.deepEqual(seguidos, ['Ana', 'Bruno', 'Carla', 'Diego', 'Eduardo', 'Fernanda']);
});

test('nomes iguais desempatam por id, sempre na mesma ordem (a página não embaralha)', async (t) => {
  const empatados = [
    { id: 'user-0002', nome: 'Jota', created_at: '2026-01-01T00:00:00Z' },
    { id: 'user-0001', nome: 'Jota', created_at: '2026-01-02T00:00:00Z' },
    { id: 'user-0003', nome: 'Jota', created_at: '2026-01-03T00:00:00Z' },
  ];
  const { carregados } = carregar({ users: empatados }, ['routes/superadmin']);
  const r = await subir([carregados['routes/superadmin']], t)('GET', '/api/super/users?page=1&limit=50', null, SUPER);
  assert.deepEqual(r.json.users.map((u) => u.id), ['user-0001', 'user-0002', 'user-0003']);
});
