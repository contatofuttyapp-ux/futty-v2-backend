// ═══════════════════════════════════════════════════════════════════════════════
// BANCADA DO UNIFORME (6-out, achado 3g da LISTA-CURTA).
//
// Em 5-out o uniforme saiu fiel ao kit em 4 de 9 gerações V6 (o dourado virou
// faixa de bordas paralelas; a manga esquerda saiu preta). Esta bancada testa
// até 3 variações da V6, cada uma mexendo numa alavanca só, e mede o resultado
// com o medidor automático (medidor-uniforme.js, que acerta as 9 de 5-out):
//
//   controle   a V6 de produção, intocada (utils/geracaoFigurinha.js).
//   v1-prompt  PROMPT: a frase do kit descreve a geometria como ela é — uma
//              linha diagonal só, o acento à direita dela ALARGANDO até a barra,
//              a manga da direita (de quem olha) inteira do acento, "não é
//              faixa de bordas paralelas". A frase de produção ("painel do
//              ombro esquerdo à barra direita") descreve, ao pé da letra, uma
//              FAIXA — que é o defeito. Tudo o resto do prompt fica igual.
//   v2-kit     ENTRADA: a imagem do kit recortada só na camisa (sem o calção,
//              que tem uma listra diagonal fina) e quadrada, com a camisa
//              ocupando o quadro. Prompt de produção.
//   v3-ordem   ORDEM E PESO: o kit vai como Image 1 e a foto como Image 2 (o
//              prompt troca as referências). Com input_fidelity alta o modelo
//              guarda com mais detalhe a PRIMEIRA imagem — aqui ela é o kit.
//              Risco conhecido: a cara pode perder; olhar as caras.
//
// Fotos: os 3 modelos fictícios da bancada da loja (Careca, Zé Gordo, Paredão)
// e a foto do dono, todos em LOJA/demo-avatares (nada sobe para o Storage: a
// entrada vai à fal como data URI). Nada é gravado no banco.
//
// DINHEIRO: o custo de cada chamada é o LIDO da fal (utils/falFila.js) e fica
// em LOJA/uniforme-bancada/custos.json, que soma entre corridas. Teto US$3,00
// para a bancada inteira: a corrida para ANTES de uma geração que passaria do
// teto. Teto por geração US$0,112 (o custo da V6, CLAUDE.md): a variação que
// passar dele numa geração é desqualificada e não gera mais.
//
// Uso (a partir de FUTTY-V2/backend):
//   node scripts/_bench/testar-uniforme.js --var v1-prompt --kit dark-gold [--fotos dono,careca]
//   node scripts/_bench/testar-uniforme.js --remedir      mede de novo tudo o que está no disco (grátis)
//   node scripts/_bench/testar-uniforme.js --folha        monta folha.png
//   node scripts/_bench/testar-uniforme.js --prompts      imprime os prompts das variações (grátis)
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { chamarFal, emDolares } = require('../../utils/falFila');
const {
  gerarFigurinha, V6_ENDPOINT, BIREFNET_ENDPOINT, QUALIDADE, TAMANHO_1_5, FIDELIDADE_V6,
} = require('../../utils/geracaoFigurinha');
const { montarPrompt, KITS_CURTOS, KIT_CHECK } = require('../../prompts/figurinha');
const { preprocessarQuadrado } = require('../../utils/entradaFigurinha');
const { lerKit, baixar } = require('./comum');
const { medirUniforme, lerReferenciaKit, mascaraKit, imagemDebug, REGRAS, num, pct } = require('./medidor-uniforme');

const FUT = path.join(__dirname, '..', '..', '..', '..');
const DEMO = path.join(FUT, 'LOJA', 'demo-avatares');
const SAIDA = path.join(FUT, 'LOJA', 'uniforme-bancada');
const KITS_DIR = path.join(SAIDA, 'kits');
const GERACOES = path.join(SAIDA, 'geracoes');
const ARQ_CUSTOS = path.join(SAIDA, 'custos.json');
const ARQ_RESULTADOS = path.join(SAIDA, 'resultados.json');

