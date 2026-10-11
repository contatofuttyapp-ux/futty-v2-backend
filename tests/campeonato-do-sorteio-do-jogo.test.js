// Futty v2.0 — RODADA 30L: o campeonato nasce do sorteio do jogo (sai o "sortear direto").
//
// O "sortear direto" (POST /campeonatos com modo 'sorteio') pegava TODOS os membros do time, inclusive quem não vai, e sorteava sem as
// notas — times tortos. O sorteio do jogo já faz isso direito (só quem confirmou, equilibrado), então o motor recusa o modo e ficam dois
// caminhos: pelo sorteio de um jogo (POST /campeonatos/de-sorteio, com os 3 formatos) e o manual (nomes + montar à mão).
// A escolha "Pelo sorteio de um jogo" lista os jogos sorteados que ainda não viraram campeonato.
//
// Uso: npm test  (ou: node --test tests/campeonato-do-sorteio-do-jogo.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');
const store = require('../utils/campeonatoStore');

const TIME = '11111111-1111-1111-1111-111111111111';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const JOGADORES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x, i) => `${x}0000000-0000-0000-0000-00000000000${i}`);
const NOMES_J = ['Rafael', 'Bruno', 'Carlos', 'Diego', 'Eduardo', 'Felipe', 'Gustavo', 'Henrique'];
const DIA = 86400000;
const usuario = (id, nome) => ({ id, nome: `${nome} da Silva`, nome_jogador: nome, email: `${nome}@futtymock.com` });
const membro = (id, nome, role = 'member') => ({ team_id: TIME, user_id: id, role, users: usuario(id, nome) });
const ha = (dias) => new Date(Date.now() + dias * DIA).toISOString();

/** Um sorteio de `n` times com 1 jogador cada, a partir do `primeiro` jogador (para um segundo sorteio ter outra gente). */
const sorteio = (n, primeiro = 0) => ({
  seed: 1, num_times: n, reservas: [],
  times: Array.from({ length: n }, (_, i) => ({ nome: `Time ${i + 1}`, jogadores: [{ user_id: JOGADORES[(primeiro + i) % JOGADORES.length], nome: NOMES_J[(primeiro + i) % NOMES_J.length], avatar_url: null, rating: 3 }] })),
});
const jogo = (id, dias, extra = {}) => ({ id, team_id: TIME, data: ha(dias), local: `Quadra ${id}`, status: 'agendado', cancelado: false, sorteio_realizado: true, times_resultado: sorteio(4), ...extra });

// Um Storage em memória, no lugar do bucket "campeonatos".
function storageFalso() {
  const arquivos = new Map();
  return {
    from: () => ({
      upload: async (caminho, corpo) => { arquivos.set(caminho, Buffer.from(corpo).toString('utf8')); return { error: null }; },
      download: async (caminho) => (arquivos.has(caminho) ? { data: { text: async () => arquivos.get(caminho) }, error: null } : { data: null, error: { message: 'not found' } }),
      list: async (prefixo) => ({ data: [...arquivos.keys()].filter((k) => k.startsWith(`${prefixo}/`)).map((k) => ({ name: k.slice(prefixo.length + 1) })) }),
      remove: async (caminhos) => { caminhos.forEach((c) => arquivos.delete(c)); return { error: null }; },
    }),
  };
}

function cenario(jogos) {
  const t = carregar({
    teams: [{ id: TIME, nome: 'Domingueira FC', slug: 'domingueira-fc' }],
    users: [usuario(DONO, 'Pedro'), ...JOGADORES.map((id, i) => usuario(id, NOMES_J[i]))],
    team_members: [membro(DONO, 'Pedro', 'admin'), ...JOGADORES.map((id, i) => membro(id, NOMES_J[i]))],
    games: jogos,
  }, ['routes/campeonatos']);
  t.cliente.storage = storageFalso();
  return t;
}

const base = '/api/equipas/domingueira-fc/campeonatos';
const ids = (r) => r.json.jogos.map((j) => j.id);

// ─── O "sortear direto" saiu ─────────────────────────────────────────────────────────────────────────────────────────────

