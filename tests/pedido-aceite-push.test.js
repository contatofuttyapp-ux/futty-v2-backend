// Futty v2.0 — RODADA 29D: o aceite de um pedido de entrada (PATCH /api/teams/:slug/pedidos/:pedidoId) avisa quem foi aceito
// por push — "Você entrou no <time>!" com o link /equipa/<slug>?entrou=1, que abre as boas-vindas do time no app. Sem banco e
// sem rede (Supabase falso em memória; enviarNotificacao trocado por um gravador). O que se prova:
//   · o payload (título, corpo, url) e o destinatário (quem pediu, mais ninguém);
//   · o aceite devolve 200 e grava o membro COM e SEM falha no push (rejeitado, lançado na hora, ou pendurado);
//   · só a 1ª aprovação avisa (um 2º toque do admin não manda de novo), e recusar nunca avisa;
//   · quem não é admin não aceita (403) e nada é enviado.
//
// Uso: npm test  (ou: node --test tests/pedido-aceite-push.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');

const TIME = '11111111-1111-1111-1111-111111111111';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const MEMBRO = 'a0000000-0000-0000-0000-00000000000a';
const QUEM_PEDIU = 'b0000000-0000-0000-0000-00000000000b';
const PEDIDO = 'c0000000-0000-0000-0000-00000000000c';
const ROTA = `/api/teams/varzea-fc/pedidos/${PEDIDO}`;

function cenario(t, { push, statusDoPedido = 'pending' } = {}) {
  const { carregados, tabelas, notificacoes } = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde' }],
    users: [{ id: DONO, nome: 'Tonhão' }, { id: QUEM_PEDIU, nome: 'Zeca' }],
    team_members: [
      { team_id: TIME, user_id: DONO, role: 'admin' },
      { team_id: TIME, user_id: MEMBRO, role: 'member' },
    ],
    team_join_requests: [{ id: PEDIDO, team_id: TIME, user_id: QUEM_PEDIU, status: statusDoPedido }],
  }, ['routes/teams'], { push });
  const pedir = subir([carregados['routes/teams']], t);
  return { pedir, tabelas, notificacoes };
}
const membroDe = (tabelas, userId) => tabelas.team_members.find((m) => m.user_id === userId);
const silenciar = (t) => { const aviso = console.warn; const linhas = []; console.warn = (...a) => { linhas.push(a.join(' ')); }; t.after(() => { console.warn = aviso; }); return linhas; };

test('aprovar avisa quem pediu: título com o nome do time, corpo da casa e o link ?entrou=1', async (t) => {
  const { pedir, tabelas, notificacoes } = cenario(t);
  const r = await pedir('PATCH', ROTA, { status: 'approved' }, DONO);
  assert.equal(r.status, 200);
  assert.equal(r.json.pedido.status, 'approved');
  assert.equal(membroDe(tabelas, QUEM_PEDIU)?.role, 'member', 'virou membro');
  assert.deepEqual(notificacoes, [{
    ids: [QUEM_PEDIU],
    payload: { title: 'Você entrou no Várzea FC!', body: 'Confirme presença e veja o próximo jogo.', url: '/equipa/varzea-fc?entrou=1' },
  }]);
});

test('o push que falha NUNCA derruba o aceite: rejeitado ou lançado na hora — 200, membro gravado, uma linha de log cada', async (t) => {
  const linhas = silenciar(t);
  const falhas = {
    rejeitado: () => Promise.reject(new Error('FCM fora do ar')),
    lancado: () => { throw new Error('bug no helper'); },
  };
  for (const [nome, push] of Object.entries(falhas)) {
    const { pedir, tabelas } = cenario(t, { push });
    const r = await pedir('PATCH', ROTA, { status: 'approved' }, DONO);
    assert.equal(r.status, 200, `${nome}: o aceite continua 200`);
    assert.equal(r.json.pedido.status, 'approved', `${nome}: o pedido ficou aprovado`);
    assert.equal(membroDe(tabelas, QUEM_PEDIU)?.role, 'member', `${nome}: a pessoa entrou no time`);
  }
  assert.equal(linhas.filter((l) => /push do aceite de pedido falhou/.test(l)).length, 2, 'cada falha deixa uma linha de log');
  assert.ok(linhas.some((l) => /FCM fora do ar/.test(l)) && linhas.some((l) => /bug no helper/.test(l)));
});

test('um push pendurado não segura o admin além do teto de 4 s (e o aceite sai 200)', async (t) => {
  const { pedir, tabelas } = cenario(t, { push: () => new Promise(() => {}) });
  const t0 = Date.now();
  const r = await pedir('PATCH', ROTA, { status: 'approved' }, DONO);
  const ms = Date.now() - t0;
  assert.equal(r.status, 200);
  assert.equal(membroDe(tabelas, QUEM_PEDIU)?.role, 'member');
  assert.ok(ms >= 3800 && ms < 6000, `esperou ${ms} ms`);
});

test('só a 1ª aprovação avisa: um pedido que já estava aprovado (2º toque do admin) não manda push de novo', async (t) => {
  const { pedir, notificacoes } = cenario(t, { statusDoPedido: 'approved' });
  const r = await pedir('PATCH', ROTA, { status: 'approved' }, DONO);
  assert.equal(r.status, 200, 'continua idempotente');
  assert.equal(notificacoes.length, 0);
});

test('recusar não avisa ninguém, e o pedido fica recusado', async (t) => {
  const { pedir, tabelas, notificacoes } = cenario(t);
  const r = await pedir('PATCH', ROTA, { status: 'rejected' }, DONO);
  assert.equal(r.status, 200);
  assert.equal(r.json.pedido.status, 'rejected');
  assert.equal(membroDe(tabelas, QUEM_PEDIU), undefined, 'não virou membro');
  assert.equal(notificacoes.length, 0);
});

test('quem não é admin não aceita (403) — nada é gravado nem enviado', async (t) => {
  const { pedir, tabelas, notificacoes } = cenario(t);
  const r = await pedir('PATCH', ROTA, { status: 'approved' }, MEMBRO);
  assert.equal(r.status, 403);
  assert.equal(membroDe(tabelas, QUEM_PEDIU), undefined);
  assert.equal(notificacoes.length, 0);
});
