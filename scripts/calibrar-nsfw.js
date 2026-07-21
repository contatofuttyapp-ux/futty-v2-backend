// CALIBRAÇÃO (experimental, fora das rotas) — Tijolo 2.
// Corre o filtro contra uma bateria LIMPA (fotos reais da casa + proxies sintéticos
// dos casos-limite do futebol amador). Mede porn/hentai/sexy e ajuda a fixar o
// limiar com margem. ZERO download de conteúdo explícito.
//   node scripts/calibrar-nsfw.js
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const tf = require('@tensorflow/tfjs');
const nsfw = require('nsfwjs');

const B = path.join(__dirname, '..', 'public');

// ── Reais da casa (legítimas — celebração/abraço/campeão/jogo) ──
const REAIS = [
  ['jogo — grupo em campo', 'fotos-jogos/03.05.2026.jpeg'],
  ['jogo — grupo em campo', 'fotos-jogos/05.04.2026.jpeg'],
  ['jogo — grupo em campo', 'fotos-jogos/12.04.2026.jpeg'],
  ['jogo — grupo em campo', 'fotos-jogos/23.04.2026.jpeg'],
  ['jogo — grupo em campo', 'fotos-jogos/26.04.2026.jpeg'],
  ['campeão — celebração colada', 'uploads/champ_1.png'],
  ['campeão — celebração colada', 'uploads/champ_2.png'],
  ['campeão — celebração colada', 'uploads/champ_3.png'],
  ['campeão — celebração colada', 'uploads/champ_4.png'],
  ['campeão — celebração colada', 'uploads/champ_5.png'],
  ['campeão — celebração colada', 'uploads/champ_6.png'],
];

// ── Proxies sintéticos (NÃO fotorrealistas — stress direcional dos extremos) ──
async function proxies() {
  const W = 224, H = 224, out = [];
  const raw = (fn) => { const b = Buffer.alloc(W * H * 3); for (let i = 0; i < W * H; i++) fn(b, i * 3, i % W, (i / W) | 0); return sharp(b, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer(); };
  // pele grande e clara (sem-camisa/toalha/praia)
  out.push(['proxy — pele grande (sem camisa/praia)', await raw((b, j) => { b[j] = 224; b[j + 1] = 172; b[j + 2] = 150; })]);
  // pele escura e granulada (foto escura/granulada)
  out.push(['proxy — escura/granulada', await raw((b, j) => { const n = (Math.sin(j) * 26) | 0; b[j] = 60 + n; b[j + 1] = 40 + n; b[j + 2] = 34 + n; })]);
  // pele com padrão escuro (tatuagens grandes)
  out.push(['proxy — tatuagem grande', await raw((b, j, x, y) => { const t = ((x + y) % 22 < 6) ? 0 : 1; b[j] = t ? 210 : 30; b[j + 1] = t ? 160 : 26; b[j + 2] = t ? 140 : 24; })]);
  // pastel claro (bebé da mascote — tom suave)
  out.push(['proxy — bebé/mascote (pastel)', await raw((b, j) => { b[j] = 245; b[j + 1] = 224; b[j + 2] = 214; })]);
  return out;
}

async function tensor(input) {
  const { data } = await sharp(input).flatten({ background: '#fff' }).resize(224, 224, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return tf.tensor3d(new Uint8Array(data), [224, 224, 3], 'int32');
}

(async () => {
  const model = await nsfw.load();
  const linhas = [];
  async function medir(rot, input) {
    const img = await tensor(input);
    try {
      const preds = await model.classify(img);
      const s = Object.fromEntries(preds.map((p) => [p.className, p.probability]));
      linhas.push({ rot, porn: s.Porn || 0, hentai: s.Hentai || 0, sexy: s.Sexy || 0, neutral: s.Neutral || 0, drawing: s.Drawing || 0 });
    } finally { img.dispose(); }
  }

  for (const [rot, rel] of REAIS) { const p = path.join(B, rel); if (fs.existsSync(p)) await medir(rot, p); }
  for (const [rot, buf] of await proxies()) await medir(rot, buf);

  // Tabela
  const f = (n) => n.toFixed(3);
  console.log('\nCENÁRIO'.padEnd(38), 'PORN  HENTAI  SEXY   NEUTRAL DRAWING  explícito');
  for (const l of linhas) {
    const ex = Math.max(l.porn, l.hentai);
    console.log(l.rot.padEnd(38), f(l.porn), f(l.hentai), f(l.sexy), ' ', f(l.neutral), f(l.drawing), ' →', f(ex));
  }
  const maxPorn = Math.max(...linhas.map((l) => l.porn));
  const maxHentai = Math.max(...linhas.map((l) => l.hentai));
  const maxExpl = Math.max(...linhas.map((l) => Math.max(l.porn, l.hentai)));
  const maxSexy = Math.max(...linhas.map((l) => l.sexy));
  console.log('\n── AGREGADOS (bateria legítima) ──');
  console.log(`max PORN     = ${f(maxPorn)}`);
  console.log(`max HENTAI   = ${f(maxHentai)}`);
  console.log(`max explícito= ${f(maxExpl)}  (= max(porn,hentai))`);
  console.log(`max SEXY     = ${f(maxSexy)}  (NÃO bloqueia — sem-camisa/praia vivem aqui)`);
  for (const lim of [0.6, 0.7, 0.8, 0.85, 0.9]) {
    const fp = linhas.filter((l) => Math.max(l.porn, l.hentai) > lim).length;
    console.log(`limiar ${lim}: ${fp} falso(s) positivo(s) na bateria legítima`);
  }
})();
