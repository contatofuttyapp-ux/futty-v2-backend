// ═══════════════════════════════════════════════════════════════════════════════
// ÍCONE DO APP — "o F está apagado na tela inicial do celular" (dono, 23-set).
//
// Bancada de COMPARAÇÃO (não aplica nada): 3 variantes do ícone em 1024×1024 e
// uma folha lado a lado com o ícone ATUAL, nos tamanhos reais de tela inicial.
// O passo seguinte (outro bloco) aplica a escolhida no iOS, Android e web.
//
// Regras da casa que mandam aqui:
//   • O F é sempre o ASSET REAL — o mesmo `F_CONTORNO` de
//     frontend/src/utils/futtyMonograma.js, lido daquele arquivo em tempo de
//     execução (fonte única; se mudar lá, muda aqui). Só o TRATAMENTO muda:
//     tamanho, gradiente, brilho, fundo. Nenhum traço do F é redesenhado.
//   • Sem IA, sem imagem baixada: tudo é SVG (gradientes, blur, vinheta)
//     renderizado pelo sharp/librsvg. Os "papéis de parede" da folha também.
//   • App leve: 1024 é o mestre; o bloco de aplicação gera os tamanhos.
//
// Ponto de partida: scripts/_bench/gerar-icone-splash.js (F a 62%, fundo chapado).
//
// As 3 variantes (todas: F maior, a 74% da altura visível; ouro com gradiente
// vertical #f5e070 → #d4a017 → #b8860b; reflexo diagonal sutil; brilho dourado
// atrás, blur ~4% do lado, alpha 0,35):
//   1 "ouro vivo"            fundo #0b0a12 com vinheta radial mais clara no centro (#1a1826)
//   2 "ouro vivo + aro"      a 1 com aro dourado fino (2% da largura) nos cantos
//                            arredondados, como a moldura da figurinha
//   3 "ouro vivo + estádio"  a 1 com fundo azul-roxo (#0f0d1f → #050810) e três
//                            pontos de luz muito discretos, lembrando o fundo Estádio
//
// Por plataforma:
//   iOS      PNG 1024×1024 SEM alpha (o iOS aplica a máscara de cantos sozinho).
//            O aro da variante 2 segue a superelipse do iOS por dentro da borda.
//   Android  adaptive icon: `background` (arte cheia, sem alpha) + `foreground`
//            (só o F e o brilho, transparente). A tela de 108 dp é recortada pelo
//            launcher em 72 dp (círculo, squircle…); a ZONA SEGURA é o círculo de
//            66 dp (66/108 = 61,1% do lado) — o F fica INTEIRO lá dentro, conferido
//            vértice a vértice. O aro da 2 vai no background como círculo no
//            diâmetro da zona segura (um aro nos cantos do quadrado seria cortado
//            por qualquer máscara). Na web/iOS o F é 74% do lado; no Android é
//            74% dos 72 dp VISÍVEIS (mesma proporção depois do recorte).
//
// Folha (saida-icone/folha.png): [atual, 1, 2, 3] × [iOS 60 pt = 180 px,
// Android 48 dp = 144 px] × [papel de parede escuro, claro], com "Futty" por
// baixo como no celular (iOS: 11 pt em 60 pt, branco com sombra; Android:
// 12 sp em 48 dp, branco no escuro e quase-preto no claro). O ATUAL é o que
// está no aparelho de verdade: o AppIcon do iOS e o foreground/background do
// Android que estão no repositório — não uma regeneração.
//
//   node scripts/_bench/testar-icone.js
// ═══════════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const FRONT = path.join(__dirname, '..', '..', '..', 'frontend');
const OUT = path.join(__dirname, 'saida-icone');
const SIZE = 1024;

