// Futty v2.0 — RODADA 29I, bloco 3 (item 4): as notificações que cada pessoa quer receber, e o push do pedido de entrada ao admin.
//
// Perfil → Notificações: jogos e presença; pedidos de entrada (só admin); figurinha pronta; Resenha. Todas ligadas por padrão;
// `users.notificacoes` (migração 079) guarda só o que a pessoa desligou. Sem banco e sem rede. O que se prova:
//   · as contas puras (utils/notificacoes.js): padrão tudo ligado, mesclar, recusar tipo inventado;
//   · GET/PATCH /api/push/preferencias — e, sem a 079, GET diz `salvavel: false` (tudo ligado) e PATCH responde 503;
//   · o filtro do envio (quemQuer): quem desligou um tipo fica de fora; sem tipo (aviso do admin) vai para todos; sem a coluna,
//     todos (como sempre foi);
//   · o pedido de entrada avisa os admins (tipo "pedidos"), com o nome de quem pediu e o link da aba Elenco; o time aberto não avisa.
//
// Uso: npm test  (ou: node --test tests/notificacoes-preferencias.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { carregar, subir, injetar, dbFalso } = require('./_rotas');
const { criarSupabaseFalso } = require('./_supabaseFalso');
const { HttpError } = require('../utils/http');
const { CATEGORIAS, preferenciasCompletas, mesclarPreferencias, quemQuer } = require('../utils/notificacoes');

const TIME = '11111111-1111-1111-1111-111111111111';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const VICE = 'e0000000-0000-0000-0000-00000000000e';
const ZECA = 'a0000000-0000-0000-0000-00000000000a';
const NOVO = 'b0000000-0000-0000-0000-00000000000b';

const semColuna079 = (tabela, _op, e) => (tabela === 'users' && /notificacoes/.test(`${e.cols || ''} ${JSON.stringify(e.patch || {})}`)
  ? { code: '42703', message: 'column users.notificacoes does not exist' }
  : null);

/** O routes/push de verdade, com o banco falso por baixo (o _rotas injeta um push falso — aqui é ele que se testa). */
function subirPush(t, tabelas, { falhar = null } = {}) {
  const { cliente, tabelas: vivas } = criarSupabaseFalso(tabelas, { falhar });
  const exigirLogin = (req, _res, next) => {
    const quem = req.get('x-teste-usuario');
    if (!quem) return next(new HttpError(401, 'Sem sessão.'));
    req.user = { id: quem, email: `${quem}@futtymock.com`, app_metadata: {} };
    return next();
  };
  const restaurar = [injetar('utils/db', dbFalso(cliente)), injetar('middleware/auth', { requireAuth: exigirLogin, optionalAuth: (_q, _s, n) => n() })];
  const caminho = require.resolve('../routes/push');
  delete require.cache[caminho];
  const push = require('../routes/push'); // eslint-disable-line global-require
  delete require.cache[caminho];
  for (const r of restaurar.reverse()) r();
  const app = express.Router();
  app.use('/api/push', push);
  return { pedir: subir([app], t), tabelas: vivas };
}

test('preferências: tudo ligado por padrão; mesclar guarda só o desligado; tipo inventado ou valor torto = erro', () => {
  assert.deepEqual(CATEGORIAS, ['jogos', 'pedidos', 'figurinha', 'resenha']);
  assert.deepEqual(preferenciasCompletas(null), { jogos: true, pedidos: true, figurinha: true, resenha: true });
  assert.deepEqual(preferenciasCompletas({ resenha: false }), { jogos: true, pedidos: true, figurinha: true, resenha: false });
  const m = mesclarPreferencias({ resenha: false }, { pedidos: false });
  assert.deepEqual(m.paraGravar, { pedidos: false, resenha: false });
  assert.deepEqual(mesclarPreferencias({ resenha: false }, { resenha: true }).paraGravar, {}, 'religar apaga a chave');
  assert.ok(mesclarPreferencias({}, { marketing: false }).erro);
  assert.ok(mesclarPreferencias({}, { jogos: 'nao' }).erro);
});

test('GET/PATCH /api/push/preferencias: lê, desliga, religa; "admin" diz se a tela mostra "Pedidos de entrada"', async (t) => {
  const { pedir, tabelas } = subirPush(t, {
    users: [{ id: DONO, nome: 'Tonhão', notificacoes: {} }, { id: ZECA, nome: 'Zeca', notificacoes: { resenha: false } }],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin' }, { team_id: TIME, user_id: ZECA, role: 'member' }],
  });
  const zeca = (await pedir('GET', '/api/push/preferencias', null, ZECA)).json;
  assert.deepEqual(zeca.preferencias, { jogos: true, pedidos: true, figurinha: true, resenha: false });
  assert.equal(zeca.admin, false);
  assert.equal(zeca.salvavel, true);
  assert.equal((await pedir('GET', '/api/push/preferencias', null, DONO)).json.admin, true);

  const r = await pedir('PATCH', '/api/push/preferencias', { pedidos: false }, DONO);
  assert.equal(r.status, 200);
  assert.equal(r.json.preferencias.pedidos, false);
  assert.deepEqual(tabelas.users.find((u) => u.id === DONO).notificacoes, { pedidos: false });
  await pedir('PATCH', '/api/push/preferencias', { pedidos: true }, DONO);
  assert.deepEqual(tabelas.users.find((u) => u.id === DONO).notificacoes, {});
  assert.equal((await pedir('PATCH', '/api/push/preferencias', { promocoes: false }, DONO)).status, 400);
});

