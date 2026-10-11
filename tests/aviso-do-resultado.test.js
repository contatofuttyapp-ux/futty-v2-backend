// Futty v2.0 — RODADA 30I, item 5: o aviso "Resultado registrado!" sai UMA vez por jogo.
//
// O editor do resultado grava em dois pedidos (o resultado em PATCH /api/games/:id/resultado, os prêmios em PATCH
// /api/feed/games/:id/resultado) e o resultado pode ser corrigido. O aviso sai quando o jogo passa de "nada para ver" a "tem o que ver"
// — nunca a cada salvamento.
//
// Uso: npm test  (ou: node --test tests/aviso-do-resultado.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');
const { temNovidade, anunciarResultado } = require('../utils/avisoDoResultado');

const TIME = '11111111-1111-1111-1111-111111111111';
const JOGO = '99999999-9999-9999-9999-999999999999';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const A = 'a0000000-0000-0000-0000-00000000000a';
const B = 'b0000000-0000-0000-0000-00000000000b';
const PASSADO = '2026-01-01T20:00:00.000Z';

const usuario = (id, nome) => ({ id, nome: `${nome} da Silva`, nome_jogador: nome, email: `${nome}@futtymock.com` });
const membro = (id, nome, role = 'member') => ({ team_id: TIME, user_id: id, role, users: usuario(id, nome) });
const times = { seed: 1, num_times: 2, times: [{ nome: 'Ouro', jogadores: [{ user_id: A, nome: 'Magrão' }] }, { nome: 'Roxo', jogadores: [{ user_id: B, nome: 'Zé' }] }], reservas: [] };

function cenario(extra = {}) {
  const c = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc' }],
    users: [usuario(DONO, 'Chavo'), usuario(A, 'Magrão'), usuario(B, 'Zé')],
    team_members: [membro(DONO, 'Chavo', 'admin'), membro(A, 'Magrão'), membro(B, 'Zé')],
    games: [{ id: JOGO, team_id: TIME, data: PASSADO, local: 'Quadra do Zé', jogadores_por_time: 1, status: 'agendado', sorteio_realizado: true, times_resultado: times, ...extra }],
    game_players: [],
  }, ['routes/games', 'routes/feed']);
  return c;
}
const esperar = () => new Promise((r) => setTimeout(r, 30)); // o aviso é "dispara e esquece", depois da resposta

test('temNovidade: resultado (campeão ou empate) ou prêmio; jogo sem nada não tem', () => {
  assert.equal(temNovidade({}), false);
  assert.equal(temNovidade(null), false);
  assert.equal(temNovidade({ campeao_time_index: 0 }), true);
  assert.equal(temNovidade({ time_vencedor: 'empate' }), true);
  assert.equal(temNovidade({ artilheiro_user_id: A }), true);
  assert.equal(temNovidade({ destaque_user_id: A }), true);
  assert.equal(temNovidade({ rodada_user_id: A }), true);
});

test('anunciarResultado: só quando passa de nada a algo — nunca duas vezes, nunca sem novidade', async () => {
  const enviados = [];
  const base = { local: 'Quadra', membros: async () => ['u1', 'u2'], enviar: (ids, payload, opcoes) => enviados.push({ ids, payload, opcoes }) };
  assert.equal(anunciarResultado({ ...base, antes: {}, depois: {} }), null, 'nada antes, nada depois');
  assert.equal(anunciarResultado({ ...base, antes: { campeao_time_index: 0 }, depois: { campeao_time_index: 1 } }), null, 'corrigir não avisa');
  await anunciarResultado({ ...base, antes: {}, depois: { campeao_time_index: 0 } });
  assert.equal(enviados.length, 1);
  assert.deepEqual(enviados[0].ids, ['u1', 'u2']);
  assert.equal(enviados[0].payload.title, '🏆 Resultado registrado!');
  assert.match(enviados[0].payload.body, /Quadra/);
  assert.deepEqual(enviados[0].opcoes, { categoria: 'resenha' });
});

test('o editor novo (resultado + prêmios, dois pedidos) avisa o time UMA vez', async (t) => {
  const { carregados, notificacoes } = cenario();
  const pedir = subir([carregados['routes/games'], carregados['routes/feed']], t);
  assert.equal((await pedir('PATCH', `/api/games/${JOGO}/resultado`, { campeao_time_index: 0, gols: [{ user_id: A, gols: 2 }] }, DONO)).status, 200);
  assert.equal((await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { artilheiro_user_id: A, artilheiro_gols: 2, destaque_user_id: null }, DONO)).status, 200);
  await esperar();
  assert.equal(notificacoes.length, 1, 'um aviso só, no primeiro pedido que deu resultado');
  assert.deepEqual(notificacoes[0].ids.sort(), [DONO, A, B].sort());
});

test('corrigir o resultado depois de anunciado não avisa de novo', async (t) => {
  const { carregados, notificacoes } = cenario();
  const pedir = subir([carregados['routes/games'], carregados['routes/feed']], t);
  await pedir('PATCH', `/api/games/${JOGO}/resultado`, { campeao_time_index: 0 }, DONO);
  await pedir('PATCH', `/api/games/${JOGO}/resultado`, { campeao_time_index: 1 }, DONO);
  await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { campeao_time_index: 0 }, DONO);
  await esperar();
  assert.equal(notificacoes.length, 1);
});

test('o empate também é um resultado a anunciar', async (t) => {
  const { carregados, notificacoes } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  await pedir('PATCH', `/api/games/${JOGO}/resultado`, { empate: true }, DONO);
  await esperar();
  assert.equal(notificacoes.length, 1);
});

test('app antigo: Ajustes → Jogos só com o campeão (pedido do feed) também avisa, uma vez', async (t) => {
  const { carregados, notificacoes } = cenario();
  const pedir = subir([carregados['routes/feed']], t);
  await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { campeao_time_index: 1 }, DONO);
  await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { campeao_time_index: 1, destaque_user_id: B }, DONO);
  await esperar();
  assert.equal(notificacoes.length, 1);
});

test('só prêmio, sem resultado, avisa uma vez (o Jogo passado sem times); limpar o resultado e lançar de novo avisa de novo', async (t) => {
  const { carregados, notificacoes } = cenario();
  const pedir = subir([carregados['routes/games'], carregados['routes/feed']], t);
  await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { destaque_user_id: A, destaque_titulo: 'Paredão' }, DONO);
  await esperar();
  assert.equal(notificacoes.length, 1, 'prêmio sem resultado: é novidade');
  await pedir('PATCH', `/api/feed/games/${JOGO}/resultado`, { destaque_user_id: null }, DONO);
  await pedir('PATCH', `/api/games/${JOGO}/resultado`, { nivel: 0 }, DONO);
  await pedir('PATCH', `/api/games/${JOGO}/resultado`, { campeao_time_index: 0 }, DONO);
  await esperar();
  assert.equal(notificacoes.length, 2, 'depois de limpar tudo, um resultado novo volta a ser novidade');
});

test('a lista de jogos do time traz o time_vencedor (a tela distingue empate de sem resultado)', async (t) => {
  const { carregados } = cenario({ campeao_time_index: null, time_vencedor: 'empate', resultado_nivel: 1 });
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('GET', '/api/teams/varzea-fc/games', null, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.games[0].time_vencedor, 'empate');
});
