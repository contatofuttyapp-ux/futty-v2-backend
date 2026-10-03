// Futty v2.0 — Rodada 29I (achado 83): a hora do jogo é a hora do campo, não a do aparelho nem a do servidor.
//
// O jogo gravado como 2026-10-08T23:00:00Z é quinta, 20h, em São Paulo. O app mostrava "sexta, 09/10, 00:00" para quem estava em
// Lisboa. Aqui trava-se a parte do MOTOR — sem banco e sem rede (Supabase falso em memória):
//   1. utils/fuso.js: validação, padrão, derivação do fuso a partir da cidade, e o relógio do campo (ler e escrever hora no fuso,
//      sem depender do TZ do processo);
//   2. o fuso do time sai em toda resposta que devolve jogo, presença, sorteio, Resenha e convite;
//   3. a criação do time e a troca de cidade gravam o fuso derivado; sem derivar, fica o padrão;
//   4. sem a migração 076 (coluna inexistente) nada quebra: o motor repete sem a coluna e vale o padrão;
//   5. a edição de data/hora e os jogos recorrentes escrevem no relógio do campo, não no do servidor.
//
// Uso: npm test  (ou: TZ=Europe/Lisbon node --test tests/fuso-do-time.test.js — o resultado é o mesmo em qualquer TZ)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  FUSO_PADRAO, fusoValido, normalizarFuso, fusoDoTime, fusoDaCoordenada, partesNoFuso, instanteNoFuso,
  dataCurtaNoFuso, dataNoFuso, horaNoFuso, lerComFuso, esquecerFaltaDaColuna,
} = require('../utils/fuso');
const { carregar, subir, injetar } = require('./_rotas');

// ─── utils/fuso.js ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('o padrão é America/Sao_Paulo e fuso inválido ou ausente vira o padrão', () => {
  assert.equal(FUSO_PADRAO, 'America/Sao_Paulo');
  assert.equal(fusoValido('Europe/Lisbon'), true);
  assert.equal(fusoValido('Marte/Olympus'), false);
  assert.equal(fusoValido(''), false);
  assert.equal(fusoValido(null), false);
  assert.equal(normalizarFuso('Europe/Lisbon'), 'Europe/Lisbon');
  assert.equal(normalizarFuso('Marte/Olympus'), FUSO_PADRAO);
  assert.equal(normalizarFuso(undefined), FUSO_PADRAO);
  assert.equal(fusoDoTime({ fuso: 'America/Manaus' }), 'America/Manaus');
  assert.equal(fusoDoTime({}), FUSO_PADRAO);
  assert.equal(fusoDoTime(null), FUSO_PADRAO);
});

test('o fuso nasce da coordenada da cidade: Brasil, Portugal (continente e ilhas); sem ponto, null', () => {
  assert.equal(fusoDaCoordenada(-23.55, -46.63), 'America/Sao_Paulo'); // São Paulo
  assert.equal(fusoDaCoordenada(-3.12, -60.02), 'America/Manaus'); // Manaus
  assert.equal(fusoDaCoordenada(-9.97, -67.81), 'America/Rio_Branco'); // Rio Branco (Acre)
  assert.equal(fusoDaCoordenada(38.72, -9.14), 'Europe/Lisbon'); // Lisboa
  assert.equal(fusoDaCoordenada(32.65, -16.91), 'Atlantic/Madeira'); // Funchal
  assert.equal(fusoDaCoordenada(37.74, -25.67), 'Atlantic/Azores'); // Ponta Delgada
  assert.equal(fusoDaCoordenada(null, null), null);
  assert.equal(fusoDaCoordenada('x', 10), null);
  assert.equal(fusoDaCoordenada(120, 10), null);
});

test('o jogo de 2026-10-08T23:00Z é quinta, 20:00 no campo de São Paulo — e sexta, 00:00 em Lisboa (o bug)', () => {
  const iso = '2026-10-08T23:00:00Z';
  const sp = partesNoFuso(iso, 'America/Sao_Paulo');
  assert.deepEqual([sp.ano, sp.mes, sp.dia, sp.hora, sp.minuto, sp.diaDaSemana], [2026, 10, 8, 20, 0, 4]); // 4 = quinta
  const lisboa = partesNoFuso(iso, 'Europe/Lisbon');
  assert.deepEqual([lisboa.dia, lisboa.hora, lisboa.diaDaSemana], [9, 0, 5]); // sexta 00h: o que o app mostrava
  assert.equal(dataCurtaNoFuso(iso, 'America/Sao_Paulo'), '08/10 · 20:00');
  assert.equal(dataNoFuso(iso, 'America/Sao_Paulo'), '08/10/2026');
  assert.equal(horaNoFuso(iso, 'America/Sao_Paulo'), '20:00');
  assert.equal(horaNoFuso('lixo', 'America/Sao_Paulo'), null);
});

