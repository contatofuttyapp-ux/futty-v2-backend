// Futty v2.0 — o cache dos times da pessoa (utils/vinculosDaPessoa.js), no app de verdade sobre banco de mentira.
//
// Ele tira a primeira ida ao banco do Início e da Resenha. O que não pode acontecer: alguém entrar num time, sair, ser removido, ou o
// time mudar de nome, e a tela continuar com o de antes. Toda escrita PELO motor em times/vínculos esvazia o cache na hora; a escrita
// por baixo (outra instância do Cloud Run, aqui simulada mexendo direto na tabela) aparece passados 60 s.
//
// Uso: npm test  (ou: node --test tests/vinculos-da-pessoa.test.js)
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { subirApp, usuario } = require('./_appFalsa');

let app;
before(async () => { app = await subirApp(); });
after(() => app.fechar());

let n = 0;
const uuid = (k) => `${String(k).padStart(8, '0')}-0000-4000-8000-${String(k).padStart(12, '0')}`;
let P;
beforeEach(() => {
  n += 10;
  P = { chavo: usuario(uuid(n + 1), 'Chavo'), ana: usuario(uuid(n + 2), 'Ana'), bia: usuario(uuid(n + 3), 'Bia') };
  app.reiniciar({ usuarios: Object.values(P) });
});

const pedir = (quem, metodo, rota, corpo) => app.pedir(metodo, rota, { token: app.token(quem.id), corpo });
const timesNoInicio = async (quem) => {
  const r = await pedir(quem, 'GET', '/api/inicio');
  assert.equal(r.status, 200);
  return (r.json.teams?.teams || []).map((t) => t.nome).sort();
};
async function criarTime(dono, nome) {
  const r = await pedir(dono, 'POST', '/api/teams', { nome, publica: false, cor: 'roxo' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.team;
}
async function entrar(admin, time, quem) {
  const conv = await pedir(admin, 'POST', `/api/teams/${time.slug}/convite`, {});
  const r = await pedir(quem, 'POST', `/api/convite/${conv.json.token}/aceitar`, {});
  assert.ok(r.status < 300, JSON.stringify(r.json));
}

test('entrar num time pelo convite aparece NA HORA no Início e na Resenha, mesmo com os times da pessoa já no cache', async () => {
  const missa = await criarTime(P.chavo, 'Missa de Quinta');
  await entrar(P.chavo, missa, P.ana);
  assert.deepEqual(await timesNoInicio(P.ana), ['Missa de Quinta']); // agora o cache conhece a Ana
  const varzea = await criarTime(P.bia, 'Várzea');
  await entrar(P.bia, varzea, P.ana);
  assert.deepEqual(await timesNoInicio(P.ana), ['Missa de Quinta', 'Várzea']);
  // A Resenha lê do mesmo cache: o filtro pelo time novo é aceito (fora do time daria 403).
  const r = await pedir(P.ana, 'GET', `/api/feed?limite=8&team_id=${varzea.id}`);
  assert.equal(r.status, 200);
});

test('sair do time e ser removido somem na hora', async () => {
  const missa = await criarTime(P.chavo, 'Missa de Quinta');
  const varzea = await criarTime(P.chavo, 'Várzea');
  await entrar(P.chavo, missa, P.ana);
  await entrar(P.chavo, varzea, P.ana);
  assert.deepEqual(await timesNoInicio(P.ana), ['Missa de Quinta', 'Várzea']);
  assert.ok((await pedir(P.ana, 'DELETE', `/api/teams/${varzea.slug}/membros/me`)).status < 300);
  assert.deepEqual(await timesNoInicio(P.ana), ['Missa de Quinta']);
  assert.ok((await pedir(P.chavo, 'DELETE', `/api/teams/${missa.slug}/membros/${P.ana.id}`)).status < 300);
  assert.deepEqual(await timesNoInicio(P.ana), []);
  const r = await pedir(P.ana, 'GET', `/api/feed?limite=8&team_id=${missa.id}`);
  assert.equal(r.status, 403, 'a Resenha do time de que saiu fecha na hora');
});

test('o time mudar de nome aparece na hora para quem é membro', async () => {
  const missa = await criarTime(P.chavo, 'Missa de Quinta');
  await entrar(P.chavo, missa, P.ana);
  assert.deepEqual(await timesNoInicio(P.ana), ['Missa de Quinta']);
  const r = await pedir(P.chavo, 'PATCH', `/api/teams/${missa.slug}`, { nome: 'Missa de Sexta' });
  assert.ok(r.status < 300, JSON.stringify(r.json));
  assert.deepEqual(await timesNoInicio(P.ana), ['Missa de Sexta']);
});

test('a mudança feita por baixo do motor (outra instância) aparece passados 60 s, no pedido seguinte', async (t) => {
  const missa = await criarTime(P.chavo, 'Missa de Quinta');
  await entrar(P.chavo, missa, P.ana);
  assert.deepEqual(await timesNoInicio(P.ana), ['Missa de Quinta']);
  // Outra instância tira a Ana do time: este motor não viu a escrita.
  app.tabelas.team_members = app.tabelas.team_members.filter((m) => m.user_id !== P.ana.id);
  assert.deepEqual(await timesNoInicio(P.ana), ['Missa de Quinta'], 'dentro dos 60 s vale o que o cache sabe');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61_000 });
  await timesNoInicio(P.ana); // este ainda pode sair com o velho, e já pede o novo por trás
  await new Promise((r) => { setImmediate(r); });
  assert.deepEqual(await timesNoInicio(P.ana), []);
});
