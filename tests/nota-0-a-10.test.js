// Futty v2.0 — A nota numa régua só, de 0 a 10 (decisão do dono): o voto, a média, o Ranking, a vitrine, o Painel, o Início e o sorteio.
//
//   · telas novas (cabeçalho X-Futty-Nota: 10): voto de 0 a 10, inteiro — 0 e 10 passam; 11, -1, 7,5 e texto são 400;
//   · telas antigas (sem o cabeçalho): o voto chega em estrelas e vira × 2; a nota que a pessoa deu volta em estrelas;
//   · votos antigos (convertidos pela migração 086, ou só com a coluna antiga) entram na média certa, sem o acréscimo de 15% de antes;
//   · o Ranking fica na mesma ORDEM e com os mesmos PONTOS (só a escala da nota muda);
//   · a vitrine (radar e evolução), o Painel (nota_media) e o Início (stats.nota) na régua nova;
//   · o sorteio grava o número de cada jogador na régua de 10 e marca o resultado (escala_nota: 10); quem não tem voto e o convidado entram com 6.
//
// O motor de verdade (tests/_appFalsa.js) sobre banco falso — nada de produção.
// Uso: node --test tests/nota-0-a-10.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { subirApp, usuario } = require('./_appFalsa');
const { uuid } = require('./_mundoDeSeguranca');

let app;
before(async () => { app = await subirApp(); });
after(() => app.fechar());

const DIA = 24 * 3600 * 1000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const NOVA = { 'x-futty-nota': '10' };
let rodada = 0;

/**
 * Um time com o admin (que joga) e quatro jogadores. `votos`: [de, para, estrelas] — gravados como a migração 086 deixa (nota e nota10)
 * ou, com `soColunaAntiga`, só com a coluna antiga (o voto de antes da migração, lido × 2).
 */
function mundo({ votos = [], soColunaAntiga = false } = {}) {
  rodada += 1;
  const n = 700 + rodada;
  const p = {
    adm: usuario(uuid('b1', n), 'Chavo'), ana: usuario(uuid('b2', n), 'Ana'), beto: usuario(uuid('b3', n), 'Beto'),
    caio: usuario(uuid('b4', n), 'Caio'), duda: usuario(uuid('b5', n), 'Duda'),
  };
  const T = { id: uuid('21', n), slug: `nota-dez-${n}`, nome: 'Régua FC' };
  const membro = (k, i, extra = {}) => ({ id: uuid(`e${i}`, n), team_id: T.id, user_id: p[k].id, role: 'member', ativo: true, pode_postar: false, categoria: 'linha', ...extra });
  const jogos = [1, 2, 3].map((i) => ({ id: uuid(`8${i}`, n), team_id: T.id, local: 'Quadra', status: 'terminado', cancelado: false, data: iso(-i * DIA) }));
  const presencas = jogos.flatMap((g, i) => ['adm', 'ana', 'beto', 'caio', 'duda'].slice(0, 5 - i).map((k) => ({ game_id: g.id, user_id: p[k].id, confirmado: true })));
  const linhas = votos.map(([de, para, estrelas], i) => ({
    id: uuid(`7${i}`, n), de_user_id: p[de].id, para_user_id: p[para].id, team_id: T.id, game_id: null, nota: estrelas,
    ...(soColunaAntiga ? {} : { nota10: Math.round(estrelas * 2) }),
    updated_at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(),
  }));
  app.reiniciar({
    tabelas: {
      teams: [{ id: T.id, nome: T.nome, slug: T.slug, cor: 'verde', criado_por: p.adm.id, modo_visibilidade: 'privado', publica: false }],
      team_members: [membro('adm', 1, { role: 'admin', pode_postar: true }), membro('ana', 2), membro('beto', 3), membro('caio', 4), membro('duda', 5)],
      games: jogos,
      game_players: presencas,
      votes: linhas,
    },
    usuarios: Object.values(p),
  });
  return { p, T, jogos };
}