test('instanteNoFuso: "quinta 20:00 no campo" vira o instante certo, e é o inverso de partesNoFuso', () => {
  assert.equal(instanteNoFuso('2026-10-08', '20:00', 'America/Sao_Paulo').toISOString(), '2026-10-08T23:00:00.000Z');
  assert.equal(instanteNoFuso('2026-10-08', '20:00', 'Europe/Lisbon').toISOString(), '2026-10-08T19:00:00.000Z'); // Lisboa em horário de verão: UTC+1
  assert.equal(instanteNoFuso('2026-01-08', '20:00', 'Europe/Lisbon').toISOString(), '2026-01-08T20:00:00.000Z'); // no inverno: UTC+0
  assert.equal(instanteNoFuso('2026-10-08', '09:05', 'America/Manaus').toISOString(), '2026-10-08T13:05:00.000Z');
  for (const fuso of ['America/Sao_Paulo', 'Europe/Lisbon', 'America/Manaus', 'Atlantic/Azores']) {
    const volta = partesNoFuso(instanteNoFuso('2026-03-28', '01:30', fuso), fuso);
    assert.deepEqual([volta.dia, volta.hora, volta.minuto], [28, 1, 30], fuso);
  }
  assert.equal(instanteNoFuso('2026-02-31', '20:00', 'America/Sao_Paulo'), null); // 31 de fevereiro não existe
  assert.equal(instanteNoFuso('2026-10-08', '25:00', 'America/Sao_Paulo'), null);
  assert.equal(instanteNoFuso('lixo', '20:00', 'America/Sao_Paulo'), null);
});

// Um banco falso que só tem as colunas de `existem`: a leitura que pede outra recebe o erro do PostgREST com o nome dela.
const bancoCom = (existem, chamadas) => async (novas) => {
  chamadas.push(novas);
  const falta = (novas ? novas.split(', ') : []).find((c) => !existem.includes(c));
  return falta ? { data: null, error: { message: `column teams.${falta} does not exist` } } : { data: { colunas: novas }, error: null };
};

test('lerComFuso: pede as colunas novas; se alguma não existe repete sem ela e lembra por um minuto', async () => {
  esquecerFaltaDaColuna();
  const chamadas = [];
  const semNenhuma = bancoCom([], chamadas);
  assert.deepEqual((await lerComFuso(semNenhuma)).data, { colunas: '' });
  assert.equal(chamadas.at(-1), '', 'acabou lendo sem nenhuma coluna nova');
  const n = chamadas.length;
  await lerComFuso(semNenhuma);
  assert.deepEqual(chamadas.slice(n), [''], 'lembrou: nem tentou com as colunas de novo');
  esquecerFaltaDaColuna();
  const comColuna = async (novas) => ({ data: { id: 2, fuso: /fuso/.test(novas) ? 'Europe/Lisbon' : undefined }, error: null });
  assert.equal((await lerComFuso(comColuna)).data.fuso, 'Europe/Lisbon');
  // um erro que não é da coluna não é engolido
  const outroErro = async () => ({ data: null, error: { message: 'connection refused' } });
  assert.equal((await lerComFuso(outroErro)).error.message, 'connection refused');
  esquecerFaltaDaColuna();
});

test('lerComFuso (29I, bloco 3): só a coluna que falta sai — com a 076 aplicada e a 077/079 não, o fuso continua valendo', async () => {
  esquecerFaltaDaColuna();
  const chamadas = [];
  const so076 = bancoCom(['fuso'], chamadas);
  assert.deepEqual((await lerComFuso(so076)).data, { colunas: 'fuso' });
  assert.deepEqual(chamadas, [
    'fuso, escudo_cor2, escudo_padrao, jogadores_por_time',
    'fuso, escudo_padrao, jogadores_por_time',
    'fuso, jogadores_por_time',
    'fuso',
  ]);
  const n = chamadas.length;
  await lerComFuso(so076);
  assert.deepEqual(chamadas.slice(n), ['fuso'], 'lembrou das três que faltam: uma ida só');
  esquecerFaltaDaColuna();
  const tudo = bancoCom(['fuso', 'escudo_cor2', 'escudo_padrao', 'jogadores_por_time'], []);
  assert.deepEqual((await lerComFuso(tudo)).data, { colunas: 'fuso, escudo_cor2, escudo_padrao, jogadores_por_time' });
  esquecerFaltaDaColuna();
});

