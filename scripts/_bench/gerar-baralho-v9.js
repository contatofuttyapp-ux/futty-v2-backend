// BANCADA v9 — Baralho oficial do sorteio: 5 personagens gerados 1x cada (ordem
// expressa do utilizador, ~$0.20 total). Padrão copiado do pipeline real
// (routes/auth.js): gpt-image-1.5/edit (quality medium) + birefnet p/ recorte.
// Inputs (V1 locais) sobem ao bucket PÚBLICO 'kits' (tmp) — o 'avatars' é privado.
// Uso: node scripts/_bench/gerar-baralho-v9.js
const fs = require('fs');
const path = require('path');
const fal = require('@fal-ai/serverless-client');
const { supabase } = require('../../utils/db');

fal.config({ credentials: process.env.FAL_KEY });

const SCR = 'C:/Users/phfer/AppData/Local/Temp/claude/C--Users-phfer/e6d3f9a7-8e16-4cba-95ea-1c38c8ef7b1b/scratchpad';
const AV = path.join(__dirname, '..', '..', 'public', 'avatares', 'preto');

const KIT_URL = 'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/kits/kit1-dark-gold.png';
const KIT2_URL = 'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/kits/kit2-dark-purple.png';

// Secção KIT (mesma régua do auth.js, ajustada a busto — sem shorts).
const kitSec = (nome, base, acento) => `KIT — CRITICAL — REPRODUCE IMAGE 2 EXACTLY:
The jersey in Image 2 is the Futty ${nome} jersey. Reproduce it precisely:
- Base color: ${base}
- Large diagonal panel in ${acento} running from upper-left shoulder down to lower-right hem
- V-neck collar: ${base} with thin ${acento} piping
- Short sleeves: ${base} with thin ${acento} trim at cuffs
- Badge: single Futty monogram (two mirrored F letters forming one unified symbol) in ${acento} on upper-left chest
CRITICAL: do NOT change colors or design; Image 2 is ground truth; NEVER a white or blank jersey.`;

const GOLD = kitSec('Dark Gold', 'deep black #0d0d12', 'metallic gold #d4a017');
const PURPLE = kitSec('Dark Purple', 'deep black #0d0d12', 'vivid purple #8b5cf6');

// Prompt-base: o personagem V1 como avatar da casa (busto, traço V1, fundo escuro).
const promptPara = (criatura, kitTxt) => `Image 1 is a Futty V1 mascot avatar: an anthropomorphic ${criatura} wearing a plain black t-shirt, painterly semi-realistic style, dark background.

TASK: Recreate THE SAME character (same species, same face, same painterly semi-realistic V1 style, same lighting mood) as a Futty trading-card avatar:
- BUST / waist-up, facing slightly forward, confident sporty pose
- The character now WEARS the Futty jersey described below (replace the black t-shirt)
- Keep the character's anatomy, skin/fur/scales texture and personality from Image 1
- Background: pure flat very dark color (#0d0d12) — no arena, no bokeh, no props
- Single character only, no text, no watermark

${kitTxt}

STYLE RULES:
- Match the illustration style of Image 1 exactly (painterly, detailed, semi-realistic mascot)
- NOT cartoon, NOT anime, NOT photoreal photography
- Metallic sheen on the jersey like a premium football kit`;

const PERSONAGENS = [
  { id: 'jacare',     ficheiro: 'Jacaré.png',     criatura: 'ALLIGATOR (green scaled crocodilian)', kitUrl: KIT_URL,  kitTxt: GOLD },
  { id: 'onca',       ficheiro: 'Onça.png',       criatura: 'JAGUAR (onça-pintada, spotted golden coat)', kitUrl: KIT_URL, kitTxt: GOLD },
  { id: 'tigre',      ficheiro: 'Tigre.png',      criatura: 'TIGER (orange with black stripes)', kitUrl: KIT_URL, kitTxt: GOLD },
  { id: 'et',         ficheiro: 'ET.png',         criatura: 'GREY ALIEN (big black eyes, grey skin)', kitUrl: KIT2_URL, kitTxt: PURPLE },
  { id: 'astronauta', ficheiro: 'Astronauta.png', criatura: 'ASTRONAUT (white space suit, reflective helmet visor)', kitUrl: KIT2_URL, kitTxt: PURPLE },
];

(async () => {
  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta'); process.exit(1); }
  let gens = 0, cortes = 0; const tmpPaths = [];
  for (const p of PERSONAGENS) {
    const t0 = Date.now();
    try {
      // 1) sobe o V1 ao bucket público 'kits' (tmp) → URL pública p/ o fal
      const buf = fs.readFileSync(path.join(AV, p.ficheiro));
      const tmpPath = `tmp-baralho/${p.id}.png`;
      const { error: upErr } = await supabase.storage.from('kits').upload(tmpPath, buf, { contentType: 'image/png', upsert: true });
      if (upErr) throw new Error('upload: ' + upErr.message);
      tmpPaths.push(tmpPath);
      const { data: pub } = supabase.storage.from('kits').getPublicUrl(tmpPath);
      const inputUrl = `${pub.publicUrl}?v=${Date.now()}`;

      // 2) geração (1 tentativa, quality medium — a régua do app)
      const result = await fal.subscribe('fal-ai/gpt-image-1.5/edit', {
        input: { prompt: promptPara(p.criatura, p.kitTxt), image_urls: [inputUrl, p.kitUrl], quality: 'medium', num_images: 1 },
        logs: false,
      });
      const urlGerada = result?.images?.[0]?.url;
      if (!urlGerada) throw new Error('sem imagem');
      gens++;

      // 3) recorte (birefnet) — se falhar, guarda a gerada com fundo
      let finalBuf;
      try {
        const rb = await fal.subscribe('fal-ai/birefnet', { input: { image_url: urlGerada, model: 'General Use (Light)' } });
        const urlRec = rb?.image?.url;
        if (!urlRec) throw new Error('sem recorte');
        finalBuf = Buffer.from(await (await fetch(urlRec)).arrayBuffer());
        cortes++;
      } catch (e) {
        console.error(`[${p.id}] birefnet falhou (${e.message}) — guardo com fundo`);
        finalBuf = Buffer.from(await (await fetch(urlGerada)).arrayBuffer());
      }
      fs.writeFileSync(path.join(SCR, `v9-${p.id}.png`), finalBuf);
      console.log(`OK ${p.id} (${((Date.now()-t0)/1000).toFixed(0)}s) -> v9-${p.id}.png`);
    } catch (e) {
      console.error(`FALHOU ${p.id}: ${e.message}`);
    }
  }
  // limpeza dos tmp no bucket público
  if (tmpPaths.length) await supabase.storage.from('kits').remove(tmpPaths).catch(() => {});
  console.log(`RESUMO: geracoes=${gens}/5 recortes=${cortes}/5`);
  console.log('CUSTO (tabela fal): gpt-image-1.5 medium ~$0.03-0.04/img; birefnet ~$0.002/img');
})();