const pedirComo = (m, quem, metodo, rota, corpo, cabecalhos = NOVA) => app.pedir(metodo, rota, { token: app.token(m.p[quem].id), corpo, cabecalhos });
const votar = (m, de, para, nota, cabecalhos = NOVA) => pedirComo(m, de, 'POST', `/api/teams/${m.T.slug}/votar`, { para_user_id: m.p[para].id, nota }, cabecalhos);
const ranking = async (m, quem, cabecalhos = NOVA) => {
  const r = await pedirComo(m, quem, 'GET', `/api/teams/${m.T.slug}/ranking`, undefined, cabecalhos);
  assert.equal(r.status, 200, r.texto);
  return r.json.ranking;
};
const linhaDe = (r, m, k) => r.find((x) => x.user_id === m.p[k].id);
const votoGuardado = (m, de, para) => app.tabelas.votes.find((v) => v.de_user_id === m.p[de].id && v.para_user_id === m.p[para].id);

test('telas novas: voto de 0 a 10, inteiro — 0 e 10 passam; 11, -1, 7,5, texto e vazio são 400', async () => {
  const m = mundo();
  assert.equal((await votar(m, 'ana', 'beto', 0)).status, 200, 'o 0 é nota');
  assert.equal(votoGuardado(m, 'ana', 'beto').nota10, 0);
  assert.equal((await votar(m, 'ana', 'caio', 10)).status, 200, 'o 10 é nota');
  assert.equal(votoGuardado(m, 'ana', 'caio').nota10, 10);
  for (const nota of [11, -1, 7.5, 'abc', null, '', true, 1e308]) {
    const r = await votar(m, 'ana', 'duda', nota);
    assert.equal(r.status, 400, `nota ${nota}`);
    assert.equal(r.json.error, 'A nota vai de 0 a 10.', `a frase da recusa (${nota})`);
  }
  assert.equal(votoGuardado(m, 'ana', 'duda'), undefined, 'nada foi gravado com nota inválida');
  const r = await votar(m, 'ana', 'beto', 7);
  assert.equal(r.status, 200);
  assert.equal(r.json.voto.nota, 7, 'a resposta devolve a nota na régua de 10');
  assert.equal(votoGuardado(m, 'ana', 'beto').nota10, 7, 'mudar o voto troca a nota (um voto por pessoa)');
});

test('telas antigas (sem o cabeçalho): o voto chega em estrelas e vira × 2; a nota que a pessoa deu volta em estrelas', async () => {
  const m = mundo();
  assert.equal((await votar(m, 'ana', 'beto', 4, {})).status, 200);
  assert.equal(votoGuardado(m, 'ana', 'beto').nota10, 8, '4 estrelas = 8');
  assert.equal((await votar(m, 'ana', 'caio', 0.5, {})).status, 200);
  assert.equal(votoGuardado(m, 'ana', 'caio').nota10, 1, '0,5 estrela = 1');
  for (const nota of [0, 6, 4.3, 10]) assert.equal((await votar(m, 'ana', 'duda', nota, {})).status, 400, `em estrelas, ${nota} não vale`);
  const velho = await ranking(m, 'ana', {});
  assert.equal(linhaDe(velho, m, 'beto').minha_nota, 4, 'o "Alterar" do app antigo abre com 4 estrelas');
  const novo = await ranking(m, 'ana');
  assert.equal(linhaDe(novo, m, 'beto').minha_nota, 8, 'as telas novas veem 8');
});

test('média com os votos antigos convertidos: estrelas × 2, sem o acréscimo de 15% (4,5 estrelas de média = 9, não 10)', async () => {
  const votos = [['adm', 'ana', 4.5], ['beto', 'ana', 4], ['caio', 'ana', 5], ['adm', 'beto', 2], ['ana', 'beto', 3], ['caio', 'beto', 2.5], ['duda', 'beto', 3.5]];
  for (const soColunaAntiga of [false, true]) {
    const m = mundo({ votos, soColunaAntiga });
    const r = await ranking(m, 'duda');
    assert.equal(linhaDe(r, m, 'ana').nota, 9, `Ana: (9 + 8 + 10) / 3 = 9 ${soColunaAntiga ? '(só a coluna antiga)' : ''}`);
    assert.equal(linhaDe(r, m, 'beto').nota, 5.5, 'Beto: (4 + 6 + 5 + 7) / 4 = 5,5');
    assert.equal(linhaDe(r, m, 'caio').nota, null, 'Caio, sem 3 votos: sem nota');
    // e um voto novo de 0 entra na conta como 0
    assert.equal((await votar(m, 'duda', 'ana', 0)).status, 200);
    assert.equal(linhaDe(await ranking(m, 'duda'), m, 'ana').nota, 6.8, 'Ana: (9 + 8 + 10 + 0) / 4 = 6,75 → 6,8');
  }
});

