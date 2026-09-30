// Futty v2.0 — RODADA 29B (E): o papel "Eu jogo" / "Só organizo o time" nas rotas de equipa (sem banco, sem rede).
//
//   · POST /api/teams com `joga: false` cria o time com o criador só organizando (e cai de pé sem a migração 067);
//   · PATCH /api/equipas/:slug/membros/joga muda o papel da própria pessoa (só admin pode ficar só organizando);
//   · GET /api/teams/:slug marca quem só organiza (membros e o próprio `team.joga`);
//   · o Início sabe (`joga` por time, `eu_jogo` por jogo) para esconder o "Vou / Não vou";
//   · o convite conta "N jogadores" sem quem só organiza.
//
// Uso: npm test  (ou: node --test tests/teams-joga-rota.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');

const TIME = '11111111-1111-1111-1111-111111111111';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const MEMBRO = 'a0000000-0000-0000-0000-00000000000a';
const FUTURO = new Date(Date.now() + 86400000).toISOString();
const usuario = (id, nome) => ({ id, nome, nome_jogador: nome, avatar_url: null });

function cenario(t, { membros, falhar = null } = {}) {
  const { carregados, tabelas } = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde' }],
    users: [{ id: DONO, nome: 'Tonhão' }],
    team_members: membros || [
      { team_id: TIME, user_id: DONO, role: 'admin', users: usuario(DONO, 'Tonhão') },
      { team_id: TIME, user_id: MEMBRO, role: 'member', users: usuario(MEMBRO, 'Magrão') },
    ],
  }, ['routes/teams', 'services/inicio'], { falhar });
  const pedir = subir([carregados['routes/teams']], t);
  return { pedir, tabelas, inicio: carregados['services/inicio'] };
}
const linhaDe = (tabelas, userId) => tabelas.team_members.find((m) => m.user_id === userId);

// ─── PATCH /api/equipas/:slug/membros/joga ────────────────────────────────────
test('o admin passa a só organizar e volta a jogar (muda o SEU papel)', async (t) => {
  const { pedir, tabelas } = cenario(t);
  const a = await pedir('PATCH', '/api/equipas/varzea-fc/membros/joga', { joga: false }, DONO);
  assert.deepEqual([a.status, a.json], [200, { ok: true, joga: false }]);
  assert.equal(linhaDe(tabelas, DONO).joga, false);
  assert.equal(linhaDe(tabelas, MEMBRO).joga, undefined, 'o papel dos outros nunca muda');
  const b = await pedir('PATCH', '/api/equipas/varzea-fc/membros/joga', { joga: true }, DONO);
  assert.deepEqual([b.status, b.json], [200, { ok: true, joga: true }]);
  assert.equal(linhaDe(tabelas, DONO).joga, true);
});

test('só quem administra o time pode ficar só organizando; voltar a jogar é de qualquer um', async (t) => {
  const { pedir, tabelas } = cenario(t, {
    membros: [
      { team_id: TIME, user_id: DONO, role: 'admin', users: usuario(DONO, 'Tonhão') },
      { team_id: TIME, user_id: MEMBRO, role: 'member', joga: false, users: usuario(MEMBRO, 'Magrão') },
    ],
  });
  const nega = await pedir('PATCH', '/api/equipas/varzea-fc/membros/joga', { joga: false }, MEMBRO);
  assert.equal(nega.status, 403);
  assert.match(nega.json.error, /administra/);
  const volta = await pedir('PATCH', '/api/equipas/varzea-fc/membros/joga', { joga: true }, MEMBRO);
  assert.equal(volta.status, 200);
  assert.equal(linhaDe(tabelas, MEMBRO).joga, true);
});

test('o corpo precisa dizer joga: true ou false; quem não é do time não mexe', async (t) => {
  const { pedir } = cenario(t);
  assert.equal((await pedir('PATCH', '/api/equipas/varzea-fc/membros/joga', {}, DONO)).status, 400);
  assert.equal((await pedir('PATCH', '/api/equipas/varzea-fc/membros/joga', { joga: 'false' }, DONO)).status, 400);
  assert.equal((await pedir('PATCH', '/api/equipas/varzea-fc/membros/joga', { joga: false }, 'de-fora')).status, 403);
  assert.equal((await pedir('PATCH', '/api/equipas/varzea-fc/membros/joga', { joga: false }, null)).status, 401);
});

test('sem a migração 067 a troca diz "essa opção ainda não está disponível" (503), sem derrubar nada', async (t) => {
  const falhar = (tabela, op, e) => (tabela === 'team_members' && op === 'update' && 'joga' in (e.patch || {}) ? { message: 'column "joga" of relation "team_members" does not exist' } : null);
  const { pedir } = cenario(t, { falhar });
  const r = await pedir('PATCH', '/api/equipas/varzea-fc/membros/joga', { joga: false }, DONO);
  assert.equal(r.status, 503);
  assert.match(r.json.error, /ainda não está disponível/);
});

