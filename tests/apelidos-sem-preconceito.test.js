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
// que só explica uma decisão já tomada não deve reprovar o teste. O `slug:` do jogador NÃO é tirado: ele vira o
// e-mail da conta (demo-loja-<slug>@futtymock.com) e o e-mail aparece na folha do membro, que o admin (o revisor da
// loja) abre — então o slug também tem de ser limpo.
function semComentarios(txt) {
  return txt
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
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

// ─── Os outros seeds (time de teste, radar, demo completa) ──────────────────────────────────────────────────────────────────
// Mesmas contas fictícias @futtymock.com, mesmos membros que um admin vê: nenhum apelido de aparência, peso, cor, etnia ou origem.
// Aqui a conta é por PALAVRA INTEIRA e só na forma de apelido (Maiúscula inicial, sem acento): "Boca" ou "Português" no meio de
// uma frase em minúscula, ou `cabeca_chave` (cabeça de chave), não são apelido. O slug é conferido à parte, em minúscula.
const OUTROS_SEEDS = ['time-teste.js', 'radar-teste.js', 'demo-completa.js'].map((n) => path.join(RAIZ, 'scripts', n));
const APELIDOS_DE_APARENCIA_E_ORIGEM = [
  'Magrão', 'Magrelo', 'Pezão', 'Pezinho', 'Baixinho', 'Gordinho', 'Gordo', 'Bigode', 'Careca', 'Cabeção', 'Caveira', 'Fininho',
  'Beiçola', 'Dentinho', 'Mãozinha', 'Perninha', 'Pintado', 'Bola Murcha', 'Boca', 'Neguinho', 'Nego', 'Pretinho', 'Índio',
  'Japa', 'Alemão', 'Alemãozinho', 'Russo', 'Português', 'Baiano', 'Mineirinho', 'Goiano', 'Maranhão', 'Gaúcho', 'Tchê',
];
const SLUGS_BANIDOS = [
  'magrao', 'pezao', 'baixinho', 'gordinho', 'bigode', 'careca', 'cabecao', 'neguinho', 'nego-di', 'indio', 'alemao', 'russo',
  'portugues', 'baiano', 'tche', 'ze-gordo', 'tiaozinho', 'paulinho-gaucho',
];

test('nenhum apelido de aparência, cor, etnia ou origem (nem no slug) em time-teste.js, radar-teste.js e demo-completa.js', () => {
  const achados = [];
  for (const p of OUTROS_SEEDS) {
    assert.ok(fs.existsSync(p), `seed não encontrado: ${p}`);
    const texto = semAcento(semComentarios(fs.readFileSync(p, 'utf8')));
    for (const apelido of APELIDOS_DE_APARENCIA_E_ORIGEM) {
      if (new RegExp(`\\b${semAcento(apelido)}\\b`).test(texto)) achados.push(`${relativo(p)}: apelido "${apelido}"`);
    }
    for (const slug of SLUGS_BANIDOS) {
      if (texto.includes(`slug: '${slug}'`)) achados.push(`${relativo(p)}: slug "${slug}"`);
    }
  }
  assert.deepEqual(achados, [], `Apelido de aparência/origem encontrado fora de comentário:\n${achados.join('\n')}`);
});

test('a varredura dos outros seeds pega de verdade (um apelido banido num texto de mentira reprova)', () => {
  const texto = semAcento("{ slug: 'magrao', apelido: 'Magrão' }, 'Cabeça', cabeca_chave, boca de siri");
  assert.ok(new RegExp(`\\b${semAcento('Magrão')}\\b`).test(texto));
  assert.ok(texto.includes("slug: 'magrao'"));
  // cabeça de chave e a palavra "boca" em minúscula não são apelido
  assert.ok(!new RegExp(`\\b${semAcento('Boca')}\\b`).test(texto));
});
