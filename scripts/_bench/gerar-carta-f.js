// BANCADA v9.2 — CARTA-F DOURADA gerada (as SVG morreram). 1 tentativa (+1 retry só
// se a forma do F falhar — máx ~$0.08, ordem expressa). Refs: golden-plate.jpg
// (material) + futty-logo-flat.png (forma EXATA do F). Caminho dos bichos (edit).
const fs = require('fs');
const path = require('path');
const fal = require('@fal-ai/serverless-client');
const { supabase } = require('../../utils/db');
fal.config({ credentials: process.env.FAL_KEY });

const SCR = 'C:/Users/phfer/AppData/Local/Temp/claude/C--Users-phfer/e6d3f9a7-8e16-4cba-95ea-1c38c8ef7b1b/scratchpad';
const PLATE = 'c:/Users/phfer/Desktop/FUT/FUTTY-V2/frontend/public/golden-plate.jpg';
const LOGO  = 'c:/Users/phfer/Desktop/FUT/FUTTY-V2/frontend/public/futty-logo-flat.png';

const PROMPT = `Create ONE luxury playing card, portrait orientation, filling the ENTIRE frame edge-to-edge (the card IS the image, no background around it).

MATERIAL — CRITICAL — Image 1 is the ground truth:
- The whole card face is made of the rich gold foil material from Image 1 (same grain, same warm metallic shine, subtle specular highlights)
- Ornate inner border frame EMBOSSED in raised gold relief (double filigree line, elegant, luxury deck)

CENTERPIECE — CRITICAL — Image 2 is the ground truth for SHAPE:
- The large centered emblem is the letter-F logo from Image 2, reproduced with its EXACT shape (italic double-stroke F letterform) — do NOT redesign it
- The F is solid BLACK (glossy black enamel look) over the gold foil, large, centered

CARD ANATOMY:
- Real playing-card proportions (poker card, rounded corners)
- Discreet small corner indices top-left and bottom-right: a tiny black "F" with a tiny diamond pip beneath
- Elegant, luxurious, premium casino deck aesthetic
- No text other than the indices, no watermark, no hands, no table`;

async function upload(localPath, remoteName, contentType) {
  const buf = fs.readFileSync(localPath);
  const p = `tmp-baralho/${remoteName}`;
  const { error } = await supabase.storage.from('kits').upload(p, buf, { contentType, upsert: true });
  if (error) throw new Error('upload ' + remoteName + ': ' + error.message);
  const { data } = supabase.storage.from('kits').getPublicUrl(p);
  return { url: `${data.publicUrl}?v=${Date.now()}`, path: p };
}

(async () => {
  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta'); process.exit(1); }
  const tmp = [];
  try {
    const plate = await upload(PLATE, 'plate.jpg', 'image/jpeg'); tmp.push(plate.path);
    const logo = await upload(LOGO, 'logo.png', 'image/png'); tmp.push(logo.path);
    const gerar = async (n) => {
      const t0 = Date.now();
      const r = await fal.subscribe('fal-ai/gpt-image-1.5/edit', {
        input: { prompt: PROMPT, image_urls: [plate.url, logo.url], quality: 'medium', num_images: 1 },
        logs: false,
      });
      const u = r?.images?.[0]?.url;
      if (!u) throw new Error('sem imagem');
      const buf = Buffer.from(await (await fetch(u)).arrayBuffer());
      fs.writeFileSync(path.join(SCR, `v9-carta-f${n > 1 ? '-r2' : ''}.png`), buf);
      console.log(`OK tentativa ${n} (${((Date.now() - t0) / 1000).toFixed(0)}s) -> v9-carta-f${n > 1 ? '-r2' : ''}.png`);
    };
    await gerar(1);
    console.log('GERACOES=1 (retry só por ordem do agente se o F falhar)');
  } catch (e) {
    console.error('FALHOU:', e.message);
  } finally {
    if (tmp.length) await supabase.storage.from('kits').remove(tmp).catch(() => {});
  }
})();
