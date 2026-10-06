// ═══════════════════════════════════════════════════════════════════════════════
// MEDIDOR DE FIDELIDADE DO UNIFORME.
//
// Não chama a fal, não gasta nada. Compara o TRONCO da figurinha com a imagem do
// kit que entrou na geração e diz se o uniforme saiu fiel.
//
// O molde dos 5 kits é o mesmo (kit2..5 nasceram do dark-gold): camisa da cor
// BASE, e o ACENTO é uma CUNHA — a borda esquerda (de quem olha) desce na
// diagonal do lado do colarinho até o meio da barra, a borda direita desce
// QUASE A PRUMO junto à costura lateral (com um vivo da cor base), e a manga
// esquerda de quem veste (a da direita de quem olha) é toda do acento, com o
// punho da cor base.
//
// Os defeitos do gabarito (LOJA/demo-avatares, 9 gerações, 4 certas):
//   • FAIXA — o acento vira uma faixa de bordas PARALELAS: a borda direita
//     desce na diagonal junto com a esquerda (dono t1 e t2, Careca).
//     Ter preto à direita do ouro NÃO é o defeito — as 4 certas também têm
//     (19–27% da largura); o defeito é esse preto crescer para baixo.
//   • MANGA — a manga esquerda de quem veste sai da cor base (Zé Gordo 1 e 2).
// E dois que o medidor confere porque custam nada: cor base trocada (os kits
// invertidos tendem a voltar ao preto) e acento a mais ou a menos no tronco.
//
// Como mede:
//   1. a paleta sai da IMAGEM DO KIT (k-médias com 2 grupos nos pixels da
//      camisa) — nenhuma cor escrita à mão, vale para os 5 kits;
//   2. cada pixel opaco do recorte (birefnet, com alfa — a produção já tem esse
//      recorte em mãos) vira BASE, ACENTO ou OUTRO (pele, cabelo) — ver testeDeCor;
//   3. acha a linha dos ombros e a largura dos ombros; o tronco analisado vai
//      dos ombros até 0,8 largura de ombro abaixo (antes da barra da camisa);
//   4. mede a manga, as duas bordas do acento e as proporções, e compara com o
//      mesmo cálculo feito na imagem do kit.
//
// Uso (bancada):
//   node scripts/_bench/medidor-uniforme.js --gabarito [--debug pasta]
//        as 9 do gabarito × o veredito do dono; sai com erro se errar alguma
//   node scripts/_bench/medidor-uniforme.js <recorte.png> --kit <kit.png> [--debug saida.png]
// Módulo: const { medirUniforme, lerReferenciaKit } = require('./medidor-uniforme');
// ═══════════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// ── cor ──────────────────────────────────────────────────────────────────────
function srgbParaLab(r, g, b) {
  const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// Distância com a luminosidade a pesar 0,35: o mesmo ouro sai em L 35 ou 75
// conforme a luz da figurinha. Só serve para desempatar (ver classificar).
const dist = (p, q) => Math.hypot((p[0] - q[0]) * 0.35, p[1] - q[1], p[2] - q[2]);
const croma = (p) => Math.hypot(p[1], p[2]);
const matiz = (p) => (Math.atan2(p[2], p[1]) * 180) / Math.PI;
const difMatiz = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/**
 * Uma cor do kit vira um TESTE de pertença, conforme o tipo:
 *   cromática (ouro, roxo)     → matiz a ±17° e croma >= 60% da do kit; luz livre.
 *     Medido nas 9 do gabarito: o ouro gerado sai com matiz 61–85° e croma 40–67;
 *     a pele fica em 30–60° com croma 20–49. É o MATIZ que separa — numa
 *     distância Lab comum a pele cai mais perto do ouro do que do preto, e os
 *     rostos virariam "acento".
 *   acromática (preto, branco) → croma baixa e luz do mesmo lado: o preto
 *     pintado tem brilho de cetim (L até ~40), o branco tem sombra (L de 60).
 */
function testeDeCor(p) {
  const C = croma(p);
  if (C >= 20) {
    const h = matiz(p), cMin = Math.max(18, C * 0.6);
    return (q) => croma(q) >= cMin && difMatiz(matiz(q), h) <= 17;
  }
  if (p[0] < 50) return (q) => croma(q) <= 16 && q[0] <= Math.max(42, p[0] + 30);
  return (q) => croma(q) <= Math.max(16, C + 10) && q[0] >= Math.min(60, p[0] - 25);
}

const OUTRO = 0, BASE = 1, ACENTO = 2;

/** Classe de cada pixel. Se os dois testes passarem (não acontece nos 5 kits), fica a cor mais próxima. */
function classificar(data, w, h, dentro, paleta) {
  const tB = testeDeCor(paleta.base), tA = testeDeCor(paleta.acento);
  const cls = new Uint8Array(w * h);
  const cache = new Map();
  for (let i = 0; i < w * h; i += 1) {
    if (!dentro[i]) continue;
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const chave = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let c = cache.get(chave);
    if (c === undefined) {
      const lab = srgbParaLab(r, g, b);
      const eB = tB(lab), eA = tA(lab);
      if (eB && eA) c = dist(lab, paleta.base) <= dist(lab, paleta.acento) ? BASE : ACENTO;
      else c = eB ? BASE : (eA ? ACENTO : OUTRO);
      cache.set(chave, c);
    }
    cls[i] = c;
  }
  return cls;
}

// ── paleta do kit ────────────────────────────────────────────────────────────
/**
 * Máscara da peça na imagem do kit: o kit1 tem alfa; os kits 2–5 vêm sobre
 * preto chapado (0–1). O fundo é o que se liga à borda passando só por pixels
 * quase pretos — o preto da camisa (6–30) não passa nesse filtro.
 */
async function mascaraKit(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const n = w * h;
  let temAlfa = false;
  for (let i = 0; i < n && !temAlfa; i += 97) if (data[i * 4 + 3] < 250) temAlfa = true;
  const dentro = new Uint8Array(n);
  if (temAlfa) {
    for (let i = 0; i < n; i += 1) dentro[i] = data[i * 4 + 3] > 200 ? 1 : 0;
    return { data, w, h, dentro };
  }
  const quasePreto = (i) => Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) <= 4;
  const fundo = new Uint8Array(n);
  const pilha = [];
  for (let x = 0; x < w; x += 1) pilha.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y += 1) pilha.push(y * w, y * w + w - 1);
  while (pilha.length) {
    const i = pilha.pop();
    if (fundo[i] || !quasePreto(i)) continue;
    fundo[i] = 1;
    const x = i % w, y = (i - x) / w;
    if (x > 0) pilha.push(i - 1);
    if (x < w - 1) pilha.push(i + 1);
    if (y > 0) pilha.push(i - w);
    if (y < h - 1) pilha.push(i + w);
  }
  for (let i = 0; i < n; i += 1) dentro[i] = fundo[i] ? 0 : 1;
  return { data, w, h, dentro };
}

