// Futty v2.0 — PUT /api/me/avatar/modo (Rodada 18): "Mostrar minha foto" /
// "Mostrar minha figurinha".
//
// Hoje, quando existe figurinha (IA), users.avatar_url aponta sempre para
// ela e a pessoa não consegue mostrar a foto real no card. Esta rota deixa
// escolher: 'foto' põe avatar_url = foto_url (a figurinha continua no slot,
// nada é apagado); 'figurinha' repõe o slot do kit ativo (ou outro já
// gerado). Só quem tem pelo menos um slot pode escolher 'figurinha'.
//
// A escolha fica em users.card_modo (migração 056) para sobreviver a uma
// figurinha gerada DEPOIS — sem isso, a próxima troca de foto voltaria a
// "preservar o avatar de IA" (o comportamento antigo, ainda o fail-safe
// correto enquanto a coluna não existir). Este arquivo cobre os dois modos,
// o 400 digno sem slot, e os dois lados da 056 (aplicada ou não) — não pode
// ficar vermelho por um passo que é do Pedro (mesmo critério dos outros
// testes de migração nesta pasta).
//
// Uso: npm test  (ou: node --test tests/avatar-modo.test.js)
require('dotenv').config();
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const { app, supabase } = require('../server');

const { SUPABASE_URL } = process.env;
const SUPABASE_ANON_KEY = require('../utils/chavesSupabase').chavePublica();
const KIT = 'dark-gold'; // grátis, sempre ativo — nenhum gate de plano no caminho

let server;
let baseUrl;
let accessToken;
let testUserId;

/** Foto sintética que passa o olheiro de entrada: 400×400, cinzento `tom`. */
const fotoDeTeste = (tom) => sharp({
  create: { width: 400, height: 400, channels: 3, background: { r: tom, g: tom, b: tom } },
}).jpeg({ quality: 92 }).toBuffer();

function subirFoto(buf) {
  const form = new FormData();
  form.append('avatar', new Blob([buf], { type: 'image/jpeg' }), 'teste.jpg');
  return fetch(`${baseUrl}/api/me/avatar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
}

function pedirModo(modo) {
  return fetch(`${baseUrl}/api/me/avatar/modo`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ modo }),
  });
}

before(async () => {
  if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_PUBLISHABLE_KEY (ou a antiga SUPABASE_ANON_KEY) em falta no .env — precisa dela para assinar sessão de teste.');

  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const email = `teste-modo-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
  const password = `Fx7!${crypto.randomUUID()}`;
  const { data: criado, error: criarErr } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (criarErr) throw criarErr;
  testUserId = criado.user.id;

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: entrou, error: entrarErr } = await anon.auth.signInWithPassword({ email, password });
  if (entrarErr) throw entrarErr;
  accessToken = entrou.session.access_token;

  // A rota exige uma foto (não dá para "mostrar minha foto" sem uma).
  const res = await subirFoto(await fotoDeTeste(120));
  if (res.status !== 200) throw new Error(`upload da foto de preparo falhou: ${res.status}`);
});

