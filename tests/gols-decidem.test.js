// Futty v2.0 — RODADA 30I, item 3: os GOLS decidem sozinhos; placar e vencedor nunca são escolhas separadas.
//
// Antes, a tela do jogo gravava `time_vencedor`, o placar e os gols como três coisas independentes: aceitava "Ouro ganhou" com placar
// 2 × 3 e os gols não somavam o placar. Agora, com 2 times, quem manda é (1) os gols por jogador — o placar é a soma por time —,
// (2) o placar digitado, (3) o vencedor tocado; e o placar define o vencedor ou o empate.
//
// Uso: npm test  (ou: node --test tests/gols-decidem.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');
const { decidirResultado, linhasDeGols, somaDeGols, placarDoCorpo } = require('../utils/resultadoDoJogo');

const TIME = '11111111-1111-1111-1111-111111111111';
const JOGO = '99999999-9999-9999-9999-999999999999';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const A = 'a0000000-0000-0000-0000-00000000000a';
const B = 'b0000000-0000-0000-0000-00000000000b';
const R = 'e0000000-0000-0000-0000-00000000000e'; // reserva: fora dos dois times
const PASSADO = '2026-01-01T20:00:00.000Z';

const usuario = (id, nome) => ({ id, nome: `${nome} da Silva`, nome_jogador: nome, email: `${nome}@futtymock.com` });
const membro = (id, nome, role = 'member') => ({ team_id: TIME, user_id: id, role, users: usuario(id, nome) });
const j = (id, nome) => ({ user_id: id, nome, avatar_url: null, rating: 3 });
const convidado = (nome) => ({ user_id: null, convidado: true, nome, avatar_url: null, rating: 3 });

const dois = {
  seed: 1,
  num_times: 2,
  times: [
    { nome: 'Ouro', jogadores: [j(A, 'Magrão'), convidado('Beto')] },
    { nome: 'Roxo', jogadores: [j(B, 'Zé'), convidado('Caio')] },
  ],
  reservas: [j(R, 'Reserva')],
};

function cenario(extra = {}, timesResultado = dois) {
  return carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc' }],
    users: [usuario(DONO, 'Chavo'), usuario(A, 'Magrão'), usuario(B, 'Zé'), usuario(R, 'Reserva')],
    team_members: [membro(DONO, 'Chavo', 'admin'), membro(A, 'Magrão'), membro(B, 'Zé'), membro(R, 'Reserva')],
    games: [{ id: JOGO, team_id: TIME, data: PASSADO, jogadores_por_time: 2, status: 'agendado', sorteio_realizado: true, times_resultado: timesResultado, ...extra }],
    game_players: [],
  }, ['routes/games', 'routes/feed']);
}
const campos = (g) => [g.campeao_time_index, g.time_vencedor, g.placar_a, g.placar_b, g.resultado_nivel];

// ─── As contas, puras ────────────────────────────────────────────────────────────────────────────────────────────────

test('os gols decidem: a soma por time é o placar e o placar define o vencedor', () => {
  assert.deepEqual(decidirResultado({ nTimes: 2, golsPorTime: [3, 1], temGols: true }), { campeao_time_index: 0, time_vencedor: 'A', placar_a: 3, placar_b: 1, resultado_nivel: 3 });
  assert.deepEqual(decidirResultado({ nTimes: 2, golsPorTime: [0, 2], temGols: true }), { campeao_time_index: 1, time_vencedor: 'B', placar_a: 0, placar_b: 2, resultado_nivel: 3 });
});

test('gols iguais são empate — sem campeão, com o placar da soma', () => {
  assert.deepEqual(decidirResultado({ nTimes: 2, golsPorTime: [2, 2], temGols: true }), { campeao_time_index: null, time_vencedor: 'empate', placar_a: 2, placar_b: 2, resultado_nivel: 3 });
});

test('"Ouro ganhou" com gols que dão Roxo: os gols mandam, o vencedor tocado não vale', () => {
  const r = decidirResultado({ nTimes: 2, campeaoIdx: 0, golsPorTime: [1, 2], temGols: true });
  assert.deepEqual([r.campeao_time_index, r.time_vencedor, r.placar_a, r.placar_b], [1, 'B', 1, 2]);
});

