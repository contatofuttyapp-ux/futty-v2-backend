// BANCADA v9.5 — VARIAÇÕES DE CASAMENTO do F sobre as chapas aprovadas (v9.4).
// Tudo composição LOCAL (sharp), custo zero. A logo é o asset oficial, sempre.
// a) relevo forte · b) contorno dourado fino · c) piano black (specular) · d) vazado.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SCR = 'C:/Users/phfer/AppData/Local/Temp/claude/C--Users-phfer/e6d3f9a7-8e16-4cba-95ea-1c38c8ef7b1b/scratchpad';
const LOGO = 'c:/Users/phfer/Desktop/FUT/FUTTY-V2/frontend/public/futty-logo-flat.png';

async function silhueta(logoBuf, cor, mul) {
  const meta = await sharp(logoBuf).metadata();
  const a = await sharp(logoBuf).ensureAlpha().extractChannel(3).raw().toBuffer();
  if (mul !== 1) for (let i = 0; i < a.length; i++) a[i] = Math.round(a[i] * mul);
  return sharp({ create: { width: meta.width, height: meta.height, channels: 3, background: cor } })
    .joinChannel(a, { raw: { width: meta.width, height: meta.height, channels: 1 } }).png().toBuffer();
}
// specular: banda diagonal de brilho DENTRO do F (alpha = alphaF × banda)
async function specular(logoBuf, centro, larg, pico) {
  const meta = await sharp(logoBuf).metadata();
  const W = meta.width, H = meta.height;
  const a = await sharp(logoBuf).ensureAlpha().extractChannel(3).raw().toBuffer();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const d = Math.abs((x + y) / (W + H) - centro);
    const g = Math.max(0, 1 - d / larg);
    a[i] = Math.round(a[i] * g * pico);
  }
  return sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
    .joinChannel(a, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
}

async function compor(matFile, outFile, variante, corPrincipal) {
  const matPath = path.join(SCR, matFile);
  const { width: W, height: H } = await sharp(matPath).metadata();
  const fw = Math.round(W * 0.40);
  const logo = await sharp(LOGO).resize(fw).png().toBuffer();
  const { width: lw, height: lh } = await sharp(logo).metadata();
  const cx = Math.round((W - lw) / 2), cy = Math.round((H - lh) / 2);
  const preto = corPrincipal === 'ouro' ? logo : await silhueta(logo, '#0a0a0c', 1);
  const comps = [];
  if (variante === 'a') { // relevo FORTE: gravado no metal
    comps.push({ input: await sharp(await silhueta(logo, '#000000', 0.65)).blur(3).toBuffer(), left: cx + 8, top: cy + 12 });
    comps.push({ input: await sharp(await silhueta(logo, '#ffffff', 0.38)).blur(1.5).toBuffer(), left: cx - 5, top: cy - 6 });
    comps.push({ input: preto, left: cx, top: cy });
  } else if (variante === 'b') { // contorno dourado fino (carimbo em 8 direções)
    const ouro = await silhueta(logo, '#f0c94a', 1);
    for (const [dx, dy] of [[-3,0],[3,0],[0,-3],[0,3],[-2,-2],[2,-2],[-2,2],[2,2]])
      comps.push({ input: ouro, left: cx + dx, top: cy + dy });
    comps.push({ input: await sharp(await silhueta(logo, '#000000', 0.5)).blur(6).toBuffer(), left: cx + 6, top: cy + 9 });
    comps.push({ input: preto, left: cx, top: cy });
  } else if (variante === 'c') { // piano black / joia: specular próprio
    comps.push({ input: await sharp(await silhueta(logo, '#000000', 0.55)).blur(5).toBuffer(), left: cx + 6, top: cy + 10 });
    comps.push({ input: preto, left: cx, top: cy });
    comps.push({ input: await specular(logo, 0.40, 0.10, 0.55), left: cx, top: cy });
    comps.push({ input: await specular(logo, 0.62, 0.04, 0.35), left: cx, top: cy });
  } else if (variante === 'd') { // VAZADO: o F recortado na chapa (stencil de luxo)
    const furo = await silhueta(logo, '#000000', 1);
    const sombraInt = await sharp(await silhueta(logo, '#000000', 0.55)).blur(5).toBuffer();
    await sharp(matPath).ensureAlpha()
      .composite([
        { input: furo, left: cx, top: cy, blend: 'dest-out' },          // recorta
        { input: sombraInt, left: cx + 4, top: cy + 6, blend: 'atop' }, // borda interna
      ]).png().toFile(path.join(SCR, outFile));
    console.log('OK', outFile); return;
  }
  await sharp(matPath).composite(comps).png().toFile(path.join(SCR, outFile));
  console.log('OK', outFile);
}

(async () => {
  // DOURADA (chapa aprovada): 4 variações com F preto
  for (const v of ['a', 'b', 'c', 'd']) await compor('v94-mat-ouro.png', `vf-ouro-${v}.png`, v, 'preto');
  // ROXA: as 4 com F preto + as que cabem com F dourado (relevo + specular)
  for (const v of ['a', 'b', 'c', 'd']) await compor('v94-mat-roxo.png', `vf-roxa-${v}.png`, v, 'preto');
  await compor('v94-mat-roxo.png', 'vf-roxa-a2.png', 'a', 'ouro');
  await compor('v94-mat-roxo.png', 'vf-roxa-c2.png', 'c', 'ouro');
  console.log('COMPOSICOES=10 · custo zero');
})();