/** carregar() com o que o /api/inicio lê de fora do banco (anúncios, denúncias) trocado por um falso — como em inicio-conta-pesada. */
function carregarComInicio(tabelas, modulos) {
  const restaurar = [
    injetar('utils/gabineteStore', { ler: async () => ({ ads_ativo: false }) }),
    injetar('utils/denunciaStore', { aoGravar: () => {}, listarEquipa: async () => [] }),
  ];
  const r = carregar(tabelas, modulos);
  for (const f of restaurar.reverse()) f();
  return r;
}

// ─── As rotas ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const ADMIN = '11111111-1111-1111-1111-111111111111';
const MEMBRO = '22222222-2222-2222-2222-222222222222';
const TIME = { id: 'time-1', nome: 'Missa de Quinta', slug: 'missa', cor: 'verde', criado_por: ADMIN, created_at: '2026-01-01T00:00:00Z', fuso: 'America/Sao_Paulo' };
const JOGO_ISO = '2026-10-08T23:00:00Z';
const daquiADias = (n) => new Date(Date.now() + n * 864e5).toISOString();

function cenario(extra = {}) {
  return {
    users: [{ id: ADMIN, nome: 'Chavo' }, { id: MEMBRO, nome: 'Tonhão' }],
    teams: [TIME],
    team_members: [
      { team_id: TIME.id, user_id: ADMIN, role: 'admin', created_at: '2026-01-01T00:00:00Z', teams: TIME },
      { team_id: TIME.id, user_id: MEMBRO, role: 'member', created_at: '2026-01-02T00:00:00Z', teams: TIME },
    ],
    games: [{
      id: 'jogo-1', team_id: TIME.id, teams: TIME, data: JOGO_ISO, local: 'Quadra', status: 'agendado', cancelado: false,
      sorteio_realizado: false, rsvp_aberto: true, rsvp_prazo: daquiADias(1), jogadores_por_time: 5, game_players: [],
    }],
    rsvp_respostas: [], rsvp_espera: [], votes: [], team_join_requests: [], game_players: [],
    ...extra,
  };
}

test('GET /api/games/:id e /api/teams/:slug/games: o fuso do time vai no objeto do time', async (t) => {
  const { carregados } = carregar(cenario(), ['routes/games']);
  const pedir = subir([carregados['routes/games']], t);
  const jogo = await pedir('GET', '/api/games/jogo-1', null, ADMIN);
  assert.equal(jogo.status, 200, JSON.stringify(jogo.json));
  assert.equal(jogo.json.team.fuso, 'America/Sao_Paulo');
  const lista = await pedir('GET', '/api/teams/missa/games', null, ADMIN);
  assert.equal(lista.json.team.fuso, 'America/Sao_Paulo');
});

test('time de Lisboa: o fuso dele sai no jogo, na lista e na vista pública do sorteio', async (t) => {
  const lisboa = { ...TIME, id: 'time-pt', slug: 'pelada-lisboa', fuso: 'Europe/Lisbon' };
  const tabelas = cenario({
    teams: [lisboa],
    team_members: [{ team_id: lisboa.id, user_id: ADMIN, role: 'admin', created_at: '2026-01-01T00:00:00Z', teams: lisboa }],
    games: [{ id: 'jogo-pt', team_id: lisboa.id, teams: lisboa, data: JOGO_ISO, local: 'Relvado', status: 'agendado', game_players: [] }],
  });
  const { carregados } = carregar(tabelas, ['routes/games']);
  const pedir = subir([carregados['routes/games']], t);
  assert.equal((await pedir('GET', '/api/games/jogo-pt', null, ADMIN)).json.team.fuso, 'Europe/Lisbon');
  assert.equal((await pedir('GET', '/api/p/jogo-pt')).json.equipa.fuso, 'Europe/Lisbon');
});

