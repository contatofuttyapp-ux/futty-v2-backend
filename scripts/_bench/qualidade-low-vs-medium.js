// BANCADA — QUALIDADE (low vs medium) × FUNDO DE GERAÇÃO (preto vs cinza)
//
// ===========================================================================
// COMO CORRER (não é para abrir com duplo-clique — é um script de terminal):
//
//   1) põe 4-8 fotos em  backend/public/fotos-teste/   (inclui a que falha!)
//   2) no terminal, dentro da pasta  backend/ :
//
//        node scripts/_bench/qualidade-low-vs-medium.js ./public/fotos-teste
//
//   3) no fim ele escreve um ficheiro HTML e diz o caminho.
//      ESSE sim abre-se com duplo-clique, no browser.
//
//   Opções:  --fundos preto,cinza,verde     --qualidades low,medium
// ===========================================================================
//
// DUAS PERGUNTAS, UMA CORRIDA:
//
// A) QUALIDADE — produção corre em `medium` ($0,051/retrato); o `low` custa
//    $0,013, 4× menos, e nunca foi testado. A copy do ENVELOPE já anuncia
//    R$4,90 por 10 figurinhas, logo esta medição decide se o preço dá lucro.
//
// B) FUNDO — hipótese do dono (29-jul), e o prompt dá-lhe razão: o fundo de
//    geração é #050810 (quase preto), a camisa é #0d0d12 (quase preto) e o
//    cabelo do jogador é preto. O birefnet tem de recortar um objecto preto
//    de um campo preto → come o cabelo → "cabeça achatada".
//    O fundo de geração é DESCARTADO pelo birefnet: ninguém o vê. Fazê-lo
//    preto é sabotar o recorte de graça. Este teste mede se um fundo com
//    contraste resolve — custo zero, é só prompt.
//    Consequência importante: se a causa é esta, o RETRY nunca conserta
//    (regera preto sobre preto) → paga 2× com 0% de chance. Ver linha 695
//    de routes/auth.js.
//
// De borla mede o tamanho real de saída (define se a conta é $0,034 ou $0,051)
// e a taxa de coroa cortada por combinação — as duas medições em falta do
// FUTTY-CUSTOS.md.
//
// NÃO TOCA EM PRODUÇÃO: só LÊ o prompt de auth.js e escreve no scratchpad.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sharp = require('sharp');
const fal = require('@fal-ai/serverless-client');
const { supabase } = require('../../utils/db');

fal.config({ credentials: process.env.FAL_KEY });

const SAIDA = path.join(__dirname, 'saida-qualidade');

// Tabela oficial fal.ai (FUTTY-CUSTOS.md secção 2) — $/imagem.
const TABELA = {
  low: { '1024x1024': 0.009, '1024x1536': 0.013 },
  medium: { '1024x1024': 0.034, '1024x1536': 0.051 },
};
const CUSTO_BIREFNET = 0.002;

// ---------------------------------------------------------------------------
// FUNDOS. `preto` é o de produção (controlo). Os outros trocam SÓ a secção
// BACKGROUND do prompt — o kit, a moldura e o enquadramento ficam intactos.
// ---------------------------------------------------------------------------
const FUNDOS = {
  preto: null, // produção, sem alteração
  cinza: {
    cor: '#8a8a8a',
    // Cinza médio: contraste de luminância contra cabelo preto E camisa preta,
    // sem introduzir franja de cor nas bordas do cabelo (o risco do verde).
    bloco: `BACKGROUND — CRITICAL:
- SOLID MID-GREY background ONLY: #8a8a8a
- This background will be removed automatically afterwards; it exists ONLY to
  make the player's silhouette (including dark hair) clearly separable
- Absolutely NO stadium, NO crowd, NO field, NO grass, NO lights
- NO environmental elements of any kind
- NO gradient, NO vignette, NO bokeh — perfectly flat, uniform grey
- Strong separation between the player's hair and the background is essential
- This is the most important rule after face accuracy`,
  },
  verde: {
    cor: '#00b140',
    bloco: `BACKGROUND — CRITICAL:
- SOLID CHROMA GREEN background ONLY: #00b140
- This background will be removed automatically afterwards; it exists ONLY to
  make the player's silhouette (including dark hair) clearly separable
- Absolutely NO stadium, NO crowd, NO field, NO grass, NO lights
- NO environmental elements of any kind
- NO gradient, NO vignette, NO bokeh — perfectly flat, uniform green
- No green tint may appear on the player, the skin or the kit
- This is the most important rule after face accuracy`,
  },
};