const TETO_TOTAL = 3.0;
const TETO_GERACAO = 0.112;
// Só para o freio ANTES de gastar (o que se anota é sempre o custo lido da fal):
// o maior custo por geração já LIDO nesta bancada + US$0,003; antes da primeira
// leitura, US$0,14 (um kit 2:3 podia custar mais que o 3:4 do Dark Gold — não custou).
const estimativaGeracao = () => {
  const porGeracao = {};
  for (const c of custos.chamadas) {
    const k = `${c.variacao}|${c.kit}|${c.foto}|${c.quando.slice(0, 16)}`;
    porGeracao[k] = (porGeracao[k] || 0) + (c.usd || 0);
  }
  const lidos = Object.values(porGeracao);
  return lidos.length ? Math.max(...lidos) + 0.003 : 0.14;
};

const FOTOS = {
  dono: path.join(DEMO, 'foto-dono.jpg'),
  careca: path.join(DEMO, 'l1-careca-foto.png'),
  'ze-gordo': path.join(DEMO, 'l2-ze-gordo-foto.png'),
  paredao: path.join(DEMO, 'l3-paredao-foto.png'),
};
const ARQ_KIT = {
  'dark-gold': 'kit1-dark-gold.png',
  'dark-purple': 'kit2-dark-purple.png',
  'white-gold': 'kit3-white-gold.png',
  'elite-gold': 'kit4-elite-gold.png',
  'royal-purple': 'kit5-royal-purple.png',
};

// ── V1: a frase do kit com a geometria certa ─────────────────────────────────
// Escrita como se vê NA IMAGEM ("lado direito do quadro"), não como o jogador
// veste: o prompt de produção mistura os dois referenciais (o painel "do ombro
// esquerdo" é o esquerdo de quem veste; o emblema "no peito esquerdo" é o
// esquerdo de quem olha). As cores são as mesmas de prompts/figurinha.js.
const CORES = {
  'dark-gold': ['black', 'gold', ''],
  'dark-purple': ['black', 'vivid purple', ''],
  'white-gold': ['off-white', 'metallic gold', ''],
  'elite-gold': ['metallic gold', 'deep black', ' — note: this kit is INVERTED, gold is the base colour and black is the accent'],
  'royal-purple': ['vivid purple', 'deep black', ' — note: this kit is INVERTED, purple is the base colour and black is the accent'],
};
const maiuscula = (s) => s[0].toUpperCase() + s.slice(1);
// Sem ponto final: o molde de produção continua com ". No other logos, no text."
const frasePrecisa = (kitId) => {
  const [base, acento, invertido] = CORES[kitId];
  return `${base} jersey cut by ONE straight diagonal line (described as seen from the front, in the picture): `
    + `the line starts at the collar on the right side of the picture and runs down to the middle of the hem. `
    + `Everything to the RIGHT of that line is solid ${acento} all the way down to the hem, so the ${acento} area gets WIDER toward the hem, `
    + `and it includes the WHOLE sleeve on the right side of the picture (only that cuff is ${base}). `
    + `It is NOT a sash or a stripe with two parallel edges: no ${base} wedge to the right of the ${acento} area, only a thin ${base} strip along the side seam. `
    + `The left side of the picture is ${base} — body and sleeve — with thin ${acento} trim at that cuff. `
    + `${maiuscula(acento)} V-neck piping; one small solid ${acento} emblem on the chest, left side of the picture${invertido}`;
};
const checkPreciso = (kitId) => {
  const [, acento] = CORES[kitId];
  return `Check before finishing: base colour, ONE diagonal line with the ${acento} area WIDENING to the hem, the whole right-side sleeve in ${acento}, V-neck piping, cuffs, chest emblem — all as in Image 2.`;
};

/** Troca um trecho que TEM de existir — se a produção mudar de forma, falha aqui, de graça. */
const trocar = (texto, de, para) => {
  if (!texto.includes(de)) throw new Error(`o prompt de produção mudou: não achei "${de.slice(0, 40)}…"`);
  return texto.split(de).join(para);
};

function promptDe(variacao, kitId) {
  const producao = montarPrompt(kitId);
  if (variacao === 'v1-prompt') {
    return trocar(trocar(producao, KITS_CURTOS[kitId], frasePrecisa(kitId)), KIT_CHECK, checkPreciso(kitId));
  }
  if (variacao === 'v3-ordem') {
    if (!producao.includes('Image 1') || !producao.includes('Image 2')) throw new Error('o prompt de produção já não fala em Image 1/Image 2');
    return producao.replace(/Image 1/g, '§FOTO§').replace(/Image 2/g, 'Image 1').replace(/§FOTO§/g, 'Image 2');
  }
  return producao;
}

