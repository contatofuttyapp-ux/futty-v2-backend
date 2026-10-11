// Futty v2.0 — RODADA 30I, item 4: com 3 ou 4 times (rodízio) não há placar nem empate.
//
// Só "Quem foi o campeão?". Os gols por jogador continuam valendo — alimentam o artilheiro e o ranking de gols —, mas não decidem nada
// (o rodízio não tem placar que some) e os gols de quem está no 3º ou 4º time também são gravados.
//
// Uso: npm test  (ou: node --test tests/tres-times.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');
const { decidirResultado } = require('../utils/resultadoDoJogo');

const TIME = '11111111-1111-1111-1111-111111111111';
const JOGO = '99999999-9999-9999-9999-999999999999';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const A = 'a0000000-0000-0000-0000-00000000000a';
const B = 'b0000000-0000-0000-0000-00000000000b';
const C = 'c0000000-0000-0000-0000-00000000000c';
const D = 'f0000000-0000-0000-0000-00000000000f';
const PASSADO = '2026-01-01T20:00:00.000Z';

const usuario = (id, nome) => ({ id, nome: `${nome} da Silva`, nome_jogador: nome, email: `${nome}@futtymock.com` });
const membro = (id, nome, role = 'member') => ({ team_id: TIME, user_id: id, role, users: usuario(id, nome) });
const j = (id, nome) => ({ user_id: id, nome, avatar_url: null, rating: 3 });
const time = (nome, ...js) => ({ nome, jogadores: js });
const tres = { seed: 1, num_times: 3, times: [time('Ouro', j(A, 'Magrão')), time('Roxo', j(B, 'Zé')), time('Prata', j(C, 'Cacá'))], reservas: [] };
const quatro = { ...tres, num_times: 4, times: [...tres.times, time('Bronze', j(D, 'Duda'))] };

function cenario(timesResultado, extra = {}) {
  return carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc' }],
    users: [usuario(DONO, 'Chavo'), usuario(A, 'Magrão'), usuario(B, 'Zé'), usuario(C, 'Cacá'), usuario(D, 'Duda')],
    team_members: [membro(DONO, 'Chavo', 'admin'), membro(A, 'Magrão'), membro(B, 'Zé'), membro(C, 'Cacá'), membro(D, 'Duda')],
    games: [{ id: JOGO, team_id: TIME, data: PASSADO, jogadores_por_time: 1, status: 'agendado', sorteio_realizado: true, times_resultado: timesResultado, ...extra }],
    game_players: [],
  }, ['routes/games', 'routes/feed', 'utils/agregados']);
}
const campos = (g) => [g.campeao_time_index, g.time_vencedor, g.placar_a, g.placar_b, g.resultado_nivel];

// ─── As contas, puras ────────────────────────────────────────────────────────────────────────────────────────────────

test('com 3 ou 4 times o campeão basta: sem letra A/B, sem placar', () => {
  assert.deepEqual(decidirResultado({ nTimes: 3, campeaoIdx: 2 }), { campeao_time_index: 2, time_vencedor: null, placar_a: null, placar_b: null, resultado_nivel: 1 });
  assert.deepEqual(decidirResultado({ nTimes: 4, campeaoIdx: 3 }), { campeao_time_index: 3, time_vencedor: null, placar_a: null, placar_b: null, resultado_nivel: 1 });
  assert.deepEqual(decidirResultado({ nTimes: 4 }), { campeao_time_index: null, time_vencedor: null, placar_a: null, placar_b: null, resultado_nivel: 0 });
});

test('com 3 ou 4 times não há empate nem placar', () => {
  assert.throws(() => decidirResultado({ nTimes: 3, empate: true }), /não há empate/);
  assert.throws(() => decidirResultado({ nTimes: 4, placar: { a: 1, b: 1 } }), /não há placar/);
});

test('com 3 ou 4 times os gols não decidem o campeão (nem dão placar), mas contam como nível 3', () => {
  const r = decidirResultado({ nTimes: 3, campeaoIdx: 2, golsPorTime: [5, 0], temGols: true });
  assert.deepEqual([r.campeao_time_index, r.placar_a, r.placar_b, r.resultado_nivel], [2, null, null, 3]);
});

