// Futty v2.0 — Os convidados sem app guardados no JOGO, com as marcas do sorteio (goleiro, cabeça de chave).
//
// O caso de verdade (Missa de Quinta, 22-out): 5 contas + 10 convidados, 5 por time. O admin queria três convidados (Eric Lopes, Wesley e
// Matheus Zanardi) como cabeças de chave, e só dava para marcar quem tem conta. Depois de associar 4 convidados às contas deles a tela
// contava 19 (o convidado E a conta), e recarregar a página apagava a lista. Aqui: a lista vive no jogo, o sorteio respeita as marcas do
// convidado como respeita as do membro, quem já ocupa a vaga de um convidado não conta duas vezes e o "Sortear de novo" usa a mesma lista.
//
// Uso: npm test  (ou: node --test tests/convidados-do-jogo.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');
const {
  umConvidado, limparConvidados, nomeRepetido, convidadosDoSorteio, convidadosGuardados, semConvidado, comConvidado, semAColuna,
} = require('../utils/convidadosDoJogo');
const { executarSorteio } = require('../utils/sorteio');

const TIME = '11111111-1111-1111-1111-111111111111';
const JOGO = '99999999-9999-9999-9999-999999999999';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const MEMBRO = 'd0000000-0000-0000-0000-000000000002'; // membro comum, não confirmado
const CONTAS = ['a1', 'a2', 'a3', 'a4', 'a5'].map((s) => `a0000000-0000-0000-0000-0000000000${s}`);
// As contas dos 4 convidados que baixaram o app (o "só neste jogo" do Associar)
const LIGADAS = ['c1', 'c2', 'c3', 'c4'].map((s) => `c0000000-0000-0000-0000-0000000000${s}`);
const FUTURO = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

const CABECAS = ['Eric Lopes', 'Wesley', 'Matheus Zanardi'];
const OUTROS = ['Gabriel Costa', 'Motta', 'Miguel', 'Marcos', 'Thiago', 'Rafa', 'Dudu'];
const NOMES_CONVIDADOS = [...CABECAS, ...OUTROS]; // 10
const comMarcas = () => NOMES_CONVIDADOS.map((nome) => ({ nome, goleiro: false, cabeca_chave: CABECAS.includes(nome) }));

const usuario = (id, nome) => ({ id, nome: `${nome} da Silva`, nome_jogador: nome, avatar_url: null, email: `${nome}@futtymock.com` });
const membro = (id, nome, role = 'member') => ({ team_id: TIME, user_id: id, role, users: usuario(id, nome) });
const presenca = (id, nome) => ({ game_id: JOGO, user_id: id, confirmado: true, goleiro: false, cabeca_chave: false, users: usuario(id, nome) });
const NOMES_CONTAS = ['Pedrão', 'Fabinho', 'Leleco', 'Juninho', 'Careca'];
const NOMES_LIGADAS = ['Gabriel', 'Mottinha', 'Miguelito', 'Marquinhos'];

// Erro do PostgREST quando a coluna não existe (a 087 não rodou).
const SEM_COLUNA = { code: 'PGRST204', message: "Could not find the 'convidados' column of 'games' in the schema cache" };

// Um Storage em memória, no lugar do bucket "campeonatos" (o Associar procura os campeonatos nascidos do sorteio).
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

function cenario(jogo = {}, opcoes = {}) {
  const t = carregar({
    teams: [{ id: TIME, nome: 'Missa de Quinta', slug: 'missa-de-quinta' }],
    users: [usuario(DONO, 'Organizador'), usuario(MEMBRO, 'Comum'), ...CONTAS.map((id, i) => usuario(id, NOMES_CONTAS[i])), ...LIGADAS.map((id, i) => usuario(id, NOMES_LIGADAS[i]))],
    team_members: [
      membro(DONO, 'Organizador', 'admin'), membro(MEMBRO, 'Comum'),
      ...CONTAS.map((id, i) => membro(id, NOMES_CONTAS[i])), ...LIGADAS.map((id, i) => membro(id, NOMES_LIGADAS[i])),
    ],
    games: [{ id: JOGO, team_id: TIME, data: FUTURO, jogadores_por_time: 5, status: 'agendado', sorteio_realizado: false, times_resultado: null, ...jogo }],
    game_players: CONTAS.map((id, i) => presenca(id, NOMES_CONTAS[i])),
  // A presença que o Associar cria nasce sem o `users` embutido: a relação faz o falso buscá-lo na tabela, como o PostgREST.
  }, ['routes/games', 'routes/campeonatos', 'utils/campeonatoStore'], { relacoes: { game_players: { users: { tabela: 'users', local: 'user_id', remota: 'id' } } }, ...opcoes });
  t.cliente.storage = storageFalso();
  return t;
}