// ─── O F real ──────────────────────────────────────────────────────────────────
function lerFContorno() {
  const arquivo = path.join(FRONT, 'src', 'utils', 'futtyMonograma.js');
  const src = fs.readFileSync(arquivo, 'utf8');
  const m = src.match(/export const F_CONTORNO\s*=\s*([\s\S]*?);/);
  if (!m) throw new Error(`não achei F_CONTORNO em ${arquivo}`);
  // É o nosso próprio arquivo (uma concatenação de strings) — avaliar só a
  // expressão da constante é o jeito de ler ESM a partir de CommonJS sem
  // duplicar o path aqui (duplicar foi o que o gerar-icone-splash fez).
  const valor = new Function(`return (${m[1]});`)();
  if (typeof valor !== 'string' || !/^M/.test(valor.trim())) throw new Error('F_CONTORNO não é um path SVG');
  return valor.trim();
}

/** Vértices do path (é só M/L/Z — pares de números). */
function verticesDoPath(d) {
  const nums = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const v = [];
  for (let i = 0; i + 1 < nums.length; i += 2) v.push({ x: nums[i], y: nums[i + 1] });
  return v;
}

const F = lerFContorno();
const V = verticesDoPath(F);
const BBOX = {
  minX: Math.min(...V.map((p) => p.x)), maxX: Math.max(...V.map((p) => p.x)),
  minY: Math.min(...V.map((p) => p.y)), maxY: Math.max(...V.map((p) => p.y)),
};
const bboxW = BBOX.maxX - BBOX.minX;
const bboxH = BBOX.maxY - BBOX.minY;
const bcx = (BBOX.minX + BBOX.maxX) / 2;
const bcy = (BBOX.minY + BBOX.maxY) / 2;

// ─── Geometria Android (adaptive icon) ─────────────────────────────────────────
const ANDROID_VISIVEL = 72 / 108; // o que o launcher mostra (qualquer máscara cabe aqui)
const ANDROID_SEGURA = 66 / 108; // círculo onde o conteúdo NUNCA é cortado
const F_ALTURA = 0.74; // fração da altura VISÍVEL

// ─── Paleta ────────────────────────────────────────────────────────────────────
const OURO_TOPO = '#f5e070';
const OURO_MEIO = '#d4a017';
const OURO_BASE = '#b8860b';
const OURO_BRILHO = '#f0c94a';

// ─── Peças de SVG ──────────────────────────────────────────────────────────────
/** Coloca o F centrado em (cx, cy) com a altura pedida; devolve { g, escala }. */
function transformF(cx, cy, altura) {
  const escala = altura / bboxH;
  return { escala, transform: `translate(${cx} ${cy}) scale(${escala}) translate(${-bcx} ${-bcy})` };
}

/** Maior distância de um vértice do F (já transformado) ao centro da tela. */
function raioDoF(cx, cy, escala) {
  let max = 0;
  for (const p of V) {
    const x = (p.x - bcx) * escala + cx;
    const y = (p.y - bcy) * escala + cy;
    max = Math.max(max, Math.hypot(x - cx, y - cy));
  }
  return max;
}

