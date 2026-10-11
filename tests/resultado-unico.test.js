// Futty v2.0 — RODADA 30I, item 1: "Quem ganhou?" tem UMA fonte só.
//
// Antes, a tela do jogo gravava `time_vencedor` e Ajustes → Jogos gravava `campeao_time_index`; o ranking lia um, o perfil e a
// Resenha liam o outro, e quem lançava só pela tela do jogo ficava sem post e com o campeão fora das conquistas. Agora o campeão
// (`campeao_time_index`) é a verdade e `time_vencedor` sai dele — por qualquer dos dois caminhos que o grave.
//
// Uso: npm test  (ou: node --test tests/resultado-unico.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');
const { vencedorDerivado, resultadoGravado, jogadoresDoCampeao, resultadoDoJogador, escolhaDoCorpo, decidirResultado, quantosTimes } = require('../utils/resultadoDoJogo');

const TIME = '11111111-1111-1111-1111-111111111111';
const JOGO = '99999999-9999-9999-9999-999999999999';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const A = 'a0000000-0000-0000-0000-00000000000a';
const B = 'b0000000-0000-0000-0000-00000000000b';
const C = 'c0000000-0000-0000-0000-00000000000c';
const PASSADO = '2026-01-01T20:00:00.000Z';

const usuario = (id, nome) => ({ id, nome: `${nome} da Silva`, nome_jogador: nome, email: `${nome}@futtymock.com` });
const membro = (id, nome, role = 'member') => ({ team_id: TIME, user_id: id, role, users: usuario(id, nome) });
const j = (id, nome) => ({ user_id: id, nome, avatar_url: null, rating: 3 });

const dois = { seed: 1, num_times: 2, times: [{ nome: 'Ouro', jogadores: [j(A, 'Magrão')] }, { nome: 'Roxo', jogadores: [j(B, 'Zé')] }], reservas: [] };
const tres = { seed: 1, num_times: 3, times: [...dois.times, { nome: 'Verde', jogadores: [j(C, 'Cacá')] }], reservas: [] };

function cenario(timesResultado = dois, extra = {}) {
  return carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc' }],
    users: [usuario(DONO, 'Chavo'), usuario(A, 'Magrão'), usuario(B, 'Zé'), usuario(C, 'Cacá')],
    team_members: [membro(DONO, 'Chavo', 'admin'), membro(A, 'Magrão'), membro(B, 'Zé'), membro(C, 'Cacá')],
    games: [{ id: JOGO, team_id: TIME, data: PASSADO, jogadores_por_time: 1, status: 'agendado', sorteio_realizado: true, times_resultado: timesResultado, ...extra }],
    game_players: [],
  }, ['routes/games', 'routes/feed', 'utils/agregados']);
}

// ─── A derivação, pura ───────────────────────────────────────────────────────────────────────────────────────────────

test('time_vencedor sai do campeão: com 2 times 0 → A e 1 → B; com 3 ou 4 não há letra', () => {
  assert.equal(vencedorDerivado({ nTimes: 2, campeaoIdx: 0 }), 'A');
  assert.equal(vencedorDerivado({ nTimes: 2, campeaoIdx: 1 }), 'B');
  assert.equal(vencedorDerivado({ nTimes: 2, campeaoIdx: null, empate: true }), 'empate');
  assert.equal(vencedorDerivado({ nTimes: 2, campeaoIdx: null, empate: false }), null);
  assert.equal(vencedorDerivado({ nTimes: 3, campeaoIdx: 0 }), null);
  assert.equal(vencedorDerivado({ nTimes: 4, campeaoIdx: 2 }), null);
});

test('o campeão manda: se o campeão e o time_vencedor se contradizem, vale o campeão', () => {
  assert.deepEqual(resultadoGravado({ campeao_time_index: 1, time_vencedor: 'A' }), { tipo: 'campeao', idx: 1 });
  assert.deepEqual(resultadoGravado({ campeao_time_index: 0, time_vencedor: null }), { tipo: 'campeao', idx: 0 });
  assert.deepEqual(resultadoGravado({ campeao_time_index: 2, time_vencedor: null }), { tipo: 'campeao', idx: 2 });
});