const linhaDoJogo = (tabelas) => tabelas.games.find((g) => g.id === JOGO);
const jogadoresDe = (tr) => [...tr.times.flatMap((t) => t.jogadores), ...(tr.reservas || [])];
const semColunaNoUpdate = { falhar: (tabela, op, e) => (tabela === 'games' && op === 'update' && e.patch && 'convidados' in e.patch ? SEM_COLUNA : null) };

// ─── a parte pura ───────────────────────────────────────────────────────────

test('umConvidado: o nome solto (app antigo) vira convidado sem marca; o objeto leva as marcas; sem nome não entra', () => {
  assert.deepEqual(umConvidado('  Beto '), { nome: 'Beto', goleiro: false, cabeca_chave: false });
  assert.deepEqual(umConvidado({ nome: 'Wesley', cabeca_chave: true }), { nome: 'Wesley', goleiro: false, cabeca_chave: true });
  assert.deepEqual(umConvidado({ nome: 'Zé', goleiro: 'sim', cabeca_chave: 1 }), { nome: 'Zé', goleiro: false, cabeca_chave: false }, 'marca só com true de verdade');
  assert.equal(umConvidado(''), null);
  assert.equal(umConvidado({ nome: '   ' }), null);
  assert.equal(umConvidado({ goleiro: true }), null);
  assert.equal(umConvidado(42), null);
  assert.equal(umConvidado('x'.repeat(60)).nome.length, 40, 'o mesmo teto de nome do sorteio');
});

test('limparConvidados: 28 no máximo, sem os vazios; nomeRepetido acha "Beto" e "beto " como o mesmo', () => {
  assert.equal(limparConvidados(Array.from({ length: 40 }, (_, i) => `C${i}`)).length, 28);
  assert.deepEqual(limparConvidados(['A', '', null, { nome: 'B' }]).map((c) => c.nome), ['A', 'B']);
  assert.deepEqual(limparConvidados('não é lista'), []);
  assert.equal(nomeRepetido(limparConvidados(['Beto', 'Caio', 'beto '])), 'beto');
  assert.equal(nomeRepetido(limparConvidados(['Beto', 'Caio'])), null);
});

test('convidadosGuardados: a lista gravada vale; sem lista (NULL) vêm os convidados do sorteio salvo, com as marcas de lá', () => {
  const tr = {
    times: [
      { jogadores: [{ user_id: 'u1', nome: 'Conta' }, { user_id: null, convidado: true, nome: 'Wesley', cabeca_chave: true, goleiro: false }] },
      { jogadores: [{ user_id: null, convidado: true, nome: 'Zeca', goleiro: true }] },
    ],
    reservas: [{ posicao: 1, user_id: null, convidado: true, nome: 'Reserva' }],
  };
  assert.deepEqual(convidadosDoSorteio(tr), [
    { nome: 'Wesley', goleiro: false, cabeca_chave: true }, { nome: 'Zeca', goleiro: true, cabeca_chave: false }, { nome: 'Reserva', goleiro: false, cabeca_chave: false },
  ]);
  assert.deepEqual(convidadosGuardados({ convidados: null, times_resultado: tr }).map((c) => c.nome), ['Wesley', 'Zeca', 'Reserva']);
  assert.deepEqual(convidadosGuardados({ times_resultado: tr }).map((c) => c.nome), ['Wesley', 'Zeca', 'Reserva'], 'motor antes da migração: a coluna nem vem');
  assert.deepEqual(convidadosGuardados({ convidados: [], times_resultado: tr }), [], 'lista vazia gravada = o admin tirou todos');
  assert.deepEqual(convidadosGuardados({ convidados: null, times_resultado: null }), []);
});

test('semConvidado / comConvidado: o Associar tira pelo nome (sem olhar maiúscula); o Desfazer devolve no fim, sem duplicar', () => {
  const lista = comMarcas();
  const sem = semConvidado(lista, 'eric lopes');
  assert.equal(sem.length, 9);
  assert.ok(!sem.some((c) => c.nome === 'Eric Lopes'));
  const com = comConvidado(sem, { user_id: null, convidado: true, nome: 'Eric Lopes', cabeca_chave: true, rating: 5 });
  assert.deepEqual(com.at(-1), { nome: 'Eric Lopes', goleiro: false, cabeca_chave: true }, 'volta com a marca e sem o resto do jogador');
  assert.equal(comConvidado(com, { nome: 'ERIC LOPES' }).length, 10, 'já está: fica como está');
});

