// ═══════════════════════════════════════════════════════════════════════════════
// O QUE TODA BANCADA DE FIGURINHA USA (17-set).
//
// Saiu de dentro do testar-prompt.js quando a bancada de MODELOS precisou das
// mesmas peças: medir a coroa, recortar o fundo, vestir a moldura e montar a
// folha de contacto. Duas bancadas a medir a mesma coisa com código diferente
// mediriam coisas diferentes — daí o módulo.
//
// O que NÃO está aqui de propósito: o prompt (prompts/figurinha.js), a entrada
// (utils/entradaFigurinha.js) e a chamada à fal (utils/falFila.js). Esses são
// módulos de PRODUÇÃO, e as bancadas importam-nos de lá — é isso que garante
// que o que se mede é o que está no ar.
// ═══════════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sharp = require('sharp');
const { chamarFal } = require('../../utils/falFila');

const BIREFNET = 'fal-ai/birefnet';

const baixar = async (url) => Buffer.from(await (await fetch(url)).arrayBuffer());

/**
 * O recorte de fundo da produção. Devolve o buffer já trimado e o custo da
 * chamada (a fal não manda header para o birefnet — vem `usd: null`).
 */
async function recortarFundo(urlGerada) {
  const r = await chamarFal(BIREFNET, { image_url: urlGerada, model: 'General Use (Light)' });
  const url = r.dados?.image?.url;
  if (!url) throw new Error('birefnet não devolveu imagem');
  const trimado = await sharp(await baixar(url)).trim({ threshold: 10 }).png().toBuffer();
  return { trimado, custo: r.custo, segundos: r.segundos };
}

/**
 * Achatamento da coroa (CLAUDE.md): largura da primeira linha opaca a dividir
 * pela maior largura nos primeiros 10% da figura. ~0 = cúpula normal;
 * acima de 0,5 = cabeça comida.
 */
async function achatamento(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const larg = (y) => { let n = 0; for (let x = 0; x < w; x += 1) if (data[(y * w + x) * c + 3] > 200) n += 1; return n; };
  let y0 = -1;
  for (let y = 0; y < h && y0 < 0; y += 1) if (larg(y) > 0) y0 = y;
  if (y0 < 0) return { razao: null, cortada: false };
  const faixa = Math.min(h, y0 + Math.max(8, Math.round(h * 0.10)));
  let maxima = 0;
  for (let y = y0; y < faixa; y += 1) maxima = Math.max(maxima, larg(y));
  const razao = maxima ? larg(y0) / maxima : 0;
  return { razao, cortada: razao > 0.5 };
}

// A moldura da casa, na receita do frontend (figurinhaCanvas.js): octógono com
// corte de 32k nos cantos, corpo dourado de 7k (gradiente) a 3,5k da borda e uma
// linha fina #f5e070 de 1,2k a 8,5k. Aqui em SVG, porque o backend não tem canvas.
function molduraSVG(W, H) {
  const k = W / 400, cut = 32 * k;
  const octo = (m) => `M${m + cut},${m} L${W - m - cut},${m} L${W - m},${m + cut} L${W - m},${H - m - cut} `
    + `L${W - m - cut},${H - m} L${m + cut},${H - m} L${m},${H - m - cut} L${m},${m + cut} Z`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="ouro" x1="0" y1="0" x2="${W}" y2="${H}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#f7e08a"/><stop offset="0.3" stop-color="#c8940f"/>
      <stop offset="0.55" stop-color="#f5d060"/><stop offset="0.8" stop-color="#8a6508"/>
      <stop offset="1" stop-color="#e8c04a"/>
    </linearGradient>
  </defs>
  <path d="${octo(3.5 * k)}" fill="none" stroke="url(#ouro)" stroke-width="${7 * k}" stroke-linejoin="miter"/>
  <path d="${octo(8.5 * k)}" fill="none" stroke="#f5e070" stroke-width="${1.2 * k}" stroke-linejoin="miter"/>
</svg>`);
}

function fundoSVG(W, H) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="base" x1="0" y1="0" x2="0" y2="${H}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0a0a12"/><stop offset="0.55" stop-color="#070812"/>
      <stop offset="1" stop-color="#050609"/>
    </linearGradient>
    <radialGradient id="aura" cx="0.5" cy="0.44" r="0.62">
      <stop offset="0" stop-color="#d4a017" stop-opacity="0.34"/>
      <stop offset="0.55" stop-color="#8b5cf6" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#050609" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#base)"/>
  <ellipse cx="${W / 2}" cy="${H * 0.44}" rx="${W * 0.46}" ry="${H * 0.38}" fill="url(#aura)"/>
</svg>`);
}

