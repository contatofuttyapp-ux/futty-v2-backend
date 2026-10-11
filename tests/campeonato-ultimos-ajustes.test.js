// Futty v2.0 — RODADA 30M (motor): os últimos ajustes do campeonato.
//   · a marca de "classificado" na tabela da fase de grupos: só quem a matemática já põe na final enquanto há jogo por fazer; com a fase
//     fechada, os dois finalistas; empate idêntico nunca marca só um;
//   · o próximo jogo (card do Início e topo da página): o primeiro ainda sem placar, na ordem da lista de jogos; some com o campeão;
//   · o título do post do campeão, sem preposição ("<Time> é campeão · <campeonato>").
//
// Uso: npm test  (ou: node --test tests/campeonato-ultimos-ajustes.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../utils/campeonatoStore');

const montar = (nomes, formato = 'pontos_final', nome = 'Copa') => store.montar('time-1', 'dono-1', { nome, formato, nomes });
const idDe = (camp, nome) => camp.times.find((t) => t.nome === nome).id;
const jogar = (camp, x, y, gx, gy) => {
  const X = idDe(camp, x); const Y = idDe(camp, y);
  const c = camp.confrontos.find((k) => k.fase !== 'final' && ((k.time_a_id === X && k.time_b_id === Y) || (k.time_a_id === Y && k.time_b_id === X)));
  return store.aplicarResultado(camp, c.id, c.time_a_id === X ? gx : gy, c.time_a_id === X ? gy : gx);
};
const marcados = (camp) => store.tabelaDaFase1(camp).linhas.filter((l) => l.classificado).map((l) => l.nome);

// Os placares do roteiro do dia 18, na ordem em que a tela lista os jogos.
const JOGOS = [
  ['Ouro', 'Bronze', 3, 1],
  ['Roxo', 'Prata', 1, 1],
  ['Ouro', 'Prata', 1, 1],
  ['Bronze', 'Roxo', 2, 1],
  ['Ouro', 'Roxo', 2, 0],
  ['Prata', 'Bronze', 2, 0],
];
const quatro = (n) => {
  const camp = montar(['Ouro', 'Roxo', 'Prata', 'Bronze']);
  JOGOS.slice(0, n).forEach(([x, y, gx, gy]) => jogar(camp, x, y, gx, gy));
  return camp;
};

// ─── A marca de classificado ─────────────────────────────────────────────────────────────────────────────────────────────

test('antes do 1º jogo e depois do 1º: ninguém é marcado (todos ainda podem tudo)', () => {
  assert.deepEqual(marcados(quatro(0)), []);
  assert.deepEqual(marcados(quatro(1)), [], 'o Ouro venceu, mas 3 pontos não garantem nada com 2 jogos por fazer');
});

test('depois de um empate entre dois times de campanha idêntica, nenhum dos dois é marcado sozinho', () => {
  const camp = quatro(2); // Ouro 3, Roxo 1, Prata 1, Bronze 0
  assert.deepEqual(marcados(camp), []);
  const roxo = store.tabelaDaFase1(camp).linhas.find((l) => l.nome === 'Roxo');
  const prata = store.tabelaDaFase1(camp).linhas.find((l) => l.nome === 'Prata');
  assert.equal(roxo.classificado, prata.classificado, 'Roxo e Prata são iguais em tudo: a marca nunca cai só num deles');
});

test('garantido antes do fim: quem os rivais já não alcançam é marcado, o resto espera (o último jogo decide a 2ª vaga)', () => {
  assert.deepEqual(marcados(quatro(3)), [], 'com 3 jogos ainda dá para todos');
  assert.deepEqual(marcados(quatro(4)), [], 'Ouro 4, Bronze 3: o Bronze ainda alcança');
  assert.deepEqual(marcados(quatro(5)), ['Ouro'], 'Ouro 7 e o rival mais forte só chega a 6: garantido; a 2ª vaga é de Bronze ou Prata');
});

