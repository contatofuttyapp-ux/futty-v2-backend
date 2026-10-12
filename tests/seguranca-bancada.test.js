// Futty v2.0 — a BANCADA da varredura de segurança (tests/_appFalsa.js): o app de verdade sobre banco, Storage e Auth de mentira.
// Este arquivo prova a bancada, não o app: que ela sobe sem o .env, sem rede, só em 127.0.0.1, e que o motor responde por ela.
// (O .env deste repo aponta para o ÚNICO banco, o de produção: nenhum teste de segurança sobe o motor com ele.)
//
// Uso: node --test tests/seguranca-bancada.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { subirApp, usuario, URL_DO_BANCO } = require('./_appFalsa');

let app;
before(async () => { app = await subirApp(); });
after(() => app.fechar());

test('a bancada sobe o app de verdade, sem .env e sem rede', async () => {
  const ana = usuario('a0000000-0000-0000-0000-000000000001', 'Ana');
  app.reiniciar({ usuarios: [ana] });

  // O motor está lá: health, 404 em JSON, login exigido, login aceito.
  assert.equal((await app.pedir('GET', '/api/health')).status, 200);
  assert.equal((await app.pedir('GET', '/api/nao-existe')).status, 404);
  assert.equal((await app.pedir('GET', '/api/teams')).status, 401, 'sem sessão, 401');
  assert.equal((await app.pedir('GET', '/api/teams', { token: 'token-torto' })).status, 401, 'token que o Auth não conhece, 401');
  const lista = await app.pedir('GET', '/api/teams', { token: app.token(ana.id) });
  assert.equal(lista.status, 200, lista.texto);

  // O banco é o de mentira (o único real é o de produção) e nenhuma conexão saiu da máquina.
  assert.equal(process.env.SUPABASE_URL, URL_DO_BANCO);
  assert.equal(process.env.FAL_KEY, 'fal-de-mentira');
  assert.equal(process.env.STRIPE_SECRET_KEY, undefined);
  assert.deepEqual(app.tentativasDeRede, [], `saiu pedido para a rede: ${app.tentativasDeRede.join(', ')}`);
});

test('a rede está fechada: fetch para fora é recusado e anotado', async () => {
  app.reiniciar();
  await assert.rejects(() => fetch('https://futtyapp.com.br/api/health'), /rede fechada/);
  await assert.rejects(() => fetch('https://projeto-falso.supabase.test/rest/v1/users'), /rede fechada/);
  assert.equal(app.tentativasDeRede.length, 2);
  assert.match(app.tentativasDeRede[0], /futtyapp\.com\.br/);
  app.tentativasDeRede.length = 0; // essas duas tentativas foram de propósito
});

test('reiniciar() troca os dados: o que um teste grava não aparece no seguinte', async () => {
  const bia = usuario('b0000000-0000-0000-0000-000000000002', 'Bia');
  app.reiniciar({ usuarios: [bia] });
  const criado = await app.pedir('POST', '/api/teams', { token: app.token(bia.id), corpo: { nome: 'Time da Bia' } });
  assert.equal(criado.status, 201, criado.texto);
  assert.equal(app.tabelas.teams.length, 1);
  app.reiniciar({ usuarios: [bia] });
  assert.equal((app.tabelas.teams || []).length, 0);
});
