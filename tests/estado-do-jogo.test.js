// Futty v2.0 — "Em andamento" x "Terminado": a regra única do estado do jogo (utils/estadoDoJogo.js), no rótulo e na lista.
//
// Antes do início o jogo está agendado; do início até o PRIMEIRO de (a) campeão ou empate marcado ou (b) 2 horas depois do início, está em curso
// ("Em andamento"); depois disso, terminado; cancelado é sempre cancelado. A regra é uma só e as três telas que mostram o estado a leem do motor: a lista
// de Ajustes → Jogos (GET /api/teams/:slug/games), a Página do Jogo (GET /api/games/:id) e o Início (GET /api/inicio → convites.games[].estado).
// O `status` do Início (finished/drawn/scheduled) NÃO muda: é ele que decide presença, "próximo jogo" e "Sortear".
//
// Uso: npm test  (ou: node --test tests/estado-do-jogo.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');
const { estadoDoJogo, JANELA_EM_ANDAMENTO_MS } = require('../utils/estadoDoJogo');
const { instanteNoFuso } = require('../utils/fuso');

const MIN = 60000;
const HORA = 60 * MIN;
const INICIO = Date.parse('2026-10-18T23:00:00Z'); // 20:00 em São Paulo
const jogo = (extra = {}) => ({ data: '2026-10-18T23:00:00Z', status: 'agendado', cancelado: false, campeao_time_index: null, time_vencedor: null, ...extra });

test('a janela do "Em andamento" é de 2 horas', () => {
  assert.equal(JANELA_EM_ANDAMENTO_MS, 2 * HORA);
});

test('antes do início: agendado (1 ms antes ainda é agendado)', () => {
  assert.equal(estadoDoJogo(jogo(), INICIO - 3 * HORA), 'agendado');
  assert.equal(estadoDoJogo(jogo(), INICIO - 1), 'agendado');
});

test('no instante do início já é "em andamento" (em_curso)', () => {
  assert.equal(estadoDoJogo(jogo(), INICIO), 'em_curso');
  assert.equal(estadoDoJogo(jogo(), INICIO + 5 * MIN), 'em_curso');
});

test('1h59 depois do início ainda é "em andamento"; às 2h exatas vira "terminado"', () => {
  assert.equal(estadoDoJogo(jogo(), INICIO + 119 * MIN), 'em_curso', '+1h59');
  assert.equal(estadoDoJogo(jogo(), INICIO + 2 * HORA - 1), 'em_curso', '1 ms antes das 2h');
  assert.equal(estadoDoJogo(jogo(), INICIO + 2 * HORA), 'terminado', '+2h');
  assert.equal(estadoDoJogo(jogo(), INICIO + 30 * 24 * HORA), 'terminado', 'um mês depois sem resultado: terminado, não "em andamento" para sempre');
});

test('resultado lançado antes das 2h termina o jogo na hora: campeão, empate ou o formato antigo (só time_vencedor)', () => {
  const agora = INICIO + 40 * MIN;
  assert.equal(estadoDoJogo(jogo(), agora), 'em_curso', 'sem resultado');
  assert.equal(estadoDoJogo(jogo({ campeao_time_index: 1, time_vencedor: 'B' }), agora), 'terminado', 'campeão');
  assert.equal(estadoDoJogo(jogo({ campeao_time_index: 0 }), agora), 'terminado', 'campeão índice 0 (zero conta)');
  assert.equal(estadoDoJogo(jogo({ time_vencedor: 'empate' }), agora), 'terminado', 'empate');
  assert.equal(estadoDoJogo(jogo({ time_vencedor: 'A' }), agora), 'terminado', 'jogo antigo: só time_vencedor');
});

test('placar, gols ou nível sozinhos NÃO terminam o jogo: o critério é campeão ou empate marcado', () => {
  const agora = INICIO + 40 * MIN;
  assert.equal(estadoDoJogo(jogo({ placar_a: 2, placar_b: 1, resultado_nivel: 2 }), agora), 'em_curso');
  assert.equal(estadoDoJogo(jogo({ resultado_nivel: 3 }), agora), 'em_curso');
});

