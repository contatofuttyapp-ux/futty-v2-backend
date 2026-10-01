// BANCADA — 5 MODELOS FICTÍCIOS para a publicidade "low vs medium"
// (decisão do dono, 31-jul: exemplos diversos em rodízio, nunca classificar o
//  usuário; pessoas que NÃO existem, geradas por IA, sem direito de imagem)
//
// O que faz, por modelo:
//   1. gera uma "foto" de uma pessoa fictícia brasileira (texto → imagem)
//   2. passa essa foto pela ESTEIRA REAL de produção (prompt lido de auth.js)
//      duas vezes: quality LOW e quality MEDIUM — o par que a publicidade mostra
//   3. mede achatamento e guarda tudo em saida-modelos/ + galeria HTML
//
// Custo: 5 fotos t2i (~$0,013) + 5 low ($0,015) + 5 medium ($0,053) ≈ $0,41.
// Tecto: $0,60. É custo ÚNICO — os pares rodam na publicidade para sempre.
//
// Uso:  node scripts/_bench/gerar-modelos-ficticios.js
//
// RONDA 2 — refazer só o medium de modelos escolhidos, com estilo "rico":
//   node scripts/_bench/gerar-modelos-ficticios.js --refazer m3-homem-negro,m5-homem-grisalho --estilo rico
// Motivo (31-jul, dono): em m3/m5 o low saiu MELHOR que o medium. O prompt é
// afinado para o low (proíbe textura fina) e amarra o medium — o pago tem de
// SUBIR de estilo junto com a qualidade. O --estilo rico liberta o detalhe
// fino SÓ no medium; reusa as fotos fictícias do disco (sem custo t2i) e grava
// {id}-medium-rico.png ao lado do par original para comparação.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sharp = require('sharp');
const fal = require('@fal-ai/serverless-client');
const { supabase } = require('../../utils/db');

fal.config({ credentials: process.env.FAL_KEY });

const SAIDA = path.join(__dirname, 'saida-modelos');
const TETO = 0.6;
const PRECO = { foto: 0.013, low: 0.015, medium: 0.053 };

// 5 perfis diversos. Fictícios, brasileiros, sem parecença com gente famosa.
const MODELOS = [
  { id: 'm1-homem-claro',   desc: 'Brazilian man, around 28, light skin, short dark hair, light stubble' },
  { id: 'm2-mulher-parda',  desc: 'Brazilian woman, around 25, medium brown skin, dark curly hair tied back' },
  { id: 'm3-homem-negro',   desc: 'Brazilian Black man, around 35, very short hair, full beard' },
  { id: 'm4-mulher-negra',  desc: 'Brazilian Black woman, around 30, long curly dark hair' },
  { id: 'm5-homem-grisalho',desc: 'Brazilian man, around 52, tan skin, short grey hair, grey stubble' },
];

const fotoPrompt = (desc) => `Casual amateur smartphone photo of a fictional ${desc}.
Completely fictional person who does not exist and does not resemble any real or famous person.
Frontal, chest-up, looking at the camera, natural friendly smile.
Plain light-grey wall background, soft even daylight, sharp focus.
Ordinary casual t-shirt. No sunglasses, no hat, no logos.
Realistic photography, not illustration.`;

// Estilo RICO para o medium: mesma composição, pincel fino liberado.
// Substitui a secção STYLE do prompt de produção (que é broad-brush, pró-low).
const ESTILO_RICO = `STYLE — PREMIUM DETAILED PAINTING (paid tier):
- Premium Panini / FIFA Ultimate Team card painting with FINE, refined detail
- Subtle lifelike skin shading and texture on the face — realistic but painted
- Hair with visible depth and fine strands, crisp clean silhouette
- Fabric with satin sheen, fine folds and subtle weave on the jersey
- Rich deep colour, polished edges, premium collector finish
- Clearly MORE refined and detailed than a basic sticker — this is the deluxe version
- NOT photographic, NOT anime, NOT cartoon`;

