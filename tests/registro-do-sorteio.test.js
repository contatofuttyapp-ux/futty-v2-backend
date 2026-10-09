// Futty v2.0 — RODADA 30B: o motor anota quem sorteou, quem montou à mão e quem ajustou os times (sem banco, sem rede).
//
//   · sorteio → registro { origem: 'sorteio', por: { id, nome de guerra } };
//   · times montados à mão → { origem: 'manual', por };
//   · ajuste depois do sorteio → o 1º ajuste guarda o ORIGINAL (o que a roleta deu); os seguintes só entram na lista;
//     salvar sem mexer não carimba "ajustado"; o registro que o app manda no corpo é ignorado;
//   · o link público (/api/p/) leva o registro SEM ids e aplica a regra do rosto também ao original;
//   · o Início diz se os times foram montados à mão (sem seed) — é o "Ver times" no lugar do "Ver sorteio".
//
// Uso: npm test  (ou: node --test tests/registro-do-sorteio.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');
const {
  registroDe, registroDeSorteio, registroDeMontagem, resultadoAjustado, registroPublico, mesmaDistribuicao,
} = require('../utils/registroDoSorteio');

const TIME = '11111111-1111-1111-1111-111111111111';
const JOGO = '99999999-9999-9999-9999-999999999999';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const ZE = 'd0000000-0000-0000-0000-000000000002';
const A = 'a0000000-0000-0000-0000-00000000000a';
const B = 'b0000000-0000-0000-0000-00000000000b';
const C = 'c0000000-0000-0000-0000-00000000000c';
const D = 'e0000000-0000-0000-0000-00000000000d';
const AGORA = '2026-10-08T21:00:00.000Z';
const FUTURO = new Date(Date.now() + 86400000).toISOString();

const j = (id, nome) => ({ user_id: id, nome, avatar_url: null, rating: 3 });
const sorteado = () => ({
  seed: 42,
  num_times: 2,
  times: [{ nome: 'Time A', jogadores: [j(A, 'Magrão'), j(B, 'Canhotinha')] }, { nome: 'Time B', jogadores: [j(C, 'Zé'), j(D, 'Gonçalo')] }],
  reservas: [],
  registro: registroDeSorteio({ id: DONO, nome: 'Chavo' }, AGORA),
});

// ─── as contas (puras) ────────────────────────────────────────────────────────
test('1º ajuste: guarda o ORIGINAL (o que a roleta deu) e anota quem ajustou e quando', () => {
  const antes = sorteado();
  const times = [{ nome: 'Time A', jogadores: [j(A, 'Magrão'), j(B, 'Canhotinha'), j(D, 'Gonçalo')] }, { nome: 'Time B', jogadores: [j(C, 'Zé')] }];
  const depois = resultadoAjustado(antes, { times, reservas: [] }, { id: ZE, nome: 'Zé' }, AGORA);
  assert.equal(depois.registro.origem, 'sorteio');
  assert.deepEqual(depois.registro.por, { id: DONO, nome: 'Chavo' }, 'quem sorteou continua sendo quem sorteou');
  assert.deepEqual(depois.registro.ajustes, [{ por: { id: ZE, nome: 'Zé' }, em: AGORA }]);
  assert.deepEqual(depois.registro.original.times, antes.times, 'o original é o que estava gravado antes do ajuste');
  assert.equal(depois.seed, 42, 'a seed fica (o replay da roleta continua exato)');
  assert.deepEqual(depois.times, times);
});

test('ajustes seguidos acumulam: o original fica o do sorteio, cada ajuste entra na lista', () => {
  const um = resultadoAjustado(sorteado(), {
    times: [{ nome: 'Time A', jogadores: [j(A, 'Magrão'), j(D, 'Gonçalo')] }, { nome: 'Time B', jogadores: [j(C, 'Zé'), j(B, 'Canhotinha')] }],
    reservas: [],
  }, { id: ZE, nome: 'Zé' }, AGORA);
  const dois = resultadoAjustado(um, {
    times: [{ nome: 'Time A', jogadores: [j(A, 'Magrão')] }, { nome: 'Time B', jogadores: [j(C, 'Zé'), j(B, 'Canhotinha')] }],
    reservas: [j(D, 'Gonçalo')],
  }, { id: DONO, nome: 'Chavo' }, '2026-10-08T22:00:00.000Z');
  assert.deepEqual(dois.registro.original.times, sorteado().times, 'o original NUNCA é o do ajuste anterior');
  assert.deepEqual(dois.registro.ajustes.map((a) => a.por.nome), ['Zé', 'Chavo']);
});

