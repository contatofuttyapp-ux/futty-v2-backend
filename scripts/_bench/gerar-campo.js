// BANCADA — FUNDO DE CAMPO da ESCALAÇÃO (31-jul, dono).
// A tentativa antiga desenhava o campo por código e "ficou horroroso" — a regra
// da casa agora: CAMPO É ASSET (gerado 1x por IA), a composição só põe coisas
// por cima (avatares, chapas, aura pixelada, escudo, título).
//
// Gera 2 candidatos de cada estilo:
//   verde — gramado clássico premium (nostálgico, vibe álbum de figurinha)
//   dark  — o campo noturno da casa (piano-black, linhas douradas)
// Formato: 1024×1536 (2:3). Na composição final vira 9:16: escala p/ 1080×1620
// e estende o topo com a continuação escura (a faixa do cabeçalho).
//
// Uso:  node scripts/_bench/gerar-campo.js
//       node scripts/_bench/gerar-campo.js --publicar verde saida-campo/campo-verde-c1.png
//       node scripts/_bench/gerar-campo.js --publicar dark  saida-campo/campo-dark-c2.png
// Custo: 4 × ~$0,053 ≈ $0,21.

const fs = require('fs');
const path = require('path');
const fal = require('@fal-ai/serverless-client');
const { supabase } = require('../../utils/db');

fal.config({ credentials: process.env.FAL_KEY });

const SAIDA = path.join(__dirname, 'saida-campo');

const ESTILOS = {
  verde: {
    ficheiroFinal: 'campo-escalacao-verde.png',
    prompt: `Vertical background for a soccer team LINEUP graphic (like national-team lineup posters).
- A lush GREEN soccer pitch seen from a high angle, slightly tilted toward the viewer
- Saturated premium green grass with subtle mowing stripes
- Clean white pitch lines: center circle in the middle area, penalty box and goal area
  at the BOTTOM of the image
- Soft stadium light rays coming from the top, gentle vignette on the edges
- The TOP THIRD gradually darkens (deep green to near-black) so a header with a team
  crest and title can sit there with good contrast
- NO players, NO people, NO text, NO logos, NO watermark, NO ball
- Premium sticker-album poster style, clean and crisp, not photorealistic grass macro`,
  },
  dark: {
    ficheiroFinal: 'campo-escalacao-dark.png',
    prompt: `Vertical background for a soccer team LINEUP graphic (like national-team lineup posters).
- A NIGHT-MODE luxury soccer pitch: near-black surface (deep piano black #0d0d12)
  seen from a high angle, slightly tilted toward the viewer
- Pitch lines drawn in elegant METALLIC GOLD (#d4a017): center circle in the middle,
  penalty box and goal area at the BOTTOM
- Subtle gold light haze and a few tiny gold particles floating, premium dark stadium mood
- The TOP THIRD fades to pure black so a header with a team crest and title can sit there
- NO players, NO people, NO text, NO logos, NO watermark, NO ball
- Premium dark collector-card aesthetic, clean and crisp`,
  },
};

(async () => {
  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta.'); process.exit(1); }

  // ---- publicar ----
  const iPub = process.argv.indexOf('--publicar');
  if (iPub > 0) {
    const estilo = process.argv[iPub + 1];
    const fich = process.argv[iPub + 2];
    const E = ESTILOS[estilo];
    if (!E || !fich) { console.error('Uso: --publicar <verde|dark> <caminho-do-png>'); process.exit(1); }
    const abs = path.isAbsolute(fich) ? fich : path.join(__dirname, fich.replace(/^scripts[\\/]_bench[\\/]/, ''));
    if (!fs.existsSync(abs)) { console.error(`Não encontrado: ${abs}`); process.exit(1); }
    const { error } = await supabase.storage.from('kits').upload(E.ficheiroFinal, fs.readFileSync(abs), { contentType: 'image/png', upsert: true });
    if (error) { console.error('Upload falhou:', error.message); process.exit(1); }
    const { data: pub } = supabase.storage.from('kits').getPublicUrl(E.ficheiroFinal);
    console.log(`\nPUBLICADO: ${pub.publicUrl}\n`);
    return;
  }

  // ---- gerar candidatos ----
  fs.mkdirSync(SAIDA, { recursive: true });
  console.log('\nCAMPOS DA ESCALAÇÃO — 2 estilos × 2 candidatos (~$0,21)\n');
  const linhas = [];
  for (const [estilo, E] of Object.entries(ESTILOS)) {
    for (let c = 1; c <= 2; c++) {
      const t0 = Date.now();
      try {
        const r = await fal.subscribe('fal-ai/gpt-image-1.5', {
          input: { prompt: E.prompt, image_size: '1024x1536', quality: 'medium', num_images: 1 },
          logs: false,
        });
        const url = r?.images?.[0]?.url;
        if (!url) throw new Error('sem imagem');
        const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
        const fich = `campo-${estilo}-c${c}.png`;
        fs.writeFileSync(path.join(SAIDA, fich), buf);
        linhas.push({ estilo, fich });
        console.log(`OK ${estilo} candidato ${c}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      } catch (e) {
        console.error(`FALHOU ${estilo} c${c}: ${e.message}`);
      }
    }
  }

  const html = `<!doctype html><meta charset="utf-8"><title>Campos da escalação</title>
<style>
 body{background:#0d0d12;color:#eee;font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px}
 h1{font-size:19px;margin:0 0 4px} h1 b{color:#d4a017} p{color:#888;margin:0 0 18px;max-width:640px}
 .grupo{margin:24px 0;border-top:1px solid #1e1e28;padding-top:12px}
 .rot{color:#d4a017;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px}
 .fila{display:flex;gap:14px;flex-wrap:wrap}
 .cel{background:#14141b;border:1px solid #24242e;border-radius:12px;padding:10px;text-align:center}
 .cel img{width:250px;display:block} .meta{font-size:12px;color:#999;margin-top:8px}
</style>
<h1>Campo da escalação — <b>escolhe 1 de cada estilo (ou 1 só)</b></h1>
<p>Isto é só o PALCO. Os jogadores, a aura pixelada na cor do time, as chapas de nome,
o escudo e o título entram por cima na composição. Repara: o gol na base, o círculo
central no meio, e o terço de cima escurecendo para o cabeçalho.</p>
${Object.keys(ESTILOS).map((e) => `<div class="grupo"><div class="rot">${e}</div><div class="fila">
${linhas.filter((l) => l.estilo === e).map((l) => `<div class="cel"><img src="${l.fich}"><div class="meta">${l.fich}</div></div>`).join('')}
</div></div>`).join('\n')}`;
  fs.writeFileSync(path.join(SAIDA, 'index.html'), html);
  console.log(`\nHTML: ${path.join(SAIDA, 'index.html')}\n`);
})();
