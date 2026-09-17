// ═══════════════════════════════════════════════════════════════════════════════
// A ENTRADA DA FIGURINHA — o que se manda à IA junto com o prompt (17-set).
//
// Vem da variante 6 da bancada (`scripts/_bench/testar-prompt.js`), a que o dono
// escolheu: faixa de 18% no topo + corte QUADRADO 1024×1024 com a cabeça a 12%
// do topo. Ganha duas vezes:
//   • semelhança — 4,1/5 contra 4,0 da mesma receita em retrato, melhor em 6 das
//     7 fotos (a foto quadrada dá à IA menos cenário e mais cara);
//   • dinheiro — US$0,112 contra US$0,132, porque a fal cobra os tokens da
//     imagem de ENTRADA ($0,008 por 1.000; uma imagem 1024×1024 em fidelidade
//     alta são 3.050 tokens) e o quadrado é menor que o retrato.
// A SAÍDA continua 1024×1536 — o corte é só da entrada.
//
// A faixa de 18% no topo é herança da receita antiga e fica: é ela que impede a
// IA de ancorar no enquadramento do input e comer a coroa da cabeça.
// ═══════════════════════════════════════════════════════════════════════════════
const sharp = require('sharp');

const FAIXA_TOPO = 0.18;   // altura da faixa acrescentada acima da foto
const FOLGA_ACIMA = 0.12;  // onde a cabeça assenta dentro do quadrado

/**
 * Auto-orienta pelo EXIF e mede a faixa a acrescentar no topo e a sua cor —
 * a cor média da primeira faixa de 2% da foto, que é o que faz a extensão
 * parecer continuação natural e não uma banda pintada.
 */
async function comFaixa(buf) {
  const base = await sharp(buf).rotate().toBuffer();
  const m = await sharp(base).metadata();
  const strip = Math.max(8, Math.round((m.height || 0) * 0.02));
  const { data: avg } = await sharp(base)
    .extract({ left: 0, top: 0, width: m.width, height: strip })
    .resize(1, 1).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { base, m, padTop: Math.round((m.height || 0) * FAIXA_TOPO), cor: { r: avg[0], g: avg[1], b: avg[2] } };
}

/** A receita ANTIGA (retrato com faixa) — fica como rede: se o corte quadrado falhar, é aqui que se cai. */
async function preprocessarRetrato(buf) {
  const { base, padTop, cor } = await comFaixa(buf);
  return sharp(base).extend({ top: padTop, background: { ...cor, alpha: 1 } }).jpeg({ quality: 90 }).toBuffer();
}

const ehPele = (r, g, b) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return r > 95 && g > 40 && b > 20 && mx - mn > 15 && Math.abs(r - g) > 15 && r > g && r > b;
};

/**
 * Onde começa a cabeça, em fracção da altura. Não há detector de rosto nesta
 * casa (o tfjs instalado é o do nsfwjs) e a saliência do sharp aponta para o
 * objecto mais contrastado — nas fotos da bancada tanto deu a cara como uma
 * camisa berrante. O que funciona é mais simples: a cabeça é a parte mais ALTA
 * da pele. Procura-se a primeira linha com pelo menos 2% de pixels de pele que
 * se mantém nas linhas seguintes (uma linha solta é reflexo, madeira, areia).
 * Medido nas 7 fotos da bancada: 29,5% / 15,0% / 13,7% / 0% / 16,6% / 0% / 0,4%.
 * null = não achou pele (foto muito escura) — quem chama decide o que fazer.
 */
async function topoDaPele(buf) {
  const { data, info } = await sharp(buf).resize({ width: 360 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const dens = [];
  for (let y = 0; y < info.height; y += 1) {
    let n = 0;
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * 3;
      if (ehPele(data[i], data[i + 1], data[i + 2])) n += 1;
    }
    dens.push(n / info.width);
  }
  for (let y = 0; y < dens.length - 10; y += 1) {
    if (dens[y] >= 0.02 && dens.slice(y, y + 8).filter((d) => d >= 0.02).length >= 6) return y / info.height;
  }
  return null;
}

/**
 * A ENTRADA DE PRODUÇÃO desde 17-set: faixa de 18% no topo, corte quadrado com
 * a cabeça a 12% do topo, 1024×1024, JPEG q90.
 * Sem pele encontrada, o quadrado assenta no topo da faixa — nunca abaixo, para
 * não cortar a cabeça.
 */
async function preprocessarQuadrado(buf) {
  const { base, m, padTop, cor } = await comFaixa(buf);
  const comPad = await sharp(base).extend({ top: padTop, background: { ...cor, alpha: 1 } }).toBuffer();
  const W = m.width, H = m.height + padTop;
  const lado = Math.min(W, H);
  const pele = await topoDaPele(base);
  const yCabeca = padTop + Math.round(m.height * (pele ?? 0));
  const top = Math.max(0, Math.min(H - lado, Math.round(yCabeca - lado * FOLGA_ACIMA)));
  const left = Math.max(0, Math.min(W - lado, Math.round((W - lado) / 2)));
  return sharp(comPad).extract({ left, top, width: lado, height: lado })
    .resize(1024, 1024, { fit: 'fill' }).jpeg({ quality: 90 }).toBuffer();
}

module.exports = { comFaixa, topoDaPele, preprocessarQuadrado, preprocessarRetrato, FAIXA_TOPO, FOLGA_ACIMA };
