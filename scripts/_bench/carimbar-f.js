// BANCADA v9.3 — CARIMBO LOCAL do F oficial (a logo NUNCA é gerada por IA).
// Compõe: material gerado + F (asset futty-logo-flat.png) ao centro, com relevo
// subtil (sombra deslocada + highlight leve) para assentar no foil.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SCR = 'C:/Users/phfer/AppData/Local/Temp/claude/C--Users-phfer/e6d3f9a7-8e16-4cba-95ea-1c38c8ef7b1b/scratchpad';
const LOGO = 'c:/Users/phfer/Desktop/FUT/FUTTY-V2/frontend/public/futty-logo-flat.png';

async function silhueta(logoBuf, cor, alphaMul) {
  // silhueta do F na cor dada, com alpha opcionalmente atenuado (para sombra/brilho)
  const meta = await sharp(logoBuf).metadata();
  const alphaRaw = await sharp(logoBuf).ensureAlpha().extractChannel(3).raw().toBuffer();
  if (alphaMul !== 1) for (let i = 0; i < alphaRaw.length; i++) alphaRaw[i] = Math.round(alphaRaw[i] * alphaMul);
  return sharp({ create: { width: meta.width, height: meta.height, channels: 3, background: cor } })
    .joinChannel(alphaRaw, { raw: { width: meta.width, height: meta.height, channels: 1 } })
    .png().toBuffer();
}

async function carimbar(materialPath, outPath, modo) {
  const mat = sharp(materialPath);
  const { width: W, height: H } = await mat.metadata();
  const fw = Math.round(W * 0.46); // tamanho nobre
  const logoBuf = await sharp(LOGO).resize(fw).png().toBuffer();
  const { width: lw, height: lh } = await sharp(logoBuf).metadata();
  const cx = Math.round((W - lw) / 2), cy = Math.round((H - lh) / 2);
  const sombra = await sharp(await silhueta(logoBuf, '#000000', 0.5)).blur(7).toBuffer();
  const brilho = await sharp(await silhueta(logoBuf, '#ffffff', 0.16)).blur(2).toBuffer();
  const principal = modo === 'ouro-logo'
    ? logoBuf // o próprio asset (ouro metálico oficial)
    : await silhueta(logoBuf, '#0a0a0c', 1); // F preto (esmalte)
  await mat.composite([
    { input: sombra, left: cx + 7, top: cy + 11 },   // sombra: assenta no material
    { input: brilho, left: cx - 3, top: cy - 4 },    // highlight: relevo subtil
    { input: principal, left: cx, top: cy },
  ]).png().toFile(outPath);
  console.log('OK', path.basename(outPath));
}

(async () => {
  await carimbar(path.join(SCR, 'v9-material-ouro.png'), path.join(SCR, 'v9-carta-ouro.png'), 'preto');
  await carimbar(path.join(SCR, 'v9-material-roxo.png'), path.join(SCR, 'v9-carta-roxa-preta.png'), 'preto');
  await carimbar(path.join(SCR, 'v9-material-roxo.png'), path.join(SCR, 'v9-carta-roxa-ouro.png'), 'ouro-logo');
  console.log('CARIMBOS=3 (custo zero, local)');
})();
