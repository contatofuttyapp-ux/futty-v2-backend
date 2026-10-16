// Futty v2.0 — "Associar em todos os jogos do time": ao associar um convidado sem app num jogo, o admin pode fazer o mesmo em cada OUTRO jogo do
// time em que o mesmo nome aparece (nomes iguais pela regra do Associar — nomeNorm: sem espaço sobrando, sem diferença de maiúscula). Cada jogo
// ganha a sua associação, com o seu Desfazer de 24 h; o jogo em que não dá (o membro já está nele, já tem gols nele) fica de fora e volta com o
// motivo. Nada passa para outro time, nem para outro nome.
//
// Uso: npm test  (ou: node --test tests/associar-em-todos.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');

const TIME = '11111111-1111-1111-1111-111111111111';
const OUTRO_TIME = '22222222-2222-2222-2222-222222222222';
const DONO = 'c3626394-6589-423e-ae6a-e71317366ec4';
const ERIC = 'e0000000-0000-0000-0000-0000000000e1';
const KIM = 'e0000000-0000-0000-0000-0000000000e2';
const J = (n) => `99999999-9999-9999-9999-99999999999${n}`;

const usuario = (id, nome) => ({ id, nome: `${nome} da Silva`, nome_jogador: nome, email: `${nome}@futtymock.com`, avatar_url: null });
const membro = (team, id, nome, role = 'member') => ({ team_id: team, user_id: id, role, users: usuario(id, nome) });
const convidado = (nome) => ({ user_id: null, nome, avatar_url: null, convidado: true });
const conta = (id, nome) => ({ user_id: id, nome, avatar_url: null });
const sorteio = (a, b) => ({ times: [{ nome: 'Time Ouro', jogadores: a }, { nome: 'Time Roxo', jogadores: b }], reservas: [], registro: { origem: 'sorteio', ajustes: [] } });
const jogo = (id, team, dias, tr, extra = {}) => ({
  id, team_id: team, data: new Date(Date.now() - dias * 86400000).toISOString(), status: 'agendado', times_resultado: tr, campeao_time_index: 0, num_times: 2, sorteio_realizado: true, ...extra,
});

function cenario() {
  const t = carregar({
    teams: [{ id: TIME, nome: 'Missa de Quinta', slug: 'missa' }, { id: OUTRO_TIME, nome: 'Outro FC', slug: 'outro' }],
    users: [usuario(DONO, 'Chavo'), usuario(ERIC, 'Eric'), usuario(KIM, 'Kim')],
    team_members: [membro(TIME, DONO, 'Chavo', 'admin'), membro(TIME, ERIC, 'Eric'), membro(TIME, KIM, 'Kim'), membro(OUTRO_TIME, DONO, 'Chavo', 'admin')],
    games: [
      jogo(J(1), TIME, 7, sorteio([conta(DONO, 'Chavo'), convidado('Eric Lopes')], [convidado('Igor')])), // o jogo onde o admin toca
      jogo(J(2), TIME, 14, sorteio([convidado('Igor')], [convidado(' eric lopes ')])), // mesmo nome, outra caixa e espaços → entra
      jogo(J(3), TIME, 21, sorteio([convidado('Eric Lopes'), conta(ERIC, 'Eric')], [convidado('Kim')])), // o Eric já está nele → pulado
      jogo(J(4), TIME, 28, sorteio([convidado('Eric')], [convidado('Marcos')])), // outro nome ("Eric" ≠ "Eric Lopes") → não conta
      jogo(J(5), OUTRO_TIME, 10, sorteio([convidado('Eric Lopes')], [convidado('Zé')])), // outro time → nunca
      jogo(J(6), TIME, 35, sorteio([convidado('Eric Lopes')], [convidado('Zé')]), { cancelado: true }), // cancelado → não conta
      jogo(J(7), TIME, 42, sorteio([convidado('Gui')], [convidado('Eric Lopes')])), // entra
    ],
    game_players: [{ id: 'gp3', game_id: J(3), user_id: ERIC, confirmado: true }],
    gols_jogadores: [{ id: 'g7', game_id: J(7), user_id: null, convidado_nome: 'Eric Lopes', gols: 2 }],
    feed_posts: [],
  }, ['routes/games', 'utils/agregados']);
  t.cliente.storage = { from: () => ({ list: async () => ({ data: [] }), download: async () => ({ data: null, error: { message: 'not found' } }), upload: async () => ({ error: null }) }) };
  return t;
}

const rota = (id) => `/api/games/${id}/associar-jogador`;
const jogadoresDe = (tabelas, id) => tabelas.games.find((g) => g.id === id).times_resultado.times.flatMap((t) => t.jogadores).map((j) => [j.user_id, j.nome.trim()]);

