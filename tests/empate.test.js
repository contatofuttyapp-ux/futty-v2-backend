// Futty v2.0 — RODADA 30I, item 2: o EMPATE é um resultado, não a falta de um.
//
// Antes, "sem campeão" era lido como empate (o perfil mostrava "E" para todo jogo sem resultado) e um empate de verdade — que só
// existia como time_vencedor = 'empate' na tela do jogo — não contava em lugar nenhum nem aparecia na Resenha. Agora:
//   · empate explícito = campeão nulo + time_vencedor 'empate' (só com 2 times); sem resultado = os dois nulos;
//   · ranking e perfil contam vitória, empate e derrota pelo campeão (e jogo sem resultado não conta nada);
//   · o empate vira post na Resenha ("Empate · Ouro 2 × 2 Roxo").
//
// Uso: npm test  (ou: node --test tests/empate.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');
const { desfechoDoJogo, resultadoDoJogador } = require('../utils/resultadoDoJogo');

const TIME = { id: 'time-1', nome: 'Missa de Quinta', slug: 'missa', cor: 'verde', criado_por: 'dono', created_at: '2026-01-01T00:00:00Z' };
const DONO = 'd0000000-0000-0000-0000-000000000001';
const OURO = 'a0000000-0000-0000-0000-00000000000a'; // joga sempre no Time Ouro (índice 0)
const ROXO = 'b0000000-0000-0000-0000-00000000000b'; // joga sempre no Time Roxo (índice 1)
const RESERVA = 'c0000000-0000-0000-0000-00000000000c'; // confirmou, ficou de fora dos times

const usuario = (id, nome) => ({ id, nome, nome_jogador: nome, avatar_url: null, foto_url: null, email: `${nome}@futtymock.com` });
const membro = (id, nome, extra = {}) => ({ team_id: TIME.id, user_id: id, role: 'member', categoria: 'linha', users: usuario(id, nome), ...extra });
const passado = (dias) => new Date(Date.now() - dias * 864e5).toISOString();
const times = { times: [{ nome: 'Time Ouro', jogadores: [{ user_id: OURO, nome: 'Ouro' }, { user_id: null, nome: 'Beto', convidado: true }] }, { nome: 'Time Roxo', jogadores: [{ user_id: ROXO, nome: 'Roxo' }] }], reservas: [{ user_id: RESERVA, nome: 'Reserva' }] };

// 4 jogos: ouro ganhou, empate 2×2, roxo ganhou, e um sem resultado nenhum.
const JOGOS = [
  { id: 'jogo-1', team_id: TIME.id, data: passado(28), status: 'terminado', resultado_nivel: 1, campeao_time_index: 0, time_vencedor: 'A', times_resultado: times },
  { id: 'jogo-2', team_id: TIME.id, data: passado(21), status: 'terminado', resultado_nivel: 2, campeao_time_index: null, time_vencedor: 'empate', placar_a: 2, placar_b: 2, times_resultado: times },
  { id: 'jogo-3', team_id: TIME.id, data: passado(14), status: 'terminado', resultado_nivel: 1, campeao_time_index: 1, time_vencedor: 'B', times_resultado: times },
  { id: 'jogo-4', team_id: TIME.id, data: passado(7), status: 'terminado', resultado_nivel: 0, campeao_time_index: null, time_vencedor: null, times_resultado: times },
];

function mundo(t) {
  const { carregados } = carregar({
    users: [usuario(DONO, 'Tonhão'), usuario(OURO, 'Ouro'), usuario(ROXO, 'Roxo'), usuario(RESERVA, 'Reserva')],
    teams: [TIME],
    team_members: [membro(DONO, 'Tonhão', { role: 'admin', joga: false }), membro(OURO, 'Ouro'), membro(ROXO, 'Roxo'), membro(RESERVA, 'Reserva')],
    games: JOGOS,
    game_players: JOGOS.flatMap((g) => [OURO, ROXO, RESERVA].map((u) => ({ game_id: g.id, user_id: u, confirmado: true }))),
    votes: [], gols_jogadores: [], champion_photos: [], feed_posts: [], feed_post_media: [], comentarios: [],
  }, ['routes/ranking']);
  return subir([carregados['routes/ranking']], t);
}

// ─── A conta, pura ───────────────────────────────────────────────────────────────────────────────────────────────────

test('o desfecho de cada jogador: vitória, empate, derrota — e quem não esteve nos times não ganha nem perde', () => {
  const venceu = desfechoDoJogo(JOGOS[0]);
  assert.deepEqual([venceu.venceram, venceu.empataram, venceu.perderam], [[OURO], [], [ROXO]], 'convidado sem app não tem conta e não entra');
  const empatou = desfechoDoJogo(JOGOS[1]);
  assert.deepEqual([empatou.venceram, empatou.empataram, empatou.perderam], [[], [OURO, ROXO], []]);
  const semResultado = desfechoDoJogo(JOGOS[3]);
  assert.deepEqual([semResultado.venceram, semResultado.empataram, semResultado.perderam], [[], [], []]);
  assert.equal(resultadoDoJogador(JOGOS[1], OURO), 'empate');
  assert.equal(resultadoDoJogador(JOGOS[0], ROXO), 'derrota');
  assert.equal(resultadoDoJogador(JOGOS[0], RESERVA), null, 'reserva não perdeu nem ganhou');
  assert.equal(resultadoDoJogador(JOGOS[3], OURO), null, 'sem resultado não é empate');
});

