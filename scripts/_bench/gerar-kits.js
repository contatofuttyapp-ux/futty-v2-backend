// BANCADA — ASSETS DOS KITS 3 e 4 (White Gold · Elite Gold), 31-jul.
// O dono decidiu: 4 uniformes no lançamento, mesmo design, só a cor muda.
// Este script RECOLORE o asset oficial kit1-dark-gold.png (Image 1 = verdade)
// e gera N candidatos por cor para o olho do dono escolher.
//
// Uso:
//   node scripts/_bench/gerar-kits.js                     (3 candidatos × 2 kits)
//   node scripts/_bench/gerar-kits.js --n 2               (2 por kit)
//   node scripts/_bench/gerar-kits.js --publicar white-gold saida-kits/white-gold-c2.png
//     → sobe o escolhido ao bucket 'kits' com o nome DEFINITIVO (kit3/kit4) e
//       imprime a URL pública. (Ligar ativo:true no auth.js é passo meu, a seguir.)
//
// Custo: ~$0,05/candidato (medium) → 6 candidatos ≈ $0,32. Tecto $0,60.

const fs = require('fs');
const path = require('path');
const fal = require('@fal-ai/serverless-client');
const { supabase } = require('../../utils/db');

fal.config({ credentials: process.env.FAL_KEY });

const SAIDA = path.join(__dirname, 'saida-kits');
const TETO = 0.6;
const REF_URL = 'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/kits/kit1-dark-gold.png';

// As cores vêm da MESMA régua do catálogo de produção (KITS_IA em auth.js).
const NOVOS = {
  // Royal Purple (pedido do dono, 31-jul): o INVERTIDO do roxo — par do Elite Gold.
  // Candidato a 5º kit pago; decisão de entrar no lançamento só depois do olho.
  'royal-purple': {
    ficheiroFinal: 'kit5-royal-purple.png',
    brief: `Recreate THE EXACT SAME jersey with ONLY the colours changed — INVERTED scheme:
- Base colour: vivid purple #8b5cf6 (the whole shirt is purple)
- Diagonal panel, V-neck piping, cuff trim and badge: deep black #0d0d12
This kit is the luxury inverted version: purple is the base, black is the accent.
Everything else identical to Image 1.`,
  },
  'white-gold': {
    ficheiroFinal: 'kit3-white-gold.png',
    brief: `Recreate THE EXACT SAME jersey with ONLY the colours changed:
- Base colour: off-white #f8f5f0 (clean, slightly warm white)
- Diagonal panel, V-neck piping, cuff trim and badge: metallic gold #d4a017
Everything else identical to Image 1.`,
  },
  'elite-gold': {
    ficheiroFinal: 'kit4-elite-gold.png',
    brief: `Recreate THE EXACT SAME jersey with ONLY the colours changed — INVERTED scheme:
- Base colour: metallic gold #d4a017 (the whole shirt is gold)
- Diagonal panel, V-neck piping, cuff trim and badge: deep black #0d0d12
This kit is the luxury inverted version: gold is the base, black is the accent.
Everything else identical to Image 1.`,
  },
};

const PROMPT = (brief) => `Image 1 is the OFFICIAL product shot of the Futty jersey (Dark Gold edition).
It is the ground truth for design, cut, fabric, folds, camera angle, framing, lighting and background.

${brief}

STRICT RULES:
- Same jersey design, same diagonal panel shape, same collar, same cuffs, same badge placement
- Same presentation: same angle, same framing, same lighting, same background as Image 1
- No person, no mannequin visible beyond what Image 1 shows, no text, no watermark
- Premium sports-kit fabric look with realistic sheen
- The badge is the Futty monogram exactly as in Image 1, recoloured to the accent colour`;

const flag = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };

(async () => {
  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta.'); process.exit(1); }

  // ---- modo publicar: sobe o candidato escolhido com o nome definitivo ----
  const iPub = process.argv.indexOf('--publicar');
  if (iPub > 0) {
    const kitId = process.argv[iPub + 1];
    const fich = process.argv[iPub + 2];
    const N = NOVOS[kitId];
    if (!N || !fich) { console.error('Uso: --publicar <white-gold|elite-gold> <caminho-do-png>'); process.exit(1); }
    const abs = path.isAbsolute(fich) ? fich : path.join(__dirname, '..', '..', fich);
    if (!fs.existsSync(abs)) { console.error(`Ficheiro não encontrado: ${abs}`); process.exit(1); }
    const { error } = await supabase.storage.from('kits').upload(N.ficheiroFinal, fs.readFileSync(abs), { contentType: 'image/png', upsert: true });
    if (error) { console.error('Upload falhou:', error.message); process.exit(1); }
    const { data: pub } = supabase.storage.from('kits').getPublicUrl(N.ficheiroFinal);
    console.log(`\nPUBLICADO: ${kitId} → ${pub.publicUrl}`);
    console.log('Próximo passo (do Claude): ligar ativo:true + url no KITS_IA e pôr no seletor do frontend.\n');
    return;
  }

  // ---- modo gerar candidatos ----
  const n = Number(flag('n', '3'));
  // --kits royal-purple  → gera só os pedidos (para não regenerar os já escolhidos)
  const filtro = flag('kits', '');
  const alvos = filtro ? filtro.split(',').map((s) => s.trim()).filter((k) => NOVOS[k]) : Object.keys(NOVOS);
  if (!alvos.length) { console.error(`Nenhum kit válido em --kits. Opções: ${Object.keys(NOVOS).join(', ')}`); process.exit(1); }
  const custo = n * alvos.length * 0.053;
  if (custo > TETO) { console.error(`RECUSADO: $${custo.toFixed(2)} > tecto $${TETO}`); process.exit(1); }
  fs.mkdirSync(SAIDA, { recursive: true });
  console.log(`\nKITS 3 e 4 — ${n} candidatos por cor · ~$${custo.toFixed(2)}\n`);

  const linhas = [];
  for (const [kitId, N] of Object.entries(NOVOS)) {
    for (let c = 1; c <= n; c++) {
      const t0 = Date.now();
      try {
        const r = await fal.subscribe('fal-ai/gpt-image-1.5/edit', {
          input: { prompt: PROMPT(N.brief), image_urls: [REF_URL], quality: 'medium', num_images: 1 },
          logs: false,
        });
        const url = r?.images?.[0]?.url;
        if (!url) throw new Error('sem imagem');
        const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
        const fich = `${kitId}-c${c}.png`;
        fs.writeFileSync(path.join(SAIDA, fich), buf);
        linhas.push({ kitId, fich });
        console.log(`OK ${kitId} candidato ${c}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      } catch (e) {
        console.error(`FALHOU ${kitId} c${c}: ${e.message}`);
      }
    }
  }

  const html = `<!doctype html><meta charset="utf-8"><title>Kits 3 e 4 — candidatos</title>
<style>
 body{background:#0d0d12;color:#eee;font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px}
 h1{font-size:19px;margin:0 0 4px} h1 b{color:#d4a017}
 p{color:#888;margin:0 0 18px;max-width:640px}
 .grupo{margin:24px 0;border-top:1px solid #1e1e28;padding-top:12px}
 .rot{color:#d4a017;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px}
 .fila{display:flex;gap:14px;flex-wrap:wrap}
 .cel{background:#14141b;border:1px solid #24242e;border-radius:12px;padding:10px;text-align:center}
 .cel img{width:230px;display:block}
 .meta{font-size:12px;color:#999;margin-top:8px}
 .ref{opacity:.8}
</style>
<h1>Kits 3 e 4 — <b>escolhe 1 candidato por cor</b></h1>
<p>A referência (Dark Gold oficial) está primeiro. Compare o desenho: diagonal, gola, punhos e o F têm de ser IGUAIS, só a cor muda. Diga ao Claude qual venceu (ex.: "white c2, elite c1").</p>
<div class="grupo"><div class="rot">Referência oficial</div><div class="fila">
  <div class="cel ref"><img src="${REF_URL}"><div class="meta">kit1 Dark Gold (verdade)</div></div>
</div></div>
${Object.keys(NOVOS).map((k) => `<div class="grupo"><div class="rot">${k}</div><div class="fila">
${linhas.filter((l) => l.kitId === k).map((l) => `<div class="cel"><img src="${l.fich}"><div class="meta">${l.fich}</div></div>`).join('')}
</div></div>`).join('\n')}`;

  fs.writeFileSync(path.join(SAIDA, 'index.html'), html);
  console.log(`\nHTML: ${path.join(SAIDA, 'index.html')}\n`);
})();