/** Superelipse |x/a|^n + |y/b|^n = 1 — a forma dos cantos do iOS (n ≈ 5). */
function superelipse(cx, cy, a, b, n = 5, pontos = 256) {
  const pts = [];
  for (let i = 0; i < pontos; i += 1) {
    const t = (i / pontos) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const x = cx + Math.sign(c) * a * Math.abs(c) ** (2 / n);
    const y = cy + Math.sign(s) * b * Math.abs(s) ** (2 / n);
    pts.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return `M ${pts.join(' L ')} Z`;
}

const defsOuro = (id, y1, y2) => `
  <linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${y1}" x2="0" y2="${y2}">
    <stop offset="0" stop-color="${OURO_TOPO}"/>
    <stop offset="0.52" stop-color="${OURO_MEIO}"/>
    <stop offset="1" stop-color="${OURO_BASE}"/>
  </linearGradient>`;

/**
 * O F tratado (brilho atrás + ouro em gradiente + reflexo diagonal), para
 * ser colado num <svg> maior. `lado` = lado do ícone VISÍVEL, para o blur do
 * brilho (~4%) escalar igual no iOS e no Android.
 */
function pecaF({ cx, cy, altura, lado, sufixo }) {
  const { transform } = transformF(cx, cy, altura);
  const blur = (0.04 * lado).toFixed(1);
  const topo = cy - altura / 2;
  const base = cy + altura / 2;
  return {
    defs: `
  ${defsOuro(`ouro-${sufixo}`, topo, base)}
  <linearGradient id="reflexo-${sufixo}" gradientUnits="objectBoundingBox" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="0"/>
    <stop offset="0.40" stop-color="#fff" stop-opacity="0"/>
    <stop offset="0.50" stop-color="#fff" stop-opacity="0.26"/>
    <stop offset="0.60" stop-color="#fff" stop-opacity="0"/>
    <stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </linearGradient>
  <filter id="brilho-${sufixo}" x="-60%" y="-60%" width="220%" height="220%">
    <feGaussianBlur stdDeviation="${blur}"/>
  </filter>`,
    corpo: `
  <g transform="${transform}">
    <path d="${F}" fill="${OURO_BRILHO}" opacity="0.35" filter="url(#brilho-${sufixo})"/>
  </g>
  <g transform="${transform}">
    <path d="${F}" fill="url(#ouro-${sufixo})"/>
    <path d="${F}" fill="url(#reflexo-${sufixo})"/>
  </g>`,
  };
}

/** Fundo da variante 1: #0b0a12 com vinheta radial mais clara no centro. */
function fundoVinheta(id) {
  return {
    defs: `
  <radialGradient id="vinheta-${id}" cx="50%" cy="50%" r="72%">
    <stop offset="0" stop-color="#1a1826"/>
    <stop offset="1" stop-color="#0b0a12"/>
  </radialGradient>`,
    corpo: `<rect width="${SIZE}" height="${SIZE}" fill="url(#vinheta-${id})"/>`,
  };
}

/**
 * Fundo da variante 3: gradiente azul-roxo e três pontos de luz muito
 * discretos. `fx/fy/r` são frações do QUADRADO VISÍVEL (no Android o launcher
 * corta a borda, por isso as luzes ficam dentro dos 72 dp).
 */
function fundoEstadio(id, visivel) {
  const meio = SIZE / 2;
  const lado = SIZE * visivel;
  // Holofote = núcleo pequeno e claro + halo CURTO. A primeira versão usava só
  // um halo largo (r 12–17% do lado, alpha ~0,1) e em 144/180 px virava um
  // borrão cinzento — lia como mancha, não como luz. O núcleo (18% do raio)
  // é o que faz o olho ler "ponto de luz" mesmo minúsculo.
  const luzes = [
    { fx: 0.24, fy: 0.17, r: 0.10, a: 0.55 },
    { fx: 0.76, fy: 0.13, r: 0.085, a: 0.45 },
    { fx: 0.50, fy: 0.06, r: 0.075, a: 0.40 },
  ];
  const defs = luzes.map((l, i) => `
  <radialGradient id="luz-${id}-${i}" cx="50%" cy="50%" r="50%">
    <stop offset="0" stop-color="#fff6d5" stop-opacity="${l.a}"/>
    <stop offset="0.18" stop-color="#fff6d5" stop-opacity="0.12"/>
    <stop offset="1" stop-color="#fff6d5" stop-opacity="0"/>
  </radialGradient>`).join('');
  const circulos = luzes.map((l, i) => {
    const x = meio + (l.fx - 0.5) * lado;
    const y = meio + (l.fy - 0.5) * lado;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(l.r * lado).toFixed(1)}" fill="url(#luz-${id}-${i})"/>`;
  }).join('\n  ');
  return {
    defs: `
  <linearGradient id="ceu-${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#0f0d1f"/>
    <stop offset="1" stop-color="#050810"/>
  </linearGradient>${defs}`,
    corpo: `<rect width="${SIZE}" height="${SIZE}" fill="url(#ceu-${id})"/>
  ${circulos}`,
  };
}

const svg = (defs, corpo) => `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>${defs}</defs>
  ${corpo}
</svg>`;

// ─── As variantes ──────────────────────────────────────────────────────────────
const VARIANTES = [
  { id: 1, nome: 'ouro vivo', fundo: 'vinheta', aro: false },
  { id: 2, nome: 'ouro vivo + aro', fundo: 'vinheta', aro: true },
  { id: 3, nome: 'ouro vivo + estádio', fundo: 'estadio', aro: false },
];

/** iOS: quadrado cheio, F a 74% do lado, aro (se houver) na superelipse do iOS. */
function svgIOS(v) {
  const fundo = v.fundo === 'estadio' ? fundoEstadio(`ios${v.id}`, 1) : fundoVinheta(`ios${v.id}`);
  const f = pecaF({ cx: SIZE / 2, cy: SIZE / 2, altura: F_ALTURA * SIZE, lado: SIZE, sufixo: `ios${v.id}` });
  let aro = '';
  let aroDefs = '';
  if (v.aro) {
    const w = 0.02 * SIZE;
    // Uma largura inteira de aro por dentro da borda: se a máscara real do
    // iOS for um pouco mais fechada nos cantos que a nossa superelipse, o aro
    // continua inteiro.
    const a = SIZE / 2 - w;
    aroDefs = defsOuro(`aro-ios${v.id}`, 0, SIZE);
    aro = `<path d="${superelipse(SIZE / 2, SIZE / 2, a, a)}" fill="none" stroke="url(#aro-ios${v.id})" stroke-width="${w.toFixed(1)}"/>`;
  }
  return svg(fundo.defs + f.defs + aroDefs, fundo.corpo + f.corpo + aro);
}

/** Android background: arte cheia (o launcher recorta). Aro da 2 = círculo na zona segura. */
function svgAndroidBackground(v) {
  const fundo = v.fundo === 'estadio' ? fundoEstadio(`abg${v.id}`, ANDROID_VISIVEL) : fundoVinheta(`abg${v.id}`);
  let aro = '';
  let aroDefs = '';
  if (v.aro) {
    const visivel = SIZE * ANDROID_VISIVEL;
    const w = 0.02 * visivel;
    const D = SIZE * ANDROID_SEGURA; // diâmetro EXTERNO do aro = zona segura
    const r = D / 2 - w / 2;
    aroDefs = defsOuro(`aro-abg${v.id}`, SIZE / 2 - D / 2, SIZE / 2 + D / 2);
    aro = `<circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${r.toFixed(1)}" fill="none" stroke="url(#aro-abg${v.id})" stroke-width="${w.toFixed(1)}"/>`;
  }
  return svg(fundo.defs + aroDefs, fundo.corpo + aro);
}

/**
 * Android foreground: só o F e o brilho, transparente. O F mede 74% dos 72 dp
 * visíveis e é ENCOLHIDO se algum vértice sair do círculo seguro de 66 dp.
 */
function svgAndroidForeground(v) {
  const visivel = SIZE * ANDROID_VISIVEL;
  let altura = F_ALTURA * visivel;
  const raioSeguro = (SIZE * ANDROID_SEGURA) / 2;
  const { escala } = transformF(SIZE / 2, SIZE / 2, altura);
  const raio = raioDoF(SIZE / 2, SIZE / 2, escala);
  let encolhido = false;
  if (raio > raioSeguro) {
    altura *= raioSeguro / raio;
    encolhido = true;
  }
  const f = pecaF({ cx: SIZE / 2, cy: SIZE / 2, altura, lado: visivel, sufixo: `afg${v.id}` });
  const raioFinal = raioDoF(SIZE / 2, SIZE / 2, altura / bboxH);
  return {
    svg: svg(f.defs, f.corpo),
    nota: `F a ${(altura / visivel * 100).toFixed(1)}% dos 72 dp visíveis (${(altura / SIZE * 100).toFixed(1)}% da tela de 108 dp)` +
      `${encolhido ? ' — ENCOLHIDO para caber' : ''}; vértice mais longe a ${raioFinal.toFixed(0)} px do centro, zona segura ${raioSeguro.toFixed(0)} px`,
  };
}

// ─── Folha de comparação ──────────────────────────────────────────────────────
const IOS_PX = 180; // 60 pt @3x
const ANDROID_PX = 144; // 48 dp @3x
const IOS_ROTULO = Math.round(IOS_PX * (11 / 60)); // 11 pt em 60 pt
const ANDROID_ROTULO = Math.round(ANDROID_PX * (12 / 48)); // 12 sp em 48 dp
const FONTE = "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

async function mascara(buffer, tamanho, forma) {
  const d = forma === 'ios' ? superelipse(tamanho / 2, tamanho / 2, tamanho / 2, tamanho / 2) : null;
  const mascaraSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tamanho}" height="${tamanho}">
  ${forma === 'ios' ? `<path d="${d}" fill="#fff"/>` : `<circle cx="${tamanho / 2}" cy="${tamanho / 2}" r="${tamanho / 2}" fill="#fff"/>`}
</svg>`;
  const mascaraPng = await sharp(Buffer.from(mascaraSvg)).png().toBuffer();
  return sharp(buffer)
    .resize(tamanho, tamanho, { kernel: 'lanczos3' })
    .ensureAlpha()
    .composite([{ input: mascaraPng, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

/** O que um launcher Android faz: mostra só os 72 dp centrais da tela de 108. */
async function androidVisivel(fundoBuf, frenteBuf) {
  const meta = await sharp(fundoBuf).metadata();
  const lado = meta.width;
  const corte = Math.round(lado * ANDROID_VISIVEL);
  const off = Math.round((lado - corte) / 2);
  // Duas passagens de propósito: na pipeline do sharp o `extract` corre ANTES
  // do `composite` (não é sequencial), e o foreground de 108 dp não cabia na
  // base já recortada a 72 dp.
  const composto = await sharp(fundoBuf).composite([{ input: frenteBuf }]).png().toBuffer();
  return sharp(composto)
    .extract({ left: off, top: off, width: corte, height: corte })
    .png()
    .toBuffer();
}

function papelDeParede(largura, altura, tema) {
  const escuro = tema === 'escuro';
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${largura}" height="${altura}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${escuro ? '#1c2140' : '#f4f4f8'}"/>
      <stop offset="1" stop-color="${escuro ? '#0a0c18' : '#d6d9e6'}"/>
    </linearGradient>
    <radialGradient id="h" cx="35%" cy="30%" r="60%">
      <stop offset="0" stop-color="${escuro ? '#4b3f8a' : '#ffffff'}" stop-opacity="${escuro ? 0.35 : 0.6}"/>
      <stop offset="1" stop-color="${escuro ? '#4b3f8a' : '#ffffff'}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${largura}" height="${altura}" fill="url(#g)"/>
  <rect width="${largura}" height="${altura}" fill="url(#h)"/>
</svg>`);
}