// ── V2: o kit recortado na camisa, quadrado ──────────────────────────────────
/**
 * A camisa ocupa o quadro: caixa da peça até 55% da altura (o resto é o calção,
 * mesma linha do medidor), 5% de margem, completada a quadrado com o fundo do
 * próprio kit (transparente no kit1, preto nos outros), 1024×1024.
 */
async function kitSoCamisa(kitId) {
  const destino = path.join(KITS_DIR, `${ARQ_KIT[kitId].replace('.png', '')}-camisa.png`);
  if (fs.existsSync(destino)) return fs.readFileSync(destino);
  const buf = fs.readFileSync(path.join(KITS_DIR, ARQ_KIT[kitId]));
  const { w, h, dentro } = await mascaraKit(buf);
  let topo = h, fundo = 0, xMin = w, xMax = 0;
  for (let i = 0; i < w * h; i += 1) {
    if (!dentro[i]) continue;
    const x = i % w, y = (i - x) / w;
    topo = Math.min(topo, y); fundo = Math.max(fundo, y); xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
  }
  const yFim = Math.round(topo + (fundo - topo) * 0.55);
  const lado = Math.round(Math.max(xMax - xMin, yFim - topo) * 1.10);
  const cx = (xMin + xMax) / 2, cy = (topo + yFim) / 2;
  const meta = await sharp(buf).metadata();
  const fundoCor = meta.hasAlpha ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 0, g: 0, b: 0, alpha: 1 };
  // recorta a camisa e cola-a centrada num quadrado do fundo do kit
  const camisa = await sharp(buf).extract({ left: xMin, top: topo, width: xMax - xMin + 1, height: yFim - topo + 1 }).png().toBuffer();
  const quadrado = await sharp({ create: { width: lado, height: lado, channels: 4, background: fundoCor } })
    .composite([{ input: camisa, left: Math.round(lado / 2 - (cx - xMin)), top: Math.round(lado / 2 - (cy - topo)) }])
    .png().toBuffer();
  const final = await sharp(quadrado).resize(1024, 1024).png().toBuffer();
  fs.writeFileSync(destino, final);
  return final;
}

// ── livro-caixa ──────────────────────────────────────────────────────────────
const lerJson = (arq, padrao) => (fs.existsSync(arq) ? JSON.parse(fs.readFileSync(arq, 'utf8')) : padrao);
const custos = lerJson(ARQ_CUSTOS, { teto_usd: TETO_TOTAL, teto_por_geracao_usd: TETO_GERACAO, total_usd: 0, chamadas: [], desqualificadas: {} });
const gasto = () => custos.chamadas.reduce((s, c) => s + (c.usd || 0), 0);
const gravarCustos = () => { custos.total_usd = Number(gasto().toFixed(4)); fs.writeFileSync(ARQ_CUSTOS, JSON.stringify(custos, null, 2)); };
const anotar = (linha) => { custos.chamadas.push({ quando: new Date().toISOString(), ...linha }); gravarCustos(); };

// ── uma geração ──────────────────────────────────────────────────────────────
async function gerar(variacao, kitId, fotoId) {
  const kit = lerKit(kitId);
  const quadrada = await preprocessarQuadrado(fs.readFileSync(FOTOS[fotoId]));
  const fotoUrl = `data:image/jpeg;base64,${quadrada.toString('base64')}`;

  if (variacao === 'controle') {
    // A receita de produção, chamada pela função de produção.
    const r = await gerarFigurinha({
      fotoUrl, kitUrl: kit.url, kitId, etiqueta: `${kitId}-${fotoId}`, receita: 'v6',
      publicar: () => { throw new Error('a V6 não sobe nada'); },
    });
    return {
      urlV6: r.urls.v6,
      recorte: r.recorteBuffer,
      parcelas: { v6: { endpoint: V6_ENDPOINT, ...r.custo.parcelas.v6 }, birefnet: { endpoint: BIREFNET_ENDPOINT, ...r.custo.parcelas.birefnet } },
    };
  }

  const kitUrl = variacao === 'v2-kit'
    ? `data:image/png;base64,${(await kitSoCamisa(kitId)).toString('base64')}`
    : kit.url;
  const imagens = variacao === 'v3-ordem' ? [kitUrl, fotoUrl] : [fotoUrl, kitUrl];
  // Os mesmos parâmetros da V6 de produção (importados, não copiados).
  const g = await chamarFal(V6_ENDPOINT, {
    prompt: promptDe(variacao, kitId),
    image_urls: imagens,
    quality: QUALIDADE,
    image_size: TAMANHO_1_5,
    input_fidelity: FIDELIDADE_V6,
    num_images: 1,
  });
  const cG = emDolares(V6_ENDPOINT, g.custo);
  const urlV6 = g.dados?.images?.[0]?.url;
  if (!urlV6) throw new Error('a V6 não devolveu imagem');
  const rec = await chamarFal(BIREFNET_ENDPOINT, { image_url: urlV6, model: 'General Use (Light)' });
  const cR = emDolares(BIREFNET_ENDPOINT, rec.custo);
  const urlRec = rec.dados?.image?.url;
  if (!urlRec) throw new Error('o birefnet não devolveu imagem');
  return {
    urlV6,
    recorte: await baixar(urlRec),
    parcelas: {
      v6: { endpoint: V6_ENDPOINT, usd: cG.usd, nota: `${cG.nota} · ${g.custo.campo || 'sem campo'}` },
      birefnet: { endpoint: BIREFNET_ENDPOINT, usd: cR.usd, nota: cR.nota },
    },
  };
}

