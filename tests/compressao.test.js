// Velocidade 6A (15-set) — compressão das respostas JSON.
//
// O backend não comprimia nada. /api/feed e /api/inicio são JSON com muito
// texto repetido (nomes de equipa, URLs, chaves) — é onde o gzip ganha mais, e
// de Lisboa para São Paulo cada KB poupado conta.
//
// Trancado aqui:
//   1. JSON acima do limiar sai comprimido
//   2. JSON pequeno NÃO sai comprimido (comprimir 200 bytes gasta mais CPU do
//      que poupa rede)
//   3. image/webp NÃO é tocado (já vem comprimido; passar por gzip só gastava CPU)
//
// Usa um app isolado com a MESMA configuração do server.js em vez do servidor
// inteiro: as rotas de verdade pedem sessão, e o que se quer provar aqui é a
// configuração do middleware.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const compression = require('compression');

// Igual ao server.js.
function appDeTeste() {
  const app = express();
  app.use(compression({ threshold: 1024 }));
  app.get('/grande', (req, res) => {
    res.json({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, nome: 'Vila Olímpica FC', slug: 'vila-olimpica' })) });
  });
  app.get('/pequeno', (req, res) => res.json({ ok: true }));
  app.get('/imagem', (req, res) => {
    res.set('Content-Type', 'image/webp');
    res.end(Buffer.alloc(50 * 1024, 7));
  });
  return app;
}

async function comServidor(fn) {
  const server = appDeTeste().listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('JSON grande sai comprimido', async () => {
  await comServidor(async (base) => {
    const r = await fetch(`${base}/grande`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(r.headers.get('content-encoding'), 'gzip', 'o JSON do feed devia sair comprimido');
  });
});

test('JSON pequeno não é comprimido', async () => {
  await comServidor(async (base) => {
    const r = await fetch(`${base}/pequeno`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(r.headers.get('content-encoding'), null, 'não vale a pena comprimir resposta minúscula');
  });
});

test('image/webp não é comprimido (já vem comprimido)', async () => {
  await comServidor(async (base) => {
    const r = await fetch(`${base}/imagem`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(r.headers.get('content-encoding'), null, 'passar WebP por gzip só gastaria CPU');
  });
});

test('sem Accept-Encoding o cliente recebe texto simples', async () => {
  await comServidor(async (base) => {
    const r = await fetch(`${base}/grande`, { headers: { 'Accept-Encoding': 'identity' } });
    assert.equal(r.headers.get('content-encoding'), null);
    const body = await r.json();
    assert.equal(body.items.length, 200, 'o conteúdo tem de chegar inteiro');
  });
});