test('sem a coluna fuso (migração 076 por aplicar) o time vale o padrão America/Sao_Paulo', async (t) => {
  const { fuso: _fuso, ...semFuso } = TIME; // eslint-disable-line no-unused-vars
  const { carregados } = carregarComInicio(cenario({
    teams: [semFuso],
    team_members: [{ team_id: TIME.id, user_id: ADMIN, role: 'admin', created_at: '2026-01-01T00:00:00Z', teams: semFuso }],
    games: [{ id: 'jogo-1', team_id: TIME.id, teams: semFuso, data: JOGO_ISO, local: 'Quadra', status: 'agendado', game_players: [] }],
  }), ['routes/games', 'routes/rsvp', 'routes/inicio']);
  const pedir = subir([carregados['routes/games'], carregados['routes/rsvp'], carregados['routes/inicio']], t);
  assert.equal((await pedir('GET', '/api/games/jogo-1', null, ADMIN)).json.team.fuso, 'America/Sao_Paulo');
  assert.equal((await pedir('GET', '/api/jogos/jogo-1/rsvp', null, ADMIN)).json.fuso, 'America/Sao_Paulo');
  const inicio = (await pedir('GET', '/api/inicio', null, ADMIN)).json;
  assert.equal(inicio.teams.teams[0].fuso, 'America/Sao_Paulo');
  assert.equal(inicio.convites.games[0].fuso, 'America/Sao_Paulo');
});

test('presença (RSVP) e Início: o fuso do time vai no RSVP, no time e em cada jogo', async (t) => {
  const lisboa = { ...TIME, fuso: 'Europe/Lisbon' };
  const { carregados } = carregarComInicio(cenario({
    teams: [lisboa],
    team_members: [{ team_id: TIME.id, user_id: ADMIN, role: 'admin', created_at: '2026-01-01T00:00:00Z', teams: lisboa }],
    games: [{ id: 'jogo-1', team_id: TIME.id, teams: lisboa, data: daquiADias(3), local: 'Quadra', status: 'agendado', rsvp_aberto: true, rsvp_prazo: daquiADias(1), game_players: [] }],
  }), ['routes/rsvp', 'routes/inicio']);
  const pedir = subir([carregados['routes/rsvp'], carregados['routes/inicio']], t);
  assert.equal((await pedir('GET', '/api/jogos/jogo-1/rsvp', null, ADMIN)).json.fuso, 'Europe/Lisbon');
  const inicio = (await pedir('GET', '/api/inicio', null, ADMIN)).json;
  assert.equal(inicio.teams.teams[0].fuso, 'Europe/Lisbon');
  assert.equal(inicio.convites.games[0].fuso, 'Europe/Lisbon');
  assert.equal(inicio.rsvp.fuso, 'Europe/Lisbon');
});