test('a lista do Associar diz em quantos OUTROS jogos do time o nome aparece (mesmo nome, mesmo time, sem cancelado)', async (t) => {
  const { carregados } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('GET', rota(J(1)), null, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const por = Object.fromEntries(r.json.convidados.map((c) => [c.nome, c.outros_jogos]));
  // Eric Lopes: J2, J3 e J7 (J4 é outro nome, J5 outro time, J6 cancelado). Igor: J2.
  assert.deepEqual(por, { 'Eric Lopes': 3, Igor: 1 });
});

test('"Associar em todos": associa aqui e em cada outro jogo do time com o mesmo nome; o que não dá volta com o motivo', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('POST', rota(J(1)), { convidado_nome: 'Eric Lopes', user_id: ERIC, em_todos: true }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ja_associado, false);
  assert.equal(r.json.em_todos.associados, 2, JSON.stringify(r.json.em_todos)); // J2 e J7
  assert.deepEqual(r.json.em_todos.pulados.map((p) => [p.game_id, p.motivo]), [[J(3), 'Eric já está neste jogo; um jogador não ocupa duas vagas.']]);

  assert.deepEqual(jogadoresDe(tabelas, J(1)), [[DONO, 'Chavo'], [ERIC, 'Eric'], [null, 'Igor']]);
  assert.deepEqual(jogadoresDe(tabelas, J(2)), [[null, 'Igor'], [ERIC, 'Eric']], 'a mesma vaga, no outro jogo');
  assert.deepEqual(jogadoresDe(tabelas, J(7)), [[null, 'Gui'], [ERIC, 'Eric']]);
  assert.deepEqual(jogadoresDe(tabelas, J(3)), [[null, 'Eric Lopes'], [ERIC, 'Eric'], [null, 'Kim']], 'pulado: nada mudou');
  assert.deepEqual(jogadoresDe(tabelas, J(4)), [[null, 'Eric'], [null, 'Marcos']], 'outro nome: nada mudou');
  assert.deepEqual(jogadoresDe(tabelas, J(5)), [[null, 'Eric Lopes'], [null, 'Zé']], 'outro time: nada mudou');
  assert.deepEqual(jogadoresDe(tabelas, J(6)), [[null, 'Eric Lopes'], [null, 'Zé']], 'jogo cancelado: nada mudou');

  // os gols do convidado no J7 foram para a conta; a presença foi criada em cada jogo associado (uma só por jogo)
  assert.equal(tabelas.gols_jogadores.find((g) => g.id === 'g7').user_id, ERIC);
  for (const id of [J(1), J(2), J(7)]) assert.equal(tabelas.game_players.filter((p) => p.game_id === id && p.user_id === ERIC && p.confirmado).length, 1, id);
  // cada jogo tem a sua associação, com o seu Desfazer de 24 h
  for (const id of [J(1), J(2), J(7)]) {
    const a = tabelas.games.find((g) => g.id === id).times_resultado.registro.associacoes;
    assert.equal(a.length, 1, id);
    assert.equal(a[0].user_id, ERIC);
  }
});

test('o Desfazer de um jogo devolve só aquele jogo; os outros continuam associados', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  assert.equal((await pedir('POST', rota(J(1)), { convidado_nome: 'Eric Lopes', user_id: ERIC, em_todos: true }, DONO)).status, 200);
  const d = await pedir('POST', `${rota(J(2))}/desfazer`, { user_id: ERIC }, DONO);
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.deepEqual(jogadoresDe(tabelas, J(2)), [[null, 'Igor'], [null, 'eric lopes']], 'o convidado volta como estava (com o nome como estava)');
  assert.deepEqual(jogadoresDe(tabelas, J(1)), [[DONO, 'Chavo'], [ERIC, 'Eric'], [null, 'Igor']]);
  assert.deepEqual(jogadoresDe(tabelas, J(7)), [[null, 'Gui'], [ERIC, 'Eric']]);
});

test('repetir o pedido não duplica nada (os jogos já associados nem aparecem: o convidado já não está neles)', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  await pedir('POST', rota(J(1)), { convidado_nome: 'Eric Lopes', user_id: ERIC, em_todos: true }, DONO);
  const antes = JSON.stringify(tabelas.games);
  const r = await pedir('POST', rota(J(1)), { convidado_nome: 'Eric Lopes', user_id: ERIC, em_todos: true }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ja_associado, true);
  assert.equal(r.json.em_todos.associados, 0);
  assert.deepEqual(r.json.em_todos.pulados.map((p) => p.game_id), [J(3)], 'só o jogo em que nunca deu');
  assert.equal(JSON.stringify(tabelas.games), antes);
  assert.equal(tabelas.game_players.filter((p) => p.user_id === ERIC).length, 4); // J1, J2, J7 + a que já existia no J3
});

test('sem "em_todos" continua como sempre: só este jogo', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('POST', rota(J(1)), { convidado_nome: 'Eric Lopes', user_id: ERIC }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.em_todos, undefined);
  assert.deepEqual(jogadoresDe(tabelas, J(2)), [[null, 'Igor'], [null, 'eric lopes']]);
});

test('só o admin associa, também em todos', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  const antes = JSON.stringify(tabelas.games);
  const r = await pedir('POST', rota(J(1)), { convidado_nome: 'Eric Lopes', user_id: ERIC, em_todos: true }, KIM);
  assert.equal(r.status, 403);
  assert.equal(JSON.stringify(tabelas.games), antes);
});
