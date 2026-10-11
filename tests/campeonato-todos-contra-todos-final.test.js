// Futty v2.0 — RODADA 30K, parte 1: o campeonato "Todos contra todos + final" (formato `pontos_final`).
//
// (O "sortear direto" do campeonato saiu na 30L: ver tests/campeonato-do-sorteio-do-jogo.test.js.)
// Fase 1: todos contra todos (vitória 3, empate 1). Classificação: PTS → SG → GP → confronto direto; se ainda empatar na briga
// pela vaga na final, QUEM DECIDE É O ADMIN (nunca o alfabeto). Fase 2: a final 1º × 2º nasce sozinha no último jogo da fase 1;
// não tem empate (a regra do mata-mata). Pódio: campeão, vice (perdedor da final), 3º da tabela. Corrigir a fase 1 depois da final
// criada refaz a final (se ainda sem resultado).
//
// Uso: npm test  (ou: node --test tests/campeonato-todos-contra-todos-final.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');
const store = require('../utils/campeonatoStore');

// ─── Cenário puro (sem Storage, sem rota) ───────────────────────────────────────────────────────────────────────────

function campeonato(nomes, formato = 'pontos_final') {
  return store.montar('time-1', 'dono-1', { nome: 'Copa da Resenha', formato, usar_sorteio: false, nomes });
}
const idDe = (camp, nome) => camp.times.find((t) => t.nome === nome).id;
const nomeDe = (camp, id) => camp.times.find((t) => t.id === id)?.nome;

/** Lança X × Y (gols de X, gols de Y), onde quer que o jogo esteja no calendário. */
function jogar(camp, x, y, gx, gy, avisos) {
  const X = idDe(camp, x);
  const Y = idDe(camp, y);
  const c = camp.confrontos.find((k) => k.fase !== 'final' && ((k.time_a_id === X && k.time_b_id === Y) || (k.time_a_id === Y && k.time_b_id === X)));
  assert.ok(c, `não achei o jogo ${x} × ${y}`);
  const [pa, pb] = c.time_a_id === X ? [gx, gy] : [gy, gx];
  return store.aplicarResultado(camp, c.id, pa, pb, avisos);
}
const final = (camp) => camp.confrontos.find((c) => c.fase === 'final');
const finalistas = (camp) => [nomeDe(camp, final(camp).time_a_id), nomeDe(camp, final(camp).time_b_id)];
const tabela = (camp) => store.enriquecer(camp).classificacao;
const ordem = (camp) => tabela(camp).map((l) => l.nome);

/** 4 times, 5 dos 6 jogos. Ouro 7 pts · Prata 4 (SG 0) · Roxo 4 (SG −1) · Bronze 1 — falta Prata × Bronze. */
function quatroTimesAteOUltimo() {
  const camp = campeonato(['Ouro', 'Roxo', 'Prata', 'Bronze']);
  jogar(camp, 'Ouro', 'Roxo', 2, 0);
  jogar(camp, 'Ouro', 'Prata', 1, 1); // empate vale na fase 1
  jogar(camp, 'Ouro', 'Bronze', 3, 0);
  jogar(camp, 'Roxo', 'Prata', 2, 1);
  jogar(camp, 'Roxo', 'Bronze', 0, 0);
  return camp;
}

/** O mesmo, completo (Prata × Bronze 1×0): final criada, Ouro × Prata. */
function comFinalCriada() {
  const camp = quatroTimesAteOUltimo();
  jogar(camp, 'Prata', 'Bronze', 1, 0);
  return camp;
}

test('o calendário: 3, 4 e 8 times = 3, 6 e 28 jogos de grupo, cada par uma vez, mais a vaga da final', () => {
  for (const [n, jogos] of [[3, 3], [4, 6], [8, 28]]) {
    const camp = campeonato(Array.from({ length: n }, (_, i) => `Time ${i + 1}`));
    const grupos = camp.confrontos.filter((c) => c.fase === 'grupos');
    assert.equal(grupos.length, jogos, `${n} times`);
    const pares = new Set(grupos.map((c) => [c.time_a_id, c.time_b_id].sort().join('|')));
    assert.equal(pares.size, jogos, 'nenhum par repetido');
    const vagas = camp.confrontos.filter((c) => c.fase === 'final');
    assert.equal(vagas.length, 1);
    assert.equal(vagas[0].time_a_id, null);
    assert.equal(vagas[0].time_b_id, null);
    assert.equal(vagas[0].jogado, false);
    assert.ok(vagas[0].ronda > Math.max(...grupos.map((c) => c.ronda)), 'a final vem depois da última rodada');
    assert.equal(camp.formato, 'pontos_final');
    assert.deepEqual(camp.desempates, []);
  }
});

