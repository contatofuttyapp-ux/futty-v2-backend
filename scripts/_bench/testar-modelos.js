// ═══════════════════════════════════════════════════════════════════════════════
// BANCADA DE MODELOS (17-set) — mesmo prompt, motores mais baratos.
//
// A V6 (gpt-image-1.5/edit + P2 + entrada quadrada) resolveu a SEMELHANÇA e
// custa US$0,112. A pergunta agora é só de dinheiro: algum motor mais barato
// entrega a mesma figurinha? O prompt, a entrada e a leitura de custo vêm dos
// módulos de PRODUÇÃO — se um candidato ganhar, o que muda é uma linha.
//
// CANDIDATOS (--so-um corre só a foto do Gui, que é a rodada de triagem):
//   1  gpt-image-2.5/flare/edit · low    · foto + kit
//   2  gpt-image-2.5/flare/edit · medium · foto + kit
//   3  gpt-image-2.5/flare/edit · low    · SÓ a foto, kit por texto
//   4  seedream v5 lite/edit            · foto + kit
//   5  flux-2 klein 9b base/edit        · foto + kit
//   6  nano-banana/edit                 · foto + kit
//   7  qwen-image-edit-2511             · foto + kit
//   8  (não gera) a V6 de produção, copiada de saida-prompt/<foto>/6.png
//
// SCHEMAS CONFERIDOS ANTES DE GASTAR (fal.ai/api/openapi/queue/openapi.json):
// os cinco endpoints aceitam `image_urls` (array), portanto todos levam foto E
// kit. NENHUM tem `input_fidelity` — é um parâmetro do gpt-image-1.5 e não
// sobreviveu no 2.5, o que significa que nos candidatos não há a alavanca de
// custo que a V6 usa. Tamanho: o 2.5, o flux e o qwen aceitam {width,height};
// o nano-banana só `aspect_ratio` ('2:3'); o seedream exige que a saída tenha
// entre 2560x1440 e 4096x4096 pixels no TOTAL, então vai em 1568x2352 (o 2:3
// mais pequeno que respeita o mínimo) e é reduzido depois.
//
// CORRER (a fal só resolve na máquina do Pedro):
//   node scripts/_bench/testar-modelos.js --so-um       triagem: só o Gui
//   node scripts/_bench/testar-modelos.js --resto       as outras 6 fotos
//   --teto 3.00   aborta antes de passar deste gasto (soma os custos REAIS)
//   --so 4,6      só estes candidatos
//   --foto <prefixo>  só a foto cujo nome começa assim
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sharp = require('sharp');
const { supabase } = require('../../utils/db');
// Módulos de PRODUÇÃO — o que se mede é o que está no ar.
const { montarPrompt } = require('../../prompts/figurinha');
const { preprocessarQuadrado } = require('../../utils/entradaFigurinha');
const { chamarFal } = require('../../utils/falFila');
const { baixar, recortarFundo, achatamento, montarFigurinha, folhaDeContato, paraCsv, lerKit } = require('./comum');

const SAIDA = path.join(__dirname, 'saida-modelos-2');
const REFERENCIA = path.join(__dirname, 'saida-prompt'); // as figurinhas da V6
const FOTOS = path.join(__dirname, '..', '..', '..', '..', 'BANCADA-FOTOS');
const FOTO_TRIAGEM = 'Gui.jpeg';
const KIT_ID = 'dark-gold';

const arg = (n, o = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : o;
};
const tem = (n) => process.argv.includes(`--${n}`);

// Estimativas para o gate ANTES de gastar (a tabela pública da fal, 17-set). O
// que entra no CSV é o custo REAL, convertido como a tabela abaixo manda.
const ESTIMATIVA = { 1: 0.045, 2: 0.09, 3: 0.03, 4: 0.035, 5: 0.044, 6: 0.039, 7: 0.047 };
const CUSTO_BIREFNET = 0.002;

