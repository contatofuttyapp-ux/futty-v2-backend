// Futty v2.0 — monta scripts/capturas/cerimonia-mista/folha.png (frontend) a
// partir das 6 capturas da cena 'cerimonia-mista' (ver-iphone.mjs). Só
// composição de imagem — nada de rede, nada de IA, custo US$0.
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const PASTA = path.join(__dirname, '..', '..', '..', 'frontend', 'scripts', 'capturas', 'cerimonia-mista');
const CELL_W = 480;
const ROW_H = 1040; // altura de cada célula depois do recorte/resize
const PAD = 24;
const LABEL_H = 46;
const COLS = 2;
const ROWS = 3;
const BG = '#0b0b14';

const ITENS = [
  { arq: 'a-slot-machine', legenda: '(a) slot machine no meio do sorteio' },
  { arq: 'b-premio', legenda: '(b) prêmio — TIMES SORTEADOS' },
  { arq: 'c-retangulo-final', legenda: '(c) retângulo final dos times' },
  { arq: 'd-compartilhar', legenda: '(d) imagem de "Compartilhar os times"' },
  { arq: 'e-ranking', legenda: '(e) Ranking (topo)' },
  { arq: 'f-presenca', legenda: '(f) presença do jogo (topo)' },
];

const svgTexto = (w, h, txt, tam = 26) => Buffer.from(
  `<svg width="${w}" height="${h}"><style>text{font-family:Arial,sans-serif;fill:#e8e6f0;font-weight:700}</style>` +
  `<rect width="${w}" height="${h}" fill="${BG}"/>` +
  `<text x="${w / 2}" y="${h / 2 + tam / 3}" font-size="${tam}" text-anchor="middle">${txt}</text></svg>`,
);

async function preparar(nome) {
  const img = sharp(path.join(PASTA, `${nome}.png`));
  const meta = await img.metadata();
  const alturaDepoisResize = Math.round(meta.height * (CELL_W / meta.width));
  let buf = await img.resize({ width: CELL_W }).toBuffer();
  if (alturaDepoisResize > ROW_H) {
    // topo é a parte informativa (cabeçalho + 1as linhas) nas listas longas.
    buf = await sharp(buf).extract({ left: 0, top: 0, width: CELL_W, height: ROW_H }).toBuffer();
    return { buf, h: ROW_H };
  }
  return { buf, h: alturaDepoisResize };
}

async function main() {
  const TITULO_H = 70;
  const larguraTotal = COLS * CELL_W + (COLS + 1) * PAD;
  const alturaTotal = TITULO_H + ROWS * (LABEL_H + ROW_H + PAD) + PAD;

  const composicoes = [
    { input: svgTexto(larguraTotal, TITULO_H, 'CERIMÔNIA COM TIME MISTO · Prova Mista (23-set)', 30), left: 0, top: 0 },
  ];

  for (let i = 0; i < ITENS.length; i += 1) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = PAD + col * (CELL_W + PAD);
    const yLabel = TITULO_H + PAD + row * (LABEL_H + ROW_H + PAD);
    const yImg = yLabel + LABEL_H;
    // eslint-disable-next-line no-await-in-loop
    const { buf, h } = await preparar(ITENS[i].arq);
    composicoes.push({ input: svgTexto(CELL_W, LABEL_H, ITENS[i].legenda, 20), left: x, top: yLabel });
    composicoes.push({ input: buf, left: x, top: yImg + Math.round((ROW_H - h) / 2) });
  }

  const destino = path.join(PASTA, 'folha.png');
  await sharp({ create: { width: larguraTotal, height: alturaTotal, channels: 4, background: BG } })
    .composite(composicoes)
    .png()
    .toFile(destino);
  console.log('folha montada em', destino, `(${larguraTotal}x${alturaTotal})`);
  console.log('tamanho:', fs.statSync(destino).size, 'bytes');
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