test('3 e 8 times, do primeiro ao último jogo: a final nasce no último jogo e o campeão sai dela', () => {
  for (const n of [3, 8]) {
    const nomes = Array.from({ length: n }, (_, i) => `Time ${i + 1}`);
    const camp = campeonato(nomes);
    const forca = (id) => n - camp.times.findIndex((t) => t.id === id); // o Time 1 é o mais forte
    const grupos = camp.confrontos.filter((c) => c.fase === 'grupos');
    grupos.forEach((c, i) => {
      assert.equal(final(camp).time_a_id, null, `${n} times: a final espera até o último jogo (jogo ${i + 1} de ${grupos.length})`);
      const [pa, pb] = forca(c.time_a_id) > forca(c.time_b_id) ? [1, 0] : [0, 1];
      store.aplicarResultado(camp, c.id, pa, pb);
    });
    assert.equal(grupos.length, (n * (n - 1)) / 2);
    assert.deepEqual(finalistas(camp), ['Time 1', 'Time 2'], `${n} times: 1º × 2º da tabela`);
    assert.equal(store.enriquecer(camp).pendencia, null);
    assert.deepEqual(ordem(camp), nomes, 'a tabela segue a força, sem empate');
    store.aplicarResultado(camp, final(camp).id, 0, 1); // o 2º ganha a final
    assert.equal(camp.estado, 'terminado');
    assert.equal(nomeDe(camp, camp.campeao_time_id), 'Time 2');
    assert.deepEqual(store.podio(camp).map((p) => [p.pos, p.time.nome]), [[1, 'Time 2'], [2, 'Time 1'], [3, 'Time 3']]);
  }
});

test('com 2 times o formato não existe: o motor recusa; formato desconhecido cai nos pontos corridos', () => {
  assert.throws(() => campeonato(['A', 'B']), /pelo menos 3 times/);
  assert.equal(store.lerFormato('pontos_final'), 'pontos_final');
  assert.equal(store.lerFormato('qualquer-coisa'), 'pontos');
  assert.equal(store.lerFormato(undefined), 'pontos');
  assert.equal(store.MIN_TIMES_DO_FORMATO.pontos_final, 3);
  // os outros dois formatos seguem aceitando 2
  assert.equal(campeonato(['A', 'B'], 'pontos').confrontos.length, 1);
  assert.equal(campeonato(['A', 'B'], 'mata').confrontos.length, 1);
});

test('antes do último jogo da fase 1 a final é só vaga; no último ela nasce sozinha com o 1º e o 2º', () => {
  const camp = quatroTimesAteOUltimo();
  assert.equal(final(camp).time_a_id, null, 'ainda vaga com 5 de 6 jogos');
  assert.equal(store.enriquecer(camp).fase1_completa, false);
  const avisos = [];
  jogar(camp, 'Prata', 'Bronze', 1, 0, avisos);
  assert.deepEqual(avisos, [], 'criar a final não é um aviso (nada foi desfeito)');
  assert.deepEqual(ordem(camp), ['Ouro', 'Prata', 'Roxo', 'Bronze']);
  assert.deepEqual(finalistas(camp), ['Ouro', 'Prata']);
  assert.equal(store.enriquecer(camp).fase1_completa, true);
  assert.equal(store.enriquecer(camp).pendencia, null);
  assert.equal(camp.estado, 'em_curso', 'fim da fase 1 não coroa ninguém');
  assert.equal(camp.campeao_time_id, null);
});

test('empate vale na fase 1: 1 ponto para cada um; vitória 3, derrota 0', () => {
  const camp = comFinalCriada();
  const t = Object.fromEntries(tabela(camp).map((l) => [l.nome, l]));
  assert.deepEqual([t.Ouro.PTS, t.Ouro.V, t.Ouro.E, t.Ouro.D], [7, 2, 1, 0]);
  assert.deepEqual([t.Prata.PTS, t.Prata.V, t.Prata.E, t.Prata.D], [4, 1, 1, 1]);
  assert.deepEqual([t.Roxo.PTS, t.Roxo.SG], [4, -1]);
  assert.deepEqual([t.Bronze.PTS, t.Bronze.D], [1, 2]);
});

test('a final não entra na tabela da fase 1', () => {
  const camp = comFinalCriada();
  const foto = () => JSON.stringify(tabela(camp).map((l) => [l.nome, l.PTS, l.GP, l.GC, l.J]));
  const antes = foto();
  store.aplicarResultado(camp, final(camp).id, 9, 0);
  assert.equal(foto(), antes);
});

// ─── A ordem da tabela: PTS → SG → GP → confronto direto ───────────────────────────────────────────────────────────

test('critério 1 — pontos iguais, o saldo de gols decide', () => {
  const camp = campeonato(['Ouro', 'Roxo', 'Prata']);
  jogar(camp, 'Ouro', 'Roxo', 1, 0); // Ouro  W
  jogar(camp, 'Prata', 'Ouro', 1, 0); // Prata W sobre o Ouro
  jogar(camp, 'Roxo', 'Prata', 3, 0); // Roxo  W
  // todos com 3 pts · Ouro GP1 GC1 (SG 0) · Roxo GP3 GC1 (SG +2) · Prata GP1 GC3 (SG −2)
  const t = Object.fromEntries(tabela(camp).map((l) => [l.nome, l]));
  assert.deepEqual([t.Ouro.PTS, t.Roxo.PTS, t.Prata.PTS], [3, 3, 3]);
  assert.deepEqual([t.Ouro.SG, t.Roxo.SG, t.Prata.SG], [0, 2, -2]);
  assert.deepEqual(ordem(camp), ['Roxo', 'Ouro', 'Prata']);
});