/** Troca a secção STYLE do prompt de produção pelo estilo rico. Aborta se a forma mudar. */
function comEstiloRico(prompt) {
  const iS = prompt.indexOf('STYLE —');
  const iL = prompt.indexOf('LIGHTING:');
  if (iS < 0 || iL < 0 || iL < iS) throw new Error('não encontrei a secção STYLE/LIGHTING no prompt de produção');
  return prompt.slice(0, iS) + ESTILO_RICO + '\n\n' + prompt.slice(iL);
}

const flag = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };

// ─── RODADA 29B (30-set): --jovens — 3 modelos novos para as REDES (onboarding/anúncios) ────────────────
// Dono pediu 15–25 anos; a Freaky recomendou 18+ (modelo com cara de menor num app com compra e cadastro 13+ é
// bandeira vermelha na revisão da Apple e do Google) — o prompt diz "clearly an adult in their early twenties".
// Dois homens e uma mulher, traços brasileiros/europeus, kit Dark Gold. Usa a RECEITA REAL da produção
// (utils/geracaoFigurinha.js, V6) e não a esteira antiga deste arquivo (que lia o prompt de routes/auth.js e já
// não existe lá). Teto US$1 (estimativa ~US$0,40: 3 fotos + 3 V6). Só o cartão final importa: um por modelo.
//   node scripts/_bench/gerar-modelos-ficticios.js --jovens
// Saída: scripts/_bench/saida-modelos-jovens/ e cópia dos 3 cartões em FUT/REDES/modelos/ (fora do bundle do app).
const MODELOS_JOVENS = [
  { id: 'j1-homem-claro',   desc: 'Brazilian man, around 22, light olive skin, short dark wavy hair, clean-shaven' },
  { id: 'j2-mulher-parda',  desc: 'Brazilian woman, around 21, light brown skin, dark wavy shoulder-length hair' },
  { id: 'j3-homem-europeu', desc: 'Portuguese man, around 24, fair skin, short light-brown hair, light stubble' },
];
const TETO_JOVENS = 1.0;
// ─── RODADA 29E (1-out): --jovens2 — mais 3 na MESMA receita, para o mini sorteio do onboarding fechar 3 com cara de Brasil
// (j1, j2, j4) e 3 de Portugal (j3, j5, j6). Mesma regra de idade (18–25, nunca menor, nunca pessoa real), mesmo kit.
//   node scripts/_bench/gerar-modelos-ficticios.js --jovens2
const MODELOS_JOVENS_2 = [
  { id: 'j4-homem-negro-br',    desc: 'Brazilian Black man, around 23, dark brown skin, very short hair, clean-shaven' },
  { id: 'j5-mulher-portuguesa', desc: 'Portuguese woman, around 22, light olive skin, long straight dark-brown hair' },
  { id: 'j6-homem-portugues',   desc: 'Portuguese man, around 20, olive Mediterranean skin, short dark curly hair, clean-shaven' },
];

