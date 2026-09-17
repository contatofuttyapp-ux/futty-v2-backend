// BANCADA v9.3 — FÁBRICA HÍBRIDA: o fal gera SÓ O MATERIAL da carta (SEM símbolos —
// a logo NUNCA é gerada por IA; carimba-se localmente depois). 2 gerações (~$0.08):
// (i) toda DOURADA (material golden-plate) · (ii) toda ROXA (#8b5cf6 profundo).
const fs = require('fs');
const path = require('path');
const fal = require('@fal-ai/serverless-client');
const { supabase } = require('../../utils/db');
fal.config({ credentials: process.env.FAL_KEY });

const SCR = 'C:/Users/phfer/AppData/Local/Temp/claude/C--Users-phfer/e6d3f9a7-8e16-4cba-95ea-1c38c8ef7b1b/scratchpad';
const PLATE = 'c:/Users/phfer/Desktop/FUT/FUTTY-V2/frontend/public/golden-plate.jpg';

const promptMaterial = (corTxt) => `Create ONE luxury playing card BLANK, portrait orientation, filling the ENTIRE frame edge-to-edge (the card IS the image, no background around it).

MATERIAL — Image 1 is the ground truth for texture:
- The whole card face is made of rich ${corTxt} metallic foil (same grain and warm specular shine as Image 1, recolored if needed)
- Ornate inner border frame EMBOSSED in raised relief of the same metal
- Elegant worked corners, premium casino deck aesthetic
- Clean empty center panel (plain foil, ready to receive an emblem later)

ABSOLUTE PROHIBITIONS — CRITICAL:
- NO letters, NO numbers, NO logos, NO symbols, NO pips, NO emblems anywhere
- NO text of any kind, NO watermark
- The center is EMPTY foil — nothing printed on it
- No hands, no table, no other objects`;

const ALVOS = [
  { id: 'material-ouro', corTxt: 'GOLD (#d4a017 family)' },
  { id: 'material-roxo', corTxt: 'DEEP PURPLE (#8b5cf6 family, dark royal purple)' },
];

(async () => {
  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta'); process.exit(1); }
  const tmp = [];
  try {
    const buf = fs.readFileSync(PLATE);
    const p = 'tmp-baralho/plate.jpg';
    const { error } = await supabase.storage.from('kits').upload(p, buf, { contentType: 'image/jpeg', upsert: true });
    if (error) throw new Error('upload: ' + error.message);
    tmp.push(p);
    const { data } = supabase.storage.from('kits').getPublicUrl(p);
    const plateUrl = `${data.publicUrl}?v=${Date.now()}`;
    for (const a of ALVOS) {
      const t0 = Date.now();
      try {
        const r = await fal.subscribe('fal-ai/gpt-image-1.5/edit', {
          input: { prompt: promptMaterial(a.corTxt), image_urls: [plateUrl], quality: 'medium', num_images: 1 },
          logs: false,
        });
        const u = r?.images?.[0]?.url;
        if (!u) throw new Error('sem imagem');
        fs.writeFileSync(path.join(SCR, `v9-${a.id}.png`), Buffer.from(await (await fetch(u)).arrayBuffer()));
        console.log(`OK ${a.id} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      } catch (e) { console.error(`FALHOU ${a.id}: ${e.message}`); }
    }
  } finally {
    if (tmp.length) await supabase.storage.from('kits').remove(tmp).catch(() => {});
  }
  console.log('MATERIAIS=2 pedidos · retry só se vier sujo (a decidir a olho)');
})();