test('salvar sem mudar ninguém de lugar não é ajuste (a ordem dentro do time não conta)', () => {
  const antes = sorteado();
  const mesmo = resultadoAjustado(antes, {
    times: [{ nome: 'Time A', jogadores: [j(B, 'Canhotinha'), j(A, 'Magrão')] }, { nome: 'Time B', jogadores: [j(D, 'Gonçalo'), j(C, 'Zé')] }],
    reservas: [],
  }, { id: ZE, nome: 'Zé' }, AGORA);
  assert.deepEqual(mesmo.registro.ajustes, []);
  assert.equal(mesmo.registro.original, undefined);
});

test('times montados à mão e depois mexidos continuam "montados à mão" (sem original de roleta)', () => {
  const mao = { times: [{ nome: 'Time A', jogadores: [j(A, 'Magrão')] }, { nome: 'Time B', jogadores: [j(B, 'Canhotinha')] }], reservas: [], registro: registroDeMontagem({ id: DONO, nome: 'Chavo' }, AGORA) };
  const depois = resultadoAjustado(mao, { times: [{ nome: 'Time A', jogadores: [j(B, 'Canhotinha')] }, { nome: 'Time B', jogadores: [j(A, 'Magrão')] }], reservas: [] }, { id: ZE, nome: 'Zé' }, AGORA);
  assert.equal(depois.registro.origem, 'manual');
  assert.equal(depois.registro.original, undefined);
  assert.deepEqual(depois.registro.ajustes.map((a) => a.por.nome), ['Zé']);
});

test('jogo antigo (antes do registro): com seed foi sorteio, sem seed foi à mão — e sem nome', () => {
  assert.deepEqual(registroDe({ seed: 7, times: [] }), { origem: 'sorteio', por: null, em: null, ajustes: [] });
  assert.deepEqual(registroDe({ manual: true, times: [] }), { origem: 'manual', por: null, em: null, ajustes: [] });
  const antigo = { seed: 7, times: sorteado().times, reservas: [] };
  const ajustado = resultadoAjustado(antigo, { times: [{ nome: 'Time A', jogadores: [j(A, 'Magrão')] }, { nome: 'Time B', jogadores: [j(C, 'Zé'), j(B, 'Canhotinha'), j(D, 'Gonçalo')] }], reservas: [] }, { id: ZE, nome: 'Zé' }, AGORA);
  assert.equal(ajustado.registro.origem, 'sorteio');
  assert.deepEqual(ajustado.registro.original.times, antigo.times);
});

test('convidado sem app (sem user_id) conta pelo nome ao comparar quem mudou de lugar', () => {
  const g = (nome) => ({ user_id: null, convidado: true, nome });
  assert.equal(mesmaDistribuicao({ times: [{ jogadores: [g('Beto')] }, { jogadores: [g('Caio')] }] }, { times: [{ jogadores: [g('Caio')] }, { jogadores: [g('Beto')] }] }), false);
  assert.equal(mesmaDistribuicao({ times: [{ jogadores: [g('Beto')] }] }, { times: [{ jogadores: [g(' beto ')] }] }), true);
});

test('registroPublico: o link público não leva o id de ninguém, só o nome do selo', () => {
  const r = registroPublico({ origem: 'sorteio', por: { id: DONO, nome: 'Chavo' }, ajustes: [{ por: { id: ZE, nome: 'Zé' }, em: AGORA }] });
  assert.deepEqual(r.por, { nome: 'Chavo' });
  assert.deepEqual(r.ajustes, [{ por: { nome: 'Zé' }, em: AGORA }]);
});

// ─── as rotas ─────────────────────────────────────────────────────────────────
const usuario = (id, nome, extra = {}) => ({ id, nome: `${nome} da Silva`, nome_jogador: nome, avatar_url: null, email: `${nome}@futtymock.com`, ...extra });
const membro = (id, nome, role = 'member') => ({ team_id: TIME, user_id: id, role, users: usuario(id, nome) });
const presenca = (id, nome) => ({ game_id: JOGO, user_id: id, confirmado: true, goleiro: false, cabeca_chave: false, users: usuario(id, nome) });

