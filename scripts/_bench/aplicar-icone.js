// ═══════════════════════════════════════════════════════════════════════════════
// APLICA O ÍCONE DO iPHONE — variante 2 "ouro vivo + aro" da bancada
// (scripts/_bench/testar-icone.js, commit e2914ab). Reusa as MESMAS funções da
// bancada (require, não cópia).
//
// RODADA 29X (5-out): este script grava SÓ o ícone do iPhone, e só com --so-ios.
// Até a 29W ele também gravava o Android e o site — e a variante 2 tem o ANEL
// dourado, que o dono mandou tirar de todo lugar menos da moldura fina do iPhone
// ("um ícone só, o ouro vivo, sem anel": 5-out). Rodá-lo sem opção devolvia o
// anel ao Android e ao site. Agora, de onde sai cada ícone:
//
//   iPhone    ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
//             — ESTE script, com --so-ios: 1024, sem alpha, ouro vivo + a moldura
//             fina nos cantos (o iOS aplica a máscara de cantos sozinho). Contents.json
//             já é "universal" 1024×1024 — não muda.
//   Android   mipmap-*/ic_launcher(_background|_foreground|_monochrome|_round).png
//   site      public/icons/icon-192.png e icon-512.png
//             — frontend/scripts/gerar-icones.mjs: a vinheta SEM aro + o F, composição.
//   splash    Splash.imageset, drawable*/splash_logo.png e frontend/assets/
//             — frontend/scripts/gerar-splash.mjs: o F ouro vivo sobre #080808 sólido.
//
// Sem IA, sem imagem baixada — tudo SVG via sharp/librsvg, como a bancada.
//
//   node scripts/_bench/aplicar-icone.js --so-ios
// ═══════════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { FRONT, svgIOS, VARIANTES } = require('./testar-icone');

const VARIANTE = VARIANTES.find((v) => v.id === 2); // "ouro vivo + aro" — a moldura fina do iPhone
const IOS_ICONSET = path.join(FRONT, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');

const MENSAGEM_SEM_OPCAO = `[aplicar-icone] nada foi gravado.
Este script grava SÓ o ícone do iPhone, e só com --so-ios:
    node scripts/_bench/aplicar-icone.js --so-ios
De onde sai cada ícone do app (desde a Rodada 29W/29X):
  · iPhone  (AppIcon-512@2x.png) ........ este script, com --so-ios (ouro vivo + a moldura fina nos cantos)
  · Android (mipmap-*) e site (public/icons/icon-192/512) .. frontend/scripts/gerar-icones.mjs
  · splash (Splash.imageset, drawable*/splash_logo.png, assets/) .. frontend/scripts/gerar-splash.mjs
Até a 29W este script também gravava o Android e o site, com o ANEL dourado da variante 2: o dono mandou tirar o anel (5-out).`;

/**
 * Grava o ícone do iPhone (e SÓ ele) na pasta `destino` — por omissão, o AppIcon.appiconset do frontend. Devolve o caminho gravado.
 * `destino` existe para o teste gravar numa pasta de mentira; o Contents.json do destino só é lido, nunca escrito.
 */
async function gravarIOS(destino = IOS_ICONSET) {
  const iosBuf = await sharp(Buffer.from(svgIOS(VARIANTE))).removeAlpha().png().toBuffer();
  const arquivo = path.join(destino, 'AppIcon-512@2x.png');
  fs.mkdirSync(destino, { recursive: true });
  fs.writeFileSync(arquivo, iosBuf);
  const contentsPath = path.join(destino, 'Contents.json');
  if (fs.existsSync(contentsPath)) {
    const contents = JSON.parse(fs.readFileSync(contentsPath, 'utf8'));
    const okContents = contents.images?.length === 1 && contents.images[0].size === '1024x1024' && contents.images[0].filename === 'AppIcon-512@2x.png';
    console.log(`[aplicar-icone] iOS Contents.json ${okContents ? 'coerente, sem mudança' : 'ATENÇÃO: formato mudou — conferir à mão'}`);
  }
  return arquivo;
}

async function main(argv) {
  if (!argv.includes('--so-ios')) {
    console.error(MENSAGEM_SEM_OPCAO);
    return 2;
  }
  console.log(`[aplicar-icone] variante ${VARIANTE.id} "${VARIANTE.nome}" — só o ícone do iPhone`);
  const gravado = await gravarIOS();
  console.log(`[aplicar-icone] gravado: ${path.relative(FRONT, gravado)}`);
  return 0;
}

module.exports = { main, gravarIOS, MENSAGEM_SEM_OPCAO, IOS_ICONSET };

if (require.main === module) {
  main(process.argv.slice(2)).then((codigo) => { process.exitCode = codigo; }).catch((e) => {
    console.error('[aplicar-icone] falhou:', e.message);
    process.exit(1);
  });
}