test('jogo antigo, gravado só pela tela do jogo (campeão nulo + A/B): lê-se como campeão até o conserto dos dados', () => {
  assert.deepEqual(resultadoGravado({ campeao_time_index: null, time_vencedor: 'B' }), { tipo: 'campeao', idx: 1 });
  assert.deepEqual(resultadoGravado({ campeao_time_index: null, time_vencedor: 'A' }), { tipo: 'campeao', idx: 0 });
});

test('empate é um resultado e "sem resultado" é outro: nunca se confundem', () => {
  assert.deepEqual(resultadoGravado({ campeao_time_index: null, time_vencedor: 'empate' }), { tipo: 'empate' });
  assert.equal(resultadoGravado({ campeao_time_index: null, time_vencedor: null }), null);
  assert.equal(resultadoGravado({}), null);
  assert.equal(resultadoGravado(null), null);
});

test('o corpo do pedido diz quem ganhou do jeito novo (campeão) ou do antigo (A / B / empate); o campeão presente ganha', () => {
  assert.deepEqual(escolhaDoCorpo({ campeao_time_index: 1 }), { campeaoIdx: 1, empate: false, informado: true });
  assert.deepEqual(escolhaDoCorpo({ campeao_time_index: null }), { campeaoIdx: null, empate: false, informado: true });
  assert.deepEqual(escolhaDoCorpo({ empate: true }), { campeaoIdx: null, empate: true, informado: true });
  assert.deepEqual(escolhaDoCorpo({ time_vencedor: 'A' }), { campeaoIdx: 0, empate: false, informado: true });
  assert.deepEqual(escolhaDoCorpo({ time_vencedor: 'B' }), { campeaoIdx: 1, empate: false, informado: true });
  assert.deepEqual(escolhaDoCorpo({ time_vencedor: 'empate' }), { campeaoIdx: null, empate: true, informado: true });
  assert.deepEqual(escolhaDoCorpo({ campeao_time_index: 0, time_vencedor: 'B' }), { campeaoIdx: 0, empate: false, informado: true });
  assert.equal(escolhaDoCorpo({}).informado, false);
  assert.throws(() => escolhaDoCorpo({ campeao_time_index: -1 }), /inválido/);
  assert.throws(() => escolhaDoCorpo({ campeao_time_index: 'x' }), /inválido/);
  assert.throws(() => escolhaDoCorpo({ time_vencedor: 'C' }), /Indique quem venceu/);
});

test('decidirResultado: o campeão tem de existir no jogo e o jogo tem de ter times', () => {
  assert.deepEqual(decidirResultado({ nTimes: 2, campeaoIdx: 1 }), { campeao_time_index: 1, time_vencedor: 'B', resultado_nivel: 1 });
  assert.deepEqual(decidirResultado({ nTimes: 3, campeaoIdx: 2 }), { campeao_time_index: 2, time_vencedor: null, resultado_nivel: 1 });
  assert.deepEqual(decidirResultado({ nTimes: 2 }), { campeao_time_index: null, time_vencedor: null, resultado_nivel: 0 });
  assert.throws(() => decidirResultado({ nTimes: 2, campeaoIdx: 2 }), /não existe/);
  assert.throws(() => decidirResultado({ nTimes: 0, campeaoIdx: 0 }), /times/);
  assert.equal(quantosTimes(tres), 3);
  assert.equal(quantosTimes(null), 0);
});

test('quem estava no time campeão venceu; quem estava no outro perdeu; a lista do campeão sai do índice', () => {
  const g = { campeao_time_index: 1, times_resultado: dois };
  assert.deepEqual(jogadoresDoCampeao(g).map((x) => x.user_id), [B]);
  assert.equal(resultadoDoJogador(g, B), 'vitoria');
  assert.equal(resultadoDoJogador(g, A), 'derrota');
  assert.equal(resultadoDoJogador({ times_resultado: dois }, A), null);
});

// ─── O motor: os DOIS caminhos gravam o mesmo ────────────────────────────────────────────────────────────────────────