async function rodarJovens(lista = MODELOS_JOVENS, teto = TETO_JOVENS) {
  const { chamarFal, emDolares } = require('../../utils/falFila');
  const { gerarFigurinha } = require('../../utils/geracaoFigurinha');
  const { preprocessarQuadrado } = require('../../utils/entradaFigurinha');
  const { lerKit, achatamento: medirCoroa, montarFigurinha } = require('./comum');
  const saida = path.join(__dirname, 'saida-modelos-jovens');
  const REDES = path.join(__dirname, '..', '..', '..', '..', 'REDES', 'modelos');
  fs.mkdirSync(saida, { recursive: true });
  fs.mkdirSync(REDES, { recursive: true });
  const kit = lerKit('dark-gold');
  const temporarios = [];
  const subir = async (nome, buf, tipo) => {
    const caminho = `tmp-modelos-jovens/${Date.now()}-${nome}`;
    const { error } = await supabase.storage.from('kits').upload(caminho, buf, { contentType: tipo, upsert: true });
    if (error) throw new Error(`upload ${caminho}: ${error.message}`);
    temporarios.push(caminho);
    return `${supabase.storage.from('kits').getPublicUrl(caminho).data.publicUrl}?v=${Date.now()}`;
  };
  console.log(`\n${lista.length} MODELOS JOVENS (18–25) · receita real da produção · estimativa ~US$0,40 · teto US${teto.toFixed(2)}\n`);
  let gasto = 0;
  const feitos = [];
  for (const M of lista) {
    if (gasto >= teto - 0.15) { console.error(`PAREI antes de ${M.id}: gasto US$${gasto.toFixed(3)} perto do teto`); break; }
    try {
      const pedido = await chamarFal('fal-ai/gpt-image-1.5', {
        prompt: `${fotoPrompt(M.desc)}\nThe person is clearly an adult in their early twenties.`,
        image_size: '1024x1536', quality: 'low', num_images: 1,
      });
      gasto += emDolares('fal-ai/gpt-image-1.5', pedido.custo).usd || 0.02;
      const urlFoto = pedido.dados?.images?.[0]?.url;
      if (!urlFoto) throw new Error('t2i não devolveu foto');
      const foto = Buffer.from(await (await fetch(urlFoto)).arrayBuffer());
      fs.writeFileSync(path.join(saida, `${M.id}-foto.png`), foto);

      const quadrada = await preprocessarQuadrado(foto);
      const fotoUrl = await subir(`${M.id}-entrada.jpg`, quadrada, 'image/jpeg');
      const r = await gerarFigurinha({ fotoUrl, kitUrl: kit.url, kitId: 'dark-gold', etiqueta: M.id, publicar: subir });
      gasto += r.custo.usd || 0.114;
      const recorte = await sharp(r.recorteBuffer).trim({ threshold: 10 }).png().toBuffer();
      const { razao: ach, cortada } = await medirCoroa(recorte);
      const card = await montarFigurinha(recorte);
      fs.writeFileSync(path.join(saida, `${M.id}-recorte.png`), recorte);
      fs.writeFileSync(path.join(saida, `${M.id}-card.png`), card);
      fs.writeFileSync(path.join(REDES, `modelo-jovem-${M.id}.png`), card);
      feitos.push({ id: M.id, ach, cortada });
      console.log(`OK ${M.id.padEnd(18)} achat ${ach === null ? '-' : ach.toFixed(2)}${cortada ? ' (CORTADA)' : ''}  custo acumulado US${gasto.toFixed(3)}`);
    } catch (e) {
      console.error(`FALHOU ${M.id}: ${e.message}`);
    }
  }
  if (temporarios.length) await supabase.storage.from('kits').remove(temporarios).catch(() => {});
  const ruins = feitos.filter((l) => l.ach !== null && l.ach > 0.5);
  console.log(`\n${feitos.length}/${lista.length} cartões · defeitos de coroa: ${ruins.length} · custo real US$${gasto.toFixed(3)}`);
  console.log(`saída: ${saida}\ncópias: ${REDES}\n`);
}