test('cancelado é cancelado: antes, durante e depois do jogo, e mesmo com resultado', () => {
  for (const quando of [INICIO - HORA, INICIO + 30 * MIN, INICIO + 3 * HORA]) {
    assert.equal(estadoDoJogo(jogo({ cancelado: true }), quando), 'cancelado');
    assert.equal(estadoDoJogo(jogo({ status: 'cancelado' }), quando), 'cancelado');
  }
  assert.equal(estadoDoJogo(jogo({ cancelado: true, campeao_time_index: 0 }), INICIO + 30 * MIN), 'cancelado');
});

test('o status gravado como terminado (jogo semeado ou antigo) vale; sem data o jogo está agendado ("data a definir")', () => {
  assert.equal(estadoDoJogo(jogo({ status: 'terminado' }), INICIO - HORA), 'terminado');
  assert.equal(estadoDoJogo(jogo({ data: null }), INICIO), 'agendado');
  assert.equal(estadoDoJogo(jogo({ data: undefined }), INICIO), 'agendado');
  assert.equal(estadoDoJogo(jogo({ data: 'não é data' }), INICIO), 'agendado');
  assert.equal(estadoDoJogo(null, INICIO), 'agendado');
});

test('fuso do time: o estado é o mesmo em qualquer relógio — a conta é entre instantes', () => {
  // "20:00" em São Paulo (UTC−3) e "23:00" em Lisboa no horário de verão (UTC+1) são instantes DIFERENTES; o que não pode mudar é o estado de um mesmo
  // instante escrito de duas formas.
  const iso = instanteNoFuso('2026-10-18', '20:00', 'America/Sao_Paulo'); // 23:00Z
  assert.equal(Date.parse(iso), INICIO);
  const comOffset = '2026-10-18T20:00:00-03:00';
  const emLisboa = '2026-10-19T00:00:00+01:00';
  for (const quando of [INICIO - MIN, INICIO, INICIO + 119 * MIN, INICIO + 120 * MIN]) {
    const esperado = estadoDoJogo(jogo({ data: iso }), quando);
    assert.equal(estadoDoJogo(jogo({ data: comOffset }), quando), esperado, 'o mesmo instante com offset de São Paulo');
    assert.equal(estadoDoJogo(jogo({ data: emLisboa }), quando), esperado, 'o mesmo instante com offset de Lisboa');
  }
  // E o jogo das 20:00 de um time em Lisboa (19:00Z) começa 4 h antes do de São Paulo: cada time vê o seu jogo no seu relógio.
  const lisboa = instanteNoFuso('2026-10-18', '20:00', 'Europe/Lisbon');
  assert.equal(Date.parse(lisboa), Date.parse('2026-10-18T19:00:00Z'));
  assert.equal(estadoDoJogo(jogo({ data: lisboa }), INICIO), 'terminado', 'às 20:00 de São Paulo o jogo das 20:00 de Lisboa já passou das 2h');
  assert.equal(estadoDoJogo(jogo({ data: iso }), INICIO), 'em_curso');
});

// ─── as três telas leem do motor ────────────────────────────────────────────────────────────────────────────────────

const TIME = '11111111-1111-1111-1111-111111111111';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const quandoAtras = (minutos) => new Date(Date.now() - minutos * MIN).toISOString();

const JOGOS_DA_LISTA = [
  { id: 'futuro', data: new Date(Date.now() + 2 * 24 * HORA).toISOString(), status: 'agendado' },
  { id: 'rolando', data: quandoAtras(20), status: 'agendado' },
  { id: 'rolando-com-campeao', data: quandoAtras(20), status: 'agendado', campeao_time_index: 0, time_vencedor: 'A', resultado_nivel: 1 },
  { id: 'passou-das-2h', data: quandoAtras(125), status: 'agendado' },
  { id: 'cancelado', data: quandoAtras(20), status: 'agendado', cancelado: true },
];

test('Ajustes → Jogos: GET /api/teams/:slug/games traz o estado de cada jogo pela regra única', async (t) => {
  const { carregados } = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde' }],
    users: [{ id: DONO, nome: 'Tonhão' }],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin' }],
    games: JOGOS_DA_LISTA.map((g) => ({ team_id: TIME, rsvp_aberto: false, rsvp_fechado: false, ...g })),
    game_players: [], rsvp_respostas: [],
  }, ['routes/games']);
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('GET', '/api/teams/varzea-fc/games', null, DONO);
  assert.equal(r.status, 200);
  const estado = Object.fromEntries(r.json.games.map((g) => [g.id, g.status]));
  assert.deepEqual(estado, { futuro: 'agendado', rolando: 'em_curso', 'rolando-com-campeao': 'terminado', 'passou-das-2h': 'terminado', cancelado: 'cancelado' });
});