// ┌──────────────────────────────────────────────────────────────────────────┐
// │ x-fal-billable-units NÃO É SEMPRE DINHEIRO (achado desta bancada).       │
// │                                                                          │
// │ No gpt-image (1.5 e 2.5), que a fal cobra por TOKENS, o header traz o    │
// │ custo em dólares — 0,132 no 1.5, 0,0229 no 2.5 low, sempre com quatro    │
// │ casas, como a página de preços promete ("rounded up to the closest       │
// │ hundredth of a cent"). Nos modelos de preço fixo o header traz a         │
// │ CONTAGEM de unidades: o seedream devolveu 1,000 (uma imagem) e o flux    │
// │ 4,000 (quatro megapixels: 2 de entrada + 1,57 de saída, arredondado).    │
// │ Ler os dois como dólares dava US$5 numa bancada que custou 15 cêntimos.  │
// │                                                                          │
// │ `unidade` diz quanto vale UMA unidade daquele endpoint, pela tabela      │
// │ pública da fal; `fonte` diz se esse preço está publicado ou estimado.    │
// └──────────────────────────────────────────────────────────────────────────┘
const PRECO_UNIDADE = {
  'openai/gpt-image-2.5/flare/edit': { unidade: 1, oQueE: 'dólares (cobrado por tokens)', publicado: true },
  'fal-ai/gpt-image-1.5/edit': { unidade: 1, oQueE: 'dólares (cobrado por tokens)', publicado: true },
  'fal-ai/bytedance/seedream/v5/lite/edit': { unidade: 0.035, oQueE: 'imagens', publicado: false },
  'fal-ai/flux-2/klein/9b/base/edit': { unidade: 0.011, oQueE: 'megapixels (entrada + saída)', publicado: true },
  'fal-ai/nano-banana/edit': { unidade: 0.039, oQueE: 'imagens', publicado: true },
  'fal-ai/qwen-image-edit-2511': { unidade: 0.03, oQueE: 'megapixels', publicado: false },
};

/** Converte o header em dólares. Devolve também como foi convertido, para o CSV. */
function emDolares(endpoint, custo) {
  if (custo?.usd == null) return { usd: null, nota: 'sem header' };
  const t = PRECO_UNIDADE[endpoint];
  if (!t) return { usd: custo.usd, nota: 'header cru (endpoint sem tabela)' };
  if (t.unidade === 1) return { usd: custo.usd, nota: 'header em dólares' };
  return {
    usd: custo.usd * t.unidade,
    nota: `${custo.usd} ${t.oQueE} x $${t.unidade}${t.publicado ? '' : ' (preço estimado)'}`,
  };
}

const P2 = montarPrompt(KIT_ID);

/**
 * O kit DESCRITO, para o candidato 3 (que vai sem a imagem do kit). O texto sai
 * do mesmo módulo de produção: a frase do kit é a que o prompt já usa, só muda
 * a moldura à volta ("Image 2" deixa de existir).
 */
const P2_SEM_KIT = P2
  .replace('Sticker-card illustration of the REAL person in Image 1, wearing the kit in Image 2.',
    'Sticker-card illustration of the REAL person in Image 1, wearing the football kit described below.')
  .replace('KIT — reproduce Image 2 exactly:', 'KIT — the player wears exactly this:')
  .replace(' — all as in Image 2.', '.');

/**
 * Versão COMPACTA do prompt, para os modelos de difusão (4-7). Eles não "leem"
 * um briefing de 1.800 caracteres como o GPT Image: passam a pesar cada frase
 * como estilo e o retrato desfaz-se. Fica o essencial: quem é, os óculos, o
 * kit, o enquadramento e o fundo cinza. Qual versão cada candidato usou vai no
 * CSV — sem isso a comparação não se pode repetir.
 */
function compactar(prompt) {
  const linha = (marca) => (prompt.split('\n').find((l) => l.startsWith(marca)) || '').trim();
  const face = linha('FACE FIRST').split('Do not idealize')[0].trim();
  return [
    'Sticker-card portrait illustration of the REAL person in Image 1, wearing the kit in Image 2.',
    face,
    linha('KIT —'),
    'Frontal bust, head complete with empty space above it, both arms complete, never touching the edges.',
    'Portrait 2:3. Background: flat mid-grey #8a8a8a, nothing else.',
  ].join(' ');
}
const P2_COMPACTO = compactar(P2);

