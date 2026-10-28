// Futty v2.0 — de onde uma URL de mídia da Resenha pode vir (utils/validarUrl.js).
//
// O proxy de mídia passou a ser servido também pelo SITE (futtyapp.com.br/api/media/…, a Cloudflare guarda na borda): uma foto que a tela
// devolve ao motor pode chegar com o host do site e não com o do motor. Quem garante é o token assinado — o host só diz "é nosso".
// Em dev e nas provas o motor fala http com 127.0.0.1; em produção, só https.
//
// Uso: npm test  (ou: node --test tests/validar-url-midia.test.js)
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.MEDIA_TOKEN_SECRET = 'segredo-do-teste-de-midia';
const { assinarToken } = require('../utils/mediaToken');
const { urlDeMidiaValida, urlDeAvatarValida } = require('../utils/validarUrl');

const MOTOR = 'futty-api-685039278359.southamerica-east1.run.app';
const req = (host = MOTOR) => ({ get: (h) => (h.toLowerCase() === 'host' ? host : undefined) });
const daResenha = assinarToken('resenha', 'u1-1760000000000.webp');
const doAvatar = assinarToken('avatars', 'u1/foto.webp');
const ambiente = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = ambiente; });

test('o proxy pelo host do motor e pelo host do SITE valem (o token é que manda)', () => {
  assert.equal(urlDeMidiaValida(`https://${MOTOR}/api/media/${daResenha}?w=512`, req()), true);
  assert.equal(urlDeMidiaValida(`https://futtyapp.com.br/api/media/${daResenha}?w=512`, req()), true);
  assert.equal(urlDeMidiaValida(`https://www.futtyapp.com.br/api/media/${daResenha}`, req()), true);
});

test('outro host, token forjado ou de outro bucket não passam', () => {
  assert.equal(urlDeMidiaValida(`https://outro-site.com/api/media/${daResenha}`, req()), false);
  assert.equal(urlDeMidiaValida(`https://futtyapp.com.br/api/media/${daResenha.slice(0, -3)}xyz`, req()), false);
  assert.equal(urlDeMidiaValida(`https://futtyapp.com.br/api/media/${doAvatar}`, req()), false, 'avatar não é mídia da Resenha');
  assert.equal(urlDeAvatarValida(`https://futtyapp.com.br/api/media/${doAvatar}`, req()), true);
});

test('http só para 127.0.0.1/localhost e só fora de produção', () => {
  process.env.NODE_ENV = 'test';
  assert.equal(urlDeMidiaValida(`http://127.0.0.1:3001/api/media/${daResenha}`, req('127.0.0.1:3001')), true);
  assert.equal(urlDeMidiaValida(`http://localhost:3001/api/media/${daResenha}`, req('localhost:3001')), true);
  assert.equal(urlDeMidiaValida(`http://futtyapp.com.br/api/media/${daResenha}`, req()), false, 'o site, em http, não');
  process.env.NODE_ENV = 'production';
  assert.equal(urlDeMidiaValida(`http://127.0.0.1:3001/api/media/${daResenha}`, req('127.0.0.1:3001')), false);
});
