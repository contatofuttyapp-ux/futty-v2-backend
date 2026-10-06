// Futty v2.0 — gera resources/icon.png e resources/splash.png do frontend a
// partir do F real (frontend/src/utils/futtyMonograma.js), via sharp. Corre
// UMA VEZ (não é bancada de comparação); fica em _bench por convenção do
// house style (scripts avulsos de geração de asset vivem aqui).
//
// "Ouro vivo": reusa a MESMA peça de F e o MESMO fundo de
// scripts/_bench/testar-icone.js (gradiente vertical + reflexo diagonal +
// brilho atrás, sobre a vinheta #0b0a12→#1a1826) em vez de redesenhar aqui —
// é a linguagem escolhida pelo dono na bancada (variante 2, "ouro vivo + aro";
// o aro fica só no ÍCONE — ver aplicar-icone.js — o splash não tem cantos de
// app para emoldurar).
//
// O resources/splash.png DESTE script NÃO é o splash que vai ao aparelho:
//   · tem vinheta (#0b0a12→#1a1826) e o splash do app é o #080808 SÓLIDO (a cor de colors.xml, do
//     capacitor.config.json e do --bg: com vinheta haveria degrau na troca da abertura para o app);
//   · o ouro sai CHAPADO (#f5e070, sem degradê): o degradê do pecaF (defsOuro) é userSpaceOnUse e vive
//     dentro do grupo transformado do F, ou seja, em coordenadas do próprio F — só cobre o F inteiro
//     no quadrado de 1024 da bancada; a 2732 px ele cai fora do F. (O icon.png, a 1024, está certo.)
// O splash do app (iPhone, Android abaixo do 12 e frontend/assets/) sai de
// frontend/scripts/gerar-splash.mjs, que renderiza a MESMA peça do ícone do iPhone em escala maior
// (scripts/_bench/renderizar-camadas.js). Este script só vale para o icon.png.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { pecaF, fundoVinheta } = require('./testar-icone');

const OUT_DIR = path.join(__dirname, '..', '..', '..', 'frontend', 'resources');

function svgOuroVivo(tamanho, alturaFracao, sufixo) {
  // fundoVinheta() vem de testar-icone.js e é reaproveitada de verdade: o
  // radialGradient usa cx/cy/r em PORCENTAGEM (independe de tamanho). Só o
  // <rect> de fundo.corpo tem o 1024 da bancada cravado — por isso desenha-se
  // aqui um <rect> do tamanho certo com os MESMOS defs, em vez de usar
  // fundo.corpo. pecaF() já é parametrizada em tamanho (cx/cy/altura/lado),
  // sem esse problema.
  const fundo = fundoVinheta(sufixo);
  const f = pecaF({ cx: tamanho / 2, cy: tamanho / 2, altura: tamanho * alturaFracao, lado: tamanho, sufixo });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${tamanho}" height="${tamanho}" viewBox="0 0 ${tamanho} ${tamanho}">
  <defs>${fundo.defs}${f.defs}</defs>
  <rect width="${tamanho}" height="${tamanho}" fill="url(#vinheta-${sufixo})"/>
  ${f.corpo}
</svg>`;
}

async function gerar() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const icone = svgOuroVivo(1024, 0.74, 'icon');
  await sharp(Buffer.from(icone)).removeAlpha().png().toFile(path.join(OUT_DIR, 'icon.png'));
  console.log('[icone] gerado: resources/icon.png (1024x1024, F ouro vivo a 74% da altura)');

  const splash = svgOuroVivo(2732, 0.40, 'splash');
  await sharp(Buffer.from(splash)).removeAlpha().png().toFile(path.join(OUT_DIR, 'splash.png'));
  console.log('[splash] gerado: resources/splash.png (2732x2732, F ouro vivo a 40% da altura)');
}

gerar().catch((e) => {
  console.error('[gerar-icone-splash] falhou:', e.message);
  process.exit(1);
});
