// SPIKE (experimental, fora das rotas) — prova técnica do filtro NSFWJS.
// NÃO é usado pela app. Corre à mão: `node scripts/spike-nsfw.js`.
//
// Decodifica com sharp (já é dep) → tensor tfjs puro (sem build nativo tfjs-node).
// Objetivo: funciona em Node 24? tempo/imagem? tamanho do modelo? falsos positivos
// nas NOSSAS fotos? Para o lado "bloqueia explícito" geramos uma imagem de pele
// SINTÉTICA como proxy — confirmação real exige um benchmark que NÃO descarregamos.

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const tf = require('@tensorflow/tfjs');
const nsfw = require('nsfwjs');

const B = path.join(__dirname, '..', 'public');

// Fotos da casa (devem PASSAR — nada de Porn alto).
const NOSSAS = [
  path.join(B, 'fotos-jogos', '03.05.2026.jpeg'),
  path.join(B, 'fotos-jogos', '05.04.2026.jpeg'),
  path.join(B, 'uploads', 'champ_1.png'),
  path.join(B, 'avatares', 'azul', 'gabriel.png'),
];

async function toTensor(input) {
  // input: caminho de ficheiro OU Buffer. RGB 224x224 int32.
  const { data } = await sharp(input)
    .flatten({ background: '#ffffff' }) // remove alfa
    .resize(224, 224, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return tf.tensor3d(new Uint8Array(data), [224, 224, 3], 'int32');
}

async function skinBuffer() {
  // Proxy sintético: retângulo grande em tom de pele + ruído. NÃO é um benchmark
  // real — só verifica que o pipeline corre e dá scores plausíveis.
  const w = 224, h = 224;
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const j = i * 3;
    buf[j] = 220 + ((Math.sin(i) * 12) | 0);       // R
    buf[j + 1] = 170 + ((Math.cos(i) * 10) | 0);   // G
    buf[j + 2] = 150 + ((Math.sin(i / 2) * 8) | 0);// B
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

function topScore(preds) {
  return preds.reduce((a, b) => (b.probability > a.probability ? b : a));
}

(async () => {
  console.log('Node', process.version, '· tfjs', tf.version.tfjs);
  const t0 = Date.now();
  let model;
  try {
    model = await nsfw.load(); // modelo default (MobileNetV2 224, quantizado) via CDN
  } catch (e) {
    console.error('FALHOU a carregar o modelo:', e.message);
    console.error('(tfjs puro em Node pode não ter io http; ver relatório do spike.)');
    process.exit(1);
  }
  console.log(`Modelo carregado em ${Date.now() - t0} ms\n`);

  async function classificar(nome, input) {
    const img = await toTensor(input);
    const t = Date.now();
    const preds = await model.classify(img);
    const ms = Date.now() - t;
    img.dispose();
    const top = topScore(preds);
    const porn = preds.find((p) => p.className === 'Porn')?.probability || 0;
    const hentai = preds.find((p) => p.className === 'Hentai')?.probability || 0;
    const sexy = preds.find((p) => p.className === 'Sexy')?.probability || 0;
    const explicito = Math.max(porn, hentai); // regra da SPEC: bloqueia > ~0.85
    console.log(
      `${nome.padEnd(26)} top=${top.className}(${top.probability.toFixed(2)}) ` +
      `porn=${porn.toFixed(2)} hentai=${hentai.toFixed(2)} sexy=${sexy.toFixed(2)} ` +
      `→ ${explicito > 0.85 ? 'BLOQUEIA' : 'passa'}  [${ms}ms]`
    );
    return ms;
  }

  console.log('— NOSSAS FOTOS (esperado: passa) —');
  const tempos = [];
  for (const p of NOSSAS) {
    if (!fs.existsSync(p)) { console.log(`(falta ${path.basename(p)})`); continue; }
    tempos.push(await classificar(path.basename(p), p));
  }

  console.log('\n— PELE SINTÉTICA (proxy, NÃO benchmark real) —');
  tempos.push(await classificar('pele-sintetica.png', await skinBuffer()));

  // Benchmark real opcional: qualquer ficheiro em scripts/_bench/ (gitignored).
  const benchDir = path.join(__dirname, '_bench');
  if (fs.existsSync(benchDir)) {
    console.log('\n— BENCHMARK REAL (scripts/_bench/, gitignored) —');
    for (const f of fs.readdirSync(benchDir)) {
      await classificar(f, path.join(benchDir, f));
    }
  } else {
    console.log('\n(sem scripts/_bench/ — larga aí 1-2 imagens de benchmark p/ confirmar o BLOQUEIA)');
  }

  const media = tempos.reduce((a, b) => a + b, 0) / tempos.length;
  console.log(`\nTempo médio de inferência: ${media.toFixed(0)} ms/imagem`);
})();