/** k-médias com 2 grupos em Lab; BASE = o grupo que domina o peito esquerdo (de quem olha), onde está o emblema. */
function duasCores(labs, noPeitoEsquerdo) {
  let c0 = labs[0], c1 = labs[0];
  for (const p of labs) { if (p[0] < c0[0]) c0 = p; if (croma(p) > croma(c1)) c1 = p; }
  let cs = [c0.slice(), c1.slice()];
  const grupo = new Uint8Array(labs.length);
  for (let it = 0; it < 15; it += 1) {
    const soma = [[0, 0, 0, 0], [0, 0, 0, 0]];
    labs.forEach((p, i) => {
      const g = dist(p, cs[0]) <= dist(p, cs[1]) ? 0 : 1;
      grupo[i] = g;
      soma[g][0] += p[0]; soma[g][1] += p[1]; soma[g][2] += p[2]; soma[g][3] += 1;
    });
    cs = soma.map((s, g) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : cs[g]));
  }
  let n0 = 0, n1 = 0;
  labs.forEach((_, i) => { if (noPeitoEsquerdo[i]) { if (grupo[i] === 0) n0 += 1; else n1 += 1; } });
  return n0 >= n1 ? { base: cs[0], acento: cs[1] } : { base: cs[1], acento: cs[0] };
}