test('dois garantidos antes do último jogo: os dois são marcados e os outros dois não', () => {
  const camp = montar(['Ouro', 'Roxo', 'Prata', 'Bronze']);
  jogar(camp, 'Ouro', 'Roxo', 1, 0);
  jogar(camp, 'Ouro', 'Bronze', 1, 0);
  jogar(camp, 'Ouro', 'Prata', 1, 0);
  jogar(camp, 'Prata', 'Roxo', 1, 0);
  jogar(camp, 'Prata', 'Bronze', 1, 0); // falta só Roxo × Bronze (no máximo 3 pontos para cada)
  assert.equal(camp.confrontos.filter((c) => c.fase !== 'final' && !c.jogado).length, 1);
  assert.deepEqual(marcados(camp).sort(), ['Ouro', 'Prata']);
});

test('fim da fase: os dois finalistas são marcados e são os mesmos da final', () => {
  const camp = quatro(6);
  assert.deepEqual(marcados(camp), ['Ouro', 'Prata']);
  const final = camp.confrontos.find((c) => c.fase === 'final');
  assert.deepEqual([final.time_a_id, final.time_b_id].sort(), [idDe(camp, 'Ouro'), idDe(camp, 'Prata')].sort());
});

test('fim da fase com empate idêntico na linha da final: o time de cima é marcado, os dois empatados não (quem escolhe é o admin)', () => {
  const camp = montar(['Ouro', 'Roxo', 'Prata']);
  jogar(camp, 'Ouro', 'Roxo', 1, 0);
  jogar(camp, 'Ouro', 'Prata', 1, 0);
  jogar(camp, 'Roxo', 'Prata', 0, 0);
  const { pendencia } = store.tabelaDaFase1(camp);
  assert.equal(pendencia.vagas, 1);
  assert.deepEqual(marcados(camp), ['Ouro'], 'só o Ouro está dentro; Roxo e Prata esperam a escolha');
  store.decidirEmpate(camp, idDe(camp, 'Prata'));
  assert.deepEqual(marcados(camp).sort(), ['Ouro', 'Prata'], 'depois da escolha, os dois finalistas');
});

test('fim da fase com dois times empatados em 1º e 2º: os dois são finalistas e os dois são marcados', () => {
  const camp = montar(['Ouro', 'Roxo', 'Prata']);
  jogar(camp, 'Ouro', 'Roxo', 0, 0);
  jogar(camp, 'Ouro', 'Prata', 1, 0);
  jogar(camp, 'Roxo', 'Prata', 1, 0);
  assert.equal(store.tabelaDaFase1(camp).pendencia, null, 'o empate não cruza a linha da final');
  assert.deepEqual(marcados(camp).sort(), ['Ouro', 'Roxo']);
});

test('empate só no 3º lugar: não marca ninguém a mais', () => {
  const camp = montar(['Ouro', 'Roxo', 'Prata', 'Bronze']);
  jogar(camp, 'Ouro', 'Roxo', 2, 0);
  jogar(camp, 'Ouro', 'Prata', 2, 0);
  jogar(camp, 'Ouro', 'Bronze', 2, 0);
  jogar(camp, 'Roxo', 'Prata', 2, 0);
  jogar(camp, 'Roxo', 'Bronze', 2, 0);
  jogar(camp, 'Prata', 'Bronze', 0, 0);
  assert.deepEqual(marcados(camp), ['Ouro', 'Roxo']);
});

// ─── O próximo jogo ──────────────────────────────────────────────────────────────────────────────────────────────────────

const par = (p) => (p ? [p.a.nome, p.b.nome].sort().join(' × ') : null);
const parDaLista = (camp) => {
  const c = [...camp.confrontos].filter((x) => x.fase !== 'final' && !x.jogado).sort((x, y) => x.ronda - y.ronda || x.ordem - y.ordem)[0];
  return [camp.times.find((t) => t.id === c.time_a_id).nome, camp.times.find((t) => t.id === c.time_b_id).nome].sort().join(' × ');
};

test('próximo jogo: o primeiro sem placar na ordem da lista de jogos (rodada, depois a ordem)', () => {
  const camp = quatro(0);
  assert.equal(par(store.proximoJogo(camp)), parDaLista(camp));
  assert.equal(store.proximoJogo(camp).final, false);
  jogar(camp, 'Ouro', 'Bronze', 3, 1); // o 1º da lista
  assert.equal(par(store.proximoJogo(camp)), parDaLista(camp));
  assert.equal(par(store.proximoJogo(camp)), 'Prata × Roxo', 'depois do 1º, o 2º da lista (Roxo × Prata)');
});

