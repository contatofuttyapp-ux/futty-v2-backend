// ═══════════════════════════════════════════════════════════════════════════════
// FOLHA FINAL — depois de aplicar-icone.js. Lê os arquivos REAIS já gravados
// (não regenera buffers) e monta uma folha só com o resultado, em 180 px (iOS)
// e 144 px (Android xxxhdpi), fundo escuro e claro — para o dono conferir.
// Reusa mascara()/androidVisivel()/papelDeParede() de testar-icone.js.
//
//   node scripts/_bench/folha-final.js
// ═══════════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { FRONT, mascara, androidVisivel, papelDeParede, IOS_PX, ANDROID_PX, IOS_ROTULO, ANDROID_ROTULO, FONTE } = require('./testar-icone');

const OUT = path.join(FRONT, 'scripts', 'capturas', 'icone', 'final.png');

async function main() {
  const iosBuf = fs.readFileSync(path.join(FRONT, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png'));
  const pastaAndroid = path.join(FRONT, 'android', 'app', 'src', 'main', 'res', 'mipmap-xxxhdpi');
  const bgBuf = fs.readFileSync(path.join(pastaAndroid, 'ic_launcher_background.png'));
  const fgBuf = fs.readFileSync(path.join(pastaAndroid, 'ic_launcher_foreground.png'));
  const androidBuf = await androidVisivel(bgBuf, fgBuf);

  const MARGEM = 40;
  const COL = 340;
  const grupos = [
    { plataforma: 'ios', tema: 'escuro', titulo: 'iOS · 60 pt (180 px) · fundo escuro' },
    { plataforma: 'ios', tema: 'claro', titulo: 'iOS · 60 pt (180 px) · fundo claro' },
    { plataforma: 'android', tema: 'escuro', titulo: 'Android xxxhdpi · 48 dp (144 px) · máscara circular · fundo escuro' },
    { plataforma: 'android', tema: 'claro', titulo: 'Android xxxhdpi · 48 dp (144 px) · máscara circular · fundo claro' },
  ];
  const TITULO_H = 44;
  const GRUPO_TITULO_H = 28;
  const GRUPO_GAP = 20;
  const painelAltura = (p) => (p === 'ios' ? IOS_PX + IOS_ROTULO + 90 : ANDROID_PX + ANDROID_ROTULO + 90);
  const largura = MARGEM * 2 + COL;
  const altura = MARGEM + TITULO_H
    + grupos.reduce((s, g) => s + GRUPO_TITULO_H + painelAltura(g.plataforma) + GRUPO_GAP, 0)
    + MARGEM - GRUPO_GAP;

  const camadas = [];
  const textos = [`<text x="${MARGEM}" y="${MARGEM - 12}" font-family="${FONTE}" font-size="17" font-weight="700" fill="#ffffff">Ícone final — "ouro vivo + aro"</text>`];
  let y = MARGEM + TITULO_H;
  for (const g of grupos) {
    const ph = painelAltura(g.plataforma);
    textos.push(`<text x="${MARGEM}" y="${y + 18}" font-family="${FONTE}" font-size="14" fill="#cfcfd6">${g.titulo}</text>`);
    y += GRUPO_TITULO_H;
    camadas.push({ input: await sharp(papelDeParede(largura - MARGEM * 2, ph, g.tema)).png().toBuffer(), left: MARGEM, top: y });

    const tamanho = g.plataforma === 'ios' ? IOS_PX : ANDROID_PX;
    const rotuloPx = g.plataforma === 'ios' ? IOS_ROTULO : ANDROID_ROTULO;
    const icone = await mascara(g.plataforma === 'ios' ? iosBuf : androidBuf, tamanho, g.plataforma);
    const x = MARGEM + Math.round((COL - tamanho) / 2);
    const top = y + 36;
    camadas.push({ input: icone, left: x, top });
    const tx = x + tamanho / 2;
    const ty = top + tamanho + 12 + rotuloPx;
    const claro = g.tema === 'claro';
    const cor = g.plataforma === 'ios' || !claro ? '#ffffff' : '#1f1f24';
    if (g.plataforma === 'ios') {
      textos.push(`<text x="${tx + 1}" y="${ty + 1}" text-anchor="middle" font-family="${FONTE}" font-size="${rotuloPx}" font-weight="500" fill="#000" fill-opacity="0.55">Futty</text>`);
    }
    textos.push(`<text x="${tx}" y="${ty}" text-anchor="middle" font-family="${FONTE}" font-size="${rotuloPx}" font-weight="500" fill="${cor}">Futty</text>`);
    y += ph + GRUPO_GAP;
  }

  const sobreposicao = `<svg xmlns="http://www.w3.org/2000/svg" width="${largura}" height="${altura}">${textos.join('\n  ')}</svg>`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await sharp({ create: { width: largura, height: altura, channels: 3, background: '#26262c' } })
    .composite([...camadas, { input: Buffer.from(sobreposicao), left: 0, top: 0 }])
    .png()
    .toFile(OUT);

  const stat = fs.statSync(OUT);
  console.log(`[folha-final] ${OUT} — ${largura}×${altura}, ${stat.size} bytes`);
}

main().catch((e) => {
  console.error('[folha-final] falhou:', e.message);
  process.exit(1);
});
