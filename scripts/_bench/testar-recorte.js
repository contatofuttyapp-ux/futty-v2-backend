// ═══════════════════════════════════════════════════════════════════════════════
// BANCADA "FIGURINHA GRÁTIS SEM IA" (22-set) — recorte + sharp, nada generativo.
//
// Decisão em estudo (dono, 22-set): a figurinha GRÁTIS passa a ser o recorte da
// foto real; a arte IA fica só para quem paga. Esta bancada mostra, nas 7 fotos
// da BANCADA-FOTOS, como fica a figurinha grátis feita só com o birefnet
// (US$0,002) e processamento nosso — e quanto custa e demora cada acabamento.
//
// ETAPAS POR FOTO
//   0  recorte: birefnet da fal sobre a foto auto-orientada (custo e tempo
//      registados). Enquadramento de BUSTO: da coroa (1ª linha opaca) até meio
//      do peito, centrado, 8% de folga em cima, no canvas 1024×1536 — a coroa
//      nunca é cortada, por construção.
//   1  "crua"       só o recorte na moldura da casa, fundo Estádio, placa+nome
//   2  "impressão"  + acabamento de figurinha impressa (posterização 10 níveis,
//                   contraste +10%, saturação +8%, grão fino, borda 1-2 px)
//   3  "pintura"    + o mais perto que o sharp chega da V6 sem IA (mediana,
//                   unsharp forte, posterização 8, rim light pelo alpha, vinheta)
//   4  "cabeça no busto": a cabeça da pessoa sobre o busto sem cabeça do kit
//                   (assets/busto-<kit>.png), emenda em pluma, a gola por cima,
//                   a pele do busto (braços e V, assets/busto-<kit>-pele.png)
//                   tingida para a mediana da pele do rosto da pessoa com luz e
//                   sombra preservadas, acabamento 3 sobre o conjunto. Com
//                   --dois-kits sai também no dark-purple (4-<kit>.png +
//                   uniformes.png lado a lado): o busto de um kit gera-se UMA
//                   vez (US$0,05, do modelo fictício) e trocar depois custa zero.
//   5  (cópia) V6, de saida-prompt/<foto>/6.png
//   6  (cópia) duas passadas — a produção de hoje, de saida-economia/<foto>/3.png
//   As cópias 5/6 escolhem a pasta pelo CONTEÚDO (assinatura da foto para a
//   saida-prompt, descritor de rosto contra o 3.png para a saida-economia):
//   duas fotos partilham o nome de pasta e as bancadas anteriores deram o
//   sufixo _2 por outra ordem.
//
// ONDE ESTÁ O PESCOÇO. Sem IA, o pescoço acha-se pela geometria do alpha: a
// cabeça é a parte mais larga no topo e o pescoço é o mínimo de largura logo
// abaixo. Com o detector de rosto (@vladmandic/face-api em WASM, instalado como
// devDependency — nunca vai para a imagem de produção) a linha do pescoço vem
// da caixa do rosto (queixo + ~22% da altura), que é mais estável quando há
// braços levantados ou cabelo volumoso. Os dois são medidos e registados; o do
// rosto manda quando existe.
//
// CORRER (a partir de FUTTY-V2/backend):
//   node scripts/_bench/testar-recorte.js --so-um             só o Gui
//   node scripts/_bench/testar-recorte.js --resto             as outras 6
//   --foto a,b         só as fotos cujo nome começa por um destes prefixos
//   --dois-kits        célula 4 em dark-gold E dark-purple (+ uniformes.png)
//   --teto 0.20        tecto de gasto (omissão US$0,20)
//   --sem-rosto        não usa o detector de rosto (só geometria do alpha)
//   --refazer-busto    regenera assets/busto-<kit>.png (+ -pele.png, .json)
//
// Custo: US$0,002 por foto (um birefnet). O busto de um kit pago custa US$0,05
// UMA vez (fica em assets/); correr de novo não paga nada por ele.
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { supabase } = require('../../utils/db');
const { chamarFal, emDolares } = require('../../utils/falFila');
const { topoDaPele, preprocessarQuadrado } = require('../../utils/entradaFigurinha');
// A receita de produção, só para gerar UMA vez o busto de cada kit pago
// (US$0,05 cada) a partir do modelo fictício da conta demo — nunca de uma
// pessoa real, para não contaminar a cara (regra de 17-set).
const { gerarFigurinha } = require('../../utils/geracaoFigurinha');
const { baixar, achatamento, molduraSVG, folhaDeContato, mulberry32, paraCsv, lerKit } = require('./comum');

const SAIDA = path.join(__dirname, 'saida-recorte');
const DA_V6 = path.join(__dirname, 'saida-prompt');       // 6.png = V6
const DAS_2P = path.join(__dirname, 'saida-economia');    // 3.png = duas passadas (produção)
const ASSETS = path.join(__dirname, 'assets');
const BUSTO_FONTE_GOLD = path.join(__dirname, 'saida-producao', 'prova-real-2026-09-17-dark-gold.png');
// O modelo fictício da conta demo: é dele que se gera o busto dos kits que
// ainda não têm figurinha guardada (adendo b: dark-purple).
const FOTO_MODELO = path.join(__dirname, 'estado-demo', 'foto-silhueta-original.jpg');
const caminhoAsset = (kit, sufixo = '') => path.join(ASSETS, `busto-${kit}${sufixo}`);
// Todos os bustos à mesma altura: o de 17-set tem 680 px, e é essa a escala
// em que as medidas (pescoço, gola, pluma) foram afinadas.
const ALTURA_BUSTO = 680;
const FOTOS = path.join(__dirname, '..', '..', '..', '..', 'BANCADA-FOTOS');
const ESTADIO = path.join(__dirname, '..', '..', '..', 'frontend', 'public', 'stadium_bg.webp');
const MODELOS_ROSTO = path.join(__dirname, '..', '..', 'node_modules', '@vladmandic', 'face-api', 'model');
const FOTO_TRIAGEM = 'Gui.jpeg';
const BIREFNET = 'fal-ai/birefnet';

// O canvas de trabalho é o mesmo 2:3 da figurinha (1024×1536); o card sai a
// 512×768 como nas outras bancadas, para a folha comparar com a V6 lado a lado.
const CANVAS = { w: 1024, h: 1536 };
const CARD = { w: 512, h: 768 };
const FOLGA_TOPO = 0.08;

// Os parâmetros finais dos acabamentos — afinados olhando o Gui, registados no
// CSV e no relatório. Mudar aqui muda em todas as fotos.
// Afinação (Gui, 3ª corrida): posterizar RGB a 8-10 níveis deslocava a pele
// para rosa/salmão e lavava a pintura — 12 níveis segura a cor; a "pintura"
// precisava de contraste e saturação de volta e de um rim light mais largo e
// menos forte para ler como luz, não como contorno.
const IMPRESSAO = { niveis: 12, contraste: 1.06, saturacao: 1.04, graoAlpha: 0.10, graoAmp: 30, bordaBlur: 1.4 };
// contraste com pivô a 160 (não no cinza médio): pele ao sol já anda nos 230-245
// e um pivô a 128 empurrava-a para o branco (4ª corrida: pintura pálida).
const PINTURA = {
  mediana: 5, unsharp: { sigma: 2.4, m1: 1.6, m2: 3.5 }, niveis: 12, contraste: 1.08, pivo: 160, saturacao: 1.28, brilho: 0.94,
  rimLargura: 9, rimCor: { r: 255, g: 230, b: 160 }, rimAlpha: 0.5, vinheta: 0.35, bordaBlur: 1.0,
};
// Emenda cabeça/busto: a pessoa desce até `sobGola` px abaixo da gola do busto
// (a gola volta por cima como última camada e esconde a pluma), a pluma tem
// `pluma` px, e a pele do modelo que sobra no V da gola é recolorida com a
// pele média do pescoço da pessoa, até `vAltura` px abaixo da gola.
const EMENDA = { pluma: 16, sobGola: 6, vAltura: 70 };

const arg = (n, o = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : o;
};
const tem = (n) => process.argv.includes(`--${n}`);
const ms = (t) => Date.now() - t;

// ─── Storage: a fal só lê URL público ────────────────────────────────────────
async function subir(caminho, buffer, tipo, temporarios) {
  const { error } = await supabase.storage.from('kits').upload(caminho, buffer, { contentType: tipo, upsert: true });
  if (error) throw new Error(`upload ${caminho}: ${error.message}`);
  temporarios.push(caminho);
  const { data: pub } = supabase.storage.from('kits').getPublicUrl(caminho);
  return `${pub.publicUrl}?v=${Date.now()}`;
}

