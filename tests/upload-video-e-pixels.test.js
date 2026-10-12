// Futty v2.0 — Rodada 30N (1 e 2): o upload confere os bytes do vídeo e o teto de pixels da imagem (sem banco, sem rede).
//
//   1. video/mp4 só passa se os bytes são de um MP4 de verdade (a caixa "ftyp" do contêiner). Texto, imagem ou executável com
//      Content-Type de vídeo levam 400 "Esse arquivo não é um vídeo aceito." e NADA vai ao Storage.
//   2. Imagem acima do teto de pixels (8192 × 8192) leva 400 "Essa imagem é grande demais em pixels…" em TODOS os uploads de imagem —
//      e o motor nem tenta decodificar. O PNG "bomba" é fabricado aqui: poucos bytes que declaram 30 000 × 30 000 pixels no cabeçalho.
//
// Uso: node --test tests/upload-video-e-pixels.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const express = require('express');
const sharp = require('sharp');
const { carregar } = require('./_rotas');
const { tratadorDeErros } = require('../middleware/erros');
const {
  ehMp4Real, exigirFormatoReal, exigirPixelsDentroDoTeto, formatoReal, MSG_VIDEO, MSG_PIXELS, LIMITE_PIXELS,
} = require('../utils/imagemReal');

const DONO = '33333333-3333-3333-3333-333333333333';
const TIME = '11111111-1111-1111-1111-111111111111';
const FOTO = { width: 300, height: 400, channels: 3, background: { r: 120, g: 130, b: 140 } };

/** Os primeiros bytes de um MP4: caixa ftyp (tamanho, "ftyp", marca principal, versão, marcas compatíveis) + lixo de "mdat". */
function mp4De(marca = 'isom') {
  const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp'), Buffer.from(marca, 'latin1'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2', 'latin1')]);
  return Buffer.concat([ftyp, Buffer.from([0, 0, 0, 16]), Buffer.from('mdat'), Buffer.alloc(8)]);
}

/** Um PNG de verdade em 1×1 com o cabeçalho (IHDR) reescrito para declarar `largura × altura`: dá para ler as dimensões, e decodificar seria um desastre. */
async function pngBomba(largura, altura) {
  const b = Buffer.from(await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } }).png().toBuffer());
  assert.equal(b.toString('latin1', 12, 16), 'IHDR');
  b.writeUInt32BE(largura, 16);
  b.writeUInt32BE(altura, 20);
  b.writeUInt32BE(zlib.crc32(b.subarray(12, 29)), 29); // o CRC do IHDR, senão a libpng recusa antes de ler as dimensões
  return b;
}

const silenciar = (t) => { t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {}); };

// ─── 1. vídeo ─────────────────────────────────────────────────────────────────
test('ehMp4Real: reconhece a caixa ftyp com marcas de MP4; recusa texto, imagem, executável, QuickTime, HEIC e arquivo curto', async () => {
  for (const marca of ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ']) assert.equal(ehMp4Real(mp4De(marca)), true, marca);
  assert.equal(ehMp4Real(Buffer.from('bytes de um vídeo qualquer, só que não')), false);
  assert.equal(ehMp4Real(Buffer.from('MZ\x90\x00\x03\x00\x00\x00 executável do Windows .............')), false);
  assert.equal(ehMp4Real(await sharp({ create: FOTO }).png().toBuffer()), false, 'imagem com cara de vídeo');
  assert.equal(ehMp4Real(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), false);
  assert.equal(ehMp4Real(mp4De('qt  ')), false, 'QuickTime (.mov) não é o que o upload declara aceitar');
  assert.equal(ehMp4Real(mp4De('heic')), false, 'HEIC também é "ftyp", mas não é vídeo');
  assert.equal(ehMp4Real(mp4De('M4A ')), false, 'áudio M4A');
  assert.equal(ehMp4Real(Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79])), false, 'curto demais');
  assert.equal(ehMp4Real(Buffer.alloc(0)), false);
  assert.equal(ehMp4Real(null), false);
  const tamanhoMentiroso = mp4De('isom');
  tamanhoMentiroso.writeUInt32BE(0x7fffffff, 0);
  assert.equal(ehMp4Real(tamanhoMentiroso), false, 'a caixa diz um tamanho maior que o arquivo');
});