// ── geometria ────────────────────────────────────────────────────────────────
/**
 * Por linha, a maior corrida de camisa (base+acento; buracos até 3% da largura
 * tolerados — emblema, dobra, reflexo). A linha dos OMBROS é a primeira (de
 * cima) onde a camisa ocupa >= 60% da maior largura por 3% da altura seguidos:
 * cabelo e barba pretos passam no teste do preto, mas a cabeça nunca chega a
 * 60% da largura dos ombros. O tronco analisado vai até 0,8 ombro abaixo —
 * nas 9 do gabarito isso fica sempre acima da barra da camisa.
 */
function geometria(cls, w, h) {
  const buraco = Math.max(3, Math.round(w * 0.03));
  const linhas = [];
  for (let y = 0; y < h; y += 1) {
    let melhor = null, ini = -1, ultimo = -1;
    for (let x = 0; x <= w; x += 1) {
      const c = x < w ? cls[y * w + x] : OUTRO;
      if (c === OUTRO) continue;
      if (ini < 0 || x - ultimo > buraco) {
        if (ini >= 0 && (!melhor || ultimo - ini > melhor[1] - melhor[0])) melhor = [ini, ultimo];
        ini = x;
      }
      ultimo = x;
    }
    if (ini >= 0 && (!melhor || ultimo - ini > melhor[1] - melhor[0])) melhor = [ini, ultimo];
    linhas.push(melhor && melhor[1] - melhor[0] > w * 0.08 ? { L: melhor[0], R: melhor[1] } : null);
  }
  let maxLarg = 0;
  for (const l of linhas) if (l) maxLarg = Math.max(maxLarg, l.R - l.L);
  const passo = Math.max(3, Math.round(h * 0.03));
  let y0 = -1;
  for (let y = 0; y < h - passo && y0 < 0; y += 1) {
    let ok = true;
    for (let k = 0; k < passo && ok; k += 1) { const l = linhas[y + k]; if (!l || l.R - l.L < maxLarg * 0.6) ok = false; }
    if (ok) y0 = y;
  }
  if (y0 < 0) return null;
  let ombro = 0;
  for (let y = y0; y < Math.min(h, y0 + Math.round(h * 0.25)); y += 1) if (linhas[y]) ombro = Math.max(ombro, linhas[y].R - linhas[y].L);
  return { linhas, y0, y1: Math.min(h - 1, y0 + Math.round(ombro * 0.8)), ombro, yCava: y0 + Math.round(ombro * 0.32) };
}

/** Mediana das inclinações entre pares (Theil–Sen): uma mão no bolso ou uma dobra não arrasta a reta. */
function theilSen(pontos, campo, dyMin) {
  const s = [];
  const pts = pontos.filter((_, i) => i % 3 === 0);
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      const dy = pts[j].y - pts[i].y;
      if (dy >= dyMin) s.push((pts[j][campo] - pts[i][campo]) / dy);
    }
  }
  if (!s.length) return null;
  s.sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * Os números que o veredito usa, todos sem unidade (independem do tamanho):
 *   mangaDir     acento na manga da direita de quem olha (= ESQUERDA de quem veste)
 *   mangaEsq     acento na manga da esquerda de quem olha
 *   incEsq/Dir   inclinação (dx/dy) das bordas esquerda e direita do acento,
 *                abaixo da cava, entre 50% e 100% do tronco
 *   paralelo     incDir ÷ incEsq — 0 = borda direita a prumo (cunha, o kit);
 *                1 = bordas paralelas (faixa)
 *   acentoTronco fração de acento no tronco, sem as mangas
 *   baseEsq      fração de base na metade esquerda do tronco, abaixo da cava
 */