// ── os candidatos ─────────────────────────────────────────────────────────────
// `entrada(fotoUrl, kitUrl)` monta o corpo do pedido de cada endpoint com os
// nomes de parâmetro que o SCHEMA daquele endpoint aceita — foi por isso que os
// schemas se leram antes: `image_size` no 2.5/flux/qwen, `aspect_ratio` no
// nano-banana, e a faixa de pixels do seedream.
const CANDIDATOS = [
  {
    n: 1,
    nome: 'gpt-image-2.5 flare · low',
    endpoint: 'openai/gpt-image-2.5/flare/edit',
    prompt: () => P2,
    entrada: (foto, kit) => ({ prompt: P2, image_urls: [foto, kit], quality: 'low', image_size: { width: 1024, height: 1536 }, num_images: 1, output_format: 'png' }),
  },
  {
    n: 2,
    nome: 'gpt-image-2.5 flare · medium',
    endpoint: 'openai/gpt-image-2.5/flare/edit',
    prompt: () => P2,
    entrada: (foto, kit) => ({ prompt: P2, image_urls: [foto, kit], quality: 'medium', image_size: { width: 1024, height: 1536 }, num_images: 1, output_format: 'png' }),
  },
  {
    n: 3,
    nome: 'gpt-image-2.5 flare · low · kit por TEXTO',
    endpoint: 'openai/gpt-image-2.5/flare/edit',
    prompt: () => P2_SEM_KIT,
    entrada: (foto) => ({ prompt: P2_SEM_KIT, image_urls: [foto], quality: 'low', image_size: { width: 1024, height: 1536 }, num_images: 1, output_format: 'png' }),
  },
  {
    n: 4,
    nome: 'seedream v5 lite',
    endpoint: 'fal-ai/bytedance/seedream/v5/lite/edit',
    difusao: true,
    // 1568x2352 = 3.687.936 px: o 2:3 mais pequeno acima do mínimo de 2560x1440
    // que o schema exige. Abaixo disso a fal reescala e o 2:3 perde-se.
    entrada: (foto, kit, prompt) => ({ prompt, image_urls: [foto, kit], image_size: { width: 1568, height: 2352 }, num_images: 1 }),
  },
  {
    n: 5,
    nome: 'flux-2 klein 9b base',
    endpoint: 'fal-ai/flux-2/klein/9b/base/edit',
    difusao: true,
    entrada: (foto, kit, prompt) => ({ prompt, image_urls: [foto, kit], image_size: { width: 1024, height: 1536 }, num_images: 1, output_format: 'png' }),
  },
  {
    n: 6,
    nome: 'nano-banana',
    endpoint: 'fal-ai/nano-banana/edit',
    difusao: true,
    // Só tem aspect_ratio — não dá para pedir pixels.
    entrada: (foto, kit, prompt) => ({ prompt, image_urls: [foto, kit], aspect_ratio: '2:3', num_images: 1, output_format: 'png' }),
  },
  {
    n: 7,
    nome: 'qwen-image-edit-2511',
    endpoint: 'fal-ai/qwen-image-edit-2511',
    difusao: true,
    entrada: (foto, kit, prompt) => ({ prompt, image_urls: [foto, kit], image_size: { width: 1024, height: 1536 }, num_images: 1, output_format: 'png' }),
  },
];

/** A imagem devolvida, seja qual for o formato de resposta do endpoint. */
const urlDaResposta = (d) => d?.images?.[0]?.url || d?.image?.url || d?.images?.[0] || null;

