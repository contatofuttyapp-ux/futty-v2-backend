// Futty v2.0 — RODADA 27: os derivados da foto (LRU + aquecimento), o auto-orientar só quando há
// EXIF e o avatar de hoje nos sorteados. Sem Supabase: tudo em memória, com imagens de código.
//
// O que se tranca aqui:
//   1. duas gerações do mesmo derivado ao mesmo tempo esperam a MESMA (o aquecimento do upload e o
//      pedido da tela não trabalham em dobro), e uma falha não fica em cache nem trava a próxima;
//   2. aquecerDerivados deixa no LRU os quatro tamanhos que as telas pedem da foto, sem ir ao
//      Storage, e o quadrado sai do TOPO do recorte (não do centro);
//   3. orientarSePreciso devolve o MESMO buffer quando não há EXIF (o recorte do app), e gira/limpa
//      quando há (orientação, GPS...);
//   4. comAvataresAtuais troca só o avatar de quem tem conta e não mexe no resto do snapshot.
//
// Uso: npm test  (ou: node --test tests/derivados-midia.test.js)
require('dotenv').config();
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
  obterDerivado, aquecerDerivados, chaveDoDerivado, cacheLer, limparCache, TAMANHOS_DA_FOTO,
} = require('../utils/derivadosMidia');
const { orientarSePreciso } = require('../utils/orientarFoto');
const { comAvataresAtuais } = require('../utils/avataresDoSorteio');

beforeEach(() => limparCache());

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/** Foto 2:3 (800×1200): a metade de cima vermelha, a de baixo azul. */
const fotoDuasMetades = () => {
  const w = 800; const h = 1200;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    raw[i] = y < h / 2 ? 220 : 20; raw[i + 1] = 30; raw[i + 2] = y < h / 2 ? 30 : 220;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
};

test('obterDerivado: duas gerações ao mesmo tempo esperam a MESMA; a terceira vem do cache', async () => {
  let geradas = 0;
  const produzir = async () => { geradas += 1; await espera(80); return { buf: Buffer.from('derivado'), tipo: 'image/webp' }; };
  const [a, b] = await Promise.all([obterDerivado('k1', produzir), obterDerivado('k1', produzir)]);
  assert.equal(geradas, 1, 'a geração corre UMA vez, mesmo com dois pedidos simultâneos');
  assert.deepEqual([a.origem, b.origem].sort(), ['gerado', 'voo']);
  const c = await obterDerivado('k1', produzir);
  assert.equal(c.origem, 'cache');
  assert.equal(geradas, 1);
});

test('obterDerivado: falha não fica em cache nem trava a próxima tentativa', async () => {
  await assert.rejects(obterDerivado('k2', async () => { throw new Error('storage fora'); }), /storage fora/);
  assert.equal(cacheLer('k2'), null, 'a falha não pode ficar guardada');
  const ok = await obterDerivado('k2', async () => ({ buf: Buffer.from('ok'), tipo: 'image/webp' }));
  assert.equal(ok.origem, 'gerado');
});

test('aquecerDerivados deixa no LRU os quatro tamanhos da foto, sem Storage; o quadrado sai do TOPO', async () => {
  const buffer = await fotoDuasMetades();
  const url = 'https://exemplo.supabase.co/storage/v1/object/public/avatars/public/u1-1790000000000.jpg?v=1790000000000';
  const prontos = await aquecerDerivados({ url, buffer, tipo: 'image/jpeg' });
  assert.equal(prontos, TAMANHOS_DA_FOTO.length, 'os quatro tamanhos ficam prontos');

  const chave = (t) => chaveDoDerivado({ bucket: 'avatars', path: 'public/u1-1790000000000.jpg', v: '1790000000000', ...t });
  const medidas = {};
  for (const t of TAMANHOS_DA_FOTO) {
    const item = cacheLer(chave(t));
    assert.ok(item, `derivado ${t.largura}${t.quadrado ? ' quadrado' : ''} tem de estar no LRU`);
    assert.equal(item.tipo, 'image/webp');
    const m = await sharp(item.buf).metadata();
    medidas[`${t.largura}${t.quadrado ? 'q' : ''}`] = [m.width, m.height];
  }
  assert.deepEqual(medidas['512'], [512, 768], 'o card em 512 mantém o 2:3');
  assert.deepEqual(medidas['128q'], [128, 128], 'a miniatura quadrada é quadrada');
  assert.deepEqual(medidas['128'], [128, 192]);
  assert.deepEqual(medidas['256'], [256, 384]);

  // TOPO, não centro: o quadrado de 800×800 do topo tem 75% vermelho (600 de 800) e 25% azul embaixo.
  // Cortado do centro seria só 50% vermelho. Pixel a 62% da altura (y = 80 de 128): vermelho no topo.
  const { data, info } = await sharp(cacheLer(chave({ largura: 128, quadrado: true })).buf).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => { const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };
  assert.ok(px(64, 80)[0] > 150 && px(64, 80)[2] < 100, `a 62% da altura o quadrado do TOPO ainda é vermelho: ${px(64, 80)}`);
  assert.ok(px(64, 120)[2] > 150, `no fim do quadrado já é azul: ${px(64, 120)}`);
});