test('critério 2 — pontos e saldo iguais, os gols pró decidem (o Ouro, 1º da lista, fica por último)', () => {
  const camp = campeonato(['Ouro', 'Roxo', 'Prata']);
  jogar(camp, 'Roxo', 'Prata', 3, 2);
  jogar(camp, 'Prata', 'Ouro', 1, 0);
  jogar(camp, 'Ouro', 'Roxo', 1, 0);
  // todos 3 pts e SG 0 · Roxo GP3 · Prata GP3 · Ouro GP1
  const t = Object.fromEntries(tabela(camp).map((l) => [l.nome, l]));
  assert.deepEqual([t.Ouro.PTS, t.Roxo.PTS, t.Prata.PTS], [3, 3, 3]);
  assert.deepEqual([t.Ouro.SG, t.Roxo.SG, t.Prata.SG], [0, 0, 0]);
  assert.deepEqual([t.Ouro.GP, t.Roxo.GP, t.Prata.GP], [1, 3, 3]);
  assert.equal(ordem(camp)[2], 'Ouro');
});

test('critério 3 — tudo igual, o confronto direto decide; vale mesmo contra a ordem dos times e o alfabeto', () => {
  // Prata e Roxo: 4 pts, SG 0, GP 1. A Roxo venceu a Prata (e Roxo vem depois nos dois jeitos de ordenar).
  const camp = campeonato(['Ouro', 'Prata', 'Roxo', 'Bronze']);
  jogar(camp, 'Ouro', 'Prata', 0, 1);
  jogar(camp, 'Ouro', 'Roxo', 1, 0);
  jogar(camp, 'Ouro', 'Bronze', 0, 1);
  jogar(camp, 'Prata', 'Roxo', 0, 1);
  jogar(camp, 'Prata', 'Bronze', 0, 0);
  jogar(camp, 'Roxo', 'Bronze', 0, 0);
  const t = Object.fromEntries(tabela(camp).map((l) => [l.nome, l]));
  assert.deepEqual([t.Prata.PTS, t.Prata.SG, t.Prata.GP], [4, 0, 1]);
  assert.deepEqual([t.Roxo.PTS, t.Roxo.SG, t.Roxo.GP], [4, 0, 1]);
  assert.deepEqual(ordem(camp), ['Bronze', 'Roxo', 'Prata', 'Ouro']);
  assert.equal(store.enriquecer(camp).pendencia, null, 'o confronto direto desfez: o admin não precisa decidir');
  assert.deepEqual(finalistas(camp).sort(), ['Bronze', 'Roxo']);
});

test('três empatados em ciclo (A vence B, B vence C, C vence A): nada separa, e depois da escolha os que sobram se olham de novo', () => {
  // Ouro, Roxo e Prata: 6 pts, mesmo saldo e mesmos gols; Bronze perde de todo mundo.
  const camp = campeonato(['Ouro', 'Roxo', 'Prata', 'Bronze']);
  jogar(camp, 'Ouro', 'Roxo', 1, 0);
  jogar(camp, 'Roxo', 'Prata', 1, 0);
  jogar(camp, 'Prata', 'Ouro', 1, 0);
  jogar(camp, 'Ouro', 'Bronze', 1, 0);
  jogar(camp, 'Roxo', 'Bronze', 1, 0);
  jogar(camp, 'Prata', 'Bronze', 1, 0);
  const dados = store.enriquecer(camp);
  assert.deepEqual(dados.classificacao.map((l) => l.pos), [1, 1, 1, 4]);
  assert.equal(dados.pendencia.vagas, 2);
  assert.deepEqual(dados.pendencia.candidatos.map((c) => c.nome), ['Ouro', 'Roxo', 'Prata']);
  // O admin põe o Ouro na frente. Sobram Roxo e Prata: entre os dois, o Roxo ganhou — sem segunda pergunta.
  store.decidirEmpate(camp, idDe(camp, 'Ouro'));
  assert.equal(store.enriquecer(camp).pendencia, null);
  assert.deepEqual(ordem(camp), ['Ouro', 'Roxo', 'Prata', 'Bronze']);
  assert.deepEqual(finalistas(camp).sort(), ['Ouro', 'Roxo']);
});

// ─── Empate sem saída: o admin decide ───────────────────────────────────────────────────────────────────────────────

/** 3 times: Ouro vence os dois por 1×0; Zebra × Abelha 0×0 — empate total (inclusive no confronto direto) na vaga da final. */
function empateNaVaga() {
  const camp = campeonato(['Ouro', 'Zebra', 'Abelha']);
  jogar(camp, 'Ouro', 'Zebra', 1, 0);
  jogar(camp, 'Ouro', 'Abelha', 1, 0);
  jogar(camp, 'Zebra', 'Abelha', 0, 0);
  return camp;
}

test('empate que nem o confronto direto desfaz, na briga pela vaga: a final espera o admin e a ordem NÃO é alfabética', () => {
  const camp = empateNaVaga();
  const dados = store.enriquecer(camp);
  assert.equal(final(camp).time_a_id, null, 'a final continua só vaga');
  assert.ok(dados.pendencia, 'há pergunta para o admin');
  assert.equal(dados.pendencia.tipo, 'empate_final');
  assert.equal(dados.pendencia.vagas, 1);
  assert.deepEqual(dados.pendencia.candidatos.map((c) => c.nome), ['Zebra', 'Abelha'], 'ordem dos times, não A→Z');
  assert.deepEqual(ordem(camp), ['Ouro', 'Zebra', 'Abelha']);
  assert.deepEqual(dados.classificacao.map((l) => [l.pos, l.empatado]), [[1, false], [2, true], [2, true]], 'empatados dividem a posição');
});