test('Página do Jogo: GET /api/games/:id traz o mesmo estado', async (t) => {
  const { carregados } = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde' }],
    users: [{ id: DONO, nome: 'Tonhão' }],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin' }],
    games: JOGOS_DA_LISTA.map((g) => ({ team_id: TIME, sorteio_realizado: false, ...g })),
    game_players: [], votes: [],
  }, ['routes/games']);
  const pedir = subir([carregados['routes/games']], t);
  const esperado = { futuro: 'agendado', rolando: 'em_curso', 'rolando-com-campeao': 'terminado', 'passou-das-2h': 'terminado', cancelado: 'cancelado' };
  for (const [id, estado] of Object.entries(esperado)) {
    const r = await pedir('GET', `/api/games/${id}`, null, DONO);
    assert.equal(r.status, 200, id);
    assert.equal(r.json.game.status, estado, id);
  }
});

const TIME_DO_INICIO = { id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde', criado_por: DONO, created_at: '2026-01-01T00:00:00Z' };

function servicoDoInicio(games) {
  const { carregados } = carregar({
    users: [{ id: DONO, nome: 'Chavo', nome_jogador: 'Chavo', email: 'chavo@futtymock.com' }],
    teams: [TIME_DO_INICIO],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin', ausente_proximo: false, created_at: '2026-01-01T00:00:00Z', teams: TIME_DO_INICIO }],
    games: games.map((g) => ({ team_id: TIME, teams: TIME_DO_INICIO, cancelado: false, sorteio_realizado: false, game_players: [{ user_id: DONO, confirmado: true }], ...g })),
    rsvp_respostas: [], rsvp_espera: [], votes: [], team_join_requests: [],
  }, ['services/inicio']);
  return carregados['services/inicio'];
}

test('Início: cada jogo leva o `estado`, e o `status` de sempre não muda (é ele que decide presença, "próximo jogo" e "Sortear")', async () => {
  const servico = servicoDoInicio(JOGOS_DA_LISTA);
  const { games } = await servico.obterConvites(DONO);
  const por = Object.fromEntries(games.map((g) => [g.id, { estado: g.estado, status: g.status }]));
  assert.deepEqual(por, {
    futuro: { estado: 'agendado', status: 'scheduled' },
    rolando: { estado: 'em_curso', status: 'finished' },
    'rolando-com-campeao': { estado: 'terminado', status: 'finished' },
    'passou-das-2h': { estado: 'terminado', status: 'finished' },
    cancelado: { estado: 'cancelado', status: 'finished' },
  });
});

test('Início: a lista curta do app (limitar) traz o jogo em andamento e segue sem trazer o cancelado', async () => {
  const servico = servicoDoInicio(JOGOS_DA_LISTA);
  const { games } = await servico.obterConvites(DONO, { limitar: true });
  assert.deepEqual(games.map((g) => g.id).sort(), ['futuro', 'passou-das-2h', 'rolando', 'rolando-com-campeao']);
  assert.equal(games.find((g) => g.id === 'rolando').estado, 'em_curso');
});

test('Início: o jogo em andamento não ocupa vaga dos 3 últimos terminados do time', async () => {
  const terminados = [1, 2, 3, 4, 5].map((i) => ({ id: `t${i}`, data: quandoAtras(60 * 24 * i), status: 'terminado' }));
  const servico = servicoDoInicio([{ id: 'rolando', data: quandoAtras(30), status: 'agendado' }, ...terminados]);
  const { games } = await servico.obterConvites(DONO, { limitar: true });
  assert.deepEqual(games.filter((g) => g.estado === 'terminado').map((g) => g.id).sort(), ['t1', 't2', 't3'], 'os 3 terminados mais recentes, como sempre');
  assert.equal(games.filter((g) => g.estado === 'em_curso').length, 1, 'e o jogo em andamento vai junto');
});
