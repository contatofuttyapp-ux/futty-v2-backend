// Futty v2.0 — COFRE 25-set: trocar o par VAPID deixa TODA subscrição antiga inútil.
//
// Depois da troca, o push service recusa a inscrição feita com a chave antiga com 403 (FCM: "SenderId mismatch").
// Antes só 404/410 limpavam a linha: as subscrições mortas ficavam para sempre no banco e cada aviso do time tentava
// (e falhava em) todas elas. O que se tranca aqui:
//
//   1. subscricaoMorta(): 403, 404 e 410 dizem "nunca mais serve"; 400/401/429/5xx/rede são passageiros e a linha fica;
//   2. enviarNotificacao() (o envio em segundo plano dos outros routers): apaga as linhas com 403/404/410 e SÓ elas;
//   3. as duas rotas de admin (aviso ao time inteiro e mensagem a um jogador) fazem o mesmo, e a resposta continua
//      contando a falha (falhas), como sempre.
//
// O web-push é trocado por um dublê que responde por endpoint: nenhum push de verdade sai daqui (nem precisa de
// VAPID válido para o envio). O banco é o real (Supabase): contas, time e subscrições descartáveis, apagados no fim.
//
// Uso: npm test  (ou: node --test tests/push-subscricao-morta.test.js)
require('dotenv').config();
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');
const { app, supabase } = require('../server');
const push = require('../routes/push');

const { SUPABASE_URL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
const SUPABASE_ANON_KEY = require('../utils/chavesSupabase').chavePublica();
const temVapid = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

let server;
let baseUrl;
let teamId;
let slug;
const contas = {}; // papel -> { id, token }
const enviosOriginais = webpush.sendNotification;
// endpoint -> comportamento do dublê: um statusCode (falha) ou 'ok'
const comportamento = new Map();
const sufixo = `${Date.now()}-${crypto.randomInt(1e6)}`;
const endpoint = (rotulo) => `https://fcm.googleapis.com/fcm/send/teste-cofre-${rotulo}-${sufixo}`;

async function criarConta(papel) {
  const email = `teste-cofre-${papel}-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
  const password = `Fx7!${crypto.randomUUID()}`;
  const { data: created, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({ email, password });
  if (signInErr) throw signInErr;
  await supabase.from('users').upsert({ id: created.user.id, email, nome: `Teste ${papel}` }, { onConflict: 'id' });
  return { id: created.user.id, email, token: signIn.session.access_token };
}

/** Grava uma subscrição de mentira para `userId` e diz ao dublê como reagir a ela. */
async function semear(userId, rotulo, reacao) {
  const ep = endpoint(rotulo);
  comportamento.set(ep, reacao);
  const { data, error } = await supabase
    .from('push_subscriptions')
    .insert({ user_id: userId, endpoint: ep, p256dh: 'BPteste-chave-publica', auth: 'teste-auth' })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

const restantes = async (ids) => {
  const { data } = await supabase.from('push_subscriptions').select('id').in('id', ids);
  return new Set((data || []).map((r) => r.id));
};

function pedir(metodo, caminho, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${caminho}`, { method: metodo, headers, body: body ? JSON.stringify(body) : undefined });
}

before(async () => {
  if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_PUBLISHABLE_KEY (ou a antiga SUPABASE_ANON_KEY) em falta no .env — precisa dela para assinar sessão de teste.');

  // O dublê: responde pelo ENDPOINT da subscrição, como faria o push service.
  webpush.sendNotification = async (subscription) => {
    const reacao = comportamento.get(subscription.endpoint);
    if (reacao === 'ok' || reacao === undefined) return { statusCode: 201 };
    const err = new Error(`push service respondeu ${reacao}`);
    err.statusCode = reacao;
    throw err;
  };

  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  contas.admin = await criarConta('admin');
  contas.membro = await criarConta('membro');
  slug = `teste-cofre-${sufixo}`;
  const { data: time, error: teamErr } = await supabase
    .from('teams')
    .insert({ nome: `Teste Cofre ${sufixo}`, slug, cor: '#d4a017', criado_por: contas.admin.id })
    .select()
    .single();
  if (teamErr) throw teamErr;
  teamId = time.id;
  const { error: memErr } = await supabase.from('team_members').insert([
    { team_id: teamId, user_id: contas.admin.id, role: 'admin', categoria: 'linha' },
    { team_id: teamId, user_id: contas.membro.id, role: 'member', categoria: 'linha' },
  ]);
  if (memErr) throw memErr;
});

