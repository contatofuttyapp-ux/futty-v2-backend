// POST /api/csp — os avisos da CSP do site viram uma linha no log, sem query, sem token, sem repetir, e sem gastar a cota da /api.
//
// O que isto prova:
//   1. os dois formatos (report-uri antigo e report-to novo) viram "[csp] <diretiva> bloqueou <origem+caminho> em <caminho>" ("bloquearia" quando o aviso é de Report-Only);
//   2. query, fragmento e o token do /api/media nunca chegam ao log; data:/blob: e as palavras-chave ("inline", "eval") passam limpas;
//   3. a mesma linha não se repete em 10 min; corpo estranho responde 204 sem linha nenhuma;
//   4. os limiters gerais da /api deixam /csp de fora (ele tem o próprio, por IP);
//   5. no servidor de verdade, /api/csp responde 204 sem sessão e escreve a linha.
const { subirApp } = require('./_appFalsa'); // PRIMEIRO require: o .env de verdade nunca entra
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { criarRotaCsp, avisosDoCorpo } = require('../routes/csp');
const { criarLimitesDaApi, LIMITES } = require('../middleware/limiters');

const ANTIGO = (extra = {}) => ({ 'csp-report': { 'document-uri': 'https://futtyapp.com.br/feed?aba=1#x', 'effective-directive': 'img-src', 'violated-directive': 'img-src', 'blocked-uri': 'https://img.exemplo.com/a.jpg?token=SEGREDO', ...extra } });
const NOVO = (extra = {}) => ({ type: 'csp-violation', url: 'https://futtyapp.com.br/home', body: { documentURL: 'https://futtyapp.com.br/home?x=1', effectiveDirective: 'frame-src', blockedURL: 'https://www.youtube.com/embed/abc?autoplay=1', ...extra } });

