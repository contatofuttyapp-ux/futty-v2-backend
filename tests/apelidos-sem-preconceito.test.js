// Futty — Rodada 30D: trava para apelido pejorativo (aparência/origem/cor/etnia) nunca mais voltar a
// aparecer em scripts/demo-loja.js, scripts/loja/* ou src/ (regra do dono: "nenhum apelido pejorativo em
// lugar nenhum — app, demo, prints, redes").
//
// O teste varre o texto do arquivo DEPOIS de tirar os comentários (// e /* */): um comentário histórico
// que explica uma decisão já tomada (datas, nomes de rodada) fica de fora de propósito — só o que ainda
// está vivo em dado ou string reprova.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const relativo = (p) => path.relative(RAIZ, p).split(path.sep).join('/');

const APELIDOS_BANIDOS = [
  'gordo', 'gordinho', 'careca', 'cabeção', 'gaúcho', 'tiãozinho', 'índio', 'nego', 'neguinho',
  'pretinho', 'japa', 'alemão', 'baixinho', 'magrelo', 'perna de pau',
];
const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const normalizar = (s) => semAcento(String(s)).toLowerCase();

function arquivosDeFonte(dir, saida = []) {
  if (!fs.existsSync(dir)) return saida;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) arquivosDeFonte(p, saida);
    else if (/\.(jsx?|mjs|cjs)$/.test(e.name)) saida.push(p);
  }
  return saida;
}

// scripts/loja e src não existem neste repo (vivem no frontend) — entram só se um dia existirem aqui também.
const RAIZES = [
  path.join(RAIZ, 'scripts', 'demo-loja.js'),
  path.join(RAIZ, 'scripts', 'loja'),
  path.join(RAIZ, 'src'),
];
const fontes = RAIZES.flatMap((raiz) => {
  if (!fs.existsSync(raiz)) return [];
  return fs.statSync(raiz).isDirectory() ? arquivosDeFonte(raiz) : [raiz];
});

// Tira comentário de bloco e de linha, preservando "://" (http://, https://) — comentário de histórico
// que só explica uma decisão já tomada não deve reprovar o teste. Tira também o `slug:` do jogador: é
// o identificador INTERNO da conta (vira e-mail demo-loja-<slug>@futtymock.com), nunca aparece em
// tela nem em texto nenhum, e fica para sempre com o apelido ORIGINAL por decisão do dono — trocá-lo
// criaria uma conta nova (e-mail novo), que é exatamente o que a Rodada 30D pediu para NÃO fazer.
function semComentarios(txt) {
  return txt
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/slug:\s*'[^']*'/g, "slug: ''");
}

test(`nenhum apelido pejorativo (${APELIDOS_BANIDOS.join(', ')}) em scripts/demo-loja.js, scripts/loja/* ou src/ — fora de comentário histórico`, () => {
  assert.ok(fontes.length >= 1, `varredura vazia (${fontes.length} arquivo(s)) — confira os caminhos`);
  const achados = [];
  for (const p of fontes) {
    const alvo = normalizar(semComentarios(fs.readFileSync(p, 'utf8')));
    for (const banido of APELIDOS_BANIDOS) {
      if (alvo.includes(normalizar(banido))) achados.push(`${relativo(p)}: "${banido}"`);
    }
  }
  assert.deepEqual(achados, [], `Apelido pejorativo encontrado fora de comentário histórico:\n${achados.join('\n')}`);
});