// ─── Alpha: perfil por linha, caixa, pescoço ─────────────────────────────────
/** RGBA cru + largura opaca por linha (alpha > 128) com esquerda/direita. */
async function perfil(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const linhas = new Array(h);
  for (let y = 0; y < h; y += 1) {
    let n = 0; let l = -1; let r = -1;
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * c + 3] > 128) { n += 1; if (l < 0) l = x; r = x; }
    }
    linhas[y] = { n, l, r };
  }
  return { data, w, h, c, linhas };
}

/** Caixa do alpha (limiar 10) — o que o trim do sharp faria, mas com os offsets. */
async function caixaDoAlpha(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * c + 3] > 10) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('recorte vazio (o birefnet não achou ninguém)');
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, w, h };
}

/**
 * Pescoço pela geometria do alpha (recorte já trimado, coroa em y=0): a cabeça é
 * a linha mais larga nos primeiros 22% (ou dentro da caixa do rosto, se houver);
 * o pescoço é o mínimo de largura entre essa linha e 1,3× a largura da cabeça
 * mais abaixo (antes dos ombros). Devolve tudo em pixels do recorte.
 */
/**
 * O trecho CONTÍNUO de pixels opacos que passa por (cx, y): anda para a
 * esquerda e para a direita até o alpha cair. É a largura do pescoço de
 * verdade — a largura da linha inteira somava braços levantados, copos e
 * ombros (6ª corrida: Renato "pescoço" de 1071 px, cabeça a 0,09 de escala).
 */
function trecho(p, y, cx) {
  const { data, w, c } = p;
  const opaco = (x) => x >= 0 && x < w && data[(y * w + x) * c + 3] > 128;
  let x0 = Math.round(cx);
  if (!opaco(x0)) {
    // O centro pode cair num furo (óculos, colar): procura o opaco mais perto.
    let d = 1; while (d < w && !opaco(x0 - d) && !opaco(x0 + d)) d += 1;
    if (d >= w) return { n: 0, l: x0, r: x0 };
    x0 = opaco(x0 - d) ? x0 - d : x0 + d;
  }
  let l = x0; while (opaco(l - 1)) l -= 1;
  let r = x0; while (opaco(r + 1)) r += 1;
  return { n: r - l + 1, l, r };
}

function pescocoPorAlpha(p, rosto) {
  const { linhas, h } = p;
  const lim = (v) => Math.max(0, Math.min(h - 1, Math.round(v)));
  const fim = rosto ? lim(rosto.y + rosto.h * 0.85) : Math.round(h * 0.22);
  let yCabeca = 0;
  for (let y = 0; y <= fim; y += 1) if (linhas[y].n > linhas[yCabeca].n) yCabeca = y;
  const largCabeca = linhas[yCabeca].n;
  // O eixo do pescoço: o centro do rosto, ou o centro da linha mais larga da cabeça.
  const cx = rosto ? rosto.x + rosto.w / 2 : (linhas[yCabeca].l + linhas[yCabeca].r) / 2;
  // Janela da busca do mínimo. Com rosto: do queixo (95% da caixa) até 150% —
  // o rosto LIMITA a busca, não decide a linha (uma linha fixa a 122% caiu nos
  // ombros do Gui e a cabeça saiu a 0,23 de escala). Sem rosto: da linha mais
  // larga da cabeça até 1,3× a largura dela mais abaixo, antes dos ombros.
  const de = rosto ? lim(rosto.y + rosto.h * 0.95) : yCabeca;
  const ate = rosto ? lim(rosto.y + rosto.h * 1.5) : lim(yCabeca + largCabeca * 1.3);
  let melhor = null;
  for (let y = de; y <= ate; y += 1) {
    const t = trecho(p, y, cx);
    if (t.n > 0 && (!melhor || t.n < melhor.n)) melhor = { y, ...t };
  }
  if (!melhor) melhor = { y: de, ...trecho(p, de, cx) };
  // Com rosto, a largura do alpha só vale se for plausível para um pescoço
  // (0,45-1,1 × a largura do rosto). Numa foto de grupo a linha do queixo é
  // contígua aos vizinhos (Renato: 1071 px) e o trecho não chega — aí manda a
  // anatomia: pescoço ≈ 0,78 × rosto, na linha do queixo + 8% e no eixo do rosto.
  if (rosto && (melhor.n > rosto.w * 1.1 || melhor.n < rosto.w * 0.45)) {
    return { yCabeca, largCabeca, yPescoco: lim(rosto.y + rosto.h * 1.08), largPescoco: Math.round(rosto.w * 0.78), cxPescoco: cx, larguraDe: 'rosto (0,78×)' };
  }
  return { yCabeca, largCabeca, yPescoco: melhor.y, largPescoco: melhor.n, cxPescoco: (melhor.l + melhor.r) / 2, larguraDe: 'alpha' };
}

// ─── Detector de rosto (opcional) ────────────────────────────────────────────
let rostoApi = null;
async function carregarRosto() {
  if (tem('sem-rosto')) return null;
  const t0 = Date.now();
  try {
    const fa = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
    const wasm = require('@tensorflow/tfjs-backend-wasm');
    wasm.setWasmPaths(`${path.join(require.resolve('@tensorflow/tfjs-backend-wasm'), '..')}/`);
    await fa.tf.setBackend('wasm');
    await fa.tf.ready();
    await fa.nets.ssdMobilenetv1.loadFromDisk(MODELOS_ROSTO);
    console.log(`detector de rosto: @vladmandic/face-api ${fa.version} · backend ${fa.tf.getBackend()} · carregado em ${ms(t0)} ms`);
    return fa;
  } catch (e) {
    console.log(`detector de rosto indisponível (${e.message.split('\n')[0].slice(0, 90)}) — sigo só com o alpha`);
    return null;
  }
}

