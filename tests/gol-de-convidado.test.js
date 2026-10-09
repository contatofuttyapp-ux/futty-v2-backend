// Futty v2.0 — RODADA 30G, item 3: o gol do convidado sem app, pelo nome.
//
// Achado da 30F: o gol era gravado por user_id; convidado (sem conta) tem user_id vazio, então todo
// convidado caía no mesmo contador na lista de gols por jogador (e, antes disso, o PATCH descartava esse
// gol de vez — `filter(g => g.user_id)`). Agora ele grava pelo nome — a mesma chave
// (utils/registroDoSorteio.js#chaveDoJogador) que já localiza o convidado nos times e recusa um repetido —
// então dois convidados diferentes não se misturam. O ranking do time (utils/agregados.js) só soma
// golsMap por user_id: o gol do convidado continua de fora.
//
// Uso: npm test  (ou: node --test tests/gol-de-convidado.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');

const TIME = '11111111-1111-1111-1111-111111111111';
const JOGO = '99999999-9999-9999-9999-999999999999';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const A = 'a0000000-0000-0000-0000-00000000000a';
const B = 'b0000000-0000-0000-0000-00000000000b';
const PASSADO = '2026-01-01T20:00:00.000Z';

const usuario = (id, nome) => ({ id, nome: `${nome} da Silva`, nome_jogador: nome, email: `${nome}@futtymock.com` });
const membro = (id, nome, role = 'member') => ({ team_id: TIME, user_id: id, role, users: usuario(id, nome) });
const jMembro = (id, nome) => ({ user_id: id, nome, avatar_url: null, rating: 3 });
const jConvidado = (nome) => ({ user_id: null, convidado: true, nome, avatar_url: null, rating: 3 });

function cenario() {
  const timesResultado = {
    seed: 1,
    num_times: 2,
    times: [
      { nome: 'Time A', jogadores: [jMembro(A, 'Magrão'), jConvidado('Beto')] },
      { nome: 'Time B', jogadores: [jMembro(B, 'Zé'), jConvidado('Caio')] },
    ],
    reservas: [],
  };
  return carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc' }],
    users: [usuario(DONO, 'Chavo'), usuario(A, 'Magrão'), usuario(B, 'Zé')],
    team_members: [membro(DONO, 'Chavo', 'admin'), membro(A, 'Magrão'), membro(B, 'Zé')],
    games: [{ id: JOGO, team_id: TIME, data: PASSADO, jogadores_por_time: 2, status: 'agendado', sorteio_realizado: true, times_resultado: timesResultado }],
    game_players: [],
  }, ['routes/games', 'utils/agregados']);
}

test('dois convidados com contagens diferentes de gols não se misturam, e o gol de convidado continua fora do ranking', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);

  const corpo = {
    nivel: 3,
    time_vencedor: 'A',
    placar_a: 3,
    placar_b: 1,
    gols: [
      { user_id: A, gols: 1 },
      { user_id: null, convidado_nome: 'Beto', gols: 2 },
      { user_id: null, convidado_nome: 'Caio', gols: 1 },
    ],
  };
  const r = await pedir('PATCH', `/api/games/${JOGO}/resultado`, corpo, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));

  // gravado: 3 linhas, uma por jogador — nenhum convidado herda a contagem do outro.
  assert.equal(tabelas.gols_jogadores.length, 3);
  const beto = tabelas.gols_jogadores.find((g) => g.convidado_nome === 'Beto');
  const caio = tabelas.gols_jogadores.find((g) => g.convidado_nome === 'Caio');
  const magrao = tabelas.gols_jogadores.find((g) => g.user_id === A);
  assert.equal(beto.gols, 2);
  assert.equal(caio.gols, 1);
  assert.equal(magrao.gols, 1);
  assert.equal(beto.user_id, null);
  assert.equal(caio.user_id, null);
  // cada convidado no seu time (Beto no A, Caio no B) — a chave do motor, não um contador cruzado entre times.
  assert.equal(beto.time, 'A');
  assert.equal(caio.time, 'B');

  // a tela do jogo recebe os dois convidados separados, cada um com o próprio nome e a própria contagem.
  const jogo = await pedir('GET', `/api/games/${JOGO}`, null, DONO);
  assert.equal(jogo.status, 200, JSON.stringify(jogo.json));
  const porConvidado = Object.fromEntries(jogo.json.gols.filter((g) => !g.user_id).map((g) => [g.nome, g.gols]));
  assert.deepEqual(porConvidado, { Beto: 2, Caio: 1 });

  // fora do ranking: os agregados do time só somam golsMap por user_id — o convidado nunca entra, mesmo tendo marcado mais gols que o Magrão.
  const { golsMap } = await carregados['utils/agregados'].agregadosDaEquipa(TIME, { jogos: [{ id: JOGO }] });
  assert.deepEqual(golsMap, { [A]: 1 });
});

test('resultado sem convidado continua gravando como antes (nada muda para quem tem conta)', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('PATCH', `/api/games/${JOGO}/resultado`, { nivel: 3, time_vencedor: 'A', placar_a: 2, placar_b: 0, gols: [{ user_id: A, gols: 2 }, { user_id: B, gols: 0 }] }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(tabelas.gols_jogadores.length, 2);
  assert.ok(tabelas.gols_jogadores.every((g) => g.convidado_nome === null));
});
