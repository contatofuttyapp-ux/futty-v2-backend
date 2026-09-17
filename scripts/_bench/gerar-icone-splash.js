// Futty v2.0 — gera resources/icon.png e resources/splash.png do frontend a
// partir do F_CONTORNO real (src/utils/futtyMonograma.js), via sharp. Corre
// UMA VEZ (não é bancada de comparação); fica em _bench por convenção do
// house style (scripts avulsos de geração de asset vivem aqui).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const F_CONTORNO =
  'M392.28 576.53 L648.8 576.5 L659.27 541.52 L398.39 541.46 L472.99 285.11 L828.3 195.25 ' +
  'L839.06 152.39 L440.51 257.5 L210.76 1049.58 L110.36 1049.52 L360.67 177.16 L983.79 16.94 ' +
  'L913.11 270.83 L548.68 369.73 L532.74 441.62 L798.55 441.67 L732.82 676.38 L462.77 676.38 ' +
  'L354.76 1049.56 L249.78 1049.53 Z';

// Bbox real do glifo (medido nos pontos do path acima).
const BBOX = { minX: 110.36, maxX: 983.79, minY: 16.94, maxY: 1049.58 };
const bboxW = BBOX.maxX - BBOX.minX;
const bboxH = BBOX.maxY - BBOX.minY;
const cx = (BBOX.minX + BBOX.maxX) / 2;
const cy = (BBOX.minY + BBOX.maxY) / 2;

const FUNDO = '#0d0d12';
const DOURADO = '#d4a017';
const OUT_DIR = path.join(__dirname, '..', '..', '..', 'frontend', 'resources');

function svgFundoComF(size, alturaFracao) {
  const alturaAlvo = size * alturaFracao;
  const escala = alturaAlvo / bboxH;
  const destino = size / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${FUNDO}"/>
  <g transform="translate(${destino} ${destino}) scale(${escala}) translate(${-cx} ${-cy})">
    <path d="${F_CONTORNO}" fill="${DOURADO}"/>
  </g>
</svg>`;
}

async function gerar() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const icone = svgFundoComF(1024, 0.62);
  await sharp(Buffer.from(icone)).png().toFile(path.join(OUT_DIR, 'icon.png'));
  console.log('[icone] gerado: resources/icon.png (1024x1024, F a 62% da altura)');

  const splash = svgFundoComF(2732, 0.40);
  await sharp(Buffer.from(splash)).png().toFile(path.join(OUT_DIR, 'splash.png'));
  console.log('[splash] gerado: resources/splash.png (2732x2732, F a 40% da altura)');
}

gerar().catch((e) => {
  console.error('[gerar-icone-splash] falhou:', e.message);
  process.exit(1);
});
