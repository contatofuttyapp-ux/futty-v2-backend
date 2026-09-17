// BANCADA — AVATAR GENÉRICO DA CASA (31-jul, ideia do dono).
// O jogador SEM ROSTO que veste o card de quem ainda não gerou avatar próprio:
// substitui as iniciais ("CH") e o texto "seu card espera por você" por um
// jogador de verdade, em grafite neutro (sem tom de pele), vestindo o manto
// Dark Gold com luz dourada de contorno. Um asset, gerado uma vez.
//
// Uso:   node scripts/_bench/gerar-avatar-generico.js          (3 candidatos)
//        node scripts/_bench/gerar-avatar-generico.js --publicar saida-generico/generico-c2.png
//
// Custo: 3 × ~$0,055 ≈ $0,17. Passa pela MESMA esteira da produção
// (birefnet → trim → extend → resize) para cair no card como um avatar normal.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const fal = require('@fal-ai/serverless-client');
const { supabase } = require('../../utils/db');

fal.config({ credentials: process.env.FAL_KEY });

const SAIDA = path.join(__dirname, 'saida-generico');
// --feminino (31-jul, dono): gera/publica a versão feminina — 3 masc + 3 fem no total.
const FEM = process.argv.includes('--feminino');
const prefixo = () => (FEM ? 'generico-f' : 'generico');
const KIT_URL = 'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/kits/kit1-dark-gold.png';
const FICHEIRO_FINAL = 'avatar-generico-dark-gold.png';

const PROMPT = `Image 1 is the official Futty Dark Gold jersey — the ground truth for the kit.

Create a FACELESS GENERIC SOCCER PLAYER for a trading-card placeholder:
- A completely featureless mannequin-like figure: smooth head with NO eyes, NO nose,
  NO mouth, NO ears — a clean neutral silhouette-person
- Matte dark graphite material (like #23262c), NOT a human skin tone of any kind
- Wearing EXACTLY the jersey from Image 1: deep black with the metallic gold diagonal
  panel, gold V-neck piping, gold cuff trim and the gold Futty badge — reproduce it faithfully
- Pose: arms crossed, confident, straight posture
- Subtle warm gold rim light along the head, shoulders and arms (premium card look)
- Bust framing: head to mid-chest, portrait 2:3, the figure in the BOTTOM 80% of the
  image, the TOP 20% completely empty above the head
- Clean semi-realistic digital painting, broad brushwork, crisp silhouette
- Background: perfectly flat mid-grey #8a8a8a (it will be removed afterwards)
- No text, no watermark, exactly one figure`;

(async () => {
  if (!process.env.FAL_KEY) { console.error('FAL_KEY em falta.'); process.exit(1); }

  // ---- publicar TODOS (decisão do dono, 31-jul: os 3 em rodízio para que
  //      vários jogadores sem foto no mesmo time não fiquem idênticos) ----
  if (process.argv.includes('--publicar-todos')) {
    for (let c = 1; c <= 3; c++) {
      const abs = path.join(SAIDA, `${prefixo()}-c${c}.png`);
      if (!fs.existsSync(abs)) { console.error(`Falta ${prefixo()}-c${c}.png — corre a geração primeiro.`); process.exit(1); }
      const nome = FEM ? `avatar-generico-f-${c}.png` : `avatar-generico-${c}.png`;
      const { error } = await supabase.storage.from('kits').upload(nome, fs.readFileSync(abs), { contentType: 'image/png', upsert: true });
      if (error) { console.error(`${nome} falhou:`, error.message); process.exit(1); }
      const { data: pub } = supabase.storage.from('kits').getPublicUrl(nome);
      console.log(`PUBLICADO: ${pub.publicUrl}`);
    }
    console.log('\nOs 3 genéricos no ar. Próximo passo (do Claude): rodízio nos empty states.\n');
    return;
  }

  // ---- publicar um só ----
  const iPub = process.argv.indexOf('--publicar');
  if (iPub > 0) {
    const fich = process.argv[iPub + 1];
    if (!fich) { console.error('Uso: --publicar <caminho-do-png>'); process.exit(1); }
    const abs = path.isAbsolute(fich) ? fich : path.join(__dirname, fich.replace(/^scripts[\\/]_bench[\\/]/, ''));
    if (!fs.existsSync(abs)) { console.error(`Não encontrado: ${abs}`); process.exit(1); }
    const { error } = await supabase.storage.from('kits').upload(FICHEIRO_FINAL, fs.readFileSync(abs), { contentType: 'image/png', upsert: true });
    if (error) { console.error('Upload falhou:', error.message); process.exit(1); }
    const { data: pub } = supabase.storage.from('kits').getPublicUrl(FICHEIRO_FINAL);
    console.log(`\nPUBLICADO: ${pub.publicUrl}`);
    console.log('Próximo passo (do Claude): trocar iniciais/texto pelos empty states com este asset.\n');
    return;
  }

  // ---- gerar 3 candidatos ----
  fs.mkdirSync(SAIDA, { recursive: true });
  console.log('\nAVATAR GENÉRICO — 3 candidatos (~$0,17)\n');
  const linhas = [];
  for (let c = 1; c <= 3; c++) {
    const t0 = Date.now();
    try {
      const r = await fal.subscribe('fal-ai/gpt-image-1.5/edit', {
        input: {
          prompt: PROMPT + (FEM
            ? '\n- FEMALE athletic build and silhouette; hair as one smooth tied-back shape (low bun), same matte graphite as the body — still completely faceless'
            : '\n- MALE athletic build; NO hair — smooth bald head'),
          image_urls: [KIT_URL], quality: 'medium', num_images: 1, image_size: '1024x1536',
        },
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
      const fich = `${prefixo()}-c${c}.png`;
      fs.writeFileSync(path.join(SAIDA, fich), final);
      linhas.push(fich);
      console.log(`OK candidato ${c}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } catch (e) {
      console.error(`FALHOU c${c}: ${e.message}`);
    }
  }

  const html = `<!doctype html><meta charset="utf-8"><title>Avatar genérico — candidatos</title>
<style>
 body{background:#0d0d12;color:#eee;font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px}
 h1{font-size:19px;margin:0 0 4px} h1 b{color:#d4a017} p{color:#888;margin:0 0 18px}
 .fila{display:flex;gap:14px;flex-wrap:wrap}
 .cel{background:#14141b;border:1px solid #24242e;border-radius:12px;padding:10px;text-align:center}
 .cel img{width:210px;display:block} .meta{font-size:12px;color:#999;margin-top:8px}
</style>
<h1>Avatar genérico — <b>escolhe 1</b></h1>
<p>Sem rosto, sem tom de pele, manto Dark Gold fiel, braços cruzados, luz dourada de contorno.
Diz ao Claude qual venceu (ex.: "generico c2").</p>
<div class="fila">${linhas.map((f) => `<div class="cel"><img src="${f}"><div class="meta">${f}</div></div>`).join('')}</div>`;
  fs.writeFileSync(path.join(SAIDA, 'index.html'), html);
  console.log(`\nHTML: ${path.join(SAIDA, 'index.html')}\n`);
})();
