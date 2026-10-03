// Futty v2.0 — Rodada 29I (achado 104): a seção "PRESENÇA" das Estatísticas do admin listava VITÓRIAS ("Tonhão 3 vitórias").
// O título promete presença: GET /api/teams/:slug/membros passa a entregar `presencas` — os jogos em que a pessoa esteve (confirmada
// num jogo já encerrado e não cancelado) —, e a tela ordena por isso. Sem banco e sem rede (Supabase falso em memória).
//
// Uso: npm test  (ou: node --test tests/membros-presencas.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');

const TIME = { id: 'time-1', nome: 'Missa de Quinta', slug: 'missa', cor: 'verde', criado_por: 'a', created_at: '2026-01-01T00:00:00Z' };
const ADMIN = 'a0000000-0000-0000-0000-00000000000a';
const TONHAO = 'b0000000-0000-0000-0000-00000000000b'; // 3 vitórias, 1 presença
const CANHOTINHA = 'c0000000-0000-0000-0000-00000000000c'; // 0 vitórias, 4 presenças
const MAGRAO = 'd0000000-0000-0000-0000-00000000000d'; // 0 vitórias, 2 presenças (uma em jogo cancelado, uma em jogo futuro)

const usuario = (id, nome) => ({ id, nome, nome_jogador: nome, avatar_url: null, email: `${nome}@futtymock.com` });
const membro = (id, nome, extra = {}) => ({ id: `m-${nome}`, team_id: TIME.id, user_id: id, role: 'member', categoria: 'linha', users: usuario(id, nome), ...extra });
const dias = (n) => new Date(Date.now() + n * 864e5).toISOString();

function cenario() {
  const jogo = (id, quando, extra = {}) => ({ id, team_id: TIME.id, data: quando, created_at: quando, status: 'terminado', resultado_nivel: 1, time_vencedor: 'A', cancelado: false, ...extra });
  return {
    teams: [TIME],
    team_members: [membro(ADMIN, 'Chavo', { role: 'admin' }), membro(TONHAO, 'Tonhão'), membro(CANHOTINHA, 'Canhotinha'), membro(MAGRAO, 'Magrão')],
    games: [
      // 4 jogos encerrados: o Tonhão ganhou 3 (time A), mas só esteve em 1 — a vitória vem do time sorteado do jogo, a presença do confirmado.
      jogo('j1', dias(-30), { times_resultado: { times: [{ jogadores: [{ user_id: TONHAO }] }, { jogadores: [] }] } }),
      jogo('j2', dias(-23), { times_resultado: { times: [{ jogadores: [{ user_id: TONHAO }] }, { jogadores: [] }] } }),
      jogo('j3', dias(-16), { times_resultado: { times: [{ jogadores: [{ user_id: TONHAO }] }, { jogadores: [] }] } }),
      jogo('j4', dias(-9), { times_resultado: { times: [{ jogadores: [] }, { jogadores: [] }] } }),
      jogo('cancelado', dias(-5), { status: 'cancelado', cancelado: true }),
      jogo('futuro', dias(5), { status: 'agendado', resultado_nivel: 0 }),
    ],
    game_players: [
      { game_id: 'j1', user_id: TONHAO, confirmado: true },
      { game_id: 'j1', user_id: CANHOTINHA, confirmado: true }, { game_id: 'j2', user_id: CANHOTINHA, confirmado: true },
      { game_id: 'j3', user_id: CANHOTINHA, confirmado: true }, { game_id: 'j4', user_id: CANHOTINHA, confirmado: true },
      { game_id: 'j4', user_id: MAGRAO, confirmado: true },
      { game_id: 'cancelado', user_id: MAGRAO, confirmado: true }, // jogo cancelado: não conta
      { game_id: 'futuro', user_id: MAGRAO, confirmado: true }, // jogo que ainda vai acontecer: não conta
      { game_id: 'j2', user_id: MAGRAO, confirmado: false }, // desistiu: não conta
    ],
    votes: [], gols_jogadores: [], users: [],
  };
}

test('GET /api/teams/:slug/membros entrega `presencas`: os jogos em que a pessoa esteve (encerrados, não cancelados, confirmada)', async (t) => {
  const { carregados } = carregar(cenario(), ['routes/teams']);
  const pedir = subir([carregados['routes/teams']], t);
  const r = await pedir('GET', '/api/teams/missa/membros', null, ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const por = Object.fromEntries(r.json.membros.map((m) => [m.user_id, m]));
  assert.equal(por[CANHOTINHA].presencas, 4);
  assert.equal(por[TONHAO].presencas, 1);
  assert.equal(por[MAGRAO].presencas, 1, 'cancelado, futuro e "não vou" não contam');
  assert.equal(por[ADMIN].presencas, 0);
});

test('presença e vitória são coisas diferentes: quem mais ganhou não é quem mais esteve', async (t) => {
  const { carregados } = carregar(cenario(), ['routes/teams']);
  const pedir = subir([carregados['routes/teams']], t);
  const { membros } = (await pedir('GET', '/api/teams/missa/membros', null, ADMIN)).json;
  const maisVitorias = [...membros].sort((a, b) => b.vitorias - a.vitorias)[0];
  const maisPresencas = [...membros].sort((a, b) => b.presencas - a.presencas)[0];
  assert.equal(maisVitorias.user_id, TONHAO);
  assert.equal(maisPresencas.user_id, CANHOTINHA);
});
