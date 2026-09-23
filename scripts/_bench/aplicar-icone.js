// ═══════════════════════════════════════════════════════════════════════════════
// APLICA O ÍCONE ESCOLHIDO — variante 2 "ouro vivo + aro" da bancada
// (scripts/_bench/testar-icone.js, commit e2914ab). Grava os arquivos reais em
// iOS, Android e web. Reusa as MESMAS funções da bancada (require, não cópia).
//
// Fundo unificado nas três plataformas: vinheta #0b0a12 → #1a1826 (a mesma
// função `fundoVinheta`). Antes, iOS usava #0d0d12 chapado e Android #050810.
//
//   iOS      Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png — 1024,
//            sem alpha. Contents.json já é "universal" 1024×1024 (Xcode
//            14+/single-size) — não muda.
//   Android  adaptive icon nas 5 densidades: `background` (NOVO — antes era
//            @color chapado, agora é a vinheta+aro em PNG, um mipmap a mais),
//            `foreground` (só F+brilho, transparente), `monochrome` (só o F,
//            branco sólido, sem brilho — é só a forma, o Android tinge
//            sozinho). Os `ic_launcher(_round).png` legados (API<26, sem
//            máscara adaptativa) são o background+foreground desta bancada já
//            achatados num quadrado (ou círculo). `ic_launcher.xml` e
//            `ic_launcher_round.xml` passam a apontar o background para o
//            novo mipmap em vez do @color.
//   web      public/icons/icon-192.png e icon-512.png — purpose "any
//            maskable" no manifest.json, por isso levam o MESMO tratamento
//            seguro do Android (F dentro do círculo de 66/108 = 61,1% do
//            lado) achatado num quadrado cheio — sobrevive a qualquer recorte
//            que o SO aplique. Favicon fica de fora: é `favicon.svg`
//            (vetorial, tratamento próprio já aprovado), não um raster.
//
// Sem IA, sem imagem baixada — tudo SVG via sharp/librsvg, como a bancada.
//
//   node scripts/_bench/aplicar-icone.js
// ═══════════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const {
  FRONT, SIZE, F, transformF,
  svgIOS, svgAndroidBackground, svgAndroidForeground, VARIANTES,
} = require('./testar-icone');

const VARIANTE = VARIANTES.find((v) => v.id === 2); // "ouro vivo + aro"
const ANDROID_RES = path.join(FRONT, 'android', 'app', 'src', 'main', 'res');
const IOS_ICONSET = path.join(FRONT, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');
const WEB_ICONS = path.join(FRONT, 'public', 'icons');

// legacy = ícone pré-Android 8 (sem máscara do SO); adaptive = canvas de 108 dp
// das camadas background/foreground/monochrome.
const DENSIDADES = [
  { pasta: 'mipmap-mdpi', legacy: 48, adaptive: 108 },
  { pasta: 'mipmap-hdpi', legacy: 72, adaptive: 162 },
  { pasta: 'mipmap-xhdpi', legacy: 96, adaptive: 216 },
  { pasta: 'mipmap-xxhdpi', legacy: 144, adaptive: 324 },
  { pasta: 'mipmap-xxxhdpi', legacy: 192, adaptive: 432 },
];

/** Só o F, branco sólido, sem brilho nem gradiente — o monochrome é só forma. */
function svgMonocromo(altura) {
  const { transform } = transformF(SIZE / 2, SIZE / 2, altura);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <g transform="${transform}"><path d="${F}" fill="#ffffff"/></g>
</svg>`;
}

async function circulo1024(buf) {
  const mascara = await sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2}" fill="#fff"/></svg>`,
  )).png().toBuffer();
  return sharp(buf).ensureAlpha().composite([{ input: mascara, blend: 'dest-in' }]).png().toBuffer();
}

async function gravar(caminho, buf) {
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, buf);
  return caminho;
}

