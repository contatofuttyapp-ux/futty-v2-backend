// Futty v2.0 — RODADA 19 (23-set): "Ajustar enquadramento" (recorte a partir
// da original, com e sem ela) + "Minhas figurinhas" (teto de 6). Sem IA —
// nenhum destes testes chama a fal (custaria dinheiro de verdade); o teto de
// histórico é testado chamando arquivarFigurinhaAntiga() direto, o mesmo
// helper que POST /api/me/avatar/ai chama depois de uma geração de verdade.
//
// Uso: npm test  (ou: node --test tests/avatar-recorte-historico.test.js)
require('dotenv').config();
const crypto = require('node:crypto');
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const { app, supabase } = require('../server');
const authRouter = require('../routes/auth');

const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;

let server;
let baseUrl;

/** Foto sintética que passa o olheiro de entrada: WxH cinzento `tom`. */
const fotoDeTeste = (tom, lado = 400) => sharp({
  create: { width: lado, height: Math.round(lado * 1.5), channels: 3, background: { r: tom, g: tom, b: tom } },
}).jpeg({ quality: 92 }).toBuffer();

async function novoUsuario(prefixo) {
  const email = `teste-${prefixo}-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
  const password = `Fx7!${crypto.randomUUID()}`;
  const { data: criado, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: entrou, error: entrarErr } = await anon.auth.signInWithPassword({ email, password });
  if (entrarErr) throw entrarErr;
  return { userId: criado.user.id, accessToken: entrou.session.access_token };
}

/**
 * users.foto_original_url só existe com a migração 057 aplicada — sem ela o
 * PostgREST recusa a query INTEIRA (mesmo padrão de card_modo/figurinha_status
 * nesta mesma pasta de testes). `semMigracao: true` é o sinal para os testes
 * pularem em vez de falharem por um passo que é do Pedro.
 */
async function lerPerfilComOriginal(userId) {
  const { data, error } = await supabase.from('users').select('foto_url, foto_original_url, avatar_url, foto_hash').eq('id', userId).maybeSingle();
  if (error) return { data: null, semMigracao: /foto_original_url/i.test(error.message || '') };
  return { data, semMigracao: false };
}

async function limparConta(userId) {
  if (!userId) return;
  try {
    const { data: sobras } = await supabase.storage.from('avatars').list('public', { limit: 200, search: userId });
    const alvos = (sobras || []).filter((f) => f.name.startsWith(userId)).map((f) => `public/${f.name}`);
    if (alvos.length) await supabase.storage.from('avatars').remove(alvos);
  } catch { /* limpeza best-effort */ }
  await supabase.from('user_avatar_historico').delete().eq('user_id', userId).then(() => {}, () => {});
  await supabase.from('user_avatar_slots').delete().eq('user_id', userId).then(() => {}, () => {});
  await supabase.auth.admin.deleteUser(userId).catch(() => {});
}

before(async () => {
  if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_ANON_KEY em falta no .env — precisa dela para assinar sessão de teste.');
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

describe('POST /api/me/avatar com "original" — RODADA 19', () => {
  let userId;
  let accessToken;

  before(async () => { ({ userId, accessToken } = await novoUsuario('original')); });
  after(async () => limparConta(userId));

  test('grava foto_original_url num objeto separado do recorte (foto_url)', async (t) => {
    const form = new FormData();
    form.append('avatar', new Blob([await fotoDeTeste(80)], { type: 'image/jpeg' }), 'recorte.jpg');
    form.append('original', new Blob([await fotoDeTeste(80, 900)], { type: 'image/jpeg' }), 'original.jpg');
    const res = await fetch(`${baseUrl}/api/me/avatar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });
    const corpo = await res.json().catch(() => ({}));
    assert.equal(res.status, 200, `upload com original devia dar 200, deu ${res.status}: ${JSON.stringify(corpo)}`);

    const { data, semMigracao } = await lerPerfilComOriginal(userId);
    if (semMigracao) return t.skip('migração 057 (users.foto_original_url) ainda não aplicada — ver db/migrations/057_foto_original_historico.sql');
    assert.ok(data.foto_original_url, 'foto_original_url tem de estar gravado');
    assert.notEqual(data.foto_original_url, data.foto_url, 'a original e o recorte têm de ser objetos DIFERENTES');
    assert.equal(data.avatar_url, data.foto_url, 'sem figurinha ainda, avatar_url = foto_url = o recorte');
  });
});