test('sem gols, o placar digitado define o vencedor — mesmo contra o vencedor tocado (2 × 3 nunca é "Ouro ganhou")', () => {
  const r = decidirResultado({ nTimes: 2, campeaoIdx: 0, placar: { a: 2, b: 3 } });
  assert.deepEqual([r.campeao_time_index, r.time_vencedor, r.placar_a, r.placar_b, r.resultado_nivel], [1, 'B', 2, 3, 2]);
  const empate = decidirResultado({ nTimes: 2, campeaoIdx: 0, placar: { a: 0, b: 0 } });
  assert.deepEqual([empate.campeao_time_index, empate.time_vencedor, empate.placar_a, empate.placar_b], [null, 'empate', 0, 0], '0 × 0 é empate de verdade');
});

test('sem gols e sem placar, vale o vencedor tocado; sem nada, não há resultado', () => {
  assert.deepEqual(decidirResultado({ nTimes: 2, campeaoIdx: 1 }), { campeao_time_index: 1, time_vencedor: 'B', placar_a: null, placar_b: null, resultado_nivel: 1 });
  assert.deepEqual(decidirResultado({ nTimes: 2, empate: true }), { campeao_time_index: null, time_vencedor: 'empate', placar_a: null, placar_b: null, resultado_nivel: 1 });
  assert.deepEqual(decidirResultado({ nTimes: 2 }), { campeao_time_index: null, time_vencedor: null, placar_a: null, placar_b: null, resultado_nivel: 0 });
});

test('linhasDeGols: cada gol no time de quem marcou; convidado pelo nome; reserva sem time; gol negativo vira 0', () => {
  const linhas = linhasDeGols(dois, [
    { user_id: A, gols: 2 }, { user_id: null, convidado_nome: 'Caio', gols: 1 }, { user_id: R, gols: 4 }, { user_id: B, gols: -3 }, { user_id: null, convidado_nome: '  ' }, null,
  ]);
  assert.deepEqual(linhas.map((l) => [l.user_id, l.convidado_nome, l.gols, l.time]), [[A, null, 2, 'A'], [null, 'Caio', 1, 'B'], [R, null, 4, null], [B, null, 0, 'B']]);
});

test('somaDeGols: só os gols de quem está nos times entram no placar (o da reserva vale só para o artilheiro)', () => {
  const linhas = linhasDeGols(dois, [{ user_id: A, gols: 2 }, { user_id: B, gols: 1 }, { user_id: R, gols: 4 }]);
  assert.deepEqual(somaDeGols(linhas), { porTime: [2, 1], temGols: true });
  assert.deepEqual(somaDeGols(linhasDeGols(dois, [{ user_id: A, gols: 0 }])), { porTime: [0, 0], temGols: false });
});

test('placarDoCorpo: vazio é "sem placar"; um campo só vale com o outro em 0; inválido é recusado', () => {
  assert.equal(placarDoCorpo({}), null);
  assert.equal(placarDoCorpo({ placar_a: '', placar_b: null }), null);
  assert.deepEqual(placarDoCorpo({ placar_a: '2' }), { a: 2, b: 0 });
  assert.deepEqual(placarDoCorpo({ placar_a: 0, placar_b: 0 }), { a: 0, b: 0 });
  assert.throws(() => placarDoCorpo({ placar_a: -1, placar_b: 0 }), /Placar inválido/);
  assert.throws(() => placarDoCorpo({ placar_a: 1.5, placar_b: 0 }), /Placar inválido/);
  assert.throws(() => placarDoCorpo({ placar_a: 'x', placar_b: 0 }), /Placar inválido/);
});