/** Prompt REAL de produção (auth.js já tem {{KIT}} e {{KIT_CHECKLIST}}). */
function producao(kitId) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'auth.js'), 'utf8');
  const iP = src.indexOf('const PROMPT_BASE');
  const iK = src.indexOf('const KITS_IA = {');
  const fim = src.indexOf('\n};', iK);
  if (iP < 0 || iK < 0 || fim < 0) throw new Error('não consegui ler o prompt de produção de auth.js');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(Math.min(iP, iK), fim + 3)}\nout={PROMPT_BASE,KITS_IA,kitChecklist:typeof kitChecklist==='function'?kitChecklist:null};`, ctx);
  const { PROMPT_BASE, KITS_IA, kitChecklist } = ctx.out;
  const kit = KITS_IA[kitId];
  if (!kit?.ativo || !kit?.url) throw new Error(`kit "${kitId}" indisponível`);
  let prompt = PROMPT_BASE.replace('{{KIT}}', kit.kitPrompt);
  prompt = prompt.replace('{{KIT_CHECKLIST}}', kitChecklist && kit.acento ? kitChecklist(kit.acento) : '');
  if (/\{\{[A-Z_]+\}\}/.test(prompt)) throw new Error('placeholder por resolver no prompt — auth.js mudou de forma');
  return { prompt, kit };
}

async function achatamento(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const larg = (y) => { let n = 0; for (let x = 0; x < w; x++) if (data[(y * w + x) * c + 3] > 200) n++; return n; };
  let y0 = -1;
  for (let y = 0; y < h && y0 < 0; y++) if (larg(y) > 0) y0 = y;
  if (y0 < 0) return null;
  const faixa = Math.min(h, y0 + Math.max(8, Math.round(h * 0.10)));
  const primeira = larg(y0);
  let maxima = 0;
  for (let y = y0; y < faixa; y++) maxima = Math.max(maxima, larg(y));
  return maxima ? primeira / maxima : 0;
}

async function gerarCard(fotoUrl, kit, prompt, quality) {
  const r = await fal.subscribe('fal-ai/gpt-image-1.5/edit', {
    input: { prompt, image_urls: [fotoUrl, kit.url], quality, num_images: 1, image_size: '1024x1536' },
    logs: false,
  });
  const url = r?.images?.[0]?.url;
  if (!url) throw new Error('sem imagem');
  const rb = await fal.subscribe('fal-ai/birefnet', { input: { image_url: url, model: 'General Use (Light)' } });
  if (!rb?.image?.url) throw new Error('birefnet falhou');
  const rec = Buffer.from(await (await fetch(rb.image.url)).arrayBuffer());
  return sharp(rec).trim({ threshold: 10 })
    .extend({ top: 40, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .resize({ height: 640, width: 512, fit: 'inside' }).png().toBuffer();
}

(async () => {
  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta.'); process.exit(1); }
  if (process.argv.includes('--jovens')) { await rodarJovens(); return; }
  if (process.argv.includes('--jovens2')) { await rodarJovens(MODELOS_JOVENS_2); return; }

  const refazer = (flag('refazer', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const estilo = flag('estilo', 'padrao');
  const alvos = refazer.length ? MODELOS.filter((M) => refazer.includes(M.id)) : MODELOS;
  if (refazer.length && alvos.length !== refazer.length) {
    console.error(`ids desconhecidos em --refazer. Válidos: ${MODELOS.map((M) => M.id).join(', ')}`);
    process.exit(1);
  }

  const custo = refazer.length
    ? alvos.length * (PRECO.medium + 0.002)
    : MODELOS.length * (PRECO.foto + PRECO.low + PRECO.medium + 2 * 0.002);
  if (custo > TETO) { console.error(`RECUSADO: $${custo.toFixed(2)} > tecto $${TETO}`); process.exit(1); }

  const { prompt, kit } = producao('dark-gold');
  const promptMedium = estilo === 'rico' ? comEstiloRico(prompt) : prompt;
  fs.mkdirSync(SAIDA, { recursive: true });
  console.log(refazer.length
    ? `\nREFAZER medium (${estilo}) de: ${alvos.map((M) => M.id).join(', ')} ≈ $${custo.toFixed(2)}\n`
    : `\n5 MODELOS FICTÍCIOS · low + medium · custo único ≈ $${custo.toFixed(2)}\n`);

  const tmp = [];
  const linhas = [];

  for (const M of alvos) {
    const t0 = Date.now();
    try {
      // 1) foto fictícia: gera (corrida normal) ou lê do disco (refazer)
      let fotoBuf;
      const fotoPath = path.join(SAIDA, `${M.id}-foto.png`);
      if (refazer.length) {
        if (!fs.existsSync(fotoPath)) throw new Error(`falta ${M.id}-foto.png — corre primeiro sem --refazer`);
        fotoBuf = fs.readFileSync(fotoPath);
      } else {
        const rf = await fal.subscribe('fal-ai/gpt-image-1.5', {
          input: { prompt: fotoPrompt(M.desc), image_size: '1024x1536', quality: 'low', num_images: 1 },
          logs: false,
        });
        const fotoUrl0 = rf?.images?.[0]?.url;
        if (!fotoUrl0) throw new Error('t2i não devolveu foto');
        fotoBuf = Buffer.from(await (await fetch(fotoUrl0)).arrayBuffer());
        fs.writeFileSync(fotoPath, fotoBuf);
      }

      // sobe a foto para a esteira (bucket público, tmp)
      const tp = `tmp-modelos/${M.id}.png`;
      const { error } = await supabase.storage.from('kits').upload(tp, fotoBuf, { contentType: 'image/png', upsert: true });
      if (error) throw new Error('upload: ' + error.message);
      tmp.push(tp);
      const { data: pub } = supabase.storage.from('kits').getPublicUrl(tp);
      const fotoUrl = `${pub.publicUrl}?v=${Date.now()}`;

      // 2) gerações: par completo (normal) ou só o medium (refazer)
      const quals = refazer.length ? ['medium'] : ['low', 'medium'];
      for (const q of quals) {
        const card = await gerarCard(fotoUrl, kit, q === 'medium' ? promptMedium : prompt, q);
        const ach = await achatamento(card);
        const sufixo = refazer.length && estilo === 'rico' ? 'medium-rico' : q;
        fs.writeFileSync(path.join(SAIDA, `${M.id}-${sufixo}.png`), card);
        linhas.push({ id: M.id, q: sufixo, ach });
        console.log(`OK ${M.id.padEnd(18)} ${sufixo.padEnd(11)} achat ${ach === null ? '-' : ach.toFixed(2)}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    } catch (e) {
      console.error(`FALHOU ${M.id}: ${e.message}`);
    }
  }
  if (tmp.length) await supabase.storage.from('kits').remove(tmp).catch(() => {});

  const ruins = linhas.filter((l) => l.ach !== null && l.ach > 0.5);
  console.log('\n' + '='.repeat(60));
  console.log(`PARES COMPLETOS: ${new Set(linhas.filter((l) => linhas.some((o) => o.id === l.id && o.q !== l.q)).map((l) => l.id)).size}/5 · defeitos de coroa: ${ruins.length}`);
  console.log('='.repeat(60));

  const html = `<!doctype html><meta charset="utf-8"><title>Modelos fictícios — low vs medium</title>
<style>
 body{background:#0d0d12;color:#eee;font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px}
 h1{font-size:19px;margin:0 0 4px} h1 b{color:#d4a017}
 p{color:#888;margin:0 0 18px;max-width:640px}
 .modelo{margin:26px 0;border-top:1px solid #1e1e28;padding-top:14px}
 .rot{color:#d4a017;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px}
 .fila{display:flex;gap:14px;align-items:flex-start}
 .cel{background:#14141b;border:1px solid #24242e;border-radius:12px;padding:10px;text-align:center}
 .cel img{width:150px;display:block} .cel.card img{width:190px}
 .meta{font-size:11px;color:#999;margin-top:8px}
 .selo{display:inline-block;margin-top:4px;padding:2px 8px;border-radius:99px;font-size:10px;font-weight:700}
 .low{background:#26202a;color:#c9a7f0} .med{background:#2a2620;color:#f0d9a7}
</style>
<h1>Modelos fictícios — <b>low vs medium</b> (material da publicidade)</h1>
<p>Pessoas que não existem. O par de cada modelo mostra ao jogador o upgrade que o envelope compra.
Escolhe os pares que ficaram convincentes; os aprovados viram assets fixos da publicidade em rodízio.</p>
${MODELOS.map((M) => `
<div class="modelo"><div class="rot">${M.id}</div><div class="fila">
  <div class="cel"><img src="${M.id}-foto.png"><div class="meta">foto fictícia (entrada)</div></div>
  <div class="cel card"><img src="${M.id}-low.png"><div class="meta">GRÁTIS<br><span class="selo low">LOW</span></div></div>
  <div class="cel card"><img src="${M.id}-medium.png"><div class="meta">ENVELOPE<br><span class="selo med">MEDIUM</span></div></div>
  ${fs.existsSync(path.join(SAIDA, `${M.id}-medium-rico.png`)) ? `<div class="cel card"><img src="${M.id}-medium-rico.png"><div class="meta">ENVELOPE (estilo rico)<br><span class="selo med">MEDIUM+</span></div></div>` : ''}
</div></div>`).join('\n')}`;

  fs.writeFileSync(path.join(SAIDA, 'index.html'), html);
  console.log(`\nHTML: ${path.join(SAIDA, 'index.html')}\n`);
})();