/** Caixa do rosto na foto orientada (coordenadas da foto), com tempo e CPU. */
async function detectarRosto(fa, orientado) {
  const t0 = Date.now(); const c0 = process.cpuUsage();
  const m = await sharp(orientado).metadata();
  const { data, info } = await sharp(orientado).resize({ width: 512 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const tensor = fa.tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');
  const dets = await fa.detectAllFaces(tensor, new fa.SsdMobilenetv1Options({ minConfidence: 0.4 }));
  tensor.dispose();
  const cpu = process.cpuUsage(c0);
  const esc = m.width / info.width;
  // O maior rosto é o dono da foto (as fotos de grupo têm gente ao fundo).
  const d = dets.sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
  return {
    ms: ms(t0), cpuMs: Math.round((cpu.user + cpu.system) / 1000), n: dets.length,
    caixa: d ? { x: d.box.x * esc, y: d.box.y * esc, w: d.box.width * esc, h: d.box.height * esc, score: d.score } : null,
  };
}

// ─── O busto sem cabeça (asset) ──────────────────────────────────────────────
/**
 * Apaga a cabeça da figurinha de produção de 17-set acima da gola, com pluma, e
 * guarda em assets/. A gola é onde a largura dispara depois do pescoço (o V da
 * camisa começa nos ombros): pescoço = mínimo entre 20% e 50% da altura, gola =
 * primeira linha abaixo com largura > 1,5× o pescoço. Devolve as medidas que a
 * emenda precisa (linha e largura do pescoço, centro, linha da gola).
 */
/**
 * Pele com regra ESTRITA — a `ehPele` de utils/entradaFigurinha.js aceita o
 * dourado do kit (r > g > b, saturado): para a máscara de pele do busto e para
 * a amostra do rosto exige-se ainda azul relativo (b/r > 0,42) e saturação
 * abaixo de 0,62. Dourado (200,160,40) fica de fora; pele clara (220,170,140)
 * e pele escura (140,90,60) entram.
 */
const ehPeleEstrita = (r, g, b) => {
  if (!ehPele(r, g, b)) return false;
  const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
  // O que separa pele de dourado é o MATIZ, não a saturação: os realces do
  // painel dourado (230,190,120) são tão pouco saturados como pele clara.
  // Medido no busto: pele 18-22° (braço 193,118,81 → 19°; V 216,155,121 →
  // 21°), dourado 36-38° (188,130,43 → 36°). Corte a 30°.
  const matiz = 60 * (g - b) / Math.max(1, r - b); // r > g > b garantido pela ehPele
  return matiz < 30 && (mx - mn) / mx < 0.70;
};

/**
 * O busto de um kit, sem cabeça, com a máscara de pele (braços + V) e as
 * medidas guardadas ao lado: assets/busto-<kit>.png, -pele.png, .json. Só se
 * gera quando falta ou com --refazer-busto; `obterFonte()` devolve a figurinha
 * COM cabeça (PNG com alpha) — do ficheiro de 17-set no dark-gold, de uma
 * geração real no resto. Todas as fontes são trimadas e postas a 680 px de
 * altura, a escala em que as medidas foram afinadas.
 */
async function garantirBusto(kit, obterFonte) {
  fs.mkdirSync(ASSETS, { recursive: true });
  const BUSTO = caminhoAsset(kit, '.png'); const PELE = caminhoAsset(kit, '-pele.png'); const JSON_ = caminhoAsset(kit, '.json');
  if (fs.existsSync(BUSTO) && fs.existsSync(PELE) && fs.existsSync(JSON_) && !tem('refazer-busto')) {
    const medidas = JSON.parse(fs.readFileSync(JSON_, 'utf8'));
    // A máscara lê-se pelo 1º canal, seja qual for o número de canais do PNG.
    const { data, info } = await sharp(PELE).raw().toBuffer({ resolveWithObject: true });
    const mascara = Buffer.alloc(info.width * info.height);
    for (let i = 0; i < mascara.length; i += 1) mascara[i] = data[i * info.channels];
    return { kit, buf: fs.readFileSync(BUSTO), mascara, ...medidas };
  }
  const fonteCrua = await obterFonte();
  const fonte = await sharp(fonteCrua).ensureAlpha().trim({ threshold: 10 }).resize({ height: ALTURA_BUSTO }).png().toBuffer();
  fs.writeFileSync(caminhoAsset(kit, '-fonte.png'), fonte);
  const p = await perfil(fonte);
  const { w, h, linhas } = p;
  let yPescoco = Math.round(h * 0.2);
  for (let y = Math.round(h * 0.2); y < Math.round(h * 0.5); y += 1) if (linhas[y].n > 0 && linhas[y].n < linhas[yPescoco].n) yPescoco = y;
  const largPescoco = linhas[yPescoco].n;
  const cxPescoco = (linhas[yPescoco].l + linhas[yPescoco].r) / 2;
  let yGola = yPescoco;
  while (yGola < h - 1 && linhas[yGola].n < largPescoco * 1.5) yGola += 1;
  const medidas = { w, h, yPescoco, largPescoco, cxPescoco, yGola, pluma: EMENDA.pluma };

  // Tudo acima da gola sai (cabeça E pescoço do modelo): alpha 0 até 2 px
  // acima da gola, rampa de `pluma` px a partir daí. Multiplicado em JS — um
  // composite 'multiply' de 1 canal no libvips não fez nada na 1ª corrida.
  const alphaNovo = await sharp(fonte).extractChannel(3).raw().toBuffer();
  for (let y = 0; y < h; y += 1) {
    const t = Math.max(0, Math.min(1, (y - (yGola - 2)) / EMENDA.pluma));
    if (t < 1) for (let x = 0; x < w; x += 1) alphaNovo[y * w + x] = Math.round(alphaNovo[y * w + x] * t);
  }
  const busto = await comAlpha(fonte, alphaNovo, w, h);
  fs.writeFileSync(BUSTO, busto);

  // Máscara de pele do busto (braços e o V da gola): pele estrita sobre o
  // busto já sem cabeça, limpa de salpicos (desfoque + limiar) e com borda
  // macia de ~1,5 px para o tingimento não cortar a seco.
  const pb = await perfil(busto);
  const bruta = Buffer.alloc(w * h);
  let nBruta = 0;
  for (let i = 0; i < w * h; i += 1) {
    if (pb.data[i * 4 + 3] > 128 && ehPeleEstrita(pb.data[i * 4], pb.data[i * 4 + 1], pb.data[i * 4 + 2])) { bruta[i] = 255; nBruta += 1; }
  }
  // Limiar em JS: o .threshold() do sharp sobre um raw de 1 canal devolveu
  // zero (achado do adendo, "pele 0 px"); o desfoque de 1 canal funciona.
  const cinza = (buf) => sharp(buf, { raw: { width: w, height: h, channels: 1 } });
  const desfocada = await cinza(bruta).blur(1.2).raw().toBuffer();
  const limpa = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i += 1) limpa[i] = desfocada[i] >= 120 ? 255 : 0;
  let mascara = await cinza(limpa).blur(1.5).raw().toBuffer();
  if (nBruta && !mascara.some((v) => v > 128)) mascara = bruta; // rede: se a limpeza comer tudo, fica a bruta
  await cinza(mascara).toColourspace('b-w').png().toFile(PELE);
  fs.writeFileSync(JSON_, JSON.stringify(medidas, null, 2));

  // Prova visual: o busto sobre cinza, as linhas do pescoço e da gola, e a
  // máscara de pele a vermelho translúcido.
  const vermelho = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) { vermelho[i * 4] = 255; vermelho[i * 4 + 1] = 40; vermelho[i * 4 + 2] = 40; vermelho[i * 4 + 3] = Math.round(mascara[i] * 0.45); }
  const guia = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <line x1="0" y1="${yPescoco}" x2="${w}" y2="${yPescoco}" stroke="#ff4d4d" stroke-width="1"/>
    <line x1="0" y1="${yGola}" x2="${w}" y2="${yGola}" stroke="#4dff88" stroke-width="1"/>
    <text x="4" y="${yPescoco - 4}" fill="#ff4d4d" font-size="11" font-family="Arial">pescoço ${largPescoco}px</text>
    <text x="4" y="${yGola + 12}" fill="#4dff88" font-size="11" font-family="Arial">gola (pluma ${EMENDA.pluma}px) · vermelho = máscara de pele</text>
  </svg>`);
  await sharp({ create: { width: w, height: h, channels: 3, background: '#8a8a8a' } })
    .composite([{ input: busto }, { input: vermelho, raw: { width: w, height: h, channels: 4 } }, { input: guia }])
    .png().toFile(caminhoAsset(kit, '-prova.png'));
  const pelePx = mascara.reduce((s, v) => s + (v > 128 ? 1 : 0), 0);
  console.log(`busto ${kit}: ${path.relative(process.cwd(), BUSTO)} · ${w}x${h} · pescoço y=${yPescoco} (${largPescoco}px, cx ${cxPescoco.toFixed(0)}) · gola y=${yGola} · pele ${pelePx} px`);
  return { kit, buf: busto, mascara, ...medidas };
}

/** A fonte do busto dark-purple: UMA geração real (receita de produção) do modelo fictício. */
async function gerarFonteDoKit(kit, temporarios, custos) {
  const k = lerKit(kit);
  const quadrada = await preprocessarQuadrado(fs.readFileSync(FOTO_MODELO));
  const fotoUrl = await subir(`tmp-recorte/busto-modelo-${kit}.jpg`, quadrada, 'image/jpeg', temporarios);
  const t0 = Date.now();
  const r = await gerarFigurinha({
    fotoUrl, kitUrl: k.url, kitId: kit, etiqueta: `busto-${kit}`,
    publicar: (nome, buf, tipo) => subir(`tmp-recorte/${nome}`, buf, tipo, temporarios),
  });
  custos.push({ o: `busto ${kit} (geração real)`, usd: r.custo.usd, segundos: Math.round((Date.now() - t0) / 1000) });
  console.log(`busto ${kit}: figurinha gerada em ${Math.round((Date.now() - t0) / 1000)}s · US$${r.custo.usd.toFixed(4)} (${r.custo.chamadas} chamadas)`);
  return r.recorteBuffer;
}

/**
 * Tom de pele da pessoa: MEDIANA por canal dos pixels de pele estrita no rosto
 * (a caixa do detector; sem ela, a cabeça até ao pescoço). null se houver
 * menos de 100 amostras — não se tinge com um palpite.
 */
async function tomDePele(recorte, rosto, yPescoco) {
  const p = await perfil(recorte);
  const x0 = rosto ? Math.max(0, Math.round(rosto.x)) : 0;
  const x1 = rosto ? Math.min(p.w, Math.round(rosto.x + rosto.w)) : p.w;
  const y0 = rosto ? Math.max(0, Math.round(rosto.y)) : 0;
  const y1 = rosto ? Math.min(p.h, Math.round(rosto.y + rosto.h)) : Math.min(p.h, yPescoco);
  // Na caixa do rosto não há camisa: chega a ehPele normal (a estrita, por
  // matiz, deixaria de fora peles mais amareladas e a mediana ficava enviesada).
  const R = []; const G = []; const B = [];
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
    const i = (y * p.w + x) * 4;
    if (p.data[i + 3] > 200 && ehPele(p.data[i], p.data[i + 1], p.data[i + 2])) { R.push(p.data[i]); G.push(p.data[i + 1]); B.push(p.data[i + 2]); }
  }
  if (R.length < 100) return null;
  const med = (a) => { a.sort((u, v) => u - v); return a[a.length >> 1]; };
  return { r: med(R), g: med(G), b: med(B), amostras: R.length };
}

/**
 * Tinge a pele do busto (braços e V) para o tom da pessoa PRESERVANDO luz e
 * sombra: cada pixel de pele mantém a razão entre a sua luminância e a
 * luminância média da pele do busto, e recebe a cor da pessoa multiplicada por
 * essa razão — muda o matiz e a luminosidade média, não o relevo.
 */
async function tingirPele(busto, cor) {
  const { w, h, mascara } = busto;
  const p = await perfil(busto.buf);
  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  let soma = 0; let peso = 0;
  for (let i = 0; i < w * h; i += 1) if (mascara[i] > 0) { soma += lum(p.data[i * 4], p.data[i * 4 + 1], p.data[i * 4 + 2]) * mascara[i]; peso += mascara[i]; }
  const lumBusto = peso ? soma / peso : 128;
  const out = Buffer.from(p.data);
  for (let i = 0; i < w * h; i += 1) {
    const m = mascara[i] / 255;
    if (m <= 0) continue;
    const f = lum(p.data[i * 4], p.data[i * 4 + 1], p.data[i * 4 + 2]) / Math.max(1, lumBusto);
    const alvo = [cor.r * f, cor.g * f, cor.b * f];
    for (let c = 0; c < 3; c += 1) out[i * 4 + c] = Math.round(Math.max(0, Math.min(255, p.data[i * 4 + c] * (1 - m) + alvo[c] * m)));
  }
  return sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

// ─── Enquadramento de busto no canvas 1024×1536 ──────────────────────────────
// A placa do nome cobre a base do card: começa a 86% da altura (placaTopo em
// figurinhaCanvas.js = H − 84k). O "meio do peito" tem de cair DEBAIXO dela —
// é assim que o card real esconde a linha de corte do avatar.
const LINHA_PLACA = 0.86;

/**
 * Da coroa (y=0 do recorte trimado) até meio do peito, centrado, com FOLGA_TOPO
 * em cima. Meio do peito = pescoço + 1,1 × altura da cabeça (coroa→pescoço). A
 * escala é a que põe a coroa a 8% e o meio do peito na linha da placa; o que a
 * foto tiver abaixo do meio do peito entra também, até ao fundo do canvas
 * (fica escondido pela placa, como no app). Se a pessoa for larga demais para
 * caber, manda a largura — e o busto sobe um pouco acima da placa.
 */
async function enquadrarBusto(recorte, neck) {
  const p = await perfil(recorte);
  const alturaCabeca = Math.max(20, neck.yPescoco);
  const yPeito = Math.min(p.h, Math.round(neck.yPescoco + alturaCabeca * 1.1));
  const escAltura = (CANVAS.h * (LINHA_PLACA - FOLGA_TOPO)) / yPeito;
  // Até onde a foto vai, no canvas: o que couber abaixo do peito até ao fundo.
  const yFim = Math.min(p.h, Math.round(yPeito + (CANVAS.h * (1 - LINHA_PLACA)) / escAltura));
  // Caixa horizontal só das linhas que entram (braços abertos mais abaixo não contam).
  let l = p.w; let r = -1;
  for (let y = 0; y < yFim; y += 1) if (p.linhas[y].n) { l = Math.min(l, p.linhas[y].l); r = Math.max(r, p.linhas[y].r); }
  const largura = r - l + 1;
  const esc = Math.min(escAltura, (CANVAS.w * 0.94) / largura);
  const faixa = await sharp(recorte).extract({ left: l, top: 0, width: largura, height: yFim }).png().toBuffer();
  const jogador = await sharp(faixa).resize({ width: Math.max(1, Math.round(largura * esc)), height: Math.max(1, Math.round(yFim * esc)), fit: 'fill' }).png().toBuffer();
  const mj = await sharp(jogador).metadata();
  // O que passar do fundo do canvas é cortado (o composite recusa imagem maior que a base).
  const alturaVisivel = Math.min(mj.height, CANVAS.h - Math.round(CANVAS.h * FOLGA_TOPO));
  const jogadorCortado = alturaVisivel < mj.height
    ? await sharp(jogador).extract({ left: 0, top: 0, width: mj.width, height: alturaVisivel }).png().toBuffer()
    : jogador;
  const canvas = await sharp({ create: { width: CANVAS.w, height: CANVAS.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: jogadorCortado, left: Math.round((CANVAS.w - mj.width) / 2), top: Math.round(CANVAS.h * FOLGA_TOPO) }])
    .png().toBuffer();
  return { canvas, yFim, yPeito, escala: esc, altura: alturaVisivel };
}

// ─── Acabamentos (sharp) ─────────────────────────────────────────────────────
/** Posteriza R, G e B em `niveis` níveis; o alpha fica. */
async function posterizar(buf, niveis) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const passo = 255 / (niveis - 1);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.round(Math.round(data[i] / passo) * passo);
    data[i + 1] = Math.round(Math.round(data[i + 1] / passo) * passo);
    data[i + 2] = Math.round(Math.round(data[i + 2] / passo) * passo);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** Grão fino, reproduzível (mulberry32), composto em overlay com alpha baixo. */
async function grao(buf, alpha, amp, semente = 17) {
  const m = await sharp(buf).metadata();
  const rnd = mulberry32(semente);
  const g = Buffer.alloc(m.width * m.height * 4);
  for (let i = 0; i < g.length; i += 4) {
    const v = Math.max(0, Math.min(255, Math.round(128 + (rnd() - 0.5) * 2 * amp)));
    g[i] = v; g[i + 1] = v; g[i + 2] = v; g[i + 3] = Math.round(255 * alpha);
  }
  return sharp(buf).composite([{ input: g, raw: { width: m.width, height: m.height, channels: 4 }, blend: 'overlay' }]).png().toBuffer();
}

/**
 * RGB de `buf` + este alpha (raw, 1 canal) → PNG RGBA. Fundido em JS, em raw:
 * no sharp, `removeAlpha()` corre no FIM do pipeline, depois do `joinChannel`,
 * e o alpha juntado era descartado a seguir — medido na 1ª corrida (saía com 3
 * canais e fundo opaco). Raw 4 canais → PNG preserva o alpha (também medido).
 */
async function comAlpha(buf, alpha, w, h) {
  const { data: rgb, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const c = info.channels; // 3 (ou 4 se o removeAlpha não teve efeito — cobre-se na mesma)
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0, n = w * h; i < n; i += 1) {
    out[i * 4] = rgb[i * c]; out[i * 4 + 1] = rgb[i * c + 1]; out[i * 4 + 2] = rgb[i * c + 2]; out[i * 4 + 3] = alpha[i];
  }
  return sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/** Suaviza a borda do recorte: desfoca só o alpha. */
async function suavizarBorda(buf, sigma) {
  const m = await sharp(buf).metadata();
  const alpha = await sharp(buf).ensureAlpha().extractChannel(3).blur(sigma).raw().toBuffer();
  return comAlpha(buf, alpha, m.width, m.height);
}

/** Volta a cortar o RGB pelo alpha original (as operações de cor vazam para o transparente). */
async function refazerAlpha(buf, alphaOriginal, w, h) {
  return comAlpha(buf, alphaOriginal, w, h);
}

async function acabamentoImpressao(buf) {
  const m = await sharp(buf).metadata();
  const alpha = await sharp(buf).ensureAlpha().extractChannel(3).raw().toBuffer();
  let x = await sharp(buf).ensureAlpha()
    .modulate({ saturation: IMPRESSAO.saturacao })
    .linear(IMPRESSAO.contraste, -(IMPRESSAO.contraste - 1) * 128) // contraste em torno do cinza médio
    .png().toBuffer();
  x = await posterizar(x, IMPRESSAO.niveis);
  x = await grao(x, IMPRESSAO.graoAlpha, IMPRESSAO.graoAmp);
  x = await refazerAlpha(x, alpha, m.width, m.height);
  return suavizarBorda(x, IMPRESSAO.bordaBlur);
}

/**
 * Rim light pelo alpha: anel = alpha − alpha erodido (erosão = desfoque +
 * limiar alto), pintado com a cor quente da moldura em "screen", só nas
 * bordas do jogador — o que uma luz de estúdio atrás faria.
 */
async function rimLight(buf, largura, cor, alpha) {
  const m = await sharp(buf).metadata();
  const a = await sharp(buf).ensureAlpha().extractChannel(3).raw().toBuffer();
  const erodido = await sharp(a, { raw: { width: m.width, height: m.height, channels: 1 } }).blur(largura / 2).threshold(245).raw().toBuffer();
  const anel = Buffer.alloc(m.width * m.height * 4);
  for (let i = 0; i < a.length; i += 1) {
    const v = a[i] > 128 && erodido[i] < 128 ? Math.round(255 * alpha) : 0;
    anel[i * 4] = cor.r; anel[i * 4 + 1] = cor.g; anel[i * 4 + 2] = cor.b; anel[i * 4 + 3] = v;
  }
  // O anel desfocado de leve para não parecer contorno de vetor.
  const anelSuave = await sharp(anel, { raw: { width: m.width, height: m.height, channels: 4 } }).blur(1.2).png().toBuffer();
  return sharp(buf).composite([{ input: anelSuave, blend: 'screen' }]).png().toBuffer();
}

async function vinheta(buf, forca) {
  const m = await sharp(buf).metadata();
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${m.width}" height="${m.height}">
    <defs><radialGradient id="v" cx="0.5" cy="0.42" r="0.75">
      <stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${forca}"/>
    </radialGradient></defs>
    <rect width="${m.width}" height="${m.height}" fill="url(#v)"/></svg>`);
  return sharp(buf).composite([{ input: svg, blend: 'multiply' }]).png().toBuffer();
}

