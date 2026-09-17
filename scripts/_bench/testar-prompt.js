// ═══════════════════════════════════════════════════════════════════════════════
// BANCADA DO PROMPT (17-set) — só o PROMPT muda. Mesmo modelo, mesma qualidade.
//
// Pergunta do dono: dá para a figurinha ficar MAIS PARECIDA com a pessoa sem
// mexer no modelo (gpt-image-1.5/edit), na qualidade (low) nem no tamanho
// (1024×1536)? O kit tem de ficar idêntico e a cabeça inteira.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ RESULTADO (avaliação do dono, 17-set, 49 figurinhas às cegas, 1 a 5):    │
// │   1 P1 (o prompt antigo) .... 1,6    5 P3 (P2 + STYLE antigo) ..... 3,3  │
// │   2 P1 + fidelity high ...... 2,0    6 P2 + high + QUADRADA ....... 4,1  │
// │   3 P2 ...................... 4,0      (melhor em 6/7 fotos, US$0,112)   │
// │   4 P2 + fidelity high ...... 4,0    7 P2 + fidelity low .......... 2,7  │
// │                                                                          │
// │ A VARIANTE 6 É A PRODUÇÃO desde 17-set. O prompt dela vive em            │
// │ prompts/figurinha.js e a entrada em utils/entradaFigurinha.js — esta      │
// │ bancada IMPORTA os dois, não os copia. Correr isto outra vez compara      │
// │ sempre contra o que está mesmo no ar.                                    │
// └──────────────────────────────────────────────────────────────────────────┘
//
// SETE variantes por foto:
//   1  P1                        o prompt antigo (prompt-antigo-reprovado.js)
//   2  P1 + input_fidelity high  o mesmo, pedindo fidelidade ao input
//   3  P2                        o prompt novo, de prompts/figurinha.js
//   4  P2 + input_fidelity high
//   5  P3 + input_fidelity high  P2 com o bloco STYLE antigo de volta — mede se
//                                é o ESTILO que apaga o rosto (é: -0,7)
//   6  P2 + high + ENTRADA QUADRADA 1024×1024 ....... A PRODUÇÃO
//   7  P2 + input_fidelity low   a barata (US$0,032), reprovada por inconstância
//
// Todas: birefnet e moldura Dark Gold, como o app entrega.
//
// CORRER (a fal só resolve na máquina do Pedro):
//   cd FUTTY-V2/backend && node scripts/_bench/testar-prompt.js
//   --fotos <pasta>     omissão: C:\Users\phfer\Desktop\FUT\BANCADA-FOTOS
//   --teto 1.00         recusa antes de gastar se a estimativa passar
//   --so Gui,Renato     só estas fotos (prefixo do nome)
//
// NÃO TOCA EM PRODUÇÃO: lê o prompt de routes/auth.js e escreve só aqui.
// A chave da fal nunca é impressa (nem em erro).
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sharp = require('sharp');
const { supabase } = require('../../utils/db');
// A bancada usa os MESMOS módulos que a produção — se divergirem, o que se mede
// deixa de ser o que está no ar (17-set: a variante 6 virou produção).
const { montarPrompt } = require('../../prompts/figurinha');
const { comFaixa, topoDaPele, preprocessarQuadrado, preprocessarRetrato } = require('../../utils/entradaFigurinha');
const { chamarFal, custoDosHeaders, limpar } = require('../../utils/falFila');

