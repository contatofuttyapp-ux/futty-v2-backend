// BANCADA v9.4 — 4 cartas com a receita certa: o prompt CONVERSA COM O APP.
// Refs por geração: golden-plate (material) + kit dark-gold (linguagem) + screenshot
// REAL da máquina do sorteio (lâmpadas marquee + chanfro 45°). A logo NUNCA é gerada
// (lei v9.3) — os centros ficam vazios p/ carimbo local; troféu e bola PODEM ser gerados.
const fs = require('fs');
const path = require('path');
const fal = require('@fal-ai/serverless-client');
const { supabase } = require('../../utils/db');
fal.config({ credentials: process.env.FAL_KEY });

const SCR = 'C:/Users/phfer/AppData/Local/Temp/claude/C--Users-phfer/e6d3f9a7-8e16-4cba-95ea-1c38c8ef7b1b/scratchpad';
const PLATE = 'c:/Users/phfer/Desktop/FUT/FUTTY-V2/frontend/public/golden-plate.jpg';
const MAQREF = path.join(SCR, 'maq-ref.png');
const KIT_URL = 'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/kits/kit1-dark-gold.png';

const base = (cor, centro) => `Create ONE luxury casino playing card, vertical poker proportions, filling the ENTIRE frame edge-to-edge (the card IS the image, nothing around it).

DESIGN LANGUAGE — CRITICAL — match the app in the references:
- Image 1: the house gold foil material (grain + warm metallic shine)
- Image 2: the house jersey (black + metallic accents = the brand palette)
- Image 3: the REAL slot machine of the app — copy its language: BEVELED 45° CORNERS (octagonal cuts, not round), thin DOUBLE INNER BORDER, and SUBTLE MARQUEE-LIGHT DOTS along the frame (small glowing bulbs like the machine's edge)
- ${cor} metallic material for the card face, dark casino ambience, elegant and premium

CENTER: ${centro}

PROHIBITIONS: NO letters, NO numbers, NO logos, NO watermarks, no hands, no table.`;

const ALVOS = [
  { id: 'mat-ouro',  prompt: base('Rich GOLD (#d4a017 family) foil', 'EMPTY — plain foil center panel, ready to receive an emblem later. NO symbol of any kind in the center.') },
  { id: 'mat-roxo',  prompt: base('Deep PURPLE (#8b5cf6 family, dark royal) metallic', 'EMPTY — plain metallic center panel, ready to receive an emblem later. NO symbol of any kind in the center.') },
  { id: 'trofeu',    prompt: base('Rich GOLD (#d4a017 family) foil', 'an ORNATE GOLDEN TROPHY (championship cup with handles), embossed in the center, matching the card metal, elegant relief.') },
  { id: 'bola',      prompt: base('BLACK with GOLD (#d4a017) accents', 'a CLASSIC STYLIZED FOOTBALL (soccer ball, pentagon pattern) in polished gold metal at the center, metallic shine.') },
];

(async () => {
  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta'); process.exit(1); }
  const tmp = [];
  const up = async (localPath, name, ct) => {
    const { error } = await supabase.storage.from('kits').upload(`tmp-baralho/${name}`, fs.readFileSync(localPath), { contentType: ct, upsert: true });
    if (error) throw new Error(error.message);
    tmp.push(`tmp-baralho/${name}`);
    return supabase.storage.from('kits').getPublicUrl(`tmp-baralho/${name}`).data.publicUrl + '?v=' + Date.now();
  };
  try {
    const plateUrl = await up(PLATE, 'plate.jpg', 'image/jpeg');
    const maqUrl = await up(MAQREF, 'maq-ref.png', 'image/png');
    for (const a of ALVOS) {
      const t0 = Date.now();
      try {
        const r = await fal.subscribe('fal-ai/gpt-image-1.5/edit', {
          input: { prompt: a.prompt, image_urls: [plateUrl, KIT_URL, maqUrl], quality: 'medium', num_images: 1 },
          logs: false,
        });
        const u = r?.images?.[0]?.url;
        if (!u) throw new Error('sem imagem');
        fs.writeFileSync(path.join(SCR, `v94-${a.id}.png`), Buffer.from(await (await fetch(u)).arrayBuffer()));
        console.log(`OK ${a.id} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      } catch (e) { console.error(`FALHOU ${a.id}: ${e.message}`); }
    }
  } finally {
    if (tmp.length) await supabase.storage.from('kits').remove(tmp).catch(() => {});
  }
  console.log('PEDIDOS=4 · retry por carta só se vier suja (a olho)');
})();
