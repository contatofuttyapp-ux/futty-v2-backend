// Futty v2.0 — os campeões dos jogos de antes do app, anotados depois como convidados sem app (FUT\DADOS-31V.sql).
//
// O jogo antigo não teve sorteio: só a foto do campeão. O dono anotou quem foi campeão e os nomes entram como o time campeão do jogo
// (`times_resultado` com UM time, `registro.campeoes`, convidados sem conta), o campeão apontado para ele. O que se tranca aqui:
//   · antes de alguém ser associado, o Ranking não muda: convidado sem app não ganha vitória, derrota nem jogo — só quem tem a conta (o dono);
//   · "Associar jogador" funciona igual a um sorteio: a vaga, a vitória e a presença vão para a conta; o Desfazer devolve tudo;
//   · a página do jogo mostra o time campeão com os nomes e a foto continua;
//   · o resultado salvo de novo (o editor manda campeao_time_index 0) é aceito e não apaga o campeão.
//
// Uso: npm test  (ou: node --test tests/campeoes-antigos.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');

const TIME = '11111111-1111-1111-1111-111111111111';
const JOGO = '99999999-9999-9999-9999-999999999991';
const JOGO_DO_DONO = '99999999-9999-9999-9999-999999999992';
const DONO = 'c3626394-6589-423e-ae6a-e71317366ec4';
const ERIC = 'e0000000-0000-0000-0000-0000000000e1'; // entrou no time depois
const KIM = 'e0000000-0000-0000-0000-0000000000e2';
const PASSADO = '2026-09-03T20:00:00.000Z';

const usuario = (id, nome, apelido = nome) => ({ id, nome: `${nome} da Silva`, nome_jogador: apelido, email: `${nome}@futtymock.com`, avatar_url: `https://x.test/${apelido}.webp` });
const membro = (id, nome, role = 'member', apelido = nome) => ({ team_id: TIME, user_id: id, role, users: usuario(id, nome, apelido) });
const convidado = (nome) => ({ user_id: null, nome, avatar_url: null, convidado: true });

/** O que o DADOS-31V.sql grava num jogo antigo (o mesmo formato, campo a campo). */
const campeoesAnotados = (jogadores) => ({
  manual: true,
  num_times: 1,
  total_jogadores: jogadores.length,
  times: [{ nome: 'Time campeão', jogadores }],
  reservas: [],
  registro: { origem: 'manual', campeoes: true, em: '2026-10-16T20:00:00.000Z', ajustes: [], sorteios: 0, por: { id: DONO, nome: 'Chavo, el matador' } },
});
const jogoAntigo = (id, jogadores) => ({
  id, team_id: TIME, data: PASSADO, status: 'agendado', historico: true, campeao_foto_url: `https://x.test/resenha/${id}.webp`,
  times_resultado: campeoesAnotados(jogadores), campeao_time_index: 0, time_vencedor: null, num_times: 1, sorteio_realizado: true, resultado_nivel: 1,
});

// Um Storage em memória, no lugar do bucket "campeonatos" (o Associar confere se o jogo virou campeonato).
const storageVazio = () => ({ from: () => ({ list: async () => ({ data: [] }), download: async () => ({ data: null, error: { message: 'not found' } }), upload: async () => ({ error: null }) }) });

function cenario() {
  const t = carregar({
    teams: [{ id: TIME, nome: 'Missa de Quinta', slug: 'missa-de-quinta' }],
    users: [usuario(DONO, 'Pedro', 'Chavo, el matador'), usuario(ERIC, 'Eric'), usuario(KIM, 'Kim')],
    team_members: [membro(DONO, 'Pedro', 'admin', 'Chavo, el matador'), membro(ERIC, 'Eric'), membro(KIM, 'Kim')],
    games: [
      jogoAntigo(JOGO, [convidado('Igor'), convidado('Eric Lopes'), convidado('K9'), convidado('Kim'), convidado('Marcos')]),
      // O jogo em que o dono foi campeão: ele entra com a conta dele direto (e a presença no jogo).
      jogoAntigo(JOGO_DO_DONO, [convidado('K9'), { user_id: DONO, nome: 'Chavo, el matador', avatar_url: null }, convidado('Gui')]),
    ],
    game_players: [{ id: 'gp1', game_id: JOGO_DO_DONO, user_id: DONO, confirmado: true }],
    gols_jogadores: [],
    feed_posts: [],
  }, ['routes/games', 'routes/campeonatos', 'utils/campeonatoStore', 'utils/agregados']);
  t.cliente.storage = storageVazio();
  return t;
}