test('próximo jogo: lançar fora da ordem não o muda (continua o primeiro que falta)', () => {
  const camp = quatro(0);
  jogar(camp, 'Prata', 'Bronze', 1, 0); // o último da lista, lançado primeiro
  assert.equal(par(store.proximoJogo(camp)), parDaLista(camp));
  assert.equal(par(store.proximoJogo(camp)), 'Bronze × Ouro');
});

test('próximo jogo: com a fase fechada é a final (marcada como tal); a vaga sem nomes não conta antes disso', () => {
  const camp = quatro(5);
  assert.equal(par(store.proximoJogo(camp)), 'Bronze × Prata', 'a final ainda é só vaga: o próximo é o último jogo de grupo');
  jogar(camp, 'Prata', 'Bronze', 2, 0);
  const proximo = store.proximoJogo(camp);
  assert.equal(par(proximo), 'Ouro × Prata');
  assert.equal(proximo.final, true);
});

test('próximo jogo: some quando a final é lançada (e o campeonato termina)', () => {
  const camp = quatro(6);
  const final = camp.confrontos.find((c) => c.fase === 'final');
  store.aplicarResultado(camp, final.id, 2, 2, [], final.time_a_id);
  assert.equal(camp.estado, 'terminado');
  assert.equal(store.proximoJogo(camp), null);
  assert.equal(store.enriquecer(camp).proximo_jogo, null);
  assert.equal(store.resumoParaInicio(camp).proximo, null);
});

test('próximo jogo: o campeonato enriquecido e o resumo do Início dizem o mesmo', () => {
  const camp = quatro(3);
  assert.deepEqual(store.enriquecer(camp).proximo_jogo, store.proximoJogo(camp));
  assert.deepEqual(store.resumoParaInicio(camp).proximo, store.proximoJogo(camp));
  assert.equal(par(store.proximoJogo(camp)), 'Bronze × Roxo');
});

test('próximo jogo: pontos corridos e mata-mata também têm (no mata-mata só confrontos com os dois times conhecidos)', () => {
  const pontos = montar(['A', 'B', 'C'], 'pontos');
  assert.ok(store.proximoJogo(pontos), 'pontos corridos');
  const mata = montar(['A', 'B', 'C', 'D'], 'mata');
  const semi1 = mata.confrontos.find((c) => c.ronda === 1 && c.ordem === 0);
  assert.equal(par(store.proximoJogo(mata)), [mata.times.find((t) => t.id === semi1.time_a_id).nome, mata.times.find((t) => t.id === semi1.time_b_id).nome].sort().join(' × '));
  assert.equal(store.proximoJogo(mata).final, false);
  const semi2 = mata.confrontos.find((c) => c.ronda === 1 && c.ordem === 1);
  store.aplicarResultado(mata, semi1.id, 1, 0);
  store.aplicarResultado(mata, semi2.id, 1, 0);
  assert.equal(store.proximoJogo(mata).final, true, 'a decisão do mata-mata');
});

// ─── O título do post ────────────────────────────────────────────────────────────────────────────────────────────────────

test('o título do post do campeão não usa preposição: "<Time> é campeão · <campeonato>" (serve para "Copa" e "Taça")', () => {
  for (const nome of ['Copa da Domingueira', 'Taça Futty', 'Campeonato Domingueira FC']) {
    const camp = montar(['Ouro', 'Roxo', 'Prata'], 'pontos_final', nome);
    jogar(camp, 'Ouro', 'Roxo', 1, 0);
    jogar(camp, 'Ouro', 'Prata', 1, 0);
    jogar(camp, 'Roxo', 'Prata', 1, 0);
    const final = camp.confrontos.find((c) => c.fase === 'final');
    store.aplicarResultado(camp, final.id, 2, 0);
    const post = store.conteudoDoPostDoCampeao(camp);
    assert.equal(post.body, `🏆 Ouro é campeão · ${nome}`);
    assert.doesNotMatch(post.body, /campeão d[oa] /);
  }
});
