// Futty v2.0 — Nome por versão + trava de hash (22-set).
//
// Vem do relato de produção "subi foto nova e a figurinha saiu da foto antiga".
// A causa nunca se reproduziu em bancada, mas as duas defesas que se puseram
// no lugar têm de ficar provadas, senão a próxima refactoração desfaz-nas sem
// ninguém dar por isso:
//
//   1. Cada foto é um OBJETO NOVO no bucket (`public/<id>-<carimbo>.<ext>`).
//      Enquanto o caminho era fixo, qualquer cache pelo caminho — navegador,
//      WebView, CDN, proxy — podia servir a versão anterior, e não havia como
//      lhe pedir para esquecer. Com nome por versão não há nada a esquecer.
//   2. Antes de gastar dinheiro com a fal, a ETAPA 0 confere que a foto que
//      baixou é a que `users.foto_hash` diz ser a atual. Se não for, recusa com
//      409 FOTO_DESATUALIZADA — sem chamar a fal e sem contar quota.
//
// Este teste não passa por fal.ai nenhuma (indisponível nesta máquina, ver
// CLAUDE.md — "fal.run não tem DNS"). A trava de hash corre ANTES da fal, que é
// exactamente o que se quer provar: com o hash errado, nada sai daqui.
//
// As fotos são geradas em código (cinzento chapado 400×400): passam o olheiro
// de entrada (lado ≥ 200 px, brilho entre 15 e 240) sem depender de ficheiro
// nenhum no disco, e dois cinzentos diferentes dão dois sha256 diferentes.
//
// Uso: npm test  (ou: node --test tests/avatar-nome-por-versao.test.js)
require('dotenv').config();
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const { app, supabase } = require('../server');

const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
const KIT = 'dark-gold'; // grátis, sempre ativo — nenhum gate de plano no caminho
const MARCADOR = '/object/public/avatars/';

let server;
let baseUrl;
let accessToken;
let testUserId;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Foto sintética que passa o olheiro de entrada: 400×400, cinzento `tom`. */
const fotoDeTeste = (tom) => sharp({
  create: { width: 400, height: 400, channels: 3, background: { r: tom, g: tom, b: tom } },
}).jpeg({ quality: 92 }).toBuffer();

/** O caminho dentro do bucket, tirado do URL guardado — o mesmo que routes/auth.js faz. */
function caminhoDe(url) {
  const i = String(url || '').indexOf(MARCADOR);
  return i === -1 ? null : url.slice(i + MARCADOR.length).split('?')[0];
}

function subirFoto(buf) {
  const form = new FormData();
  form.append('avatar', new Blob([buf], { type: 'image/jpeg' }), 'teste.jpg');
  return fetch(`${baseUrl}/api/me/avatar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
}

before(async () => {
  if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_ANON_KEY em falta no .env — precisa dela para assinar sessão de teste.');

  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const email = `teste-versao-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
  const password = `Fx7!${crypto.randomUUID()}`;
  const { data: criado, error: criarErr } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (criarErr) throw criarErr;
  testUserId = criado.user.id;

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: entrou, error: entrarErr } = await anon.auth.signInWithPassword({ email, password });
  if (entrarErr) throw entrarErr;
  accessToken = entrou.session.access_token;
});

