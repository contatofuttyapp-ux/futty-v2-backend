// Futty v2.0 — RODADA 29B (bloco 3, E): o recorte da miniatura do avatar, de ponta a ponta no motor (sem banco, sem rede).
//
//   1. a janela quadrada: contas puras, na MESMA tabela de casos que o app prova (frontend/scripts/unidade/enquadro-recorte.test.mjs)
//      — o que a pessoa vê ao arrastar a miniatura no editor é, ao pixel, o que o proxy entrega;
//   2. o derivado de verdade (sharp): o quadrado sai da janela pedida, também numa foto com EXIF girado;
//   3. a chave do cache: sem recorte é exatamente a de sempre; com recorte é outra; sem `sq` o recorte não conta;
//   4. a URL do proxy leva `?rc=` só para o arquivo que tem recorte (e só no bucket de avatares);
//   5. o registro em memória: carrega do banco (em páginas), não desfaz a escrita recente, sobrevive a falha e à migração em falta;
//   6. as rotas PUT/DELETE /api/me/avatar/enquadro e o proxy /api/media com `rc`.
//
// Uso: npm test  (ou: node --test tests/recorte-avatar.test.js)
require('dotenv').config();
process.env.MEDIA_TOKEN_SECRET = process.env.MEDIA_TOKEN_SECRET || 'segredo-de-teste-do-recorte';
const crypto = require('node:crypto');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const sharp = require('sharp');
const { validarRecorte, janelaDoRecorte, paraParametro, deParametro, ESCALA_MAX } = require('../utils/recorteAvatar');
const recortes = require('../utils/recortesAvatar');
const { chaveDoDerivado, gerarDerivado, limparCache } = require('../utils/derivadosMidia');
const { proxificarPayload, urlDoProxy } = require('../utils/storage');
const { aplicarRostoPublico } = require('../utils/rostoPublico');
const { verificarToken } = require('../utils/mediaToken');
const { carregar, subir, injetar } = require('./_rotas');
const { criarSupabaseFalso } = require('./_supabaseFalso');

beforeEach(() => { recortes.limpar(); limparCache(); });

// ─── 1. a janela ──────────────────────────────────────────────────────────────
// ATENÇÃO: a mesma tabela vive em frontend/scripts/unidade/enquadro-recorte.test.mjs. Mexeu aqui, mexe lá.
const CASOS_DA_JANELA = [
  // [largura, altura, recorte, esperado]
  [800, 1200, { x: 0.5, y: 0.5, escala: 1 }, { left: 0, top: 200, lado: 800 }],
  [800, 1200, { x: 0.5, y: 0, escala: 1 }, { left: 0, top: 0, lado: 800 }], // o quadrado do topo (a regra da figurinha)
  [800, 1200, { x: 0.5, y: 1, escala: 1 }, { left: 0, top: 400, lado: 800 }],
  [800, 1200, { x: 0.5, y: 0.2, escala: 2 }, { left: 200, top: 40, lado: 400 }],
  [800, 1200, { x: 0, y: 0, escala: 3 }, { left: 0, top: 0, lado: 267 }],
  [800, 1200, { x: 1, y: 1, escala: 3 }, { left: 533, top: 933, lado: 267 }],
  [1200, 800, { x: 0.5, y: 0.5, escala: 1 }, { left: 200, top: 0, lado: 800 }],
  [500, 500, { x: 0.3, y: 0.7, escala: 1.5 }, { left: 0, top: 167, lado: 333 }],
];

test('a janela do recorte: centro puxado para dentro, lado = menor medida ÷ escala, tudo inteiro', () => {
  for (const [w, h, recorte, esperado] of CASOS_DA_JANELA) {
    assert.deepEqual(janelaDoRecorte(w, h, recorte), esperado, `${w}×${h} ${JSON.stringify(recorte)}`);
  }
});

