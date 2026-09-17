// BANCADA — TREINO DO AUDITOR (1-ago, dono). LOW APENAS, medium morto.
// Para cada foto: gera 1x pela receita REAL de produção (prompt lido de auth.js,
// low, retrato, birefnet) e mede TODOS os cheques do auditor SEM retry — o
// objectivo é VER o julgamento, não escondê-lo:
//   · borda TOPO (pré-trim)      — cabeça colada/cortada no tecto
//   · borda LATERAL (pré-trim)   — braço cortado pela moldura
//   · achatamento (pós-trim)     — coroa comida (>0,50)
//   · simetria (pós-trim)        — braço em falta de um lado (<0,82; calibrada
//                                  em 55 cards: bons ≥0,88, Denis-defeito 0,74)
// O HTML mostra cada card com métricas e VEREDITO. O dono confere com o olho e
// diz onde o auditor errou (falso alarme ou defeito que passou) — é assim que
// os limiares se afinam.
//
// Uso:  node scripts/_bench/prova-auditor.js               (./public/fotos-treino)
//       node scripts/_bench/prova-auditor.js ./outra/pasta
// Custo: n × ~$0,017 (low retrato + birefnet). Tecto $0,30.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sharp = require('sharp');
const fal = require('@fal-ai/serverless-client');
const { supabase } = require('../../utils/db');

fal.config({ credentials: process.env.FAL_KEY });

const SAIDA = path.join(__dirname, 'saida-auditor');
const TETO = 0.3;
const CUSTO_IMG = 0.015 + 0.002;

const LIMIAR_ACHATAMENTO = 0.5;
const LIMIAR_SIMETRIA = 0.82;
const LIMIAR_BORDA_TOPO = 0.15;   // fração da largura opaca nas linhas 0-2
const LIMIAR_BORDA_LADO = 0.15;   // fração da altura opaca nas colunas laterais