after(async () => {
  if (testUserId) {
    try {
      const { data: sobras } = await supabase.storage.from('avatars').list('public', { limit: 100, search: testUserId });
      const alvos = (sobras || []).filter((f) => f.name.startsWith(testUserId)).map((f) => `public/${f.name}`);
      if (alvos.length) await supabase.storage.from('avatars').remove(alvos);
    } catch {
      /* limpeza best-effort — um ficheiro de teste a mais não pode pintar o teste de vermelho */
    }
    await supabase.from('user_avatar_slots').delete().eq('user_id', testUserId).then(() => {}, () => {});
    await supabase.auth.admin.deleteUser(testUserId).catch(() => {});
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('modo fora de "foto"/"figurinha" -> 400 MODO_INVALIDO', async () => {
  const res = await pedirModo('brilhante');
  const corpo = await res.json().catch(() => ({}));
  assert.equal(res.status, 400, `devia recusar com 400, deu ${res.status}: ${JSON.stringify(corpo)}`);
  assert.equal(corpo.code, 'MODO_INVALIDO');
});

test('sem slot nenhum, modo "figurinha" -> 400 digno (SEM_SLOT)', async () => {
  const res = await pedirModo('figurinha');
  const corpo = await res.json().catch(() => ({}));
  assert.equal(res.status, 400, `devia recusar com 400, deu ${res.status}: ${JSON.stringify(corpo)}`);
  assert.equal(corpo.code, 'SEM_SLOT');
  assert.match(corpo.error || '', /figurinha/i, 'a mensagem tem de ser digna e falar de figurinha, não um erro técnico');
});

test('com um slot: "figurinha" veste o slot, "foto" volta pra própria foto, e o slot sobrevive', async () => {
  const { data: perfilAntes } = await supabase.from('users').select('foto_url').eq('id', testUserId).maybeSingle();
  const fotoUrl = perfilAntes?.foto_url;
  assert.ok(fotoUrl, 'preciso da foto de preparo já gravada em users.foto_url');

  const avatarFigurinha = 'https://exemplo.invalid/avatar-modo-teste.png';
  const { error: erroSlot } = await supabase.from('user_avatar_slots').upsert(
    { user_id: testUserId, kit_id: KIT, avatar_url: avatarFigurinha },
    { onConflict: 'user_id,kit_id' },
  );
  if (erroSlot) throw erroSlot;
  const { error: erroKit } = await supabase.from('users').update({ kit_ativo: KIT }).eq('id', testUserId);
  if (erroKit) throw erroKit;

  const resFig = await pedirModo('figurinha');
  const corpoFig = await resFig.json().catch(() => ({}));
  assert.equal(resFig.status, 200, `modo figurinha devia dar 200, deu ${resFig.status}: ${JSON.stringify(corpoFig)}`);
  assert.equal(corpoFig.avatar_url, avatarFigurinha, 'avatar_url devia virar o slot do kit ativo');

  const { data: depoisFig } = await supabase.from('users').select('avatar_url').eq('id', testUserId).maybeSingle();
  assert.equal(depoisFig.avatar_url, avatarFigurinha, 'o banco tem de refletir o slot');

  const resFoto = await pedirModo('foto');
  const corpoFoto = await resFoto.json().catch(() => ({}));
  assert.equal(resFoto.status, 200, `modo foto devia dar 200, deu ${resFoto.status}: ${JSON.stringify(corpoFoto)}`);
  assert.ok(corpoFoto.avatar_url, 'a resposta tem de trazer um avatar_url');

  // Comparação pelo BANCO, não pela resposta: o middleware mediaUrls troca o
  // URL do Storage por um URL do proxy (/api/media/<token>) antes de sair da
  // rota (mesma nota em avatar-nome-por-versao.test.js) — comparar a resposta
  // com o URL cru do Storage dá falso negativo.
  const { data: depoisFoto } = await supabase.from('users').select('avatar_url, foto_url').eq('id', testUserId).maybeSingle();
  assert.equal(depoisFoto.avatar_url, fotoUrl, 'avatar_url devia voltar a ser a própria foto');
  assert.equal(depoisFoto.avatar_url, depoisFoto.foto_url, 'no modo foto, avatar_url e foto_url têm de bater');

  // A troca de modo NUNCA apaga nada — a figurinha continua no slot.
  const { data: slotDepois } = await supabase.from('user_avatar_slots').select('avatar_url').eq('user_id', testUserId).eq('kit_id', KIT).maybeSingle();
  assert.equal(slotDepois?.avatar_url, avatarFigurinha, 'o slot tem de sobreviver à troca para modo foto');
});

test('card_modo grava a escolha (ou pula se a migração 056 ainda não tiver corrido)', async (t) => {
  const { data, error } = await supabase.from('users').select('card_modo').eq('id', testUserId).maybeSingle();
  if (error) {
    return t.skip(`migração 056 (users.card_modo) ainda não aplicada — ver db/migrations/056_card_modo.sql (${error.message})`);
  }
  // O teste anterior terminou em modo 'foto' — é essa a última escolha.
  assert.equal(data?.card_modo, 'foto', 'a coluna existe: a última troca (modo foto) tem de ter ficado gravada');
});

test('modo "foto" sobrevive a uma figurinha gerada depois — ou cai no fail-safe sem a 056', async () => {
  // Simula o que POST /api/me/avatar/ai faria: uma figurinha nova põe
  // avatar_url a apontar para ela de novo, mesmo com a pessoa em modo 'foto'
  // (gerar não é escolher o que mostrar — são caminhos diferentes). A partir
  // daqui o avatar atual é uma figurinha NOSSA outra vez (arquivo -ai- no
  // bucket avatars, como o de POST /api/me/avatar/ai), exatamente como se a
  // pessoa tivesse acabado de gerar sem ter mexido no interruptor. Hotfix 26:
  // tem de ser um arquivo nosso; um URL qualquer de fora já não conta como
  // figurinha (a foto do Google não pode ser "preservada").
  const figurinhaSimulada = `${SUPABASE_URL}/storage/v1/object/public/avatars/public/${testUserId}-ai-${KIT}-1.png`;
  const { data: antes } = await supabase.from('users').select('foto_url, card_modo').eq('id', testUserId).maybeSingle();
  const { error: erroSimula } = await supabase.from('users').update({ avatar_url: figurinhaSimulada }).eq('id', testUserId);
  if (erroSimula) throw erroSimula;

  const novaFoto = await fotoDeTeste(200);
  const res = await subirFoto(novaFoto);
  const corpo = await res.json().catch(() => ({}));
  assert.equal(res.status, 200, `upload devia dar 200, deu ${res.status}: ${JSON.stringify(corpo)}`);

  if (antes?.card_modo === 'foto') {
    // Migração aplicada: a escolha persistida vale MESMO com avatar_url tendo
    // se afastado da foto nesse meio-tempo — é o problema real que a 056 resolve.
    assert.equal(corpo.avatar_url, corpo.foto_url, 'com card_modo="foto" gravado, a troca de foto tem de atualizar o card mesmo tendo uma figurinha no meio do caminho');
  } else {
    // Sem a coluna (ou sem ela ter persistido), fail-safe = comportamento de
    // sempre: com uma figurinha nossa no card no momento do upload, preserva.
    // Compara pelo BANCO: a resposta passa pelo middleware mediaUrls, que troca o
    // URL do Storage pelo do proxy.
    const { data: depois } = await supabase.from('users').select('avatar_url').eq('id', testUserId).maybeSingle();
    assert.equal(depois.avatar_url, figurinhaSimulada, 'sem card_modo persistido, o fail-safe é preservar o avatar de IA (comportamento antigo)');
  }
});
