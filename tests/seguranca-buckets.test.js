// Futty v2.0 — SEGURANÇA · os buckets do Storage: os privados continuam privados, só `ads` é público, e todo link de mídia que sai do motor é
// assinado/temporário (o proxy /api/media/<token>), nunca o endereço público cru.
//
// Três provas, todas sem banco real e sem rede (tests/_appFalsa.js):
//   1. NASCER: as funções do motor que criam bucket, rodadas contra um Storage VAZIO (um projeto novo, como o "dia do dinheiro"), não deixam
//      nenhum bucket público — nem por um instante, nem o `resenha`, que só é criado no primeiro upload;
//   2. CÓDIGO: nenhum arquivo do motor (fora dos scripts) cria bucket com `public: true`, e `ads` só nasce no script da campanha;
//   3. SAIR: o que as rotas devolvem — feed, jogo, perfil, páginas públicas — não leva o endereço cru de `avatars`/`resenha`: autenticado vai
//      pelo proxy assinado (que expira), público vira "sem foto".
//
// Uso: node --test tests/seguranca-buckets.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { subirApp, URL_DO_BANCO } = require('./_appFalsa');
const { criarMundo, iso, HORA } = require('./_mundoDeSeguranca');

let app;
before(async () => { app = await subirApp(); });
after(() => app.fechar());

const RAIZ = path.join(__dirname, '..');
const publicos = () => [...app.storage.buckets].filter(([, b]) => b.public).map(([nome]) => nome);
const cru = (bucket, caminho) => `${URL_DO_BANCO}/storage/v1/object/public/${bucket}/${caminho}`;

// ─── 1. Nascer ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('um projeto novo (Storage vazio): todo bucket que o motor cria nasce PRIVADO — avatars, resenha (no 1º upload), campeonatos e denuncias', async () => {
  const m = criarMundo(app);
  app.storage.buckets.clear(); // o projeto novo: nenhum bucket ainda
  const { ensureAvatarsBucket } = require('../utils/db');
  const { ensureCampeonatosBucket } = require('../utils/campeonatoStore');
  const { ensureDenunciasBucket } = require('../utils/denunciaStore');
  await ensureAvatarsBucket();
  await ensureCampeonatosBucket();
  await ensureDenunciasBucket();
  // o `resenha` só nasce quando alguém sobe a primeira foto
  const foto = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#888' } }).png().toBuffer();
  const form = new FormData();
  form.append('file', new Blob([foto], { type: 'image/png' }), 'x.png');
  const subiu = await app.pedir('POST', '/api/feed/upload', { token: m.tok.memA, form });
  assert.equal(subiu.status, 201, subiu.texto);

  const nascidos = [...app.storage.buckets.keys()].sort();
  assert.deepEqual(nascidos, ['avatars', 'campeonatos', 'denuncias', 'resenha']);
  assert.deepEqual(publicos(), [], `buckets que nasceram públicos: ${publicos().join(', ')}`);
});

test('privatizarBuckets() fecha avatars e resenha mesmo que estivessem abertos (o arranque do motor roda isto)', async () => {
  criarMundo(app);
  app.storage.buckets.clear();
  for (const nome of ['avatars', 'resenha']) app.storage.buckets.set(nome, { public: true, arquivos: new Map() });
  app.storage.buckets.set('ads', { public: true, arquivos: new Map() });
  const { privatizarBuckets } = require('../utils/storage');
  await privatizarBuckets();
  assert.deepEqual(publicos(), ['ads'], 'só o `ads` fica público');
});

// ─── 2. O código ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function arquivosJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const completo = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : arquivosJs(completo);
    return e.name.endsWith('.js') ? [completo] : [];
  });
}

