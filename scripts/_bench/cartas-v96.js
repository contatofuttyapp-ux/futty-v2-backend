// BANCADA v9.6 — trabalho local (zero fal):
//  (6) Carta-Troféu: centrar o troféu SEM duplicar a moldura — máscara por luminância
//      na zona CENTRAL (exclui as bordas), move só o troféu, apaga o antigo com um
//      cover de textura escura amostrada + feather. Bordas ficam 100% originais.
//  (5) Carta-F bola-style: mesma anatomia/material da carta-bola, mas o F oficial
//      carimbado grande ao centro (metálico), no lugar da bola.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SCR = 'C:/Users/phfer/AppData/Local/Temp/claude/C--Users-phfer/e6d3f9a7-8e16-4cba-95ea-1c38c8ef7b1b/scratchpad';
const LOGO = 'c:/Users/phfer/Desktop/FUT/FUTTY-V2/frontend/public/futty-logo-flat.png';

// bbox do objeto brilhante na zona central (evita marquee/bordas)
async function emblemaBBox(cardPath, thr = 92) {
  const { width: W, height: H } = await sharp(cardPath).metadata();
  const g = await sharp(cardPath).greyscale().raw().toBuffer();
  let minx = W, miny = H, maxx = 0, maxy = 0;
  for (let y = Math.round(H * 0.14); y < H * 0.86; y++)
    for (let x = Math.round(W * 0.16); x < W * 0.84; x++)
      if (g[y * W + x] > thr) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  return { W, H, minx, miny, maxx, maxy, bw: maxx - minx, bh: maxy - miny };
}

// cover feathered (textura escura amostrada de uma faixa lateral limpa, esticada)
async function coverEscuro(cardPath, W, H, box) {
  const cw = box.w, ch = box.h;
  // amostra: faixa escura à ESQUERDA do centro (entre borda e emblema), sempre limpa
  const tile = await sharp(cardPath).extract({ left: Math.round(W * 0.15), top: Math.round(H * 0.45), width: Math.round(W * 0.06), height: Math.round(H * 0.10) }).toBuffer();
  const textura = await sharp(tile).resize(cw, ch, { fit: 'fill' }).blur(6).toBuffer();
  // alpha feather: retângulo branco arredondado, encolhido e desfocado
  const m = Math.round(Math.min(cw, ch) * 0.16);
  const alpha = await sharp({ create: { width: cw, height: ch, channels: 1, background: 0 } })
    .composite([{ input: await sharp({ create: { width: cw - 2 * m, height: ch - 2 * m, channels: 1, background: 255 } }).png().toBuffer(), left: m, top: m }])
    .blur(m * 0.7).raw().toBuffer();
  return sharp(textura).ensureAlpha().joinChannel(alpha, { raw: { width: cw, height: ch, channels: 1 } }).png().toBuffer();
}

async function trofeuCentrado() {
  const src = path.join(SCR, 'v94-trofeu.png');
  const b = await emblemaBBox(src, 96);
  const { W, H } = b;
  const pad = Math.round(W * 0.03);
  const ex = { left: Math.max(0, b.minx - pad), top: Math.max(0, b.miny - pad), width: b.bw + 2 * pad, height: b.bh + 2 * pad };
  // centro do INTERIOR da carta ~ 51% da altura; desloca o troféu p/ lá
  const centroAlvo = Math.round(H * 0.51);
  const centroAtual = Math.round((b.miny + b.maxy) / 2);
  const desce = centroAlvo - centroAtual;
  const trofeu = await sharp(src).extract(ex).png().toBuffer();
  const coverBox = { w: ex.width + Math.round(W * 0.04), h: ex.height + Math.abs(desce) + Math.round(H * 0.03) };
  const cover = await coverEscuro(src, W, H, coverBox);
  await sharp(src).composite([
    { input: cover, left: Math.round(ex.left - W * 0.02), top: Math.round(ex.top - H * 0.015) }, // apaga o antigo
    { input: trofeu, left: ex.left, top: ex.top + desce },                                        // troféu centrado
  ]).png().toFile(path.join(SCR, 'v94-trofeu-c.png'));
  console.log('OK troféu-c (desce ' + desce + 'px, molduras intactas)');
}

async function silhueta(logoBuf, cor, mul) {
  const meta = await sharp(logoBuf).metadata();
  const a = await sharp(logoBuf).ensureAlpha().extractChannel(3).raw().toBuffer();
  if (mul !== 1) for (let i = 0; i < a.length; i++) a[i] = Math.round(a[i] * mul);
  return sharp({ create: { width: meta.width, height: meta.height, channels: 3, background: cor } })
    .joinChannel(a, { raw: { width: meta.width, height: meta.height, channels: 1 } }).png().toBuffer();
}

async function fBolaStyle() {
  const src = path.join(SCR, 'v94-bola.png');
  const b = await emblemaBBox(src, 96);
  const { W, H } = b;
  // apaga a bola
  const coverBox = { w: b.bw + Math.round(W * 0.08), h: b.bh + Math.round(H * 0.06) };
  const cover = await coverEscuro(src, W, H, coverBox);
  const coverLeft = Math.round((b.minx + b.maxx) / 2 - coverBox.w / 2);
  const coverTop = Math.round((b.miny + b.maxy) / 2 - coverBox.h / 2);
  // F oficial (gold metálico) grande no centro da carta, com relevo
  const fw = Math.round(W * 0.44);
  const logo = await sharp(LOGO).resize(fw).png().toBuffer();
  const { width: lw, height: lh } = await sharp(logo).metadata();
  const cx = Math.round((W - lw) / 2), cy = Math.round((H - lh) / 2);
  const sombra = await sharp(await silhueta(logo, '#000000', 0.6)).blur(8).toBuffer();
  const brilho = await sharp(await silhueta(logo, '#ffffff', 0.20)).blur(2).toBuffer();
  await sharp(src).composite([
    { input: cover, left: coverLeft, top: coverTop },
    { input: sombra, left: cx + 8, top: cy + 12 },
    { input: brilho, left: cx - 4, top: cy - 5 },
    { input: logo, left: cx, top: cy },     // o asset oficial gold-metálico
  ]).png().toFile(path.join(SCR, 'v94-carta-f-bola.png'));
  console.log('OK carta-F bola-style (F oficial no material da bola)');
}

(async () => { await trofeuCentrado(); await fBolaStyle(); console.log('DONE'); })();