test('o admin toca num time do empate: ele vai para a final e a final nasce na hora', () => {
  const camp = empateNaVaga();
  const avisos = [];
  store.decidirEmpate(camp, idDe(camp, 'Abelha'), avisos);
  assert.deepEqual(finalistas(camp).sort(), ['Abelha', 'Ouro']);
  assert.equal(store.enriquecer(camp).pendencia, null);
  assert.deepEqual(ordem(camp), ['Ouro', 'Abelha', 'Zebra']);
  assert.deepEqual(avisos, []);
});

test('só quem está no empate pode ser escolhido, e só enquanto há empate', () => {
  const camp = empateNaVaga();
  assert.throws(() => store.decidirEmpate(camp, idDe(camp, 'Ouro')), /não está no empate/);
  assert.throws(() => store.decidirEmpate(camp, 'id-que-nao-existe'), /não está no empate/);
  store.decidirEmpate(camp, idDe(camp, 'Zebra'));
  assert.throws(() => store.decidirEmpate(camp, idDe(camp, 'Abelha')), /Não há empate/);
  assert.throws(() => store.decidirEmpate(campeonato(['A', 'B'], 'pontos'), 'x'), /não tem empate/);
});

test('três times empatados em tudo (todos 0×0): duas perguntas seguidas, uma por vaga', () => {
  const camp = campeonato(['Ouro', 'Roxo', 'Prata']);
  jogar(camp, 'Ouro', 'Roxo', 0, 0);
  jogar(camp, 'Ouro', 'Prata', 0, 0);
  jogar(camp, 'Roxo', 'Prata', 0, 0);
  let p = store.enriquecer(camp).pendencia;
  assert.equal(p.vagas, 2);
  assert.equal(p.candidatos.length, 3);
  store.decidirEmpate(camp, idDe(camp, 'Prata'));
  assert.equal(final(camp).time_a_id, null, 'falta a segunda vaga');
  p = store.enriquecer(camp).pendencia;
  assert.equal(p.vagas, 1);
  assert.deepEqual(p.candidatos.map((c) => c.nome), ['Ouro', 'Roxo']);
  store.decidirEmpate(camp, idDe(camp, 'Roxo'));
  assert.deepEqual(finalistas(camp).sort(), ['Prata', 'Roxo']);
  assert.deepEqual(ordem(camp), ['Prata', 'Roxo', 'Ouro']);
});

test('empate só entre os dois primeiros não pergunta nada: os dois já estão na final', () => {
  const camp = campeonato(['Ouro', 'Roxo', 'Prata']);
  jogar(camp, 'Ouro', 'Roxo', 0, 0);
  jogar(camp, 'Ouro', 'Prata', 1, 0);
  jogar(camp, 'Roxo', 'Prata', 1, 0);
  assert.equal(store.enriquecer(camp).pendencia, null);
  assert.deepEqual(finalistas(camp).sort(), ['Ouro', 'Roxo']);
});

test('empate pelo 3º lugar não bloqueia a final: os dois dividem o 3º', () => {
  const camp = campeonato(['Ouro', 'Roxo', 'Prata', 'Bronze']);
  jogar(camp, 'Ouro', 'Roxo', 0, 1);
  jogar(camp, 'Ouro', 'Prata', 1, 0);
  jogar(camp, 'Ouro', 'Bronze', 1, 0);
  jogar(camp, 'Roxo', 'Prata', 1, 0);
  jogar(camp, 'Roxo', 'Bronze', 1, 0);
  jogar(camp, 'Prata', 'Bronze', 0, 0);
  // Roxo 9 · Ouro 6 · Prata e Bronze 1 pt, GP 0, GC 2 — idênticos, e o jogo entre eles foi 0×0.
  assert.equal(store.enriquecer(camp).pendencia, null);
  assert.deepEqual(finalistas(camp).sort(), ['Ouro', 'Roxo']);
  assert.deepEqual(tabela(camp).map((l) => l.pos), [1, 2, 3, 3]);
  store.aplicarResultado(camp, final(camp).id, 2, 1);
  const pod = store.podio(camp);
  assert.deepEqual(pod.map((p) => p.pos), [1, 2, 3, 3]);
  assert.deepEqual(pod.slice(2).map((p) => p.time.nome).sort(), ['Bronze', 'Prata']);
});

// ─── A final ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('final empatada não vale (a regra do mata-mata): o placar é recusado e nada muda', () => {
  const camp = comFinalCriada();
  assert.throws(() => store.aplicarResultado(camp, final(camp).id, 2, 2), /Na final não há empate/);
  assert.equal(final(camp).jogado, false);
  assert.equal(final(camp).placar_a, null);
  assert.equal(camp.estado, 'em_curso');
  // o mata-mata continua com a frase de sempre
  const mata = campeonato(['A', 'B', 'C', 'D'], 'mata');
  assert.throws(() => store.aplicarResultado(mata, mata.confrontos[0].id, 1, 1), /No mata-mata não há empate/);
});

test('a final vaga não aceita placar', () => {
  const camp = quatroTimesAteOUltimo();
  assert.throws(() => store.aplicarResultado(camp, final(camp).id, 1, 0), /só abre depois do último jogo/);
});