function medidas(cls, w, h, geo) {
  const { linhas, y0, y1, ombro, yCava } = geo;
  let mdA = 0, mdT = 0, meA = 0, meT = 0, trA = 0, trT = 0, beB = 0, beT = 0;
  const pontos = [];
  // O centro do tronco, medido abaixo da cava (onde não há manga a puxar).
  let centro = 0, nC = 0;
  for (let y = yCava; y <= y1; y += 1) if (linhas[y]) { centro += (linhas[y].L + linhas[y].R) / 2; nC += 1; }
  centro = nC ? centro / nC : w / 2;
  for (let y = y0; y <= y1; y += 1) {
    const l = linhas[y];
    if (!l) continue;
    const fy = (y - y0) / Math.max(1, y1 - y0);
    let aIni = -1, aUlt = -1, aMelhor = null;
    for (let x = l.L; x <= l.R; x += 1) {
      const c = cls[y * w + x];
      if (c === OUTRO) continue;
      // acima da cava, o que passa de 0,30 ombro do centro é manga
      if (y < yCava && Math.abs(x - centro) > ombro * 0.30) {
        if (x > centro) { mdT += 1; if (c === ACENTO) mdA += 1; } else { meT += 1; if (c === ACENTO) meA += 1; }
      } else {
        trT += 1; if (c === ACENTO) trA += 1;
        if (x < centro && y >= yCava) { beT += 1; if (c === BASE) beB += 1; }
      }
      if (c === ACENTO) {
        if (aIni < 0 || x - aUlt > Math.max(3, w * 0.02)) {
          if (aIni >= 0 && (!aMelhor || aUlt - aIni > aMelhor[1] - aMelhor[0])) aMelhor = [aIni, aUlt];
          aIni = x;
        }
        aUlt = x;
      }
    }
    if (aIni >= 0 && (!aMelhor || aUlt - aIni > aMelhor[1] - aMelhor[0])) aMelhor = [aIni, aUlt];
    // só corridas de acento de verdade (>= 8% da camisa): o emblema e o vivo não contam
    if (y >= yCava && aMelhor && aMelhor[1] - aMelhor[0] >= (l.R - l.L) * 0.08) pontos.push({ y, fy, e: aMelhor[0], d: aMelhor[1] });
  }
  const faixa = pontos.filter((p) => p.fy >= 0.5);
  const incEsq = theilSen(faixa, 'e', ombro * 0.08);
  const incDir = theilSen(faixa, 'd', ombro * 0.08);
  return {
    mangaDir: mdT ? mdA / mdT : null,
    mangaEsq: meT ? meA / meT : null,
    incEsq,
    incDir,
    paralelo: incEsq != null && incDir != null && Math.abs(incEsq) > 0.05 ? incDir / incEsq : null,
    acentoTronco: trT ? trA / trT : 0,
    baseEsq: beT ? beB / beT : 0,
  };
}

// ── API ──────────────────────────────────────────────────────────────────────
/** Paleta + medidas do próprio kit (a referência). Faz-se uma vez por kit. */
async function lerReferenciaKit(kitBuf) {
  const { data, w, h, dentro } = await mascaraKit(kitBuf);
  let topo = h, fundoY = 0, xMin = w, xMax = 0;
  for (let i = 0; i < w * h; i += 1) {
    if (!dentro[i]) continue;
    const x = i % w, y = (i - x) / w;
    topo = Math.min(topo, y); fundoY = Math.max(fundoY, y); xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
  }
  // A camisa é a parte de cima da peça (55%); o resto é o calção.
  const limCamisa = Math.round(topo + (fundoY - topo) * 0.55);
  const meioX = (xMin + xMax) / 2;
  const labs = [], peitoEsq = [];
  for (let y = topo; y < limCamisa; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = y * w + x;
      if (!dentro[i]) continue;
      labs.push(srgbParaLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]));
      peitoEsq.push(x < meioX - (xMax - xMin) * 0.08 && y < topo + (fundoY - topo) * 0.35);
    }
  }
  const paleta = duasCores(labs, peitoEsq);
  const soCamisa = new Uint8Array(dentro);
  soCamisa.fill(0, limCamisa * w);
  const cls = classificar(data, w, h, soCamisa, paleta);
  const geo = geometria(cls, w, h);
  if (!geo) throw new Error('não achei a camisa na imagem do kit');
  return { paleta, medidas: medidas(cls, w, h, geo), geo, cls, w, h };
}

