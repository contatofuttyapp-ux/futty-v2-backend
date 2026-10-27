// Futty v2.0 — Rodada 32H, item G: as fotos da Resenha e do "Time campeão" sumiam depois de ~2 semanas.
// Elas ficavam guardadas como a URL do proxy (/api/media/<token>) com o token da época; o token vence (a janela de 7 dias de
// utils/mediaToken.js) e o proxy responde 403 "Acesso inválido ou expirado." Agora toda resposta autenticada sai com o token
// RENOVADO (renovarUrlDeMidia no middleware mediaUrls), e o que se grava daqui para a frente é bucket + caminho, sem token.
// No app de verdade sobre banco e Storage de mentira (tests/_appFalsa.js): um post, um comentário, a foto do campeão e o avatar
// no JSON do resultado, todos com token vencido à mão, voltam a carregar.
//
// Uso: npm test  (ou: node --test tests/midia-renovada.test.js)
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { subirApp, usuario } = require('./_appFalsa');

let app;
// O motor (e utils/storage, que fala com o banco) só carrega depois do app de mentira de pé: é ele que põe o banco falso no lugar.
let assinarToken; let verificarToken; let renovarUrlDeMidia; let urlGuardavelDeMidia;
before(async () => {
  app = await subirApp();
  ({ assinarToken, verificarToken } = require('../utils/mediaToken'));
  ({ renovarUrlDeMidia, urlGuardavelDeMidia } = require('../utils/storage'));
});
after(() => app.fechar());

const DIA = 24 * 3600 * 1000;
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = { ana: usuario(uuid(1), 'Ana'), beto: usuario(uuid(2), 'Beto'), fora: usuario(uuid(3), 'Zé') };
const TIME = { id: uuid(100), slug: 'missa', nome: 'Missa de Quinta', fuso: 'America/Sao_Paulo', criado_por: P.ana.id, created_at: '2026-01-01T00:00:00Z' };
const JOGO = uuid(300);
const POST = uuid(400);
const COMENTARIO = uuid(500);
const FOTO_POST = `${P.ana.id}-1700000000000.webp`;
const FOTO_CAMPEAO = `${P.ana.id}-1700000000001.webp`;
const FOTO_ANEXO = `${P.beto.id}-1700000000002.webp`;
const AVATAR = `${P.beto.id}/avatar.webp`;

/** O token como ele foi guardado há 3 semanas: assinado por nós, com a validade daquela época (já vencida). */
function tokenDeTresSemanas(bucket, path, v) {
  const agora = Date.now;
  Date.now = () => agora() - 21 * DIA;
  try { return assinarToken(bucket, path, v ? { v } : {}); } finally { Date.now = agora; }
}
const urlVelha = (bucket, path, extra = '') => `${app.base}/api/media/${tokenDeTresSemanas(bucket, path)}${extra}`;
const pedir = (quem, metodo, rota, corpo) => app.pedir(metodo, rota, { token: app.token(P[quem].id), corpo });
const tokenDe = (url) => String(url).match(/\/api\/media\/([^/?#]+)/)?.[1];

let png;
beforeEach(async () => {
  png ||= await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 212, g: 160, b: 23 } } }).webp().toBuffer();
  app.reiniciar({
    tabelas: {
      teams: [TIME],
      team_members: [{ id: uuid(201), team_id: TIME.id, user_id: P.ana.id, role: 'admin' }, { id: uuid(202), team_id: TIME.id, user_id: P.beto.id, role: 'member' }],
      games: [{
        id: JOGO, team_id: TIME.id, data: new Date(Date.now() - 20 * DIA).toISOString(), local: 'Arena', status: 'terminado', sorteio_realizado: true,
        campeao_time_index: 0, resultado_nivel: 1, created_at: new Date(Date.now() - 25 * DIA).toISOString(),
        campeao_foto_url: urlVelha('resenha', FOTO_CAMPEAO),
        times_resultado: { times: [{ jogadores: [{ user_id: P.beto.id, nome: 'Beto', avatar_url: urlVelha('avatars', AVATAR) }] }, { jogadores: [] }] },
      }],
      game_players: [], gols_jogadores: [],
      feed_posts: [{ id: POST, team_id: TIME.id, author_id: P.ana.id, body: 'A foto do jogo', tipo: 'post', created_at: new Date(Date.now() - 20 * DIA).toISOString() }],
      feed_post_media: [{ id: uuid(401), post_id: POST, url: urlVelha('resenha', FOTO_POST), media_type: 'image', position: 0 }],
      comentarios: [{ id: COMENTARIO, parent_type: 'post', parent_id: POST, author_id: P.beto.id, body: 'Olha essa', created_at: new Date(Date.now() - 19 * DIA).toISOString(), deleted_at: null }],
      comentario_anexos: [{ id: uuid(501), comentario_id: COMENTARIO, url: urlVelha('resenha', FOTO_ANEXO), media_type: 'image', position: 0 }],
      reacoes: [], blocks: [],
    },
    usuarios: Object.values(P),
  });
  app.criarBucketsDoProjeto();
  for (const [bucket, caminho] of [['resenha', FOTO_POST], ['resenha', FOTO_CAMPEAO], ['resenha', FOTO_ANEXO], ['avatars', AVATAR]]) {
    await app.cliente.storage.from(bucket).upload(caminho, png, { contentType: 'image/webp' });
  }
});