test('a tela do jogo manda só time_vencedor (app antigo): o campeão é preenchido junto', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('PATCH', `/api/games/${JOGO}/resultado`, { nivel: 1, time_vencedor: 'B' }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(tabelas.games[0].campeao_time_index, 1);
  assert.equal(tabelas.games[0].time_vencedor, 'B');
  assert.equal(tabelas.games[0].resultado_nivel, 1);
});

test('a tela do jogo manda o campeão: time_vencedor é derivado dele', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('PATCH', `/api/games/${JOGO}/resultado`, { nivel: 1, campeao_time_index: 0 }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(tabelas.games[0].campeao_time_index, 0);
  assert.equal(tabelas.games[0].time_vencedor, 'A');
});

test('Ajustes → Jogos (PATCH do feed) grava o campeão e o time_vencedor junto; trocar de campeão troca os dois', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/feed']], t);
  let r = await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { campeao_time_index: 0 }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([tabelas.games[0].campeao_time_index, tabelas.games[0].time_vencedor], [0, 'A']);
  r = await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { campeao_time_index: 1 }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([tabelas.games[0].campeao_time_index, tabelas.games[0].time_vencedor], [1, 'B']);
});

test('desfazer o campeão limpa os dois campos (jogo volta a "sem resultado")', async (t) => {
  const { carregados, tabelas } = cenario(dois, { campeao_time_index: 1, time_vencedor: 'B', resultado_nivel: 1 });
  const pedir = subir([carregados['routes/feed']], t);
  const r = await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { campeao_time_index: null }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([tabelas.games[0].campeao_time_index, tabelas.games[0].time_vencedor, tabelas.games[0].resultado_nivel], [null, null, 0]);
});

test('um campeão que não existe no jogo é recusado nos dois caminhos', async (t) => {
  const { carregados } = cenario();
  const pedir = subir([carregados['routes/games'], carregados['routes/feed']], t);
  const a = await pedir('PATCH', `/api/games/${JOGO}/resultado`, { nivel: 1, campeao_time_index: 2 }, DONO);
  const b = await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { campeao_time_index: 5 }, DONO);
  assert.equal(a.status, 400);
  assert.equal(b.status, 400);
});

test('só o admin lança o resultado', async (t) => {
  const { carregados } = cenario();
  const pedir = subir([carregados['routes/games'], carregados['routes/feed']], t);
  assert.equal((await pedir('PATCH', `/api/games/${JOGO}/resultado`, { nivel: 1, campeao_time_index: 0 }, A)).status, 403);
  assert.equal((await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { campeao_time_index: 0 }, A)).status, 403);
});

// ─── O ranking lê o campeão ──────────────────────────────────────────────────────────────────────────────────────────

test('a vitória do ranking vem do campeão — lançado pelo caminho que for', async (t) => {
  const { carregados } = cenario(dois, { campeao_time_index: 1, time_vencedor: null, resultado_nivel: 0 });
  const { vitoriasMap } = await carregados['utils/agregados'].agregadosDaEquipa(TIME);
  assert.deepEqual(vitoriasMap, { [B]: 1 });
  t.diagnostic('campeão sem time_vencedor (lançado só por Ajustes) já conta vitória');
});

test('com 3 times o campeão do rodízio também conta vitória', async () => {
  const { carregados } = cenario(tres, { campeao_time_index: 2, time_vencedor: null, resultado_nivel: 1 });
  const { vitoriasMap } = await carregados['utils/agregados'].agregadosDaEquipa(TIME);
  assert.deepEqual(vitoriasMap, { [C]: 1 });
});

test('empate não dá vitória a ninguém; sem resultado também não', async () => {
  const e = cenario(dois, { campeao_time_index: null, time_vencedor: 'empate', resultado_nivel: 1 });
  assert.deepEqual((await e.carregados['utils/agregados'].agregadosDaEquipa(TIME)).vitoriasMap, {});
  const s = cenario(dois);
  assert.deepEqual((await s.carregados['utils/agregados'].agregadosDaEquipa(TIME)).vitoriasMap, {});
});