const refs = {};
const referencia = async (kitId) => {
  if (!refs[kitId]) refs[kitId] = await lerReferenciaKit(fs.readFileSync(path.join(KITS_DIR, ARQ_KIT[kitId])));
  return refs[kitId];
};

async function medirEGuardar(variacao, kitId, fotoId, recorte, extra = {}) {
  const dir = path.join(GERACOES, variacao);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${kitId}-${fotoId}`);
  const r = await medirUniforme(recorte, await referencia(kitId));
  fs.writeFileSync(`${base}-debug.png`, await imagemDebug(r));
  const resultados = lerJson(ARQ_RESULTADOS, []);
  const i = resultados.findIndex((x) => x.variacao === variacao && x.kit === kitId && x.foto === fotoId);
  const linha = {
    ...(i >= 0 ? resultados[i] : {}),
    variacao, kit: kitId, foto: fotoId, ...extra,
    medidor: { ok: r.ok, limite: r.limite, motivos: r.motivos, medidas: r.medidas },
  };
  if (i >= 0) resultados[i] = linha; else resultados.push(linha);
  fs.writeFileSync(ARQ_RESULTADOS, JSON.stringify(resultados, null, 2));
  return r;
}

async function rodar(variacao, kitId, fotos) {
  if (!['controle', 'v1-prompt', 'v2-kit', 'v3-ordem'].includes(variacao)) throw new Error(`variação desconhecida: ${variacao}`);
  if (!CORES[kitId]) throw new Error(`kit desconhecido: ${kitId}`);
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY em falta');
  promptDe(variacao, kitId); // falha aqui, de graça, se a produção mudou de forma
  console.log(`\n${variacao} · ${kitId} · ${fotos.join(', ')} · já gastos US$${gasto().toFixed(3)} de US$${TETO_TOTAL.toFixed(2)}\n`);
  for (const fotoId of fotos) {
    if (!FOTOS[fotoId]) throw new Error(`foto desconhecida: ${fotoId}`);
    if (custos.desqualificadas[variacao]) { console.log(`PAREI: ${variacao} desqualificada (${custos.desqualificadas[variacao]})`); return; }
    const estimativa = estimativaGeracao();
    if (gasto() + estimativa > TETO_TOTAL) {
      console.log(`PAREI NO TETO antes de ${variacao}/${kitId}/${fotoId}: US$${gasto().toFixed(3)} + ~US$${estimativa.toFixed(3)} passaria de US$${TETO_TOTAL.toFixed(2)}`);
      return;
    }
    const t0 = Date.now();
    try {
      const g = await gerar(variacao, kitId, fotoId);
      for (const [etapa, p] of Object.entries(g.parcelas)) anotar({ variacao, kit: kitId, foto: fotoId, etapa, endpoint: p.endpoint, usd: p.usd, nota: p.nota });
      const total = (g.parcelas.v6.usd ?? 0) + (g.parcelas.birefnet.usd ?? 0);
      const dir = path.join(GERACOES, variacao);
      fs.mkdirSync(dir, { recursive: true });
      const base = path.join(dir, `${kitId}-${fotoId}`);
      fs.writeFileSync(`${base}-v6.png`, await baixar(g.urlV6));
      fs.writeFileSync(`${base}-recorte.png`, g.recorte);
      const r = await medirEGuardar(variacao, kitId, fotoId, g.recorte, {
        custo_usd: Number(total.toFixed(4)), custo_v6_usd: g.parcelas.v6.usd, nota_custo: g.parcelas.v6.nota, segundos: Math.round((Date.now() - t0) / 1000),
      });
      const acima = g.parcelas.v6.usd == null || total > TETO_GERACAO + 1e-9;
      console.log(`${r.ok ? '✓' : '✗'} ${variacao}/${kitId}/${fotoId.padEnd(8)} US$${total.toFixed(4)}${acima ? ' ACIMA DO TETO POR GERAÇÃO' : ''} · manga ${num(r.medidas?.mangaDir)} · paralelo ${num(r.medidas?.paralelo)} · base ${num(r.medidas?.baseEsq)}${r.limite ? ' (no limite)' : ''}${r.motivos.length ? ` · ${r.motivos.join('; ')}` : ''} · total US$${gasto().toFixed(3)}`);
      if (acima && variacao !== 'controle') {
        custos.desqualificadas[variacao] = `geração de US$${total.toFixed(4)} em ${kitId}/${fotoId} (teto US$${TETO_GERACAO})`;
        gravarCustos();
      }
    } catch (e) {
      console.error(`FALHOU ${variacao}/${kitId}/${fotoId}: ${e.message}`);
    }
  }
  console.log(`\ncusto real acumulado: US$${gasto().toFixed(4)} de US$${TETO_TOTAL.toFixed(2)} (${ARQ_CUSTOS})`);
}

async function remedir() {
  const resultados = lerJson(ARQ_RESULTADOS, []);
  for (const x of resultados) {
    const rec = path.join(GERACOES, x.variacao, `${x.kit}-${x.foto}-recorte.png`);
    if (!fs.existsSync(rec)) continue;
    const r = await medirEGuardar(x.variacao, x.kit, x.foto, fs.readFileSync(rec));
    console.log(`${r.ok ? '✓' : '✗'} ${x.variacao.padEnd(10)} ${x.kit.padEnd(11)} ${x.foto.padEnd(8)} manga ${num(r.medidas?.mangaDir)} · paralelo ${num(r.medidas?.paralelo)} · base ${num(r.medidas?.baseEsq)} · acento ${num(r.medidas?.acentoTronco)}${r.limite ? ' (no limite)' : ''}${r.motivos.length ? ` · ${r.motivos.join('; ')}` : ''}`);
  }
}

// ── a folha ──────────────────────────────────────────────────────────────────
const NOMES_VAR = { 'v6-5out': 'V6 atual (5-out)', controle: 'V6 atual', 'v1-prompt': 'V1 · prompt', 'v2-kit': 'V2 · kit recortado', 'v3-ordem': 'V3 · kit primeiro' };
const NOMES_FOTO = { dono: 'Dono', careca: 'Careca', 'ze-gordo': 'Zé Gordo', paredao: 'Paredão' };
const NOMES_KIT = { 'dark-gold': 'Dark Gold (preto e dourado)', 'elite-gold': 'Elite Gold (invertido)' };

// O selo desenhado (o librsvg do sharp nem sempre tem ✓/✗ nas fontes do Windows).
const selo = (ok, x, y, r = 17) => (ok
  ? `<circle cx="${x}" cy="${y}" r="${r}" fill="#1f9d55"/><path d="M${x - r * 0.45} ${y} l${r * 0.32} ${r * 0.34} l${r * 0.6} ${-r * 0.7}" stroke="#fff" stroke-width="${r * 0.22}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
  : `<circle cx="${x}" cy="${y}" r="${r}" fill="#d64545"/><path d="M${x - r * 0.38} ${y - r * 0.38} L${x + r * 0.38} ${y + r * 0.38} M${x + r * 0.38} ${y - r * 0.38} L${x - r * 0.38} ${y + r * 0.38}" stroke="#fff" stroke-width="${r * 0.22}" stroke-linecap="round"/>`);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// A régua do Dark Gold: as 9 V6 de produção de 5-out (o gabarito do medidor), na ordem em que nasceram.