function cenario(jogo = {}) {
  return carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc' }],
    users: [usuario(DONO, 'Chavo'), usuario(ZE, 'Zé'), usuario(A, 'Magrão'), usuario(B, 'Canhotinha'), usuario(C, 'Zezinho'), usuario(D, 'Gonçalo')],
    team_members: [membro(DONO, 'Chavo', 'admin'), membro(ZE, 'Zé', 'admin'), membro(A, 'Magrão'), membro(B, 'Canhotinha'), membro(C, 'Zezinho'), membro(D, 'Gonçalo')],
    games: [{ id: JOGO, team_id: TIME, data: FUTURO, jogadores_por_time: 2, status: 'agendado', ...jogo }],
    game_players: [presenca(A, 'Magrão'), presenca(B, 'Canhotinha'), presenca(C, 'Zezinho'), presenca(D, 'Gonçalo')],
  }, ['routes/games']);
}

test('POST /sortear grava quem sorteou, com o nome de guerra de agora', async (t) => {
  const { carregados } = cenario();
  const r = await subir([carregados['routes/games']], t)('POST', `/api/games/${JOGO}/sortear`, {}, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const reg = r.json.game.times_resultado.registro;
  assert.equal(reg.origem, 'sorteio');
  assert.deepEqual(reg.por, { id: DONO, nome: 'Chavo' }, 'nome_jogador, não o nome completo');
  assert.ok(reg.em);
  assert.deepEqual(reg.ajustes, []);
});

test('PATCH /times: o registro que o app manda é ignorado — o motor guarda o original e anota o ajuste', async (t) => {
  const { carregados, tabelas } = cenario({ sorteio_realizado: true, times_resultado: sorteado() });
  const pedir = subir([carregados['routes/games']], t);
  const forjado = {
    seed: 42,
    times: [{ nome: 'Time A', jogadores: [j(A, 'Magrão'), j(D, 'Gonçalo')] }, { nome: 'Time B', jogadores: [j(C, 'Zé'), j(B, 'Canhotinha')] }],
    reservas: [],
    registro: { origem: 'sorteio', por: null, ajustes: [] }, // o app "esquecendo" do ajuste
  };
  const r = await pedir('PATCH', `/api/games/${JOGO}/times`, { times_resultado: forjado }, ZE);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const reg = r.json.times_resultado.registro;
  assert.deepEqual(reg.por, { id: DONO, nome: 'Chavo' }, 'quem sorteou não muda');
  assert.deepEqual(reg.ajustes.map((a) => a.por), [{ id: ZE, nome: 'Zé' }]);
  assert.deepEqual(reg.original.times, sorteado().times);
  assert.deepEqual(tabelas.games[0].times_resultado.registro.original.times, sorteado().times, 'gravado no banco, não só na resposta');
});

test('POST /times-manuais grava "montado à mão por" quem montou', async (t) => {
  const { carregados } = cenario();
  const corpo = { times: [{ nome: 'Time Ouro', jogadores: [{ user_id: A, nome: 'Magrão' }, { user_id: B, nome: 'Canhotinha' }] }, { nome: 'Time Roxo', jogadores: [{ user_id: C, nome: 'Zezinho' }, { user_id: null, nome: 'Beto', convidado: true }] }] };
  const r = await subir([carregados['routes/games']], t)('POST', `/api/games/${JOGO}/times-manuais`, corpo, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const tr = r.json.game.times_resultado;
  assert.equal(tr.seed, undefined, 'sem seed: sem roleta');
  assert.equal(tr.registro.origem, 'manual');
  assert.deepEqual(tr.registro.por, { id: DONO, nome: 'Chavo' });
});

test('GET /api/p/: o registro sai sem ids e o rosto do ORIGINAL segue a mesma regra (sem consentimento → silhueta)', async (t) => {
  const comFoto = (id, nome) => ({ ...j(id, nome), avatar_url: 'https://x.supabase.co/storage/v1/object/public/avatars/public/a.webp' });
  const tr = sorteado();
  tr.registro.original = { times: [{ nome: 'Time A', jogadores: [comFoto(A, 'Magrão')] }], reservas: [] };
  tr.registro.ajustes = [{ por: { id: ZE, nome: 'Zé' }, em: AGORA }];
  const { carregados } = cenario({ sorteio_realizado: true, times_resultado: tr });
  const r = await subir([carregados['routes/games']], t)('GET', `/api/p/${JOGO}`, null);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const reg = r.json.times_resultado.registro;
  assert.deepEqual(reg.por, { nome: 'Chavo' });
  assert.deepEqual(reg.ajustes[0].por, { nome: 'Zé' });
  assert.equal(reg.original.times[0].jogadores[0].avatar_url, '', 'Magrão não liberou o rosto: silhueta também no original');
});

// ─── o contador de sorteios ("2º sorteio deste jogo") ─────────────────────────
test('contador: o 1º sorteio é o nº 1; sortear de novo vira o nº 2; resultado antigo com seed conta como 1', () => {
  const { quantosSorteios } = require('../utils/registroDoSorteio');
  const primeiro = registroDeSorteio({ id: DONO, nome: 'Chavo' }, AGORA, null);
  assert.equal(primeiro.sorteio_numero, 1);
  const segundo = registroDeSorteio({ id: DONO, nome: 'Chavo' }, AGORA, { seed: 1, registro: primeiro });
  assert.equal(segundo.sorteio_numero, 2);
  assert.equal(registroDeSorteio(null, AGORA, { seed: 9, times: [] }).sorteio_numero, 2, 'antigo com seed = já houve 1');
  assert.equal(registroDeSorteio(null, AGORA, { manual: true, times: [] }).sorteio_numero, 1, 'antigo sem seed = nenhum sorteio antes');
  assert.equal(quantosSorteios(null), 0);
});

test('contador: montar à mão e ajustar não zeram a conta — o sorteio seguinte continua dela', () => {
  const s2 = { seed: 1, times: sorteado().times, reservas: [], registro: registroDeSorteio(null, AGORA, { seed: 1 }) };
  const mao = registroDeMontagem(null, AGORA, s2);
  assert.equal(mao.sorteios, 2);
  const ajustado = resultadoAjustado(s2, { times: [{ nome: 'Time A', jogadores: [j(A, 'Magrão')] }, { nome: 'Time B', jogadores: [j(B, 'Canhotinha'), j(C, 'Zé'), j(D, 'Gonçalo')] }], reservas: [] }, null, AGORA);
  assert.equal(ajustado.registro.sorteio_numero, 2, 'ajustar não muda o número do sorteio');
  assert.equal(registroDeSorteio(null, AGORA, { times: [], registro: mao }).sorteio_numero, 3);
});

test('POST /sortear duas vezes: o segundo resultado diz que é o 2º sorteio', async (t) => {
  const { carregados } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  const um = await pedir('POST', `/api/games/${JOGO}/sortear`, {}, DONO);
  assert.equal(um.json.game.times_resultado.registro.sorteio_numero, 1);
  const dois = await pedir('POST', `/api/games/${JOGO}/sortear`, {}, DONO);
  assert.equal(dois.status, 200, JSON.stringify(dois.json));
  assert.equal(dois.json.game.times_resultado.registro.sorteio_numero, 2);
});

test('Início: sem seed no resultado (times à mão) o card sabe — é o "Ver times"', async () => {
  const { carregados } = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc' }],
    team_members: [{ team_id: TIME, user_id: A, role: 'member', teams: { id: TIME, nome: 'Várzea FC', slug: 'varzea-fc' } }],
    // `seed` é o alias de times_resultado->seed na consulta do Início.
    games: [
      { id: 'sorteado', team_id: TIME, data: FUTURO, status: 'agendado', sorteio_realizado: true, seed: 42 },
      { id: 'a-mao', team_id: TIME, data: FUTURO, status: 'agendado', sorteio_realizado: true, seed: null },
      { id: 'sem-times', team_id: TIME, data: FUTURO, status: 'agendado', sorteio_realizado: false, seed: null },
    ],
    game_players: [],
  }, ['services/inicio']);
  const { games } = await carregados['services/inicio'].obterConvites(A);
  const porId = Object.fromEntries(games.map((g) => [g.id, g]));
  assert.equal(porId.sorteado.montado_a_mao, false);
  assert.equal(porId['a-mao'].montado_a_mao, true);
  assert.equal(porId['sem-times'].montado_a_mao, false, 'sem times ainda não é "montado"');
});
