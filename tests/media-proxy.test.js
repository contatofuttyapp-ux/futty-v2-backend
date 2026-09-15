// Velocidade 6A (15-set) — o proxy de imagem serve os BYTES, em WebP, cacheados.
//
// Antes era um 302 para o Supabase: segunda ligação TLS e o PNG original inteiro
// (390 KB, 1,4-1,6 s de Lisboa por imagem). Este teste tranca o que interessa:
//   1. o degrau de largura é respeitado (e um w esquisito cai no mais próximo)
//   2. a 2ª leitura da mesma imagem vem do LRU (X-Futty-Cache: hit)
//   3. If-None-Match devolve 304 sem trabalho nenhum
//   4. a figurinha em w=128 pesa MUITO menos que os 390 KB do PNG
//   5. Cache-Control é imutável e de um ano
//
// Precisa de uma imagem real no bucket privado `avatars`. Se não houver (CI sem
// credenciais, bucket vazio), os testes que dependem dela são SALTADOS em vez de
// falharem — o que se está a testar é o proxy, não a existência de dados.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');
const { supabase } = require('../utils/db');
const { assinarToken } = require('../utils/mediaToken');

let server;
let baseUrl;
let amostra = null; // { path, v }

before(async () => {
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Procura uma figurinha real no bucket para exercitar o caminho completo.
  try {
    const { data } = await supabase.storage.from('avatars').list('public', { limit: 50 });
    const png = (data || []).find((f) => /\.(png|jpe?g|webp)$/i.test(f.name));
    if (png) amostra = { path: `public/${png.name}`, v: '1' };
  } catch {
    amostra = null;
  }
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

const urlDe = (path, v, w) => {
  const t = assinarToken('avatars', path, { v });
  return `${baseUrl}/api/media/${t}${w ? `?w=${w}` : ''}`;
};

test('token inválido → 403, sem tocar no Storage', async () => {
  const r = await fetch(`${baseUrl}/api/media/lixo.assinaturafalsa`);
  assert.equal(r.status, 403);
});

test('serve WebP no degrau pedido e guarda no cache (miss → hit)', async (t) => {
  if (!amostra) return t.skip('sem imagem no bucket avatars/public');

  // `v` único por execução: garante chave de cache limpa mesmo se o teste correr 2x.
  const v = `t${Date.now()}`;
  const url = urlDe(amostra.path, v, 128);

  const um = await fetch(url);
  assert.equal(um.status, 200);
  assert.equal(um.headers.get('content-type'), 'image/webp');
  assert.equal(um.headers.get('x-futty-cache'), 'miss');
  assert.match(um.headers.get('cache-control'), /public/);
  assert.match(um.headers.get('cache-control'), /immutable/);
  assert.match(um.headers.get('cache-control'), /max-age=31536000/);
  assert.ok(um.headers.get('etag'), 'sem ETag não há 304 possível');

  const dois = await fetch(url);
  assert.equal(dois.status, 200);
  assert.equal(dois.headers.get('x-futty-cache'), 'hit', 'a 2ª leitura não veio do cache');
  assert.equal(dois.headers.get('etag'), um.headers.get('etag'));
});

test('If-None-Match devolve 304 vazio', async (t) => {
  if (!amostra) return t.skip('sem imagem no bucket avatars/public');
  const url = urlDe(amostra.path, `t${Date.now()}`, 256);
  const primeiro = await fetch(url);
  const etag = primeiro.headers.get('etag');

  const r = await fetch(url, { headers: { 'If-None-Match': etag } });
  assert.equal(r.status, 304);
  const corpo = await r.arrayBuffer();
  assert.equal(corpo.byteLength, 0, '304 não pode trazer corpo');
});

test('w esquisito cai no degrau mais próximo (200 → 256)', async (t) => {
  if (!amostra) return t.skip('sem imagem no bucket avatars/public');
  const v = `t${Date.now()}`;
  const a = await fetch(urlDe(amostra.path, v, 200));
  const b = await fetch(urlDe(amostra.path, v, 256));
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  // Mesmo degrau = mesma chave de cache = mesmo ETag.
  assert.equal(a.headers.get('etag'), b.headers.get('etag'), 'w=200 devia cair no degrau 256');
});

test('a figurinha em w=128 pesa muito menos que os 390 KB do PNG', async (t) => {
  if (!amostra) return t.skip('sem imagem no bucket avatars/public');
  const r = await fetch(urlDe(amostra.path, `t${Date.now()}`, 128));
  const bytes = (await r.arrayBuffer()).byteLength;
  assert.ok(bytes <= 15 * 1024, `w=128 deu ${(bytes / 1024).toFixed(1)} KB, era para ficar ≤ 15 KB`);
});

test('degraus maiores pesam mais que degraus menores', async (t) => {
  if (!amostra) return t.skip('sem imagem no bucket avatars/public');
  const v = `t${Date.now()}`;
  const p128 = (await (await fetch(urlDe(amostra.path, v, 128))).arrayBuffer()).byteLength;
  const p512 = (await (await fetch(urlDe(amostra.path, v, 512))).arrayBuffer()).byteLength;
  assert.ok(p512 > p128, `w=512 (${p512}) devia pesar mais que w=128 (${p128})`);
});