async function acabamentoPintura(buf) {
  const m = await sharp(buf).metadata();
  const alpha = await sharp(buf).ensureAlpha().extractChannel(3).raw().toBuffer();
  let x = await sharp(buf).ensureAlpha()
    .median(PINTURA.mediana)
    .sharpen(PINTURA.unsharp)
    .linear(PINTURA.contraste, -(PINTURA.contraste - 1) * PINTURA.pivo)
    .modulate({ saturation: PINTURA.saturacao, brightness: PINTURA.brilho })
    .png().toBuffer();
  x = await posterizar(x, PINTURA.niveis);
  x = await refazerAlpha(x, alpha, m.width, m.height);
  x = await rimLight(x, PINTURA.rimLargura, PINTURA.rimCor, PINTURA.rimAlpha);
  x = await vinheta(x, PINTURA.vinheta);
  x = await refazerAlpha(x, alpha, m.width, m.height);
  return suavizarBorda(x, PINTURA.bordaBlur);
}

// ─── A cabeça no busto do kit ────────────────────────────────────────────────
// A regra de pele de utils/entradaFigurinha.js (não exportada): serve para
// achar a cor média do pescoço da pessoa e para saber que pixels do V recolorir.
const ehPele = (r, g, b) => {
  const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
  return r > 95 && g > 40 && b > 20 && mx - mn > 15 && Math.abs(r - g) > 15 && r > g && r > b;
};