async function main() {
  console.log(`[aplicar-icone] variante ${VARIANTE.id} "${VARIANTE.nome}" — fundo unificado, iOS + Android (5 densidades) + web`);
  const gravados = [];

  // ── 1. Mestres em 1024 (uma vez cada; tudo abaixo é resize/composite) ──
  const iosBuf = await sharp(Buffer.from(svgIOS(VARIANTE))).removeAlpha().png().toBuffer();
  const androidBgBuf = await sharp(Buffer.from(svgAndroidBackground(VARIANTE))).removeAlpha().png().toBuffer();
  const fg = svgAndroidForeground(VARIANTE);
  const androidFgBuf = await sharp(Buffer.from(fg.svg)).png().toBuffer();
  const monoBuf = await sharp(Buffer.from(svgMonocromo(fg.altura))).png().toBuffer();
  console.log(`[aplicar-icone] Android: ${fg.nota}`);

  // Achatado (background + foreground compostos) — serve de base tanto para
  // os ic_launcher(_round) legados do Android quanto para o ícone web
  // maskable, que precisa do MESMO respiro seguro.
  const achatado1024 = await sharp(androidBgBuf).composite([{ input: androidFgBuf }]).png().toBuffer();
  const achatadoRedondo1024 = await circulo1024(achatado1024);

  // ── 2. iOS ──
  gravados.push(await gravar(path.join(IOS_ICONSET, 'AppIcon-512@2x.png'), iosBuf));
  const contents = JSON.parse(fs.readFileSync(path.join(IOS_ICONSET, 'Contents.json'), 'utf8'));
  const okContents = contents.images?.length === 1 && contents.images[0].size === '1024x1024' && contents.images[0].filename === 'AppIcon-512@2x.png';
  console.log(`[aplicar-icone] iOS Contents.json ${okContents ? 'coerente, sem mudança' : 'ATENÇÃO: formato mudou — conferir à mão'}`);

  // ── 3. Android, por densidade ──
  for (const d of DENSIDADES) {
    const pasta = path.join(ANDROID_RES, d.pasta);
    const resize = (buf, tam) => sharp(buf).resize(tam, tam, { kernel: 'lanczos3' }).png().toBuffer();

    gravados.push(await gravar(path.join(pasta, 'ic_launcher_background.png'), await resize(androidBgBuf, d.adaptive)));
    gravados.push(await gravar(path.join(pasta, 'ic_launcher_foreground.png'), await resize(androidFgBuf, d.adaptive)));
    gravados.push(await gravar(path.join(pasta, 'ic_launcher_monochrome.png'), await resize(monoBuf, d.adaptive)));
    gravados.push(await gravar(path.join(pasta, 'ic_launcher.png'), await resize(achatado1024, d.legacy)));
    gravados.push(await gravar(path.join(pasta, 'ic_launcher_round.png'), await resize(achatadoRedondo1024, d.legacy)));
  }

  // XML adaptativo: o background deixa de ser @color (chapado) e passa a
  // apontar para o mipmap novo (a arte com a vinheta e o aro). Idempotente —
  // uma 2ª corrida (já trocado) não é erro, é o estado que se quer.
  for (const nome of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    const p = path.join(ANDROID_RES, 'mipmap-anydpi-v26', nome);
    const antes = fs.readFileSync(p, 'utf8');
    if (antes.includes('android:drawable="@mipmap/ic_launcher_background"')) {
      gravados.push(p); // já estava certo
      continue;
    }
    const depois = antes.replace('android:drawable="@color/ic_launcher_background"', 'android:drawable="@mipmap/ic_launcher_background"');
    if (depois === antes) throw new Error(`${nome}: não achei nem @color nem @mipmap de ic_launcher_background — conferir à mão.`);
    fs.writeFileSync(p, depois);
    gravados.push(p);
  }
  // A cor fica como registo (não é mais o que desenha o ícone, mas pode ter
  // outro leitor) — atualizada para a mesma vinheta, não deixada a apontar
  // para o azul antigo (#050810) que já não é verdade. Vai pelo <color
  // name="ic_launcher_background">, não pelo primeiro hex do arquivo — a 1ª
  // tentativa pegou o hex de um COMENTÁRIO histórico acima do valor real.
  const corPath = path.join(ANDROID_RES, 'values', 'ic_launcher_background.xml');
  const corAntes = fs.readFileSync(corPath, 'utf8');
  const corRe = /(<color\s+name="ic_launcher_background"\s*>)\s*#[0-9a-fA-F]{6,8}\s*(<\/color>)/;
  if (!corRe.test(corAntes)) throw new Error('ic_launcher_background.xml: não achei a tag <color> para trocar — conferir à mão.');
  fs.writeFileSync(corPath, corAntes.replace(corRe, '$1#0b0a12$2')); // idempotente: já certo → regrava o mesmo valor
  gravados.push(corPath);

  // ── 4. Web (manifest: purpose "any maskable" — mesmo respiro do Android) ──
  // .flatten(): achatado1024 nasce de um composite() e carrega um canal alpha
  // 100% opaco à toa — remover encolhe o PNG sem mudar 1 pixel visível.
  const web192 = await sharp(achatado1024).flatten({ background: '#0b0a12' }).resize(192, 192, { kernel: 'lanczos3' }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  const web512 = await sharp(achatado1024).flatten({ background: '#0b0a12' }).resize(512, 512, { kernel: 'lanczos3' }).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  gravados.push(await gravar(path.join(WEB_ICONS, 'icon-192.png'), web192));
  gravados.push(await gravar(path.join(WEB_ICONS, 'icon-512.png'), web512));
  console.log('[aplicar-icone] favicon.svg é vetorial (tratamento próprio já aprovado) — não é raster, não mexi.');

  console.log(`\n[aplicar-icone] ${gravados.length} arquivo(s) gravado(s):`);
  for (const g of gravados) console.log(`  ${path.relative(FRONT, g)}`);
}

main().catch((e) => {
  console.error('[aplicar-icone] falhou:', e.message);
  process.exit(1);
});
