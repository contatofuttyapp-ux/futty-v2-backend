// Futty v2.0 — RODADA 29I, bloco 3 (achado 102 + bancadas do dono): o escudo do time sem logo e o padrão de jogadores por time.
//
// UM controle, "Escudo do time": cor principal (teams.cor) + segunda cor + padrão, da paleta FIXA de 12 e dos 6 padrões aprovados.
// Sem banco e sem rede (Supabase falso em memória). O que se prova:
//   · a validação pura (utils/escudo.js): as 12 cores, as 4 antigas (a 'verde' de sempre é roxo), os 6 padrões; RGB livre e os
//     padrões reprovados pelo dono (quadriculado, listras finas, pontinhos, gradiente) recusados;
//   · PATCH /api/teams/:slug grava o escudo e o padrão de jogadores por time; valor fora da paleta = 400;
//   · sem a migração 077 (regra antiga da cor, colunas ausentes) ou sem a 079: 503 "Essa opção ainda não está disponível." — e o
//     resto do time segue igual;
//   · GET do time e Explorar levam o escudo (null = sólido) e o padrão (5 sem a 079);
//   · o "Novo jogo" sem número nasce com o padrão do time; com número, é o "mudar só neste jogo".
//
// Uso: npm test  (ou: node --test tests/escudo-do-time.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');
const { PALETA, PADROES, lerEscudo } = require('../utils/escudo');
const { lerJogadoresPorTime, jogadoresPorTimeDoTime } = require('../utils/jogadoresPorTime');

const TIME = '11111111-1111-1111-1111-111111111111';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const MEMBRO = 'a0000000-0000-0000-0000-00000000000a';

const CORES_ANTES_DA_077 = ['verde', 'azul', 'vermelho', 'preto'];
// O banco de verdade sem a 077: a regra antiga da cor e as colunas novas ausentes; sem a 079, a coluna do padrão também.
const semMigracao = ({ sem077 = true, sem079 = false } = {}) => (tabela, op, e) => {
  if (tabela !== 'teams' || op !== 'update') return null;
  if (sem077 && 'cor' in e.patch && !CORES_ANTES_DA_077.includes(e.patch.cor)) {
    return { code: '23514', message: 'new row for relation "teams" violates check constraint "teams_cor_check"' };
  }
  if (sem077 && ('escudo_cor2' in e.patch || 'escudo_padrao' in e.patch)) {
    return { code: 'PGRST204', message: "Could not find the 'escudo_cor2' column of 'teams' in the schema cache" };
  }
  if (sem079 && 'jogadores_por_time' in e.patch) {
    return { code: 'PGRST204', message: "Could not find the 'jogadores_por_time' column of 'teams' in the schema cache" };
  }
  return null;
};

function cenario(t, { time = {}, falhar = null } = {}) {
  const { carregados, tabelas } = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde', modo_visibilidade: 'publico_aprovacao', ...time }],
    users: [{ id: DONO, nome: 'Tonhão' }, { id: MEMBRO, nome: 'Zeca' }],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin' }, { team_id: TIME, user_id: MEMBRO, role: 'member' }],
  }, ['routes/teams', 'routes/games'], { falhar });
  const pedir = subir([carregados['routes/teams'], carregados['routes/games']], t);
  return { pedir, tabelas };
}

test('a paleta e os padrões são os aprovados pelo dono — 12 × 12 × 6 = 864 escudos', () => {
  assert.deepEqual(PALETA, ['roxo', 'azul', 'ciano', 'gramado', 'lima', 'ouro', 'laranja', 'vermelho', 'rosa', 'vinho', 'grafite', 'preto']);
  assert.deepEqual(PADROES, ['solido', 'faixa', 'metade', 'listras', 'barra', 'aro']);
  assert.equal(PALETA.length * PALETA.length * PADROES.length, 864);
});