// O veredito. Cada regra é uma frase sobre o kit; o número é o meio da folga
// entre as certas e as erradas do gabarito (rodar --gabarito):
const REGRAS = {
  // manga esquerda de quem veste: certas 0,75–0,93 · erradas 0,07 · kit 0,72
  mangaMin: 0.45,
  // bordas do acento: certas 0,58–0,75 · faixas 0,84–0,95 · kit 0,08.
  // A folga é a mais estreita das regras: entre 0,75 e 0,85 o veredito é
  // "no limite" (ver `limite` no resultado) — a bancada nova diz se segura.
  paraleloMax: 0.80,
  // cor base: a metade esquerda do tronco é base (certas 0,74–0,87 · kit 0,99)
  baseEsqMin: 0.55,
  // acento no tronco: entre metade e o dobro do kit (kit 0,29 · as 9: 0,29–0,39)
  acentoMinFatorKit: 0.5,
  acentoMaxFatorKit: 2.0,
};

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const num = (v) => (v == null ? '—' : v.toFixed(2));

/**
 * Mede uma figurinha contra a referência do kit.
 * @param {Buffer} recorteBuf recorte do birefnet (PNG com alfa)
 * @param {object} ref        lerReferenciaKit(kitBuf)
 * @returns {{ ok: boolean, limite: boolean, motivos: string[], medidas: object|null }}
 *   `limite` = passou ou falhou por menos de 0,05 no paralelismo.
 */
async function medirUniforme(recorteBuf, ref) {
  const { data, info } = await sharp(recorteBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const dentro = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) dentro[i] = data[i * 4 + 3] > 200 ? 1 : 0;
  const cls = classificar(data, w, h, dentro, ref.paleta);
  const geo = geometria(cls, w, h);
  if (!geo) return { ok: false, limite: false, motivos: ['camisa não encontrada (cores fora do kit)'], medidas: null, cls, w, h, geo };
  const m = medidas(cls, w, h, geo);
  const k = ref.medidas;
  const motivos = [];
  if (m.mangaDir == null || m.mangaDir < REGRAS.mangaMin) motivos.push(`manga esquerda sem o acento (${pct(m.mangaDir)}; kit ${pct(k.mangaDir)})`);
  if (m.paralelo == null) motivos.push('acento sem borda diagonal');
  else if (m.paralelo > REGRAS.paraleloMax) motivos.push(`acento virou faixa de bordas paralelas (${num(m.paralelo)}; kit ${num(k.paralelo)})`);
  if (m.baseEsq < REGRAS.baseEsqMin) motivos.push(`cor base trocada (${pct(m.baseEsq)} de base no lado esquerdo)`);
  if (m.acentoTronco < k.acentoTronco * REGRAS.acentoMinFatorKit) motivos.push(`acento a menos no tronco (${pct(m.acentoTronco)}; kit ${pct(k.acentoTronco)})`);
  if (m.acentoTronco > k.acentoTronco * REGRAS.acentoMaxFatorKit) motivos.push(`acento a mais no tronco (${pct(m.acentoTronco)}; kit ${pct(k.acentoTronco)})`);
  const limite = m.paralelo != null && Math.abs(m.paralelo - REGRAS.paraleloMax) < 0.05;
  return { ok: motivos.length === 0, limite, motivos, medidas: m, cls, w, h, geo };
}

