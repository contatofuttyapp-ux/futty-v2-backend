// Futty v2.0 — RODADA 30I, item 9: o conserto dos jogos antigos (time_vencedor sem campeao_time_index).
//
// A decisão é pura (utils/consertoDoCampeao.js) e o cliente do banco entra por parâmetro: aqui roda com o Supabase falso. O que isto prova:
//   1. o modo seco SÓ LÊ — nenhum UPDATE é chamado, nem uma linha muda — e conta quantos jogos seriam afetados;
//   2. com --sim grava o campeão (A → 0, B → 1) só onde ele está vazio, e rodar de novo não acha mais nada;
//   3. o que fica de fora: campeão já preenchido (mesmo diferente — o campeão manda), jogo sem times, empate, gols sem vencedor.
//
// Uso: npm test  (ou: node --test tests/conserto-do-campeao.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarSupabaseFalso } = require('./_supabaseFalso');
const { planoDoConserto, executarConserto } = require('../utils/consertoDoCampeao');

const TIME = 'time-1';
const dois = { times: [{ nome: 'Time A', jogadores: [] }, { nome: 'Time B', jogadores: [] }] };
const jogo = (id, extra) => ({ id, team_id: TIME, data: '2026-09-01T20:00:00Z', times_resultado: dois, campeao_time_index: null, time_vencedor: null, resultado_nivel: 0, ...extra });

const JOGOS = [
  jogo('a-sem-campeao', { time_vencedor: 'A', resultado_nivel: 1 }),
  jogo('b-sem-campeao', { time_vencedor: 'B', resultado_nivel: 2 }),
  jogo('ja-certo', { time_vencedor: 'A', campeao_time_index: 0, resultado_nivel: 1 }),
  jogo('divergente', { time_vencedor: 'A', campeao_time_index: 1, resultado_nivel: 1 }),
  jogo('sem-times', { time_vencedor: 'B', times_resultado: null, resultado_nivel: 1 }),
  jogo('empate', { time_vencedor: 'empate', resultado_nivel: 1 }),
  jogo('so-gols', { resultado_nivel: 3 }),
  jogo('sem-resultado'),
];

test('o plano: A → 0 e B → 1 onde falta o campeão; o resto fica de fora, cada um no seu grupo', () => {
  const p = planoDoConserto(JOGOS);
  assert.deepEqual(p.conserta.map((j) => [j.id, j.campeao_time_index]), [['a-sem-campeao', 0], ['b-sem-campeao', 1]]);
  assert.equal(p.jaCertos, 1);
  assert.deepEqual(p.divergentes.map((j) => j.id), ['divergente']);
  assert.deepEqual(p.semTimes.map((j) => j.id), ['sem-times']);
});

test('B com um time só no jogo não tem para onde apontar (índice 1 não existe)', () => {
  const p = planoDoConserto([jogo('um-time', { time_vencedor: 'B', times_resultado: { times: [{ nome: 'Time A' }] } })]);
  assert.equal(p.conserta.length, 0);
  assert.equal(p.semTimes.length, 1);
});

test('MODO SECO: lê, conta e NÃO grava — nenhuma linha muda e nenhum UPDATE é chamado', async () => {
  const atualizacoes = [];
  const { cliente, tabelas } = criarSupabaseFalso({ games: JOGOS }, { falhar: (tabela, op) => { if (op === 'update' || op === 'insert' || op === 'delete' || op === 'upsert') atualizacoes.push(`${op} ${tabela}`); return null; } });
  const antes = JSON.stringify(tabelas.games);
  const r = await executarConserto(cliente, { sim: false });
  assert.equal(r.plano.conserta.length, 2, 'dois jogos seriam afetados');
  assert.equal(r.gravados, 0);
  assert.equal(r.semComoDerivar, 1, 'o jogo só com gols');
  assert.deepEqual(atualizacoes, [], 'nenhuma operação de escrita foi nem tentada');
  assert.equal(JSON.stringify(tabelas.games), antes, 'o banco ficou exatamente como estava');
});

test('--sim grava o campeão onde faltava; o resto não muda; rodar de novo não acha mais nada (idempotente)', async () => {
  const { cliente, tabelas } = criarSupabaseFalso({ games: JOGOS });
  const r = await executarConserto(cliente, { sim: true });
  assert.equal(r.gravados, 2);
  assert.deepEqual(r.falhas, []);
  const por = Object.fromEntries(tabelas.games.map((g) => [g.id, g.campeao_time_index]));
  assert.deepEqual(por, { 'a-sem-campeao': 0, 'b-sem-campeao': 1, 'ja-certo': 0, divergente: 1, 'sem-times': null, empate: null, 'so-gols': null, 'sem-resultado': null });
  assert.equal(tabelas.games.find((g) => g.id === 'a-sem-campeao').time_vencedor, 'A', 'o time_vencedor não é tocado');
  const de_novo = await executarConserto(cliente, { sim: true });
  assert.equal(de_novo.plano.conserta.length, 0);
  assert.equal(de_novo.gravados, 0);
});

test('--sim não pisa num campeão preenchido entre a leitura e a escrita (o UPDATE só vale onde o campeão ainda está vazio)', async () => {
  const { cliente, tabelas } = criarSupabaseFalso({ games: [jogo('corrida', { time_vencedor: 'A', resultado_nivel: 1 })] });
  // Simula alguém corrigindo o jogo (para o Time B) logo depois da leitura do script.
  const from0 = cliente.from.bind(cliente);
  let leu = false;
  cliente.from = (tabela) => {
    const b = from0(tabela);
    const select0 = b.select.bind(b);
    b.select = (...a) => { const r = select0(...a); if (tabela === 'games') leu = true; return r; };
    const update0 = b.update.bind(b);
    b.update = (patch) => { if (leu) tabelas.games[0].campeao_time_index = 1; return update0(patch); };
    return b;
  };
  const r = await executarConserto(cliente, { sim: true });
  assert.equal(tabelas.games[0].campeao_time_index, 1, 'o campeão que alguém pôs no meio do caminho ficou');
  assert.equal(r.falhas.length, 0);
});

test('o script é seco por padrão: só --sim grava (e só o utils tem a escrita)', () => {
  const fs = require('node:fs');
  const script = fs.readFileSync(require.resolve('../scripts/consertar-campeao-antigo.js'), 'utf8');
  assert.match(script, /const SIM = process\.argv\.includes\('--sim'\);/);
  assert.match(script, /executarConserto\(supabase, \{ sim: SIM \}\)/);
  assert.doesNotMatch(script, /\.update\(|\.insert\(|\.delete\(|\.upsert\(/, 'o script em si nunca escreve: quem escreve é executarConserto, e só com sim');
  const util = fs.readFileSync(require.resolve('../utils/consertoDoCampeao.js'), 'utf8');
  assert.match(util, /if \(!sim\) return resultado;\r?\n\s*for \(const j of plano\.conserta\)/);
});