// ─── O motor grava o empate explícito ────────────────────────────────────────────────────────────────────────────────

function lancar(t, extra = {}) {
  const { carregados, tabelas } = carregar({
    teams: [{ id: TIME.id, nome: TIME.nome, slug: TIME.slug }],
    users: [usuario(DONO, 'Tonhão'), usuario(OURO, 'Ouro'), usuario(ROXO, 'Roxo')],
    team_members: [membro(DONO, 'Tonhão', { role: 'admin' }), membro(OURO, 'Ouro'), membro(ROXO, 'Roxo')],
    games: [{ id: 'jogo-x', team_id: TIME.id, data: passado(2), jogadores_por_time: 2, status: 'agendado', sorteio_realizado: true, times_resultado: times, ...extra }],
    game_players: [],
  }, ['routes/games', 'routes/feed']);
  return { pedir: subir([carregados['routes/games'], carregados['routes/feed']], t), tabelas };
}

test('"Empate" grava o empate explícito: campeão nulo, time_vencedor empate, resultado lançado', async (t) => {
  const { pedir, tabelas } = lancar(t);
  const r = await pedir('PATCH', '/api/games/jogo-x/resultado', { empate: true }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const g = tabelas.games[0];
  assert.deepEqual([g.campeao_time_index, g.time_vencedor, g.resultado_nivel], [null, 'empate', 1]);
});

test('o app antigo manda time_vencedor "empate": é o mesmo empate', async (t) => {
  const { pedir, tabelas } = lancar(t);
  const r = await pedir('PATCH', '/api/games/jogo-x/resultado', { nivel: 1, time_vencedor: 'empate' }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([tabelas.games[0].campeao_time_index, tabelas.games[0].time_vencedor], [null, 'empate']);
});

test('limpar o resultado volta a "sem resultado" — que NÃO é empate', async (t) => {
  const { pedir, tabelas } = lancar(t, { campeao_time_index: null, time_vencedor: 'empate', resultado_nivel: 1 });
  const r = await pedir('PATCH', '/api/games/jogo-x/resultado', { nivel: 0 }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([tabelas.games[0].campeao_time_index, tabelas.games[0].time_vencedor, tabelas.games[0].resultado_nivel], [null, null, 0]);
});

// ─── O ranking e o perfil contam ─────────────────────────────────────────────────────────────────────────────────────

test('o ranking conta vitória, empate e derrota pelo campeão; o jogo sem resultado não conta nada', async (t) => {
  const pedir = mundo(t);
  const r = await pedir('GET', '/api/teams/missa/ranking', null, OURO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const linha = (id) => r.json.ranking.find((x) => x.user_id === id);
  assert.deepEqual([linha(OURO).vitorias, linha(OURO).empates, linha(OURO).derrotas], [1, 1, 1], 'ouro: ganhou 1, empatou 1, perdeu 1');
  assert.deepEqual([linha(ROXO).vitorias, linha(ROXO).empates, linha(ROXO).derrotas], [1, 1, 1], 'roxo: ganhou 1, empatou 1, perdeu 1');
  assert.deepEqual([linha(RESERVA).vitorias, linha(RESERVA).empates, linha(RESERVA).derrotas], [0, 0, 0], 'reserva não esteve nos times');
});

test('o histórico do perfil diz V, E, D — e deixa em branco o jogo sem resultado, sem inventar empate', async (t) => {
  const pedir = mundo(t);
  const r = await pedir('GET', `/api/teams/missa/jogador/${OURO}`, null, OURO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const porJogo = Object.fromEntries(r.json.historico.map((h) => [h.game_id, h.resultado]));
  assert.deepEqual(porJogo, { 'jogo-1': 'vitoria', 'jogo-2': 'empate', 'jogo-3': 'derrota', 'jogo-4': null });
  assert.equal(r.json.conquistas.campeao, 1);
  assert.equal(r.json.conquistas.empates_total, 1);
  assert.equal(r.json.conquistas.derrotas_total, 1);
  assert.equal(r.json.conquistas.vitorias_total, 1);
});

// ─── A Resenha ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('o empate vira post na Resenha, com o placar; o jogo sem resultado continua de fora', async (t) => {
  const { carregados } = carregar({
    users: [usuario(OURO, 'Ouro')],
    team_members: [{ team_id: TIME.id, user_id: OURO, role: 'member', teams: { id: TIME.id, nome: TIME.nome, slug: TIME.slug } }],
    feed_posts: [], feed_post_media: [], comentarios: [], reacoes: [], user_blocks: [],
    games: JOGOS.map((g, i) => ({ ...g, local: 'Quadra', created_at: new Date(Date.parse('2026-10-01T12:00:00Z') + i * 60000).toISOString() })),
  }, ['routes/feed']);
  const pedir = subir([carregados['routes/feed']], t);
  const r = await pedir('GET', '/api/feed', null, OURO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const ids = r.json.items.map((i) => i.id).sort();
  assert.deepEqual(ids, ['jogo-1', 'jogo-2', 'jogo-3'], 'campeão, empate e campeão; o jogo-4 (sem resultado) não vira post');
  const empate = r.json.items.find((i) => i.id === 'jogo-2');
  assert.equal(empate.campeao_time_index, null);
  assert.equal(empate.time_vencedor, 'empate');
  assert.deepEqual([empate.placar_a, empate.placar_b], [2, 2]);
  assert.equal(empate.times_resultado.times.length, 2, 'o post tem os dois times para escrever "Ouro 2 × 2 Roxo"');
});