test('validarRecorte: aceita x,y em 0–1 e escala em 1–3, arredonda a 3 casas; o resto é null', () => {
  assert.deepEqual(validarRecorte({ x: '0.12345', y: 1, escala: 1.5 }), { x: 0.123, y: 1, escala: 1.5 });
  assert.equal(ESCALA_MAX, 3);
  for (const ruim of [null, undefined, 'x', 7, {}, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5, escala: 0.99 }, { x: 0.5, y: 0.5, escala: 3.01 },
    { x: -0.01, y: 0.5, escala: 1 }, { x: 0.5, y: 1.01, escala: 1 }, { x: 'a', y: 0.5, escala: 1 }, { x: NaN, y: 0.5, escala: 1 }, { x: Infinity, y: 0.5, escala: 1 }]) {
    assert.equal(validarRecorte(ruim), null, JSON.stringify(ruim));
  }
  assert.equal(janelaDoRecorte(0, 100, { x: 0.5, y: 0.5, escala: 1 }), null);
  assert.equal(janelaDoRecorte(100, 100, null), null);
});

test('o parâmetro da URL (`rc`) vai e volta; lixo vira null', () => {
  assert.equal(paraParametro({ x: 0.5, y: 0.31, escala: 1.2 }), '0.500,0.310,1.200');
  assert.deepEqual(deParametro('0.500,0.310,1.200'), { x: 0.5, y: 0.31, escala: 1.2 });
  for (const ruim of [undefined, null, '', 'a,b,c', '0.5,0.5', '0.5,0.5,1,1', ',,', '0.5,0.5,9', 'x'.repeat(60), ['0.5,0.5,1']]) {
    assert.equal(deParametro(ruim), null, String(ruim));
  }
  assert.equal(paraParametro({ x: 5, y: 0, escala: 1 }), null);
});