/** Recorte trimado → figurinha 512×768 com fundo da casa e moldura Dark Gold. */
async function montarFigurinha(trimado) {
  const W = 512, H = 768;
  const jogador = await sharp(trimado)
    .resize({ width: Math.round(W * 0.80), height: Math.round(H * 0.80), fit: 'inside' })
    .png().toBuffer();
  const m = await sharp(jogador).metadata();
  return sharp(await sharp(fundoSVG(W, H)).png().toBuffer())
    .composite([
      { input: jogador, left: Math.round((W - m.width) / 2), top: Math.round(H * 0.94) - m.height },
      { input: await sharp(molduraSVG(W, H)).png().toBuffer(), left: 0, top: 0 },
    ])
    .png().toBuffer();
}

/**
 * Folha de contacto: as células lado a lado, cada uma com o seu rótulo em cima.
 * Na bancada de PROMPT os rótulos são letras embaralhadas (avaliação cega); na
 * de MODELOS são os números dos candidatos, porque aí a pergunta é técnica.
 */
async function folhaDeContato(celulas, destino) {
  const CW = 300, CH = 450, PAD = 16, TOPO = 44;
  const W = PAD + celulas.length * (CW + PAD), H = TOPO + CH + PAD;
  const fundo = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#0d0d12"/>
    ${celulas.map((c, i) => `<text x="${PAD + i * (CW + PAD) + CW / 2}" y="30" fill="#d4a017"
      font-family="Arial,Helvetica,sans-serif" font-size="22" font-weight="bold" text-anchor="middle">${c.letra}</text>`).join('')}
  </svg>`);
  const partes = [];
  for (const [i, c] of celulas.entries()) {
    partes.push({
      input: await sharp(c.png).resize({ width: CW, height: CH, fit: 'inside' }).png().toBuffer(),
      left: PAD + i * (CW + PAD), top: TOPO,
    });
  }
  await sharp(await sharp(fundo).png().toBuffer()).composite(partes).png().toFile(destino);
}

/** Mulberry32 — o mesmo da casa; embaralha de forma reproduzível. */
function mulberry32(a) {
  return function proximo() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** CSV com aspas onde é preciso — as linhas levam nomes de ficheiro e parâmetros. */
const paraCsv = (linhas) => linhas
  .map((l) => l.map((c) => (/[",;\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(','))
  .join('\n');


/**
 * O catálogo de kits REAL, lido de routes/auth.js. Lê desde KIT_URL (as
 * constantes dos assets) até ao fim de KITS_IA — ler só o KITS_IA rebenta com
 * "KIT_URL is not defined", que é o que acontecia antes de isto vir para aqui.
 */
function lerKit(kitId) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'auth.js'), 'utf8');
  const ini = src.indexOf('const KIT_URL');
  const iK = src.indexOf('const KITS_IA = {');
  const fim = src.indexOf('\n};', iK);
  if (ini < 0 || iK < 0 || fim < 0) throw new Error('não consegui ler KITS_IA de routes/auth.js — aborta antes de gastar');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(ini, fim + 3)}\nout={KITS_IA};`, ctx);
  const kit = ctx.out.KITS_IA[kitId];
  if (!kit?.ativo || !kit?.url) throw new Error(`kit "${kitId}" indisponível`);
  return kit;
}

module.exports = {
  lerKit,
  BIREFNET, baixar, recortarFundo, achatamento,
  molduraSVG, fundoSVG, montarFigurinha, folhaDeContato, mulberry32, paraCsv,
};