/**
 * Corta a cabeça do recorte da coroa até `sobGola` px abaixo da gola do busto
 * (em coordenadas da pessoa), com pluma na base; escala pela largura do
 * pescoço do busto; assenta o pescoço da pessoa na linha do pescoço do busto e
 * centra pelo centro do pescoço. Três camadas: busto sem cabeça → cabeça com
 * o pescoço da pessoa → a GOLA do busto outra vez por cima (da linha da gola
 * para baixo), que esconde a pluma como um decote esconde o pescoço. A pele do
 * modelo que sobra dentro do V é recolorida com a pele média da pessoa.
 */
async function cabecaNoBusto(recorte, neck, busto, pele) {
  const m = await sharp(recorte).metadata();
  const esc = busto.largPescoco / Math.max(8, neck.largPescoco);
  const yCorte = Math.min(m.height, Math.round(neck.yPescoco + (busto.yGola + EMENDA.sobGola - busto.yPescoco) / esc));
  const cabeca = await sharp(recorte).extract({ left: 0, top: 0, width: m.width, height: yCorte }).png().toBuffer();
  // Pluma na base: alpha × rampa de 1 (yCorte − pluma) a 0 (yCorte), em JS
  // (ver nota em garantirBusto: o multiply de 1 canal no composite não pega).
  // E abaixo da linha do pescoço só fica a FAIXA do pescoço (cx ± 0,6 × largura,
  // borda macia de 10 px): os ombros da pessoa não podem descer com a cabeça —
  // acima da gola o busto está apagado e eles saíam fora da silhueta da camisa
  // (5ª corrida: faixa clara nos ombros do Gui, que está sem camisa).
  const alphaCab = await sharp(cabeca).ensureAlpha().extractChannel(3).raw().toBuffer();
  const meia = neck.largPescoco * 0.6;
  for (let y = neck.yPescoco; y < yCorte; y += 1) {
    const tPluma = y >= yCorte - EMENDA.pluma ? Math.max(0, Math.min(1, (yCorte - y) / EMENDA.pluma)) : 1;
    for (let x = 0; x < m.width; x += 1) {
      const d = Math.abs(x - neck.cxPescoco) - meia; // >0 fora da faixa
      const tFaixa = d <= 0 ? 1 : Math.max(0, 1 - d / 10);
      const i = y * m.width + x;
      alphaCab[i] = Math.round(alphaCab[i] * tPluma * tFaixa);
    }
  }
  // Na faixa, abaixo do 1º quarto (o queixo e a barba ficam de fora), só fica
  // PELE: golas, toalhas e correntes à altura do pescoço entravam na emenda
  // (7ª corrida: Menor K, Renato, sdasad). Salvaguarda para pele escura, que a
  // regra ehPele nem sempre apanha: se menos de 30% da faixa for pele, não
  // se filtra nada — melhor uma gola a mais do que um pescoço a menos.
  {
    const { data: rgb, info } = await sharp(cabeca).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const cc = info.channels;
    const yDe = Math.round(neck.yPescoco + (yCorte - neck.yPescoco) * 0.25);
    let opacos = 0; let pele = 0;
    for (let y = yDe; y < yCorte; y += 1) for (let x = 0; x < m.width; x += 1) {
      const i = y * m.width + x;
      if (alphaCab[i] > 128) { opacos += 1; if (ehPele(rgb[i * cc], rgb[i * cc + 1], rgb[i * cc + 2])) pele += 1; }
    }
    if (opacos && pele / opacos >= 0.3) {
      for (let y = yDe; y < yCorte; y += 1) for (let x = 0; x < m.width; x += 1) {
        const i = y * m.width + x;
        if (alphaCab[i] && !ehPele(rgb[i * cc], rgb[i * cc + 1], rgb[i * cc + 2])) alphaCab[i] = 0;
      }
    }
  }
  const cabecaPluma = await comAlpha(cabeca, alphaCab, m.width, yCorte);

  const cabW = Math.max(1, Math.round(m.width * esc));
  const cabH = Math.max(1, Math.round(yCorte * esc));
  const cabecaEsc = await sharp(cabecaPluma).resize({ width: cabW, height: cabH, fit: 'fill' }).png().toBuffer();
  const left = Math.round(busto.cxPescoco - neck.cxPescoco * esc);
  const top = Math.round(busto.yPescoco - neck.yPescoco * esc);

  // Adendo a: o busto inteiro (braços e V) tingido para o tom de pele da pessoa,
  // luz e sombra preservadas. Sem tom (pele não achada) fica o busto como está.
  const bustoBuf = pele ? await tingirPele(busto, pele) : busto.buf;

  // A GOLA por cima: o busto (já tingido) só da linha da gola para baixo,
  // rampa de 4 px — esconde a pluma da pessoa como um decote esconde o pescoço.
  const pb = await perfil(bustoBuf);
  const gola = Buffer.from(pb.data);
  for (let y = 0; y < Math.min(pb.h, busto.yGola + 2); y += 1) {
    const t = Math.max(0, Math.min(1, (y - (busto.yGola - 2)) / 4));
    for (let x = 0; x < pb.w; x += 1) gola[(y * pb.w + x) * 4 + 3] = Math.round(gola[(y * pb.w + x) * 4 + 3] * t);
  }
  const golaBuf = await sharp(gola, { raw: { width: pb.w, height: pb.h, channels: 4 } }).png().toBuffer();

  // O canvas cresce para onde a cabeça sair: por cima (coroa acima do topo do
  // busto) e para os lados (o recorte da pessoa é largo — ombros, braços — e o
  // sharp recusa compor uma imagem maior que a base ou com offset negativo).
  const extra = Math.max(0, -top);
  const extraEsq = Math.max(0, -left);
  const extraDir = Math.max(0, left + cabW - busto.w);
  const conjunto = await sharp({ create: { width: busto.w + extraEsq + extraDir, height: busto.h + extra, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: bustoBuf, left: extraEsq, top: extra },
      { input: cabecaEsc, left: left + extraEsq, top: top + extra },
      { input: golaBuf, left: extraEsq, top: extra },
    ]).png().toBuffer();
  return { conjunto, escala: esc, left, top, extra, extraEsq, tingido: !!pele };
}

