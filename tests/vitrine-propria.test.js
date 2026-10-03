// Futty v2.0 — Rodada 29I (achado 97): a pessoa sempre vê a PRÓPRIA vitrine.
//
// A varredura da Freaky (3-out): "Ver minha vitrine de jogador" abria a tela "Perfil só entre companheiros — Não compartilham
// nenhum time", como se a regra de dividir time valesse contra o dono do perfil. O ranking só leva quem tem 3 jogos, é visível,
// está ativo e joga (quem só organiza o time sai dele); GET /api/teams/:slug/jogador/:userId dava 404 para esse dono, e a tela
// escrevia a mesma frase para qualquer erro. O próprio id tem de passar SEMPRE, antes de qualquer verificação de time em comum.
// Sem banco e sem rede (Supabase falso em memória).
//
// Uso: npm test  (ou: node --test tests/vitrine-propria.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');

const TIME = { id: 'time-1', nome: 'Missa de Quinta', slug: 'missa', cor: 'verde', criado_por: 'dono', created_at: '2026-01-01T00:00:00Z' };
const DONO = 'd0000000-0000-0000-0000-000000000001'; // admin que SÓ ORGANIZA
const NOVO = 'a0000000-0000-0000-0000-00000000000a'; // entrou agora: 1 jogo
const VETERANO = 'b0000000-0000-0000-0000-00000000000b'; // 3 jogos: está no ranking
const FORA = 'c0000000-0000-0000-0000-00000000000c'; // não é do time
const OUTRO_NOVO = 'e0000000-0000-0000-0000-00000000000e'; // outro com poucos jogos

const usuario = (id, nome) => ({ id, nome, nome_jogador: nome, avatar_url: null, foto_url: null, email: `${nome}@futtymock.com` });
const membro = (id, nome, extra = {}) => ({ team_id: TIME.id, user_id: id, role: 'member', categoria: 'linha', users: usuario(id, nome), ...extra });
const passado = (dias) => new Date(Date.now() - dias * 864e5).toISOString();

function mundo(t) {
  const jogos = [1, 2, 3].map((i) => ({
    id: `jogo-${i}`, team_id: TIME.id, data: passado(7 * i), status: 'terminado', resultado_nivel: 1, time_vencedor: 'A',
    times_resultado: { times: [{ jogadores: [{ user_id: VETERANO }, { user_id: NOVO }] }, { jogadores: [] }] }, campeao_time_index: 0,
  }));
  const { carregados } = carregar({
    users: [usuario(DONO, 'Tonhão'), usuario(NOVO, 'Magrão'), usuario(VETERANO, 'Canhotinha'), usuario(FORA, 'Estranho'), usuario(OUTRO_NOVO, 'Fumaça')],
    teams: [TIME],
    team_members: [
      membro(DONO, 'Tonhão', { role: 'admin', joga: false }),
      membro(NOVO, 'Magrão'),
      membro(VETERANO, 'Canhotinha'),
      membro(OUTRO_NOVO, 'Fumaça'),
    ],
    games: jogos,
    game_players: [
      { game_id: 'jogo-1', user_id: VETERANO, confirmado: true }, { game_id: 'jogo-2', user_id: VETERANO, confirmado: true }, { game_id: 'jogo-3', user_id: VETERANO, confirmado: true },
      { game_id: 'jogo-1', user_id: NOVO, confirmado: true }, // só 1 jogo: fica fora do ranking (mínimo de 3)
      { game_id: 'jogo-2', user_id: OUTRO_NOVO, confirmado: true },
    ],
    votes: [], gols_jogadores: [], champion_photos: [], feed_posts: [], feed_post_media: [], comentarios: [],
  }, ['routes/ranking']);
  return subir([carregados['routes/ranking']], t);
}

test('quem só organiza o time (fora do ranking) vê a PRÓPRIA vitrine — antes: 404 e "Perfil só entre companheiros"', async (t) => {
  const pedir = mundo(t);
  const r = await pedir('GET', `/api/teams/missa/jogador/${DONO}`, null, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.jogador.user_id, DONO);
  assert.equal(r.json.jogador.nome_jogador, 'Tonhão');
  assert.equal(r.json.jogador.sou_eu, true);
  assert.equal(r.json.jogador.posicao, null, 'fora do ranking: sem posição');
  assert.equal(r.json.jogador.score, null, 'fora do ranking: sem pontos');
  assert.equal(r.json.jogador.presenca, 0);
  assert.equal(r.json.team.role, 'admin');
});

test('quem tem menos de 3 jogos vê a própria vitrine, com os números dele', async (t) => {
  const pedir = mundo(t);
  const r = await pedir('GET', `/api/teams/missa/jogador/${NOVO}`, null, NOVO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.jogador.user_id, NOVO);
  assert.equal(r.json.jogador.presenca, 1);
  assert.equal(r.json.jogador.vitorias, 3, 'as vitórias saem da mesma fonte do ranking');
  assert.equal(r.json.jogador.posicao, null);
  assert.equal(r.json.conquistas.jogos_total, 1);
  assert.equal(r.json.historico.length, 1);
});

test('quem está no ranking continua como sempre (com posição e pontos)', async (t) => {
  const pedir = mundo(t);
  const r = await pedir('GET', `/api/teams/missa/jogador/${VETERANO}`, null, VETERANO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.jogador.presenca, 3);
  assert.equal(typeof r.json.jogador.score, 'number');
});

test('o próprio id passa mesmo para quem NÃO é membro do time da URL (antes de qualquer checagem de time em comum)', async (t) => {
  const pedir = mundo(t);
  const r = await pedir('GET', `/api/teams/missa/jogador/${FORA}`, null, FORA);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.jogador.user_id, FORA);
  assert.equal(r.json.jogador.nome_jogador, 'Estranho');
});

test('a regra de companheiros continua valendo para o perfil dos OUTROS: não-membro leva 403; membro fora do ranking, 404', async (t) => {
  const pedir = mundo(t);
  const deFora = await pedir('GET', `/api/teams/missa/jogador/${VETERANO}`, null, FORA);
  assert.equal(deFora.status, 403, 'quem não é do time não vê o perfil de ninguém');
  const foraDoRanking = await pedir('GET', `/api/teams/missa/jogador/${NOVO}`, null, VETERANO);
  assert.equal(foraDoRanking.status, 404, 'perfil de outra pessoa fora do ranking segue não encontrado');
});

test('quem ver a vitrine de outra pessoa não muda a lista nem as posições do ranking', async (t) => {
  const pedir = mundo(t);
  const antes = await pedir('GET', '/api/teams/missa/ranking', null, VETERANO);
  await pedir('GET', `/api/teams/missa/jogador/${NOVO}`, null, NOVO);
  const depois = await pedir('GET', '/api/teams/missa/ranking', null, VETERANO);
  assert.deepEqual(depois.json.ranking.map((r) => r.user_id), antes.json.ranking.map((r) => r.user_id));
  assert.equal(antes.json.ranking.some((r) => r.user_id === NOVO), false, 'o novato continua fora do ranking');
});
