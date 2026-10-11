// Futty v2.0 — RODADA 30I, item 6: o resultado abre 5 MINUTOS depois do início do jogo.
//
// Antes abria no horário marcado: o admin lançava "quem ganhou" com a bola ainda rolando. Agora vale início + 5 minutos (a mesma conta que faz o card
// "Quem ganhou?" aparecer no Início). Jogo histórico ("Jogo passado") não tem trava. Vale para os dois caminhos que gravam resultado.
//
// Uso: npm test  (ou: node --test tests/trava-resultado.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');
const { ESPERA_DO_RESULTADO_MS, resultadoAbreEm, resultadoJaAbriu } = require('../utils/resultadoDoJogo');

const TIME = '11111111-1111-1111-1111-111111111111';
const JOGO = '99999999-9999-9999-9999-999999999999';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const A = 'a0000000-0000-0000-0000-00000000000a';
const MIN = 60000;
const usuario = (id, nome) => ({ id, nome: `${nome} da Silva`, nome_jogador: nome, email: `${nome}@futtymock.com` });
const times = { seed: 1, num_times: 2, times: [{ nome: 'Ouro', jogadores: [{ user_id: A, nome: 'Magrão' }] }, { nome: 'Roxo', jogadores: [{ user_id: null, nome: 'Beto', convidado: true }] }], reservas: [] };
const quando = (minutosAtras) => new Date(Date.now() - minutosAtras * MIN).toISOString();

function cenario(extra = {}) {
  return carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc' }],
    users: [usuario(DONO, 'Chavo'), usuario(A, 'Magrão')],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin', users: usuario(DONO, 'Chavo') }, { team_id: TIME, user_id: A, role: 'member', users: usuario(A, 'Magrão') }],
    games: [{ id: JOGO, team_id: TIME, data: quando(10), jogadores_por_time: 1, status: 'agendado', sorteio_realizado: true, times_resultado: times, ...extra }],
    game_players: [],
  }, ['routes/games', 'routes/feed']);
}

test('a espera é de 5 minutos; resultadoAbreEm e resultadoJaAbriu fazem a conta', () => {
  assert.equal(ESPERA_DO_RESULTADO_MS, 5 * MIN);
  const inicio = Date.parse('2026-10-18T23:00:00Z');
  assert.equal(resultadoAbreEm({ data: '2026-10-18T23:00:00Z' }), inicio + 5 * MIN);
  assert.equal(resultadoAbreEm({}), null);
  assert.equal(resultadoAbreEm(null), null);
  const jogo = { data: '2026-10-18T23:00:00Z' };
  assert.equal(resultadoJaAbriu(jogo, inicio - MIN), false, 'antes do início');
  assert.equal(resultadoJaAbriu(jogo, inicio), false, 'no início o resultado ainda não abriu');
  assert.equal(resultadoJaAbriu(jogo, inicio + 5 * MIN - 1), false, 'um milissegundo antes dos 5 minutos');
  assert.equal(resultadoJaAbriu(jogo, inicio + 5 * MIN), true, 'aos 5 minutos abre');
  assert.equal(resultadoJaAbriu(jogo, inicio + 90 * MIN), true);
  assert.equal(resultadoJaAbriu({ historico: true, data: '2999-01-01T00:00:00Z' }, inicio), true, 'jogo histórico não tem trava');
  assert.equal(resultadoJaAbriu({}, inicio), false, 'sem data não abre');
});

test('4 minutos depois do início: o resultado ainda está fechado, nos dois caminhos, e nada é gravado', async (t) => {
  const { carregados, tabelas } = cenario({ data: quando(4) });
  const pedir = subir([carregados['routes/games'], carregados['routes/feed']], t);
  const a = await pedir('PATCH', `/api/games/${JOGO}/resultado`, { campeao_time_index: 0 }, DONO);
  const b = await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { campeao_time_index: 0 }, DONO);
  const c = await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { destaque_user_id: A }, DONO);
  for (const r of [a, b, c]) {
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(r.json.error, /abre 5 minutos depois do início do jogo/);
  }
  assert.equal(tabelas.games[0].campeao_time_index, undefined);
  assert.equal(tabelas.games[0].destaque_user_id, undefined);
});

test('antes do início também está fechado', async (t) => {
  const { carregados } = cenario({ data: quando(-30) });
  const pedir = subir([carregados['routes/games']], t);
  assert.equal((await pedir('PATCH', `/api/games/${JOGO}/resultado`, { campeao_time_index: 0 }, DONO)).status, 400);
});

test('6 minutos depois do início: abre — nos dois caminhos', async (t) => {
  const { carregados, tabelas } = cenario({ data: quando(6) });
  const pedir = subir([carregados['routes/games'], carregados['routes/feed']], t);
  assert.equal((await pedir('PATCH', `/api/games/${JOGO}/resultado`, { campeao_time_index: 0 }, DONO)).status, 200);
  assert.equal((await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { destaque_user_id: A }, DONO)).status, 200);
  assert.equal(tabelas.games[0].campeao_time_index, 0);
  assert.equal(tabelas.games[0].destaque_user_id, A);
});

test('jogo histórico ("Jogo passado") não tem trava, mesmo com a data no futuro', async (t) => {
  const { carregados, tabelas } = cenario({ data: quando(-60), historico: true });
  const pedir = subir([carregados['routes/games'], carregados['routes/feed']], t);
  assert.equal((await pedir('PATCH', `/api/games/${JOGO}/resultado`, { empate: true }, DONO)).status, 200);
  assert.equal((await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { destaque_user_id: A }, DONO)).status, 200);
  assert.equal(tabelas.games[0].time_vencedor, 'empate');
});