test('semAColuna: reconhece o erro do PostgREST e o do Postgres para a coluna que falta; outro erro não', () => {
  assert.equal(semAColuna(SEM_COLUNA), true);
  assert.equal(semAColuna({ code: '42703', message: 'column "convidados" of relation "games" does not exist' }), true);
  assert.equal(semAColuna({ message: 'connection reset' }), false);
  assert.equal(semAColuna(null), false);
});

// ─── o sorteio respeita as marcas do convidado ───────────────────────────────

const contas = () => CONTAS.map((id, i) => ({ user_id: id, nome: NOMES_CONTAS[i], rating: 5 + i, goleiro: false, cabeca_chave: false }));

test('sorteio: 3 convidados cabeças de chave caem cada um num time, em 300 sorteios diferentes', () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const s = executarSorteio(contas(), 5, { seed, convidados: comMarcas() });
    assert.equal(s.numTimes, 3);
    const cabecasPorTime = s.times.map((t) => t.filter((j) => j.cabeca_chave).map((j) => j.nome));
    assert.deepEqual(cabecasPorTime.map((c) => c.length), [1, 1, 1], `seed ${seed}: ${JSON.stringify(cabecasPorTime)}`);
    assert.deepEqual(cabecasPorTime.flat().sort(), [...CABECAS].sort());
    assert.ok(s.times.flat().filter((j) => j.cabeca_chave).every((j) => j.convidado === true && j.user_id === null));
    assert.equal(s.reservas.length, 0);
  }
});

test('sorteio: goleiros convidados e membro se espalham, um por time; convidado goleiro E cabeça conta como goleiro', () => {
  const membros = contas();
  membros[0].goleiro = true;
  const convidados = comMarcas().map((c) => (c.nome === 'Motta' ? { ...c, goleiro: true } : c.nome === 'Wesley' ? { ...c, goleiro: true } : c));
  for (let seed = 1; seed <= 200; seed += 1) {
    const s = executarSorteio(membros, 5, { seed, convidados });
    assert.deepEqual(s.times.map((t) => t.filter((j) => j.goleiro).length), [1, 1, 1], `seed ${seed}`);
    // Wesley é goleiro e cabeça: entra como o goleiro do time dele; as outras duas cabeças vão para dois times diferentes
    const cabecasSoDeLinha = s.times.map((t) => t.filter((j) => j.cabeca_chave && !j.goleiro).length);
    assert.equal(cabecasSoDeLinha.filter((n) => n === 1).length, 2, `seed ${seed}`);
  }
});

test('sorteio: o nome solto (app antigo) continua entrando como jogador de linha, sem marca', () => {
  const s = executarSorteio(contas(), 5, { seed: 7, convidados: NOMES_CONVIDADOS });
  const convidados = s.times.flat().filter((j) => j.convidado);
  assert.equal(convidados.length, 10);
  assert.ok(convidados.every((j) => j.goleiro === false && j.cabeca_chave === false));
});

// ─── as rotas ─────────────────────────────────────────────────────────────────

test('PUT /convidados grava a lista com as marcas; o GET do jogo a devolve ao admin (e só ao admin)', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('PUT', `/api/games/${JOGO}/convidados`, { convidados: comMarcas() }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(linhaDoJogo(tabelas).convidados, comMarcas());

  // recarregar a página: a lista volta, com as cabeças marcadas
  const g = await pedir('GET', `/api/games/${JOGO}`, null, DONO);
  assert.equal(g.status, 200);
  assert.deepEqual(g.json.convidados, comMarcas());
  assert.equal(g.json.players.filter((p) => p.confirmado).length, 5);

  const doMembro = await pedir('GET', `/api/games/${JOGO}`, null, MEMBRO);
  assert.equal(doMembro.status, 200);
  assert.equal(doMembro.json.convidados, undefined, 'quem não organiza não recebe a lista');
});

