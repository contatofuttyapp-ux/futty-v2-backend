// Rodada 28 (bloco A) — `figurinha_ativa`: o card mostra AGORA uma figurinha nossa?
//
// As telas decidiam "foto × figurinha" por foto_url ≠ avatar_url — a regra que o Hotfix 26 aposentou
// no motor. Com a foto do Google em avatar_url, a foto da pessoa entrava no card como se fosse
// figurinha: seletor de fundos, zoom abaixo da moldura, faixas vazias (o que o dono viu na conta
// backup). Agora o motor diz, pela regra única do nome do arquivo (utils/figurinhaRegra.js):
//   1. conta com foto → false no /api/me e na resposta do upload;
//   2. avatar_url com a foto do Google (≠ foto_url) → false — onde a regra antiga dizia true;
//   3. avatar_url com um arquivo -ai- do nosso bucket → true;
//   4. "Mostrar minha foto" (PUT /api/me/avatar/modo) → false na resposta.
require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const { app, supabase } = require('../server');

const { SUPABASE_URL } = process.env;
const SUPABASE_ANON_KEY = require('../utils/chavesSupabase').chavePublica();

let server;
let baseUrl;
let userId;
let token;

before(async () => {
  if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_PUBLISHABLE_KEY (ou a antiga SUPABASE_ANON_KEY) em falta no .env.');
  server = app.listen(0);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const email = `teste-figativa-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
  const password = `Fx7!${crypto.randomUUID()}`;
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { onboarding_completo: true } });
  if (error) throw error;
  userId = data.user.id;
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: sessao, error: erroSessao } = await anon.auth.signInWithPassword({ email, password });
  if (erroSessao) throw erroSessao;
  token = sessao.session.access_token;
});

after(async () => {
  try {
    if (userId) {
      const { data: sobras } = await supabase.storage.from('avatars').list('public', { limit: 100, search: userId });
      const alvos = (sobras || []).filter((f) => f.name.startsWith(userId)).map((f) => `public/${f.name}`);
      if (alvos.length) await supabase.storage.from('avatars').remove(alvos);
      await supabase.auth.admin.deleteUser(userId).catch(() => {});
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
});

const me = async () => (await (await fetch(`${baseUrl}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).json()).user;

test('foto: false no upload e no /api/me', async () => {
  const foto = await sharp({ create: { width: 400, height: 600, channels: 3, background: { r: 120, g: 110, b: 100 } } }).jpeg({ quality: 90 }).toBuffer();
  const form = new FormData();
  form.append('avatar', new Blob([foto], { type: 'image/jpeg' }), 'foto.jpg');
  const r = await fetch(`${baseUrl}/api/me/avatar`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const corpo = await r.json();
  assert.equal(r.status, 200, JSON.stringify(corpo));
  assert.equal(corpo.figurinha_ativa, false);
  assert.equal((await me()).figurinha_ativa, false);
});

test('foto do Google em avatar_url (≠ foto_url): false — a regra antiga dizia true', async () => {
  await supabase.from('users').update({ avatar_url: 'https://lh3.googleusercontent.com/a/foto-do-google=s96-c' }).eq('id', userId);
  const u = await me();
  assert.notEqual(u.avatar_url, u.foto_url, 'o cenário precisa de avatar_url ≠ foto_url');
  assert.equal(u.figurinha_ativa, false, 'a foto do Google virou "figurinha" de novo');
});

test('arquivo -ai- do nosso bucket em avatar_url: true', async () => {
  const caminho = `${SUPABASE_URL}/storage/v1/object/public/avatars/public/${userId}-ai-dark-gold-1.png?v=1`;
  await supabase.from('users').update({ avatar_url: caminho }).eq('id', userId);
  assert.equal((await me()).figurinha_ativa, true);
});

test('"Mostrar minha foto" (PUT /api/me/avatar/modo): false na resposta', async () => {
  const r = await fetch(`${baseUrl}/api/me/avatar/modo`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ modo: 'foto' }),
  });
  const corpo = await r.json();
  assert.equal(r.status, 200, JSON.stringify(corpo));
  assert.equal(corpo.figurinha_ativa, false);
  assert.equal((await me()).figurinha_ativa, false);
});