test('lerEscudo: aceita a paleta e as 4 cores antigas; recusa RGB livre e os padrões reprovados; "sólido" guarda null', () => {
  assert.deepEqual(lerEscudo({ cor: 'gramado', escudo_cor2: 'ouro', escudo_padrao: 'faixa' }), { patch: { cor: 'gramado', escudo_cor2: 'ouro', escudo_padrao: 'faixa' }, erro: null });
  assert.deepEqual(lerEscudo({ cor: 'verde' }).patch, { cor: 'verde' }, 'a chave antiga (roxo na tela) continua valendo');
  assert.deepEqual(lerEscudo({ escudo_padrao: 'solido', escudo_cor2: '' }).patch, { escudo_padrao: null, escudo_cor2: null });
  assert.deepEqual(lerEscudo({}).patch, {}, 'só entra no patch o que veio no corpo');
  for (const cor of ['#ff0000', 'rgb(1,2,3)', 'magenta', '']) assert.ok(lerEscudo({ cor }).erro, `cor ${cor} recusada`);
  assert.ok(lerEscudo({ escudo_cor2: 'verde' }).erro, "a segunda cor é só da paleta nova ('verde' é a chave antiga)");
  for (const p of ['quadriculado', 'listras_finas', 'pontinhos', 'gradiente']) assert.ok(lerEscudo({ escudo_padrao: p }).erro, `${p} reprovado pelo dono`);
});

test('jogadores por time: 2 a 11; vazio volta ao padrão; o time sem padrão (ou sem a 079) vale 5', () => {
  assert.equal(lerJogadoresPorTime(7), 7);
  assert.equal(lerJogadoresPorTime('11'), 11);
  assert.equal(lerJogadoresPorTime(null), null);
  assert.equal(lerJogadoresPorTime(''), null);
  for (const v of [1, 12, 5.5, 'cinco']) assert.equal(lerJogadoresPorTime(v), undefined, `${v} é inválido`);
  assert.equal(jogadoresPorTimeDoTime({}), 5);
  assert.equal(jogadoresPorTimeDoTime({ jogadores_por_time: null }), 5);
  assert.equal(jogadoresPorTimeDoTime({ jogadores_por_time: 7 }), 7);
});

test('PATCH grava o escudo (cor + segunda cor + padrão) e o padrão de jogadores por time; a resposta já leva tudo', async (t) => {
  const { pedir, tabelas } = cenario(t);
  const r = await pedir('PATCH', '/api/teams/varzea-fc', { cor: 'vinho', escudo_cor2: 'ouro', escudo_padrao: 'listras', jogadores_por_time: 6 }, DONO);
  assert.equal(r.status, 200);
  assert.equal(r.json.team.cor, 'vinho');
  assert.equal(r.json.team.escudo_cor2, 'ouro');
  assert.equal(r.json.team.escudo_padrao, 'listras');
  assert.equal(r.json.team.jogadores_por_time, 6);
  assert.deepEqual(
    (({ cor, escudo_cor2: c2, escudo_padrao: p, jogadores_por_time: j }) => ({ cor, c2, p, j }))(tabelas.teams[0]),
    { cor: 'vinho', c2: 'ouro', p: 'listras', j: 6 },
  );
  // Voltar ao sólido de uma cor: segunda cor e padrão ficam null.
  const r2 = await pedir('PATCH', '/api/teams/varzea-fc', { escudo_cor2: null, escudo_padrao: 'solido' }, DONO);
  assert.equal(r2.status, 200);
  assert.equal(r2.json.team.escudo_cor2, null);
  assert.equal(r2.json.team.escudo_padrao, null);
});

test('PATCH: cor fora da paleta, padrão reprovado ou 12 por time = 400; quem não é admin = 403', async (t) => {
  const { pedir, tabelas } = cenario(t);
  assert.equal((await pedir('PATCH', '/api/teams/varzea-fc', { cor: '#123456' }, DONO)).status, 400);
  assert.equal((await pedir('PATCH', '/api/teams/varzea-fc', { escudo_padrao: 'quadriculado' }, DONO)).status, 400);
  assert.equal((await pedir('PATCH', '/api/teams/varzea-fc', { jogadores_por_time: 12 }, DONO)).status, 400);
  assert.equal((await pedir('PATCH', '/api/teams/varzea-fc', { cor: 'azul' }, MEMBRO)).status, 403);
  assert.equal(tabelas.teams[0].cor, 'verde', 'nada mudou');
});