test('PUT /convidados: só o admin; nome repetido e mais de 28 voltam com a frase, sem gravar', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  assert.equal((await pedir('PUT', `/api/games/${JOGO}/convidados`, { convidados: comMarcas() }, MEMBRO)).status, 403);
  assert.equal((await pedir('PUT', `/api/games/${JOGO}/convidados`, { convidados: comMarcas() }, CONTAS[0])).status, 403);

  const rep = await pedir('PUT', `/api/games/${JOGO}/convidados`, { convidados: [{ nome: 'Beto' }, { nome: 'beto' }] }, DONO);
  assert.equal(rep.status, 400);
  assert.match(rep.json.error, /"beto" já está na lista/);
  const muitos = await pedir('PUT', `/api/games/${JOGO}/convidados`, { convidados: Array.from({ length: 29 }, (_, i) => ({ nome: `C${i}` })) }, DONO);
  assert.equal(muitos.status, 400);
  assert.equal((await pedir('PUT', `/api/games/${JOGO}/convidados`, { convidados: 'Beto' }, DONO)).status, 400);
  assert.equal(linhaDoJogo(tabelas).convidados, undefined, 'nada gravado');
});

test('POST /sortear sem lista no pedido usa a guardada: 15 no sorteio, 3 times de 5, cada cabeça convidada num time', async (t) => {
  const { carregados, tabelas } = cenario({ convidados: comMarcas() });
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('POST', `/api/games/${JOGO}/sortear`, {}, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const tr = linhaDoJogo(tabelas).times_resultado;
  assert.equal(tr.num_times, 3);
  assert.equal(tr.total_jogadores, 15);
  assert.equal(tr.convidados_total, 10);
  assert.deepEqual(tr.times.map((x) => x.jogadores.length), [5, 5, 5]);
  assert.deepEqual(tr.times.map((x) => x.jogadores.filter((j) => j.cabeca_chave).map((j) => j.nome).length), [1, 1, 1]);
  assert.deepEqual(tr.times.flatMap((x) => x.jogadores.filter((j) => j.cabeca_chave).map((j) => j.nome)).sort(), [...CABECAS].sort());
  assert.deepEqual(linhaDoJogo(tabelas).convidados, comMarcas(), 'a lista continua guardada');
});

test('POST /sortear do app antigo (só os nomes) funciona como antes e a lista fica guardada no jogo', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('POST', `/api/games/${JOGO}/sortear`, { convidados: NOMES_CONVIDADOS }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(linhaDoJogo(tabelas).times_resultado.total_jogadores, 15);
  assert.deepEqual(linhaDoJogo(tabelas).convidados.map((c) => c.nome), NOMES_CONVIDADOS);
  // recarregar a página do app novo: a lista está lá
  const g = await pedir('GET', `/api/games/${JOGO}`, null, DONO);
  assert.equal(g.json.convidados.length, 10);
});

test('POST /sortear com a lista do app novo (objetos) usa o que veio, com as marcas, e grava', async (t) => {
  const { carregados, tabelas } = cenario({ convidados: [{ nome: 'Velho', goleiro: false, cabeca_chave: false }] });
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('POST', `/api/games/${JOGO}/sortear`, { jogadoresPorTime: 5, convidados: comMarcas() }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(linhaDoJogo(tabelas).convidados, comMarcas());
  assert.ok(!jogadoresDe(linhaDoJogo(tabelas).times_resultado).some((j) => j.nome === 'Velho'));
});

// O caso da Missa de Quinta, reproduzido: sorteio feito (5 contas + 10 convidados), e 4 convidados ligados às contas deles.
async function sortearEAssociar(t, jogo, opcoes) {
  const { carregados, tabelas } = cenario(jogo, opcoes);
  const pedir = subir([carregados['routes/games']], t);
  const s = await pedir('POST', `/api/games/${JOGO}/sortear`, { convidados: NOMES_CONVIDADOS }, DONO);
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const ligar = [['Gabriel Costa', LIGADAS[0]], ['Motta', LIGADAS[1]], ['Miguel', LIGADAS[2]], ['Marcos', LIGADAS[3]]];
  for (const [convidadoNome, userId] of ligar) {
    const a = await pedir('POST', `/api/games/${JOGO}/associar-jogador`, { convidado_nome: convidadoNome, user_id: userId }, DONO);
    assert.equal(a.status, 200, JSON.stringify(a.json));
  }
  return { pedir, tabelas };
}

function conferirContagem(json) {
  const confirmados = json.players.filter((p) => p.confirmado);
  assert.equal(confirmados.length, 9, '5 contas + as 4 associadas');
  assert.equal(json.convidados.length, 6, 'os 4 associados saíram da lista');
  assert.ok(!json.convidados.some((c) => ['Gabriel Costa', 'Motta', 'Miguel', 'Marcos'].includes(c.nome)));
  assert.equal(confirmados.length + json.convidados.length, 15, 'quem ocupa a vaga de um convidado não conta duas vezes');
}

test('depois de associar 4 convidados: 9 confirmados + 6 convidados = 15 (não 19), e recarregar não perde a lista', async (t) => {
  const { pedir } = await sortearEAssociar(t);
  const g = await pedir('GET', `/api/games/${JOGO}`, null, DONO);
  conferirContagem(g.json);
});

test('jogo sorteado ANTES desta rodada (sem lista gravada): a lista vem do sorteio e a conta dá 15 depois de associar', async (t) => {
  // o sorteio sai do motor sem a coluna (migração por rodar) e a lista fica só dentro dele, como no jogo de referência
  const { pedir, tabelas } = await sortearEAssociar(t, {}, semColunaNoUpdate);
  assert.equal(linhaDoJogo(tabelas).convidados, undefined);
  const g = await pedir('GET', `/api/games/${JOGO}`, null, DONO);
  conferirContagem(g.json);
});

test('"Sortear de novo" depois de associar: os mesmos 15, cada pessoa uma vez, sem digitar nada', async (t) => {
  for (const [rotulo, opcoes] of [['com lista gravada', undefined], ['sem a coluna', semColunaNoUpdate]]) {
    const { pedir, tabelas } = await sortearEAssociar(t, {}, opcoes);
    const r = await pedir('POST', `/api/games/${JOGO}/sortear`, {}, DONO);
    assert.equal(r.status, 200, `${rotulo}: ${JSON.stringify(r.json)}`);
    const todos = jogadoresDe(linhaDoJogo(tabelas).times_resultado);
    assert.equal(todos.length, 15, rotulo);
    assert.equal(todos.filter((j) => j.user_id).length, 9, rotulo);
    assert.equal(todos.filter((j) => !j.user_id).length, 6, rotulo);
    const nomes = todos.map((j) => j.nome);
    assert.equal(new Set(nomes).size, 15, `${rotulo}: ninguém repetido · ${nomes.join(', ')}`);
    for (const id of LIGADAS) assert.equal(todos.filter((j) => j.user_id === id).length, 1, rotulo);
  }
});

test('Desfazer do Associar devolve o convidado à lista, com a marca de cabeça de chave', async (t) => {
  const { carregados, tabelas } = cenario({ convidados: comMarcas() });
  const pedir = subir([carregados['routes/games']], t);
  assert.equal((await pedir('POST', `/api/games/${JOGO}/sortear`, {}, DONO)).status, 200);
  const a = await pedir('POST', `/api/games/${JOGO}/associar-jogador`, { convidado_nome: 'Wesley', user_id: LIGADAS[0] }, DONO);
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.ok(!linhaDoJogo(tabelas).convidados.some((c) => c.nome === 'Wesley'));
  // a conta herdou a marca: no "Sortear de novo" ela continua abrindo um time
  const gp = tabelas.game_players.find((p) => p.user_id === LIGADAS[0]);
  assert.equal(gp.confirmado, true);
  assert.equal(gp.cabeca_chave, true);

  const d = await pedir('POST', `/api/games/${JOGO}/associar-jogador/desfazer`, { user_id: LIGADAS[0] }, DONO);
  assert.equal(d.status, 200, JSON.stringify(d.json));
  const volta = linhaDoJogo(tabelas).convidados.find((c) => c.nome === 'Wesley');
  assert.deepEqual(volta, { nome: 'Wesley', goleiro: false, cabeca_chave: true });
  assert.equal(linhaDoJogo(tabelas).convidados.length, 10);
});

test('sem a coluna (087 por rodar): o sorteio grava igual e o PUT responde com a frase, sem detalhe do banco', async (t) => {
  const { carregados, tabelas } = cenario({}, semColunaNoUpdate);
  const pedir = subir([carregados['routes/games']], t);
  const s = await pedir('POST', `/api/games/${JOGO}/sortear`, { convidados: comMarcas() }, DONO);
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.equal(linhaDoJogo(tabelas).times_resultado.total_jogadores, 15);
  const g = await pedir('GET', `/api/games/${JOGO}`, null, DONO);
  assert.deepEqual(g.json.convidados.filter((c) => c.cabeca_chave).map((c) => c.nome).sort(), [...CABECAS].sort(), 'a lista (com as marcas) vem do sorteio');

  const p = await pedir('PUT', `/api/games/${JOGO}/convidados`, { convidados: comMarcas() }, DONO);
  assert.equal(p.status, 503);
  assert.equal(p.json.error, 'Essa opção ainda não está disponível.');
  assert.ok(!JSON.stringify(p.json).includes('schema cache'));
});
