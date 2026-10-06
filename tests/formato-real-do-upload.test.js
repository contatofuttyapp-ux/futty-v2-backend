// Futty v2.0 — Arrumação 0, bloco 3 (B1): o upload confere o formato REAL dos bytes, não só o Content-Type (sem banco, sem rede).
//
// O pentest do ZAP (B1) viu que o avatar só olhava o Content-Type que o cliente declara e que o sharp descobre o formato
// pelos bytes: um SVG disfarçado de PNG chegaria à librsvg (a do CVE do sharp < 0.35.5). Agora, nos três uploads de imagem
// (avatar e recorte em routes/auth.js, escudo em routes/teams.js, Resenha em routes/feed.js), o formato real tem de estar
// na lista do upload; SVG e qualquer outro formato levam 400 "Esse arquivo não é uma imagem aceita." ANTES de o NSFW, o
// olheiro, o sharp ou o Storage verem os bytes. Aqui se prova:
//   · a conferência pura (formatoReal / exigirFormatoReal), com imagens e SVGs gerados na hora (nenhum binário no repo);
//   · cada upload: SVG com Content-Type de PNG → 400 e NADA vai ao Storage; PNG de verdade → passa da conferência e chega ao Storage;
//   · o que continua como era: JPEG de verdade com cara de PNG (os dois estão na lista), vídeo da Resenha (não passa pelo sharp);
//   · o sharp instalado é o que fecha a CVE (≥ 0.35.5) e não lê mais SVG nenhum.
//
// Uso: npm test  (ou: node --test tests/formato-real-do-upload.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const sharp = require('sharp');
const { carregar } = require('./_rotas');
const { tratadorDeErros } = require('../middleware/erros');
const { formatoReal, exigirFormatoReal, MSG_FORMATO } = require('../utils/imagemReal');

