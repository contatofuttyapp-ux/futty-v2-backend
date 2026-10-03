// Futty v2.0 — Rodada 29J, achado 118: "Remover logo" ao lado de "Enviar logo". Sem ela, quem subiu
// um logo não tinha volta e o editor de escudo (864 combinações) ficava inalcançável em qualquer
// time com logo — os dois times de teste tinham logo, e o escudo nunca foi validado em tela nenhuma.
//
// Uso: npm test  (ou: node --test tests/remover-logo.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');

const TIME = '11111111-1111-1111-1111-111111111111';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const MEMBRO = 'a0000000-0000-0000-0000-00000000000a';

function cenario(t, { time = {} } = {}) {
  const { carregados, tabelas } = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde', logo_url: 'https://x/logos/11111111.png?v=1', ...time }],
    users: [{ id: DONO, nome: 'Tonhão' }, { id: MEMBRO, nome: 'Zeca' }],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin' }, { team_id: TIME, user_id: MEMBRO, role: 'member' }],
  }, ['routes/teams']);
  const pedir = subir([carregados['routes/teams']], t);
  return { pedir, tabelas };
}

test('DELETE /api/teams/:slug/logo: admin apaga o logo (logo_url volta a null)', async (t) => {
  const { pedir, tabelas } = cenario(t);
  const r = await pedir('DELETE', '/api/teams/varzea-fc/logo', null, DONO);
  assert.equal(r.status, 200);
  assert.equal(tabelas.teams[0].logo_url, null);
});

test('DELETE /api/teams/:slug/logo: quem não é admin não pode (403), e o logo continua', async (t) => {
  const { pedir, tabelas } = cenario(t);
  const r = await pedir('DELETE', '/api/teams/varzea-fc/logo', null, MEMBRO);
  assert.equal(r.status, 403);
  assert.ok(tabelas.teams[0].logo_url, 'o logo não foi tocado');
});

test('DELETE /api/teams/:slug/logo: time sem logo (idempotente) e time inexistente (404)', async (t) => {
  const { pedir, tabelas } = cenario(t, { time: { logo_url: null } });
  const r = await pedir('DELETE', '/api/teams/varzea-fc/logo', null, DONO);
  assert.equal(r.status, 200);
  assert.equal(tabelas.teams[0].logo_url, null);

  const r2 = await pedir('DELETE', '/api/teams/time-que-nao-existe/logo', null, DONO);
  assert.equal(r2.status, 404);
});