test('Resenha: o jogo e o post trazem o fuso do time, e a hora (time) é a do campo, não UTC', async (t) => {
  const { carregados } = carregar(cenario({
    games: [{
      id: 'jogo-1', team_id: TIME.id, data: JOGO_ISO, local: 'Quadra', status: 'terminado', created_at: JOGO_ISO,
      campeao_time_index: 0, times_resultado: { times: [] },
    }],
    feed_posts: [], feed_post_media: [], reacoes: [], comentarios: [], blocks: [], user_blocks: [],
  }), ['routes/feed']);
  const pedir = subir([carregados['routes/feed']], t);
  const r = await pedir('GET', '/api/feed', null, ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const jogo = r.json.items.find((i) => i.kind === 'jogo');
  assert.equal(jogo.fuso, 'America/Sao_Paulo');
  assert.equal(jogo.time, '20:00'); // era "23:00" (UTC)
});

test('criar time: o fuso nasce da cidade (Lisboa → Europe/Lisbon; São Paulo → o padrão); sem cidade, o padrão', async (t) => {
  const { carregados, tabelas } = carregar({ users: [{ id: ADMIN }], teams: [], team_members: [] }, ['routes/teams']);
  const pedir = subir([carregados['routes/teams']], t);
  const lisboa = await pedir('POST', '/api/teams', { nome: 'Pelada de Lisboa', cidade: 'Lisboa', uf: '', pais: 'PT', lat: 38.72, lng: -9.14, origem: 'lista' }, ADMIN);
  assert.equal(lisboa.status, 201, JSON.stringify(lisboa.json));
  assert.equal(lisboa.json.team.fuso, 'Europe/Lisbon');
  assert.equal(tabelas.teams.find((x) => x.id === lisboa.json.team.id).fuso, 'Europe/Lisbon');
  const sp = await pedir('POST', '/api/teams', { nome: 'Pelada de SP', cidade: 'São Paulo', uf: 'SP', pais: 'BR', lat: -23.55, lng: -46.63, origem: 'lista' }, ADMIN);
  assert.equal(sp.json.team.fuso, 'America/Sao_Paulo');
  const manaus = await pedir('POST', '/api/teams', { nome: 'Pelada de Manaus', cidade: 'Manaus', uf: 'AM', pais: 'BR', lat: -3.12, lng: -60.02, origem: 'lista' }, ADMIN);
  assert.equal(manaus.json.team.fuso, 'America/Manaus');
  const semCidade = await pedir('POST', '/api/teams', { nome: 'Pelada Sem Cidade' }, ADMIN);
  assert.equal(semCidade.json.team.fuso, 'America/Sao_Paulo');
});

test('trocar a cidade do time troca o fuso (e voltar ao padrão também se grava)', async (t) => {
  const { carregados, tabelas } = carregar(cenario(), ['routes/teams']);
  const pedir = subir([carregados['routes/teams']], t);
  const r = await pedir('PATCH', '/api/teams/missa', { cidade: 'Lisboa', pais: 'PT', uf: '', lat: 38.72, lng: -9.14, origem: 'lista' }, ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.team.fuso, 'Europe/Lisbon');
  assert.equal(tabelas.teams[0].fuso, 'Europe/Lisbon');
  const volta = await pedir('PATCH', '/api/teams/missa', { cidade: 'São Paulo', pais: 'BR', uf: 'SP', lat: -23.55, lng: -46.63, origem: 'lista' }, ADMIN);
  assert.equal(volta.json.team.fuso, 'America/Sao_Paulo');
  assert.equal(tabelas.teams[0].fuso, 'America/Sao_Paulo');
});

test('sem a migração 076 a edição do time vale igual (a coluna fuso é repetida sem)', async (t) => {
  const falhar = (tabela, op, e) => (tabela === 'teams' && op === 'update' && e.patch && 'fuso' in e.patch
    ? { message: "Could not find the 'fuso' column of 'teams' in the schema cache" } : null);
  const { carregados, tabelas } = carregar(cenario(), ['routes/teams'], { falhar });
  const pedir = subir([carregados['routes/teams']], t);
  const r = await pedir('PATCH', '/api/teams/missa', { cidade: 'Lisboa', pais: 'PT', uf: '', lat: 38.72, lng: -9.14, origem: 'lista' }, ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(tabelas.teams[0].cidade, 'Lisboa, Portugal');
  assert.equal(r.json.team.fuso, 'America/Sao_Paulo');
});

test('editar data/hora do jogo: "quinta 20:00" é o relógio do CAMPO, qualquer que seja o TZ do servidor', async (t) => {
  const { carregados, tabelas } = carregar(cenario({
    games: [{ id: 'jogo-1', team_id: TIME.id, teams: TIME, data: '2026-10-01T23:00:00Z', local: 'Quadra', status: 'agendado', sorteio_realizado: false, game_players: [] }],
  }), ['routes/games']);
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('PATCH', '/api/games/jogo-1', { date: '2026-10-08', time: '20:00' }, ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(tabelas.games[0].data, '2026-10-08T23:00:00.000Z');
  assert.equal(r.json.game.fuso, 'America/Sao_Paulo');
  // só a hora: a data de antes (no relógio do campo) fica
  const soHora = await pedir('PATCH', '/api/games/jogo-1', { time: '21:30' }, ADMIN);
  assert.equal(soHora.status, 200);
  assert.equal(tabelas.games[0].data, '2026-10-09T00:30:00.000Z'); // 08/10 21:30 em São Paulo
});

test('jogos recorrentes: o dia da semana e a hora são os do campo (quinta 20:00 de São Paulo = 23:00Z)', async (t) => {
  const { carregados, tabelas } = carregar(cenario({ games: [] }), ['routes/games']);
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('POST', '/api/teams/missa/jogos/recorrentes', { dia_semana: 4, hora: '20:00', semanas: 4 }, ADMIN);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.criados, 4);
  assert.equal(r.json.fuso, 'America/Sao_Paulo');
  for (const g of tabelas.games) {
    const p = partesNoFuso(g.data, 'America/Sao_Paulo');
    assert.equal(p.diaDaSemana, 4, g.data); // quinta no campo
    assert.deepEqual([p.hora, p.minuto], [20, 0], g.data);
  }
  assert.ok(tabelas.games.every((g) => new Date(g.data).getTime() > Date.now()));
});

test('notificações: a data do jogo no corpo é a do campo (e não "23:00" do servidor em UTC)', async (t) => {
  const { carregados, notificacoes } = carregar(cenario(), ['routes/games']);
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('POST', '/api/games', { team_slug: 'missa', data: JOGO_ISO, jogadores_por_time: 5 }, ADMIN);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.game.fuso, 'America/Sao_Paulo');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(notificacoes.at(-1).payload.body, /08\/10 · 20:00/);
});
