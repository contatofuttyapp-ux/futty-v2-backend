// Futty v2.0 — Rodada 15 (16-set): fotos da Resenha comprimidas e cota por
// time. Mesmo padrão de tests/goleiro-do-time.test.js: cria conta e time
// descartáveis, sobe o app numa porta livre, apaga tudo no fim (after).
//
// Cobre:
//   1. JPG grande -> vira webp, gravado bem menor (comprimirImagem)
//   2. PNG fisicamente rotacionado + EXIF orientation -> sai em pé
//      (sharp().rotate() respeita a tag antes de comprimir)
//   3. GIF de 9 MB -> recusado com a mensagem (GIF_MAX_BYTES, 8MB)
//   4. Apagar um post apaga o ARQUIVO no Storage, não só a linha (item 3)
//   5. Cota de 500 MB por time -> 413 ao estourar. SKIP se a migração 053
//      ainda não rodou (RPC feed_bytes_por_time ausente): bytesUsadosPeloTime
//      devolve null e o backend fica fail-open, de propósito — não há 413
//      pra testar até o Pedro aplicar o SQL no Supabase.
//
// As fotos são SINTÉTICAS (sharp, semente fixa) — nenhum arquivo binário no
// repo. O "JPG grande" é ruído desfocado (blur) upscalado: ruído puro não
// comprime como foto de verdade e um degradê liso comprime DEMAIS — o blur é
// o que dá uma textura parecida com uma foto de celular de verdade.
//
// O bucket `resenha` é PRIVADO (Tijolo 1C): a URL que POST /api/feed/upload
// devolve já sai reescrita pelo middleware/mediaUrls.js para o formato do
// proxy (/api/media/<token>), nunca a URL crua do Storage — é essa mesma URL
// que se reenvia depois em POST /api/feed/posts. Por isso os testes resolvem
// o caminho real no bucket com caminhoDeUrl() (utils/storage.js), que agora
// também decodifica o token do proxy (achado desta rodada: sem isso,
// removerFicheirosPorUrl nunca achava o arquivo salvo por um post — ver o
// teste do item 4) — a MESMA função que o backend usa pra achar o tamanho de
// cada anexo na hora de checar a cota.
//
// Uso: npm test  (ou: node --test tests/resenha-midia.test.js)
require('dotenv').config();
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const { app, supabase } = require('../server');
const { bytesUsadosPeloTime } = require('../utils/resenhaCota');
const { caminhoDeUrl } = require('../utils/storage');
const { COM_BANCO, MOTIVO_SKIP } = require('./_ajudaBanco');

const { SUPABASE_URL } = process.env;
const SUPABASE_ANON_KEY = require('../utils/chavesSupabase').chavePublica();
const STORAGE_BUCKET = 'resenha';

let server;
let baseUrl;
let teamId;
const contas = {};
const arquivosParaLimpar = []; // caminhos no bucket resenha (nossos, mesmo se um teste falhar a meio)

// ── infra do teste (mesmo padrão de tests/goleiro-do-time.test.js) ──────────

async function criarConta(papel) {
  const email = `teste-resenha-${papel}-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
  const password = `Fx7!${crypto.randomUUID()}`;
  const { data: created, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({ email, password });
  if (signInErr) throw signInErr;
  await supabase.from('users').upsert({ id: created.user.id, email, nome: `Teste ${papel}` }, { onConflict: 'id' });
  return { id: created.user.id, token: signIn.session.access_token };
}

// urlDeMidiaValida (utils/validarUrl.js) só aceita https — correto em
// produção (atrás do Cloud Run, TLS de verdade), mas o server de teste local
// fala http puro. Trocar só o esquema não muda host/path/token (o que
// urlDeMidiaValida de fato confere) nem precisa de um listener https de
// verdade: os testes nunca BUSCAM essa URL pela rede, só decodificam o token
// (caminhoDeUrl) e leem o Storage direto.
const comoHttps = (url) => url.replace(/^http:/, 'https:');

function pedir(metodo, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, { method: metodo, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

async function enviarArquivo(token, buffer, nome, tipo) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: tipo }), nome);
  return fetch(`${baseUrl}/api/feed/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
}