const rota = `/api/games/${JOGO}/associar-jogador`;
const linha = (tabelas, id = JOGO) => tabelas.games.find((g) => g.id === id);

test('antes de associar: convidado sem app não pontua — só o dono (com a conta) tem a vitória do jogo dele', async () => {
  const { carregados } = cenario();
  const ag = await carregados['utils/agregados'].agregadosDaEquipa(TIME);
  assert.deepEqual(ag.vitoriasMap, { [DONO]: 1 });
  assert.deepEqual(ag.derrotasMap, {}, 'um time só: ninguém perdeu');
  assert.deepEqual(ag.empatesMap, {});
});

test('a página do jogo mostra o time campeão com os nomes, a foto e o campeão; a lista do "Associar" traz os 5 convidados', async (t) => {
  const { carregados } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  const jogo = await pedir('GET', `/api/games/${JOGO}`, null, ERIC);
  assert.equal(jogo.status, 200, JSON.stringify(jogo.json));
  assert.deepEqual(jogo.json.game.times_resultado.times[0].jogadores.map((j) => j.nome), ['Igor', 'Eric Lopes', 'K9', 'Kim', 'Marcos']);
  assert.equal(jogo.json.game.campeao_time_index, 0);
  assert.equal(jogo.json.game.campeao_foto_url, `https://x.test/resenha/${JOGO}.webp`);
  const lista = await pedir('GET', rota, null, DONO);
  assert.equal(lista.status, 200);
  assert.deepEqual(lista.json.convidados.map((c) => [c.nome, c.time, c.time_nome]), [['Igor', 0, 'Time campeão'], ['Eric Lopes', 0, 'Time campeão'], ['K9', 0, 'Time campeão'], ['Kim', 0, 'Time campeão'], ['Marcos', 0, 'Time campeão']]);
});

test('associar "Eric Lopes" → a conta do Eric: vaga, vitória e presença; o jogo continua sendo dos campeões anotados; Desfazer devolve tudo', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('POST', rota, { convidado_nome: 'Eric Lopes', user_id: ERIC }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const tr = linha(tabelas).times_resultado;
  assert.deepEqual(tr.times[0].jogadores.map((j) => [j.user_id, j.nome, !!j.convidado]), [[null, 'Igor', true], [ERIC, 'Eric', false], [null, 'K9', true], [null, 'Kim', true], [null, 'Marcos', true]]);
  assert.equal(tr.times.length, 1);
  assert.equal(tr.registro.campeoes, true, 'segue reconhecido como campeões anotados (o SQL de novo não mexe nele)');
  assert.equal(linha(tabelas).campeao_time_index, 0);
  const ag = await carregados['utils/agregados'].agregadosDaEquipa(TIME);
  assert.equal(ag.vitoriasMap[ERIC], 1);
  assert.equal(ag.vitoriasMap[KIM], undefined, 'quem não foi associado continua sem nada');
  assert.equal(tabelas.game_players.filter((p) => p.user_id === ERIC && p.game_id === JOGO && p.confirmado).length, 1);

  const d = await pedir('POST', `${rota}/desfazer`, { user_id: ERIC }, DONO);
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.deepEqual(linha(tabelas).times_resultado.times[0].jogadores.map((j) => [j.user_id, j.nome]), [[null, 'Igor'], [null, 'Eric Lopes'], [null, 'K9'], [null, 'Kim'], [null, 'Marcos']]);
  assert.equal((await carregados['utils/agregados'].agregadosDaEquipa(TIME)).vitoriasMap[ERIC], undefined);
  assert.equal(tabelas.game_players.filter((p) => p.user_id === ERIC).length, 0, 'a presença que a associação criou saiu');
});

test('salvar o resultado de novo num jogo de um time só (campeao_time_index 0) é aceito e mantém o campeão', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('PATCH', `/api/games/${JOGO}/resultado`, { campeao_time_index: 0, empate: false, gols: [] }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(linha(tabelas).campeao_time_index, 0);
  assert.equal(linha(tabelas).time_vencedor, null);
});