test('Ranking: a mesma ORDEM e os mesmos PONTOS com os votos em estrelas ou na régua de 10 (só a escala da nota muda)', async () => {
  const votos = [['adm', 'ana', 5], ['beto', 'ana', 4], ['caio', 'ana', 4.5], ['adm', 'beto', 3], ['ana', 'beto', 2], ['caio', 'beto', 4],
    ['ana', 'caio', 1], ['beto', 'caio', 1.5], ['duda', 'caio', 2], ['ana', 'duda', 5], ['beto', 'duda', 5], ['caio', 'duda', 5]];
  const emEstrelas = await ranking(mundo({ votos, soColunaAntiga: true }), 'adm');
  const naRegua = await ranking(mundo({ votos }), 'adm');
  const ordem = (r) => r.map((x) => x.nome_jogador);
  assert.deepEqual(ordem(naRegua), ordem(emEstrelas));
  assert.deepEqual(naRegua.map((x) => x.score), emEstrelas.map((x) => x.score), 'os pontos são os mesmos (o eixo nota é dividido pelo maior do time)');
  assert.deepEqual(naRegua.map((x) => x.nota), emEstrelas.map((x) => x.nota));
  assert.ok(naRegua.every((x) => x.nota == null || (x.nota >= 0 && x.nota <= 10)), 'toda nota entre 0 e 10');
});

test('vitrine do jogador: nota, radar (nota ÷ 10) e evolução na régua de 10; a nota que eu dei, na régua do meu app', async () => {
  const m = mundo({ votos: [['adm', 'ana', 4], ['beto', 'ana', 3], ['caio', 'ana', 5]] });
  const r = await pedirComo(m, 'beto', 'GET', `/api/teams/${m.T.slug}/jogador/${m.p.ana.id}`);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.jogador.nota, 8, '(8 + 6 + 10) / 3 = 8');
  assert.equal(r.json.radar.notas, 80, '8 de 10 = 80% no radar');
  assert.deepEqual(r.json.evolucao.map((e) => e.nota), [8, 7, 8], 'média que vai se formando: 8, (8+6)/2, (8+6+10)/3');
  assert.equal(r.json.jogador.minha_nota, 6, 'eu dei 3 estrelas = 6');
  const antigo = await pedirComo(m, 'beto', 'GET', `/api/teams/${m.T.slug}/jogador/${m.p.ana.id}`, undefined, {});
  assert.equal(antigo.json.jogador.minha_nota, 3, 'o app antigo vê as 3 estrelas');
});

test('Painel (lista de membros do admin) e Início (stats.nota) na régua de 10', async () => {
  const m = mundo({ votos: [['adm', 'beto', 2.5], ['ana', 'beto', 3.5], ['caio', 'beto', 4.5]] });
  const membros = await pedirComo(m, 'adm', 'GET', `/api/teams/${m.T.slug}/membros`);
  assert.equal(membros.status, 200, membros.texto);
  const lista = membros.json.membros || membros.json;
  const beto = lista.find((x) => x.user_id === m.p.beto.id);
  assert.equal(beto.nota_media, 7, '(5 + 7 + 9) / 3 = 7');
  assert.equal(lista.find((x) => x.user_id === m.p.ana.id).nota_media, null, 'sem voto, sem nota');
  const me = await pedirComo(m, 'beto', 'GET', '/api/me');
  assert.equal(me.status, 200, me.texto);
  assert.equal(me.json.stats.nota, 7);
});