/** Sobe um arquivo e devolve { url, media_type, caminho }; registado para limpeza. */
async function upload(token, buffer, nome, tipo) {
  const r = await enviarArquivo(token, buffer, nome, tipo);
  const bruto = await r.text(); // lê UMA vez só — .json() depois de .text() no mesmo Response quebra
  assert.equal(r.status, 201, `upload de ${nome} devia dar 201, deu ${r.status}: ${bruto}`);
  const { url, media_type } = JSON.parse(bruto);
  const caminho = caminhoDeUrl(url, STORAGE_BUCKET);
  assert.ok(caminho, `não consegui decodificar o caminho no bucket a partir da URL devolvida: ${url}`);
  arquivosParaLimpar.push(caminho);
  return { url, media_type, caminho };
}

/** Metadata real (inclui .size) do objeto no bucket resenha, ou null se não achar. */
async function metaNoStorage(caminho) {
  const { data } = await supabase.storage.from(STORAGE_BUCKET).list('', { search: caminho, limit: 1 });
  return data?.find((f) => f.name === caminho) || null;
}

// ── fixtures sintéticas (semente fixa — reprodutíveis, sem binário no repo) ──

function mulberry32(a) {
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function ruidoBase(w, h, seed) {
  const rnd = mulberry32(seed);
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < buf.length; i += 1) buf[i] = Math.floor(rnd() * 256);
  return buf;
}

/** JPEG ~2,5 MB, textura de foto (ruído desfocado, upscalado) — comprime como uma foto de verdade. */
async function jpegGrande() {
  const BW = 220; const BH = 165;
  const pixels = ruidoBase(BW, BH, 42);
  return sharp(pixels, { raw: { width: BW, height: BH, channels: 3 } })
    .blur(5)
    .resize(4200, 3150, { kernel: 'cubic' })
    .jpeg({ quality: 94 })
    .toBuffer();
}

/**
 * PNG fisicamente "deitado" (rotacionado 90° dos pixels) com uma tag EXIF
 * orientation=8 — a que diz "gire 90° para a esquerda para corrigir". Um
 * marcador vermelho no canto superior-esquerdo de quem está "em pé" prova a
 * direção certa (girar para o lado errado deixaria o marcador noutro canto).
 * Valor 8 confirmado por medição direta (não por tabela EXIF de memória):
 * ver o histórico desta rodada.
 */
async function pngDeitadoComExif() {
  const W = 80; const H = 140; // retrato — mais alto que largo
  const marcador = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const upright = await sharp({ create: { width: W, height: H, channels: 3, background: '#0000ff' } })
    .composite([{ input: marcador, top: 0, left: 0 }])
    .png()
    .toBuffer();
  const deitado = await sharp(upright).rotate(90).toBuffer(); // só pixels — sem tag
  const comExif = await sharp(deitado).withMetadata({ orientation: 8 }).png().toBuffer();
  return { buffer: comExif, larguraEsperada: W, alturaEsperada: H };
}

/** N bytes com cabeçalho de GIF — o servidor barra pelo TAMANHO, antes de decodificar. */
function gifDeBytes(bytes) {
  const cabecalho = Buffer.from('GIF89a', 'ascii');
  return Buffer.concat([cabecalho, crypto.randomBytes(Math.max(0, bytes - cabecalho.length))]);
}

// ── setup / cleanup ──────────────────────────────────────────────────────────

before(async () => {
  if (!COM_BANCO) return;
  if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_PUBLISHABLE_KEY (ou a antiga SUPABASE_ANON_KEY) em falta no .env — precisa dela para assinar sessão de teste.');

  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  contas.admin = await criarConta('admin');

  const sufixo = `${Date.now()}-${crypto.randomInt(1e6)}`;
  const { data: time, error: teamErr } = await supabase
    .from('teams')
    .insert({ nome: `Teste Resenha ${sufixo}`, slug: `teste-resenha-${sufixo}`, cor: '#d4a017', criado_por: contas.admin.id })
    .select()
    .single();
  if (teamErr) throw teamErr;
  teamId = time.id;

  const { error: memErr } = await supabase.from('team_members').insert([
    { team_id: teamId, user_id: contas.admin.id, role: 'admin' },
  ]);
  if (memErr) throw memErr;
});