after(async () => {
  if (testUserId) {
    // apagarUsuario() faz o varrimento por prefixo; aqui basta o caminho curto.
    try {
      const { data: sobras } = await supabase.storage.from('avatars').list('public', { limit: 100, search: testUserId });
      const alvos = (sobras || []).filter((f) => f.name.startsWith(testUserId)).map((f) => `public/${f.name}`);
      if (alvos.length) await supabase.storage.from('avatars').remove(alvos);
    } catch {
      /* limpeza best-effort — um ficheiro de teste a mais não pode pintar o teste de vermelho */
    }
    await supabase.from('user_avatar_slots').delete().eq('user_id', testUserId).then(() => {}, () => {});
    await supabase.auth.admin.deleteUser(testUserId).catch(() => {});
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('duas fotos seguidas -> dois CAMINHOS diferentes no bucket, e o hash é o da segunda', async () => {
  const fotoA = await fotoDeTeste(120);
  const fotoB = await fotoDeTeste(180);
  assert.notEqual(sha256(fotoA), sha256(fotoB), 'as duas fotos de teste têm de ser mesmo diferentes');

  // O corpo lê-se SEMPRE antes de afirmar seja o que for: o template da
  // mensagem de erro é avaliado mesmo quando a asserção passa, e um
  // `await res.text()` lá dentro queimava o corpo antes do `.json()`.
  //
  // O caminho do bucket vem do BANCO, não da resposta: o middleware mediaUrls
  // troca os URLs do Storage por URLs do proxy (`/api/media/<token>`) antes de
  // sair daqui. O que a resposta prova é outra coisa, igualmente útil — que o
  // token muda entre as duas fotos, e portanto o cache de 7 dias do proxy não
  // tem como servir a versão anterior.
  const resA = await subirFoto(fotoA);
  const corpoA = await resA.json().catch(() => ({}));
  assert.equal(resA.status, 200, `upload A devia dar 200, deu ${resA.status}: ${JSON.stringify(corpoA)}`);
  const { data: perfilA } = await supabase.from('users').select('foto_url').eq('id', testUserId).maybeSingle();
  const caminhoA = caminhoDe(perfilA?.foto_url);
  assert.ok(caminhoA, `users.foto_url devia ser um URL do bucket avatars, veio "${perfilA?.foto_url}"`);

  const resB = await subirFoto(fotoB);
  const corpoB = await resB.json().catch(() => ({}));
  assert.equal(resB.status, 200, `upload B devia dar 200, deu ${resB.status}: ${JSON.stringify(corpoB)}`);
  assert.notEqual(corpoA.foto_url, corpoB.foto_url, 'o URL servido ao app tem de mudar com a foto — é o que impede o proxy de servir a anterior');
  const { data: perfil } = await supabase.from('users').select('foto_url, foto_hash').eq('id', testUserId).maybeSingle();
  const caminhoB = caminhoDe(perfil?.foto_url);
  assert.ok(caminhoB, `users.foto_url devia ser um URL do bucket avatars, veio "${perfil?.foto_url}"`);

  // O CORAÇÃO DESTE TESTE: caminho novo, não o mesmo caminho com ?v= novo.
  // Enquanto era o mesmo, havia sempre um cache pelo caminho capaz de servir
  // a foto de ontem — e foi disso que veio o relato de produção.
  assert.notEqual(caminhoA, caminhoB, 'a segunda foto TEM de ir para um caminho novo; caminho reutilizado é cache velho à espera de acontecer');
  assert.match(caminhoB, new RegExp(`^public/${testUserId}-\\d{13}\\.jpg$`), `o caminho devia ser public/<id>-<carimbo>.jpg, veio "${caminhoB}"`);

  // O QUE ESTÁ NO BUCKET BATE COM O QUE A TABELA DIZ. Esta é literalmente a
  // conta que a ETAPA 0 faz antes de gastar dinheiro — se falhar aqui, a trava
  // de hash recusaria toda a gente. Compara-se com `foto_hash` e não com o
  // sha do ficheiro original de propósito: `receberAvatar` reescreve o buffer
  // ao auto-orientar pelo EXIF (.rotate()), portanto o que é guardado nunca
  // são os bytes exactos que saíram do cliente — e o hash é tirado depois.
  const { data: blob, error } = await supabase.storage.from('avatars').download(caminhoB);
  assert.equal(error, null, `devia conseguir baixar ${caminhoB}: ${error?.message}`);
  const bytesNoBucket = Buffer.from(await blob.arrayBuffer());
  assert.equal(sha256(bytesNoBucket), perfil.foto_hash, 'o objeto no caminho novo tem de ser o que users.foto_hash descreve — é o que a ETAPA 0 confere');

  // E é mesmo a foto B: a imagem guardada tem o cinzento 180, não o 120 da A.
  const { channels } = await sharp(bytesNoBucket).greyscale().stats();
  assert.ok(Math.abs(channels[0].mean - 180) < 3, `a imagem guardada devia ser a foto B (cinzento 180), mediu ${channels[0].mean.toFixed(1)}`);

  // A versão anterior saiu do bucket (best-effort na rota, mas tem de acontecer
  // no caminho feliz — senão cada troca de foto deixa lixo por lá para sempre).
  const { error: erroAntiga } = await supabase.storage.from('avatars').download(caminhoA);
  assert.ok(erroAntiga, `a foto anterior (${caminhoA}) devia ter sido apagada depois do update`);
});

test('hash da tabela não bate com o objeto -> 409 FOTO_DESATUALIZADA, sem fal e sem quota', async () => {
  // Cenário: o objeto no bucket é a foto B, mas `foto_hash` diz outra coisa —
  // é o que se veria se o download trouxesse uma versão que não é a atual.
  // Sem a trava, daqui saía uma figurinha paga da foto errada.
  const { data: antes } = await supabase.from('users').select('avatar_ia_mes').eq('id', testUserId).maybeSingle();
  const { error: erroPrep } = await supabase.from('users').update({ foto_hash: 'nao-e-o-hash-desta-foto' }).eq('id', testUserId);
  if (erroPrep) throw erroPrep;

  // A rota tenta 3 vezes com 2 s de intervalo antes de desistir (propagação
  // lenta é motivo legítimo), por isso a recusa demora ~4 s. O timeout aqui é
  // folgado, mas muito abaixo do que uma chamada à fal levaria.
  const res = await fetch(`${baseUrl}/api/me/avatar/ai`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kit: KIT }),
    signal: AbortSignal.timeout(30_000),
  });
  const corpo = await res.json().catch(() => ({}));

  assert.equal(res.status, 409, `devia recusar com 409, deu ${res.status} ${JSON.stringify(corpo)}`);
  assert.equal(corpo.code, 'FOTO_DESATUALIZADA', 'o código tem de ser FOTO_DESATUALIZADA — é por ele que o app escolhe a mensagem');
  assert.match(corpo.error || '', /ainda está sendo preparada/i, `a mensagem devia ser a digna, veio ${JSON.stringify(corpo)}`);

  // Recusar não pode custar quota: quem não recebeu figurinha não gastou uma.
  const { data: depois } = await supabase.from('users').select('avatar_ia_mes').eq('id', testUserId).maybeSingle();
  assert.equal(depois.avatar_ia_mes || 0, antes?.avatar_ia_mes || 0, 'uma recusa por hash desactualizado NÃO pode consumir geração');
});