test('sorteio: o número de cada jogador na régua de 10, o resultado marcado (escala_nota: 10); sem voto e convidado entram com 6', async () => {
  const m = mundo({ votos: [['adm', 'ana', 4], ['beto', 'ana', 4], ['caio', 'ana', 4], ['adm', 'beto', 2], ['ana', 'beto', 2], ['caio', 'beto', 3]] });
  const jogo = { id: uuid('66', 700 + rodada), team_id: m.T.id, local: 'Quadra', status: 'agendado', cancelado: false, data: iso(DIA), jogadores_por_time: 2 };
  app.tabelas.games.push(jogo);
  for (const k of ['ana', 'beto', 'caio', 'duda']) {
    app.tabelas.game_players.push({ game_id: jogo.id, user_id: m.p[k].id, confirmado: true, goleiro: false, cabeca_chave: false, users: { ...m.p[k] } });
  }
  const r = await pedirComo(m, 'adm', 'POST', `/api/games/${jogo.id}/sortear`, { jogadoresPorTime: 2, convidados: ['Zé da Esquina'] });
  assert.equal(r.status, 200, r.texto);
  const tr = r.json.game.times_resultado;
  assert.equal(tr.escala_nota, 10, 'o resultado novo é marcado');
  const todos = [...tr.times.flatMap((t) => t.jogadores), ...tr.reservas];
  const de = (k) => todos.find((j) => j.user_id === m.p[k].id).rating;
  assert.equal(de('ana'), 8, 'Ana: 4 estrelas de média = 8');
  assert.equal(de('beto'), 4.7, 'Beto: (4 + 4 + 6) / 3 = 4,67 → 4,7');
  assert.equal(de('caio'), 6, 'Caio, sem voto: 6 (o 3 das estrelas × 2)');
  assert.equal(todos.find((j) => j.convidado).rating, 6, 'o convidado sem app: 6, igual a quem ainda não tem voto');
});

test('ajustar os times: as telas novas marcam o resultado na régua de 10; as antigas, num sorteio antigo, deixam como estava', async () => {
  const m = mundo();
  const antigo = { seed: 9, num_times: 2, times: [{ nome: 'Time A', rating_medio: 4, jogadores: [{ user_id: m.p.ana.id, nome: 'Ana', rating: 4 }] }, { nome: 'Time B', rating_medio: 3, jogadores: [{ user_id: m.p.beto.id, nome: 'Beto', rating: 3 }] }], reservas: [] };
  const jogo = { id: uuid('67', 700 + rodada), team_id: m.T.id, local: 'Quadra', status: 'agendado', cancelado: false, data: iso(DIA), sorteio_realizado: true, times_resultado: antigo };
  app.tabelas.games.push(jogo);
  for (const k of ['ana', 'beto']) app.tabelas.game_players.push({ game_id: jogo.id, user_id: m.p[k].id, confirmado: true });
  const corpo = (fator) => ({ times_resultado: { times: [{ nome: 'Time A', jogadores: [{ user_id: m.p.beto.id, nome: 'Beto', rating: 3 * fator }] }, { nome: 'Time B', jogadores: [{ user_id: m.p.ana.id, nome: 'Ana', rating: 4 * fator }] }], reservas: [] } });
  const velho = await pedirComo(m, 'adm', 'PATCH', `/api/games/${jogo.id}/times`, corpo(1), {});
  assert.equal(velho.status, 200, velho.texto);
  assert.equal(velho.json.times_resultado.escala_nota, undefined, 'app antigo num sorteio antigo: continua em estrelas (as telas leem × 2)');
  const novo = await pedirComo(m, 'adm', 'PATCH', `/api/games/${jogo.id}/times`, corpo(2));
  assert.equal(novo.status, 200, novo.texto);
  assert.equal(novo.json.times_resultado.escala_nota, 10, 'as telas novas mandam a régua de 10 e o motor marca');
  assert.equal(novo.json.times_resultado.seed, 9, 'o resto do resultado fica');
});
