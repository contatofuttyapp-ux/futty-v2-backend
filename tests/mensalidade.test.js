// Futty v2.0 — A mensalidade do time (routes/mensalidade.js, utils/lembretesMensalidade.js), no app de verdade sobre banco de mentira:
// o admin liga e configura, marca e desmarca; o jogador vê só o dele (ou a lista, se o admin abrir), avisa "Já paguei" e desfaz; o
// admin confirma; meses antigos só para ler; o lembrete do vencimento sai às 10h do relógio do time, uma vez por pessoa por mês, e o
// "avisou que pagou" chega aos admins. Sem a migração 088 nada cai. E o toque no "Traga seu histórico" fica contado.
//
// Uso: npm test  (ou: node --test tests/mensalidade.test.js)
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { subirApp, usuario } = require('./_appFalsa');

let app;
let m;
let lembretes;
const pushes = [];
before(async () => {
  app = await subirApp();
  m = require('../utils/mensalidade');
  lembretes = require('../utils/lembretesMensalidade');
  require('../routes/push').enviarNotificacao = async (ids, payload, opcoes) => { pushes.push({ ids: [...ids].sort(), ...payload, categoria: opcoes?.categoria }); };
});
after(() => app.fechar());

const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = {
  admin: usuario(uuid(1), 'Chavo'),
  admin2: usuario(uuid(2), 'Bia'),
  ana: usuario(uuid(3), 'Ana'),
  beto: usuario(uuid(4), 'Beto', { notificacoes: { jogos: false } }),
  fora: usuario(uuid(5), 'Fora'),
};
const TIME = { id: uuid(100), slug: 'missa', nome: 'Missa de Quinta', created_at: '2026-01-10T12:00:00Z', fuso: 'America/Sao_Paulo', criado_por: P.admin.id };
const base = '/api/teams/missa/mensalidade';
let atual;

beforeEach(() => {
  pushes.length = 0;
  lembretes.esquecerCarona();
  app.reiniciar({
    tabelas: {
      teams: [TIME],
      team_members: [
        { id: uuid(201), team_id: TIME.id, user_id: P.admin.id, role: 'admin' },
        { id: uuid(202), team_id: TIME.id, user_id: P.admin2.id, role: 'admin' },
        { id: uuid(203), team_id: TIME.id, user_id: P.ana.id, role: 'member' },
        { id: uuid(204), team_id: TIME.id, user_id: P.beto.id, role: 'member' },
      ],
      team_mensalidade: [], mensalidade_pagamentos: [], mensalidade_lembretes: [], historico_interesse: [],
    },
    usuarios: Object.values(P),
  });
  atual = m.mesNoFuso(new Date(), TIME.fuso);
});

const pedir = (quem, metodo, rota, corpo) => app.pedir(metodo, rota, { token: app.token(P[quem].id), corpo });
const ligar = (extra = {}) => pedir('admin', 'PUT', `${base}/ajustes`, { ativa: true, valor: 'R$ 60', dia_vencimento: 10, como_pagar: 'https://picpay.me/chavo', ...extra });

test('desligada por padrão: ninguém vê aba; o admin recebe a configuração para ligar, o jogador só "desligada"', async () => {
  const a = await pedir('admin', 'GET', base);
  assert.equal(a.status, 200, a.texto);
  assert.equal(a.json.ativa, false);
  assert.equal(a.json.disponivel, true);
  assert.deepEqual(a.json.config, { ativa: false, valor: null, dia_vencimento: null, como_pagar: null, lista_publica: false, lembrete: true });
  const j = await pedir('ana', 'GET', base);
  assert.equal(j.json.ativa, false);
  assert.equal('lembrete' in j.json.config, false, 'o lembrete é coisa do admin');
  const time = await pedir('ana', 'GET', '/api/teams/missa');
  assert.equal(time.json.team.mensalidade_ativa, false);
});

test('só o admin configura; o texto é validado (40 / 300 letras, dia 1–31)', async () => {
  assert.equal((await pedir('ana', 'PUT', `${base}/ajustes`, { ativa: true })).status, 403);
  assert.equal((await pedir('admin', 'PUT', `${base}/ajustes`, { valor: 'x'.repeat(41) })).status, 400);
  assert.equal((await pedir('admin', 'PUT', `${base}/ajustes`, { dia_vencimento: 32 })).status, 400);
  assert.equal((await pedir('admin', 'PUT', `${base}/ajustes`, { como_pagar: 'y'.repeat(301) })).status, 400);
  assert.equal((await pedir('admin', 'PUT', `${base}/ajustes`, { ativa: 'sim' })).status, 400);
  const r = await ligar();
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.config.ativa, true);
  assert.equal((await pedir('ana', 'GET', '/api/teams/missa')).json.team.mensalidade_ativa, true, 'agora a aba aparece');
  // mudar uma coisa só não apaga as outras
  const r2 = await pedir('admin', 'PUT', `${base}/ajustes`, { lista_publica: true });
  assert.equal(r2.json.config.valor, 'R$ 60');
  assert.equal(r2.json.config.lista_publica, true);
});