test('o problema: a URL guardada há 3 semanas dá 403 "Acesso inválido ou expirado." no proxy', async () => {
  const velha = app.tabelas.feed_post_media[0].url;
  const r = await app.pedir('GET', `/api/media/${tokenDe(velha)}`);
  assert.equal(r.status, 403);
  assert.equal(r.json?.error, 'Acesso inválido ou expirado.');
});

test('o post da Resenha com token vencido volta a carregar: o feed devolve o token novo, e ele serve a foto', async () => {
  const r = await pedir('beto', 'GET', `/api/feed?team_id=${TIME.id}`);
  assert.equal(r.status, 200, r.texto);
  const post = (r.json.posts || r.json.items || r.json.feed || []).find?.((x) => x.id === POST) || JSON.stringify(r.json).includes(POST);
  assert.ok(post, 'o post está no feed');
  const urls = JSON.stringify(r.json).match(/https?:\/\/[^"]+\/api\/media\/[^"]+/g) || [];
  const daFoto = urls.find((u) => verificarToken(tokenDe(u))?.path === FOTO_POST);
  assert.ok(daFoto, `a foto do post sai com token válido agora (${urls.length} urls)`);
  const foto = await app.pedir('GET', new URL(daFoto).pathname);
  assert.equal(foto.status, 200, 'o proxy serve a foto');
  // A foto do campeão e o avatar dentro do JSON do resultado (o card "Time campeão" da Resenha) também.
  assert.ok(urls.some((u) => verificarToken(tokenDe(u))?.path === FOTO_CAMPEAO), 'a foto do campeão');
  assert.ok(urls.some((u) => verificarToken(tokenDe(u))?.bucket === 'avatars' && verificarToken(tokenDe(u))?.path === AVATAR), 'o avatar do JSON do resultado');
  assert.ok(!urls.some((u) => !verificarToken(tokenDe(u))), 'nenhuma URL vencida sobra na resposta');
});

test('o comentário com anexo vencido volta a carregar', async () => {
  const r = await pedir('ana', 'GET', `/api/feed/comentarios/post/${POST}`);
  assert.equal(r.status, 200, r.texto);
  const urls = JSON.stringify(r.json).match(/https?:\/\/[^"]+\/api\/media\/[^"]+/g) || [];
  const anexo = urls.find((u) => verificarToken(tokenDe(u))?.path === FOTO_ANEXO);
  assert.ok(anexo, 'o anexo sai com token válido');
  assert.equal((await app.pedir('GET', new URL(anexo).pathname)).status, 200);
});