test('modo "sorteio" é recusado com a frase que manda sortear pelo jogo — com ou sem nome, em qualquer formato', async (t) => {
  const { carregados } = cenario([jogo('g1', 3)]);
  const pedir = subir([carregados['routes/campeonatos']], t);
  for (const formato of ['pontos', 'mata', 'pontos_final']) {
    const r = await pedir('POST', base, { nome: 'Copa', formato, modo: 'sorteio', num_times: 4, nomes: ['A', 'B', 'C', 'D'] }, DONO);
    assert.equal(r.status, 400, formato);
    assert.equal(r.json.error, 'Para sortear, marque um jogo e sorteie por lá; no resultado do sorteio, toque em Criar campeonato.');
  }
  const semNome = await pedir('POST', base, { modo: 'sorteio', num_times: 4 }, DONO);
  assert.equal(semNome.status, 400);
  assert.match(semNome.json.error, /marque um jogo e sorteie/);
  // nada foi criado
  assert.deepEqual((await pedir('GET', base, null, DONO)).json.campeonatos, []);
});

test('o modo "sorteio" não vale nem para quem não é admin (continua sendo 403)', async (t) => {
  const { carregados } = cenario([jogo('g1', 3)]);
  const pedir = subir([carregados['routes/campeonatos']], t);
  const r = await pedir('POST', base, { nome: 'Copa', modo: 'sorteio', num_times: 4 }, JOGADORES[0]);
  assert.equal(r.status, 403);
});

test('o manual segue igual: nomes + montar à mão (e sem modo nenhum)', async (t) => {
  const { carregados } = cenario([jogo('g1', 3)]);
  const pedir = subir([carregados['routes/campeonatos']], t);
  const nomes = ['Ouro', 'Roxo', 'Prata', 'Bronze'];
  const plantel = [[{ user_id: JOGADORES[0], nome: 'Rafael' }], [{ user_id: null, nome: 'Zeca', convidado: true }], [], []];
  const r = await pedir('POST', base, { nome: 'Copa', formato: 'pontos', modo: 'manual', nomes, plantel }, DONO);
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.campeonato.times.map((x) => x.nome), nomes);
  assert.equal(r.json.campeonato.times[1].jogadores[0].convidado, true);
  assert.equal(r.json.campeonato.seed, null, 'sem sorteio, sem semente');
  assert.equal(r.json.campeonato.origem_game_id, undefined, 'o manual não tem jogo de origem');
  const sem = await pedir('POST', base, { nome: 'Copa 2', formato: 'mata', nomes }, DONO);
  assert.equal(sem.status, 201);
  assert.equal(sem.json.campeonato.formato, 'mata');
  assert.equal((await pedir('POST', base, { nome: 'Dois', formato: 'pontos_final', nomes: ['A', 'B'] }, DONO)).status, 400, 'o formato novo segue pedindo 3 times');
});

test('os campeonatos antigos, criados pelo "sortear direto", continuam abrindo (com a semente deles)', async (t) => {
  const { carregados, cliente } = cenario([jogo('g1', 3)]);
  const pedir = subir([carregados['routes/campeonatos']], t);
  const antigo = store.montar(TIME, DONO, { nome: 'Copa antiga', formato: 'pontos', nomes: ['A', 'B', 'C'] });
  antigo.seed = 123456;
  await cliente.storage.from('campeonatos').upload(`t/${TIME}/${antigo.id}.json`, Buffer.from(JSON.stringify(antigo)));
  const r = await pedir('GET', `${base}/${antigo.id}`, null, DONO);
  assert.equal(r.status, 200);
  assert.equal(r.json.campeonato.seed, 123456);
  assert.equal(r.json.campeonato.classificacao.length, 3);
});

// ─── Pelo sorteio do jogo: os 3 formatos ──────────────────────────────────────────────────────────────────────────────────

test('de-sorteio com os 3 formatos (sorteio de 4 times): pontos, todos contra todos + final e mata-mata', async (t) => {
  const { carregados } = cenario([jogo('g1', 3)]);
  const pedir = subir([carregados['routes/campeonatos']], t);
  const esperado = { pontos: 6, pontos_final: 7, mata: 3 }; // jogos (pontos_final: 6 de grupo + a vaga da final)
  for (const [formato, n] of Object.entries(esperado)) {
    const r = await pedir('POST', `${base}/de-sorteio`, { game_id: 'g1', formato }, DONO);
    assert.equal(r.status, 201, formato);
    assert.equal(r.json.campeonato.formato, formato);
    assert.equal(r.json.campeonato.confrontos.filter((c) => !c.bye).length, n, formato);
    assert.equal(r.json.campeonato.times.length, 4);
    assert.equal(r.json.campeonato.origem_game_id, 'g1', 'guarda de qual jogo nasceu');
  }
});