// ─── POST /api/teams ──────────────────────────────────────────────────────────
function cenarioCriar(t, { falhar = null } = {}) {
  const { carregados, tabelas } = carregar({ teams: [], users: [{ id: DONO, nome: 'Tonhão' }], team_members: [] }, ['routes/teams'], { falhar });
  return { pedir: subir([carregados['routes/teams']], t), tabelas };
}

test('criar o time com "Só organizo": o criador entra como admin com joga = false', async (t) => {
  const { pedir, tabelas } = cenarioCriar(t);
  const r = await pedir('POST', '/api/teams', { nome: 'Time do Organizador', joga: false }, DONO);
  assert.equal(r.status, 201);
  assert.equal(r.json.joga, false);
  assert.deepEqual([tabelas.team_members[0].user_id, tabelas.team_members[0].role, tabelas.team_members[0].joga], [DONO, 'admin', false]);
});

test('criar o time sem dizer nada (ou com "Eu jogo"): o criador joga, como sempre foi', async (t) => {
  const { pedir, tabelas } = cenarioCriar(t);
  const a = await pedir('POST', '/api/teams', { nome: 'Time Um' }, DONO);
  const b = await pedir('POST', '/api/teams', { nome: 'Time Dois', joga: true }, DONO);
  assert.equal(a.json.joga, true);
  assert.equal(b.json.joga, true);
  assert.ok(tabelas.team_members.every((m) => !('joga' in m) || m.joga === true));
});

test('criar com "Só organizo" sem a migração 067: o time nasce (o criador joga) e a resposta diz joga: true', async (t) => {
  const falhar = (tabela, op, e) => (tabela === 'team_members' && op === 'insert' && e.linhas.some((l) => 'joga' in l) ? { message: "Could not find the 'joga' column of 'team_members' in the schema cache" } : null);
  const { pedir, tabelas } = cenarioCriar(t, { falhar });
  const r = await pedir('POST', '/api/teams', { nome: 'Time Sem 067', joga: false }, DONO);
  assert.equal(r.status, 201, 'o time não deixa de ser criado por causa da coluna que falta');
  assert.equal(r.json.joga, true, 'a tela pode avisar que o papel não foi gravado');
  assert.equal(tabelas.teams.length, 1);
  assert.equal(tabelas.team_members.length, 1);
});

// ─── GET /api/teams/:slug ─────────────────────────────────────────────────────
test('a página do time marca quem só organiza, e diz se quem abre joga', async (t) => {
  const { pedir } = cenario(t, {
    membros: [
      { team_id: TIME, user_id: DONO, role: 'admin', joga: false, users: usuario(DONO, 'Tonhão') },
      { team_id: TIME, user_id: MEMBRO, role: 'member', users: usuario(MEMBRO, 'Magrão') },
    ],
  });
  const dono = (await pedir('GET', '/api/teams/varzea-fc', null, DONO)).json;
  assert.equal(dono.team.joga, false);
  assert.deepEqual(dono.members.map((m) => [m.id, m.joga]), [[DONO, false], [MEMBRO, true]]);
  const membro = (await pedir('GET', '/api/teams/varzea-fc', null, MEMBRO)).json;
  assert.equal(membro.team.joga, true);
});

test('a página do time sem a migração 067: todo mundo joga e nada quebra', async (t) => {
  // A coluna `joga` não existe: SÓ a leitura que a filtra falha (a listagem de membros não a usa).
  const falhar = (tabela, op, e) => (tabela === 'team_members' && op === 'select' && e.colunas?.includes('joga') ? { message: 'column team_members.joga does not exist' } : null);
  const { pedir } = cenario(t, { falhar });
  const r = (await pedir('GET', '/api/teams/varzea-fc', null, DONO)).json;
  assert.equal(r.team.joga, true);
  assert.ok(r.members.every((m) => m.joga === true));
});

// ─── o Início ─────────────────────────────────────────────────────────────────
test('Início: `joga` por time e `eu_jogo` por jogo (a tela esconde o "Vou / Não vou" de quem só organiza)', async (t) => {
  const { carregados } = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde' }, { id: 'time2', nome: 'Missa', slug: 'missa', cor: 'azul' }],
    team_members: [
      { team_id: TIME, user_id: DONO, role: 'admin', joga: false, teams: { id: TIME, nome: 'Várzea FC', slug: 'varzea-fc' } },
      { team_id: 'time2', user_id: DONO, role: 'member', teams: { id: 'time2', nome: 'Missa', slug: 'missa' } },
    ],
    games: [
      { id: 'g1', team_id: TIME, data: FUTURO, status: 'agendado', local: 'Quadra', game_players: [] },
      { id: 'g2', team_id: 'time2', data: FUTURO, status: 'agendado', local: 'Campo', game_players: [] },
    ],
  }, ['services/inicio']);
  const inicio = carregados['services/inicio'];
  const { teams } = await inicio.obterTeams(DONO);
  assert.deepEqual(teams.map((x) => [x.slug, x.joga]).sort(), [['missa', true], ['varzea-fc', false]]);
  const { games } = await inicio.obterConvites(DONO);
  assert.deepEqual(games.map((g) => [g.team_slug, g.eu_jogo]).sort(), [['missa', true], ['varzea-fc', false]]);
});