test('o campeão é o vencedor da final; o campeonato termina; pódio: campeão, vice, 3º da tabela', () => {
  const camp = comFinalCriada();
  const prata = idDe(camp, 'Prata');
  // a vitória é da Prata (2º da tabela): o campeão não precisa ser o 1º da fase de grupos
  const c = final(camp);
  const [pa, pb] = c.time_a_id === prata ? [3, 2] : [2, 3];
  store.aplicarResultado(camp, c.id, pa, pb);
  assert.equal(camp.estado, 'terminado');
  assert.equal(camp.campeao_time_id, prata);
  assert.ok(camp.terminado_em);
  assert.equal(store.enriquecer(camp).campeao.nome, 'Prata');
  assert.deepEqual(store.podio(camp).map((p) => [p.pos, p.tier, p.time.nome]), [[1, 'ouro', 'Prata'], [2, 'prata', 'Ouro'], [3, 'bronze', 'Roxo']]);
});

test('sem a final jogada ainda não há pódio', () => {
  assert.deepEqual(store.podio(comFinalCriada()), []);
});

test('pontos corridos e mata-mata ficam como eram (a tabela dos pontos ainda desempata por nome)', () => {
  const camp = campeonato(['Zebra', 'Abelha', 'Macaco'], 'pontos');
  assert.equal(camp.confrontos.every((c) => c.fase === undefined), true);
  assert.equal(camp.desempates, undefined);
  assert.deepEqual(store.classificacao(camp).map((l) => l.nome), ['Abelha', 'Macaco', 'Zebra']);
  assert.equal(store.enriquecer(camp).pendencia, undefined);
});

// ─── Corrigir a fase 1 depois da final criada ──────────────────────────────────────────────────────────────────────

test('correção que não muda o 1º e o 2º: a final fica como está, sem aviso', () => {
  const camp = comFinalCriada();
  const antes = [final(camp).id, final(camp).time_a_id, final(camp).time_b_id];
  const avisos = [];
  jogar(camp, 'Ouro', 'Bronze', 5, 0, avisos); // goleada maior: o Ouro segue em 1º
  assert.deepEqual([final(camp).id, final(camp).time_a_id, final(camp).time_b_id], antes);
  assert.deepEqual(avisos, []);
  assert.equal(tabela(camp).find((l) => l.nome === 'Ouro').GP, 8);
});

test('correção que muda quem é 1º/2º: avisa e refaz a final', () => {
  const camp = comFinalCriada();
  assert.deepEqual(finalistas(camp), ['Ouro', 'Prata']);
  const avisos = [];
  // Ouro × Bronze 3×0 vira 0×3: o Bronze passa a 4 pts com SG +2 e vai para a frente.
  jogar(camp, 'Ouro', 'Bronze', 0, 3, avisos);
  assert.deepEqual(ordem(camp), ['Bronze', 'Prata', 'Ouro', 'Roxo']);
  assert.deepEqual(finalistas(camp).sort(), ['Bronze', 'Prata']);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /A tabela mudou: a final agora é .+ × .+\./);
  assert.equal(final(camp).jogado, false);
  assert.equal(camp.estado, 'em_curso');
});

test('correção que cria um empate sem saída na vaga: a final volta a ser vaga e o admin é avisado', () => {
  const camp = campeonato(['Ouro', 'Zebra', 'Abelha']);
  jogar(camp, 'Ouro', 'Zebra', 1, 0);
  jogar(camp, 'Ouro', 'Abelha', 1, 0);
  jogar(camp, 'Zebra', 'Abelha', 1, 0); // Zebra 3 pts: final Ouro × Zebra
  assert.deepEqual(finalistas(camp).sort(), ['Ouro', 'Zebra']);
  const avisos = [];
  jogar(camp, 'Zebra', 'Abelha', 0, 0, avisos); // corrigido para empate: Zebra e Abelha igualam em tudo
  assert.equal(final(camp).time_a_id, null);
  assert.equal(final(camp).time_b_id, null);
  assert.ok(store.enriquecer(camp).pendencia);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /empate na vaga da final/);
});

test('a escolha do admin não sobrevive ao empate que deixou de existir', () => {
  const camp = campeonato(['Ouro', 'Roxo', 'Prata']);
  jogar(camp, 'Ouro', 'Roxo', 0, 0);
  jogar(camp, 'Ouro', 'Prata', 0, 0);
  jogar(camp, 'Roxo', 'Prata', 0, 0);
  store.decidirEmpate(camp, idDe(camp, 'Prata'));
  store.decidirEmpate(camp, idDe(camp, 'Roxo'));
  assert.deepEqual(finalistas(camp).sort(), ['Prata', 'Roxo']);
  const avisos = [];
  jogar(camp, 'Ouro', 'Prata', 1, 0, avisos); // agora o Ouro tem 4 pts e o Prata 1: ninguém mais está empatado
  assert.equal(store.enriquecer(camp).pendencia, null);
  assert.deepEqual(ordem(camp), ['Ouro', 'Roxo', 'Prata']);
  assert.deepEqual(finalistas(camp).sort(), ['Ouro', 'Roxo']);
  assert.equal(avisos.length, 1);
});