test('aquecerDerivados: URL que não é do bucket, ou sem bytes, não faz nada e não lança', async () => {
  assert.equal(await aquecerDerivados({ url: 'https://outro.site/x.jpg', buffer: Buffer.from('x'), tipo: 'image/jpeg' }), 0);
  assert.equal(await aquecerDerivados({ url: 'https://e.supabase.co/storage/v1/object/public/avatars/public/a.jpg?v=1', buffer: null, tipo: 'image/jpeg' }), 0);
});

test('orientarSePreciso: sem EXIF devolve o MESMO buffer (o recorte do app não é recodificado)', async () => {
  const jpeg = await sharp({ create: { width: 200, height: 300, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer();
  const saida = await orientarSePreciso(jpeg);
  assert.equal(saida, jpeg, 'sem EXIF não há o que corrigir: nada de decodificar e codificar de novo');
});

test('orientarSePreciso: orientação 6 gira os pixels e some com a tag; EXIF qualquer é descartado', async () => {
  const base = await sharp({ create: { width: 200, height: 300, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer();
  const deitada = await sharp(base).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  assert.equal((await sharp(deitada).metadata()).orientation, 6, 'a foto de prova traz mesmo a orientação 6');
  const girada = await orientarSePreciso(deitada);
  const m = await sharp(girada).metadata();
  assert.notEqual(girada, deitada);
  assert.deepEqual([m.width, m.height], [300, 200], 'os pixels giraram 90°');
  assert.equal(m.orientation, undefined, 'e a tag saiu');

  const comGps = await sharp(base).withMetadata({ exif: { IFD0: { Copyright: 'Futty prova' } } }).jpeg().toBuffer();
  assert.ok((await sharp(comGps).metadata()).exif, 'a foto de prova traz EXIF');
  const limpa = await orientarSePreciso(comGps);
  assert.equal((await sharp(limpa).metadata()).exif, undefined, 'o EXIF (GPS, aparelho...) não sobrevive ao upload');
});

test('orientarSePreciso: lixo que não é imagem lança (quem chama vira 400)', async () => {
  await assert.rejects(orientarSePreciso(Buffer.from('isto não é uma imagem')));
});

test('comAvataresAtuais: troca o avatar de quem tem conta; convidado, conta apagada e "sem avatar hoje" ficam com a cópia', () => {
  const tr = {
    seed: 7,
    times: [
      { nome: 'A', jogadores: [{ user_id: 'u1', nome: 'Ana', avatar_url: 'velho-1' }, { user_id: null, nome: 'Convidado', avatar_url: 'copia-c', convidado: true }] },
      { nome: 'B', jogadores: [{ user_id: 'u2', nome: 'Beto', avatar_url: 'velho-2' }, { user_id: 'u3', nome: 'Cris', avatar_url: 'velho-3' }] },
    ],
    reservas: [{ user_id: 'u4', nome: 'Dani', avatar_url: 'velho-4' }],
  };
  const hoje = new Map([['u1', 'novo-1'], ['u2', null], ['u4', 'novo-4']]); // u3 sumiu (conta apagada); u2 sem avatar hoje
  const antes = JSON.stringify(tr);
  const out = comAvataresAtuais(tr, hoje);
  assert.equal(JSON.stringify(tr), antes, 'o snapshot original não pode ser alterado');
  assert.equal(out.times[0].jogadores[0].avatar_url, 'novo-1');
  assert.equal(out.times[0].jogadores[1].avatar_url, 'copia-c', 'convidado sem conta mantém a cópia');
  assert.equal(out.times[1].jogadores[0].avatar_url, 'velho-2', 'sem avatar hoje: não se apaga o rosto do histórico');
  assert.equal(out.times[1].jogadores[1].avatar_url, 'velho-3', 'conta apagada mantém a cópia');
  assert.equal(out.reservas[0].avatar_url, 'novo-4');
  assert.equal(out.seed, 7);
  assert.equal(out.times[0].jogadores[0].nome, 'Ana', 'o resto do snapshot fica como está');
  assert.equal(comAvataresAtuais(tr, new Map()), tr, 'sem nada a trocar devolve o mesmo objeto');
  assert.equal(comAvataresAtuais(null, hoje), null);
});
