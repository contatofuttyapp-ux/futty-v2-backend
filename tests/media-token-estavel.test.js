// Velocidade 6A (15-set) — o token do proxy de imagem tem de ser ESTÁVEL.
//
// Antes, `exp = agora + 7 dias` mudava a cada segundo: cada leitura gerava um
// URL diferente para a MESMA foto, e o cache do celular nunca acertava (a mesma
// imagem descia 3x num só carregamento do Início, 390 KB e ~1,4 s cada).
// Agora o exp é arredondado a uma janela de 7 dias — mesma foto, mesma semana,
// mesmo URL.
const test = require('node:test');
const assert = require('node:assert');

const { assinarToken, verificarToken, expDaJanela, JANELA } = require('../utils/mediaToken');
const { parseUrlPublico } = require('../utils/storage');

test('mesmo bucket/path/v em dois instantes → tokens IDÊNTICOS', () => {
  const a = assinarToken('avatars', 'public/abc-ai-dark-gold.png', { v: '1789473382184' });
  const b = assinarToken('avatars', 'public/abc-ai-dark-gold.png', { v: '1789473382184' });
  assert.strictEqual(a, b, 'o token mudou entre duas emissões — o cache do celular nunca acertaria');
});

test('v diferente → token diferente (conteúdo novo quebra o cache)', () => {
  const antigo = assinarToken('avatars', 'public/abc.png', { v: '1000' });
  const novo = assinarToken('avatars', 'public/abc.png', { v: '2000' });
  assert.notStrictEqual(antigo, novo, 'foto nova devolveu o mesmo URL — ficaria presa no cache');
});

test('path ou bucket diferente → token diferente', () => {
  const a = assinarToken('avatars', 'public/a.png', { v: '1' });
  assert.notStrictEqual(a, assinarToken('avatars', 'public/b.png', { v: '1' }));
  assert.notStrictEqual(a, assinarToken('resenha', 'public/a.png', { v: '1' }));
});

test('verificarToken devolve bucket, path e v', () => {
  const t = assinarToken('resenha', 'foto com espaço.webp', { v: '42' });
  assert.deepStrictEqual(verificarToken(t), { bucket: 'resenha', path: 'foto com espaço.webp', v: '42' });
});

test('token SEM v (formato antigo) continua válido', () => {
  const t = assinarToken('avatars', 'public/legado.png');
  const alvo = verificarToken(t);
  assert.ok(alvo, 'token sem v foi rejeitado — quebraria as URLs já no DOM dos utilizadores');
  assert.strictEqual(alvo.bucket, 'avatars');
  assert.strictEqual(alvo.path, 'public/legado.png');
  assert.strictEqual(alvo.v, null);
});

test('token adulterado é rejeitado', () => {
  const t = assinarToken('avatars', 'public/a.png', { v: '1' });
  const [corpo] = t.split('.');
  assert.strictEqual(verificarToken(`${corpo}.assinaturaFalsa`), null);
  assert.strictEqual(verificarToken('lixo'), null);
  assert.strictEqual(verificarToken(''), null);
});

test('o token vale sempre pelo menos 7 dias, mesmo emitido no fim da janela', () => {
  const agoraS = Math.floor(Date.now() / 1000);
  // Pior caso: um segundo antes de a janela virar.
  const fimDaJanela = (Math.floor(agoraS / JANELA) + 1) * JANELA - 1;
  const exp = expDaJanela(fimDaJanela);
  assert.ok(exp - fimDaJanela >= JANELA, `só ${exp - fimDaJanela}s de validade no pior caso`);
});

test('parseUrlPublico captura o ?v= do upload', () => {
  const url = 'https://x.supabase.co/storage/v1/object/public/avatars/public/abc-ai.png?v=1789473382184';
  assert.deepStrictEqual(parseUrlPublico(url), {
    bucket: 'avatars',
    path: 'public/abc-ai.png',
    v: '1789473382184',
  });
});

test('parseUrlPublico sem query devolve v null', () => {
  const url = 'https://x.supabase.co/storage/v1/object/public/resenha/foto.webp';
  assert.deepStrictEqual(parseUrlPublico(url), { bucket: 'resenha', path: 'foto.webp', v: null });
});

test('parseUrlPublico ignora URLs de fora dos nossos buckets privados', () => {
  assert.strictEqual(parseUrlPublico('https://x.supabase.co/storage/v1/object/public/kits/kit1.png'), null);
  assert.strictEqual(parseUrlPublico('https://exemplo.com/foto.png'), null);
  assert.strictEqual(parseUrlPublico(null), null);
});