test('sem a migração 079: GET responde tudo ligado com salvavel:false; PATCH = 503 com a frase da casa', async (t) => {
  const { pedir } = subirPush(t, { users: [{ id: ZECA, nome: 'Zeca' }], team_members: [] }, { falhar: semColuna079 });
  const g = await pedir('GET', '/api/push/preferencias', null, ZECA);
  assert.equal(g.status, 200);
  assert.deepEqual(g.json.preferencias, { jogos: true, pedidos: true, figurinha: true, resenha: true });
  assert.equal(g.json.salvavel, false);
  const p = await pedir('PATCH', '/api/push/preferencias', { jogos: false }, ZECA);
  assert.equal(p.status, 503);
  assert.equal(p.json.error, 'Essa opção ainda não está disponível.');
});

test('o filtro do envio: quem desligou o tipo fica de fora; aviso sem tipo vai a todos; sem a coluna, todos', async () => {
  const { cliente } = criarSupabaseFalso({
    users: [{ id: DONO, notificacoes: { pedidos: false } }, { id: VICE, notificacoes: {} }, { id: ZECA, notificacoes: { jogos: false } }],
  });
  assert.deepEqual(await quemQuer(cliente, [DONO, VICE], 'pedidos'), [VICE]);
  assert.deepEqual(await quemQuer(cliente, [DONO, VICE, ZECA], 'jogos'), [DONO, VICE]);
  assert.deepEqual(await quemQuer(cliente, [DONO, VICE, ZECA], undefined), [DONO, VICE, ZECA]);
  const { cliente: sem079 } = criarSupabaseFalso({ users: [{ id: DONO }] }, { falhar: semColuna079 });
  assert.deepEqual(await quemQuer(sem079, [DONO, VICE], 'pedidos'), [DONO, VICE]);
});

function cenarioPedido(t, modo = 'publico_aprovacao') {
  const enviados = [];
  const { carregados, tabelas } = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde', modo_visibilidade: modo }],
    users: [{ id: DONO, nome: 'Tonhão' }, { id: VICE, nome: 'Vice' }, { id: NOVO, nome: 'Carlos', nome_jogador: 'Carlão' }],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin' }, { team_id: TIME, user_id: VICE, role: 'admin' }, { team_id: TIME, user_id: ZECA, role: 'member' }],
  }, ['routes/teams'], { push: (ids, payload, opcoes) => { enviados.push({ ids, payload, opcoes }); } });
  return { pedir: subir([carregados['routes/teams']], t), tabelas, enviados };
}
const umInstante = () => new Promise((r) => { setTimeout(r, 30); });

test('pedido de entrada: os admins recebem push (tipo "pedidos") com o nome de quem pediu e o link da aba Elenco', async (t) => {
  const { pedir, tabelas, enviados } = cenarioPedido(t);
  const r = await pedir('POST', '/api/teams/varzea-fc/pedir-entrada', { mensagem: 'Jogo de zagueiro' }, NOVO);
  assert.equal(r.status, 201);
  assert.equal(tabelas.team_join_requests.length, 1);
  await umInstante();
  assert.equal(enviados.length, 1);
  assert.deepEqual([...enviados[0].ids].sort(), [DONO, VICE].sort(), 'os dois admins, e só eles');
  assert.deepEqual(enviados[0].payload, { title: 'Carlão quer entrar no Várzea FC', body: 'Toque para aceitar ou recusar.', url: '/time/varzea-fc?aba=elenco' });
  assert.deepEqual(enviados[0].opcoes, { categoria: 'pedidos' });
});

test('time aberto (entra na hora) não manda pedido ao admin; o push que falha não derruba o pedido', async (t) => {
  const aberto = cenarioPedido(t, 'publico_aberto');
  assert.equal((await aberto.pedir('POST', '/api/teams/varzea-fc/pedir-entrada', {}, NOVO)).status, 201);
  await umInstante();
  assert.equal(aberto.enviados.length, 0);

  const { carregados, tabelas } = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde', modo_visibilidade: 'publico_aprovacao' }],
    users: [{ id: NOVO, nome: 'Carlos' }],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin' }],
  }, ['routes/teams'], { push: () => Promise.reject(new Error('FCM fora do ar')) });
  const pedir = subir([carregados['routes/teams']], t);
  assert.equal((await pedir('POST', '/api/teams/varzea-fc/pedir-entrada', {}, NOVO)).status, 201);
  await umInstante();
  assert.equal(tabelas.team_join_requests.length, 1);
});