after(async () => {
  if (!COM_BANCO) return;
  try {
    if (arquivosParaLimpar.length) await supabase.storage.from(STORAGE_BUCKET).remove(arquivosParaLimpar).catch(() => {});
    if (teamId) await supabase.from('teams').delete().eq('id', teamId);
    for (const c of Object.values(contas)) {
      await supabase.from('users').delete().eq('id', c.id);
      await supabase.auth.admin.deleteUser(c.id).catch(() => {});
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
});

// ── 1. JPG grande -> webp, bem menor ─────────────────────────────────────────

test('upload de JPG ~2,5MB -> grava webp bem menor que 400KB', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const original = await jpegGrande();
  assert.ok(original.length > 1024 * 1024, `a fixture tinha de ser >1MB pra valer como "foto grande", ficou ${(original.length / 1024).toFixed(0)}KB`);

  const { media_type, caminho } = await upload(contas.admin.token, original, 'foto-grande.jpg', 'image/jpeg');
  assert.equal(media_type, 'image');
  assert.match(caminho, /\.webp$/, `o arquivo gravado devia terminar em .webp, veio ${caminho}`);

  const meta = await metaNoStorage(caminho);
  assert.ok(meta, 'o arquivo tinha de existir no Storage depois do upload');
  assert.equal(meta.metadata?.mimetype, 'image/webp');
  const bytes = meta.metadata.size;
  assert.ok(bytes < 400 * 1024, `esperava < 400KB, o arquivo gravado deu ${(bytes / 1024).toFixed(0)}KB`);
  assert.ok(bytes < original.length * 0.25, `o comprimido (${bytes}B) devia ser bem menor que 25% do original (${original.length}B)`);
});

// ── 2. PNG com EXIF girado -> sai em pé ──────────────────────────────────────

test('PNG fisicamente deitado + EXIF orientation=8 -> sai em pé', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const { buffer, larguraEsperada, alturaEsperada } = await pngDeitadoComExif();
  // Confere a PRÓPRIA fixture antes de gastar um upload nela: os pixels têm
  // de estar deitados (proporção invertida) — senão o teste não prova nada.
  const metaFixture = await sharp(buffer).metadata();
  assert.equal(metaFixture.width, alturaEsperada, 'a fixture tem de nascer FISICAMENTE deitada (pixels invertidos)');
  assert.equal(metaFixture.height, larguraEsperada);
  assert.equal(metaFixture.orientation, 8, 'a fixture tem de carregar a tag EXIF orientation=8');

  const { caminho } = await upload(contas.admin.token, buffer, 'retrato-girado.png', 'image/png');

  const { data: baixado, error } = await supabase.storage.from(STORAGE_BUCKET).download(caminho);
  assert.ok(!error && baixado, `não consegui baixar de volta o arquivo gravado: ${error?.message}`);
  const bytesFinal = Buffer.from(await baixado.arrayBuffer());

  const final = sharp(bytesFinal);
  const metaFinal = await final.metadata();
  assert.equal(metaFinal.format, 'webp');
  // Sem orientação pendente: a rotação já foi aplicada aos PIXELS no upload
  // (o .rotate() do servidor consome a tag; não sobra orientation p/ reaplicar).
  assert.equal(metaFinal.orientation ?? 1, 1, 'depois de comprimido não pode sobrar uma orientação pendente');
  assert.equal(metaFinal.width, larguraEsperada, 'largura devia voltar a ser a "em pé" (80), não a deitada (140)');
  assert.equal(metaFinal.height, alturaEsperada);

  // O marcador vermelho tem de estar de volta no canto superior-esquerdo —
  // prova que girou para o lado CERTO, não só que trocou largura por altura.
  const canto = await sharp(bytesFinal).extract({ left: 2, top: 2, width: 4, height: 4 }).raw().toBuffer();
  assert.ok(canto[0] > 180 && canto[1] < 80 && canto[2] < 80, `canto superior-esquerdo devia ser vermelho (marcador em pé), veio rgb(${canto[0]},${canto[1]},${canto[2]})`);
});