// ─── 2. o derivado de verdade ─────────────────────────────────────────────────
/** Imagem w×h em que R = y/h e G = x/w (0–255): dá para ler, na miniatura, de que ponto da original ela veio. */
async function gradiente(w, h, { orientacao = null, formato = 'png' } = {}) {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    raw[i] = Math.floor((y / h) * 255); raw[i + 1] = Math.floor((x / w) * 255); raw[i + 2] = 90;
  }
  const img = sharp(raw, { raw: { width: w, height: h, channels: 3 } });
  if (formato === 'jpeg') return img.jpeg({ quality: 95 }).withMetadata(orientacao ? { orientation: orientacao } : {}).toBuffer();
  return img.png().toBuffer();
}
/** A cor média do miolo (16×16) da miniatura gerada. */
async function miolo(buf) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  let r = 0; let g = 0; let n = 0;
  const c0 = Math.floor(info.width / 2) - 8; const l0 = Math.floor(info.height / 2) - 8;
  for (let y = l0; y < l0 + 16; y++) for (let x = c0; x < c0 + 16; x++) {
    const i = (y * info.width + x) * info.channels; r += data[i]; g += data[i + 1]; n += 1;
  }
  return { r: r / n, g: g / n, w: info.width, h: info.height };
}
const perto = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a.toFixed(1)} ≠ ${b} (±${tol})`);

test('derivado com recorte: o quadrado sai da JANELA pedida (e não do topo)', async () => {
  const original = await gradiente(800, 1200);
  const comRecorte = await gerarDerivado(original, 'image/png', { largura: 128, quadrado: true, recorte: { x: 0.5, y: 0.2, escala: 2 } });
  assert.equal(comRecorte.tipo, 'image/webp');
  const a = await miolo(comRecorte.buf);
  assert.deepEqual([a.w, a.h], [128, 128]);
  // janela {left 200, top 40, lado 400}: o centro é o ponto (400, 240) da original → R = 240/1200·255 ≈ 51, G = 400/800·255 ≈ 127
  perto(a.r, 51, 9, 'R do miolo (a altura de onde veio)');
  perto(a.g, 127, 9, 'G do miolo (a largura de onde veio)');
  // sem recorte, o quadrado do TOPO (800×800): o centro é (400, 400) → R ≈ 85
  const topo = await gerarDerivado(original, 'image/png', { largura: 128, quadrado: true });
  perto((await miolo(topo.buf)).r, 85, 9, 'sem recorte o quadrado continua saindo do topo');
});

test('derivado com recorte numa foto com EXIF girado: a janela é medida na imagem JÁ orientada', async () => {
  // Guardada 1200×800 com Orientation 6 (o app mostra 800×1200). R = y/800 guardado = a posição ao longo do lado de 1200 na tela.
  const original = await gradiente(1200, 800, { orientacao: 6, formato: 'jpeg' });
  const meta = await sharp(original).metadata();
  assert.equal(meta.orientation, 6);
  const a = await miolo((await gerarDerivado(original, 'image/jpeg', { largura: 128, quadrado: true, recorte: { x: 0.5, y: 0.9, escala: 1 } })).buf);
  assert.deepEqual([a.w, a.h], [128, 128]);
  // Na tela (800×1200) a janela é {left 0, top 400, lado 800}: o centro cai em y=800 da imagem girada, que é o x=800 da guardada
  // (G = x/1200·255 ≈ 170). Medida nas dimensões ERRADAS (1200×800, sem girar) o centro cairia em x=600 (G ≈ 127).
  perto(a.g, 170, 10, 'o miolo veio da janela da imagem JÁ girada');
});

test('recorte sem `quadrado` não faz nada; formato que não é imagem passa intacto', async () => {
  const original = await gradiente(800, 1200);
  const livre = await gerarDerivado(original, 'image/png', { largura: 256, quadrado: false, recorte: { x: 0.5, y: 0.9, escala: 3 } });
  const meta = await sharp(livre.buf).metadata();
  assert.deepEqual([meta.width, meta.height], [256, 384], 'continua 2:3, sem janela');
  const gif = Buffer.from('GIF89a');
  assert.deepEqual(await gerarDerivado(gif, 'image/gif', { largura: 128, quadrado: true, recorte: { x: 0.5, y: 0.5, escala: 1 } }), { buf: gif, tipo: 'image/gif' });
});

// ─── 3. a chave do cache ──────────────────────────────────────────────────────
test('chave do derivado: sem recorte é a de SEMPRE (o aquecimento do upload continua batendo); com recorte é outra', () => {
  const base = { bucket: 'avatars', path: 'public/u1-1.png', v: '9', largura: 128, quadrado: true };
  const antiga = crypto.createHash('sha1').update('avatars:public/u1-1.png:9:128:sq').digest('hex');
  assert.equal(chaveDoDerivado(base), antiga);
  assert.equal(chaveDoDerivado({ ...base, recorte: null }), antiga);
  const rc = chaveDoDerivado({ ...base, recorte: { x: 0.5, y: 0.2, escala: 2 } });
  assert.notEqual(rc, antiga);
  assert.notEqual(rc, chaveDoDerivado({ ...base, recorte: { x: 0.5, y: 0.2, escala: 2.5 } }));
  // sem `sq` o recorte não conta: é a mesma chave de qualquer pedido livre
  assert.equal(
    chaveDoDerivado({ ...base, quadrado: false, recorte: { x: 0.5, y: 0.2, escala: 2 } }),
    chaveDoDerivado({ ...base, quadrado: false }),
  );
});

// ─── 4. a URL do proxy ────────────────────────────────────────────────────────
const BASE = 'http://motor.teste';
const publica = (bucket, caminho, v = '1790') => `https://ref.supabase.co/storage/v1/object/public/${bucket}/${caminho}?v=${v}`;

test('proxificarPayload: só o arquivo com recorte ganha `?rc=`; o token continua o mesmo e decodifica', () => {
  recortes.registrar('public/u1-1790.jpg', { x: 0.5, y: 0.25, escala: 1.4 });
  const payload = {
    eu: { avatar_url: publica('avatars', 'public/u1-1790.jpg') },
    outros: [{ avatar_url: publica('avatars', 'public/u2-1790.jpg') }, { avatar_url: publica('avatars', 'public/u1-1790.jpg') }],
    post: { url: publica('resenha', 'public/u1-1790.jpg') }, // outro bucket, mesmo caminho: não é avatar
    de_fora: { avatar_url: 'https://lh3.googleusercontent.com/a/abc' },
  };
  proxificarPayload(payload, BASE);
  assert.match(payload.eu.avatar_url, /^http:\/\/motor\.teste\/api\/media\/[^/?]+\?rc=0\.500,0\.250,1\.400$/);
  assert.equal(payload.outros[1].avatar_url, payload.eu.avatar_url, 'as miniaturas de todo mundo veem o mesmo recorte');
  assert.doesNotMatch(payload.outros[0].avatar_url, /rc=/);
  assert.doesNotMatch(payload.post.url, /rc=/);
  assert.equal(payload.de_fora.avatar_url, 'https://lh3.googleusercontent.com/a/abc');
  const token = payload.eu.avatar_url.split('/api/media/')[1].split('?')[0];
  const alvo = verificarToken(token);
  assert.deepEqual([alvo.bucket, alvo.path, alvo.v], ['avatars', 'public/u1-1790.jpg', '1790']);
});

