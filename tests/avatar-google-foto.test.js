// Futty v2.0 — HOTFIX 26 (25-set): "Trocar foto" não trocava o card de quem entrou com o Google.
//
// O trigger handle_new_user (migração 001) copiava a foto de perfil do Google para
// users.avatar_url, e POST /api/me/avatar + PUT /api/me/avatar/recorte decidiam "já tem
// figurinha IA" por avatar_url <> foto_url: a foto do Google contava como figurinha, era
// "preservada", e a foto nova ia para foto_url sem o card (avatar_url) nunca mudar.
//
// Aqui, com contas de verdade e o motor local:
//   · conta com a foto do Google em avatar_url + upload  → avatar_url = a foto nova;
//   · o mesmo com o reenquadramento (recorte);
//   · conta com figurinha real (arquivo -ai- no nosso bucket) + upload/recorte → preservada;
//   · tem_figurinha do /api/me não vira true por causa da foto do Google;
//   · os fundos pagos (PATCH /api/me) seguem a mesma regra: a foto do Google não os destranca.
// O estado do Google é gravado à mão em avatar_url: vale com o trigger antigo (que copia) e
// com o novo da migração 060 (que já não copia): o motor tem de funcionar antes e depois.
//
// Uso: npm test  (ou: node --test tests/avatar-google-foto.test.js)
require('dotenv').config();
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const { app, supabase } = require('../server');
const { COM_BANCO, MOTIVO_SKIP } = require('./_ajudaBanco');

const { SUPABASE_URL } = process.env;
const SUPABASE_ANON_KEY = require('../utils/chavesSupabase').chavePublica();
const GOOGLE = 'https://lh3.googleusercontent.com/a/ACg8ocK-hotfix26=s96-c';

let server;
let baseUrl;
const contas = {}; // rotulo -> { id, token }

/** Foto sintética que passa o olheiro de entrada (400×600, cinzento `tom`). */
const fotoDeTeste = (tom) => sharp({
  create: { width: 400, height: 600, channels: 3, background: { r: tom, g: tom, b: tom } },
}).jpeg({ quality: 92 }).toBuffer();

async function criarConta(rotulo, metadata = {}) {
  const email = `teste-google-${rotulo}-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
  const password = `Fx7!${crypto.randomUUID()}`;
  const { data: criado, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: metadata });
  if (error) throw error;
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: entrou, error: entrarErr } = await anon.auth.signInWithPassword({ email, password });
  if (entrarErr) throw entrarErr;
  contas[rotulo] = { id: criado.user.id, email, token: entrou.session.access_token };
  return contas[rotulo];
}

/** Grava o estado de partida direto no banco (a linha existe: o upsert a cria se o trigger não tiver criado). */
async function gravarEstado(conta, campos) {
  const { error } = await supabase.from('users').upsert({ id: conta.id, email: conta.email, ...campos }, { onConflict: 'id' });
  if (error) throw error;
}

const perfilNoBanco = async (id) => (await supabase.from('users').select('avatar_url, foto_url').eq('id', id).maybeSingle()).data;

function enviar(conta, metodo, rota, campo, buf) {
  const form = new FormData();
  form.append(campo, new Blob([buf], { type: 'image/jpeg' }), 'foto.jpg');
  return fetch(`${baseUrl}${rota}`, { method: metodo, headers: { Authorization: `Bearer ${conta.token}` }, body: form });
}
const subirFoto = (conta, buf) => enviar(conta, 'POST', '/api/me/avatar', 'avatar', buf);
const enviarRecorte = (conta, buf) => enviar(conta, 'PUT', '/api/me/avatar/recorte', 'recorte', buf);
async function meDaApi(conta) {
  const res = await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${conta.token}` } });
  assert.equal(res.status, 200);
  return (await res.json()).user;
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
});

after(async () => {
  if (!COM_BANCO) return;
  try {
    for (const conta of Object.values(contas)) {
      const { data: sobras } = await supabase.storage.from('avatars').list('public', { limit: 100, search: conta.id });
      const alvos = (sobras || []).filter((f) => f.name.startsWith(conta.id)).map((f) => `public/${f.name}`);
      if (alvos.length) await supabase.storage.from('avatars').remove(alvos);
      await supabase.from('user_avatar_historico').delete().eq('user_id', conta.id).then(() => {}, () => {});
      await supabase.auth.admin.deleteUser(conta.id).catch(() => {});
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
});

test('conta com a foto do Google em avatar_url: o upload troca o card (avatar_url = a foto nova)', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const conta = await criarConta('google', { full_name: 'Teste Google', avatar_url: GOOGLE });
  await gravarEstado(conta, { avatar_url: GOOGLE });
  const antes = await perfilNoBanco(conta.id);
  assert.equal(antes.avatar_url, GOOGLE, 'a precondição do relato: avatar_url é a foto do Google');
  assert.equal(antes.foto_url, null, 'e ainda não há foto subida');

  const res = await subirFoto(conta, await fotoDeTeste(90));
  const corpo = await res.json().catch(() => ({}));
  assert.equal(res.status, 200, `upload devia dar 200, deu ${res.status}: ${JSON.stringify(corpo)}`);

  const depois = await perfilNoBanco(conta.id);
  assert.notEqual(depois.avatar_url, GOOGLE, 'o card continuou na foto do Google: é o bug do relato');
  assert.equal(depois.avatar_url, depois.foto_url, 'sem figurinha, avatar_url tem de ser a foto nova');
  assert.match(depois.foto_url, /\/storage\/v1\/object\/public\/avatars\/public\//, 'a foto nova mora no nosso bucket');
  assert.ok(corpo.avatar_url, 'a resposta traz o avatar_url novo');
});

test('a foto do Google não faz o /api/me acusar figurinha (tem_figurinha continua false depois do upload)', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const eu = await meDaApi(contas.google);
  assert.equal(eu.tem_figurinha, false, 'quem nunca gerou figurinha não pode ter tem_figurinha=true');
});

test('a segunda troca de foto também muda o card', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const conta = contas.google;
  const primeira = (await perfilNoBanco(conta.id)).foto_url;
  const res = await subirFoto(conta, await fotoDeTeste(160));
  assert.equal(res.status, 200);
  const depois = await perfilNoBanco(conta.id);
  assert.notEqual(depois.foto_url, primeira, 'a foto tem de ter mudado');
  assert.equal(depois.avatar_url, depois.foto_url, 'e o card acompanha a foto nova de novo');
});

