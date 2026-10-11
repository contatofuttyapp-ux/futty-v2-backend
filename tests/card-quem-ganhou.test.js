// Futty v2.0 — RODADA 30I, item 7: o card "Quem ganhou?" no Início, só para o admin do time.
//
// Do jogo sorteado, 5 minutos depois do início (o resultado abre), até alguém marcar o campeão OU o empate. O motor entrega o card pronto em
// GET /api/inicio → seu_time[].quem_ganhou ({ game_id, data, local, times: [{ nome }] }); a tela só o desenha. A pendência "resultado por
// lançar" do card "Seus times" usa o MESMO critério (campeão ou empate marcado — nível, placar e gols sozinhos não bastam).
//
// Uso: npm test  (ou: node --test tests/card-quem-ganhou.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir, injetar } = require('./_rotas');
const { pendenciasDoTime } = require('../utils/pendenciasAdmin');

const T1 = '11111111-1111-1111-1111-111111111111';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const ZECA = 'a0000000-0000-0000-0000-00000000000a';
const MIN = 60000;
const quando = (minutosAtras) => new Date(Date.now() - minutosAtras * MIN).toISOString();
const j = (id, nome) => ({ user_id: id, nome, avatar_url: null, rating: 3 });
const dois = { seed: 1, num_times: 2, times: [{ nome: 'Time A', jogadores: [j(DONO, 'Tonhão')] }, { nome: 'Time B', jogadores: [j(ZECA, 'Zeca')] }], reservas: [] };
const tres = { ...dois, num_times: 3, times: [...dois.times, { nome: 'Time C', jogadores: [j('c0000000-0000-0000-0000-00000000000c', 'Cacá')] }] };