test('o rosto público (páginas /p/) também leva o recorte', () => {
  recortes.registrar('public/u1-1790.jpg', { x: 0.4, y: 0.3, escala: 1 });
  const tr = { times: [{ jogadores: [{ user_id: 'u1', avatar_url: publica('avatars', 'public/u1-1790.jpg') }] }], reservas: [] };
  aplicarRostoPublico(tr, new Map([['u1', { birthdate: '1990-01-01', mostrar_rosto_publico: true }]]), BASE);
  assert.match(tr.times[0].jogadores[0].avatar_url, /\?rc=0\.400,0\.300,1\.000$/);
  assert.equal(urlDoProxy(BASE, { bucket: 'avatars', path: 'public/outro.jpg', v: null }).includes('rc='), false);
});

// ─── 5. o registro em memória ────────────────────────────────────────────────
const rc = (x, y, escala, arquivo) => ({ x, y, escala, arquivo });

test('carregar: lê do banco (em páginas), troca o mapa inteiro e ignora linha sem arquivo ou com recorte ruim', async () => {
  const usuarios = [];
  for (let i = 0; i < 1203; i++) usuarios.push({ id: `u${String(i).padStart(4, '0')}`, avatar_recorte: rc(0.5, 0.3, 1.5, `public/u${i}-1.jpg`) });
  usuarios.push({ id: 'z1', avatar_recorte: { x: 0.5, y: 0.5, escala: 9, arquivo: 'public/ruim.jpg' } }, { id: 'z2', avatar_recorte: { x: 0.5, y: 0.5, escala: 1 } }, { id: 'z3', avatar_recorte: null });
  const { cliente } = criarSupabaseFalso({ users: usuarios });
  assert.equal(await recortes.carregar(cliente), true);
  assert.equal(recortes.tamanho(), 1203, 'as três páginas (1000 + 203 + a que fecha), sem as linhas ruins');
  assert.equal(recortes.parametroDe('public/u1202-1.jpg'), '0.500,0.300,1.500');
  assert.equal(recortes.parametroDe('public/ruim.jpg'), null);
});