async function gerar() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`[icone] F real lido de futtyMonograma.js: ${V.length} vértices, bbox ${bboxW.toFixed(1)}×${bboxH.toFixed(1)} (proporção ${(bboxW / bboxH).toFixed(3)})`);

  // 1) As variantes, por plataforma.
  const arquivos = [];
  const mestres = {}; // id -> { ios, abg, afg } (buffers)
  for (const v of VARIANTES) {
    const ios = await sharp(Buffer.from(svgIOS(v))).removeAlpha().png().toBuffer();
    const abg = await sharp(Buffer.from(svgAndroidBackground(v))).removeAlpha().png().toBuffer();
    const fg = svgAndroidForeground(v);
    const afg = await sharp(Buffer.from(fg.svg)).png().toBuffer();
    mestres[v.id] = { ios, abg, afg };

    const nomes = {
      ios: `v${v.id}-ios-1024.png`,
      abg: `v${v.id}-android-background-1024.png`,
      afg: `v${v.id}-android-foreground-1024.png`,
    };
    fs.writeFileSync(path.join(OUT, nomes.ios), ios);
    fs.writeFileSync(path.join(OUT, nomes.abg), abg);
    fs.writeFileSync(path.join(OUT, nomes.afg), afg);
    for (const [k, nome] of Object.entries(nomes)) {
      const m = await sharp(mestres[v.id][k]).metadata();
      arquivos.push({ nome, bytes: fs.statSync(path.join(OUT, nome)).size, canais: m.channels, alpha: m.hasAlpha });
    }
    console.log(`[icone] variante ${v.id} "${v.nome}" — Android: ${fg.nota}`);
  }

  // 2) O ATUAL, como está no aparelho.
  const atualIOS = fs.readFileSync(path.join(FRONT, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png'));
  const atualFgPath = path.join(FRONT, 'android', 'app', 'src', 'main', 'res', 'mipmap-xxxhdpi', 'ic_launcher_foreground.png');
  const corFundoXml = fs.readFileSync(path.join(FRONT, 'android', 'app', 'src', 'main', 'res', 'values', 'ic_launcher_background.xml'), 'utf8');
  // O VALOR do <color>, não o primeiro hex do arquivo (o comentário de cima
  // cita o "#FFFFFF" de antes e enganou a primeira versão desta bancada).
  const corFundoAtual = corFundoXml.match(/<color\s+name="ic_launcher_background"\s*>\s*(#[0-9a-fA-F]{6,8})\s*<\/color>/)[1];
  const atualFg = fs.readFileSync(atualFgPath);
  const atualFgMeta = await sharp(atualFg).metadata();
  const atualBg = await sharp({ create: { width: atualFgMeta.width, height: atualFgMeta.height, channels: 3, background: corFundoAtual } }).png().toBuffer();
  console.log(`[icone] atual: iOS AppIcon-512@2x.png (1024, sem alpha) · Android foreground ${atualFgMeta.width}px sobre ${corFundoAtual}`);

  // 3) A folha.
  const colunas = [
    { rotulo: 'Atual', ios: atualIOS, android: await androidVisivel(atualBg, atualFg) },
    ...(await Promise.all(VARIANTES.map(async (v) => ({
      rotulo: `${v.id} · ${v.nome}`,
      ios: mestres[v.id].ios,
      android: await androidVisivel(mestres[v.id].abg, mestres[v.id].afg),
    })))),
  ];

  const MARGEM = 48;
  const COL = 300;
  const largura = MARGEM * 2 + COL * colunas.length;
  const grupos = [
    { plataforma: 'ios', tema: 'escuro', titulo: 'iOS · 60 pt (180 px) · papel de parede escuro' },
    { plataforma: 'ios', tema: 'claro', titulo: 'iOS · 60 pt (180 px) · papel de parede claro' },
    { plataforma: 'android', tema: 'escuro', titulo: 'Android · 48 dp (144 px) · máscara circular · papel de parede escuro' },
    { plataforma: 'android', tema: 'claro', titulo: 'Android · 48 dp (144 px) · máscara circular · papel de parede claro' },
  ];
  const TITULO_H = 64;
  const CABECALHO_H = 44;
  const GRUPO_TITULO_H = 30;
  const GRUPO_GAP = 22;
  const painelAltura = (p) => (p === 'ios' ? IOS_PX + IOS_ROTULO + 96 : ANDROID_PX + ANDROID_ROTULO + 96);
  const altura = MARGEM + TITULO_H + CABECALHO_H
    + grupos.reduce((s, g) => s + GRUPO_TITULO_H + painelAltura(g.plataforma) + GRUPO_GAP, 0)
    + MARGEM - GRUPO_GAP;

  const camadas = [];
  const textos = [];
  let y = MARGEM + TITULO_H + CABECALHO_H;
  for (const g of grupos) {
    const ph = painelAltura(g.plataforma);
    textos.push(`<text x="${MARGEM}" y="${y + 20}" font-family="${FONTE}" font-size="16" fill="#cfcfd6">${g.titulo}</text>`);
    y += GRUPO_TITULO_H;
    camadas.push({ input: await sharp(papelDeParede(largura - MARGEM * 2, ph, g.tema)).png().toBuffer(), left: MARGEM, top: y });

    const tamanho = g.plataforma === 'ios' ? IOS_PX : ANDROID_PX;
    const rotuloPx = g.plataforma === 'ios' ? IOS_ROTULO : ANDROID_ROTULO;
    for (let i = 0; i < colunas.length; i += 1) {
      const c = colunas[i];
      const icone = await mascara(g.plataforma === 'ios' ? c.ios : c.android, tamanho, g.plataforma);
      const x = MARGEM + COL * i + Math.round((COL - tamanho) / 2);
      const top = y + 40;
      camadas.push({ input: icone, left: x, top });
      // "Futty" como no celular: iOS branco com sombra (em qualquer papel);
      // Android branco no escuro, quase-preto no claro.
      const tx = x + tamanho / 2;
      const ty = top + tamanho + 14 + rotuloPx;
      const claro = g.tema === 'claro';
      const cor = g.plataforma === 'ios' || !claro ? '#ffffff' : '#1f1f24';
      if (g.plataforma === 'ios') {
        textos.push(`<text x="${tx + 1}" y="${ty + 1}" text-anchor="middle" font-family="${FONTE}" font-size="${rotuloPx}" font-weight="500" fill="#000" fill-opacity="0.55">Futty</text>`);
      }
      textos.push(`<text x="${tx}" y="${ty}" text-anchor="middle" font-family="${FONTE}" font-size="${rotuloPx}" font-weight="500" fill="${cor}">Futty</text>`);
    }
    y += ph + GRUPO_GAP;
  }

  const cabecalhos = colunas.map((c, i) =>
    `<text x="${MARGEM + COL * i + COL / 2}" y="${MARGEM + TITULO_H + 26}" text-anchor="middle" font-family="${FONTE}" font-size="19" font-weight="600" fill="#f0c94a">${c.rotulo}</text>`).join('\n');
  const sobreposicao = `<svg xmlns="http://www.w3.org/2000/svg" width="${largura}" height="${altura}">
  <text x="${MARGEM}" y="${MARGEM + 26}" font-family="${FONTE}" font-size="24" font-weight="700" fill="#ffffff">Ícone do app — 3 variantes vs atual, nos tamanhos reais de tela inicial</text>
  <text x="${MARGEM}" y="${MARGEM + 50}" font-family="${FONTE}" font-size="14" fill="#9a9aa6">F = o mesmo asset vetorial de sempre; só o tratamento muda. Sem IA, sem imagem baixada. 1 px da folha = 1 px de tela @3x.</text>
  ${cabecalhos}
  ${textos.join('\n  ')}
</svg>`;

  const folha = path.join(OUT, 'folha.png');
  await sharp({ create: { width: largura, height: altura, channels: 3, background: '#26262c' } })
    .composite([...camadas, { input: Buffer.from(sobreposicao), left: 0, top: 0 }])
    .png()
    .toFile(folha);
  arquivos.push({ nome: 'folha.png', bytes: fs.statSync(folha).size, canais: 3, alpha: false });

  console.log(`\n[icone] saída em ${OUT}`);
  for (const a of arquivos) {
    console.log(`  ${a.nome.padEnd(34)} ${String(a.bytes).padStart(9)} bytes  ${a.canais} canais${a.alpha ? ' (alpha)' : ' (sem alpha)'}`);
  }
  console.log(`\n[icone] folha: ${largura}×${altura} — iOS ${IOS_PX} px (rótulo ${IOS_ROTULO} px), Android ${ANDROID_PX} px (rótulo ${ANDROID_ROTULO} px)`);
}

gerar().catch((e) => {
  console.error('[testar-icone] falhou:', e.message);
  process.exit(1);
});