test('a página do jogo passado: a foto do campeão volta com token válido', async () => {
  const r = await pedir('ana', 'GET', `/api/games/${JOGO}`);
  assert.equal(r.status, 200, r.texto);
  assert.equal(verificarToken(tokenDe(r.json.game.campeao_foto_url))?.path, FOTO_CAMPEAO);
  assert.equal((await app.pedir('GET', new URL(r.json.game.campeao_foto_url).pathname)).status, 200);
});

test('quem não é do time não ganha nada: o feed não traz o post, e a URL velha continua morta', async () => {
  const r = await pedir('fora', 'GET', '/api/feed');
  assert.ok(!JSON.stringify(r.json || {}).includes(POST));
  assert.equal((await app.pedir('GET', `/api/media/${tokenDe(app.tabelas.feed_post_media[0].url)}`)).status, 403);
});

test('renovarUrlDeMidia: só o que nós assinamos, só dos buckets privados; a query (?rc=) segue; o resto volta como veio', () => {
  const velha = urlVelha('avatars', AVATAR, '?rc=10,20,1.5');
  const nova = renovarUrlDeMidia(velha, 'https://api.exemplo.test');
  assert.match(nova, /^https:\/\/api\.exemplo\.test\/api\/media\/[^?]+\?rc=10,20,1\.5$/);
  assert.equal(verificarToken(tokenDe(nova)).path, AVATAR);
  assert.equal(renovarUrlDeMidia(velha), `${app.base}/api/media/${tokenDe(nova)}?rc=10,20,1.5`, 'sem base, a origem da própria URL');
  const forjada = `${app.base}/api/media/${tokenDe(velha).split('.')[0]}.assinatura-falsa`;
  assert.equal(renovarUrlDeMidia(forjada, 'https://x.test'), forjada, 'token forjado: não renova');
  for (const outra of ['https://exemplo.test/foto.jpg', 'Veja /api/media/abc no texto', '', null]) assert.equal(renovarUrlDeMidia(outra, 'https://x.test'), outra);
  const denuncia = urlVelha('denuncias', 'x/y.json');
  assert.equal(renovarUrlDeMidia(denuncia, 'https://x.test'), denuncia, 'bucket que não é de mídia privada: não renova');
});

test('daqui para a frente o post guarda bucket + caminho (sem token); a leitura assina na hora', async () => {
  const recente = `${app.base}/api/media/${assinarToken('resenha', FOTO_POST)}`;
  const guardavel = urlGuardavelDeMidia(recente);
  assert.match(guardavel, new RegExp(`/storage/v1/object/public/resenha/${FOTO_POST.replace('.', '\\.')}$`));
  assert.equal(urlGuardavelDeMidia('https://exemplo.test/x.jpg'), 'https://exemplo.test/x.jpg');
  // Um post novo pela rota (a URL do upload, de agora, que é o que o app manda).
  app.reiniciar({ tabelas: { ...app.tabelas, feed_post_media: [] }, usuarios: Object.values(P) });
  const host = new URL(app.base).host;
  const r = await app.pedir('POST', '/api/feed/posts', {
    token: app.token(P.ana.id),
    corpo: { team_id: TIME.id, body: 'Nova', media: [{ url: `https://${host}/api/media/${assinarToken('resenha', FOTO_POST)}`, media_type: 'image' }] },
    cabecalhos: { 'x-forwarded-proto': 'https' },
  });
  assert.equal(r.status < 300, true, r.texto);
  const guardada = app.tabelas.feed_post_media.at(-1)?.url;
  assert.match(guardada, /\/storage\/v1\/object\/public\/resenha\//, `guardou bucket + caminho: ${guardada}`);
  assert.ok(!/\/api\/media\//.test(guardada));
});