test('carregar: a escrita direta de ANTES da releitura já está no banco; a de DEPOIS não pode ser desfeita por ela', async () => {
  const { cliente, tabelas } = criarSupabaseFalso({ users: [{ id: 'a', avatar_recorte: rc(0.5, 0.5, 1, 'public/a-1.jpg') }] });
  // escrita direta ANTES de a releitura começar: o banco "já sabe" — o que ele disser vale (aqui: nada de 'public/novo.jpg')
  recortes.registrar('public/novo.jpg', { x: 0.2, y: 0.2, escala: 1 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await recortes.carregar(cliente), true);
  assert.equal(recortes.parametroDe('public/novo.jpg'), null, 'a releitura veio depois da escrita: vale o banco');
  assert.equal(recortes.parametroDe('public/a-1.jpg'), '0.500,0.500,1.000');
  // escrita DURANTE a releitura (acontece depois de ela ter começado): a releitura não a desfaz
  const lenta = {
    from: (t) => {
      const q = cliente.from(t);
      const original = q.then.bind(q);
      q.then = (ok, falha) => new Promise((r) => setTimeout(r, 20)).then(() => original(ok, falha));
      return q;
    },
  };
  const emCurso = recortes.carregar(lenta);
  recortes.registrar('public/durante.jpg', { x: 0.3, y: 0.3, escala: 2 });
  recortes.remover('public/a-1.jpg');
  await emCurso;
  assert.equal(recortes.parametroDe('public/durante.jpg'), '0.300,0.300,2.000');
  assert.equal(recortes.parametroDe('public/a-1.jpg'), null);
  assert.equal(tabelas.users.length, 1);
});

test('carregar: falha de rede mantém o mapa; sem a migração 070 avisa UMA vez e segue na regra de sempre', async () => {
  const avisos = [];
  const aviso = console.warn; const erro = console.error;
  console.warn = (...a) => avisos.push(a.join(' ')); console.error = (...a) => avisos.push(a.join(' '));
  try {
    recortes.registrar('public/fica.jpg', { x: 0.5, y: 0.5, escala: 1 });
    const { cliente: caiu } = criarSupabaseFalso({ users: [] }, { falhar: (t, op) => (t === 'users' && op === 'select' ? { message: 'fetch failed' } : null) });
    assert.equal(await recortes.carregar(caiu), false);
    assert.equal(recortes.parametroDe('public/fica.jpg'), '0.500,0.500,1.000', 'falhou: fica com o que tinha');
    const { cliente: semMigracao } = criarSupabaseFalso({ users: [] }, { falhar: (t, op) => (t === 'users' && op === 'select' ? { message: 'column users.avatar_recorte does not exist' } : null) });
    assert.equal(await recortes.carregar(semMigracao), false);
    assert.equal(await recortes.carregar(semMigracao), false);
    assert.equal(avisos.filter((a) => /migração 070/.test(a)).length, 1, 'avisa uma vez só');
  } finally { console.warn = aviso; console.error = erro; }
});

// ─── 6. as rotas e o proxy ───────────────────────────────────────────────────
const EU = 'e0000000-0000-0000-0000-00000000000e';
const FOTO = `https://ref.supabase.co/storage/v1/object/public/avatars/public/${EU}-1790000000000.jpg?v=1790000000000`;
const CAMINHO_FOTO = `public/${EU}-1790000000000.jpg`;

function rotaDeAvatar(t, { users, falhar = null } = {}) {
  const { carregados, tabelas } = carregar({ users: users || [{ id: EU, avatar_url: FOTO, avatar_recorte: null }] }, ['routes/auth'], { falhar });
  const pedir = subir([carregados['routes/auth']], t);
  return { pedir, tabelas };
}

test('PUT enquadro: grava {x,y,escala,arquivo} no banco E no registro, e o avatar_url já sai com o recorte', async (t) => {
  const { pedir, tabelas } = rotaDeAvatar(t);
  const r = await pedir('PUT', '/api/me/avatar/enquadro', { x: 0.5, y: 0.3, escala: 1.6 }, EU);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.recorte, { x: 0.5, y: 0.3, escala: 1.6 });
  assert.deepEqual(tabelas.users[0].avatar_recorte, { x: 0.5, y: 0.3, escala: 1.6, arquivo: CAMINHO_FOTO });
  assert.equal(recortes.parametroDe(CAMINHO_FOTO), '0.500,0.300,1.600');
  const saida = { avatar_url: r.json.avatar_url };
  proxificarPayload(saida, BASE);
  assert.match(saida.avatar_url, /\?rc=0\.500,0\.300,1\.600$/);
});

test('PUT enquadro noutro arquivo solta o recorte do anterior; DELETE volta à regra de sempre', async (t) => {
  const antigo = { x: 0.5, y: 0.1, escala: 1, arquivo: `public/${EU}-1700000000000.jpg` };
  const { pedir, tabelas } = rotaDeAvatar(t, { users: [{ id: EU, avatar_url: FOTO, avatar_recorte: antigo }] });
  recortes.registrar(antigo.arquivo, antigo);
  await pedir('PUT', '/api/me/avatar/enquadro', { x: 0.4, y: 0.4, escala: 2 }, EU);
  assert.equal(recortes.parametroDe(antigo.arquivo), null);
  assert.equal(recortes.parametroDe(CAMINHO_FOTO), '0.400,0.400,2.000');
  const del = await pedir('DELETE', '/api/me/avatar/enquadro', null, EU);
  assert.equal(del.status, 200);
  assert.equal(del.json.recorte, null);
  assert.equal(tabelas.users[0].avatar_recorte, null);
  assert.equal(recortes.parametroDe(CAMINHO_FOTO), null);
});