test('o código do motor (fora dos scripts) não cria bucket público; o `ads` público só nasce no script da campanha', () => {
  const doMotor = ['routes', 'utils', 'services', 'middleware'].flatMap((d) => arquivosJs(path.join(RAIZ, d))).concat(path.join(RAIZ, 'server.js'));
  const criacoes = [];
  for (const arquivo of doMotor) {
    const texto = fs.readFileSync(arquivo, 'utf8');
    for (const achado of texto.matchAll(/createBucket\(([^)]*)\)/g)) criacoes.push({ arquivo: path.relative(RAIZ, arquivo), chamada: achado[0] });
    // o bloco de opções pode vir na linha de baixo: olha as 3 linhas depois de cada createBucket
    const linhas = texto.split(/\r?\n/);
    linhas.forEach((linha, i) => {
      if (!linha.includes('createBucket(')) return;
      const janela = linhas.slice(i, i + 4).join(' ');
      assert.doesNotMatch(janela, /public:\s*true/, `${path.relative(RAIZ, arquivo)}:${i + 1} cria bucket PÚBLICO: ${linha.trim()}`);
    });
  }
  assert.ok(criacoes.length >= 4, `achei só ${criacoes.length} criações de bucket — o teste está olhando o lugar errado`);
  const adsNoMotor = doMotor.filter((a) => /['"]ads['"]/.test(fs.readFileSync(a, 'utf8')) && /createBucket/.test(fs.readFileSync(a, 'utf8')));
  assert.deepEqual(adsNoMotor, [], 'o motor não cria o bucket `ads`');
  const script = fs.readFileSync(path.join(RAIZ, 'scripts', 'criar-campanha-previa.js'), 'utf8');
  assert.match(script, /createBucket\(BUCKET, \{\s*public: true/, 'o bucket `ads` público é criado pelo script da campanha, de propósito (a arte do anúncio é pública)');
});

test('as funções que montam endereço de mídia: getPublicUrl só aparece onde o endereço é cru de propósito (e depois vira proxy na saída)', () => {
  const doMotor = ['routes', 'utils', 'services', 'middleware'].flatMap((d) => arquivosJs(path.join(RAIZ, d)));
  const usos = doMotor.filter((a) => /getPublicUrl\(/.test(fs.readFileSync(a, 'utf8'))).map((a) => path.relative(RAIZ, a).split(path.sep).join('/'));
  // quem grava o endereço cru no banco: o upload da foto, do logo, da Resenha e a figurinha — todos buckets privados, lidos só pelo proxy
  assert.deepEqual(usos.sort(), ['routes/auth.js', 'routes/feed.js', 'routes/teams.js']);
});

// ─── 3. Sair ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('o que as rotas devolvem não leva o endereço cru de avatars/resenha: autenticado vai pelo proxy assinado, a página pública vira "sem foto"', async () => {
  const m = criarMundo(app);
  const fotoDeAlice = cru('avatars', `public/${m.p.memA.id}-1.jpg`);
  const fotoDoPost = cru('resenha', `${m.p.memA.id}-aaaa.webp`);
  app.tabelas.users.find((u) => u.id === m.p.memA.id).avatar_url = fotoDeAlice;
  app.tabelas.users.find((u) => u.id === m.p.memA.id).foto_url = fotoDeAlice;
  app.tabelas.feed_post_media = [{ id: 'm1', post_id: m.ids.postA, url: fotoDoPost, media_type: 'image', position: 0 }];
  app.tabelas.teams.find((t) => t.id === m.A.id).logo_url = cru('avatars', `logos/${m.A.id}.png`);
  const jogo = app.tabelas.games.find((g) => g.id === m.ids.jogoPassadoA);
  jogo.times_resultado.times[1].jogadores[0].avatar_url = fotoDeAlice;

  const rotasComLogin = [
    ['GET', '/api/feed'], ['GET', '/api/me'], ['GET', '/api/inicio'], ['GET', `/api/teams/${m.A.slug}`], ['GET', `/api/teams/${m.A.slug}/membros`],
    ['GET', `/api/games/${m.ids.jogoPassadoA}`], ['GET', `/api/teams/${m.A.slug}/games`], ['GET', `/api/teams/${m.A.slug}/ranking`],
  ];
  for (const [metodo, rota] of rotasComLogin) {
    const r = await app.pedir(metodo, rota, { token: m.tok.admA });
    assert.ok(r.status < 500, `${rota} · ${r.status} ${r.texto.slice(0, 120)}`);
    assert.doesNotMatch(r.texto, /\/storage\/v1\/object\/public\/(avatars|resenha)\//, `${rota} devolveu o endereço público cru de um bucket privado`);
  }
  const feed = await app.pedir('GET', '/api/feed', { token: m.tok.memA });
  assert.match(feed.texto, /\/api\/media\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, 'a mídia do feed vai pelo proxy assinado');

  // as páginas públicas (sem login): nenhuma foto de bucket privado, nem pelo proxy
  for (const rota of [`/api/p/${m.ids.jogoPassadoA}`]) {
    const r = await app.pedir('GET', rota);
    assert.equal(r.status, 200, `${rota} · ${r.texto.slice(0, 120)}`);
    assert.doesNotMatch(r.texto, /\/storage\/v1\/object\/public\/(avatars|resenha)\//, `${rota} (pública) levou o endereço cru`);
    assert.doesNotMatch(r.texto, /\/api\/media\//, `${rota} (pública) levou um token do proxy`);
  }
});

test('o proxy de mídia: token forjado, vencido ou de outro bucket não serve nada; o certo serve a foto (e nunca o original sem passar pelo sharp)', async () => {
  const m = criarMundo(app);
  const { assinarToken } = require('../utils/mediaToken');
  const foto = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 50, b: 50 } } }).png().toBuffer();
  app.storage.buckets.get('resenha').arquivos.set('a.png', { corpo: foto, tipo: 'image/png', em: iso(-HORA) });
  app.storage.buckets.get('denuncias').arquivos.set('_gabinete/operacao.json', { corpo: Buffer.from('{"segredo":1}'), tipo: 'application/json', em: iso(-HORA) });

  const bom = await app.pedir('GET', `/api/media/${assinarToken('resenha', 'a.png')}`);
  assert.equal(bom.status, 200);
  assert.match(bom.cabecalhos.get('content-type'), /image\//);

  const [corpo, assinatura] = assinarToken('resenha', 'a.png').split('.');
  const forjados = {
    'sem assinatura': corpo,
    'assinatura trocada': `${corpo}.${assinatura.slice(0, -2)}xx`,
    'caminho trocado': `${Buffer.from(JSON.stringify({ b: 'resenha', p: 'outra.png', e: 4102444800 })).toString('base64url')}.${assinatura}`,
    'bucket trocado': `${Buffer.from(JSON.stringify({ b: 'denuncias', p: '_gabinete/operacao.json', e: 4102444800 })).toString('base64url')}.${assinatura}`,
    'lixo': 'a.b',
    'vencido': (() => {
      const crypto = require('node:crypto');
      const c = Buffer.from(JSON.stringify({ b: 'resenha', p: 'a.png', e: 1000 })).toString('base64url');
      return `${c}.${crypto.createHmac('sha256', process.env.MEDIA_TOKEN_SECRET).update(c).digest('base64url')}`;
    })(),
  };
  for (const [nome, token] of Object.entries(forjados)) {
    const r = await app.pedir('GET', `/api/media/${encodeURIComponent(token)}`);
    assert.equal(r.status, 403, `${nome} · ${r.status}`);
  }
  // o JSON do Gabinete (bucket denuncias) nunca sai por aqui: nem com token de verdade, o motor só assina avatars e resenha
  const { urlDoProxy } = require('../utils/storage');
  assert.match(urlDoProxy('http://x', { bucket: 'avatars', path: 'p.png', v: null }), /\/api\/media\//);
  assert.deepEqual(app.tentativasDeRede, []);
  void m;
});