test('sem a migração 077: cor nova, segunda cor ou padrão = 503 com a frase da casa; as 4 cores antigas seguem gravando', async (t) => {
  const { pedir, tabelas } = cenario(t, { falhar: semMigracao({ sem077: true }) });
  for (const corpo of [{ cor: 'ciano' }, { escudo_cor2: 'ouro' }, { escudo_padrao: 'aro' }]) {
    const r = await pedir('PATCH', '/api/teams/varzea-fc', corpo, DONO);
    assert.equal(r.status, 503, JSON.stringify(corpo));
    assert.equal(r.json.error, 'Essa opção ainda não está disponível.');
  }
  const r = await pedir('PATCH', '/api/teams/varzea-fc', { cor: 'azul', nome: 'Várzea FC 2' }, DONO);
  assert.equal(r.status, 200);
  assert.equal(tabelas.teams[0].cor, 'azul');
  assert.equal(r.json.team.escudo_padrao, null, 'sem a 077 o escudo vale sólido');
});

test('sem a migração 079: o padrão de jogadores por time = 503; o "Novo jogo" sem número nasce com 5', async (t) => {
  const { pedir, tabelas } = cenario(t, { falhar: semMigracao({ sem077: false, sem079: true }) });
  const r = await pedir('PATCH', '/api/teams/varzea-fc', { jogadores_por_time: 7 }, DONO);
  assert.equal(r.status, 503);
  const jogo = await pedir('POST', '/api/games', { team_slug: 'varzea-fc', data: '2026-10-08T23:00:00Z' }, DONO);
  assert.equal(jogo.status, 201);
  assert.equal(tabelas.games[0].jogadores_por_time, 5);
});

test('o "Novo jogo" sem número nasce com o padrão do time; com número, "mudar só neste jogo" vale para ele', async (t) => {
  const { pedir, tabelas } = cenario(t, { time: { jogadores_por_time: 7 } });
  assert.equal((await pedir('POST', '/api/games', { team_slug: 'varzea-fc', data: '2026-10-08T23:00:00Z' }, DONO)).status, 201);
  assert.equal((await pedir('POST', '/api/games', { team_slug: 'varzea-fc', data: '2026-10-15T23:00:00Z', jogadores_por_time: 6 }, DONO)).status, 201);
  assert.deepEqual(tabelas.games.map((g) => g.jogadores_por_time), [7, 6]);
  assert.equal(tabelas.teams[0].jogadores_por_time, 7, 'mudar só neste jogo não mexe no padrão do time');
});

test('GET do time e Explorar levam o escudo; time antigo (sem as colunas) vale sólido e 5 por time', async (t) => {
  const { pedir } = cenario(t, { time: { cor: 'laranja', escudo_cor2: 'preto', escudo_padrao: 'barra' } });
  const time = (await pedir('GET', '/api/teams/varzea-fc', null, DONO)).json.team;
  assert.deepEqual([time.cor, time.escudo_cor2, time.escudo_padrao, time.jogadores_por_time], ['laranja', 'preto', 'barra', 5]);
  const lista = (await pedir('GET', '/api/teams/explorar', null, MEMBRO)).json.teams;
  assert.deepEqual([lista[0].cor, lista[0].escudo_cor2, lista[0].escudo_padrao], ['laranja', 'preto', 'barra']);

  const antigo = cenario(t);
  const t2 = (await antigo.pedir('GET', '/api/teams/varzea-fc', null, DONO)).json.team;
  assert.deepEqual([t2.cor, t2.escudo_cor2, t2.escudo_padrao, t2.jogadores_por_time], ['verde', null, null, 5]);
});