test('PUT enquadro: recorte inválido 400; avatar que não é arquivo nosso 409; sem login 401; sem a migração 070 503', async (t) => {
  const { pedir } = rotaDeAvatar(t);
  for (const ruim of [{}, { x: 2, y: 0.5, escala: 1 }, { x: 0.5, y: 0.5, escala: 5 }, { x: 'a', y: 0.5, escala: 1 }]) {
    assert.equal((await pedir('PUT', '/api/me/avatar/enquadro', ruim, EU)).status, 400, JSON.stringify(ruim));
  }
  assert.equal((await pedir('PUT', '/api/me/avatar/enquadro', { x: 0.5, y: 0.5, escala: 1 }, null)).status, 401);

  const google = rotaDeAvatar(t, { users: [{ id: EU, avatar_url: 'https://lh3.googleusercontent.com/a/abc=s96-c', avatar_recorte: null }] });
  const g = await google.pedir('PUT', '/api/me/avatar/enquadro', { x: 0.5, y: 0.5, escala: 1 }, EU);
  assert.equal(g.status, 409);
  assert.match(g.json.error, /foto sua|figurinha/);

  const aviso = console.warn; console.warn = () => {};
  try {
    const sem = rotaDeAvatar(t, { falhar: (tab, op) => (tab === 'users' && op === 'select' ? { message: 'column users.avatar_recorte does not exist' } : null) });
    const s = await sem.pedir('PUT', '/api/me/avatar/enquadro', { x: 0.5, y: 0.5, escala: 1 }, EU);
    assert.equal(s.status, 503);
    assert.match(s.json.error, /ainda não está disponível/);
  } finally { console.warn = aviso; }
});

test('o proxy /api/media: `rc` com `sq=1` serve a janela; sem `sq` ignora; lixo ignora; URLs diferentes não se misturam', async (t) => {
  const original = await gradiente(800, 1200);
  let downloads = 0;
  const bucket = { from: () => ({ download: async () => { downloads += 1; return { data: new Blob([original], { type: 'image/png' }), error: null }; } }) };
  const restaurar = injetar('utils/db', { supabase: { storage: bucket } });
  delete require.cache[require.resolve('../routes/media')];
  delete require.cache[require.resolve('../utils/storage')];
  delete require.cache[require.resolve('../utils/derivadosMidia')];
  const media = require('../routes/media');
  restaurar();
  const { assinarToken } = require('../utils/mediaToken');
  const app = express();
  app.use(media);
  const servidor = app.listen(0);
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const token = assinarToken('avatars', CAMINHO_FOTO, { v: '1' });
  const baixar = async (query) => {
    const r = await fetch(`${base}/api/media/${token}?${query}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, etag: r.headers.get('etag'), cc: r.headers.get('cache-control'), m: r.status === 200 ? await miolo(buf) : null };
  };

  const topo = await baixar('w=128&sq=1');
  const janela = await baixar('w=128&sq=1&rc=0.500,0.200,2.000');
  const semSq = await baixar('w=128&rc=0.500,0.200,2.000');
  const lixo = await baixar('w=128&sq=1&rc=lixo,1,2');
  assert.deepEqual([topo.status, janela.status, semSq.status, lixo.status], [200, 200, 200, 200]);
  perto(topo.m.r, 85, 9, 'sem rc: o quadrado do topo');
  perto(janela.m.r, 51, 9, 'com rc: a janela pedida');
  assert.notEqual(janela.etag, topo.etag, 'recorte diferente = ETag diferente (o browser não confunde as duas miniaturas)');
  assert.deepEqual([semSq.m.w, semSq.m.h], [128, 192], 'sem sq o recorte não corta nada: segue 2:3');
  assert.equal(lixo.etag, topo.etag, 'rc ilegível = sem recorte');
  assert.match(janela.cc, /immutable/);
  assert.ok(downloads >= 1);
});