after(async () => {
  webpush.sendNotification = enviosOriginais;
  try {
    for (const c of Object.values(contas)) await supabase.from('push_subscriptions').delete().eq('user_id', c.id);
    if (teamId) await supabase.from('teams').delete().eq('id', teamId);
    for (const c of Object.values(contas)) {
      await supabase.from('users').delete().eq('id', c.id);
      await supabase.auth.admin.deleteUser(c.id).catch(() => {});
    }
  } catch {
    /* limpeza best-effort — um resto de teste não pode pintar o teste de vermelho */
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('subscricaoMorta: 403, 404 e 410 dizem "nunca mais serve"; o resto é passageiro', () => {
  for (const codigo of [403, 404, 410]) assert.equal(push.subscricaoMorta({ statusCode: codigo }), true, `${codigo} tem de limpar`);
  for (const codigo of [400, 401, 413, 429, 500, 502, 503]) assert.equal(push.subscricaoMorta({ statusCode: codigo }), false, `${codigo} é passageiro: a linha fica`);
  for (const estranho of [undefined, null, {}, new Error('rede caiu'), { statusCode: '403' }]) {
    assert.equal(push.subscricaoMorta(estranho), false, `sem statusCode numérico não se apaga nada (${JSON.stringify(estranho)})`);
  }
});

test('enviarNotificacao: apaga as subscrições com 403/404/410 e SÓ elas', async () => {
  const id403 = await semear(contas.membro.id, 'chave-antiga-403', 403);
  const id410 = await semear(contas.membro.id, 'expirada-410', 410);
  const id404 = await semear(contas.membro.id, 'removida-404', 404);
  const id500 = await semear(contas.membro.id, 'servico-fora-500', 500);
  const id429 = await semear(contas.membro.id, 'limite-429', 429);
  const idOk = await semear(contas.membro.id, 'viva', 'ok');

  await push.enviarNotificacao([contas.membro.id], { title: 'Teste do cofre', body: 'nenhum push de verdade sai daqui' });

  const ficaram = await restantes([id403, id410, id404, id500, id429, idOk]);
  assert.equal(ficaram.has(id403), false, '403 (VAPID trocado) tem de sair do banco');
  assert.equal(ficaram.has(id410), false, '410 sai (como sempre)');
  assert.equal(ficaram.has(id404), false, '404 sai (como sempre)');
  assert.equal(ficaram.has(id500), true, '500 é do serviço, não da subscrição: fica');
  assert.equal(ficaram.has(id429), true, '429 é limite de taxa: fica');
  assert.equal(ficaram.has(idOk), true, 'a que funciona fica');
  await supabase.from('push_subscriptions').delete().in('id', [id500, id429, idOk]);
});

test('aviso ao time inteiro: 403 limpa a linha e a resposta segue contando a falha', { skip: !temVapid && 'sem VAPID no .env' }, async () => {
  const idMorta = await semear(contas.membro.id, 'time-chave-antiga', 403);
  const idViva = await semear(contas.membro.id, 'time-viva', 'ok');

  const res = await pedir('POST', `/api/push/equipas/${slug}/broadcast`, { token: contas.admin.token, body: { titulo: 'Jogo domingo', mensagem: 'Chega cedo' } });
  const corpo = await res.json().catch(() => ({}));
  assert.equal(res.status, 200, `broadcast devia dar 200, deu ${res.status}: ${JSON.stringify(corpo)}`);
  assert.deepEqual([corpo.enviadas, corpo.falhas], [1, 1], 'uma viva enviada, uma morta contada como falha');

  const ficaram = await restantes([idMorta, idViva]);
  assert.equal(ficaram.has(idMorta), false, 'a subscrição com a chave antiga saiu do banco');
  assert.equal(ficaram.has(idViva), true, 'a viva ficou');
  await supabase.from('push_subscriptions').delete().eq('id', idViva);
});

test('mensagem a um jogador: 403 limpa a linha e a resposta segue contando a falha', { skip: !temVapid && 'sem VAPID no .env' }, async () => {
  const idMorta = await semear(contas.membro.id, 'msg-chave-antiga', 403);

  const res = await pedir('POST', `/api/push/equipas/${slug}/membros/${contas.membro.id}/mensagem`, {
    token: contas.admin.token, body: { titulo: 'Oi', mensagem: 'Confirma presença' },
  });
  const corpo = await res.json().catch(() => ({}));
  assert.equal(res.status, 200, `mensagem devia dar 200, deu ${res.status}: ${JSON.stringify(corpo)}`);
  assert.deepEqual([corpo.enviadas, corpo.falhas], [0, 1]);
  assert.equal((await restantes([idMorta])).has(idMorta), false, 'a subscrição com a chave antiga saiu do banco');
});