function mundo(t, games) {
  const restaurar = [
    injetar('utils/gabineteStore', { ler: async () => ({ ads_ativo: false }) }),
    injetar('utils/denunciaStore', { aoGravar: () => {}, listarEquipa: async () => [] }),
  ];
  const VARZEA = { id: T1, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde', created_at: '2026-01-01T00:00:00Z' };
  const c = carregar({
    users: [{ id: DONO, nome: 'Tonhão' }, { id: ZECA, nome: 'Zeca' }],
    teams: [VARZEA],
    team_members: [
      { team_id: T1, user_id: DONO, role: 'admin', created_at: '2026-01-01T00:00:00Z', teams: VARZEA },
      { team_id: T1, user_id: ZECA, role: 'member', created_at: '2026-01-02T00:00:00Z', teams: VARZEA },
    ],
    team_join_requests: [],
    games: games.map((g) => ({ team_id: T1, status: 'agendado', jogadores_por_time: 1, ...g })),
    game_players: [],
  }, ['routes/inicio', 'routes/games']);
  for (const r of restaurar.reverse()) r();
  return { pedir: subir([c.carregados['routes/inicio'], c.carregados['routes/games']], t), tabelas: c.tabelas };
}
const cardDe = async (pedir, usuario = DONO) => ((await pedir('GET', '/api/inicio', null, usuario)).json.seu_time || [])[0] || null;

test('a pendência "resultado por lançar" é jogo sem campeão nem empate — e só depois que o resultado abre (5 min)', () => {
  const agora = Date.parse('2026-10-18T23:30:00Z');
  const comecou = (min, extra = {}) => ({ id: 'g', data: new Date(agora - min * MIN).toISOString(), ...extra });
  assert.equal(pendenciasDoTime({ jogos: [comecou(4)] }, agora).resultado, null, 'aos 4 minutos ainda não abriu');
  assert.equal(pendenciasDoTime({ jogos: [comecou(6)] }, agora).resultado?.game_id, 'g');
  assert.equal(pendenciasDoTime({ jogos: [comecou(60, { campeao_time_index: 0 })] }, agora).resultado, null, 'campeão marcado: resolvido');
  assert.equal(pendenciasDoTime({ jogos: [comecou(60, { campeao_time_index: null, time_vencedor: 'empate' })] }, agora).resultado, null, 'empate marcado: resolvido');
  assert.equal(pendenciasDoTime({ jogos: [comecou(60, { resultado_nivel: 3 })] }, agora).resultado?.game_id, 'g', 'nível, placar e gols sozinhos não são resultado');
  assert.equal(pendenciasDoTime({ jogos: [comecou(60, { campeao_time_index: 1 })] }, agora).total, 0);
});

test('4 minutos depois do início: o card ainda não existe; aos 6, aparece, com o jogo e os times', async (t) => {
  const { pedir } = mundo(t, [{ id: 'g1', data: quando(4), sorteio_realizado: true, times_resultado: dois, local: 'Quadra do Zé' }]);
  const antes = await cardDe(pedir);
  assert.equal(antes.quem_ganhou, null);
  assert.equal(antes.pendencias.resultado, null);
  const { pedir: pedir6 } = mundo(t, [{ id: 'g1', data: quando(6), sorteio_realizado: true, times_resultado: dois, local: 'Quadra do Zé' }]);
  const depois = await cardDe(pedir6);
  assert.equal(depois.quem_ganhou.game_id, 'g1');
  assert.equal(depois.quem_ganhou.local, 'Quadra do Zé');
  assert.deepEqual(depois.quem_ganhou.times, [{ nome: 'Time A' }, { nome: 'Time B' }], 'só os nomes — o JSON gordo dos times não viaja');
  assert.equal(depois.pendencias.resultado.game_id, 'g1', 'a pendência do card "Seus times" é a do mesmo jogo');
  assert.ok(!('_jogoDoResultado' in depois), 'nada interno vaza');
});

test('o card some quando o admin marca o campeão — e também quando marca o empate', async (t) => {
  const { pedir, tabelas } = mundo(t, [{ id: 'g1', data: quando(10), sorteio_realizado: true, times_resultado: dois }]);
  assert.equal((await cardDe(pedir)).quem_ganhou.game_id, 'g1');
  const r = await pedir('PATCH', '/api/games/g1/resultado', { campeao_time_index: 1 }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const depois = await cardDe(pedir);
  assert.equal(depois.quem_ganhou, null);
  assert.equal(depois.pendencias.resultado, null);
  // desfaz e marca o empate
  await pedir('PATCH', '/api/games/g1/resultado', { nivel: 0 }, DONO);
  assert.equal((await cardDe(pedir)).quem_ganhou.game_id, 'g1', 'sem resultado, o card volta');
  await pedir('PATCH', '/api/games/g1/resultado', { empate: true }, DONO);
  assert.equal((await cardDe(pedir)).quem_ganhou, null);
  assert.equal(tabelas.games[0].time_vencedor, 'empate');
});

test('só gols (ou só nível) não resolvem: o card segue até haver campeão ou empate', async (t) => {
  const { pedir } = mundo(t, [{ id: 'g1', data: quando(10), sorteio_realizado: true, times_resultado: tres, resultado_nivel: 3, campeao_time_index: null }]);
  const c = await cardDe(pedir);
  assert.equal(c.quem_ganhou.game_id, 'g1');
  assert.deepEqual(c.quem_ganhou.times.map((x) => x.nome), ['Time A', 'Time B', 'Time C'], '3 times: os três no card');
});

test('jogo antigo, lançado só pela tela do jogo (campeão nulo + time_vencedor A): conta como resolvido até o conserto dos dados', async (t) => {
  const { pedir } = mundo(t, [{ id: 'g1', data: quando(10), sorteio_realizado: true, times_resultado: dois, campeao_time_index: null, time_vencedor: 'A', resultado_nivel: 1 }]);
  const c = await cardDe(pedir);
  assert.equal(c.quem_ganhou, null);
  assert.equal(c.pendencias.resultado, null);
});

test('jogo sem sorteio não tem card (não há quem perguntar), mas a pendência do "Seus times" continua', async (t) => {
  const { pedir } = mundo(t, [{ id: 'g1', data: quando(10), sorteio_realizado: false }]);
  const c = await cardDe(pedir);
  assert.equal(c.quem_ganhou, null);
  assert.equal(c.pendencias.resultado.game_id, 'g1');
});

test('só vale o ÚLTIMO jogo: um jogo antigo sem resultado não segura o card quando há um mais novo já resolvido', async (t) => {
  const { pedir } = mundo(t, [
    { id: 'velho', data: quando(60 * 24 * 7), sorteio_realizado: true, times_resultado: dois },
    { id: 'novo', data: quando(30), sorteio_realizado: true, times_resultado: dois, campeao_time_index: 0 },
  ]);
  assert.equal((await cardDe(pedir)).quem_ganhou, null);
});

test('jogo cancelado não vira card', async (t) => {
  const { pedir } = mundo(t, [{ id: 'g1', data: quando(30), sorteio_realizado: true, times_resultado: dois, cancelado: true }]);
  assert.equal((await cardDe(pedir)).quem_ganhou, null);
});

test('quem não administra o time não recebe card nenhum', async (t) => {
  const { pedir } = mundo(t, [{ id: 'g1', data: quando(30), sorteio_realizado: true, times_resultado: dois }]);
  const r = await pedir('GET', '/api/inicio', null, ZECA);
  assert.deepEqual(r.json.seu_time, []);
});
