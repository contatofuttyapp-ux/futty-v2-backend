// BANCADA — Rodada 29E (1-out): os 6 BUSTOS do mini sorteio do onboarding, a partir dos recortes dos modelos fictícios
// (saida-modelos-jovens/*-recorte.png, 30-set e 1-out). Cada busto = o recorte sobre o fundo da casa (comum.js fundoSVG,
// SEM a moldura dourada — a moldura é a .fr do CSS, como no sorteio real), janela 3:4 pelo topo (cabeça + ombros + peito),
// exportado em WebP 112×150 (2× os 56×75 de exibição) com ≤ 6 KB cada (lei do app leve, 14-set): a qualidade desce de 5 em 5
// até caber. Saída: FUTTY-V2/frontend/public/onboarding/<nome>.webp (servida do site, fora do pacote nativo).
//
// Uso: node scripts/_bench/exportar-bustos-onboarding.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { fundoSVG } = require('./comum');

const ENTRADA = path.join(__dirname, 'saida-modelos-jovens');
const SAIDA = path.join(__dirname, '..', '..', '..', 'frontend', 'public', 'onboarding');
const LARGURA = 112;
const ALTURA = 150;
const TETO_BYTES = 6 * 1024;
// A janela do busto: 62 % da altura do recorte (cabeça + ombros + peito), centrada; 6 % de folga acima da cabeça.
const FRACAO_ALTURA = 0.62;
const FOLGA_TOPO = 0.06;

// nome do arquivo (sem acento, é URL) ← recorte do modelo. Rodada 29E2 (2-out): ficam TIAGÃO (j8), PEDRÃO (j4), RAFA (j10), BRUNINHO (j11) e LÉO (j12),
// aprovados pelo dono; BRUNINHO e LÉO são a 2ª leva (--jovens4); DUDU é a 4ª (--jovens6: gordinho nerd de óculos, cabeça reta e de frente). 3 Brasil, 3 Portugal.
// Com --so a,b exporta só esses nomes (os aprovados não são tocados).
// Rodada 29E3 (2-out): 4 por time (8 rolos) — entram NANDO (j16, Brasil, ~39, grisalho) e CAIO (j17, Portugal, ~24, negro, sério), leva --jovens7.
// Os 8 são FINAIS (dono, 2-out): não re-exportar. Só o NOME do j12 mudou: LÉO virou GONÇALO (arquivo goncalo.webp, mesmos bytes do leo.webp).
const BUSTOS = [
  ['bruninho', 'j11-bruninho-br'],
  ['tiagao', 'j8-tiagao-br'],
  ['goncalo', 'j12-leo-pt'],
  ['rafa', 'j10-rafa-pt'],
  ['pedrao', 'j4-homem-negro-br'],
  ['dudu', 'j15-dudu-pt'],
  ['nando', 'j16-nando-br'],
  ['caio', 'j17-caio-pt'],
];
const SO = (() => { const i = process.argv.indexOf('--so'); return i > 0 && process.argv[i + 1] ? process.argv[i + 1].split(',') : null; })();

async function busto(recortePng) {
  const recorte = sharp(recortePng).trim({ threshold: 10 });
  const { width: w, height: h } = await recorte.toBuffer({ resolveWithObject: true }).then((r) => r.info);
  const wh = Math.round(h * FRACAO_ALTURA);
  const ww = Math.round(wh * LARGURA / ALTURA);
  const topo = Math.round(wh * FOLGA_TOPO);
  // A região do recorte que cabe na janela (o sharp não compõe uma camada maior que a base).
  const esq = Math.round(w / 2 - ww / 2);
  const x0 = Math.max(0, esq);
  const largura = Math.min(w - x0, ww - Math.max(0, -esq));
  const altura = Math.min(h, wh - topo);
  const pedaco = await sharp(await recorte.toBuffer()).extract({ left: x0, top: 0, width: largura, height: altura }).png().toBuffer();
  const fundo = await sharp(fundoSVG(ww, wh)).png().toBuffer();
  // Em duas etapas: o sharp aplica o resize ANTES do composite no mesmo pipeline, e a camada deixaria de caber na base.
  const composto = await sharp(fundo).composite([{ input: pedaco, left: Math.max(0, -esq), top: topo }]).png().toBuffer();
  return sharp(composto)
    .resize({ width: LARGURA, height: ALTURA, fit: 'cover', kernel: 'lanczos3' })
    .removeAlpha()
    .png()
    .toBuffer();
}

async function emWebp(png) {
  for (let q = 82; q >= 30; q -= 5) {
    const buf = await sharp(png).webp({ quality: q, effort: 6, smartSubsample: true }).toBuffer();
    if (buf.length <= TETO_BYTES) return { buf, q };
  }
  throw new Error('não coube em 6 KB nem a qualidade 30');
}

(async () => {
  fs.mkdirSync(SAIDA, { recursive: true });
  const linhas = [];
  let total = 0;
  for (const [nome, modelo] of BUSTOS.filter(([n]) => !SO || SO.includes(n))) {
    const origem = path.join(ENTRADA, `${modelo}-recorte.png`);
    if (!fs.existsSync(origem)) { console.error(`FALTA ${origem} — gere o modelo primeiro (gerar-modelos-ficticios.js --jovens/--jovens2)`); process.exitCode = 1; continue; }
    const png = await busto(fs.readFileSync(origem));
    const { buf, q } = await emWebp(png);
    const destino = path.join(SAIDA, `${nome}.webp`);
    fs.writeFileSync(destino, buf);
    total += buf.length;
    linhas.push(`${nome.padEnd(10)} ${String(buf.length).padStart(5)} B  q${q}  ← ${modelo}`);
  }
  console.log(linhas.join('\n'));
  console.log(`\n${linhas.length}/${BUSTOS.length} bustos · ${total} B no total (${(total / 1024).toFixed(1)} KB) · ${LARGURA}×${ALTURA} WebP ≤ ${TETO_BYTES} B cada\nsaída: ${SAIDA}`);
})();