test('PUT /api/me/avatar/recorte: com a foto do Google em avatar_url, o reenquadramento também troca o card', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const conta = contas.google;
  await gravarEstado(conta, { avatar_url: GOOGLE }); // volta ao estado do relato (foto_url já existe)
  const res = await enviarRecorte(conta, await fotoDeTeste(200));
  const corpo = await res.json().catch(() => ({}));
  assert.equal(res.status, 200, `recorte devia dar 200, deu ${res.status}: ${JSON.stringify(corpo)}`);
  const depois = await perfilNoBanco(conta.id);
  assert.notEqual(depois.avatar_url, GOOGLE);
  assert.equal(depois.avatar_url, depois.foto_url, 'o recorte novo vira o card quando não há figurinha');
});

test('conta com figurinha real (arquivo -ai- no nosso bucket): upload e recorte PRESERVAM a figurinha', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const conta = await criarConta('figurinha');
  const figurinha = `${SUPABASE_URL}/storage/v1/object/public/avatars/public/${conta.id}-ai-dark-gold-${Date.now()}.png`;
  await gravarEstado(conta, { avatar_url: figurinha });

  let res = await subirFoto(conta, await fotoDeTeste(60));
  assert.equal(res.status, 200, `upload devia dar 200, deu ${res.status}`);
  let depois = await perfilNoBanco(conta.id);
  assert.equal(depois.avatar_url, figurinha, 'a figurinha tem de continuar no card depois de trocar a foto');
  assert.notEqual(depois.foto_url, depois.avatar_url, 'a foto nova vai para foto_url (fonte da próxima geração)');
  assert.match(depois.foto_url, /\/storage\/v1\/object\/public\/avatars\/public\//);

  res = await enviarRecorte(conta, await fotoDeTeste(110));
  assert.equal(res.status, 200, `recorte devia dar 200, deu ${res.status}`);
  depois = await perfilNoBanco(conta.id);
  assert.equal(depois.avatar_url, figurinha, 'o reenquadramento também preserva a figurinha');

  const eu = await meDaApi(conta);
  assert.equal(eu.tem_figurinha, true, 'o avatar atual é figurinha nossa: tem_figurinha=true');
});

test('fundos pagos (PATCH /api/me): a foto do Google em avatar_url não os destranca; a figurinha nossa, sim', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const pedirFundo = (conta) => fetch(`${baseUrl}/api/me`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${conta.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fundo_figurinha: 'aura' }),
  });
  await gravarEstado(contas.google, { avatar_url: GOOGLE });
  const barrada = await pedirFundo(contas.google);
  assert.equal(barrada.status, 403, 'a foto do Google não é figurinha: os 6 fundos continuam trancados');
  assert.equal((await barrada.json().catch(() => ({}))).code, 'SEM_BRILHANTE');

  const liberada = await pedirFundo(contas.figurinha);
  assert.equal(liberada.status, 200, `quem tem figurinha nossa escolhe qualquer fundo, deu ${liberada.status}`);
});

test('modo "foto" (migração 056): a foto nova vira o card mesmo havendo figurinha', { skip: !COM_BANCO && MOTIVO_SKIP }, async (t) => {
  const conta = contas.figurinha;
  const { error } = await supabase.from('users').update({ card_modo: 'foto' }).eq('id', conta.id);
  if (error) return t.skip(`migração 056 (users.card_modo) ainda não aplicada (${error.message})`);
  const res = await subirFoto(conta, await fotoDeTeste(75));
  assert.equal(res.status, 200);
  const depois = await perfilNoBanco(conta.id);
  assert.equal(depois.avatar_url, depois.foto_url, 'em modo foto o card segue a foto');
});

test('estado torto: histórico de figurinhas mas o avatar atual é a foto do Google → a foto nova vira o card', { skip: !COM_BANCO && MOTIVO_SKIP }, async (t) => {
  const conta = await criarConta('torto', { avatar_url: GOOGLE });
  await gravarEstado(conta, { avatar_url: GOOGLE });
  const { error } = await supabase.from('user_avatar_historico').insert({ user_id: conta.id, kit_id: 'dark-gold', avatar_url: `${SUPABASE_URL}/storage/v1/object/public/avatars/public/${conta.id}-ai-dark-gold-1.png`, custo_cents: null });
  if (error) return t.skip(`migração 057 (user_avatar_historico) ainda não aplicada (${error.message})`);

  const res = await subirFoto(conta, await fotoDeTeste(130));
  assert.equal(res.status, 200);
  const depois = await perfilNoBanco(conta.id);
  assert.notEqual(depois.avatar_url, GOOGLE, 'não se "preserva" o que não é figurinha');
  assert.equal(depois.avatar_url, depois.foto_url);
  assert.equal((await meDaApi(conta)).tem_figurinha, true, 'mas a pessoa tem figurinha no histórico: tem_figurinha continua true');
});