// ── 3. GIF de 9MB -> recusado com mensagem clara ─────────────────────────────

test('GIF de 9MB -> recusado (acima do teto de 8MB do GIF)', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const gif9mb = gifDeBytes(9 * 1024 * 1024);
  const r = await enviarArquivo(contas.admin.token, gif9mb, 'reacao.gif', 'image/gif');
  assert.equal(r.status, 413, `devia recusar com 413, deu ${r.status}`);
  const corpo = await r.json();
  assert.match(corpo.error, /gif/i, 'a mensagem tem de mencionar GIF');
  assert.match(corpo.error, /8\s?mb/i, 'a mensagem tem de dizer o teto de 8MB');
});

test('GIF de 5MB (abaixo do teto de 8MB) -> passa sem compressão', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const gif5mb = gifDeBytes(5 * 1024 * 1024);
  const { media_type, caminho } = await upload(contas.admin.token, gif5mb, 'reacao-ok.gif', 'image/gif');
  assert.equal(media_type, 'gif');
  assert.match(caminho, /\.gif$/, 'GIF não passa por conversão — continua .gif');
  const meta = await metaNoStorage(caminho);
  assert.equal(meta.metadata.size, gif5mb.length, 'GIF tem de ser gravado do tamanho exato que chegou (sem tocar)');
});

// ── 4. Apagar um post apaga o ARQUIVO no Storage (item 3) ───────────────────

test('DELETE /api/feed/posts/:id apaga o arquivo no Storage, não só a linha', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const { url, caminho } = await upload(contas.admin.token, await jpegGrande(), 'vai-ser-apagada.jpg', 'image/jpeg');
  assert.ok(await metaNoStorage(caminho), 'pré-condição: o arquivo tem de existir antes de apagar o post');

  const criar = await pedir('POST', '/api/feed/posts', {
    token: contas.admin.token,
    body: { team_id: teamId, body: '', media: [{ url: comoHttps(url), media_type: 'image', position: 0 }] },
  });
  const criarBruto = await criar.text();
  assert.equal(criar.status, 201, `criar o post devia dar 201: ${criarBruto}`);
  const { post } = JSON.parse(criarBruto);

  const apagar = await pedir('DELETE', `/api/feed/posts/${post.id}`, { token: contas.admin.token });
  assert.equal(apagar.status, 200);
  assert.deepEqual(await apagar.json(), { deleted: true });

  const depois = await metaNoStorage(caminho);
  assert.equal(depois, null, 'o arquivo tinha de sumir do Storage junto com o post — não só a linha em feed_post_media');
  // já foi removido pelo próprio endpoint — não precisa (nem deve) entrar na limpeza do after()
  const idx = arquivosParaLimpar.indexOf(caminho);
  if (idx !== -1) arquivosParaLimpar.splice(idx, 1);
});