/** Depuração: base = azul, acento = laranja, outro = cinza; linhas brancas = ombros, cava, fim do tronco. */
async function imagemDebug(res) {
  const { cls, w, h, geo } = res;
  const out = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i += 1) {
    const cor = cls[i] === BASE ? [40, 70, 200] : cls[i] === ACENTO ? [255, 150, 0] : [60, 60, 60];
    out[i * 3] = cor[0]; out[i * 3 + 1] = cor[1]; out[i * 3 + 2] = cor[2];
  }
  if (geo) {
    for (const y of [geo.y0, geo.yCava, geo.y1]) {
      for (let x = 0; x < w; x += 1) out.fill(255, (Math.min(h - 1, y) * w + x) * 3, (Math.min(h - 1, y) * w + x) * 3 + 3);
    }
  }
  return sharp(out, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

module.exports = { medirUniforme, lerReferenciaKit, mascaraKit, imagemDebug, REGRAS, pct, num };

// ── linha de comando ─────────────────────────────────────────────────────────
const FUT = path.join(__dirname, '..', '..', '..', '..');
const DEMO = path.join(FUT, 'LOJA', 'demo-avatares');
// As imagens dos kits (cópia do bucket público `kits`) vivem fora do repositório, com a saída da bancada.
const KITS = path.join(FUT, 'LOJA', 'uniforme-bancada', 'kits');

// O gabarito: as 9 V6 geradas, pela ordem em que foram geradas. Fiel em 4 de 9:
// dono t1/t2 errados (faixa), t3 certo; Zé Gordo 2 de 3 com a manga preta
// (as duas primeiras). Faltam 2 certas e 1 errada entre Careca e os dois
// Paredões: de perto, o Careca é faixa de bordas paralelas e os dois Paredões
// são cunha — o "reprovado" do Paredão foi pela cara de revista, não pelo
// uniforme.
const GABARITO = [
  { id: 'l1-careca', certo: false },
  { id: 'l2-ze-gordo-reprovado', certo: false },
  { id: 'l3-paredao-reprovado', certo: true },
  { id: 'dono-t1', certo: false },
  { id: 'dono-t2', certo: false },
  { id: 'l2-ze-gordo-reprovado2', certo: false },
  { id: 'l3-paredao', certo: true },
  { id: 'dono-t3', certo: true },
  { id: 'l2-ze-gordo', certo: true },
];

const resumo = (m) => (m
  ? `manga ${num(m.mangaDir)} · paralelo ${num(m.paralelo)} · base ${num(m.baseEsq)} · acento ${num(m.acentoTronco)}`
  : 'sem medidas');

if (require.main === module) {
  (async () => {
    const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
    const ref = await lerReferenciaKit(fs.readFileSync(arg('kit') || path.join(KITS, 'kit1-dark-gold.png')));
    const dbg = arg('debug');
    console.log(`KIT${' '.repeat(22)}${resumo(ref.medidas)}`);
    if (process.argv.includes('--gabarito')) {
      let acertos = 0;
      for (const g of GABARITO) {
        const r = await medirUniforme(fs.readFileSync(path.join(DEMO, `${g.id}-recorte.png`)), ref);
        const bate = r.ok === g.certo;
        if (bate) acertos += 1;
        console.log(`${g.id.padEnd(24)} ${resumo(r.medidas)} → ${r.ok ? '✓' : '✗'}${r.limite ? ' (no limite)' : ''} · dono ${g.certo ? '✓' : '✗'} ${bate ? 'BATE' : 'NÃO BATE'}${r.motivos.length ? ` · ${r.motivos.join('; ')}` : ''}`);
        if (dbg) fs.writeFileSync(path.join(dbg, `${g.id}-debug.png`), await imagemDebug(r));
      }
      if (dbg) fs.writeFileSync(path.join(dbg, 'kit-debug.png'), await imagemDebug(ref));
      console.log(`\n${acertos}/${GABARITO.length} vereditos iguais aos do gabarito`);
      if (acertos !== GABARITO.length) process.exit(2);
      return;
    }
    const fig = process.argv[2];
    if (!fig || fig.startsWith('--')) { console.error('uso: medidor-uniforme.js <recorte.png> --kit <kit.png> | --gabarito'); process.exit(1); }
    const r = await medirUniforme(fs.readFileSync(fig), ref);
    console.log(`${path.basename(fig)} ${resumo(r.medidas)} → ${r.ok ? '✓' : '✗'}${r.limite ? ' (no limite)' : ''} ${r.motivos.join('; ')}`);
    if (dbg) fs.writeFileSync(dbg, await imagemDebug(r));
  })().catch((e) => { console.error(e); process.exit(1); });
}
