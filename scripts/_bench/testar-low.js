// BANCADA — VIABILIZAR O `low` (prioridade nº1 do dono, 29-jul)
//
// ===========================================================================
// COMO CORRER (é um script de terminal, não se abre com duplo-clique):
//
//   1) põe as fotos em  backend/public/fotos-teste/
//   2) no terminal, DENTRO da pasta  backend/ :
//
//        node scripts/_bench/testar-low.js ./public/fotos-teste
//
//   3) no fim ele imprime o caminho de um index.html — ESSE abre no browser.
//
//   Opções:
//     --variantes L1,L2,L3     quais candidatos low correr (omissão: os três)
//     --controlo               inclui o medium de produção como régua (recomendado)
//     --teto 1.00              tecto de gasto em dólares; recusa se passar
// ===========================================================================
//
// Mede quatro coisas por imagem:
//   custo · achatamento da coroa (cabeça inteira ou comida) · nitidez
//   (variância do laplaciano — quantifica a "moleza" do low) · tamanho de saída.
//
// NÃO TOCA EM PRODUÇÃO. Só LÊ o prompt de auth.js e escreve no scratchpad.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sharp = require('sharp');
const fal = require('@fal-ai/serverless-client');
const { supabase } = require('../../utils/db');
const { VARIANTES } = require('./prompts-low');

fal.config({ credentials: process.env.FAL_KEY });

const SAIDA = path.join(__dirname, 'saida-low');
const CUSTO_BIREFNET = 0.002;
// Preço por tamanho REAL de saída (tabela fal). A chave é a dimensão devolvida,
// não a pedida — assim a conta continua honesta se o fal ignorar o pedido.
const PRECO = {
  low:    { '1024x1024': 0.009, '1024x1536': 0.013, '1536x1024': 0.013 },
  medium: { '1024x1024': 0.034, '1024x1536': 0.051, '1536x1024': 0.051 },
};
const precoDe = (q, dim) => PRECO[q]?.[dim] ?? PRECO[q]?.['1024x1536'] ?? 0;