/**
 * Lê o prompt REAL de produção direto de routes/auth.js.
 * Não copia o texto para cá: se o prompt mudar, o teste acompanha. Se a
 * extração falhar, ABORTA — um teste com prompt diferente do de produção não
 * vale nada e gastaria dinheiro a medir a coisa errada.
 */
function promptDeProducao(kitId) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'auth.js'), 'utf8');
  const iPrompt = src.indexOf('const PROMPT_BASE');
  const iKits = src.indexOf('const KITS_IA = {');
  const fim = src.indexOf('\n};', iKits);
  if (iPrompt < 0 || iKits < 0 || fim < 0) {
    throw new Error(
      'Não consegui extrair PROMPT_BASE/KITS_IA de routes/auth.js — o ficheiro mudou de forma. ' +
      'Corrige isto ANTES de gastar dinheiro.'
    );
  }
  // Bloco contíguo: apanha PROMPT_BASE, KIT_URL/KIT2_URL e kitPrompt() de uma
  // vez, porque KITS_IA depende dos três.
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(Math.min(iPrompt, iKits), fim + 3)}\nout = { PROMPT_BASE, KITS_IA };`, ctx);
  const { PROMPT_BASE, KITS_IA } = ctx.out;
  const kit = KITS_IA[kitId];
  if (!kit) throw new Error(`kitId "${kitId}" não existe. Opções: ${Object.keys(KITS_IA).join(', ')}`);
  if (!kit.ativo || !kit.url) {
    const ok = Object.keys(KITS_IA).filter((k) => KITS_IA[k].ativo && KITS_IA[k].url);
    throw new Error(`kit "${kitId}" não tem asset activo no Storage. Activos: ${ok.join(', ')}`);
  }
  return { prompt: PROMPT_BASE.replace('{{KIT}}', kit.kitPrompt), kit };
}

/**
 * Troca a secção BACKGROUND do prompt. Faz ASSERT de cada substituição: se o
 * prompt de produção mudar de forma, aborta em vez de gerar às cegas com o
 * fundo errado (que invalidaria silenciosamente o teste).
 */
function comFundo(prompt, nomeFundo) {
  const f = FUNDOS[nomeFundo];
  if (!f) throw new Error(`fundo "${nomeFundo}" não existe. Opções: ${Object.keys(FUNDOS).join(', ')}`);
  if (!f.bloco) return prompt; // produção

  const iBg = prompt.indexOf('BACKGROUND — CRITICAL:');
  const iNever = prompt.indexOf('NEVER GENERATE:');
  if (iBg < 0 || iNever < 0 || iNever < iBg) {
    throw new Error('Não encontrei a secção BACKGROUND no prompt de produção — aborta antes de gastar dinheiro.');
  }
  let out = prompt.slice(0, iBg) + f.bloco + '\n\n' + prompt.slice(iNever);

  // A lista NEVER GENERATE proíbe fundo colorido — contradiria o fundo novo.
  const proibicao = '- Colored or busy background (stadium, grass, crowd, arena)';
  if (out.includes(proibicao)) {
    out = out.replace(proibicao, '- Busy background (stadium, grass, crowd, arena, any scenery)');
  }
  if (out.includes('#050810')) throw new Error('O fundo antigo (#050810) ainda está no prompt — substituição falhou.');
  if (!out.includes(f.cor)) throw new Error(`O fundo novo (${f.cor}) não entrou no prompt — substituição falhou.`);
  return out;
}

/** ETAPA 0 de produção: estende o topo 18% com a cor média da faixa superior. */
async function preprocessar(fotoBuf) {
  const meta = await sharp(fotoBuf).metadata();
  const stripH = Math.max(8, Math.round((meta.height || 0) * 0.02));
  const { data: avg } = await sharp(fotoBuf)
    .extract({ left: 0, top: 0, width: meta.width, height: stripH })
    .resize(1, 1).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const [r, g, b] = avg;
  const padTop = Math.round((meta.height || 0) * 0.18);
  return sharp(fotoBuf).extend({ top: padTop, background: { r, g, b, alpha: 1 } }).jpeg({ quality: 90 }).toBuffer();
}

/** A rede de detecção COMO ESTÁ HOJE em auth.js: linhas y=0..2, >15% da largura. */
async function coroaContato(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  let max = 0;
  for (let y = 0; y <= 2 && y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) if (data[(y * w + x) * c + 3] > 200) n++;
    if (n > max) max = n;
  }
  return { cortada: max > w * 0.15, px: max, limiar: Math.round(w * 0.15) };
}

/**
 * TESTE PROPOSTO — ACHATAMENTO. Mede se a cabeça está INCOMPLETA, não se toca
 * a borda: cabeça real afunila numa cúpula (razão baixa); cabeça comida pelo
 * recorte tem topo largo e reto (razão ~1). Validado em ficheiros reais do
 * Futty: 0,05 nas boas, 1,00 nas cortadas → limiar 0,5 é seguro.
 */
async function coroaAchatamento(buf) {
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
  return { razao, primeira, maxima, cortada: razao > 0.5 };
}

async function gerar(inputUrl, kitUrl, prompt, quality) {
  const r = await fal.subscribe('fal-ai/gpt-image-1.5/edit', {
    input: { prompt, image_urls: [inputUrl, kitUrl], quality, num_images: 1 },
    logs: false,
  });
  const urlGerada = r?.images?.[0]?.url;
  if (!urlGerada) throw new Error('a IA não devolveu imagem');
  const geradaBuf = Buffer.from(await (await fetch(urlGerada)).arrayBuffer());

  const rb = await fal.subscribe('fal-ai/birefnet', { input: { image_url: urlGerada, model: 'General Use (Light)' } });
  const urlRec = rb?.image?.url;
  if (!urlRec) throw new Error('birefnet não devolveu imagem');
  return { geradaBuf, recorteBuf: Buffer.from(await (await fetch(urlRec)).arrayBuffer()) };
}

function flag(nome, omissao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1].split(',').map((s) => s.trim()) : omissao;
}

(async () => {
  const pasta = process.argv[2];
  if (!pasta || pasta.startsWith('--')) {
    console.error('\nFalta a pasta com as fotos.\n\n  node scripts/_bench/qualidade-low-vs-medium.js ./public/fotos-teste\n');
    process.exit(1);
  }
  const kitId = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'dark-gold';
  const qualidades = flag('qualidades', ['low', 'medium']);
  const fundos = flag('fundos', ['preto', 'cinza']);

  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta no ambiente.'); process.exit(1); }
  if (!fs.existsSync(pasta)) { console.error(`Pasta não encontrada: ${pasta}`); process.exit(1); }
  const fotos = fs.readdirSync(pasta).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  if (!fotos.length) { console.error(`Nenhuma foto em ${pasta}. Põe 4-8 fotos lá (jpg/png) e corre outra vez.`); process.exit(1); }

  const { prompt, kit } = promptDeProducao(kitId);
  for (const f of fundos) comFundo(prompt, f); // valida TODOS antes de gastar $1
  fs.mkdirSync(SAIDA, { recursive: true });

  const nGer = fotos.length * qualidades.length * fundos.length;
  console.log(`\nFotos: ${fotos.length} · qualidades: ${qualidades.join(', ')} · fundos: ${fundos.join(', ')} · kit: ${kitId}`);
  console.log(`Gerações: ${nGer} · prompt lido de produção (${prompt.length} chars)\n`);

  const linhas = [];
  const tmpPaths = [];

  for (const foto of fotos) {
    const nome = path.parse(foto).name;
    let inputUrl;
    try {
      // O bucket 'avatars' é privado; o fal precisa de URL acessível → 'kits' (público) como tmp.
      const padded = await preprocessar(fs.readFileSync(path.join(pasta, foto)));
      const tmpPath = `tmp-qualidade/${nome}-pad.jpg`;
      const { error } = await supabase.storage.from('kits').upload(tmpPath, padded, { contentType: 'image/jpeg', upsert: true });
      if (error) throw new Error('upload: ' + error.message);
      tmpPaths.push(tmpPath);
      const { data: pub } = supabase.storage.from('kits').getPublicUrl(tmpPath);
      inputUrl = `${pub.publicUrl}?v=${Date.now()}`;
    } catch (e) {
      console.error(`[${nome}] etapa 0 falhou: ${e.message} — salto esta foto`);
      continue;
    }

    for (const fundo of fundos) {
      for (const q of qualidades) {
        const t0 = Date.now();
        try {
          const { geradaBuf, recorteBuf } = await gerar(inputUrl, kit.url, comFundo(prompt, fundo), q);
          const mg = await sharp(geradaBuf).metadata();
          const dim = `${mg.width}x${mg.height}`;

          // Detecção ANTES do trim (como produção mede hoje) e DEPOIS (a verdade).
          const antes = await coroaContato(recorteBuf);
          const trimmed = await sharp(recorteBuf).trim({ threshold: 10 }).png().toBuffer();
          const depois = await coroaContato(trimmed);
          const achat = await coroaAchatamento(trimmed);

          // ETAPA 3 de produção → é ESTE ficheiro que o jogador vê.
          const final = await sharp(recorteBuf)
            .trim({ threshold: 10 })
            .extend({ top: 40, background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .resize({ height: 640, width: 512, fit: 'inside' })
            .png().toBuffer();
          const ficheiro = `${nome}--${fundo}--${q}.png`;
          fs.writeFileSync(path.join(SAIDA, ficheiro), final);
          // guarda também a gerada com fundo, para se ver o que o birefnet recebeu
          fs.writeFileSync(path.join(SAIDA, `${nome}--${fundo}--${q}--bruta.png`), geradaBuf);

          const custo = (TABELA[q]?.[dim] ?? TABELA[q]?.['1024x1536'] ?? 0) + CUSTO_BIREFNET;
          linhas.push({ nome, fundo, q, dim, ficheiro, antes, depois, achat, custo });
          console.log(
            `OK ${nome.padEnd(12)} ${fundo.padEnd(6)} ${q.padEnd(6)} ${dim.padEnd(10)} ` +
            `contato ${antes.cortada ? 'CORTADA' : 'passa'}→${depois.cortada ? 'CORTADA' : 'passa'}  ` +
            `achat ${achat.razao === null ? '-' : achat.razao.toFixed(2)}${achat.cortada ? ' CORTADA' : ''}  ` +
            `$${custo.toFixed(3)}  ${((Date.now() - t0) / 1000).toFixed(0)}s`
          );
        } catch (e) {
          console.error(`FALHOU ${nome} ${fundo} ${q}: ${e.message}`);
        }
      }
    }
  }

  if (tmpPaths.length) await supabase.storage.from('kits').remove(tmpPaths).catch(() => {});

  // ---------------------------- RESUMO ----------------------------
  console.log('\n' + '='.repeat(78));
  console.log('A HIPÓTESE DO FUNDO (cabelo preto sobre fundo preto):');
  for (const fundo of fundos) {
    const ls = linhas.filter((l) => l.fundo === fundo);
    if (!ls.length) continue;
    const cort = ls.filter((l) => l.achat.cortada).length;
    console.log(`  fundo ${fundo.padEnd(6)} n=${ls.length}  coroa cortada: ${cort}/${ls.length} (${((cort / ls.length) * 100).toFixed(0)}%)`);
  }
  console.log('\nA CONTA DO ENVELOPE (R$4,90 − 15% loja, R$5,5/dólar ≈ $0,757 líq. / 10 fig.):');
  for (const fundo of fundos) {
    for (const q of qualidades) {
      const ls = linhas.filter((l) => l.fundo === fundo && l.q === q);
      if (!ls.length) continue;
      const medio = ls.reduce((s, l) => s + l.custo, 0) / ls.length;
      const taxa = ls.filter((l) => l.achat.cortada).length / ls.length;
      const real = medio * (1 + taxa); // retry dobra a geração falhada
      const custo10 = real * 10;
      const escapou = ls.filter((l) => !l.antes.cortada && l.depois.cortada).length;
      console.log(
        `  ${fundo.padEnd(6)} ${q.padEnd(6)} $${medio.toFixed(3)}/fig · retry ${(taxa * 100).toFixed(0)}% → ` +
        `real $${real.toFixed(3)} · envelope $${custo10.toFixed(2)}/$0,76 → margem ${(((0.757 - custo10) / 0.757) * 100).toFixed(0)}%` +
        (escapou ? `  (${escapou} escaparam à rede actual)` : '')
      );
    }
  }
  console.log('='.repeat(78));

  // ------------------- HTML lado a lado, tamanho real -------------------
  const nomes = [...new Set(linhas.map((l) => l.nome))];
  const combos = [];
  for (const f of fundos) for (const q of qualidades) combos.push({ f, q });
  const cel = (l) => l ? `
    <div class="cel">
      <img src="${l.ficheiro}" alt="${l.nome}">
      <div class="meta"><b>${l.fundo} · ${l.q}</b><br>${l.dim} · $${l.custo.toFixed(3)}
        <span class="${l.achat.cortada ? 'ruim' : 'bom'}">achat ${l.achat.razao === null ? '-' : l.achat.razao.toFixed(2)}</span>
        ${!l.antes.cortada && l.depois.cortada ? '<span class="ruim">escapou à rede</span>' : ''}
        <a href="${l.ficheiro.replace('.png', '--bruta.png')}" target="_blank">ver bruta</a>
      </div>
    </div>` : '<div class="cel">—</div>';

  const html = `<!doctype html><meta charset="utf-8"><title>Bancada — qualidade × fundo</title>