describe('PUT /api/me/avatar/recorte — RODADA 19', () => {
  let userId;
  let accessToken;

  before(async () => { ({ userId, accessToken } = await novoUsuario('recorte')); });
  after(async () => limparConta(userId));

  function putRecorte(buf) {
    const form = new FormData();
    form.append('recorte', new Blob([buf], { type: 'image/jpeg' }), 'novo-recorte.jpg');
    return fetch(`${baseUrl}/api/me/avatar/recorte`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });
  }

  test('regrava só o recorte — a original sobrevive e o hash muda', async (t) => {
    // Prepara: upload normal COM original.
    const form = new FormData();
    form.append('avatar', new Blob([await fotoDeTeste(100)], { type: 'image/jpeg' }), 'recorte.jpg');
    form.append('original', new Blob([await fotoDeTeste(100, 900)], { type: 'image/jpeg' }), 'original.jpg');
    const r0 = await fetch(`${baseUrl}/api/me/avatar`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body: form });
    assert.equal(r0.status, 200, 'preparo (upload com original) falhou');
    const { data: antes, semMigracao } = await lerPerfilComOriginal(userId);
    if (semMigracao) return t.skip('migração 057 (users.foto_original_url) ainda não aplicada — ver db/migrations/057_foto_original_historico.sql');
    assert.ok(antes.foto_original_url, 'preciso da original gravada para este teste fazer sentido');

    const res = await putRecorte(await fotoDeTeste(140));
    const corpo = await res.json().catch(() => ({}));
    assert.equal(res.status, 200, `PUT /recorte devia dar 200, deu ${res.status}: ${JSON.stringify(corpo)}`);

    const { data: depois } = await lerPerfilComOriginal(userId);
    assert.notEqual(depois.foto_url, antes.foto_url, 'foto_url (o recorte) tem de virar um objeto NOVO');
    assert.equal(depois.foto_original_url, antes.foto_original_url, 'foto_original_url NUNCA muda num reenquadramento');
    assert.notEqual(depois.foto_hash, antes.foto_hash, 'a trava de hash passa a ser a do recorte NOVO');
  });

  test('funciona sem original nenhuma (conta antiga / legado) — não erra, só reenquadra o recorte atual', async () => {
    const { userId: uid2, accessToken: tok2 } = await novoUsuario('recorte-legado');
    try {
      // Upload SEM campo "original" — como o Onboarding faz hoje. O PONTO deste
      // teste (PUT /recorte funciona sem original nenhuma gravada) vale COM ou
      // SEM a migração 057 — só a checagem "ficou vazia" depende dela.
      const form = new FormData();
      form.append('avatar', new Blob([await fotoDeTeste(60)], { type: 'image/jpeg' }), 'recorte.jpg');
      const r0 = await fetch(`${baseUrl}/api/me/avatar`, { method: 'POST', headers: { Authorization: `Bearer ${tok2}` }, body: form });
      assert.equal(r0.status, 200, 'preparo (upload sem original) falhou');
      const { data: perfil, semMigracao } = await lerPerfilComOriginal(uid2);
      if (!semMigracao) assert.equal(perfil.foto_original_url ?? null, null, 'sem "original" no upload, a coluna tem de ficar vazia');

      const form2 = new FormData();
      form2.append('recorte', new Blob([await fotoDeTeste(160)], { type: 'image/jpeg' }), 'ajustado.jpg');
      const res = await fetch(`${baseUrl}/api/me/avatar/recorte`, { method: 'PUT', headers: { Authorization: `Bearer ${tok2}` }, body: form2 });
      const corpo = await res.json().catch(() => ({}));
      assert.equal(res.status, 200, `PUT /recorte sem original devia dar 200 (fail-safe), deu ${res.status}: ${JSON.stringify(corpo)}`);
    } finally {
      await limparConta(uid2);
    }
  });
});

describe('user_avatar_historico — teto de 6 (arquivarFigurinhaAntiga)', () => {
  let userId;

  before(async () => { ({ userId } = await novoUsuario('historico')); });
  after(async () => limparConta(userId));

  test('a 7ª arquivada apaga a mais antiga (linha + arquivo no Storage)', async (t) => {
    if (typeof authRouter.arquivarFigurinhaAntiga !== 'function') {
      return t.skip('arquivarFigurinhaAntiga não exportado — rodada 19 não aplicada nesta base?');
    }
    // 6 figurinhas "antigas" já arquivadas, uma por minuto (ordem determinística).
    const caminhos = [];
    for (let i = 1; i <= 6; i += 1) {
      const caminho = `public/${userId}-ai-dark-gold-hist${i}.png`;
      caminhos.push(caminho);
      // eslint-disable-next-line no-await-in-loop
      const { error: upErr } = await supabase.storage.from('avatars').upload(caminho, await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: i * 10, g: 0, b: 0 } } }).png().toBuffer(), { contentType: 'image/png' });
      if (upErr) throw new Error(`upload hist${i}: ${upErr.message}`);
      const url = `${SUPABASE_URL}/storage/v1/object/public/avatars/${caminho}`;
      const criadoEm = new Date(Date.now() - (7 - i) * 60000).toISOString(); // hist1 = mais antiga
      // eslint-disable-next-line no-await-in-loop
      const { error: insErr } = await supabase.from('user_avatar_historico').insert({ user_id: userId, kit_id: 'dark-gold', avatar_url: url, criado_em: criadoEm });
      if (insErr) return t.skip(`user_avatar_historico indisponível (migração 057 aplicada?): ${insErr.message}`);
    }

    // A 7ª — via o MESMO helper que POST /api/me/avatar/ai chama ao regenerar.
    const caminho7 = `public/${userId}-ai-dark-gold-hist7.png`;
    await supabase.storage.from('avatars').upload(caminho7, await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 70, g: 0, b: 0 } } }).png().toBuffer(), { contentType: 'image/png' });
    const url7 = `${SUPABASE_URL}/storage/v1/object/public/avatars/${caminho7}`;
    await authRouter.arquivarFigurinhaAntiga(userId, 'dark-gold', url7);

    const { data: linhas, error } = await supabase.from('user_avatar_historico').select('avatar_url').eq('user_id', userId);
    if (error) throw new Error(error.message);
    assert.equal(linhas.length, 6, `teto tem de manter exatamente 6 (achei ${linhas.length})`);
    const urls = linhas.map((l) => l.avatar_url);
    assert.ok(urls.includes(url7), 'a recém-arquivada (7ª) tem de estar dentro');
    assert.ok(!urls.some((u) => u.includes('hist1.png')), 'a mais antiga (hist1) tem de ter saído da tabela');

    const { data: existeAinda } = await supabase.storage.from('avatars').list('public', { search: `${userId}-ai-dark-gold-hist1` });
    assert.equal((existeAinda || []).length, 0, 'o ARQUIVO da mais antiga também tem de ter sido apagado do Storage');
  });
});
