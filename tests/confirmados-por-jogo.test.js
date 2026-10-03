// Futty v2.0 — Rodada 29J, achados 109/116: a contagem de confirmados divergia na mesma tela —
// cabeçalho "11 confirmados" (game_players) × bloco de presença "12 confirmados" (rsvp_respostas),
// no MESMO jogo. Causa: enquanto o RSVP está aberto e não foi fechado, quem responde grava só em
// rsvp_respostas — routes/rsvp.js só sincroniza para game_players no "Fechar presença". GET
// /api/teams/:slug/games contava sempre por game_players, por isso ficava para trás.
//
// Uso: npm test  (ou: node --test tests/confirmados-por-jogo.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');

const TIME = '11111111-1111-1111-1111-111111111111';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const J1 = '20000000-0000-0000-0000-000000000001'; // RSVP aberto, não fechado
const J2 = '20000000-0000-0000-0000-000000000002'; // RSVP fechado (já sincronizado)
const J3 = '20000000-0000-0000-0000-000000000003'; // sem RSVP (o "Vou" simples)

function cenario(t) {
  const { carregados, tabelas } = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde' }],
    users: [{ id: DONO, nome: 'Tonhão' }],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin' }],
    games: [
      { id: J1, team_id: TIME, data: '2026-10-08T23:00:00Z', rsvp_aberto: true, rsvp_fechado: false },
      { id: J2, team_id: TIME, data: '2026-10-09T23:00:00Z', rsvp_aberto: true, rsvp_fechado: true },
      { id: J3, team_id: TIME, data: '2026-10-10T23:00:00Z', rsvp_aberto: false, rsvp_fechado: false },
    ],
    // J1: só 2 linhas sincronizadas em game_players (ficou para trás), mas rsvp_respostas já tem 3 confirmados.
    game_players: [
      { game_id: J1, user_id: 'a', confirmado: true },
      { game_id: J1, user_id: 'b', confirmado: true },
      { game_id: J2, user_id: 'a', confirmado: true },
      { game_id: J3, user_id: 'a', confirmado: true },
      { game_id: J3, user_id: 'b', confirmado: false },
    ],
    rsvp_respostas: [
      { game_id: J1, user_id: 'a', status: 'confirmado' },
      { game_id: J1, user_id: 'b', status: 'confirmado' },
      { game_id: J1, user_id: 'c', status: 'confirmado' },
      { game_id: J1, user_id: 'd', status: 'recusado' },
      // J2 já fechado: rsvp_respostas pode ter mudado depois (não conta mais; vale game_players).
      { game_id: J2, user_id: 'a', status: 'confirmado' },
      { game_id: J2, user_id: 'b', status: 'confirmado' },
    ],
  }, ['routes/games']);
  const pedir = subir([carregados['routes/games']], t);
  return { pedir, tabelas };
}

test('RSVP aberto e não fechado: a contagem vem de rsvp_respostas (3), não de game_players (2, que ficou para trás)', async (t) => {
  const { pedir } = cenario(t);
  const r = await pedir('GET', '/api/teams/varzea-fc/games', null, DONO);
  assert.equal(r.status, 200);
  const j1 = r.json.games.find((g) => g.id === J1);
  assert.equal(j1.confirmados, 3, 'achado 116: a mesma conta que o bloco de presença mostra');
});

test('RSVP já fechado: a contagem vem de game_players (sincronizado no fechar), não de rsvp_respostas', async (t) => {
  const { pedir } = cenario(t);
  const r = await pedir('GET', '/api/teams/varzea-fc/games', null, DONO);
  const j2 = r.json.games.find((g) => g.id === J2);
  assert.equal(j2.confirmados, 1, 'game_players tem 1 confirmado; rsvp_respostas (2) não conta mais depois de fechado');
});

test('sem RSVP nenhum (o "Vou" simples): a contagem continua vindo de game_players, como sempre', async (t) => {
  const { pedir } = cenario(t);
  const r = await pedir('GET', '/api/teams/varzea-fc/games', null, DONO);
  const j3 = r.json.games.find((g) => g.id === J3);
  assert.equal(j3.confirmados, 1);
});