test('de-sorteio com 2 times: pontos corridos e mata-mata valem; "todos contra todos + final" não (precisa de 3)', async (t) => {
  const { carregados } = cenario([jogo('g2', 3, { times_resultado: sorteio(2) })]);
  const pedir = subir([carregados['routes/campeonatos']], t);
  assert.equal((await pedir('POST', `${base}/de-sorteio`, { game_id: 'g2', formato: 'pontos' }, DONO)).status, 201);
  assert.equal((await pedir('POST', `${base}/de-sorteio`, { game_id: 'g2', formato: 'mata' }, DONO)).status, 201);
  const r = await pedir('POST', `${base}/de-sorteio`, { game_id: 'g2', formato: 'pontos_final' }, DONO);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /mínimo 3/);
});

// ─── A lista de jogos elegíveis ───────────────────────────────────────────────────────────────────────────────────────────

test('elegíveis (puro): sorteado, 2+ times, não cancelado, recente e ainda sem campeonato; o mais recente primeiro', () => {
  const agora = Date.now();
  const jogos = [
    jogo('ok-ontem', -1),
    jogo('ok-amanha', 1),
    jogo('ok-montado-a-mao', -3, { times_resultado: { ...sorteio(3), montado_a_mao: true } }),
    jogo('cancelado-por-flag', 2, { cancelado: true }),
    jogo('cancelado-por-status', 2, { status: 'cancelado' }),
    jogo('sem-sorteio', 2, { sorteio_realizado: false, times_resultado: null }),
    jogo('so-um-time', 2, { times_resultado: sorteio(1) }),
    jogo('antigo', -30),
    jogo('quase-antigo', -13),
  ];
  const lista = store.jogosElegiveisParaCampeonato(jogos, [], agora).map((g) => g.id);
  assert.deepEqual(lista, ['ok-amanha', 'ok-ontem', 'ok-montado-a-mao', 'quase-antigo']);
});

test('elegíveis (puro): o sorteio que já virou campeonato sai da lista — gravado com a origem ou reconhecido pelo elenco', () => {
  const g = jogo('g1', 1);
  const outro = jogo('g2', 2, { times_resultado: sorteio(4, 4) });
  const nomes = ['Time Ouro', 'Time Roxo', 'Time Prata', 'Time Bronze'];
  const plantel = (j) => j.times_resultado.times.map((x) => x.jogadores.map((p) => ({ user_id: p.user_id, nome: p.nome })));
  // com a origem gravada
  const comOrigem = store.montar(TIME, DONO, { nome: 'X', formato: 'pontos', nomes, plantel: plantel(g), origem: { game_id: g.id, assinatura: store.assinaturaDosTimes(g.times_resultado.times) } });
  assert.deepEqual(store.jogosElegiveisParaCampeonato([g, outro], [comOrigem]).map((x) => x.id), ['g2']);
  // criado antes de a origem existir: o elenco copiado do sorteio entrega
  const semOrigem = store.montar(TIME, DONO, { nome: 'Y', formato: 'pontos', nomes, plantel: plantel(g) });
  assert.deepEqual(store.jogosElegiveisParaCampeonato([g, outro], [semOrigem]).map((x) => x.id), ['g2']);
  // um campeonato à mão com outra gente não esconde nada
  const aMao = store.montar(TIME, DONO, { nome: 'Z', formato: 'pontos', nomes, plantel: [] });
  assert.deepEqual(store.jogosElegiveisParaCampeonato([g, outro], [aMao]).map((x) => x.id), ['g2', 'g1']);
});

