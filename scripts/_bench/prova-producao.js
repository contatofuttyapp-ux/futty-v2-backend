// PROVA DE PRODUÇÃO — gera N imagens com a receita EXACTA que está em
// routes/auth.js (prompt novo L2P, retrato 1024×1536, quality low, birefnet,
// trim+extend+resize). Lê o prompt DO ficheiro de produção: se auth.js mudar,
// esta prova acompanha.
//
// Uso:  node scripts/_bench/prova-producao.js            (10 imagens, low)
//       node scripts/_bench/prova-producao.js --n 10 --quality low
//
// Com 6 fotos e n=10, repete as 4 primeiras — de propósito: mostra a VARIÂNCIA
// (a mesma foto duas vezes sai igual de boa?).
// Custo: n × $0,015. Tecto de $0,50.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sharp = require('sharp');
const fal = require('@fal-ai/serverless-client');
const { supabase } = require('../../utils/db');

fal.config({ credentials: process.env.FAL_KEY });

const SAIDA = path.join(__dirname, 'saida-producao');
const PASTA = './public/fotos-teste';
const PRECO = { low: 0.015, medium: 0.053 }; // retrato + birefnet
const TETO = 0.5;

function producao(kitId) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'auth.js'), 'utf8');
  const iP = src.indexOf('const PROMPT_BASE');
  const iK = src.indexOf('const KITS_IA = {');
  const fim = src.indexOf('\n};', iK);
  if (iP < 0 || iK < 0 || fim < 0) throw new Error('Não consegui ler o prompt de produção de auth.js.');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(Math.min(iP, iK), fim + 3)}\nout={PROMPT_BASE,KITS_IA};`, ctx);
  const kit = ctx.out.KITS_IA[kitId];
  if (!kit?.ativo || !kit?.url) throw new Error(`kit "${kitId}" indisponível.`);
  return { prompt: ctx.out.PROMPT_BASE.replace('{{KIT}}', kit.kitPrompt), kit };
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

async function achatamento(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const larg = (y) => { let n = 0; for (let x = 0; x < w; x++) if (data[(y * w + x) * c + 3] > 200) n++; return n; };
  let y0 = -1;
  for (let y = 0; y < h && y0 < 0; y++) if (larg(y) > 0) y0 = y;
  if (y0 < 0) return { razao: null, cortada: false };
  const faixa = Math.min(h, y0 + Math.max(8, Math.round(h * 0.10)));
  const primeira = larg(y0);
  let maxima = 0;
  for (let y = y0; y < faixa; y++) maxima = Math.max(maxima, larg(y));
  return { razao: maxima ? primeira / maxima : 0, cortada: maxima ? primeira / maxima > 0.5 : false };
}

const flag = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

(async () => {
  const n = Number(flag('n', '10'));
  const quality = flag('quality', 'low');
  const kitId = flag('kit', 'dark-gold');
  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta.'); process.exit(1); }

  const fotos = fs.readdirSync(PASTA).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  if (!fotos.length) { console.error(`Nenhuma foto em ${PASTA}.`); process.exit(1); }

  const custo = n * (PRECO[quality] ?? PRECO.low);
  if (custo > TETO) { console.error(`RECUSADO: $${custo.toFixed(2)} passa o tecto de $${TETO.toFixed(2)}.`); process.exit(1); }

  const { prompt, kit } = producao(kitId);
  fs.mkdirSync(SAIDA, { recursive: true });
  console.log(`\nPROVA DE PRODUÇÃO: ${n} imagens · quality ${quality} · retrato 1024x1536 · $${custo.toFixed(2)}`);
  console.log(`Prompt lido de auth.js: ${prompt.length} chars (deve conter a receita L2P)\n`);

  // plano: cicla as fotos até n; repetição ganha sufixo -b, -c...
  const plano = [];
  const vezes = {};
  for (let i = 0; i < n; i++) {
    const f = fotos[i % fotos.length];
    vezes[f] = (vezes[f] || 0) + 1;
    plano.push({ foto: f, rot: path.parse(f).name.replace(/[^\w-]/g, '_') + (vezes[f] > 1 ? '-' + 'bcdef'[vezes[f] - 2] : '') });
  }

  const urls = {};
  const tmp = [];
  const linhas = [];

  for (const p of plano) {
    const t0 = Date.now();
    try {
      if (!urls[p.foto]) {
        const padded = await preprocessar(fs.readFileSync(path.join(PASTA, p.foto)));
        const tp = `tmp-prova/${path.parse(p.foto).name.replace(/[^\w-]/g, '_')}.jpg`;
        const { error } = await supabase.storage.from('kits').upload(tp, padded, { contentType: 'image/jpeg', upsert: true });
        if (error) throw new Error('upload: ' + error.message);
        tmp.push(tp);
        const { data: pub } = supabase.storage.from('kits').getPublicUrl(tp);
        urls[p.foto] = `${pub.publicUrl}?v=${Date.now()}`;
      }

      const r = await fal.subscribe('fal-ai/gpt-image-1.5/edit', {
        input: { prompt, image_urls: [urls[p.foto], kit.url], quality, num_images: 1, image_size: '1024x1536' },
        logs: false,
      });
      const url = r?.images?.[0]?.url;
      if (!url) throw new Error('sem imagem');
      const rb = await fal.subscribe('fal-ai/birefnet', { input: { image_url: url, model: 'General Use (Light)' } });
      if (!rb?.image?.url) throw new Error('birefnet falhou');
      const rec = Buffer.from(await (await fetch(rb.image.url)).arrayBuffer());

      const final = await sharp(rec).trim({ threshold: 10 })
        .extend({ top: 40, background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .resize({ height: 640, width: 512, fit: 'inside' }).png().toBuffer();
      const ach = await achatamento(await sharp(rec).trim({ threshold: 10 }).png().toBuffer());
      const fich = `${p.rot}.png`;
      fs.writeFileSync(path.join(SAIDA, fich), final);
      linhas.push({ rot: p.rot, fich, ach });
      console.log(`OK ${p.rot.padEnd(20)} achat ${ach.razao === null ? '-' : ach.razao.toFixed(2)}${ach.cortada ? '  CORTADA' : ''}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } catch (e) {
      console.error(`FALHOU ${p.rot}: ${e.message}`);
    }
  }
  if (tmp.length) await supabase.storage.from('kits').remove(tmp).catch(() => {});

  const cortadas = linhas.filter((l) => l.ach.cortada).length;
  console.log('\n' + '='.repeat(60));
  console.log(`RESULTADO: ${linhas.length}/${n} geradas · cabeça cortada: ${cortadas}/${linhas.length} · $${custo.toFixed(2)}`);
  console.log('='.repeat(60));

  const html = `<!doctype html><meta charset="utf-8"><title>Prova de produção — ${quality}</title>
<style>
 body{background:#0d0d12;color:#eee;font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px}
 h1{font-size:19px;margin:0 0 4px} h1 b{color:#d4a017}
 p{color:#888;margin:0 0 18px}
 .fila{display:flex;gap:12px;flex-wrap:wrap}
 .cel{background:#14141b;border:1px solid #24242e;border-radius:12px;padding:10px;text-align:center;width:190px}
 .cel img{width:172px;display:block;margin:0 auto}
 .meta{font-size:11px;color:#999;margin-top:8px}
 .bom{color:#4ade80} .ruim{color:#f87171;font-weight:700}
</style>
<h1>Prova de produção — <b>${quality}</b> · receita real do auth.js</h1>
<p>${linhas.length} imagens · cabeça cortada: ${cortadas}/${linhas.length} · $${custo.toFixed(2)} · sufixo -b/-c = mesma foto outra vez (variância)</p>
<div class="fila">
${linhas.map((l) => `<div class="cel"><img src="${l.fich}"><div class="meta">${l.rot} <span class="${l.ach.cortada ? 'ruim' : 'bom'}">achat ${l.ach.razao === null ? '-' : l.ach.razao.toFixed(2)}</span></div></div>`).join('\n')}
</div>`;
  const out = path.join(SAIDA, 'index.html');
  fs.writeFileSync(out, html);
  console.log(`\nHTML: ${out}\n`);
})();
