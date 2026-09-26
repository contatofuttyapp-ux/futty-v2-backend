// Futty v2.0 — RODADA 20 (23-set): convite por link REUTILIZÁVEL, 30 dias.
// Decisão do dono: o link de convite vira "de grupo" — o MESMO link serve
// para todo mundo (não morre no 1º uso), vale 30 dias, e o admin revoga
// quando quiser. Migração 058 (convite_usos) já aplicada.
//
// Cria time/admin próprios e apaga tudo no fim (after), mesmo se falhar.
// Uso: npm test  (ou: node --test tests/convite-reutilizavel.test.js)
require('dotenv').config();
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@supabase/supabase-js');
const { app, supabase } = require('../server');
const { COM_BANCO, MOTIVO_SKIP } = require('./_ajudaBanco');

const { SUPABASE_URL } = process.env;
const SUPABASE_ANON_KEY = require('../utils/chavesSupabase').chavePublica();

let server;
let baseUrl;
let teamId;
let teamSlug;
const contas = {}; // papel -> { id, token }

async function criarConta(papel) {
  const email = `teste-convite-${papel}-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
  const password = `Fx7!${crypto.randomUUID()}`;
  const { data: created, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({ email, password });
  if (signInErr) throw signInErr;
  await supabase.from('users').upsert({ id: created.user.id, email, nome: `Teste ${papel}` }, { onConflict: 'id' });
  return { id: created.user.id, email, token: signIn.session.access_token };
}

function pedir(metodo, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, { method: metodo, headers, body: body ? JSON.stringify(body) : undefined });
}

async function gerarConvite() {
  const res = await pedir('POST', `/api/teams/${teamSlug}/convite`, { token: contas.admin.token });
  const corpo = await res.json();
  assert.equal(res.status, 201, `gerar convite falhou: ${JSON.stringify(corpo)}`);
  return corpo.token;
}

before(async () => {
  if (!COM_BANCO) return;
  if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_PUBLISHABLE_KEY (ou a antiga SUPABASE_ANON_KEY) em falta no .env — precisa dela para assinar sessão de teste.');
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  contas.admin = await criarConta('admin');
  contas.entra1 = await criarConta('entra1');
  contas.entra2 = await criarConta('entra2');

  const sufixo = `${Date.now()}-${crypto.randomInt(1e6)}`;
  teamSlug = `teste-convite-${sufixo}`;
  const { data: time, error: teamErr } = await supabase
    .from('teams')
    .insert({ nome: `Teste Convite ${sufixo}`, slug: teamSlug, cor: '#8b5cf6', criado_por: contas.admin.id })
    .select()
    .single();
  if (teamErr) throw teamErr;
  teamId = time.id;
  const { error: memErr } = await supabase.from('team_members').insert({ team_id: teamId, user_id: contas.admin.id, role: 'admin' });
  if (memErr) throw memErr;
});

after(async () => {
  if (!COM_BANCO) return;
  try {
    if (teamId) await supabase.from('teams').delete().eq('id', teamId);
    for (const c of Object.values(contas)) {
      await supabase.from('users').delete().eq('id', c.id);
      await supabase.auth.admin.deleteUser(c.id).catch(() => {});
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
});

test('CONVITE_DIAS = 30: o token novo expira ~30 dias à frente', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const res = await pedir('POST', `/api/teams/${teamSlug}/convite`, { token: contas.admin.token });
  const corpo = await res.json();
  assert.equal(res.status, 201);
  const dias = (new Date(corpo.expires_at).getTime() - Date.now()) / 86400000;
  assert.ok(dias > 29 && dias < 31, `esperava ~30 dias de validade, deu ${dias.toFixed(2)}`);
});

test('o MESMO link é aceito por 2 contas diferentes (201 nas duas) e usos = 2 no GET', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const token = await gerarConvite();

  const r1 = await pedir('POST', `/api/convite/${token}/aceitar`, { token: contas.entra1.token });
  const c1 = await r1.json();
  assert.equal(r1.status, 201, `1ª conta devia entrar (201): ${JSON.stringify(c1)}`);
  assert.equal(c1.jaMembro, false);

  const r2 = await pedir('POST', `/api/convite/${token}/aceitar`, { token: contas.entra2.token });
  const c2 = await r2.json();
  assert.equal(r2.status, 201, `2ª conta (MESMO link) devia entrar (201) também: ${JSON.stringify(c2)}`);
  assert.equal(c2.jaMembro, false);

  const info = await (await pedir('GET', `/api/convite/${token}`)).json();
  assert.equal(info.valido, true, 'o link continua válido depois de usado 2 vezes');
  assert.equal(info.motivo, null, `'usado' não existe mais como motivo — deu ${info.motivo}`);
  assert.equal(info.usos, 2, `usos devia ser 2, deu ${info.usos}`);

  // Limpeza local (o time não deleta em cascata os membros extra do teste seguinte).
  await supabase.from('team_members').delete().eq('team_id', teamId).in('user_id', [contas.entra1.id, contas.entra2.id]);
});

test('GET /api/teams/:slug/convites lista o convite USADO (não filtra mais por usado_por) com o contador certo', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const token = await gerarConvite();
  await pedir('POST', `/api/convite/${token}/aceitar`, { token: contas.entra1.token });

  const { convites } = await (await pedir('GET', `/api/teams/${teamSlug}/convites`, { token: contas.admin.token })).json();
  const linha = convites.find((c) => c.token === token);
  assert.ok(linha, 'o convite usado tem de continuar na lista de convites ativos');
  assert.equal(linha.usos, 1, `usos devia ser 1, deu ${linha.usos}`);

  await supabase.from('team_members').delete().eq('team_id', teamId).eq('user_id', contas.entra1.id);
});

test('revogado (DELETE) -> GET /api/convite/:token dá motivo "nao_encontrado"', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const gerar = await pedir('POST', `/api/teams/${teamSlug}/convite`, { token: contas.admin.token });
  const { token } = await gerar.json();
  const { convites } = await (await pedir('GET', `/api/teams/${teamSlug}/convites`, { token: contas.admin.token })).json();
  const linha = convites.find((c) => c.token === token);
  assert.ok(linha, 'convite recém-criado tem de aparecer na lista');

  const del = await pedir('DELETE', `/api/teams/${teamSlug}/convites/${linha.id}`, { token: contas.admin.token });
  assert.equal(del.status, 200, 'revogar devia dar 200');

  const info = await (await pedir('GET', `/api/convite/${token}`)).json();
  assert.equal(info.valido, false);
  assert.equal(info.motivo, 'nao_encontrado', `esperava 'nao_encontrado' após revogar, deu ${info.motivo}`);
});

test('expirado -> GET /api/convite/:token dá motivo "expirado"; aceitar dá 400', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const jaExpirou = new Date(Date.now() - 3600000).toISOString();
  const { data: convite, error } = await supabase
    .from('convites')
    .insert({ team_id: teamId, token: crypto.randomUUID(), criado_por: contas.admin.id, expires_at: jaExpirou })
    .select('token')
    .single();
  if (error) throw error;

  const info = await (await pedir('GET', `/api/convite/${convite.token}`)).json();
  assert.equal(info.valido, false);
  assert.equal(info.motivo, 'expirado', `esperava 'expirado', deu ${info.motivo}`);

  const res = await pedir('POST', `/api/convite/${convite.token}/aceitar`, { token: contas.entra1.token });
  const corpo = await res.json();
  assert.equal(res.status, 400, `aceitar convite expirado devia dar 400, deu ${res.status}: ${JSON.stringify(corpo)}`);
});