test('admin vê todos em aberto e o contador; o jogador (lista privada) vê só o dele', async () => {
  await ligar();
  const a = await pedir('admin', 'GET', base);
  assert.equal(a.json.mes, atual);
  assert.equal(a.json.editavel, true);
  assert.equal(a.json.vencimento, m.vencimentoDoMes(atual, 10));
  assert.deepEqual(a.json.lista.map((x) => [x.nome_jogador, x.status]), [['Ana', 'aberto'], ['Beto', 'aberto'], ['Bia', 'aberto'], ['Chavo', 'aberto']]);
  assert.deepEqual(a.json.contador, { pagos: 0, avisaram: 0, total: 4 });
  const j = await pedir('ana', 'GET', base);
  assert.equal(j.json.lista, null);
  assert.equal(j.json.contador, null);
  assert.deepEqual(j.json.eu, { status: 'aberto', marcado_em: null });
  assert.equal(j.json.config.como_pagar, 'https://picpay.me/chavo');
  assert.equal(JSON.stringify(j.json).includes(P.beto.id), false, 'nada do Beto vaza para a Ana');
});

test('"Já paguei" → avisou; push para os OUTROS admins (pedidos); tocar de novo não manda outro; desfazer volta a aberto', async () => {
  await ligar();
  const r = await pedir('ana', 'POST', `${base}/${atual}/ja-paguei`);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.status, 'avisou');
  await new Promise((ok) => setImmediate(ok));
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].ids, [P.admin.id, P.admin2.id].sort());
  assert.equal(pushes[0].title, 'Ana avisou que pagou a mensalidade');
  assert.equal(pushes[0].categoria, 'pedidos');
  assert.equal(pushes[0].url, `/time/missa?aba=mensalidade&mes=${atual}`);
  assert.equal((await pedir('ana', 'POST', `${base}/${atual}/ja-paguei`)).json.status, 'avisou');
  await new Promise((ok) => setImmediate(ok));
  assert.equal(pushes.length, 1, 'dois toques, um push');
  assert.equal((await pedir('admin', 'GET', base)).json.contador.avisaram, 1);
  // o admin que avisa não recebe o próprio push
  await pedir('admin2', 'POST', `${base}/${atual}/ja-paguei`);
  await new Promise((ok) => setImmediate(ok));
  assert.deepEqual(pushes[1].ids, [P.admin.id]);
  // desfazer
  assert.equal((await pedir('ana', 'DELETE', `${base}/${atual}/ja-paguei`)).json.status, 'aberto');
  assert.equal((await pedir('ana', 'GET', base)).json.eu.status, 'aberto');
});

test('o admin confirma (pago): o jogador não desfaz nem avisa de novo; o admin pode voltar a "em aberto"', async () => {
  await ligar();
  await pedir('ana', 'POST', `${base}/${atual}/ja-paguei`);
  const c = await pedir('admin', 'PUT', `${base}/${atual}/membros/${P.ana.id}`, { status: 'pago' });
  assert.equal(c.status, 200, c.texto);
  assert.equal((await pedir('ana', 'GET', base)).json.eu.status, 'pago');
  assert.equal((await pedir('ana', 'DELETE', `${base}/${atual}/ja-paguei`)).json.code, 'JA_PAGO');
  assert.equal((await pedir('ana', 'POST', `${base}/${atual}/ja-paguei`)).json.code, 'JA_PAGO');
  // o admin marca direto quem pagou em dinheiro, sem aviso
  await pedir('admin', 'PUT', `${base}/${atual}/membros/${P.beto.id}`, { status: 'pago' });
  assert.deepEqual((await pedir('admin', 'GET', base)).json.contador, { pagos: 2, avisaram: 0, total: 4 });
  assert.equal((await pedir('admin', 'PUT', `${base}/${atual}/membros/${P.ana.id}`, { status: 'aberto' })).status, 200);
  assert.equal((await pedir('ana', 'GET', base)).json.eu.status, 'aberto');
  assert.equal(app.tabelas.mensalidade_pagamentos.filter((x) => x.user_id === P.ana.id).length, 0, 'em aberto = sem registro');
});