// ─── O card, como o app desenha ──────────────────────────────────────────────
const k = CARD.w / 400;
function octogonoPath(W, H, m) {
  const cut = 32 * k;
  return `M${m + cut},${m} L${W - m - cut},${m} L${W - m},${m + cut} L${W - m},${H - m - cut} L${W - m - cut},${H - m} L${m + cut},${H - m} L${m},${H - m - cut} L${m},${m + cut} Z`;
}
/** Placa do nome como em figurinhaCanvas.js: 74% da largura, 54k de altura, cantos a 45°, borda dourada fina. */
function placaNomeSVG(W, H, nome) {
  const nomeY = H - 42 * k; const placaTopo = nomeY - 42 * k;
  const placaW = W * 0.74; const placaX = (W - placaW) / 2; const placaH = nomeY + 12 * k - placaTopo; const pc = 8 * k;
  const texto = String(nome || 'JOGADOR').toUpperCase();
  // Fit-to-width (regra do dono: o nome nunca é cortado): encolhe até caber.
  let fonte = 46 * k;
  while (texto.length * fonte * 0.62 > placaW * 0.88 && fonte > 22 * k) fonte -= 1;
  const path = `M${placaX + pc},${placaTopo} L${placaX + placaW - pc},${placaTopo} L${placaX + placaW},${placaTopo + pc} L${placaX + placaW},${placaTopo + placaH - pc} L${placaX + placaW - pc},${placaTopo + placaH} L${placaX + pc},${placaTopo + placaH} L${placaX},${placaTopo + placaH - pc} L${placaX},${placaTopo + pc} Z`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <path d="${path}" fill="rgba(5,8,16,0.86)" stroke="rgba(212,160,23,0.5)" stroke-width="${1 * k}"/>
    <text x="${W / 2}" y="${placaTopo + placaH / 2}" text-anchor="middle" dominant-baseline="central"
      font-family="Rajdhani, 'Arial Black', Impact, sans-serif" font-weight="800" font-size="${fonte}" letter-spacing="${1.5 * k}" fill="#f3e6b8">${texto}</text>
  </svg>`);
}

/** Fundo Estádio do app (frontend/public/stadium_bg.webp), com o escurecimento de baixo. */
async function fundoEstadio(W, H) {
  const base = fs.existsSync(ESTADIO)
    ? await sharp(ESTADIO).resize(W, H, { fit: 'cover', position: 'centre' }).png().toBuffer()
    : await sharp({ create: { width: W, height: H, channels: 3, background: '#0a0a12' } }).png().toBuffer();
  const veu = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0.15"/><stop offset="0.55" stop-color="#000" stop-opacity="0.25"/><stop offset="1" stop-color="#000" stop-opacity="0.72"/>
    </linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`);
  return sharp(base).composite([{ input: veu }]).png().toBuffer();
}