function ouvir(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${s.address().port}`, fechar: () => s.close() }));
  });
}
function subir(opcoes) {
  const app = express();
  app.use(criarRotaCsp(opcoes));
  return ouvir(app);
}
const mandar = (base, corpo, tipo) => fetch(`${base}/api/csp`, { method: 'POST', headers: { 'content-type': tipo }, body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo) });

test('os dois formatos viram a mesma linha curta: diretiva, origem + caminho do bloqueado, caminho da página', () => {
  assert.deepEqual(avisosDoCorpo(ANTIGO()), [{ diretiva: 'img-src', acao: 'bloqueou', bloqueado: 'https://img.exemplo.com/a.jpg', pagina: '/feed' }]);
  assert.deepEqual(avisosDoCorpo([NOVO()]), [{ diretiva: 'frame-src', acao: 'bloqueou', bloqueado: 'https://www.youtube.com/embed/abc', pagina: '/home' }]);
});

test('o aviso diz se a política bloqueou (enforce, o site de hoje) ou só bloquearia (report, Report-Only); sem o campo, bloqueou', () => {
  assert.equal(avisosDoCorpo(ANTIGO({ disposition: 'enforce' }))[0].acao, 'bloqueou');
  assert.equal(avisosDoCorpo(ANTIGO({ disposition: 'report' }))[0].acao, 'bloquearia');
  assert.equal(avisosDoCorpo([NOVO({ disposition: 'enforce' })])[0].acao, 'bloqueou');
  assert.equal(avisosDoCorpo([NOVO({ disposition: 'report' })])[0].acao, 'bloquearia');
  assert.equal(avisosDoCorpo(ANTIGO())[0].acao, 'bloqueou');
  assert.equal(avisosDoCorpo(ANTIGO({ disposition: '<lixo>' }))[0].acao, 'bloqueou', 'só duas palavras saem para o log, nunca o texto do aviso');
});

test('nada de query, token do /api/media ou texto solto; data:, blob: e palavras-chave passam limpas', () => {
  const [media] = avisosDoCorpo(ANTIGO({ 'blocked-uri': 'https://motor.run.app/api/media/eyJhbGciOi.SEGREDO.assinatura' }));
  assert.equal(media.bloqueado, 'https://motor.run.app/api/media/…');
  assert.equal(avisosDoCorpo(ANTIGO({ 'blocked-uri': 'data:image/png;base64,AAAA' }))[0].bloqueado, 'data:');
  assert.equal(avisosDoCorpo(ANTIGO({ 'blocked-uri': 'blob:https://futtyapp.com.br/123' }))[0].bloqueado, 'blob:');
  assert.equal(avisosDoCorpo(ANTIGO({ 'blocked-uri': 'inline' }))[0].bloqueado, 'inline');
  assert.equal(avisosDoCorpo(ANTIGO({ 'blocked-uri': 'eval <script>alert(1)</script>' }))[0].bloqueado, 'evalscriptalert1script');
  for (const lixo of [null, 'texto', 42, {}, [{ type: 'deprecation', body: {} }], [{ 'csp-report': 'x' }]]) assert.deepEqual(avisosDoCorpo(lixo), [], JSON.stringify(lixo));
});

test('a rota: 204, uma linha por aviso novo, a mesma linha só volta depois de 10 min', async (t) => {
  const linhas = [];
  let relogio = 1_000_000;
  const { base, fechar } = await subir({ registrar: (l) => linhas.push(l), limite: (req, res, next) => next(), agora: () => relogio });
  t.after(fechar);
  assert.equal((await mandar(base, ANTIGO(), 'application/csp-report')).status, 204);
  assert.equal((await mandar(base, [NOVO()], 'application/reports+json')).status, 204);
  assert.equal((await mandar(base, ANTIGO(), 'application/csp-report')).status, 204);
  assert.deepEqual(linhas, ['[csp] img-src bloqueou https://img.exemplo.com/a.jpg em /feed', '[csp] frame-src bloqueou https://www.youtube.com/embed/abc em /home']);
  assert.ok(!linhas.join(' ').includes('SEGREDO'));
  relogio += 10 * 60 * 1000;
  await mandar(base, ANTIGO(), 'application/csp-report');
  assert.equal(linhas.length, 3, 'depois de 10 min a mesma linha volta');
  assert.equal((await mandar(base, '"só texto"', 'application/csp-report')).status, 204);
  assert.equal(linhas.length, 3);
});

test('os limiters gerais da /api deixam /csp de fora: um site cheio de avisos não gasta a cota de quem usa o app', async (t) => {
  const app = express();
  app.use('/api', ...criarLimitesDaApi({ tokenDoPedido: () => null, sessaoConhecida: () => false, limites: { ...LIMITES, apiPorIp: 1 } }));
  app.post('/api/csp', (req, res) => res.status(204).end());
  app.post('/api/outra', (req, res) => res.status(204).end());
  const { base, fechar } = await ouvir(app);
  t.after(fechar);
  const rajada = async (rota) => { const s = []; for (let i = 0; i < 3; i += 1) s.push((await fetch(`${base}${rota}`, { method: 'POST' })).status); return s; };
  assert.deepEqual(await rajada('/api/csp'), [204, 204, 204]);
  assert.deepEqual(await rajada('/api/outra'), [204, 429, 429], 'a régua: as outras rotas caem no teto por IP');
});

test('no servidor de verdade: sem sessão, 204, e a linha vai para o log', async (t) => {
  const app = await subirApp();
  t.after(() => app.fechar());
  const avisos = [];
  const avisoOriginal = console.warn;
  console.warn = (...a) => { if (String(a[0]).startsWith('[csp]')) avisos.push(a.join(' ')); else avisoOriginal(...a); };
  t.after(() => { console.warn = avisoOriginal; });
  const r = await fetch(`${app.base}/api/csp`, { method: 'POST', headers: { 'content-type': 'application/csp-report', origin: 'https://futtyapp.com.br' }, body: JSON.stringify(ANTIGO({ 'blocked-uri': 'https://um-host-so-deste-teste.com/x.png' })) });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('ratelimit-policy'), `${LIMITES.csp};w=900`, 'o limiter próprio conta este pedido');
  assert.deepEqual(avisos, ['[csp] img-src bloqueou https://um-host-so-deste-teste.com/x.png em /feed']);
});