test('o campeão tem de ser um dos times do rodízio', () => {
  assert.throws(() => decidirResultado({ nTimes: 3, campeaoIdx: 3 }), /não existe/);
  assert.throws(() => decidirResultado({ nTimes: 4, campeaoIdx: 4 }), /não existe/);
});

// ─── O motor ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('3 times: o campeão do rodízio é gravado (índice 2), sem time_vencedor e sem placar', async (t) => {
  const { carregados, tabelas } = cenario(tres);
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('PATCH', `/api/games/${JOGO}/resultado`, { campeao_time_index: 2 }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(campos(tabelas.games[0]), [2, null, null, null, 1]);
});

test('4 times com gols por jogador: o campeão e os gols dos 4 times são gravados — inclusive os do 3º e do 4º', async (t) => {
  const { carregados, tabelas } = cenario(quatro);
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('PATCH', `/api/games/${JOGO}/resultado`, {
    campeao_time_index: 3,
    gols: [{ user_id: A, gols: 1 }, { user_id: C, gols: 2 }, { user_id: D, gols: 3 }],
  }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(campos(tabelas.games[0]), [3, null, null, null, 3]);
  assert.deepEqual(tabelas.gols_jogadores.map((g) => [g.user_id, g.gols]).sort(), [[A, 1], [C, 2], [D, 3]]);
  // a coluna `time` só conhece A e B: quem está no 3º/4º time fica sem letra, e o gol dele vale para o artilheiro.
  assert.deepEqual(tabelas.gols_jogadores.map((g) => g.time), ['A', null, null]);
});

test('os gols de quem está no 3º time contam no ranking de gols do time', async (t) => {
  const { carregados } = cenario(quatro);
  const pedir = subir([carregados['routes/games']], t);
  await pedir('PATCH', `/api/games/${JOGO}/resultado`, { campeao_time_index: 2, gols: [{ user_id: C, gols: 4 }] }, DONO);
  const { golsMap, vitoriasMap } = await carregados['utils/agregados'].agregadosDaEquipa(TIME);
  assert.deepEqual(golsMap, { [C]: 4 });
  assert.deepEqual(vitoriasMap, { [C]: 1 }, 'e o campeão do rodízio leva a vitória');
});

test('com 3 times, empate e placar são recusados nos dois caminhos e nada é gravado', async (t) => {
  const { carregados, tabelas } = cenario(tres);
  const pedir = subir([carregados['routes/games'], carregados['routes/feed']], t);
  assert.equal((await pedir('PATCH', `/api/games/${JOGO}/resultado`, { empate: true }, DONO)).status, 400);
  assert.equal((await pedir('PATCH', `/api/games/${JOGO}/resultado`, { nivel: 1, time_vencedor: 'empate' }, DONO)).status, 400);
  assert.equal((await pedir('PATCH', `/api/games/${JOGO}/resultado`, { campeao_time_index: 0, placar_a: 2, placar_b: 1 }, DONO)).status, 400);
  assert.equal((await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { empate: true }, DONO)).status, 400);
  assert.deepEqual(campos(tabelas.games[0]), [undefined, undefined, undefined, undefined, undefined]);
});

test('Ajustes → Jogos com 4 times grava o campeão pelo mesmo caminho', async (t) => {
  const { carregados, tabelas } = cenario(quatro);
  const pedir = subir([carregados['routes/feed']], t);
  const r = await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { campeao_time_index: 1 }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(campos(tabelas.games[0]), [1, null, null, null, 1]);
});

test('jogo sem times não aceita campeão, empate nem placar', async (t) => {
  const { carregados } = cenario(null);
  const pedir = subir([carregados['routes/games']], t);
  for (const corpo of [{ campeao_time_index: 0 }, { empate: true }, { placar_a: 1, placar_b: 0 }]) {
    const r = await pedir('PATCH', `/api/games/${JOGO}/resultado`, corpo, DONO);
    assert.equal(r.status, 400, JSON.stringify(corpo));
  }
});
