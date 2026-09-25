// Futty v2.0 — RODADA 27: "Trocar foto" responde sem esperar a faxina, e o resto da casa vê a foto
// de hoje. Com contas de verdade e o motor local (o mesmo padrão dos outros testes de avatar).
//
// O que se tranca aqui (cada item existe por um número medido na bancada da rodada):
//   1. POST /api/me/avatar RESPONDE antes de apagar a foto anterior (o remove ficou depois do
//      res.json): a 6ª/7ª ida ao Supabase em série saiu do caminho de quem espera a tela;
//   2. a foto e a original anteriores mesmo assim saem do bucket, e o hash do arquivo guardado
//      continua no MESMO update que o URL (nada de janela com foto nova e hash velho);
//   3. original que não sobe não derruba o recorte e NÃO deixa foto_original_url apontando para
//      um objeto que não existe;
//   4. os derivados que as telas pedem da foto nova ficam prontos no LRU do proxy sem ninguém
//      pedir, e a primeira leitura do proxy já é um hit;
//   5. PUT .../recorte faz o mesmo (foto anterior sai, derivados prontos), e sem foto dá 400 sem
//      deixar arquivo órfão;
//   6. o sorteio mostra a foto de HOJE de quem a trocou depois de sorteado, e o Ranking traz o
//      genérico que a pessoa escolheu (uma silhueta "?" não).
//
// Uso: npm test  (ou: node --test tests/foto-rapida.test.js)
require('dotenv').config();
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const { app, supabase } = require('../server');
const { assinarToken, decodificarToken } = require('../utils/mediaToken');
const { parseUrlPublico } = require('../utils/storage');
const { chaveDoDerivado, cacheLer, TAMANHOS_DA_FOTO } = require('../utils/derivadosMidia');

const { SUPABASE_URL } = process.env;
const SUPABASE_ANON_KEY = require('../utils/chavesSupabase').chavePublica();

let server;
let baseUrl;
const contas = {}; // rotulo -> { id, email, token }
let teamId = null;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Foto sintética 2:3 (400×600) que passa o olheiro de entrada: cinzento `tom`, com um risco para variar os bytes. */
const foto = (tom, w = 400, h = 600) => sharp({ create: { width: w, height: h, channels: 3, background: { r: tom, g: tom, b: tom } } })
  .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}"><rect x="10" y="${tom % 50}" width="40" height="8" fill="#fff"/></svg>`), top: 0, left: 0 }])
  .jpeg({ quality: 90 }).toBuffer();