/** conteúdo 1024×1536 (alpha) → card 512×768: fundo, sombra, jogador, recorte octogonal, placa+nome, moldura. */
async function montarCard(conteudo, nome) {
  const { w: W, h: H } = CARD;
  const jogador = await sharp(conteudo).resize(W, H, { fit: 'fill' }).png().toBuffer();
  // Sombra: o alpha do jogador desfocado, a 60%, como preto — montado em raw
  // (ver comAlpha: joinChannel não é de confiança aqui).
  const alphaSombra = await sharp(jogador).ensureAlpha().extractChannel(3).blur(10).raw().toBuffer();
  const sombraRgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i += 1) sombraRgba[i * 4 + 3] = Math.round(alphaSombra[i] * 0.6);
  const mascara = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><path d="${octogonoPath(W, H, 8 * k)}" fill="#fff"/></svg>`);
  // UM composite só: no sharp, chamar .composite() duas vezes não acumula — a
  // segunda chamada substitui a primeira (achado na 1ª corrida: o card saía só
  // com o estádio). A lista é aplicada em ordem sobre o resultado acumulado, e
  // o dest-in no fim recorta tudo pelo octógono.
  const dentro = await sharp(await fundoEstadio(W, H))
    .composite([{ input: sombraRgba, raw: { width: W, height: H, channels: 4 }, top: 4, left: 0 }, { input: jogador }, { input: mascara, blend: 'dest-in' }])
    .png().toBuffer();
  return sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: dentro }, { input: placaNomeSVG(W, H, nome) }, { input: await sharp(molduraSVG(W, H)).png().toBuffer() }])
    .png().toBuffer();
}

// ─── As referências (5 e 6) escolhidas pelo CONTEÚDO, não pelo nome ──────────
// Duas fotos da bancada partilham o nome de pasta (`…22d_-` e `…22d_-_2`) e
// as bancadas anteriores atribuíram o sufixo por outra ordem: copiar por nome
// punha a V6 de OUTRA pessoa ao lado do recorte (achado da 7ª corrida — e a
// bancada da economia, que também copiou por nome, já tinha esse cruzamento).
// A assinatura é a foto a 24×24 em cinza; dentro de cada grupo de pastas com o
// mesmo nome base escolhe-se a permutação de menor distância total.
async function assinatura(buf) {
  const { data } = await sharp(buf).rotate().resize(24, 24, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return data;
}
const distancia = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i]); return s / a.length; };
function permutacoes(xs) {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutacoes([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}
/**
 * Descritor de ROSTO (128 números, face-api): a identidade da pessoa, que
 * sobrevive à pintura da figurinha. Serve para a saida-economia, cujo
 * entrada.jpg e 3.png nem sempre são da mesma pessoa (reruns parciais com
 * --foto reatribuíram o sufixo) — só a cara no próprio 3.png diz quem é.
 */
async function descritorDeRosto(fa, buf) {
  if (!fa) return null;
  if (!fa.nets.faceLandmark68Net.isLoaded) await fa.nets.faceLandmark68Net.loadFromDisk(MODELOS_ROSTO);
  if (!fa.nets.faceRecognitionNet.isLoaded) await fa.nets.faceRecognitionNet.loadFromDisk(MODELOS_ROSTO);
  const { data, info } = await sharp(buf).rotate().resize({ width: 512 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const tensor = fa.tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');
  const r = await fa.detectSingleFace(tensor, new fa.SsdMobilenetv1Options({ minConfidence: 0.3 })).withFaceLandmarks().withFaceDescriptor();
  tensor.dispose();
  return r ? Array.from(r.descriptor) : null;
}
const distanciaEuclid = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0));

/**
 * { [nome desta bancada]: pasta na bancada `base` } para as fotos desta corrida.
 * `vetores[i]` descreve a foto i; `descrever(buf)` descreve o `arquivo` de cada
 * pasta candidata da mesma forma; `dist` compara. Só entra em jogo quando há
 * um grupo de pastas com o mesmo nome base — o resto vai pelo nome.
 */
async function mapearReferencias(base, nomes, vetores, { arquivo, descrever, dist }) {
  const mapa = {};
  const grupos = {};
  nomes.forEach((nome, i) => { const cru = nome.replace(/_\d+$/, ''); (grupos[cru] = grupos[cru] || []).push(i); });
  for (const [cru, idx] of Object.entries(grupos)) {
    const candidatas = fs.existsSync(base)
      ? fs.readdirSync(base).filter((d) => (d === cru || d.startsWith(`${cru}_`)) && fs.existsSync(path.join(base, d, arquivo)))
      : [];
    const vetoresOk = idx.every((i) => vetores[i]);
    if (candidatas.length < 2 || candidatas.length !== idx.length || !vetoresOk) { idx.forEach((i) => { mapa[nomes[i]] = nomes[i]; }); continue; }
    const vPastas = {};
    for (const d of candidatas) vPastas[d] = await descrever(fs.readFileSync(path.join(base, d, arquivo)));
    if (!candidatas.every((d) => vPastas[d])) { idx.forEach((i) => { mapa[nomes[i]] = nomes[i]; }); console.log(`   referências de ${cru} em ${path.basename(base)}: sem rosto/assinatura numa das pastas — fica pelo nome`); continue; }
    let melhor = null;
    for (const perm of permutacoes(candidatas)) {
      const total = idx.reduce((s, i, j) => s + dist(vetores[i], vPastas[perm[j]]), 0);
      if (!melhor || total < melhor.total) melhor = { perm, total };
    }
    idx.forEach((i, j) => {
      mapa[nomes[i]] = melhor.perm[j];
      if (melhor.perm[j] !== nomes[i]) console.log(`   referência de ${nomes[i]} em ${path.basename(base)}: pasta ${melhor.perm[j]} (pelo conteúdo, não pelo nome)`);
    });
  }
  return mapa;
}

// ─── Nome por foto (o card real leva o nome do jogador) ─────────────────────
function nomeDoJogador(foto) {
  const n = path.parse(foto).name;
  if (/^WhatsApp/i.test(n)) return 'JOGADOR';
  return n.replace(/churras/i, '').trim().split(/\s+/).slice(0, 2).join(' ').toUpperCase();
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta no ambiente.'); process.exit(1); }
  const teto = Number(arg('teto', '0.20'));
  let fotos = fs.readdirSync(FOTOS).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  const soFoto = arg('foto', '');
  // --foto aceita vários prefixos separados por vírgula (adendo: "Gui,Renato").
  const prefixos = soFoto.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (prefixos.length) fotos = fotos.filter((f) => prefixos.some((p) => f.toLowerCase().startsWith(p)));
  else if (tem('so-um')) fotos = fotos.filter((f) => f === FOTO_TRIAGEM);
  else if (tem('resto')) fotos = fotos.filter((f) => f !== FOTO_TRIAGEM);
  if (!fotos.length) { console.error('nenhuma foto para correr.'); process.exit(1); }

  console.log('\nBANCADA "FIGURINHA GRÁTIS SEM IA" · recorte + sharp');
  console.log(`Fotos: ${fotos.length} · custo estimado: $${(fotos.length * 0.002).toFixed(3)} (um birefnet por foto) · tecto $${teto.toFixed(2)}\n`);

  const fa = await carregarRosto();
  const temporarios = [];
  const custosExtra = []; // gerações reais fora do laço (bustos dos kits pagos)
  // Adendo b: --dois-kits produz a célula 4 também no dark-purple — o busto
  // desse kit gera-se UMA vez (US$0,05) e fica em assets/; trocar de uniforme
  // depois disso custa zero.
  const kits = tem('dois-kits') ? ['dark-gold', 'dark-purple'] : ['dark-gold'];
  const bustos = {};
  for (const kit of kits) {
    bustos[kit] = await garantirBusto(kit, kit === 'dark-gold'
      ? async () => fs.readFileSync(BUSTO_FONTE_GOLD)
      : () => gerarFonteDoKit(kit, temporarios, custosExtra));
  }
  fs.mkdirSync(SAIDA, { recursive: true });
  const ficheiroCsv = path.join(SAIDA, 'custos.csv');
  const CABECALHO = ['foto', 'variante', 'receita', 'custo_usd', 'detalhe_custo', 's_birefnet', 'ms_rosto', 'ms_cpu_rosto', 'ms_sharp', 'achatamento', 'cabeca_cortada', 'pescoco_alpha_px', 'pescoco_rosto_px', 'parametros', 'kit', 'ms_total'];
  // Reload com parser de CSV a sério (campos entre aspas podem ter vírgula —
  // "sem header, tabela $0.002" partiu as colunas na 1ª corrida) e as linhas
  // das fotos desta corrida saem antes de entrar as novas: correr de novo
  // SUBSTITUI, não duplica.
  const deCsv = (linha) => {
    const campos = []; let atual = ''; let aspas = false;
    for (let i = 0; i < linha.length; i += 1) {
      const ch = linha[i];
      if (aspas) {
        if (ch === '"' && linha[i + 1] === '"') { atual += '"'; i += 1; } else if (ch === '"') aspas = false; else atual += ch;
      } else if (ch === '"') aspas = true;
      else if (ch === ',') { campos.push(atual); atual = ''; } else atual += ch;
    }
    campos.push(atual);
    return campos;
  };

  // As pastas seguem o mesmo nome das bancadas anteriores (é assim que as cópias
  // 5 e 6 se encontram) — incluindo o sufixo _2 do nome que colide. Os nomes
  // desta corrida decidem-se antes do laço, para limpar o CSV de uma vez.
  const usados = new Set();
  const nomes = fotos.map((foto) => {
    const cru = path.parse(foto).name.replace(/[^\w-]/g, '_').slice(0, 40);
    let nome = cru;
    for (let i = 2; usados.has(nome); i += 1) nome = `${cru}_${i}`;
    usados.add(nome);
    return nome;
  });
  const linhas = fs.existsSync(ficheiroCsv)
    ? fs.readFileSync(ficheiroCsv, 'utf8').trim().split(/\r?\n/).map(deCsv).filter((l, i) => i === 0 || !nomes.includes(l[0]))
    : [CABECALHO];
  // Colunas novas (adendo: kit, ms_total): um CSV antigo ganha-as vazias.
  if (linhas[0].length < CABECALHO.length) {
    linhas[0] = CABECALHO;
    for (let i = 1; i < linhas.length; i += 1) while (linhas[i].length < CABECALHO.length) linhas[i].push('');
  }
  let gasto = custosExtra.reduce((s, c) => s + c.usd, 0);

  // saida-prompt: o entrada.jpg é a foto orientada → assinatura 24×24 da foto
  // crua chega (margens largas). saida-economia: o entrada.jpg e o 3.png nem
  // sempre são da mesma pessoa (8ª corrida) → compara-se a CARA da foto com a
  // cara pintada no próprio 3.png, pelo descritor do face-api.
  const assCrua = []; const rostos = [];
  for (const foto of fotos) {
    const buf = fs.readFileSync(path.join(FOTOS, foto));
    assCrua.push(await assinatura(buf));
    rostos.push(await descritorDeRosto(fa, buf));
  }
  const refV6 = await mapearReferencias(DA_V6, nomes, assCrua, { arquivo: 'entrada.jpg', descrever: assinatura, dist: distancia });
  const ref2P = await mapearReferencias(DAS_2P, nomes, rostos, { arquivo: '3.png', descrever: (b) => descritorDeRosto(fa, b), dist: distanciaEuclid });

  for (const [idx, foto] of fotos.entries()) {
    const nome = nomes[idx];
    // Nas bancadas anteriores as duas "Cópia" da mesma foto ganharam _2 na
    // SEGUNDA processada — mesma ordem (readdir ordenado), mesmo resultado.
    const pasta = path.join(SAIDA, nome);
    fs.mkdirSync(pasta, { recursive: true });
    const nomeJog = nomeDoJogador(foto);
    console.log(`── ${nome} ${'─'.repeat(Math.max(0, 52 - nome.length))}`);
    if (gasto >= teto) { console.error(`   PARADO: já gastei $${gasto.toFixed(3)} (tecto $${teto.toFixed(2)})`); break; }

    try {
      // 0) recorte
      const orientado = await sharp(fs.readFileSync(path.join(FOTOS, foto))).rotate().jpeg({ quality: 92 }).toBuffer();
      const url = await subir(`tmp-recorte/${nome}.jpg`, orientado, 'image/jpeg', temporarios);
      const resp = await chamarFal(BIREFNET, { image_url: url, model: 'General Use (Light)' });
      const urlRec = resp.dados?.image?.url;
      if (!urlRec) throw new Error('birefnet não devolveu imagem');
      const conv = emDolares(BIREFNET, resp.custo);
      gasto += conv.usd ?? 0.002;
      const inteiro = await sharp(await baixar(urlRec)).ensureAlpha().png().toBuffer();
      const caixa = await caixaDoAlpha(inteiro);
      const recorte = await sharp(inteiro).extract({ left: caixa.left, top: caixa.top, width: caixa.width, height: caixa.height }).png().toBuffer();
      fs.writeFileSync(path.join(pasta, 'recorte.png'), recorte);

      // rosto (opcional) → caixa em coordenadas do recorte
      let rosto = null; let infoRosto = { ms: 0, cpuMs: 0, n: 0 };
      if (fa) {
        infoRosto = await detectarRosto(fa, orientado);
        if (infoRosto.caixa) {
          const mOr = await sharp(orientado).metadata();
          const ex = caixa.w / mOr.width; const ey = caixa.h / mOr.height; // o birefnet pode devolver outro tamanho
          const c = infoRosto.caixa;
          rosto = { x: c.x * ex - caixa.left, y: c.y * ey - caixa.top, w: c.w * ex, h: c.h * ey, score: c.score };
        }
      }

      // pescoço: só alpha (para comparar) e alpha limitado pelo rosto (o que se usa, quando há rosto)
      const p = await perfil(recorte);
      const porAlpha = pescocoPorAlpha(p, null);
      const porRosto = rosto ? pescocoPorAlpha(p, rosto) : null;
      const neck = porRosto || porAlpha;
      const pele = await topoDaPele(recorte);
      console.log(`   recorte ${caixa.width}x${caixa.height} · birefnet ${resp.segundos.toFixed(1)}s $${(conv.usd ?? 0.002).toFixed(3)} (${conv.nota}) · pele a ${pele === null ? '—' : `${(pele * 100).toFixed(0)}%`}`);
      console.log(`   pescoço: alpha y=${porAlpha.yPescoco} (${porAlpha.largPescoco}px)${porRosto ? ` · com rosto y=${porRosto.yPescoco} (${porRosto.largPescoco}px, largura de ${porRosto.larguraDe}; caixa ${Math.round(rosto.w)}x${Math.round(rosto.h)}, score ${rosto.score.toFixed(2)}, ${infoRosto.ms} ms, cpu ${infoRosto.cpuMs} ms)` : fa ? ' · rosto: NÃO DETECTADO' : ''} → uso ${porRosto ? 'rosto' : 'alpha'}`);

      // enquadramento comum às variantes 1-3
      const t1 = Date.now();
      const bustoCanvas = await enquadrarBusto(recorte, neck);
      const ach = await achatamento(bustoCanvas.canvas);
      const msEnq = ms(t1);
      // ms_total = o tempo de UMA figurinha desta variante, de ponta a ponta:
      // birefnet + detector de rosto + sharp (enquadramento, acabamento, card).
      const regista = (n, receita, msSharp, achat, extraParams = '', kit = '') => {
        linhas.push([nome, n, receita, (conv.usd ?? 0.002).toFixed(4), n === 4 ? `${conv.nota} (mesmo birefnet)` : conv.nota,
          resp.segundos.toFixed(1), infoRosto.ms, infoRosto.cpuMs, msSharp, achat.razao === null ? '' : achat.razao.toFixed(2), achat.cortada ? 'S' : 'N',
          porAlpha.yPescoco, porRosto ? porRosto.yPescoco : '', extraParams, kit, Math.round(resp.segundos * 1000) + infoRosto.ms + msSharp]);
      };

      // 1 crua
      let t = Date.now();
      fs.writeFileSync(path.join(pasta, '1.png'), await montarCard(bustoCanvas.canvas, nomeJog));
      regista(1, 'crua', ms(t) + msEnq, ach, `folga ${FOLGA_TOPO} · busto até y=${bustoCanvas.yFim} · escala ${bustoCanvas.escala.toFixed(2)}`);
      console.log(`   1 crua       ${ms(t) + msEnq} ms · achat ${ach.razao === null ? '—' : ach.razao.toFixed(2)}${ach.cortada ? ' CORTADA' : ''}`);

      // 2 impressão
      t = Date.now();
      const imp = await acabamentoImpressao(bustoCanvas.canvas);
      fs.writeFileSync(path.join(pasta, '2.png'), await montarCard(imp, nomeJog));
      regista(2, 'impressão', ms(t) + msEnq, ach, JSON.stringify(IMPRESSAO).replace(/,/g, ';'));
      console.log(`   2 impressão  ${ms(t) + msEnq} ms`);

      // 3 pintura
      t = Date.now();
      const pin = await acabamentoPintura(bustoCanvas.canvas);
      fs.writeFileSync(path.join(pasta, '3.png'), await montarCard(pin, nomeJog));
      regista(3, 'pintura', ms(t) + msEnq, ach, JSON.stringify(PINTURA).replace(/,/g, ';'));
      console.log(`   3 pintura    ${ms(t) + msEnq} ms`);

      // 4 cabeça no busto — um card por kit (adendo b). A pele da pessoa
      // amostra-se UMA vez (mediana no rosto) e tinge o busto de cada kit.
      const tom = await tomDePele(recorte, rosto, neck.yPescoco);
      const celulas4 = [];
      for (const kit of kits) {
        t = Date.now();
        const cb = await cabecaNoBusto(recorte, neck, bustos[kit], tom);
        fs.writeFileSync(path.join(pasta, `cabeca-no-busto-${kit}.png`), cb.conjunto);
        const conjuntoCanvas = await enquadrarBusto(cb.conjunto, { yPescoco: bustos[kit].yPescoco + cb.extra, largCabeca: bustos[kit].largPescoco * 1.6 });
        const ach4 = await achatamento(conjuntoCanvas.canvas);
        const pin4 = await acabamentoPintura(conjuntoCanvas.canvas);
        const card4 = await montarCard(pin4, nomeJog);
        fs.writeFileSync(path.join(pasta, `4-${kit}.png`), card4);
        if (kit === 'dark-gold') fs.writeFileSync(path.join(pasta, '4.png'), card4); // a célula 4 da folha
        celulas4.push({ letra: `4 · ${kit}`, png: card4 });
        regista(4, 'cabeça no busto', ms(t), ach4, `escala cabeça ${cb.escala.toFixed(2)} · pluma ${EMENDA.pluma}px · pessoa até ${EMENDA.sobGola}px sob a gola · gola por cima · pele ${tom ? `tingida (mediana ${tom.r};${tom.g};${tom.b} de ${tom.amostras} px)` : 'NÃO tingida (sem amostra)'} · acabamento 3`, kit);
        console.log(`   4 ${kit.padEnd(12)} ${ms(t)} ms · escala ${cb.escala.toFixed(2)} · pele ${tom ? `${tom.r},${tom.g},${tom.b}` : 'NÃO tingida'} · achat ${ach4.razao === null ? '—' : ach4.razao.toFixed(2)}${ach4.cortada ? ' CORTADA' : ''}`);
      }
      // Os dois uniformes lado a lado: a prova de que trocar de kit custa zero.
      if (celulas4.length > 1) await folhaDeContato(celulas4, path.join(pasta, 'uniformes.png'));
    } catch (e) {
      console.error(`   FALHOU: ${e.message.slice(0, 160)}`);
      linhas.push([nome, '', 'FALHOU', '', e.message.slice(0, 80).replace(/,/g, ';'), '', '', '', '', '', '', '', '', '']);
    }

    // 5 e 6: cópias, sem gastar — da pasta escolhida pelo conteúdo (ver mapearReferencias)
    for (const [n, origem] of [[5, path.join(DA_V6, refV6[nome] || nome, '6.png')], [6, path.join(DAS_2P, ref2P[nome] || nome, '3.png')]]) {
      if (fs.existsSync(origem)) fs.copyFileSync(origem, path.join(pasta, `${n}.png`));
      else console.log(`   ${n} (comparação) não existe em ${path.relative(SAIDA, origem)}`);
    }

    const ROTULO = { 1: 'crua $0,002', 2: 'impressão $0,002', 3: 'pintura $0,002', 4: 'cabeça no busto (gold) $0,002', 5: 'V6 $0,112', 6: '2 passadas $0,05' };
    const naPasta = fs.readdirSync(pasta).filter((f) => /^[0-9]+\.png$/.test(f)).map((f) => Number(f.replace('.png', ''))).sort((a, b) => a - b);
    if (naPasta.length) {
      await folhaDeContato(
        naPasta.map((n) => ({ letra: `${n} · ${ROTULO[n] || n}`, png: fs.readFileSync(path.join(pasta, `${n}.png`)) })),
        path.join(pasta, 'folha-de-contato.png'),
      );
      console.log(`   folha: ${path.relative(process.cwd(), path.join(pasta, 'folha-de-contato.png'))}`);
    }
  }

  if (temporarios.length) await supabase.storage.from('kits').remove(temporarios).catch(() => {});
  fs.writeFileSync(ficheiroCsv, paraCsv(linhas));

  const dados = linhas.slice(1).filter((l) => l[2] !== 'FALHOU');
  console.log(`\n${'='.repeat(88)}`);
  console.log('var  receita              custo/figurinha   birefnet   sharp     cortadas   n');
  for (const n of [1, 2, 3, 4]) {
    const ls = dados.filter((l) => Number(l[1]) === n);
    if (!ls.length) continue;
    const med = (i) => ls.reduce((s, l) => s + Number(l[i]), 0) / ls.length;
    console.log(`${String(n).padEnd(4)} ${ls[0][2].padEnd(20)} $${med(3).toFixed(4)}           ${med(5).toFixed(1)}s      ${Math.round(med(8))} ms   ${ls.filter((l) => l[10] === 'S').length}/${ls.length}       ${ls.length}   · total/figurinha ${(med(15) / 1000).toFixed(1)} s`);
  }
  for (const c of custosExtra) console.log(`extra: ${c.o} — $${c.usd.toFixed(4)} em ${c.segundos}s (uma vez; depois é asset)`);
  console.log(`\nReferências na folha: 5 = V6 ($0,112) · 6 = duas passadas ($0,05, produção)`);
  console.log(`GASTO REAL DESTA CORRIDA: $${gasto.toFixed(3)}`);
  console.log(`Folhas: ${SAIDA}\\<foto>\\folha-de-contato.png · CSV: ${ficheiroCsv}`);
  console.log('='.repeat(88));
})();