function producao(kitId) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'auth.js'), 'utf8');
  const iP = src.indexOf('const PROMPT_BASE');
  const iK = src.indexOf('const KITS_IA = {');
  const fim = src.indexOf('\n};', iK);
  if (iP < 0 || iK < 0 || fim < 0) throw new Error('não consegui ler o prompt de produção');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(Math.min(iP, iK), fim + 3)}\nout={PROMPT_BASE,KITS_IA,kitChecklist:typeof kitChecklist==='function'?kitChecklist:null};`, ctx);
  const { PROMPT_BASE, KITS_IA, kitChecklist } = ctx.out;
  const kit = KITS_IA[kitId];
  let prompt = PROMPT_BASE.replace('{{KIT}}', kit.kitPrompt);
  prompt = prompt.replace('{{KIT_CHECKLIST}}', kitChecklist && kit.acento ? kitChecklist(kit.acento) : '');
  if (/\{\{[A-Z_]+\}\}/.test(prompt)) throw new Error('placeholder por resolver');
  return { prompt, kit };
}

async function preprocessar(buf) {
  const m = await sharp(buf).metadata();
  const strip = Math.max(8, Math.round((m.height || 0) * 0.02));
  const { data: avg } = await sharp(buf).extract({ left: 0, top: 0, width: m.width, height: strip })
    .resize(1, 1).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const [r, g, b] = avg;
  return sharp(buf).extend({ top: Math.round((m.height || 0) * 0.18), background: { r, g, b, alpha: 1 } })
    .jpeg({ quality: 90 }).toBuffer();
}

// ---- os cheques do auditor ----
async function bordas(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const opaco = (x, y) => data[(y * w + x) * c + 3] > 200;
  let topo = 0;
  for (let y = 0; y <= 2 && y < h; y++) { let n = 0; for (let x = 0; x < w; x++) if (opaco(x, y)) n++; topo = Math.max(topo, n); }
  let esq = 0, dir = 0;
  for (let x = 0; x <= 2 && x < w; x++) { let n = 0; for (let y = 0; y < h; y++) if (opaco(x, y)) n++; esq = Math.max(esq, n); }
  for (let x = w - 3; x < w; x++) { if (x < 0) continue; let n = 0; for (let y = 0; y < h; y++) if (opaco(x, y)) n++; dir = Math.max(dir, n); }
  return { topo: topo / w, esq: esq / h, dir: dir / h };
}

async function posTrim(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const m = (x, y) => data[(y * w + x) * c + 3] > 200;
  const larg = (y) => { let n = 0; for (let x = 0; x < w; x++) if (m(x, y)) n++; return n; };
  let y0 = -1, y1 = -1;
  for (let y = 0; y < h; y++) if (larg(y) > 0) { if (y0 < 0) y0 = y; y1 = y; }
  if (y0 < 0) return { achatamento: null, simetria: null };
  const corpoH = y1 - y0 + 1;
  // achatamento da coroa
  const faixa = Math.min(h, y0 + Math.max(8, Math.round(h * 0.10)));
  const primeira = larg(y0);
  let maxima = 0;
  for (let y = y0; y < faixa; y++) maxima = Math.max(maxima, larg(y));
  const achatamento = maxima ? primeira / maxima : 0;
  // simetria na zona dos braços (35%-85% do corpo)
  const za = y0 + Math.round(corpoH * 0.35), zb = y0 + Math.round(corpoH * 0.85);
  let minX = w, maxX = -1;
  for (let y = za; y < zb; y++) for (let x = 0; x < w; x++) if (m(x, y)) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
  const cx = (minX + maxX) / 2;
  let massaEsq = 0, massaDir = 0;
  for (let y = za; y < zb; y++) for (let x = 0; x < w; x++) if (m(x, y)) { if (x < cx) massaEsq++; else massaDir++; }
  const simetria = Math.max(massaEsq, massaDir) ? Math.min(massaEsq, massaDir) / Math.max(massaEsq, massaDir) : 1;
  return { achatamento, simetria };
}

(async () => {
  const pasta = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : './public/fotos-treino';
  // --fotos nome1,nome2 : repete SÓ essas (ex.: as reprovadas da rodada anterior)
  const iF = process.argv.indexOf('--fotos');
  const filtro = iF > 0 && process.argv[iF + 1] ? process.argv[iF + 1].split(',').map((x) => x.trim()) : null;
  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta.'); process.exit(1); }
  if (!fs.existsSync(pasta)) { console.error(`Pasta não encontrada: ${pasta}`); process.exit(1); }
  let fotos = fs.readdirSync(pasta).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  if (filtro) fotos = fotos.filter((f) => filtro.some((x) => path.parse(f).name.replace(/[^\w-]/g, '_').startsWith(x)));
  if (filtro) console.log(`(repetindo só ${fotos.length} reprovadas)`);
  if (!fotos.length) { console.error(`Nenhuma foto em ${pasta}.`); process.exit(1); }
  const custo = fotos.length * CUSTO_IMG;
  if (custo > TETO) { console.error(`RECUSADO: $${custo.toFixed(2)} > tecto $${TETO}. Menos fotos.`); process.exit(1); }

  const { prompt, kit } = producao('dark-gold');
  fs.mkdirSync(SAIDA, { recursive: true });
  console.log(`\nTREINO DO AUDITOR — ${fotos.length} fotos · LOW apenas · sem retry · ~$${custo.toFixed(2)}\n`);

  const tmp = [];
  const linhas = [];
  for (const foto of fotos) {
    const nome = path.parse(foto).name.replace(/[^\w-]/g, '_');
    const t0 = Date.now();
    try {
      const padded = await preprocessar(fs.readFileSync(path.join(pasta, foto)));
      const tp = `tmp-auditor-treino/${nome}.jpg`;
      const { error } = await supabase.storage.from('kits').upload(tp, padded, { contentType: 'image/jpeg', upsert: true });
      if (error) throw new Error('upload: ' + error.message);
      tmp.push(tp);
      const { data: pub } = supabase.storage.from('kits').getPublicUrl(tp);
      const inputUrl = `${pub.publicUrl}?v=${Date.now()}`;

      const r = await fal.subscribe('fal-ai/gpt-image-1.5/edit', {
        input: { prompt, image_urls: [inputUrl, kit.url], quality: 'low', num_images: 1, image_size: '1024x1536' },
        logs: false,
      });
      const url = r?.images?.[0]?.url;
      if (!url) throw new Error('sem imagem');
      const rb = await fal.subscribe('fal-ai/birefnet', { input: { image_url: url, model: 'General Use (Light)' } });
      if (!rb?.image?.url) throw new Error('birefnet falhou');
      const rec = Buffer.from(await (await fetch(rb.image.url)).arrayBuffer());

      const b = await bordas(rec);
      const trimmed = await sharp(rec).trim({ threshold: 10 }).png().toBuffer();
      const p = await posTrim(trimmed);
      const final = await sharp(rec).trim({ threshold: 10 })
        .extend({ top: 40, background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .resize({ height: 640, width: 512, fit: 'inside' }).png().toBuffer();
      const fich = `${nome}.png`;
      fs.writeFileSync(path.join(SAIDA, fich), final);
      fs.writeFileSync(path.join(SAIDA, `${nome}--entrada.jpg`), padded);

      const motivos = [];
      if (b.topo > LIMIAR_BORDA_TOPO) motivos.push(`borda topo ${(b.topo * 100).toFixed(0)}%`);
      if (b.esq > LIMIAR_BORDA_LADO) motivos.push(`borda esq ${(b.esq * 100).toFixed(0)}%`);
      if (b.dir > LIMIAR_BORDA_LADO) motivos.push(`borda dir ${(b.dir * 100).toFixed(0)}%`);
      if (p.achatamento !== null && p.achatamento > LIMIAR_ACHATAMENTO) motivos.push(`achatamento ${p.achatamento.toFixed(2)}`);
      if (p.simetria !== null && p.simetria < LIMIAR_SIMETRIA) motivos.push(`simetria ${p.simetria.toFixed(2)}`);
      linhas.push({ nome, fich, b, p, motivos });
      console.log(`${motivos.length ? 'REPROVA' : 'passa '} ${nome.padEnd(16)} topo ${(b.topo * 100).toFixed(0)}% esq ${(b.esq * 100).toFixed(0)}% dir ${(b.dir * 100).toFixed(0)}% achat ${p.achatamento === null ? '-' : p.achatamento.toFixed(2)} sim ${p.simetria === null ? '-' : p.simetria.toFixed(2)}${motivos.length ? '  ← ' + motivos.join(', ') : ''}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } catch (e) {
      console.error(`FALHOU ${nome}: ${e.message}`);
    }
  }
  if (tmp.length) await supabase.storage.from('kits').remove(tmp).catch(() => {});

  const reprovadas = linhas.filter((l) => l.motivos.length);
  console.log('\n' + '='.repeat(70));
  console.log(`AUDITOR: reprovou ${reprovadas.length}/${linhas.length} · taxa de retry implícita ${linhas.length ? ((reprovadas.length / linhas.length) * 100).toFixed(0) : 0}%`);
  console.log('Agora o DONO confere no HTML: falso alarme? defeito que passou? É o treino.');
  console.log('='.repeat(70));

  const html = `<!doctype html><meta charset="utf-8"><title>Treino do auditor</title>
<style>
 body{background:#0d0d12;color:#eee;font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px}
 h1{font-size:19px;margin:0 0 4px} h1 b{color:#d4a017} p{color:#888;margin:0 0 18px;max-width:660px}
 .fila{display:flex;gap:14px;flex-wrap:wrap}
 .cel{background:#14141b;border:1px solid #24242e;border-radius:12px;padding:10px;text-align:center;width:210px}
 .cel img{width:190px;display:block;margin:0 auto}
 .meta{font-size:11px;color:#999;margin-top:8px;line-height:1.6}
 .ok{display:inline-block;padding:2px 10px;border-radius:99px;font-weight:800;font-size:11px;background:#123a24;color:#4ade80}
 .mau{display:inline-block;padding:2px 10px;border-radius:99px;font-weight:800;font-size:11px;background:#3a1212;color:#f87171}
 .ent{width:54px;border-radius:6px;vertical-align:middle;margin-right:6px;opacity:.8}
</style>
<h1>Treino do auditor — <b>confere o veredito com o olho</b></h1>
<p>LOW apenas, sem retry: o que você vê é a 1ª geração crua e o julgamento do auditor sobre ela.
Me diga onde ele errou: reprovou card bom (falso alarme) ou deixou passar defeito. Limiares atuais:
borda 15% · achatamento 0,50 · simetria 0,82.</p>
<div class="fila">
${linhas.map((l) => `<div class="cel">
  <img src="${l.fich}">
  <div class="meta">
    <img class="ent" src="${l.nome}--entrada.jpg">${l.nome}<br>
    topo ${(l.b.topo * 100).toFixed(0)}% · lados ${(l.b.esq * 100).toFixed(0)}/${(l.b.dir * 100).toFixed(0)}% · achat ${l.p.achatamento === null ? '-' : l.p.achatamento.toFixed(2)} · sim ${l.p.simetria === null ? '-' : l.p.simetria.toFixed(2)}<br>
    ${l.motivos.length ? `<span class="mau">REPROVA</span> ${l.motivos.join(' · ')}` : '<span class="ok">PASSA</span>'}
  </div>
</div>`).join('\n')}
</div>`;
  fs.writeFileSync(path.join(SAIDA, 'index.html'), html);
  console.log(`\nHTML: ${path.join(SAIDA, 'index.html')}\n`);
})();