const SAIDA = path.join(__dirname, 'saida-prompt');
const FOTOS_OMISSAO = 'C:\\Users\\phfer\\Desktop\\FUT\\BANCADA-FOTOS';
const MODELO = 'fal-ai/gpt-image-1.5/edit';
const BIREFNET = 'fal-ai/birefnet';
// ATENÇÃO AO CUSTO (medido nesta bancada, 17-set):
// A tabela abaixo é só o preço da IMAGEM DE SAÍDA — é o que as bancadas antigas
// contavam, e é por isso que a casa acredita em "$0,015 por figurinha". A fal
// cobra MAIS do que isso na mesma chamada:
//   $0,005 / 1.000 tokens de texto do prompt
//   $0,008 / 1.000 tokens de IMAGEM de entrada — e uma imagem 1024×1024 são
//           135 tokens em fidelidade BAIXA, mas 3.050 em fidelidade ALTA
//   $0,010 / 1.000 tokens de raciocínio sobre o prompt
//   + $0,013 a imagem de saída low em 1024×1536
// Como `input_fidelity` tem omissão ALTA na fal, a produção manda duas imagens
// em alta fidelidade e paga por isso: o header x-fal-billable-units devolveu
// $0,132 na receita EXACTA de produção (variante 1). O custo verdadeiro por
// figurinha é ~9× o que está escrito no CLAUDE.md.
// Aqui o custo de cada linha vem SEMPRE do header quando ele existe; a tabela
// é o último recurso e a linha do CSV diz "tabela" quando foi usada.
const PRECO = { low: { '1024x1024': 0.009, '1024x1536': 0.013, '1536x1024': 0.013 } };
const CUSTO_BIREFNET = 0.002;
// Medido: geração completa (prompt + 2 imagens em alta fidelidade + saída).
// Serve só para a ESTIMATIVA antes de gastar — o que entra no CSV é o header.
const CUSTO_MEDIDO = 0.132;
const SEMENTE = 16092617; // embaralhamento das letras — fixo, reproduzível

const arg = (n, omissao = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : omissao;
};

// ── prompts ───────────────────────────────────────────────────────────────────
//
// DEPOIS DA DECISÃO (17-set): a variante 6 É a produção. O que era "P2" nesta
// bancada é agora `prompts/figurinha.js`, e é de lá que ele vem — a bancada
// deixou de ter texto de prompt próprio. O prompt ANTIGO (P1), que a produção
// tinha até 17-set, está arquivado em `prompt-antigo-reprovado.js` só para estas
// variantes poderem ser repetidas.