test('jogador nunca marca "pago" (nem o próprio); quem não é do time não lê nada; a pessoa precisa ser do time', async () => {
  await ligar();
  assert.equal((await pedir('ana', 'PUT', `${base}/${atual}/membros/${P.ana.id}`, { status: 'pago' })).status, 403);
  assert.equal((await pedir('ana', 'PUT', `${base}/${atual}/membros/${P.beto.id}`, { status: 'pago' })).status, 403);
  const fora = await pedir('fora', 'GET', base);
  assert.equal(fora.status, 403);
  assert.equal(fora.json.code, 'FORA_DO_TIME');
  assert.equal((await pedir('admin', 'PUT', `${base}/${atual}/membros/${P.fora.id}`, { status: 'pago' })).status, 404);
  assert.equal((await pedir('admin', 'PUT', `${base}/${atual}/membros/${P.ana.id}`, { status: 'talvez' })).status, 400);
});

test('meses: o atual e os 2 anteriores se corrigem; o 3º para trás e o futuro, não; o mês passado fica guardado e o novo começa em aberto', async () => {
  await ligar();
  const dois = m.mesAntes(atual, 2);
  const tres = m.mesAntes(atual, 3);
  assert.equal((await pedir('admin', 'PUT', `${base}/${dois}/membros/${P.ana.id}`, { status: 'pago' })).status, 200);
  const r3 = await pedir('admin', 'PUT', `${base}/${tres}/membros/${P.ana.id}`, { status: 'pago' });
  assert.equal(r3.status, 403);
  assert.equal(r3.json.code, 'MES_FECHADO');
  assert.equal((await pedir('admin', 'PUT', `${base}/${m.mesAntes(atual, -1)}/membros/${P.ana.id}`, { status: 'pago' })).json.code, 'MES_FECHADO');
  assert.equal((await pedir('ana', 'POST', `${base}/${tres}/ja-paguei`)).json.code, 'MES_FECHADO');
  // o mês de dois atrás: pago e guardado; o atual: em aberto (nenhum job zerou nada)
  const antes = await pedir('admin', 'GET', `${base}?mes=${dois}`);
  assert.equal(antes.json.mes, dois);
  assert.equal(antes.json.editavel, true);
  assert.equal(antes.json.lista.find((x) => x.user_id === P.ana.id).status, 'pago');
  assert.equal((await pedir('admin', 'GET', base)).json.lista.find((x) => x.user_id === P.ana.id).status, 'aberto');
  const velho = await pedir('admin', 'GET', `${base}?mes=${tres}`);
  assert.equal(velho.json.editavel, false, 'só para ler');
  // mês torto, futuro ou de antes do time nascer vale o atual
  for (const q of ['2026-13', 'abc', m.mesAntes(atual, -2), '2025-01']) assert.equal((await pedir('admin', 'GET', `${base}?mes=${q}`)).json.mes, atual, q);
});

test('"mostrar a lista para o time": o jogador passa a ver todos e o contador; desligar esconde de novo', async () => {
  await ligar({ lista_publica: true });
  await pedir('admin', 'PUT', `${base}/${atual}/membros/${P.beto.id}`, { status: 'pago' });
  const j = await pedir('ana', 'GET', base);
  assert.equal(j.json.lista.length, 4);
  assert.deepEqual(j.json.contador, { pagos: 1, avisaram: 0, total: 4 });
  await pedir('admin', 'PUT', `${base}/ajustes`, { lista_publica: false });
  assert.equal((await pedir('ana', 'GET', base)).json.lista, null);
});

test('mensalidade desligada: ações recusam (409) e nada se grava', async () => {
  await ligar();
  await pedir('admin', 'PUT', `${base}/ajustes`, { ativa: false });
  assert.equal((await pedir('ana', 'POST', `${base}/${atual}/ja-paguei`)).json.code, 'MENSALIDADE_DESLIGADA');
  assert.equal((await pedir('admin', 'PUT', `${base}/${atual}/membros/${P.ana.id}`, { status: 'pago' })).json.code, 'MENSALIDADE_DESLIGADA');
  assert.equal(app.tabelas.mensalidade_pagamentos.length, 0);
});

