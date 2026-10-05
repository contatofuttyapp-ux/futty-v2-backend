// Futty v2.0 — RODADA 29X: o aplicar-icone.js só grava o ícone do iPhone (sem banco, sem rede).
//
// Até a 29W o script também gravava o Android e o site com a variante 2 da bancada — a que tem o ANEL dourado. O dono mandou tirar o anel de todo lugar
// menos da moldura fina do iPhone (5-out), e quem faz o Android e o site agora é frontend/scripts/gerar-icones.mjs. Prova:
//   · sem --so-ios o script PARA (código 2), diz de onde sai cada ícone e não mexe em nada: o hash de tudo o que é ícone no frontend (Android, site,
//     iPhone, splash, assets/) é o mesmo antes e depois;
//   · com --so-ios, o ÚNICO caminho que ele escreve (writeFileSync/mkdirSync/copyFileSync…, espiados) é AppIcon-512@2x.png do iPhone;
//   · gravarIOS(pasta) grava só esse arquivo (1024×1024, sem alfa) e é idêntico ao que está no repositório;
//   · o código não cita mais Android nem site fora de comentário.
//
// Uso: npm test  (ou: node --test tests/aplicar-icone.test.js). Precisa do frontend ao lado (a bancada lê o F dele); sem ele, o teste pula.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');

const SCRIPT = path.join(__dirname, '..', 'scripts', '_bench', 'aplicar-icone.js');
const FRONT = path.join(__dirname, '..', '..', 'frontend');
const TEM_FRONTEND = fs.existsSync(path.join(FRONT, 'src', 'utils', 'futtyMonograma.js'));
const IOS_ICONSET = path.join(FRONT, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');
const ICONE_IOS = path.join(IOS_ICONSET, 'AppIcon-512@2x.png');

// Todo arquivo que é ícone ou splash no frontend: hash de cada um.
function fotografar() {
  const pastas = [
    path.join(FRONT, 'android', 'app', 'src', 'main', 'res'),
    path.join(FRONT, 'ios', 'App', 'App', 'Assets.xcassets'),
    path.join(FRONT, 'public', 'icons'),
    path.join(FRONT, 'assets'),
  ];
  const foto = {};
  const andar = (pasta) => {
    for (const e of fs.readdirSync(pasta, { withFileTypes: true })) {
      const p = path.join(pasta, e.name);
      if (e.isDirectory()) andar(p);
      else foto[path.relative(FRONT, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  for (const p of pastas) andar(p);
  return foto;
}
const semComentarios = (texto) => texto.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

test('29X · aplicar-icone.js sem --so-ios para com a mensagem de onde sai cada ícone, e não grava NADA', { skip: !TEM_FRONTEND && 'sem o frontend ao lado' }, () => {
  const antes = fotografar();
  assert.ok(Object.keys(antes).length > 40, 'a foto pegou os ícones do Android, do site, do iPhone e do splash');
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 2, 'sem a opção, o código de saída é 2 (não é sucesso)');
  const saida = `${r.stdout}${r.stderr}`;
  assert.match(saida, /nada foi gravado/);
  assert.match(saida, /--so-ios/, 'diz a opção que grava o iPhone');
  assert.match(saida, /AppIcon-512@2x\.png/, 'diz que o iPhone sai daqui');
  assert.match(saida, /frontend\/scripts\/gerar-icones\.mjs/, 'diz que Android e site saem do gerar-icones.mjs');
  assert.match(saida, /frontend\/scripts\/gerar-splash\.mjs/, 'diz que o splash sai do gerar-splash.mjs');
  assert.deepEqual(fotografar(), antes, 'nenhum ícone do app mudou');
});

test('29X · com --so-ios, o único caminho que o script escreve é o AppIcon-512@2x.png do iPhone', { skip: !TEM_FRONTEND && 'sem o frontend ao lado' }, async () => {
  const { main } = require(SCRIPT);
  const escritos = [];
  const originais = {};
  // Espia tudo o que escreve ou cria no disco. Nada é gravado de verdade (o iPhone, aliás, sairia byte a byte igual).
  for (const nome of ['writeFileSync', 'appendFileSync', 'copyFileSync', 'renameSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'createWriteStream']) {
    originais[nome] = fs[nome];
    fs[nome] = (destino) => { escritos.push({ nome, destino: path.resolve(String(destino)) }); };
  }
  const log = console.log;
  console.log = () => {};
  let codigo;
  try {
    codigo = await main(['--so-ios']);
  } finally {
    console.log = log;
    for (const [nome, fn] of Object.entries(originais)) fs[nome] = fn;
  }
  assert.equal(codigo, 0);
  const gravacoes = escritos.filter((e) => e.nome === 'writeFileSync');
  assert.deepEqual(gravacoes.map((e) => e.destino), [path.resolve(ICONE_IOS)], 'grava UM arquivo: o ícone do iPhone');
  for (const e of escritos) assert.ok(e.destino.startsWith(path.resolve(IOS_ICONSET)), `${e.nome} fora da pasta do ícone do iPhone: ${e.destino}`);
});

test('29X · gravarIOS(pasta) grava só o ícone do iPhone: 1024×1024, sem alfa, idêntico ao do repositório', { skip: !TEM_FRONTEND && 'sem o frontend ao lado' }, async () => {
  const { gravarIOS } = require(SCRIPT);
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'futty-ios-'));
  const log = console.log;
  console.log = () => {};
  try {
    const arquivo = await gravarIOS(pasta);
    assert.deepEqual(fs.readdirSync(pasta), ['AppIcon-512@2x.png']);
    const meta = await sharp(arquivo).metadata();
    assert.equal(`${meta.width}x${meta.height}`, '1024x1024');
    assert.equal(meta.hasAlpha, false, 'a App Store recusa ícone com canal alfa');
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(arquivo)).digest('hex'),
      crypto.createHash('sha256').update(fs.readFileSync(ICONE_IOS)).digest('hex'),
      'o script ainda reproduz o ícone do iPhone que está no repositório',
    );
  } finally {
    console.log = log;
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});

test('29X · o código do aplicar-icone.js não cita mais Android nem site (fora de comentário)', () => {
  const codigo = semComentarios(fs.readFileSync(SCRIPT, 'utf8'));
  for (const proibido of [/mipmap/i, /ANDROID/, /WEB_ICONS/, /public['"\s,]+icons/, /icon-(192|512)/, /ic_launcher/, /monochrome/i, /ic_launcher_background/]) {
    assert.doesNotMatch(codigo.replace(/MENSAGEM_SEM_OPCAO = `[\s\S]*?`;/, ''), proibido, `o código ainda cita ${proibido}`);
  }
  assert.equal((codigo.match(/writeFileSync/g) || []).length, 1, 'um só ponto de gravação');
});