test('re-lançar o mesmo placar não muda nada', () => {
  const camp = comFinalCriada();
  const antes = JSON.stringify([tabela(camp), final(camp)]);
  jogar(camp, 'Ouro', 'Roxo', 2, 0);
  assert.equal(JSON.stringify([tabela(camp), final(camp)]), antes);
});

// ─── Pelas rotas: criar nos 3 caminhos, lançar, corrigir, decidir, pódio e selo ────────────────────────────────────────

const TIME = '11111111-1111-1111-1111-111111111111';
const JOGO = '99999999-9999-9999-9999-999999999999';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const JOGADORES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x, i) => `${x}0000000-0000-0000-0000-00000000000${i}`);
const usuario = (id, nome) => ({ id, nome: `${nome} da Silva`, nome_jogador: nome, email: `${nome}@futtymock.com` });
const membro = (id, nome, role = 'member') => ({ team_id: TIME, user_id: id, role, users: usuario(id, nome) });
const NOMES_J = ['Rafael', 'Bruno', 'Carlos', 'Diego', 'Eduardo', 'Felipe', 'Gustavo', 'Henrique'];

// Um Storage em memória, no lugar do bucket "campeonatos".
function storageFalso() {
  const arquivos = new Map();
  return {
    arquivos,
    from: () => ({
      upload: async (caminho, corpo) => { arquivos.set(caminho, Buffer.from(corpo).toString('utf8')); return { error: null }; },
      download: async (caminho) => (arquivos.has(caminho) ? { data: { text: async () => arquivos.get(caminho) }, error: null } : { data: null, error: { message: 'not found' } }),
      list: async (prefixo) => ({ data: [...arquivos.keys()].filter((k) => k.startsWith(`${prefixo}/`)).map((k) => ({ name: k.slice(prefixo.length + 1) })) }),
      remove: async (caminhos) => { caminhos.forEach((c) => arquivos.delete(c)); return { error: null }; },
    }),
  };
}

function timesDoSorteio(n) {
  return Array.from({ length: n }, (_, i) => ({ nome: `Time ${i + 1}`, jogadores: [{ user_id: JOGADORES[i], nome: NOMES_J[i], avatar_url: null, rating: 3 }] }));
}

function cenario(nTimesSorteio = 4) {
  const t = carregar({
    teams: [{ id: TIME, nome: 'Domingueira FC', slug: 'domingueira-fc' }],
    users: [usuario(DONO, 'Pedro'), ...JOGADORES.map((id, i) => usuario(id, NOMES_J[i]))],
    team_members: [membro(DONO, 'Pedro', 'admin'), ...JOGADORES.map((id, i) => membro(id, NOMES_J[i]))],
    games: [{ id: JOGO, team_id: TIME, data: '2026-10-18T20:00:00.000Z', status: 'agendado', sorteio_realizado: true, times_resultado: { seed: 1, num_times: nTimesSorteio, times: timesDoSorteio(nTimesSorteio), reservas: [] } }],
  }, ['routes/campeonatos']);
  t.cliente.storage = storageFalso();
  return t;
}

const base = '/api/equipas/domingueira-fc/campeonatos';

test('rotas — criação manual: 4 times viram 6 jogos + a vaga da final; com 2 nomes o formato é recusado', async (t) => {
  const { carregados } = cenario();
  const pedir = subir([carregados['routes/campeonatos']], t);
  const ok = await pedir('POST', base, { nome: 'Copa', formato: 'pontos_final', modo: 'manual', nomes: ['Ouro', 'Roxo', 'Prata', 'Bronze'] }, DONO);
  assert.equal(ok.status, 201);
  const camp = ok.json.campeonato;
  assert.equal(camp.formato, 'pontos_final');
  assert.equal(camp.confrontos.filter((c) => c.fase === 'grupos').length, 6);
  assert.equal(camp.confrontos.filter((c) => c.fase === 'final').length, 1);
  assert.equal(camp.classificacao.length, 4);
  assert.equal(camp.pendencia, null);
  assert.equal(camp.fase1_completa, false);

  const dois = await pedir('POST', base, { nome: 'Copa', formato: 'pontos_final', modo: 'manual', nomes: ['Ouro', 'Roxo'] }, DONO);
  assert.equal(dois.status, 400);
  assert.match(dois.json.error, /pelo menos 3 times/);
  // o mesmo pedido nos outros formatos continua valendo
  const pontos = await pedir('POST', base, { nome: 'Copa', formato: 'pontos', modo: 'manual', nomes: ['Ouro', 'Roxo'] }, DONO);
  assert.equal(pontos.status, 201);
  assert.equal(pontos.json.campeonato.formato, 'pontos');
});

test('rotas — a partir do sorteio de um jogo: 4 times entram; só o admin cria', async (t) => {
  const { carregados } = cenario(4);
  const pedir = subir([carregados['routes/campeonatos']], t);
  const jogador = await pedir('POST', `${base}/de-sorteio`, { game_id: JOGO, formato: 'pontos_final' }, JOGADORES[0]);
  assert.equal(jogador.status, 403);
  const r = await pedir('POST', `${base}/de-sorteio`, { game_id: JOGO, formato: 'pontos_final' }, DONO);
  assert.equal(r.status, 201);
  assert.equal(r.json.campeonato.formato, 'pontos_final');
  assert.deepEqual(r.json.campeonato.times.map((x) => x.nome), ['Time Ouro', 'Time Roxo', 'Time Prata', 'Time Bronze']);
  assert.equal(r.json.campeonato.times[0].jogadores[0].nome, 'Rafael');
  assert.equal(r.json.campeonato.confrontos.length, 7);
});