/** O catálogo de kits REAL, lido de routes/auth.js (url do asset + planos). */
function lerKits(kitId) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'auth.js'), 'utf8');
  const iK = src.indexOf('const KITS_IA = {');
  const fim = src.indexOf('\n};', iK);
  if (iK < 0 || fim < 0) throw new Error('Não consegui ler KITS_IA de routes/auth.js — aborta antes de gastar.');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(iK, fim + 3)}\nout={KITS_IA};`, ctx);
  const kit = ctx.out.KITS_IA[kitId];
  if (!kit?.ativo || !kit?.url) throw new Error(`kit "${kitId}" indisponível.`);
  return kit;
}

/** P1 — o prompt reprovado, montado como a produção o montava até 17-set. */
function montarP1(kitId, acento) {
  const { PROMPT_BASE, kitPrompt, kitChecklist } = require('./prompt-antigo-reprovado');
  const nome = kitId.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');
  const base = kitId.startsWith('elite') ? 'metallic gold #d4a017' : kitId.startsWith('royal') ? 'vivid purple #8b5cf6' : kitId.startsWith('white') ? 'off-white #f8f5f0' : 'deep black #0d0d12';
  return PROMPT_BASE
    .replace('{{KIT}}', kitPrompt(nome, base, acento))
    .replace('{{KIT_CHECKLIST}}', kitChecklist(acento));
}

/** P3 — P2 com o bloco STYLE do prompt antigo de volta. Mede o estrago do estilo. */
function montarP3(p2) {
  const { PROMPT_BASE } = require('./prompt-antigo-reprovado');
  const i = PROMPT_BASE.indexOf('STYLE — SEMI-REALISTIC');
  const f = PROMPT_BASE.indexOf('\nLIGHTING:');
  if (i < 0 || f < 0) throw new Error('Não achei o bloco STYLE no prompt antigo — aborta antes de gastar.');
  const estilo = PROMPT_BASE.slice(i, f).trim();
  const ini = p2.indexOf('RENDERING:');
  const fim = p2.indexOf('\n\nPOSE:');
  if (ini < 0 || fim < 0) throw new Error('Não achei o bloco RENDERING em P2.');
  return p2.slice(0, ini) + estilo + p2.slice(fim);
}

const baixar = async (url) => Buffer.from(await (await fetch(url)).arrayBuffer());

// ── medidas e imagem ──────────────────────────────────────────────────────────

/** Achatamento da coroa (CLAUDE.md): ~0 cúpula normal; > 0,5 cabeça comida. */
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

/** Folha de contacto: as 5 células lado a lado, rotuladas com as letras cegas. */
async function folhaDeContato(celulas, destino) {
  const CW = 300, CH = 450, PAD = 16, TOPO = 44;
  const W = PAD + celulas.length * (CW + PAD), H = TOPO + CH + PAD;
  const fundo = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#0d0d12"/>
    ${celulas.map((c, i) => `<text x="${PAD + i * (CW + PAD) + CW / 2}" y="30" fill="#d4a017"
      font-family="Arial,Helvetica,sans-serif" font-size="26" font-weight="bold" text-anchor="middle">${c.letra}</text>`).join('')}
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

/** Mulberry32 — o mesmo da casa; embaralha as letras de forma reproduzível. */
function mulberry32(a) {
  return function proximo() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── principal ─────────────────────────────────────────────────────────────────

(async () => {
  if (!CHAVE) { console.error('FAL_KEY em falta no ambiente.'); process.exit(1); }
  const pastaFotos = arg('fotos', FOTOS_OMISSAO);
  const teto = Number(arg('teto', '1.00'));
  const filtro = (arg('so', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!fs.existsSync(pastaFotos)) { console.error(`Pasta não encontrada: ${pastaFotos}`); process.exit(1); }

  let fotos = fs.readdirSync(pastaFotos).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  if (filtro.length) fotos = fotos.filter((f) => filtro.some((p) => f.toLowerCase().startsWith(p.toLowerCase())));
  if (!fotos.length) { console.error(`Nenhuma foto em ${pastaFotos}.`); process.exit(1); }

  const kit = lerKits('dark-gold');
  const P2 = montarPrompt('dark-gold');   // o prompt DE PRODUÇÃO desde 17-set
  const p1 = montarP1('dark-gold', kit.acento); // o reprovado, para comparação
  const p3 = montarP3(P2);
  const soVariantes = (arg('variantes', '') || '').split(',').map((s) => Number(s)).filter(Boolean);
  const VARIANTES = [
    { n: 1, nome: 'P1 (produção)', prompt: p1, fidelity: null, entrada: 'retrato' },
    { n: 2, nome: 'P1 + fidelity high', prompt: p1, fidelity: 'high', entrada: 'retrato' },
    { n: 3, nome: 'P2 retrato fiel', prompt: P2, fidelity: null, entrada: 'retrato' },
    { n: 4, nome: 'P2 + fidelity high', prompt: P2, fidelity: 'high', entrada: 'retrato' },
    { n: 5, nome: 'P3 (P2 + STYLE produção) + fidelity high', prompt: p3, fidelity: 'high', entrada: 'retrato' },
    { n: 6, nome: 'P2 + fidelity high · entrada QUADRADA', prompt: P2, fidelity: 'high', entrada: 'quadrada' },
    // Variante 7 (17-set, achado do custo): a MESMA receita da 4, mas com a
    // fidelidade de entrada BAIXA — 135 tokens por imagem em vez de 3.050. É a
    // que mostra quanto da semelhança se perde ao deixar de pagar a entrada cara.
    { n: 7, nome: 'P2 + fidelity LOW (barata)', prompt: P2, fidelity: 'low', entrada: 'retrato' },
  ].filter((v) => !soVariantes.length || soVariantes.includes(v.n));

  const estimado = fotos.length * VARIANTES.length * (CUSTO_MEDIDO + CUSTO_BIREFNET);
  console.log(`\nBANCADA DO PROMPT · ${MODELO} · low · 1024x1536 · kit dark-gold`);
  console.log(`Fotos: ${fotos.length} · variantes: ${VARIANTES.length} · gerações: ${fotos.length * VARIANTES.length}`);
  console.log(`Custo estimado pelo MEDIDO ($${CUSTO_MEDIDO.toFixed(3)}/geração): $${estimado.toFixed(2)} (tecto $${teto.toFixed(2)})`);
  console.log(`  (a tabela de saída sozinha diria $${(fotos.length * VARIANTES.length * (PRECO.low['1024x1536'] + CUSTO_BIREFNET)).toFixed(2)} — é a conta que o CLAUDE.md usa e que esta bancada mostrou estar errada)`);
  if (estimado > teto) {
    console.error(`\nRECUSADO: passa o tecto. Corre com --teto ${(Math.ceil(estimado * 100) / 100).toFixed(2)} ou menos fotos.\n`);
    process.exit(1);
  }
  for (const v of VARIANTES) console.log(`  ${v.n}  ${v.nome.padEnd(42)} prompt ${String(v.prompt.length).padStart(5)}ch · input_fidelity ${(v.fidelity || '(omitido)').padEnd(9)} · entrada ${v.entrada}`);
  console.log('');

  // --so-entradas: prepara e mostra as entradas (retrato e quadrada) sem gastar
  // um dólar. É a conferência do corte quadrado antes de pagar 42 gerações.
  if (process.argv.includes('--so-entradas')) {
    fs.mkdirSync(SAIDA, { recursive: true });
    const celulas = [];
    for (const foto of fotos) {
      const buf = fs.readFileSync(path.join(pastaFotos, foto));
      celulas.push({ letra: path.parse(foto).name.slice(0, 12), png: await preprocessarQuadrado(buf) });
    }
    const destino = path.join(SAIDA, 'entradas-quadradas.png');
    await folhaDeContato(celulas, destino);
    console.log(`Entradas quadradas (nada foi gasto): ${destino}\n`);
    process.exit(0);
  }

  fs.mkdirSync(SAIDA, { recursive: true });
  // --acrescentar: junta-se ao que já está em saida-prompt em vez de começar do
  // zero. É o que permite completar uma foto que falhou sem repetir (e pagar)
  // as outras seis.
  const acrescentar = process.argv.includes('--acrescentar');
  const lerCsv = (f) => {
    const p = path.join(SAIDA, f);
    if (!acrescentar || !fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8').trim().split('\n')
      .map((l) => l.match(/("([^"]|"")*"|[^,]*)/g).filter((_, i) => i % 2 === 0).map((c) => c.replace(/^"|"$/g, '').replace(/""/g, '"')));
  };
  const chaveAntiga = acrescentar && fs.existsSync(path.join(SAIDA, 'chave.json'))
    ? JSON.parse(fs.readFileSync(path.join(SAIDA, 'chave.json'), 'utf8')) : null;
  const chave = chaveAntiga || { modelo: MODELO, qualidade: 'low', tamanho: '1024x1536', kit: 'dark-gold', gerado: new Date().toISOString(), variantes: {}, fotos: {} };
  for (const v of VARIANTES) chave.variantes[v.n] = { nome: v.nome, input_fidelity: v.fidelity, entrada: v.entrada, prompt_chars: v.prompt.length };
  const custos = lerCsv('custos.csv') || [['foto', 'variante', 'prompt', 'input_fidelity', 'entrada', 'chamada', 'custo_usd', 'fonte_custo', 'segundos', 'dimensao', 'achatamento', 'cabeca_cortada']];
  const avaliacao = lerCsv('avaliacao.csv') || [['foto', 'letra', 'semelhanca_1a5', 'estilo_1a5', 'kit_certo_S_N', 'notas']];
  if (acrescentar) console.log(`(a acrescentar ao que já existe: ${custos.length - 1} linhas de custo, ${Object.keys(chave.fotos).length} fotos)\n`);
  const temporarios = [];
  let primeiraChamada = true;
  let fidelityRecusado = false;

  // Nome da pasta de cada foto. O sufixo numérico NÃO é enfeite: "…22d - Cópia
  // (3)" e "…22d - Cópia" davam o MESMO nome depois de cortar a 40 caracteres, e
  // a segunda escreveu por cima da primeira — sete gerações pagas e perdidas na
  // 1ª corrida. Só quem colide leva sufixo, para os nomes já usados não mudarem.
  const usados = new Set(Object.keys(chave.fotos));
  const nomeDaPasta = (foto) => {
    const cru = path.parse(foto).name.replace(/[^\w-]/g, '_').slice(0, 40);
    if (!usados.has(cru)) { usados.add(cru); return cru; }
    let i = 2;
    while (usados.has(`${cru}_${i}`)) i += 1;
    usados.add(`${cru}_${i}`);
    return `${cru}_${i}`;
  };

  for (const foto of fotos) {
    const nome = nomeDaPasta(foto);
    const pastaFoto = path.join(SAIDA, nome);
    fs.mkdirSync(pastaFoto, { recursive: true });
    console.log(`\n── ${nome} ${'─'.repeat(Math.max(0, 60 - nome.length))}`);

    // Duas entradas: a da produção (retrato com faixa de 18%) e a quadrada da
    // variante 6. Ambas sobem ao bucket público 'kits' e saem no fim.
    const entradas = {};
    try {
      const bruta = fs.readFileSync(path.join(pastaFotos, foto));
      for (const [tipo, fn, ficheiro] of [['retrato', preprocessarRetrato, 'entrada.jpg'], ['quadrada', preprocessarQuadrado, 'entrada-quadrada.jpg']]) {
        const img = await fn(bruta);
        const caminho = `tmp-prompt/${nome}-${tipo}.jpg`;
        const { error } = await supabase.storage.from('kits').upload(caminho, img, { contentType: 'image/jpeg', upsert: true });
        if (error) throw new Error(`upload ${tipo}: ${error.message}`);
        temporarios.push(caminho);
        const { data: pub } = supabase.storage.from('kits').getPublicUrl(caminho);
        entradas[tipo] = `${pub.publicUrl}?v=${Date.now()}`;
        fs.writeFileSync(path.join(pastaFoto, ficheiro), img);
      }
    } catch (e) {
      console.error(`   etapa 0 falhou: ${e.message} — salto esta foto`);
      continue;
    }

    const feitas = [];
    for (const v of VARIANTES) {
      const input = {
        prompt: v.prompt, image_urls: [entradas[v.entrada], kit.url],
        quality: 'low', image_size: '1024x1536', num_images: 1, output_format: 'png',
      };
      if (v.fidelity) input.input_fidelity = v.fidelity;
      try {
        let ger;
        try {
          ger = await chamarFal(MODELO, input);
        } catch (e) {
          // A fal recusou input_fidelity? Regista e repete SEM ele — nunca salta em silêncio.
          if (v.fidelity && /input_fidelity/i.test(e.message)) {
            fidelityRecusado = true;
            console.warn(`   ${v.n} AVISO: a fal recusou input_fidelity (${e.message}) — repito sem ele.`);
            delete input.input_fidelity;
            ger = await chamarFal(MODELO, input);
          } else throw e;
        }
        if (primeiraChamada) {
          const hs = Object.keys(ger.custo.headers);
          console.log(`   (headers x-fal- da 1ª chamada: ${hs.length ? hs.join(', ') : 'nenhum'} → custo ${ger.custo.usd != null ? `$${ger.custo.usd}` : 'não vem na resposta, uso a tabela'})`);
          chave.custo_nos_headers = ger.custo.usd != null ? ger.custo.campo : null;
          chave.headers_x_fal = hs;
          primeiraChamada = false;
        }
        const urlGerada = ger.dados?.images?.[0]?.url;
        if (!urlGerada) throw new Error('a IA não devolveu imagem');
        const geradaBuf = await baixar(urlGerada);
        const dim = await sharp(geradaBuf).metadata().then((m) => `${m.width}x${m.height}`);

        const rec = await chamarFal(BIREFNET, { image_url: urlGerada, model: 'General Use (Light)' });
        const urlRec = rec.dados?.image?.url;
        if (!urlRec) throw new Error('birefnet não devolveu imagem');
        const trimado = await sharp(await baixar(urlRec)).trim({ threshold: 10 }).png().toBuffer();

        const ach = await achatamento(trimado);
        const figurinha = await montarFigurinha(trimado);
        fs.writeFileSync(path.join(pastaFoto, `${v.n}.png`), figurinha);

        const custoGer = ger.custo.usd != null ? ger.custo.usd : PRECO.low[dim] ?? PRECO.low['1024x1536'];
        const custoRec = rec.custo.usd != null ? rec.custo.usd : CUSTO_BIREFNET;
        const fonte = ger.custo.usd != null ? `headers:${ger.custo.campo}` : 'tabela';
        const segundos = ger.segundos + rec.segundos;
        custos.push([nome, v.n, v.prompt === p1 ? 'P1' : v.prompt === P2 ? 'P2' : 'P3', input.input_fidelity || '(omitido)', v.entrada,
          'gpt-image-1.5+birefnet', (custoGer + custoRec).toFixed(4), fonte, segundos.toFixed(1), dim,
          ach.razao === null ? '' : ach.razao.toFixed(2), ach.cortada ? 'S' : 'N']);
        feitas.push({ n: v.n, png: figurinha });
        console.log(`   ${v.n} ok  ${dim} · achat ${ach.razao === null ? '—' : ach.razao.toFixed(2)}${ach.cortada ? ' CORTADA' : ''} · $${(custoGer + custoRec).toFixed(4)} (${fonte}) · ${segundos.toFixed(0)}s`);
      } catch (e) {
        console.error(`   ${v.n} FALHOU: ${limpar(e.message)}`);
        custos.push([nome, v.n, '', v.fidelity || '(omitido)', v.entrada, 'FALHOU', '', '', '', '', '', '']);
      }
    }

    if (feitas.length) {
      // Letras EMBARALHADAS: o dono avalia às cegas; a correspondência fica só no chave.json.
      const rnd = mulberry32(SEMENTE + nome.length * 31 + nome.charCodeAt(0));
      const ordem = feitas.map((f) => f.n);
      for (let i = ordem.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rnd() * (i + 1));
        [ordem[i], ordem[j]] = [ordem[j], ordem[i]];
      }
      const letras = 'ABCDEFG'.split('');
      const celulas = ordem.map((n, i) => ({ letra: letras[i], png: feitas.find((f) => f.n === n).png, n }));
      await folhaDeContato(celulas, path.join(pastaFoto, 'folha-de-contato.png'));
      chave.fotos[nome] = Object.fromEntries(celulas.map((c) => [c.letra, c.n]));
      (chave.arquivos ||= {})[nome] = foto; // qual foto original deu esta pasta
      for (const c of celulas) avaliacao.push([nome, c.letra, '', '', '', '']);
      console.log(`   folha: ${path.join(pastaFoto, 'folha-de-contato.png')}`);
    }
  }

  if (temporarios.length) await supabase.storage.from('kits').remove(temporarios).catch(() => {});

  fs.writeFileSync(path.join(SAIDA, 'chave.json'), JSON.stringify(chave, null, 2));
  const csv = (linhas) => linhas.map((l) => l.map((c) => (/[",;\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n');
  fs.writeFileSync(path.join(SAIDA, 'custos.csv'), csv(custos));
  fs.writeFileSync(path.join(SAIDA, 'avaliacao.csv'), csv(avaliacao));

  // ── resumo por variante (sem dizer qual é a melhor: a avaliação é do dono) ──
  const linhas = custos.slice(1).filter((l) => l[5] !== 'FALHOU');
  console.log(`\n${'='.repeat(78)}`);
  console.log('var  prompt  fidelity     entrada    custo médio   tempo médio   cabeças cortadas');
  for (const v of VARIANTES) {
    const ls = linhas.filter((l) => Number(l[1]) === v.n);
    if (!ls.length) { console.log(`${String(v.n).padEnd(4)} — sem linhas`); continue; }
    const med = ls.reduce((s, l) => s + Number(l[6]), 0) / ls.length;
    const tmp = ls.reduce((s, l) => s + Number(l[8]), 0) / ls.length;
    const cort = ls.filter((l) => l[11] === 'S').length;
    console.log(`${String(v.n).padEnd(4)} ${ls[0][2].padEnd(7)} ${ls[0][3].padEnd(12)} ${ls[0][4].padEnd(10)} $${med.toFixed(4)}       ${tmp.toFixed(0)}s           ${cort}/${ls.length}`);
  }
  const gasto = linhas.reduce((s, l) => s + Number(l[6]), 0);
  console.log(`\nGASTO REAL DESTA CORRIDA: $${gasto.toFixed(2)}${fidelityRecusado ? ' · ATENÇÃO: a fal recusou input_fidelity em pelo menos uma chamada (ver avisos acima)' : ''}`);
  console.log(`Folhas de contacto: ${SAIDA}\\<foto>\\folha-de-contato.png`);
  console.log(`Chave (NÃO abrir antes de avaliar): ${path.join(SAIDA, 'chave.json')}`);
  console.log('='.repeat(78));
})();