const NOVE_5OUT = ['l1-careca', 'l2-ze-gordo-reprovado', 'l3-paredao-reprovado', 'dono-t1', 'dono-t2', 'l2-ze-gordo-reprovado2', 'l3-paredao', 'dono-t3', 'l2-ze-gordo'];
const ROTULO_5OUT = {
  'l1-careca': 'Careca', 'l2-ze-gordo-reprovado': 'Zé Gordo 1', 'l3-paredao-reprovado': 'Paredão 1', 'dono-t1': 'Dono 1', 'dono-t2': 'Dono 2',
  'l2-ze-gordo-reprovado2': 'Zé Gordo 2', 'l3-paredao': 'Paredão 2', 'dono-t3': 'Dono 3', 'l2-ze-gordo': 'Zé Gordo 3',
};

async function folha() {
  const resultados = lerJson(ARQ_RESULTADOS, []);
  const kits = ['dark-gold', 'elite-gold'].filter((k) => resultados.some((x) => x.kit === k));
  const fotos = ['dono', 'careca', 'ze-gordo', 'paredao'];
  const ordemVar = ['controle', 'v1-prompt', 'v2-kit', 'v3-ordem'];
  const CW = 190, CH = 285, GAP = 10, KW = 230, ROT = 90, TIT = 76, CAB = 58;
  const NW = 122, NH = 183, NG = 8, NCAB = 78;
  const blocos = [];
  let altura = TIT + NCAB + NH + 44;
  for (const kitId of kits) {
    const linhas = fotos.filter((f) => resultados.some((x) => x.kit === kitId && x.foto === f));
    const hB = CAB + linhas.length * (CH + GAP) + 30;
    blocos.push({ kitId, linhas, y: altura });
    altura += hB;
  }
  const largura = Math.max(KW + ROT + ordemVar.length * (CW + GAP) + 20, 20 + NOVE_5OUT.length * (NW + NG) + 12);
  const texto = (x, y, s, { cor = '#9a9aa6', tam = 13, peso = 'normal', ancora = 'start' } = {}) =>
    `<text x="${x}" y="${y}" fill="${cor}" font-family="Arial" font-size="${tam}" font-weight="${peso}" text-anchor="${ancora}">${esc(s)}</text>`;
  // três camadas: fundo (títulos) → imagens → por cima (selos e legendas das células)
  const fundo = [`<rect width="${largura}" height="${altura}" fill="#0d0d12"/>`,
    texto(20, 34, 'Uniforme da figurinha — bancada de 6-out', { cor: '#f2f2f2', tam: 24, peso: 'bold' }),
    texto(20, 58, 'Selo = veredito do medidor automático (verde = fiel ao kit, vermelho = errado). Uma geração por célula; custo lido da fal.', { tam: 14 })];
  const topo = [];
  const partes = [];
  // faixa de cima: as 9 de 5-out (V6 de produção, Dark Gold), medidas agora pelo mesmo medidor
  const yN = TIT;
  const refDG = await referencia('dark-gold');
  let certas5 = 0;
  for (const [i, id] of NOVE_5OUT.entries()) {
    const x = 20 + i * (NW + NG);
    const r = await medirUniforme(fs.readFileSync(path.join(DEMO, `${id}-recorte.png`)), refDG);
    if (r.ok) certas5 += 1;
    partes.push({ input: await sharp(path.join(DEMO, `${id}-v6.png`)).resize({ width: NW, height: NH, fit: 'cover', position: 'bottom' }).png().toBuffer(), left: x, top: yN + NCAB });
    topo.push(selo(r.ok, x + NW - 16, yN + NCAB + 16, 13));
    fundo.push(texto(x + 2, yN + NCAB - 8, ROTULO_5OUT[id], { cor: '#cfcfd6', tam: 12 }));
  }
  fundo.push(texto(20, yN + 26, 'V6 de produção (a de hoje) — as 9 gerações de 5-out no Dark Gold', { cor: '#d4a017', tam: 20, peso: 'bold' }));
  fundo.push(texto(20, yN + 48, `${certas5}/9 fiéis — o veredito do dono e da LISTA-CURTA (3g). O medidor tinha de acertar estas 9 antes de qualquer gasto.`));
  for (const b of blocos) {
    fundo.push(texto(20, b.y + 32, NOMES_KIT[b.kitId] || b.kitId, { cor: '#d4a017', tam: 20, peso: 'bold' }));
    const kitImg = await sharp(path.join(KITS_DIR, ARQ_KIT[b.kitId])).flatten({ background: '#000' })
      .resize({ width: KW - 30, height: CH * 2, fit: 'inside' }).png().toBuffer();
    const mk = await sharp(kitImg).metadata();
    partes.push({ input: kitImg, left: 20, top: b.y + CAB });
    fundo.push(texto(20, b.y + CAB + mk.height + 20, 'o kit que entra na geração'));
    ordemVar.forEach((v, j) => {
      const x = KW + ROT + j * (CW + GAP);
      const daVar = resultados.filter((r) => r.kit === b.kitId && r.variacao === v);
      const certos = daVar.filter((r) => r.medidor?.ok).length;
      fundo.push(texto(x + CW / 2, b.y + 30, NOMES_VAR[v], { cor: '#f2f2f2', tam: 15, peso: 'bold', ancora: 'middle' }));
      fundo.push(texto(x + CW / 2, b.y + 49, daVar.length ? `${certos}/${daVar.length} fiéis` : (v === 'controle' ? '4/9 fiéis em 5-out (faixa de cima)' : 'não gerada'), { ancora: 'middle' }));
    });
    for (const [i, f] of b.linhas.entries()) {
      const y = b.y + CAB + i * (CH + GAP);
      fundo.push(texto(KW + 4, y + CH / 2, NOMES_FOTO[f], { cor: '#cfcfd6', tam: 15 }));
      for (const [j, v] of ordemVar.entries()) {
        const x = KW + ROT + j * (CW + GAP);
        const r = resultados.find((z) => z.kit === b.kitId && z.variacao === v && z.foto === f);
        const arq = path.join(GERACOES, v, `${b.kitId}-${f}-v6.png`);
        if (!r || !fs.existsSync(arq)) {
          fundo.push(`<rect x="${x}" y="${y}" width="${CW}" height="${CH}" fill="#16161d" stroke="#26262f"/>`);
          fundo.push(texto(x + CW / 2, y + CH / 2, v === 'controle' ? 'ver faixa de cima' : 'não gerada', { cor: '#55555f', ancora: 'middle' }));
          continue;
        }
        partes.push({ input: await sharp(arq).resize({ width: CW, height: CH, fit: 'cover', position: 'bottom' }).png().toBuffer(), left: x, top: y });
        topo.push(selo(r.medidor.ok, x + CW - 22, y + 22));
        const m = r.medidor.medidas || {};
        topo.push(`<rect x="${x}" y="${y + CH - 22}" width="${CW}" height="22" fill="#000" fill-opacity="0.65"/>`);
        topo.push(texto(x + 6, y + CH - 7, `paralelo ${num(m.paralelo)}${r.medidor.limite ? ' (limite)' : ''} · US$${r.custo_usd.toFixed(3)}`, { cor: '#e6e6ea', tam: 12 }));
      }
    }
  }
  const svg = (corpo) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${largura}" height="${altura}">${corpo.join('\n')}</svg>`);
  partes.push({ input: await sharp(svg(topo)).png().toBuffer(), left: 0, top: 0 });
  await sharp(svg(fundo)).composite(partes).png().toFile(path.join(SAIDA, 'folha.png'));
  console.log(path.join(SAIDA, 'folha.png'));
}