test('rotas — a partir de um sorteio de 2 times este formato não vale (os outros sim)', async (t) => {
  const { carregados } = cenario(2);
  const pedir = subir([carregados['routes/campeonatos']], t);
  const r = await pedir('POST', `${base}/de-sorteio`, { game_id: JOGO, formato: 'pontos_final' }, DONO);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /mínimo 3/);
  const pontos = await pedir('POST', `${base}/de-sorteio`, { game_id: JOGO, formato: 'pontos' }, DONO);
  assert.equal(pontos.status, 201);
});

test('rotas — o campeonato inteiro: fase 1, final automática, empate recusado, campeão, selos e página pública', async (t) => {
  const { carregados } = cenario(4);
  const pedir = subir([carregados['routes/campeonatos']], t);
  const criado = await pedir('POST', `${base}/de-sorteio`, { game_id: JOGO, formato: 'pontos_final' }, DONO);
  let camp = criado.json.campeonato;
  const id = camp.id;
  const nome = (tid) => camp.times.find((x) => x.id === tid).nome;
  const lancar = (confronto, a, b, quem = DONO) => pedir('POST', `${base}/${id}/confrontos/${confronto.id}/resultado`, { placar_a: a, placar_b: b }, quem);
  const grupos = camp.confrontos.filter((c) => c.fase === 'grupos');

  const jogadorComum = await lancar(grupos[0], 1, 0, JOGADORES[0]);
  assert.equal(jogadorComum.status, 403, 'só o admin lança');

  // Ouro vence todos, Roxo vence Prata e Bronze, Prata × Bronze empata 0×0 (os dois fecham a tabela idênticos).
  const forca = { 'Time Ouro': 3, 'Time Roxo': 2, 'Time Prata': 1, 'Time Bronze': 1 };
  let ultimo;
  for (const g of grupos) {
    const fa = forca[nome(g.time_a_id)];
    const fb = forca[nome(g.time_b_id)];
    ultimo = await lancar(g, ...(fa > fb ? [1, 0] : fa < fb ? [0, 1] : [0, 0]));
    assert.equal(ultimo.status, 200);
  }
  camp = ultimo.json.campeonato;
  assert.equal(camp.fase1_completa, true);
  assert.equal(camp.pendencia, null);
  const fin = camp.confrontos.find((c) => c.fase === 'final');
  assert.deepEqual([nome(fin.time_a_id), nome(fin.time_b_id)].sort(), ['Time Ouro', 'Time Roxo']);
  assert.deepEqual(camp.classificacao.map((l) => [l.nome, l.pos]), [['Time Ouro', 1], ['Time Roxo', 2], ['Time Prata', 3], ['Time Bronze', 3]]);

  // Terminar "pelo líder" não existe neste formato.
  assert.equal((await pedir('POST', `${base}/${id}/terminar`, null, DONO)).status, 400);

  // Final empatada: recusada.
  const empate = await lancar(fin, 1, 1);
  assert.equal(empate.status, 400);
  assert.match(empate.json.error, /Na final não há empate/);

  // Final decidida: o Roxo é campeão.
  const roxo = camp.times.find((x) => x.nome === 'Time Roxo').id;
  const [pa, pb] = fin.time_a_id === roxo ? [3, 2] : [2, 3];
  const decidida = await lancar(fin, pa, pb);
  assert.equal(decidida.status, 200);
  assert.equal(decidida.json.campeonato.estado, 'terminado');
  assert.equal(decidida.json.campeonato.campeao.nome, 'Time Roxo');

  // Depois do campeão, corrigir a fase 1 é barrado com explicação — e nada muda.
  const corrigir = await lancar(grupos[0], 5, 0);
  assert.equal(corrigir.status, 409);
  assert.match(corrigir.json.error, /final já foi jogada/);

  // Selos: o jogador do Roxo é campeão; o do Ouro, vice; os dois que dividem o 3º lugar levam "3º LUGAR".
  const selosDe = async (time) => {
    const jogador = camp.times.find((x) => x.nome === time).jogadores[0].user_id;
    const r = await pedir('GET', `/api/equipas/domingueira-fc/jogador/${jogador}/selos`, null, DONO);
    assert.equal(r.status, 200);
    return r.json.selos.filter((s) => s.fonte === 'campeonato').map((s) => s.label);
  };
  assert.deepEqual(await selosDe('Time Roxo'), ['CAMPEÃO']);
  assert.deepEqual(await selosDe('Time Ouro'), ['VICE']);
  assert.deepEqual(await selosDe('Time Prata'), ['3º LUGAR']);
  assert.deepEqual(await selosDe('Time Bronze'), ['3º LUGAR']);

  // A página pública traz o mesmo retrato, com as duas fases.
  const publico = await pedir('GET', `/api/p/campeonato/domingueira-fc/${id}`);
  assert.equal(publico.status, 200);
  assert.equal(publico.json.campeonato.formato, 'pontos_final');
  assert.equal(publico.json.campeonato.campeao.nome, 'Time Roxo');
  assert.equal(publico.json.campeonato.confrontos.filter((c) => c.fase === 'final').length, 1);
  assert.equal(publico.json.campeonato.classificacao.length, 4);

  // A lista do time mostra o formato.
  const lista = await pedir('GET', base, null, DONO);
  assert.equal(lista.json.campeonatos[0].formato, 'pontos_final');
});