/** Lê PROMPT_BASE + KITS_IA reais de routes/auth.js. Aborta se não conseguir. */
function producao(kitId) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'auth.js'), 'utf8');
  const iP = src.indexOf('const PROMPT_BASE');
  const iK = src.indexOf('const KITS_IA = {');
  const fim = src.indexOf('\n};', iK);
  if (iP < 0 || iK < 0 || fim < 0) throw new Error('Não consegui ler PROMPT_BASE/KITS_IA de routes/auth.js — aborta antes de gastar.');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(Math.min(iP, iK), fim + 3)}\nout={PROMPT_BASE,KITS_IA};`, ctx);
  const { PROMPT_BASE, KITS_IA } = ctx.out;
  const kit = KITS_IA[kitId];
  if (!kit) throw new Error(`kit "${kitId}" não existe. Opções: ${Object.keys(KITS_IA).join(', ')}`);
  if (!kit.ativo || !kit.url) throw new Error(`kit "${kitId}" sem asset activo. Activos: ${Object.keys(KITS_IA).filter((k) => KITS_IA[k].ativo && KITS_IA[k].url).join(', ')}`);
  return { promptProducao: PROMPT_BASE.replace('{{KIT}}', kit.kitPrompt), kitTxt: kit.kitPrompt, kit };
}

/** ETAPA 0 de produção: estende o topo 18% com a cor média da faixa superior. */
async function preprocessar(buf) {
  const m = await sharp(buf).metadata();
  const strip = Math.max(8, Math.round((m.height || 0) * 0.02));
  const { data: avg } = await sharp(buf).extract({ left: 0, top: 0, width: m.width, height: strip })
    .resize(1, 1).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const [r, g, b] = avg;
  return sharp(buf).extend({ top: Math.round((m.height || 0) * 0.18), background: { r, g, b, alpha: 1 } })
    .jpeg({ quality: 90 }).toBuffer();
}

/** Achatamento da coroa: ~0 = cabeça inteira em cúpula; ~1 = topo chato/comido. */
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
  const razao = maxima ? primeira / maxima : 0;
  return { razao, cortada: razao > 0.5 };
}

/** Nitidez = variância do laplaciano sobre o cinza. Quantifica a "moleza". */
async function nitidez(buf) {
  const { data, info } = await sharp(buf).flatten({ background: '#8a8a8a' }).greyscale().raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const vals = [];
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x;
      vals.push(Math.abs(4 * data[i] - data[i - w] - data[i + w] - data[i - 1] - data[i + 1]));
    }
  }
  const m = vals.reduce((s, v) => s + v, 0) / vals.length;
  return Math.round(vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length);
}

/**
 * Gera. Se `fundoTransparente`, pede background:'transparent' ao próprio modelo
 * e NÃO chama o birefnet — é a hipótese que mata a causa raiz da cabeça
 * achatada (não há recorte a confundir cabelo preto com fundo preto).
 */
async function gerar(inputUrl, kitUrl, prompt, quality, tamanho, fundoTransparente) {
  const input = { prompt, image_urls: [inputUrl, kitUrl], quality, num_images: 1, output_format: 'png' };
  // 'auto' = o que a produção faz hoje (não define nada) → serve de controlo.
  if (tamanho !== 'auto') input.image_size = tamanho;
  if (fundoTransparente) input.background = 'transparent';
  const r = await fal.subscribe('fal-ai/gpt-image-1.5/edit', { input, logs: false });
  const url = r?.images?.[0]?.url;
  if (!url) throw new Error('a IA não devolveu imagem');
  const geradaBuf = Buffer.from(await (await fetch(url)).arrayBuffer());

  if (fundoTransparente) {
    // Confirma que veio mesmo alpha; se vier opaco, o parâmetro foi ignorado.
    const meta = await sharp(geradaBuf).metadata();
    if (!meta.hasAlpha) throw new Error('pedi background transparente e veio opaco — parâmetro ignorado pelo fal');
    return { geradaBuf, recorteBuf: geradaBuf, semBirefnet: true };
  }
  const rb = await fal.subscribe('fal-ai/birefnet', { input: { image_url: url, model: 'General Use (Light)' } });
  const rec = rb?.image?.url;
  if (!rec) throw new Error('birefnet não devolveu imagem');
  return { geradaBuf, recorteBuf: Buffer.from(await (await fetch(rec)).arrayBuffer()), semBirefnet: false };
}

const flag = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1].split(',').map((s) => s.trim()) : d; };
const tem = (n) => process.argv.includes(`--${n}`);

(async () => {
  const pasta = process.argv[2];
  if (!pasta || pasta.startsWith('--')) {
    console.error('\nFalta a pasta com as fotos:\n  node scripts/_bench/testar-low.js ./public/fotos-teste [--controlo]\n');
    process.exit(1);
  }
  const kitId = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'dark-gold';
  const quais = flag('variantes', ['L1', 'L1T', 'L2', 'L2T', 'L3']);
  const comControlo = tem('controlo');
  const teto = Number(flag('teto', ['1.00'])[0]);

  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta no ambiente.'); process.exit(1); }
  if (!fs.existsSync(pasta)) { console.error(`Pasta não encontrada: ${pasta}`); process.exit(1); }
  const fotos = fs.readdirSync(pasta).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  if (!fotos.length) { console.error(`Nenhuma foto em ${pasta}. Põe 3-6 fotos lá e corre outra vez.`); process.exit(1); }
  for (const v of quais) if (!VARIANTES[v]) { console.error(`Variante "${v}" não existe. Opções: ${Object.keys(VARIANTES).join(', ')}`); process.exit(1); }

  const { promptProducao, kitTxt, kit } = producao(kitId);

  // Monta TODOS os prompts ANTES de gastar: se algum falhar, aborta a zero dólares.
  const acento = /metallic gold #d4a017/.test(kitTxt) ? 'metallic gold #d4a017' : 'the accent colour';
  const plano = [];
  for (const v of quais) {
    const V = VARIANTES[v];
    plano.push({
      id: v, nome: V.nome, prompt: V.montar(kitTxt, acento, V.fundo, V.enq),
      qualidade: V.qualidade, tamanho: V.tamanho, transp: V.fundo === 'transparente',
    });
  }
  // M0 = produção exacta: prompt intacto, medium, sem image_size (fica 'auto'), com birefnet.
  if (comControlo) plano.push({ id: 'M0', nome: 'M0 produção (medium)', prompt: promptProducao, qualidade: 'medium', tamanho: 'auto', transp: false });

  // Tecto de gasto — o dono deu liberdade até €2; o script recusa passar do tecto.
  const dimEsperada = (p) => (p.tamanho === 'auto' ? '1024x1536' : p.tamanho);
  const estimado = fotos.length * plano.reduce((s, p) => s + precoDe(p.qualidade, dimEsperada(p)) + (p.transp ? 0 : CUSTO_BIREFNET), 0);
  console.log(`\nFotos: ${fotos.length} · candidatos: ${plano.map((p) => p.id).join(', ')} · kit: ${kitId}`);
  console.log(`Gerações: ${fotos.length * plano.length} · custo estimado: $${estimado.toFixed(2)} (tecto $${teto.toFixed(2)})`);
  if (estimado > teto) {
    console.error(`\nRECUSADO: $${estimado.toFixed(2)} passa o tecto de $${teto.toFixed(2)}.\nCorre com menos fotos, menos variantes, ou --teto ${(Math.ceil(estimado * 100) / 100).toFixed(2)}\n`);
    process.exit(1);
  }
  for (const p of plano) {
    console.log(`  ${p.id.padEnd(3)} ${p.nome.padEnd(22)} ${p.qualidade}/${p.tamanho}  ${p.transp ? 'fundo transparente (sem birefnet)' : 'fundo cinza + birefnet'}  prompt ${p.prompt.length}ch`);
  }
  console.log('');

  fs.mkdirSync(SAIDA, { recursive: true });
  const linhas = [];
  const tmp = [];

  for (const foto of fotos) {
    const nome = path.parse(foto).name.replace(/[^\w-]/g, '_');
    let inputUrl;
    try {
      const padded = await preprocessar(fs.readFileSync(path.join(pasta, foto)));
      const p = `tmp-low/${nome}-pad.jpg`;
      const { error } = await supabase.storage.from('kits').upload(p, padded, { contentType: 'image/jpeg', upsert: true });
      if (error) throw new Error('upload: ' + error.message);
      tmp.push(p);
      const { data: pub } = supabase.storage.from('kits').getPublicUrl(p);
      inputUrl = `${pub.publicUrl}?v=${Date.now()}`;
      // guarda a entrada ao lado, para a comparação mostrar de onde veio
      fs.writeFileSync(path.join(SAIDA, `${nome}--entrada.jpg`), padded);
    } catch (e) {
      console.error(`[${nome}] etapa 0 falhou: ${e.message} — salto esta foto`);
      continue;
    }

    for (const p of plano) {
      const t0 = Date.now();
      try {
        const { geradaBuf, recorteBuf, semBirefnet } = await gerar(inputUrl, kit.url, p.prompt, p.qualidade, p.tamanho, p.transp);
        const mg = await sharp(geradaBuf).metadata();
        const dim = `${mg.width}x${mg.height}`;
        if (p.tamanho !== 'auto' && dim !== p.tamanho) {
          console.warn(`   AVISO: pedi ${p.tamanho} e veio ${dim} — o preço usado é o do tamanho REAL.`);
        }
        const trimmed = await sharp(recorteBuf).trim({ threshold: 10 }).png().toBuffer();
        const ach = await achatamento(trimmed);
        const nit = await nitidez(trimmed);
        const final = await sharp(recorteBuf).trim({ threshold: 10 })
          .extend({ top: 40, background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .resize({ height: 640, width: 512, fit: 'inside' }).png().toBuffer();
        const fich = `${nome}--${p.id}.png`;
        fs.writeFileSync(path.join(SAIDA, fich), final);
        const custo = precoDe(p.qualidade, dim) + (semBirefnet ? 0 : CUSTO_BIREFNET);
        linhas.push({ nome, id: p.id, rotulo: p.nome, dim, fich, ach, nit, custo, semBirefnet });
        console.log(`OK ${nome.padEnd(14)} ${p.id.padEnd(3)} ${dim.padEnd(10)} achat ${ach.razao === null ? ' -  ' : ach.razao.toFixed(2)}${ach.cortada ? ' CORTADA' : '        '} nitidez ${String(nit).padStart(5)}  $${custo.toFixed(3)}${semBirefnet ? ' (sem birefnet)' : ''}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      } catch (e) {
        console.error(`FALHOU ${nome} ${p.id}: ${e.message}`);
      }
    }
  }

  if (tmp.length) await supabase.storage.from('kits').remove(tmp).catch(() => {});

  // ------------------------------- RESUMO -------------------------------
  console.log('\n' + '='.repeat(80));
  const gasto = linhas.reduce((s, l) => s + l.custo, 0);
  for (const p of plano) {
    const ls = linhas.filter((l) => l.id === p.id);
    if (!ls.length) continue;
    const cort = ls.filter((l) => l.ach.cortada).length;
    const nitMed = Math.round(ls.reduce((s, l) => s + l.nit, 0) / ls.length);
    const medio = ls.reduce((s, l) => s + l.custo, 0) / ls.length;
    const custo10 = medio * (1 + cort / ls.length) * 10;
    console.log(
      `${p.id.padEnd(3)} ${p.nome.padEnd(22)} $${medio.toFixed(3)}/fig · cabeça cortada ${cort}/${ls.length} · ` +
      `nitidez média ${String(nitMed).padStart(5)} · envelope 10 fig: $${custo10.toFixed(2)} de $0,76 → margem ${(((0.757 - custo10) / 0.757) * 100).toFixed(0)}%`
    );
  }
  console.log(`\nGASTO REAL DESTA CORRIDA: $${gasto.toFixed(2)}`);
  console.log('nitidez: compara os low com o M0. Se ficarem perto, a estilização compensou a perda.');
  console.log('='.repeat(80));

  // ------------------------- HTML lado a lado -------------------------
  const nomes = [...new Set(linhas.map((l) => l.nome))];
  const cel = (l) => l ? `<div class="cel"><img src="${l.fich}"><div class="meta"><b>${l.id}</b> ${l.dim}${l.semBirefnet ? ' · alpha do modelo' : ''}<br>$${l.custo.toFixed(3)} · nitidez ${l.nit}
    <span class="${l.ach.cortada ? 'ruim' : 'bom'}">achat ${l.ach.razao === null ? '-' : l.ach.razao.toFixed(2)}</span></div></div>` : '<div class="cel">—</div>';

  const html = `<!doctype html><meta charset="utf-8"><title>Bancada — viabilizar o low</title>
<style>
 :root{--ouro:#d4a017}
 body{background:#0d0d12;color:#eee;font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px}
 h1{font-size:19px;margin:0 0 4px} h1 b{color:var(--ouro)}
 p.sub{color:#888;margin:0 0 6px;max-width:680px}
 .leg{color:#666;font-size:12px;margin:0 0 18px;max-width:680px}
 .toggle button{background:#1a1a22;color:#eee;border:1px solid #333;padding:8px 14px;border-radius:8px;cursor:pointer;margin-right:8px}
 .toggle button.on{border-color:var(--ouro);color:var(--ouro)}
 .grupo{margin:26px 0;border-top:1px solid #1e1e28;padding-top:14px}
 .rot{color:var(--ouro);font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:11px;margin-bottom:10px}
 .fila{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start}
 .cel{background:#14141b;border:1px solid #24242e;border-radius:12px;padding:10px;text-align:center;width:215px}
 .cel img{width:100%;height:auto;display:block}
 .entrada{width:150px;opacity:.85} .entrada img{border-radius:8px}
 .meta{font-size:11px;color:#999;margin-top:8px}
 .bom{color:#4ade80;margin-left:4px} .ruim{color:#f87171;margin-left:4px;font-weight:700}
 body.real .cel{width:190px} body.real .cel img{width:172px;margin:0 auto}
</style>
<h1>Viabilizar o <b>low</b> — $0,009 por figurinha</h1>
<p class="sub">Cada linha é uma foto. A primeira coluna é a ENTRADA (já com o topo esticado 18%).
Depois os candidatos low, e <b>M0</b> é a régua: o prompt de produção em medium.</p>
<p class="leg"><b>achat</b> = achatamento da coroa: perto de 0 é cabeça inteira, acima de 0,5 é cabeça comida pelo recorte.
<b>nitidez</b> = quanto detalhe fino a imagem tem. Compare os low com o M0: se ficarem perto, a estilização compensou.</p>
<div class="toggle">
 <button id="b1" class="on" onclick="document.body.className='real';b1.className='on';b2.className=''">Tamanho real</button>
 <button id="b2" onclick="document.body.className='';b2.className='on';b1.className=''">Zoom</button>
</div>
${nomes.map((n) => `<div class="grupo"><div class="rot">${n}</div><div class="fila">
  <div class="cel entrada"><img src="${n}--entrada.jpg"><div class="meta">entrada</div></div>
  ${plano.map((p) => cel(linhas.find((l) => l.nome === n && l.id === p.id))).join('')}
</div></div>`).join('\n')}
<script>document.body.className='real'</script>`;

  const out = path.join(SAIDA, 'index.html');
  fs.writeFileSync(out, html);
  console.log(`\n>>> ABRE ESTE FICHEIRO NO BROWSER (duplo-clique):\n${out}\n`);
})();