test('elegíveis (puro): sortear de novo o mesmo jogo (outros times) volta a oferecê-lo', () => {
  const g = jogo('g1', 1);
  const nomes = ['A', 'B', 'C', 'D'];
  const camp = store.montar(TIME, DONO, { nome: 'X', formato: 'pontos', nomes, origem: { game_id: 'g1', assinatura: store.assinaturaDosTimes(g.times_resultado.times) } });
  assert.deepEqual(store.jogosElegiveisParaCampeonato([g], [camp]), []);
  const resorteado = { ...g, times_resultado: sorteio(4, 4) };
  assert.deepEqual(store.jogosElegiveisParaCampeonato([resorteado], [camp]).map((x) => x.id), ['g1']);
});

test('a assinatura do sorteio não depende da ordem dentro do time, e a ordem dos times conta', () => {
  const a = { times: [{ jogadores: [{ user_id: 'u1' }, { user_id: 'u2' }] }, { jogadores: [{ nome: 'Zeca' }] }] };
  const b = { times: [{ jogadores: [{ user_id: 'u2' }, { user_id: 'u1' }] }, { jogadores: [{ nome: ' zeca ' }] }] };
  const c = { times: [a.times[1], a.times[0]] };
  assert.equal(store.assinaturaDosTimes(a.times), store.assinaturaDosTimes(b.times));
  assert.notEqual(store.assinaturaDosTimes(a.times), store.assinaturaDosTimes(c.times));
});

test('rota: GET /campeonatos/jogos-sorteados lista os elegíveis e só para o admin', async (t) => {
  const { carregados } = cenario([
    jogo('g-bom', 2),
    jogo('g-cancelado', 2, { cancelado: true }),
    jogo('g-sem-sorteio', 2, { sorteio_realizado: false, times_resultado: null }),
    jogo('g-antigo', -40),
    jogo('g-dois', -2, { times_resultado: sorteio(2) }),
  ]);
  const pedir = subir([carregados['routes/campeonatos']], t);
  assert.equal((await pedir('GET', `${base}/jogos-sorteados`, null, JOGADORES[0])).status, 403, 'jogador comum não cria campeonato');
  const r = await pedir('GET', `${base}/jogos-sorteados`, null, DONO);
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r), ['g-bom', 'g-dois']);
  assert.equal(r.json.jogos[0].n_times, 4);
  assert.equal(r.json.jogos[0].por_time, 1);
  assert.equal(r.json.jogos[0].local, 'Quadra g-bom');
  assert.equal(r.json.jogos[1].n_times, 2);
});

test('rota: depois de criar o campeonato pelo sorteio, o jogo sai da lista; refazer o sorteio o traz de volta', async (t) => {
  const { carregados, tabelas } = cenario([jogo('g1', 2), jogo('g2', 1)]);
  const pedir = subir([carregados['routes/campeonatos']], t);
  assert.deepEqual(ids(await pedir('GET', `${base}/jogos-sorteados`, null, DONO)), ['g1', 'g2']);
  assert.equal((await pedir('POST', `${base}/de-sorteio`, { game_id: 'g2', formato: 'pontos_final' }, DONO)).status, 201);
  assert.deepEqual(ids(await pedir('GET', `${base}/jogos-sorteados`, null, DONO)), ['g1'], 'g2 já virou campeonato');
  // o admin sorteia o g2 de novo: times novos, jogo elegível outra vez
  tabelas.games.find((g) => g.id === 'g2').times_resultado = sorteio(4, 4);
  assert.deepEqual(ids(await pedir('GET', `${base}/jogos-sorteados`, null, DONO)), ['g1', 'g2']);
});

test('rota: sem jogo sorteado a lista vem vazia (a tela explica e oferece "Novo jogo")', async (t) => {
  const { carregados } = cenario([jogo('g-sem', 2, { sorteio_realizado: false, times_resultado: null })]);
  const pedir = subir([carregados['routes/campeonatos']], t);
  const r = await pedir('GET', `${base}/jogos-sorteados`, null, DONO);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.jogos, []);
});

test('"jogos-sorteados" não é confundido com o id de um campeonato', async (t) => {
  const { carregados } = cenario([]);
  const pedir = subir([carregados['routes/campeonatos']], t);
  const r = await pedir('GET', `${base}/jogos-sorteados`, null, DONO);
  assert.equal(r.status, 200, 'a rota da lista vem antes da rota do detalhe');
  assert.equal((await pedir('GET', `${base}/nao-existe`, null, DONO)).status, 404);
});