test('rotas — empate na vaga da final: a final espera, o admin escolhe pelo toque e só ele', async (t) => {
  const { carregados } = cenario();
  const pedir = subir([carregados['routes/campeonatos']], t);
  const criado = await pedir('POST', base, { nome: 'Copa', formato: 'pontos_final', modo: 'manual', nomes: ['Ouro', 'Zebra', 'Abelha'] }, DONO);
  let camp = criado.json.campeonato;
  const id = camp.id;
  const nome = (tid) => camp.times.find((x) => x.id === tid).nome;
  let r;
  for (const g of camp.confrontos.filter((c) => c.fase === 'grupos')) {
    const par = [nome(g.time_a_id), nome(g.time_b_id)];
    const [a, b] = !par.includes('Ouro') ? [0, 0] : par[0] === 'Ouro' ? [1, 0] : [0, 1];
    r = await pedir('POST', `${base}/${id}/confrontos/${g.id}/resultado`, { placar_a: a, placar_b: b }, DONO);
    assert.equal(r.status, 200);
  }
  camp = r.json.campeonato;
  assert.ok(camp.pendencia);
  assert.deepEqual(camp.pendencia.candidatos.map((c) => c.nome), ['Zebra', 'Abelha']);
  assert.equal(camp.confrontos.find((c) => c.fase === 'final').time_a_id, null);

  const abelha = camp.times.find((x) => x.nome === 'Abelha').id;
  const ouro = camp.times.find((x) => x.nome === 'Ouro').id;
  assert.equal((await pedir('POST', `${base}/${id}/desempate`, { time_id: abelha }, JOGADORES[0])).status, 403);
  const errado = await pedir('POST', `${base}/${id}/desempate`, { time_id: ouro }, DONO);
  assert.equal(errado.status, 400);
  assert.match(errado.json.error, /não está no empate/);

  const certo = await pedir('POST', `${base}/${id}/desempate`, { time_id: abelha }, DONO);
  assert.equal(certo.status, 200);
  assert.equal(certo.json.campeonato.pendencia, null);
  const fin = certo.json.campeonato.confrontos.find((c) => c.fase === 'final');
  assert.deepEqual([fin.time_a_id, fin.time_b_id].sort(), [abelha, ouro].sort());
  // a escolha ficou gravada: ler de novo traz a mesma final
  const lido = await pedir('GET', `${base}/${id}`, null, DONO);
  assert.equal(lido.json.campeonato.pendencia, null);
  assert.equal(lido.json.campeonato.confrontos.find((c) => c.fase === 'final').time_a_id, fin.time_a_id);
});

test('rotas — corrigir a fase 1 com a final criada e sem resultado refaz a final e devolve o aviso', async (t) => {
  const { carregados } = cenario();
  const pedir = subir([carregados['routes/campeonatos']], t);
  const criado = await pedir('POST', base, { nome: 'Copa', formato: 'pontos_final', modo: 'manual', nomes: ['Ouro', 'Roxo', 'Prata'] }, DONO);
  let camp = criado.json.campeonato;
  const id = camp.id;
  const nome = (tid) => camp.times.find((x) => x.id === tid).nome;
  const vence = (g, quem) => (nome(g.time_a_id) === quem ? [1, 0] : [0, 1]);
  let r;
  for (const g of camp.confrontos.filter((c) => c.fase === 'grupos')) {
    // Ouro vence tudo; Roxo vence a Prata
    const [a, b] = [nome(g.time_a_id), nome(g.time_b_id)].includes('Ouro') ? vence(g, 'Ouro') : vence(g, 'Roxo');
    r = await pedir('POST', `${base}/${id}/confrontos/${g.id}/resultado`, { placar_a: a, placar_b: b }, DONO);
  }
  camp = r.json.campeonato;
  const finalistasDe = (c) => { const f = c.confrontos.find((k) => k.fase === 'final'); return [nome(f.time_a_id), nome(f.time_b_id)].sort(); };
  assert.deepEqual(finalistasDe(camp), ['Ouro', 'Roxo']);
  assert.deepEqual(r.json.avisos, []);

  // Corrige Roxo × Prata para a vitória da Prata: Prata 3 pts, Roxo 0 → a final passa a ser Ouro × Prata.
  const g = camp.confrontos.find((c) => c.fase === 'grupos' && [nome(c.time_a_id), nome(c.time_b_id)].sort().join() === 'Prata,Roxo');
  const [a, b] = nome(g.time_a_id) === 'Prata' ? [1, 0] : [0, 1];
  const corrigido = await pedir('POST', `${base}/${id}/confrontos/${g.id}/resultado`, { placar_a: a, placar_b: b }, DONO);
  assert.equal(corrigido.status, 200);
  assert.deepEqual(finalistasDe(corrigido.json.campeonato), ['Ouro', 'Prata']);
  assert.equal(corrigido.json.avisos.length, 1);
  assert.match(corrigido.json.avisos[0], /a final agora é/);
});