<style>
  :root{--ouro:#d4a017}
  body{background:#0d0d12;color:#eee;font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px}
  h1{font-size:18px;margin:0 0 4px} h1 b{color:var(--ouro)}
  p.sub{color:#888;margin:0 0 18px;max-width:620px}
  .toggle button{background:#1a1a22;color:#eee;border:1px solid #333;padding:8px 14px;border-radius:8px;cursor:pointer;margin-right:8px}
  .toggle button.on{border-color:var(--ouro);color:var(--ouro)}
  .grupo{margin:26px 0}
  .rot{color:var(--ouro);font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:11px;margin-bottom:8px}
  .fila{display:flex;gap:12px;flex-wrap:wrap}
  .cel{background:#14141b;border:1px solid #24242e;border-radius:12px;padding:10px;text-align:center;width:220px}
  .cel img{width:100%;height:auto;display:block}
  .meta{font-size:11px;color:#999;margin-top:8px}
  .meta a{color:#666;margin-left:6px}
  .bom{color:#4ade80;margin-left:6px} .ruim{color:#f87171;margin-left:6px;font-weight:700}
  body.real .cel{width:196px} body.real .cel img{width:176px;margin:0 auto}
</style>
<h1>Qualidade <b>low vs medium</b> × fundo de geração <b>preto vs cinza</b></h1>
<p class="sub">Julga no TAMANHO REAL — é assim que aparece no telefone. O zoom favorece sempre o medium
e faz gastar 4× por uma diferença que ninguém vê. <b>achat</b> = achatamento da coroa:
perto de 0 é cabeça inteira, perto de 1 é cabeça comida pelo recorte.</p>
<div class="toggle">
  <button id="b1" class="on" onclick="document.body.className='real';b1.className='on';b2.className=''">Tamanho real</button>
  <button id="b2" onclick="document.body.className='';b2.className='on';b1.className=''">Zoom</button>
</div>
${nomes.map((n) => `<div class="grupo"><div class="rot">${n}</div><div class="fila">${combos.map((c) => cel(linhas.find((l) => l.nome === n && l.fundo === c.f && l.q === c.q))).join('')}</div></div>`).join('\n')}
<script>document.body.className='real'</script>`;

  const htmlPath = path.join(SAIDA, 'index.html');
  fs.writeFileSync(htmlPath, html);
  console.log(`\n>>> ABRE ESTE FICHEIRO NO BROWSER (duplo-clique):\n${htmlPath}\n`);
  console.log('Nada foi tocado em produção.\n');
})();