/** As rotas de verdade com o banco falso por baixo e um Storage falso que só anota o que lhe mandam subir. */
function cenarioDaResenha(t) {
  const { carregados, cliente } = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde' }],
    users: [{ id: DONO, nome: 'Dono' }],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin' }],
  }, ['routes/auth', 'routes/teams', 'routes/feed']);
  const subidos = [];
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
  const enviar = async (metodo, rota, campo, buffer, tipo, nome = 'arquivo') => {
    const corpo = new FormData();
    corpo.append(campo, new Blob([buffer], { type: tipo }), nome);
    const r = await fetch(`${base}${rota}`, { method: metodo, headers: { 'x-teste-usuario': DONO }, body: corpo });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { enviar, subidos };
}

test('Resenha: video/mp4 com bytes de MP4 de verdade chega ao Storage (como o tipo do vídeo)', async (t) => {
  silenciar(t);
  const { enviar, subidos } = cenarioDaResenha(t);
  await enviar('POST', '/api/feed/upload', 'file', mp4De('isom'), 'video/mp4', 'a.mp4');
  assert.equal(subidos.length, 1);
  assert.equal(subidos[0].tipo, 'video/mp4');
});

test('Resenha: video/mp4 que NÃO é vídeo → 400 "Esse arquivo não é um vídeo aceito." e nada vai ao Storage', async (t) => {
  silenciar(t);
  const { enviar, subidos } = cenarioDaResenha(t);
  const falsos = [
    ['texto', Buffer.from('bytes de um vídeo qualquer')],
    ['imagem PNG', await sharp({ create: FOTO }).png().toBuffer()],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['HTML', Buffer.from('<!doctype html><script>alert(1)</script>')],
    ['executável', Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00')],
    ['vazio', Buffer.from([0])],
  ];
  for (const [rotulo, bytes] of falsos) {
    const r = await enviar('POST', '/api/feed/upload', 'file', bytes, 'video/mp4', 'a.mp4');
    assert.equal(r.status, 400, rotulo);
    assert.equal(r.json.error, MSG_VIDEO, rotulo);
  }
  assert.deepEqual(subidos, []);
});

test('Resenha: o MP4 de verdade com Content-Type de IMAGEM não passa (a imagem é conferida pelos bytes); a imagem de verdade segue passando', async (t) => {
  silenciar(t);
  const { enviar, subidos } = cenarioDaResenha(t);
  const r = await enviar('POST', '/api/feed/upload', 'file', mp4De('isom'), 'image/png', 'a.png');
  assert.equal(r.status, 400);
  assert.deepEqual(subidos, []);
  const ok = await enviar('POST', '/api/feed/upload', 'file', await sharp({ create: FOTO }).jpeg().toBuffer(), 'image/jpeg', 'a.jpg');
  assert.notEqual(ok.json?.error, MSG_VIDEO);
  assert.equal(subidos.length, 1);
});

// ─── 2. pixels ────────────────────────────────────────────────────────────────
test('o teto: 8192 × 8192 (67 MP) — uma foto de 48 a 50 MP do celular cabe com folga', () => {
  assert.equal(LIMITE_PIXELS, 8192 * 8192);
  assert.ok(8064 * 6048 < LIMITE_PIXELS, 'iPhone 48 MP');
  assert.ok(8192 * 6144 < LIMITE_PIXELS, 'sensor de 50 MP em resolução máxima');
});

test('o PNG bomba é lido só pelo cabeçalho: as dimensões aparecem, nada é decodificado', async () => {
  const bomba = await pngBomba(30000, 30000);
  assert.ok(bomba.length < 200, `a bomba tem ${bomba.length} bytes`);
  assert.equal(await formatoReal(bomba), 'png', 'o formato continua legível (sem o teto padrão do sharp)');
  const meta = await sharp(bomba, { limitInputPixels: false }).metadata();
  assert.deepEqual([meta.width, meta.height], [30000, 30000]);
});

test('exigirPixelsDentroDoTeto / exigirFormatoReal: acima do teto → 400 com a frase da casa; no teto ou abaixo, passa', async (t) => {
  silenciar(t);
  const lista = ['image/jpeg', 'image/png', 'image/webp'];
  for (const [l, a] of [[30000, 30000], [8193, 8192], [100000, 1000], [16384, 16384]]) {
    const bomba = await pngBomba(l, a);
    await assert.rejects(exigirPixelsDentroDoTeto(bomba), (e) => e.status === 400 && e.message === MSG_PIXELS && !e.code, `${l}×${a}`);
    await assert.rejects(exigirFormatoReal(bomba, lista), (e) => e.status === 400 && e.message === MSG_PIXELS, `${l}×${a} no upload`);
  }
  for (const [l, a] of [[8192, 8192], [8000, 6000], [4000, 3000]]) {
    const ok = await pngBomba(l, a);
    await exigirPixelsDentroDoTeto(ok);
    await exigirFormatoReal(ok, lista);
  }
  // acima de 268 MP (o teto padrão do sharp) também: a conferência não pode confundir "enorme" com "ilegível"
  await assert.rejects(exigirFormatoReal(await pngBomba(65000, 65000), lista), (e) => e.status === 400 && e.message === MSG_PIXELS);
  // o que nada lê não é decidido aqui (a decodificação de cada upload responde)
  await exigirPixelsDentroDoTeto(Buffer.from('lixo'));
  await exigirPixelsDentroDoTeto(Buffer.alloc(0));
  await exigirPixelsDentroDoTeto(null);
});

const UPLOADS = [
  { nome: 'avatar (POST /api/me/avatar)', metodo: 'POST', rota: '/api/me/avatar', campo: 'avatar' },
  { nome: 'recorte do avatar (PUT /api/me/avatar/recorte)', metodo: 'PUT', rota: '/api/me/avatar/recorte', campo: 'recorte' },
  { nome: 'escudo do time (POST /api/teams/:slug/logo)', metodo: 'POST', rota: '/api/teams/varzea-fc/logo', campo: 'logo' },
  { nome: 'mídia da Resenha (POST /api/feed/upload)', metodo: 'POST', rota: '/api/feed/upload', campo: 'file' },
];
for (const up of UPLOADS) {
  test(`${up.nome}: imagem gigante → 400 "${MSG_PIXELS}", o motor segue de pé e nada vai ao Storage`, async (t) => {
    silenciar(t);
    const { enviar, subidos } = cenarioDaResenha(t);
    for (const [l, a] of [[30000, 30000], [20000, 20000], [65000, 65000]]) {
      const r = await enviar(up.metodo, up.rota, up.campo, await pngBomba(l, a), 'image/png', 'foto.png');
      assert.equal(r.status, 400, `${l}×${a}`);
      assert.equal(r.json.error, MSG_PIXELS, `${l}×${a}`);
    }
    assert.deepEqual(subidos, []);
    // o motor segue de pé: uma foto normal logo depois passa da conferência e chega ao Storage
    const normal = await enviar(up.metodo, up.rota, up.campo, await sharp({ create: FOTO }).png().toBuffer(), 'image/png', 'foto.png');
    assert.notEqual(normal.json?.error, MSG_PIXELS);
    assert.equal(subidos.length, 1, `a foto normal devia chegar ao Storage (status ${normal.status})`);
  });
}

test('uma foto de 48 MP no teto passa pela conferência (a Resenha a comprime e a grava)', async (t) => {
  silenciar(t);
  const { enviar } = cenarioDaResenha(t);
  const quarenta8 = await pngBomba(8064, 6048);
  const r = await enviar('POST', '/api/feed/upload', 'file', quarenta8, 'image/png', 'foto.png');
  assert.notEqual(r.json?.error, MSG_PIXELS, 'foto de celular de 48 MP não pode levar a frase dos pixels');
});