// ── linha de comando ─────────────────────────────────────────────────────────
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };

(async () => {
  fs.mkdirSync(GERACOES, { recursive: true });
  if (process.argv.includes('--prompts')) {
    for (const v of ['v1-prompt', 'v3-ordem']) for (const k of ['dark-gold', 'elite-gold']) console.log(`\n── ${v} · ${k} (${promptDe(v, k).length} caracteres; produção ${montarPrompt(k).length})\n${promptDe(v, k)}`);
    for (const k of ['dark-gold', 'elite-gold']) console.log(`kit só camisa: ${(await kitSoCamisa(k)).length} bytes`);
    return;
  }
  if (process.argv.includes('--remedir')) { await remedir(); return; }
  if (process.argv.includes('--folha')) { await folha(); return; }
  const variacao = arg('var');
  const kitId = arg('kit', 'dark-gold');
  const fotos = arg('fotos', 'dono,careca,ze-gordo,paredao').split(',').filter(Boolean);
  if (!variacao) { console.error('uso: --var controle|v1-prompt|v2-kit|v3-ordem --kit dark-gold|elite-gold [--fotos dono,careca,ze-gordo,paredao]'); process.exit(1); }
  await rodar(variacao, kitId, fotos);
})().catch((e) => { console.error(e); process.exit(1); });