(async () => {
  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta no ambiente.'); process.exit(1); }
  const teto = Number(arg('teto', '3.00'));
  const soCandidatos = (arg('so', '') || '').split(',').map(Number).filter(Boolean);
  const candidatos = CANDIDATOS.filter((c) => !soCandidatos.length || soCandidatos.includes(c.n));

  let fotos = fs.readdirSync(FOTOS).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  const soFoto = arg('foto', '');
  if (soFoto) fotos = fotos.filter((f) => f.toLowerCase().startsWith(soFoto.toLowerCase()));
  else if (tem('so-um')) fotos = fotos.filter((f) => f === FOTO_TRIAGEM);
  else if (tem('resto')) fotos = fotos.filter((f) => f !== FOTO_TRIAGEM);
  if (!fotos.length) { console.error('nenhuma foto para correr.'); process.exit(1); }

  const kit = lerKit(KIT_ID);
  const estimado = fotos.length * candidatos.reduce((s, c) => s + (ESTIMATIVA[c.n] || 0.05) + CUSTO_BIREFNET, 0);
  console.log(`\nBANCADA DE MODELOS · prompt P2 de produção · kit ${KIT_ID}`);
  console.log(`Fotos: ${fotos.length} · candidatos: ${candidatos.map((c) => c.n).join(', ')} · gerações: ${fotos.length * candidatos.length}`);
  console.log(`Estimativa pela tabela: $${estimado.toFixed(2)} · tecto $${teto.toFixed(2)}`);
  if (estimado > teto) { console.error(`\nRECUSADO: a estimativa passa o tecto. Corre com menos candidatos ou --teto maior.\n`); process.exit(1); }
  for (const c of candidatos) console.log(`  ${c.n}  ${c.nome.padEnd(36)} ${c.endpoint}`);
  console.log('');

  fs.mkdirSync(SAIDA, { recursive: true });
  const ficheiroCsv = path.join(SAIDA, 'custos.csv');
  const linhas = fs.existsSync(ficheiroCsv)
    ? fs.readFileSync(ficheiroCsv, 'utf8').trim().split('\n').map((l) => l.split(','))
    : [['foto', 'candidato', 'endpoint', 'parametros', 'prompt', 'custo_usd', 'unidades_no_header', 'fonte_custo', 'segundos', 'dimensao', 'achatamento', 'cabeca_cortada', 'uniforme']];
  const temporarios = [];
  let gasto = 0;

  const usados = new Set();
  for (const foto of fotos) {
    // Sufixo por colisão: "…22d - Cópia (3)" e "…22d - Cópia" dão o MESMO nome
    // depois de cortar a 40 caracteres, e a segunda escrevia por cima da
    // primeira. Já custou sete gerações pagas na bancada do prompt; aqui a
    // pasta ganha _2, _3… quando o nome já existe.
    const cru = path.parse(foto).name.replace(/[^\w-]/g, '_').slice(0, 40);
    let nome = cru;
    for (let i = 2; fs.existsSync(path.join(SAIDA, nome)) && !usados.has(nome); i += 1) nome = `${cru}_${i}`;
    usados.add(nome);
    const pasta = path.join(SAIDA, nome);
    fs.mkdirSync(pasta, { recursive: true });
    console.log(`\n── ${nome} ${'─'.repeat(Math.max(0, 56 - nome.length))}`);

    // A MESMA entrada da produção: quadrado 1024×1024 com a cabeça a 12% do topo.
    let fotoUrl;
    try {
      const quadrada = await preprocessarQuadrado(fs.readFileSync(path.join(FOTOS, foto)));
      const caminho = `tmp-modelos/${nome}.jpg`;
      const { error } = await supabase.storage.from('kits').upload(caminho, quadrada, { contentType: 'image/jpeg', upsert: true });
      if (error) throw new Error(`upload: ${error.message}`);
      temporarios.push(caminho);
      const { data: pub } = supabase.storage.from('kits').getPublicUrl(caminho);
      fotoUrl = `${pub.publicUrl}?v=${Date.now()}`;
      fs.writeFileSync(path.join(pasta, 'entrada.jpg'), quadrada);
    } catch (e) {
      console.error(`   entrada falhou: ${e.message} — salto esta foto`);
      continue;
    }

    const feitas = [];
    for (const c of candidatos) {
      if (gasto >= teto) { console.error(`   PARADO: já gastei $${gasto.toFixed(2)} (tecto $${teto.toFixed(2)})`); break; }
      // Os de difusão levam o prompt compacto; os GPT Image levam o P2 inteiro.
      const prompt = c.difusao ? P2_COMPACTO : c.prompt();
      const qualPrompt = c.difusao ? 'P2 compacto' : (c.n === 3 ? 'P2 sem kit' : 'P2 inteiro');
      const corpo = c.entrada(fotoUrl, kit.url, prompt);
      try {
        const r = await chamarFal(c.endpoint, corpo);
        const url = urlDaResposta(r.dados);
        if (!url) throw new Error('não devolveu imagem');
        const geradaBuf = await baixar(typeof url === 'string' ? url : url.url);
        const dim = await sharp(geradaBuf).metadata().then((m) => `${m.width}x${m.height}`);

        // Uma imagem só é útil depois do birefnet, como em produção.
        const subida = await supabase.storage.from('kits').upload(`tmp-modelos/${nome}-${c.n}.png`, geradaBuf, { contentType: 'image/png', upsert: true });
        if (subida.error) throw new Error(`upload da gerada: ${subida.error.message}`);
        temporarios.push(`tmp-modelos/${nome}-${c.n}.png`);
        const { data: pubG } = supabase.storage.from('kits').getPublicUrl(`tmp-modelos/${nome}-${c.n}.png`);
        const rec = await recortarFundo(`${pubG.publicUrl}?v=${Date.now()}`);

        const ach = await achatamento(rec.trimado);
        fs.writeFileSync(path.join(pasta, `${c.n}.png`), await montarFigurinha(rec.trimado));
        feitas.push(c.n);

        const conv = emDolares(c.endpoint, r.custo);
        const custo = (conv.usd ?? ESTIMATIVA[c.n] ?? 0) + (rec.custo.usd ?? CUSTO_BIREFNET);
        gasto += custo;
        const fonte = r.custo.usd != null ? conv.nota : 'estimativa (sem header)';
        const params = Object.entries(corpo).filter(([k]) => k !== 'prompt' && k !== 'image_urls')
          .map(([k, v]) => `${k}=${typeof v === 'object' ? `${v.width}x${v.height}` : v}`).join(' ') + ` imagens=${corpo.image_urls.length}`;
        linhas.push([nome, c.n, c.endpoint, params, qualPrompt, custo.toFixed(4), r.custo.usd ?? '', fonte,
          (r.segundos + rec.segundos).toFixed(1), dim, ach.razao === null ? '' : ach.razao.toFixed(2), ach.cortada ? 'S' : 'N', '']);
        console.log(`   ${c.n} ok  ${dim.padEnd(11)} achat ${ach.razao === null ? '—' : ach.razao.toFixed(2)}${ach.cortada ? ' CORTADA' : '        '} $${custo.toFixed(4)} (${fonte})  ${(r.segundos + rec.segundos).toFixed(0)}s`);
      } catch (e) {
        console.error(`   ${c.n} FALHOU: ${e.message}`);
        linhas.push([nome, c.n, c.endpoint, '', qualPrompt, '', '', 'FALHOU', '', '', '', '', '']);
      }
    }

    // 8 = a produção de hoje (V6), copiada da bancada do prompt. Não gera nada.
    const daV6 = path.join(REFERENCIA, nome, '6.png');
    if (fs.existsSync(daV6)) {
      fs.copyFileSync(daV6, path.join(pasta, '8.png'));
      feitas.push(8);
    } else {
      console.log(`   8 (V6 de produção) não encontrada em ${path.relative(SAIDA, daV6)} — folha sai sem a referência`);
    }

    // A folha leva TUDO o que está na pasta, não só o que esta corrida gerou —
    // senão correr '--so 6,7' apagava os candidatos anteriores da comparação.
    const naPasta = fs.readdirSync(pasta).filter((f) => /^[0-9]+.png$/.test(f)).map((f) => Number(f.replace('.png', '')));
    if (naPasta.length) {
      const feitasTodas = [...new Set([...feitas, ...naPasta])];
      feitas.length = 0; feitas.push(...feitasTodas);
    }
    if (feitas.length) {
      // Rótulo CURTO: o nome completo do motor não cabe na célula de 300 px e
      // saía cortado a meio ("gpt-image-2.5 flare · low · ki").
      const CURTO = {
        1: 'gpt-2.5 low', 2: 'gpt-2.5 medium', 3: 'gpt-2.5 · kit texto', 4: 'seedream v5 lite',
        5: 'flux-2 klein 9b', 6: 'nano-banana', 7: 'qwen 2511', 8: 'V6 HOJE (produção)',
      };
      const rotulo = (n) => `${n} · ${CURTO[n] || n}`;
      await folhaDeContato(feitas.sort((a, b) => a - b).map((n) => ({ letra: rotulo(n), png: fs.readFileSync(path.join(pasta, `${n}.png`)) })),
        path.join(pasta, 'folha-de-contato.png'));
      console.log(`   folha: ${path.join(pasta, 'folha-de-contato.png')}`);
    }
  }

  if (temporarios.length) await supabase.storage.from('kits').remove(temporarios).catch(() => {});
  fs.writeFileSync(ficheiroCsv, paraCsv(linhas));

  // ── resumo ──
  const dados = linhas.slice(1).filter((l) => l[7] !== 'FALHOU');
  console.log(`\n${'='.repeat(92)}`);
  console.log('cand  motor                                  custo médio   tempo    cortadas   gerações');
  for (const c of CANDIDATOS) {
    const ls = dados.filter((l) => Number(l[1]) === c.n);
    if (!ls.length) continue;
    const med = ls.reduce((s, l) => s + Number(l[5]), 0) / ls.length;
    const tmp = ls.reduce((s, l) => s + Number(l[8]), 0) / ls.length;
    const cort = ls.filter((l) => l[11] === 'S').length;
    console.log(`${String(c.n).padEnd(5)} ${c.nome.padEnd(38)} $${med.toFixed(4)}      ${tmp.toFixed(0)}s      ${cort}/${ls.length}        ${ls.length}`);
  }
  console.log(`\nGASTO REAL DESTA CORRIDA: $${gasto.toFixed(2)} · total no CSV: $${dados.reduce((s, l) => s + Number(l[5] || 0), 0).toFixed(2)}`);
  console.log(`Folhas: ${SAIDA}\\<foto>\\folha-de-contato.png`);
  console.log(`Referência: o 8 de cada folha é a V6 que está em dev (US$0,112).`);
  console.log('='.repeat(92));
})();