// ─── O motor ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('gols lançados: o placar sai da soma, o vencedor sai do placar — e o vencedor/placar do corpo que contradizem não valem', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  // O corpo diz "Ouro ganhou" com placar 2 × 3, mas os gols são Ouro 1 × 2 Roxo.
  const r = await pedir('PATCH', `/api/games/${JOGO}/resultado`, {
    campeao_time_index: 0, placar_a: 2, placar_b: 3,
    gols: [{ user_id: A, gols: 1 }, { user_id: null, convidado_nome: 'Caio', gols: 1 }, { user_id: B, gols: 1 }],
  }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(campos(tabelas.games[0]), [1, 'B', 1, 2, 3]);
  assert.equal(tabelas.gols_jogadores.length, 3, 'os gols de cada um ficam gravados');
  assert.equal(r.json.game.placar_a, 1);
  assert.equal(r.json.game.campeao_time_index, 1);
});

test('gols iguais: empate explícito, com o placar da soma', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('PATCH', `/api/games/${JOGO}/resultado`, { gols: [{ user_id: A, gols: 2 }, { user_id: B, gols: 2 }] }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(campos(tabelas.games[0]), [null, 'empate', 2, 2, 3]);
});

test('só o placar: ele define o vencedor (0 × 0 é empate), sem nenhum gol por jogador', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  let r = await pedir('PATCH', `/api/games/${JOGO}/resultado`, { campeao_time_index: 1, placar_a: 3, placar_b: 1 }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(campos(tabelas.games[0]), [0, 'A', 3, 1, 2], 'o "Roxo ganhou" tocado perde para o 3 × 1');
  r = await pedir('PATCH', `/api/games/${JOGO}/resultado`, { placar_a: 0, placar_b: 0 }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(campos(tabelas.games[0]), [null, 'empate', 0, 0, 2]);
  assert.equal(tabelas.gols_jogadores.length, 0);
});

test('só o vencedor: grava o campeão sem placar e sem gols', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('PATCH', `/api/games/${JOGO}/resultado`, { campeao_time_index: 0 }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(campos(tabelas.games[0]), [0, 'A', null, null, 1]);
});

test('o app antigo (nivel 3, time_vencedor "A", placar 2 × 0) com gols que dão B: vale o que os gols dizem', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('PATCH', `/api/games/${JOGO}/resultado`, { nivel: 3, time_vencedor: 'A', placar_a: 2, placar_b: 0, gols: [{ user_id: B, gols: 3 }] }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(campos(tabelas.games[0]), [1, 'B', 0, 3, 3]);
});

test('o app antigo com nivel 0 limpa o resultado e os gols', async (t) => {
  const { carregados, tabelas } = cenario({ campeao_time_index: 0, time_vencedor: 'A', placar_a: 2, placar_b: 0, resultado_nivel: 3 });
  tabelas.gols_jogadores = [{ id: 'x', game_id: JOGO, user_id: A, gols: 2, time: 'A' }];
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('PATCH', `/api/games/${JOGO}/resultado`, { nivel: 0 }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(campos(tabelas.games[0]), [null, null, null, null, 0]);
  assert.equal(tabelas.gols_jogadores.length, 0);
});

test('placar inválido é recusado e nada é gravado', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('PATCH', `/api/games/${JOGO}/resultado`, { placar_a: -2, placar_b: 1 }, DONO);
  assert.equal(r.status, 400);
  assert.deepEqual(campos(tabelas.games[0]), [undefined, undefined, undefined, undefined, undefined]);
});

test('Ajustes → Jogos: com gols lançados o campeão tocado não vale; sem gols vale e o placar de antes se desfaz', async (t) => {
  const { carregados, tabelas } = cenario({ campeao_time_index: 0, time_vencedor: 'A', placar_a: 2, placar_b: 1, resultado_nivel: 3 });
  tabelas.gols_jogadores = [{ id: 'x', game_id: JOGO, user_id: A, gols: 2, time: 'A' }, { id: 'y', game_id: JOGO, user_id: B, gols: 1, time: 'B' }];
  const pedir = subir([carregados['routes/feed']], t);
  let r = await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { campeao_time_index: 1 }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(campos(tabelas.games[0]), [0, 'A', 2, 1, 3], 'os gols (2 × 1) seguem decidindo');
  tabelas.gols_jogadores.length = 0;
  r = await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { campeao_time_index: 1 }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(campos(tabelas.games[0]), [1, 'B', null, null, 1], 'sem gols, o campeão tocado vale e o placar 2 × 1 some');
});