test('lembrete: no vencimento às 10h do relógio do time, para quem está em aberto, 1 vez por mês; quem desligou "jogos" fica de fora (no envio)', async () => {
  await ligar({ dia_vencimento: 10 });
  await pedir('admin', 'PUT', `${base}/${atual}/membros/${P.admin2.id}`, { status: 'pago' });
  await pedir('ana', 'POST', `${base}/${atual}/ja-paguei`);
  pushes.length = 0;
  const avisar = async (ids, payload, opcoes) => { pushes.push({ ids: [...ids].sort(), ...payload, categoria: opcoes?.categoria }); };
  const venc = m.vencimentoDoMes(atual, 10);
  const as = (hora) => new Date(`${venc}T${hora}:00-03:00`);
  assert.deepEqual(await lembretes.enviarLembretes({ agora: as('09:59'), avisar }), { times: 1, enviados: 0 }, 'antes das 10h, nada');
  const r = await lembretes.enviarLembretes({ agora: as('10:00'), avisar });
  assert.equal(r.enviados, 2);
  assert.deepEqual(pushes[0].ids, [P.admin.id, P.beto.id].sort(), 'só quem está em aberto (a Bia pagou, a Ana avisou)');
  assert.equal(pushes[0].title, `Mensalidade de ${m.nomeDoMes(atual)} do Missa de Quinta em aberto`);
  assert.equal(pushes[0].body, 'R$ 60. Toque para ver como pagar.');
  assert.equal(pushes[0].categoria, 'jogos', 'quem desligou os avisos de jogos não recebe (o filtro é do enviarNotificacao)');
  assert.deepEqual(await lembretes.enviarLembretes({ agora: as('18:00'), avisar }), { times: 1, enviados: 0 }, 'no mesmo mês, nunca de novo');
  // lembrete desligado: nada
  app.tabelas.mensalidade_lembretes.length = 0;
  await pedir('admin', 'PUT', `${base}/ajustes`, { lembrete: false });
  assert.equal((await lembretes.enviarLembretes({ agora: as('11:00'), avisar })).enviados, 0);
});

test('a rota interna do lembrete só abre com o segredo', async () => {
  process.env.INTERNO_SEGREDO = 'segredo-de-teste';
  try {
    assert.equal((await app.pedir('POST', '/api/interno/mensalidade/lembretes')).status, 401);
    assert.equal((await app.pedir('POST', '/api/interno/mensalidade/lembretes', { cabecalhos: { 'x-futty-interno': 'errado' } })).status, 401);
    const ok = await app.pedir('POST', '/api/interno/mensalidade/lembretes', { cabecalhos: { 'x-futty-interno': 'segredo-de-teste' } });
    assert.equal(ok.status, 200, ok.texto);
    assert.deepEqual(Object.keys(ok.json).sort(), ['enviados', 'times']);
  } finally {
    delete process.env.INTERNO_SEGREDO;
  }
});

test('sem a migração 088: a página do time e a mensalidade não caem (indisponível); configurar diz 503', async () => {
  app.falhar((tabela) => (/mensalidade|historico_interesse/.test(tabela) ? { message: `relation "public.${tabela}" does not exist` } : null));
  const time = await pedir('ana', 'GET', '/api/teams/missa');
  assert.equal(time.status, 200, time.texto);
  assert.equal(time.json.team.mensalidade_ativa, false);
  const g = await pedir('admin', 'GET', base);
  assert.equal(g.status, 200);
  assert.equal(g.json.disponivel, false);
  assert.equal(g.json.ativa, false);
  const c = await ligar();
  assert.equal(c.status, 503);
  assert.equal(c.json.code, 'MENSALIDADE_INDISPONIVEL');
  assert.deepEqual(await lembretes.enviarLembretes({ avisar: async () => {} }), { times: 0, enviados: 0 });
  assert.equal((await pedir('admin', 'POST', '/api/teams/missa/historico/interesse', { origem: 'ranking' })).status, 204, 'contar o toque nunca impede o e-mail');
});

test('"Traga seu histórico": cada toque fica contado (de onde veio); origem desconhecida = 400; quem não é do time = 403', async () => {
  assert.equal((await pedir('admin', 'POST', '/api/teams/missa/historico/interesse', { origem: 'criar_time' })).status, 204);
  assert.equal((await pedir('ana', 'POST', '/api/teams/missa/historico/interesse', { origem: 'resenha' })).status, 204);
  assert.deepEqual(app.tabelas.historico_interesse.map((x) => [x.origem, x.team_id]), [['criar_time', TIME.id], ['resenha', TIME.id]]);
  assert.equal((await pedir('admin', 'POST', '/api/teams/missa/historico/interesse', { origem: 'whatsapp' })).status, 400);
  assert.equal((await pedir('fora', 'POST', '/api/teams/missa/historico/interesse', { origem: 'ranking' })).status, 403);
});
