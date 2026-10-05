// ═══════════════════════════════════════════════════════════════════════════════
// CAMADAS DO "OURO VIVO" NO TAMANHO CHEIO — Rodada 29X.
//
// Quem desenha o ícone e o splash do app é a receita da bancada de 23-set
// (testar-icone.js: o F real de futtyMonograma.js, em ouro com degradê, reflexo e
// brilho, sobre a vinheta). Este script só RENDERIZA as peças dela no tamanho cheio
// e as grava como PNG; quem compõe, redimensiona e grava nos lugares do app é o
// frontend (scripts/gerar-icones.mjs e scripts/gerar-splash.mjs), que chama este
// script num processo filho. Por que filho: o sharp do backend e o do frontend são
// duas cópias do libvips (versões diferentes) e as duas no MESMO processo derrubam
// o Node (segfault) — cada uma fica no seu.
//
// Nada é desenhado aqui: as funções são as de testar-icone.js (require, não cópia).
//
//   adaptativo-fundo-1024.png   a vinheta #1a1826 → #0b0a12 SEM aro (variante 1 "ouro vivo"), sem alfa
//   adaptativo-frente-1024.png  só o F ouro vivo com o brilho, transparente, dentro da zona segura (66/108)
//   splash-f-<altura>.png       o F ouro vivo com o brilho, transparente, num quadrado só um pouco maior que o F (74% do lado),
//                               com <altura> px de altura — a mesma peça do ícone do iPhone, só em escala maior
//
//   node scripts/_bench/renderizar-camadas.js --saida=<pasta> [--splash-altura=928]
// ═══════════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { SIZE, F_ALTURA, pecaF, svgAndroidBackground, svgAndroidForeground, VARIANTES } = require('./testar-icone');

const opcao = (nome) => {
  const achada = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return achada ? achada.slice(nome.length + 3) : undefined;
};

async function main() {
  const saida = opcao('saida');
  if (!saida) throw new Error('faltou --saida=<pasta>');
  fs.mkdirSync(saida, { recursive: true });
  const gravar = async (nome, buffer) => {
    fs.writeFileSync(path.join(saida, nome), buffer);
    console.log(`[camadas] ${nome} (${buffer.length} B)`);
  };

  // O fundo e a frente do adaptativo: a variante 1 (vinheta, sem aro) — a 2 é a do iPhone, com a moldura.
  const semAro = VARIANTES.find((v) => v.id === 1);
  if (!semAro || semAro.aro) throw new Error('a variante 1 da bancada não é mais a "ouro vivo" sem aro — conferir à mão');
  await gravar('adaptativo-fundo-1024.png', await sharp(Buffer.from(svgAndroidBackground(semAro))).removeAlpha().png().toBuffer());
  await gravar('adaptativo-frente-1024.png', await sharp(Buffer.from(svgAndroidForeground(semAro).svg)).png().toBuffer());

  // O F do splash: a MESMA peça do ícone do iPhone (pecaF no quadrado de 1024, F a 74% da altura — o "ouro vivo" que o dono escolheu), sem
  // fundo (quem põe o #080808 sólido, ou o transparente, é o frontend), desenhada em escala maior: o SVG fica com o viewBox de 1024 e o
  // width/height do tamanho pedido, então o librsvg rasteriza o vetor já grande, sem ampliar pixel. Por que não pecaF() direto no tamanho do
  // splash, como o gerar-icone-splash.js: o degradê do ouro (defsOuro) é userSpaceOnUse e vive dentro do grupo transformado do F, ou seja, em
  // coordenadas do próprio F — só cobre o F inteiro no 1024 da bancada. A 2732 ele cai fora do F e o ouro sai chapado em #f5e070.
  const altura = Number(opcao('splash-altura') || 0);
  if (altura) {
    let lado = Math.round(altura / F_ALTURA); // o F tem F_ALTURA do lado: o quadrado é só um pouco maior que o F (cabe o brilho)
    if (lado % 2) lado += 1; // par: o F fica centrado em pixel inteiro quando o frontend o põe no meio do splash
    const f = pecaF({ cx: SIZE / 2, cy: SIZE / 2, altura: F_ALTURA * SIZE, lado: SIZE, sufixo: 'splash' });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${lado}" height="${lado}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>${f.defs}</defs>
  ${f.corpo}
</svg>`;
    await gravar(`splash-f-${altura}.png`, await sharp(Buffer.from(svg)).png().toBuffer());
    console.log(`[camadas] o F do splash mede ${(F_ALTURA * lado).toFixed(1)} px de altura num quadrado de ${lado} px (pedido: ${altura} px)`);
  }
}

main().catch((e) => {
  console.error('[renderizar-camadas] falhou:', e.message);
  process.exit(1);
});