test('DELETE /api/me (excluir conta) também apaga a mídia da Resenha do usuário no Storage', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  // Conta descartável PRÓPRIA: apagá-la não pode mexer no teamId/contas.admin
  // usados pelos outros testes deste arquivo. Vira admin do MESMO time só
  // para poder postar — como já sobra outro admin (contas.admin), apagar
  // este usuário não aciona sucessão nem apaga o time (utils/apagarUsuario.js).
  const jogador = await criarConta('exclusao');
  const { error: memErr } = await supabase.from('team_members').insert({ team_id: teamId, user_id: jogador.id, role: 'admin' });
  if (memErr) throw memErr;

  const { url, caminho } = await upload(jogador.token, await jpegGrande(), 'sera-orfa.jpg', 'image/jpeg');
  const criar = await pedir('POST', '/api/feed/posts', {
    token: jogador.token,
    body: { team_id: teamId, body: 'antes de excluir a conta', media: [{ url: comoHttps(url), media_type: 'image', position: 0 }] },
  });
  assert.equal(criar.status, 201, `criar o post devia dar 201: ${await criar.text()}`);
  assert.ok(await metaNoStorage(caminho), 'pré-condição: o arquivo tem de existir antes de excluir a conta');

  const excluir = await pedir('DELETE', '/api/me', { token: jogador.token, body: { confirmacao: 'EXCLUIR' } });
  assert.equal(excluir.status, 200, `excluir a conta devia dar 200: ${await excluir.text()}`);

  const depois = await metaNoStorage(caminho);
  assert.equal(depois, null, 'a mídia da Resenha do usuário tinha de sumir do Storage ao excluir a conta');
  const idx = arquivosParaLimpar.indexOf(caminho);
  if (idx !== -1) arquivosParaLimpar.splice(idx, 1); // já removido pela própria exclusão de conta
  // `jogador` é local (não entra em `contas`): a conta já foi excluída acima,
  // e o after() só limpa quem está em `contas` — nada a desfazer aqui.
});

// ── 5. Cota de 500 MB por time -> 413 (SKIP sem a migração 053) ─────────────

test('cota por time -> 413 ao estourar um limite baixo (simulado)', { skip: !COM_BANCO && MOTIVO_SKIP }, async (t) => {
  const usadosAgora = await bytesUsadosPeloTime(teamId);
  if (usadosAgora === null) {
    return t.skip('migração 053 (feed_bytes_por_time) ainda não aplicada no Supabase — cota fica fail-open de propósito até o Pedro rodar o SQL.');
  }

  const { url } = await upload(contas.admin.token, await jpegGrande(), 'estoura-cota.jpg', 'image/jpeg');
  const anterior = process.env.FEED_COTA_BYTES_POR_TIME;
  process.env.FEED_COTA_BYTES_POR_TIME = '500'; // qualquer foto de verdade passa longe disso
  try {
    const r = await pedir('POST', '/api/feed/posts', {
      token: contas.admin.token,
      body: { team_id: teamId, body: '', media: [{ url: comoHttps(url), media_type: 'image', position: 0 }] },
    });
    const bruto = await r.text();
    assert.equal(r.status, 413, `devia recusar com 413, deu ${r.status}: ${bruto}`);
    const corpo = JSON.parse(bruto);
    assert.match(corpo.error, /limite/i);
  } finally {
    if (anterior === undefined) delete process.env.FEED_COTA_BYTES_POR_TIME;
    else process.env.FEED_COTA_BYTES_POR_TIME = anterior;
  }
});

// ── 6. Gabinete → Pessoas & times mostra o uso por time ─────────────────────

test('GET /api/super/teams inclui midia_mb/midia_cota_mb do time (sem quebrar sem a migração 053)', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  contas.donoGabinete = await criarConta('dono-gabinete'); // em `contas`: o after() cuida da exclusão
  const { error } = await supabase.from('users').update({ is_super_admin: true }).eq('id', contas.donoGabinete.id);
  if (error) throw error;

  const r = await pedir('GET', '/api/super/teams', { token: contas.donoGabinete.token });
  const bruto = await r.text();
  assert.equal(r.status, 200, `devia dar 200, deu ${r.status}: ${bruto}`);
  const { teams } = JSON.parse(bruto);
  const meuTime = teams.find((t) => t.id === teamId);
  assert.ok(meuTime, 'o time de teste tinha de aparecer na listagem');
  assert.equal(meuTime.midia_cota_mb, 500, 'a cota exposta ao Gabinete tem de ser 500 MB');
  // Sem a migração 053, bytesUsadosPorTodosOsTimes fica {} (fail-open) — o
  // Gabinete recebe null e mostra "—", nunca quebra a listagem inteira.
  assert.ok(meuTime.midia_mb === null || typeof meuTime.midia_mb === 'number', 'midia_mb tem de ser number ou null, nunca undefined/erro');
});