const MSG = 'Esse arquivo não é uma imagem aceita.';
const DONO = '33333333-3333-3333-3333-333333333333';
const TIME = '11111111-1111-1111-1111-111111111111';
const FOTO = { width: 300, height: 400, channels: 3, background: { r: 120, g: 130, b: 140 } };

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="red"/></svg>';
const SVG_BUF = Buffer.from(SVG);
const SVG_COM_BOM = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n  ${SVG}`)]);

async function imagens() {
  return {
    png: await sharp({ create: FOTO }).png().toBuffer(),
    jpeg: await sharp({ create: FOTO }).jpeg().toBuffer(),
    webp: await sharp({ create: FOTO }).webp().toBuffer(),
    gif: await sharp({ create: FOTO }).gif().toBuffer(),
    tiff: await sharp({ create: FOTO }).tiff().toBuffer(),
    avif: await sharp({ create: { ...FOTO, width: 64, height: 64 } }).avif().toBuffer(),
  };
}

// ─── a conferência pura ───────────────────────────────────────────────────────
test('formatoReal: pelos bytes, não pelo nome — jpeg, png, webp, gif, tiff, heif; SVG e HTML viram "marcacao"; lixo e vazio, null', async () => {
  const im = await imagens();
  assert.equal(await formatoReal(im.png), 'png');
  assert.equal(await formatoReal(im.jpeg), 'jpeg');
  assert.equal(await formatoReal(im.webp), 'webp');
  assert.equal(await formatoReal(im.gif), 'gif');
  assert.equal(await formatoReal(im.tiff), 'tiff');
  assert.equal(await formatoReal(im.avif), 'heif');
  assert.equal(await formatoReal(SVG_BUF), 'marcacao');
  assert.equal(await formatoReal(SVG_COM_BOM), 'marcacao', 'com BOM, prólogo XML e espaço na frente');
  assert.equal(await formatoReal(Buffer.from('\n\n<!DOCTYPE html><html><script>alert(1)</script></html>')), 'marcacao');
  assert.equal(await formatoReal(Buffer.from('oi, isto é só texto')), null);
  assert.equal(await formatoReal(Buffer.from([1, 2, 3, 4])), null);
  assert.equal(await formatoReal(Buffer.alloc(0)), null);
  assert.equal(await formatoReal(null), null);
});

test('o sharp não lê mais SVG de jeito nenhum (loader bloqueado), mesmo se a marcação escapasse do olhar nos primeiros bytes', async () => {
  const disfarcado = Buffer.concat([Buffer.from(' '.repeat(600)), SVG_BUF]); // a marcação só começa depois dos 512 bytes olhados
  // A prova de que o buffer É um SVG para o libvips: sem o bloqueio ele o lê.
  sharp.unblock({ operation: ['VipsForeignLoadSvg'] });
  try {
    assert.equal((await sharp(disfarcado).metadata()).format, 'svg', 'sem o bloqueio, o libvips lê este buffer como SVG');
  } finally {
    sharp.block({ operation: ['VipsForeignLoadSvg'] });
  }
  await assert.rejects(sharp(disfarcado).metadata(), /unsupported image format/);
  await assert.rejects(sharp(disfarcado).resize(50).png().toBuffer(), /unsupported image format/);
  assert.equal(await formatoReal(disfarcado), null, 'nada o lê: segue para a decodificação de cada upload, que responde 400');
});

test('exigirFormatoReal: só passa o que está na lista; o resto é 400 com a frase da casa; o que nada lê passa (a decodificação seguinte responde)', async () => {
  const im = await imagens();
  const lista = ['image/jpeg', 'image/png', 'image/webp'];
  for (const ok of [im.png, im.jpeg, im.webp]) await exigirFormatoReal(ok, lista);
  for (const fora of [SVG_BUF, SVG_COM_BOM, im.gif, im.tiff, im.avif]) {
    await assert.rejects(exigirFormatoReal(fora, lista), (e) => e.status === 400 && e.message === MSG && !e.code);
  }
  await exigirFormatoReal(im.gif, [...lista, 'image/gif']); // a lista da Resenha aceita GIF
  await exigirFormatoReal(Buffer.from('lixo'), lista);
  await exigirFormatoReal(Buffer.alloc(0), lista);
  assert.equal(MSG_FORMATO, MSG);
});

test('sharp ≥ 0.35.5 (a versão que fecha a CVE da librsvg) e a librsvg que vem com ela', () => {
  const [maior, menor, patch] = sharp.versions.sharp.split('.').map(Number);
  assert.ok(maior > 0 || menor > 35 || (menor === 35 && patch >= 5), `sharp ${sharp.versions.sharp} é anterior à 0.35.5`);
  const instalado = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'sharp', 'package.json'), 'utf8')).version;
  assert.equal(instalado, sharp.versions.sharp);
  const declarado = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).dependencies.sharp;
  assert.match(declarado, /^\^0\.35\.([5-9]|\d{2,})/, `package.json declara "${declarado}": uma instalação limpa não pode cair numa versão com a CVE`);
});

// ─── os três uploads, pelas rotas de verdade ──────────────────────────────────
/** As rotas de verdade com o banco falso por baixo, e um Storage falso que só anota o que lhe mandam subir. */
function cenario(t) {
  const { carregados, cliente } = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde' }],
    users: [{ id: DONO, nome: 'Dono' }],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin' }],
  }, ['routes/auth', 'routes/teams', 'routes/feed']);
  const subidos = [];
  // Parar no Storage com erro: o que interessa é SE o arquivo chegou até ali, não o que vem depois.
  cliente.storage = {
    createBucket: async () => ({}),
    from: () => ({
      upload: async (caminho, buffer, opcoes) => { subidos.push({ caminho, tipo: opcoes?.contentType }); return { error: { message: 'parado no teste' } }; },
      remove: async () => ({ error: null }),
      getPublicUrl: () => ({ data: { publicUrl: 'https://exemplo.test/x' } }),
    }),
  };
  const app = express();
  for (const m of ['routes/auth', 'routes/teams', 'routes/feed']) app.use(carregados[m]);
  app.use(tratadorDeErros);
  const servidor = app.listen(0);
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const enviar = async (metodo, rota, campo, buffer, tipo, nome = 'foto') => {
    const corpo = new FormData();
    corpo.append(campo, new Blob([buffer], { type: tipo }), nome);
    const r = await fetch(`${base}${rota}`, { method: metodo, headers: { 'x-teste-usuario': DONO }, body: corpo });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { enviar, subidos };
}
const silenciar = (t) => { t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {}); };

const UPLOADS = [
  { nome: 'avatar (POST /api/me/avatar)', metodo: 'POST', rota: '/api/me/avatar', campo: 'avatar' },
  { nome: 'recorte do avatar (PUT /api/me/avatar/recorte)', metodo: 'PUT', rota: '/api/me/avatar/recorte', campo: 'recorte' },
  { nome: 'escudo do time (POST /api/teams/:slug/logo)', metodo: 'POST', rota: '/api/teams/varzea-fc/logo', campo: 'logo' },
  { nome: 'mídia da Resenha (POST /api/feed/upload)', metodo: 'POST', rota: '/api/feed/upload', campo: 'file' },
];

for (const up of UPLOADS) {
  test(`${up.nome}: SVG com Content-Type de PNG → 400 "${MSG}" e nada vai ao Storage`, async (t) => {
    silenciar(t);
    const { enviar, subidos } = cenario(t);
    for (const [rotulo, bytes] of [['SVG', SVG_BUF], ['SVG com BOM e prólogo XML', SVG_COM_BOM]]) {
      const r = await enviar(up.metodo, up.rota, up.campo, bytes, 'image/png', 'foto.png');
      assert.equal(r.status, 400, rotulo);
      assert.equal(r.json.error, MSG, rotulo);
    }
    assert.deepEqual(subidos, []);
  });

  test(`${up.nome}: TIFF e AVIF de verdade com Content-Type de PNG → 400 (formato real fora da lista)`, async (t) => {
    silenciar(t);
    const im = await imagens();
    const { enviar, subidos } = cenario(t);
    for (const [rotulo, bytes] of [['TIFF', im.tiff], ['AVIF', im.avif]]) {
      const r = await enviar(up.metodo, up.rota, up.campo, bytes, 'image/png', 'foto.png');
      assert.equal(r.status, 400, rotulo);
      assert.equal(r.json.error, MSG, rotulo);
    }
    assert.deepEqual(subidos, []);
  });

  test(`${up.nome}: PNG de verdade passa pela conferência e chega ao Storage; JPEG e WebP de verdade também`, async (t) => {
    silenciar(t);
    const im = await imagens();
    const { enviar, subidos } = cenario(t);
    const resultados = [];
    for (const [bytes, tipo] of [[im.png, 'image/png'], [im.jpeg, 'image/jpeg'], [im.webp, 'image/webp']]) {
      const r = await enviar(up.metodo, up.rota, up.campo, bytes, tipo);
      assert.notEqual(r.json?.error, MSG, `um ${tipo} de verdade não pode levar a frase do formato (status ${r.status})`);
      resultados.push(r.status);
    }
    assert.equal(subidos.length, 3, `os 3 chegaram ao Storage (status ${resultados})`);
  });
}

test('avatar: GIF de verdade com Content-Type de PNG → 400 (a lista do avatar não tem GIF); JPEG com cara de PNG segue passando (os dois estão na lista)', async (t) => {
  silenciar(t);
  const im = await imagens();
  const { enviar, subidos } = cenario(t);
  const gif = await enviar('POST', '/api/me/avatar', 'avatar', im.gif, 'image/png');
  assert.deepEqual([gif.status, gif.json.error], [400, MSG]);
  assert.deepEqual(subidos, []);
  const jpegComCaraDePng = await enviar('POST', '/api/me/avatar', 'avatar', im.jpeg, 'image/png');
  assert.notEqual(jpegComCaraDePng.json?.error, MSG);
  assert.equal(subidos.length, 1);
});

test('avatar: a original (campo "original") também é conferida — SVG nela barra o pedido inteiro', async (t) => {
  silenciar(t);
  const im = await imagens();
  const { subidos } = cenario(t);
  const app = express();
  const { carregados } = carregar({ users: [{ id: DONO, nome: 'Dono' }] }, ['routes/auth']);
  app.use(carregados['routes/auth']);
  app.use(tratadorDeErros);
  const servidor = app.listen(0);
  t.after(() => servidor.close());
  const corpo = new FormData();
  corpo.append('avatar', new Blob([im.png], { type: 'image/png' }), 'recorte.png');
  corpo.append('original', new Blob([SVG_BUF], { type: 'image/png' }), 'original.png');
  const r = await fetch(`http://127.0.0.1:${servidor.address().port}/api/me/avatar`, { method: 'POST', headers: { 'x-teste-usuario': DONO }, body: corpo });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, MSG);
  assert.deepEqual(subidos, []);
});

test('Resenha: GIF de verdade com Content-Type de GIF passa (a lista da Resenha tem GIF); SVG com Content-Type de GIF → 400', async (t) => {
  silenciar(t);
  const im = await imagens();
  const { enviar, subidos } = cenario(t);
  const gif = await enviar('POST', '/api/feed/upload', 'file', im.gif, 'image/gif', 'a.gif');
  assert.notEqual(gif.json?.error, MSG);
  assert.equal(subidos.length, 1);
  const falso = await enviar('POST', '/api/feed/upload', 'file', SVG_BUF, 'image/gif', 'a.gif');
  assert.deepEqual([falso.status, falso.json.error], [400, MSG]);
  assert.equal(subidos.length, 1);
});

test('Resenha: o vídeo não passa pelo sharp e segue como estava (video/mp4 vai ao Storage sem a conferência de imagem)', async (t) => {
  silenciar(t);
  const { enviar, subidos } = cenario(t);
  const r = await enviar('POST', '/api/feed/upload', 'file', Buffer.from('bytes de um vídeo qualquer'), 'video/mp4', 'a.mp4');
  assert.notEqual(r.json?.error, MSG);
  assert.equal(subidos.length, 1);
  assert.equal(subidos[0].tipo, 'video/mp4');
});