async function criarConta(rotulo) {
  const email = `teste-foto-${rotulo}-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
  const password = `Fx7!${crypto.randomUUID()}`;
  const { data: criado, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: entrou, error: entrarErr } = await anon.auth.signInWithPassword({ email, password });
  if (entrarErr) throw entrarErr;
  contas[rotulo] = { id: criado.user.id, email, token: entrou.session.access_token };
  return contas[rotulo];
}

function enviar(conta, metodo, rota, campos) {
  const form = new FormData();
  for (const [nome, buf] of Object.entries(campos)) form.append(nome, new Blob([buf], { type: 'image/jpeg' }), `${nome}.jpg`);
  return fetch(`${baseUrl}${rota}`, { method: metodo, headers: { Authorization: `Bearer ${conta.token}` }, body: form });
}
const subirFoto = (conta, recorte, original) => enviar(conta, 'POST', '/api/me/avatar', original ? { avatar: recorte, original } : { avatar: recorte });
const enviarRecorte = (conta, recorte) => enviar(conta, 'PUT', '/api/me/avatar/recorte', { recorte });
const perfilNoBanco = async (id) => (await supabase.from('users').select('foto_url, avatar_url, foto_original_url, foto_hash').eq('id', id).maybeSingle()).data;
const caminhoDe = (url) => parseUrlPublico(url)?.path ?? null;
// Existência pelo LIST (metadados), nunca pelo download: o download de um objeto que já foi lido continua servido
// pelo cache do Storage por um bom tempo depois do remove (medido: > 6 s), e o teste esperaria à toa.
async function existeNoBucket(caminho) {
  const nome = caminho.split('/').pop();
  const { data } = await supabase.storage.from('avatars').list('public', { limit: 20, search: nome });
  return (data || []).some((f) => f.name === nome);
}

/** Espera `fn` devolver algo verdadeiro (até `limite` ms); devolve o valor ou null. */
async function esperarAte(fn, limite = 15000, passo = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > limite) return null;
    await espera(passo);
  }
}

// A classe que o supabase-js usa para cada bucket (o `supabase.storage` cria um cliente novo a cada leitura,
// então o gancho vai no protótipo). O gancho troca `remove`/`upload` só enquanto o teste precisa.
const ApiDoBucket = supabase.storage.from('avatars').constructor;
const originais = { remove: ApiDoBucket.prototype.remove, upload: ApiDoBucket.prototype.upload };
const restaurarGanchos = () => { ApiDoBucket.prototype.remove = originais.remove; ApiDoBucket.prototype.upload = originais.upload; };

before(async () => {
  if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_PUBLISHABLE_KEY (ou a antiga SUPABASE_ANON_KEY) em falta no .env — precisa dela para assinar sessão de teste.');
  server = app.listen(0);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await criarConta('dona');
});

after(async () => {
  restaurarGanchos();
  try {
    if (teamId) await supabase.from('teams').delete().eq('id', teamId);
    for (const conta of Object.values(contas)) {
      const { data: sobras } = await supabase.storage.from('avatars').list('public', { limit: 100, search: conta.id });
      const alvos = (sobras || []).filter((f) => f.name.startsWith(conta.id)).map((f) => `public/${f.name}`);
      if (alvos.length) await supabase.storage.from('avatars').remove(alvos);
      await supabase.from('user_avatar_historico').delete().eq('user_id', conta.id).then(() => {}, () => {});
      await supabase.auth.admin.deleteUser(conta.id).catch(() => {});
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/me/avatar RESPONDE antes de apagar a foto anterior; o hash é o dos bytes guardados', async () => {
  const dona = contas.dona;
  const fotoA = await foto(110);
  const resA = await subirFoto(dona, fotoA);
  assert.equal(resA.status, 200, `upload A: ${resA.status}`);
  const caminhoA = caminhoDe((await perfilNoBanco(dona.id)).foto_url);
  assert.ok(caminhoA);
  await esperarAte(async () => existeNoBucket(caminhoA), 5000); // a A está lá

  // O gancho: `remove` só termina 2,5 s depois de chamado. Se a rota o esperasse antes de responder,
  // a resposta chegaria DEPOIS do fim do remove.
  let removeFim = null;
  ApiDoBucket.prototype.remove = async function (...a) {
    await espera(2500);
    const r = await originais.remove.apply(this, a);
    removeFim = Date.now();
    return r;
  };
  try {
    const fotoB = await foto(170);
    const res = await subirFoto(dona, fotoB);
    const corpo = await res.json().catch(() => ({}));
    const tResposta = Date.now();
    assert.equal(res.status, 200, `upload B: ${res.status} ${JSON.stringify(corpo)}`);

    // O hash é o do que a pessoa mandou (sem recodificar) e já está no banco quando a resposta chega.
    const perfil = await perfilNoBanco(dona.id);
    assert.equal(perfil.foto_hash, sha256(fotoB), 'o hash guardado é o dos bytes enviados (a foto do app não é recodificada) e vai no MESMO update do URL');
    const caminhoB = caminhoDe(perfil.foto_url);
    assert.notEqual(caminhoB, caminhoA);

    const terminou = await esperarAte(async () => removeFim, 20000);
    assert.ok(terminou, 'a faxina precisa acontecer (o remove chegou a terminar)');
    assert.ok(tResposta < removeFim, `a resposta (${tResposta}) tem de chegar ANTES do fim do remove (${removeFim}): a rota não pode esperar a faxina`);
    assert.equal(await esperarAte(async () => !(await existeNoBucket(caminhoA)), 10000), true, 'e a foto anterior saiu do bucket');
  } finally {
    restaurarGanchos();
  }
});

test('original: foto_original_url aponta para o arquivo gravado, e a original anterior sai depois', async () => {
  const dona = contas.dona;
  const rec1 = await foto(90);
  const ori1 = await foto(91, 800, 1200);
  const r1 = await subirFoto(dona, rec1, ori1);
  const c1 = await r1.json().catch(() => ({}));
  assert.equal(r1.status, 200, `upload 1: ${r1.status} ${JSON.stringify(c1)}`);
  const p1 = await perfilNoBanco(dona.id);
  assert.ok(p1.foto_original_url, 'a resposta e o banco trazem a original');
  const caminhoOri1 = caminhoDe(p1.foto_original_url);
  assert.equal(await existeNoBucket(caminhoOri1), true, 'e o arquivo da original existe de verdade');
  assert.equal(p1.foto_hash, sha256(rec1), 'o hash é o do RECORTE (a original não entra na trava)');

  const r2 = await subirFoto(dona, await foto(95), await foto(96, 800, 1200));
  assert.equal(r2.status, 200);
  const p2 = await perfilNoBanco(dona.id);
  assert.notEqual(caminhoDe(p2.foto_original_url), caminhoOri1);
  assert.equal(await esperarAte(async () => !(await existeNoBucket(caminhoOri1)), 12000), true, 'a original anterior saiu do bucket');
});

test('original que não sobe: 200, o recorte vale, e foto_original_url NÃO aponta para um arquivo que não existe', async () => {
  const dona = contas.dona;
  const antes = await perfilNoBanco(dona.id);
  ApiDoBucket.prototype.upload = async function (caminho, ...a) {
    if (/-original-/.test(caminho)) return { data: null, error: { message: 'falha de propósito (teste)' } };
    return originais.upload.call(this, caminho, ...a);
  };
  let res; let corpo;
  try {
    res = await subirFoto(dona, await foto(130), await foto(131, 800, 1200));
    corpo = await res.json().catch(() => ({}));
  } finally {
    restaurarGanchos();
  }
  assert.equal(res.status, 200, `o recorte não pode cair por causa da original: ${res.status} ${JSON.stringify(corpo)}`);
  const depois = await perfilNoBanco(dona.id);
  assert.notEqual(depois.foto_url, antes.foto_url, 'a foto nova valeu');
  assert.equal(depois.foto_original_url, antes.foto_original_url, 'foto_original_url continua a de antes (a nova original não existe)');
  assert.equal(corpo.foto_original_url === null || typeof corpo.foto_original_url === 'string', true);
  const { data: lista } = await supabase.storage.from('avatars').list('public', { limit: 100, search: `${dona.id}-original` });
  assert.ok((lista || []).every((f) => !f.name.includes('131')) , 'nenhum arquivo da original que falhou ficou no bucket');
});

test('os derivados da foto nova ficam prontos no LRU sem ninguém pedir, e o proxy os serve como hit', async () => {
  const dona = contas.dona;
  const res = await subirFoto(dona, await foto(150));
  assert.equal(res.status, 200);
  const perfil = await perfilNoBanco(dona.id);
  const alvo = parseUrlPublico(perfil.foto_url);
  const chave = (t) => chaveDoDerivado({ bucket: 'avatars', path: alvo.path, v: alvo.v, ...t });

  const prontos = await esperarAte(async () => (TAMANHOS_DA_FOTO.every((t) => cacheLer(chave(t))) ? true : null), 10000, 50);
  assert.ok(prontos, 'os quatro tamanhos (512, 128 quadrado, 128, 256) têm de aparecer no LRU sem nenhum GET');

  // A primeira leitura da tela: o token do proxy (o mesmo que o middleware põe nas respostas) → hit.
  const token = assinarToken('avatars', alvo.path, { v: alvo.v });
  const leitura = await fetch(`${baseUrl}/api/media/${token}?w=512`);
  assert.equal(leitura.status, 200);
  assert.equal(leitura.headers.get('content-type'), 'image/webp');
  assert.equal(leitura.headers.get('x-futty-cache'), 'hit', 'a primeira leitura da própria pessoa já não paga o Storage nem o sharp');
  const quadrada = await fetch(`${baseUrl}/api/media/${token}?w=128&sq=1`);
  assert.equal(quadrada.headers.get('x-futty-cache'), 'hit');
  assert.equal(decodificarToken(token).path, alvo.path);
});

test('PUT /api/me/avatar/recorte: a foto anterior sai e os derivados do recorte novo ficam prontos', async () => {
  const dona = contas.dona;
  const antes = await perfilNoBanco(dona.id);
  const caminhoAntes = caminhoDe(antes.foto_url);
  const res = await enviarRecorte(dona, await foto(200));
  const corpo = await res.json().catch(() => ({}));
  assert.equal(res.status, 200, `recorte: ${res.status} ${JSON.stringify(corpo)}`);
  const depois = await perfilNoBanco(dona.id);
  const alvo = parseUrlPublico(depois.foto_url);
  assert.notEqual(alvo.path, caminhoAntes);
  assert.equal(await esperarAte(async () => !(await existeNoBucket(caminhoAntes)), 12000), true, 'o recorte anterior saiu do bucket');
  const pronto = await esperarAte(async () => (TAMANHOS_DA_FOTO.every((t) => cacheLer(chaveDoDerivado({ bucket: 'avatars', path: alvo.path, v: alvo.v, ...t }))) ? true : null), 10000, 50);
  assert.ok(pronto, 'os derivados do recorte novo estão no LRU');
});

test('PUT .../recorte sem foto: 400 e nenhum arquivo órfão no bucket', async () => {
  const semFoto = await criarConta('semfoto');
  const res = await enviarRecorte(semFoto, await foto(60));
  assert.equal(res.status, 400);
  const limpo = await esperarAte(async () => {
    const { data } = await supabase.storage.from('avatars').list('public', { limit: 100, search: semFoto.id });
    return (data || []).filter((f) => f.name.startsWith(semFoto.id)).length === 0;
  }, 8000);
  assert.equal(limpo, true, 'o recorte que subiu à toa foi apagado');
});

test('sorteio: quem trocou a foto depois de sorteado aparece com a foto de HOJE; Ranking traz o genérico escolhido', async () => {
  const dona = contas.dona;
  const sufixo = `${Date.now()}-${crypto.randomInt(1e6)}`;
  const { data: time, error: eTime } = await supabase.from('teams')
    .insert({ nome: `Foto R27 ${sufixo}`, slug: `foto-r27-${sufixo}`, cor: '#d4a017', criado_por: dona.id }).select().single();
  if (eTime) throw eTime;
  teamId = time.id;
  const { error: eMem } = await supabase.from('team_members').insert({ team_id: teamId, user_id: dona.id, role: 'admin', categoria: 'linha' });
  if (eMem) throw eMem;
  // Ranking só lista quem tem ≥ 3 jogos confirmados: dois passados + o do sorteio.
  const jogos = [];
  for (const dias of [-14, -7, 3]) {
    const { data: g, error } = await supabase.from('games')
      .insert({ team_id: teamId, data: new Date(Date.now() + dias * 864e5).toISOString(), local: 'Society', jogadores_por_time: 1, max_jogadores: 2 }).select().single();
    if (error) throw error;
    jogos.push(g);
    const { error: eGp } = await supabase.from('game_players').insert({ game_id: g.id, user_id: dona.id, confirmado: true });
    if (eGp) throw eGp;
  }
  const jogoDoSorteio = jogos[2];

  // O sorteio foi feito com a foto de ANTES (a copia fica no snapshot).
  const fotoAntiga = (await perfilNoBanco(dona.id)).foto_url;
  const resultado = { num_times: 2, total_jogadores: 1, convidados_total: 0, seed: 42, avisos: [], times: [{ nome: 'Time A', rating_medio: 3, jogadores: [{ user_id: dona.id, nome: 'Dona', avatar_url: fotoAntiga, rating: 3 }] }, { nome: 'Time B', rating_medio: 0, jogadores: [] }], reservas: [] };
  const { error: eSort } = await supabase.from('games').update({ sorteio_realizado: true, num_times: 2, times_resultado: resultado }).eq('id', jogoDoSorteio.id);
  if (eSort) throw eSort;

  // Troca a foto DEPOIS do sorteio.
  const res = await subirFoto(dona, await foto(210));
  assert.equal(res.status, 200);
  const fotoNova = (await perfilNoBanco(dona.id)).foto_url;
  assert.notEqual(caminhoDe(fotoNova), caminhoDe(fotoAntiga));

  const lido = await fetch(`${baseUrl}/api/games/${jogoDoSorteio.id}`, { headers: { Authorization: `Bearer ${dona.token}` } });
  assert.equal(lido.status, 200);
  const jogo = await lido.json();
  const daTela = jogo.game.times_resultado.times[0].jogadores[0].avatar_url;
  const caminhoDaTela = decodificarToken(String(daTela).match(/\/api\/media\/([^/?]+)/)?.[1] || '')?.path;
  assert.equal(caminhoDaTela, caminhoDe(fotoNova), 'o cartão do sorteio mostra a foto NOVA, não a copia guardada no sorteio');
  // O snapshot no banco continua o de quando foi sorteado (o replay da cerimônia depende dele).
  const { data: guardado } = await supabase.from('games').select('times_resultado').eq('id', jogoDoSorteio.id).maybeSingle();
  assert.equal(guardado.times_resultado.times[0].jogadores[0].avatar_url, fotoAntiga, 'o banco não é reescrito: só a leitura muda');

  // Ranking: o genérico que a pessoa escolheu viaja no payload.
  await supabase.from('users').update({ avatar_generico: 'f2' }).eq('id', dona.id);
  const rank = await fetch(`${baseUrl}/api/teams/${time.slug}/ranking`, { headers: { Authorization: `Bearer ${dona.token}` } });
  assert.equal(rank.status, 200, `ranking: ${rank.status}`);
  const linhas = (await rank.json()).ranking || [];
  const minha = linhas.find((p) => p.user_id === dona.id);
  assert.ok(minha, 'a dona aparece no Ranking (3 jogos confirmados)');
  assert.equal(minha.avatar_generico, 'f2', 'o Ranking traz o genérico escolhido para a tela desenhar em vez da silhueta');
});
