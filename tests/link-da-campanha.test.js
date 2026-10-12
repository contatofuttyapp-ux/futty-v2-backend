// Futty v2.0 — Rodada 30N (5): o link da campanha de anúncio é validado também no MOTOR. Só http(s) (e um caminho do próprio app, "/planos");
// `javascript:`, `data:`, `file:`, `vbscript:` e o resto são recusados na gravação, com a frase da casa. O app já ignora o que não é http(s)
// (frontend/src/utils/linkDoAnuncio.js); aqui o motor se recusa a guardar.
//
// Uso: node --test tests/link-da-campanha.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_appFalsa');
const { criarMundo } = require('./_mundoDeSeguranca');

let app;
before(async () => { app = await subirApp(); });
after(() => app.fechar());

const HTTP = /^Campanha.*: o link precisa começar com http:\/\/ ou https:\/\/\.$/;

// O módulo do motor só entra DEPOIS de a bancada subir (ela prepara o ambiente; antes disso o utils/db recusa a falta de chave).
const validarLinkDaCampanha = (...args) => require('../utils/gabineteStore').validarLinkDaCampanha(...args);

test('validarLinkDaCampanha: http(s), caminho do app e vazio passam; o resto leva 400 com a frase da casa', () => {
  assert.equal(validarLinkDaCampanha('https://exemplo.com.br/oferta?ref=futty#topo'), 'https://exemplo.com.br/oferta?ref=futty#topo');
  assert.equal(validarLinkDaCampanha('  http://exemplo.com  '), 'http://exemplo.com', 'aparado');
  assert.equal(validarLinkDaCampanha('HTTPS://EXEMPLO.COM'), 'HTTPS://EXEMPLO.COM', 'o esquema vale em maiúsculas');
  assert.equal(validarLinkDaCampanha('/planos'), '/planos', 'caminho do próprio app');
  for (const vazio of ['', '   ', null, undefined]) assert.equal(validarLinkDaCampanha(vazio), '');

  const recusados = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(document.cookie)', '\tjavascript:alert(1)', 'java\nscript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)', 'file:///C:/Windows/win.ini', 'blob:https://exemplo.com/abc', 'ftp://exemplo.com/arquivo',
    'about:blank', 'mailto:alguem@exemplo.com', 'intent://exemplo#Intent;scheme=https;end', 'capacitor://localhost/', 'chrome://settings',
    '//exemplo.com/oferta', '/\\exemplo.com', '\\\\exemplo.com\\share',
    'exemplo.com/oferta', 'www.exemplo.com', 'não é um link', 'https://',
  ];
  for (const link of recusados) {
    assert.throws(() => validarLinkDaCampanha(link, 'Oferta'), (e) => e.status === 400 && HTTP.test(e.message), `devia recusar: ${JSON.stringify(link)}`);
  }
  assert.throws(() => validarLinkDaCampanha(42, 'Oferta'), (e) => e.status === 400 && /precisa ser um endereço de texto/.test(e.message));
  assert.throws(() => validarLinkDaCampanha({ href: 'https://x.com' }), (e) => e.status === 400);
  assert.throws(() => validarLinkDaCampanha(`https://exemplo.com/${'a'.repeat(2100)}`), (e) => e.status === 400 && /longo demais/.test(e.message));
  assert.throws(() => validarLinkDaCampanha('javascript:1', 'x'.repeat(500)), (e) => e.message.length < 200, 'o nome da campanha na frase tem teto');
});

function superDoMundo() {
  const m = criarMundo(app);
  const dono = { id: '5ab00000-0000-4000-8000-0000000000aa', nome: 'Dono', nome_jogador: 'Dono', email: 'dono@futtymock.com', is_super_admin: true };
  app.tabelas.users.push(dono);
  return { m, token: app.abrirSessao(dono) };
}
const campanha = (extra = {}) => ({ id: 'c1', nome: 'Oferta de Teste', anunciante: 'Loja', texto: 'Oi', sub: 'Loja', cta: 'Ver', link: 'https://exemplo.com/oferta', cls: 'livre', inicio: '', fim: '', paginas: { inicio: true }, estado: 'ativa', ...extra });

test('PUT /api/super/gabinete/operacao: a campanha com link http(s) grava; com javascript:/data: leva 400 e NADA é gravado', async () => {
  const { token } = superDoMundo();
  const ok = await app.pedir('PUT', '/api/super/gabinete/operacao', { token, corpo: { campanhas: [campanha()] } });
  assert.equal(ok.status, 200, ok.texto);
  assert.equal(ok.json.campanhas[0].link, 'https://exemplo.com/oferta');

  const guardado = () => JSON.stringify([...app.storage.buckets].map(([n, b]) => [n, [...b.arquivos].map(([c, a]) => [c, a.corpo.toString('base64')])]));
  const antes = guardado();
  for (const link of ['javascript:alert(document.cookie)', 'data:text/html,<script>alert(1)</script>', '//evil.test/x', 'vbscript:x']) {
    const r = await app.pedir('PUT', '/api/super/gabinete/operacao', { token, corpo: { campanhas: [campanha(), campanha({ id: 'c2', nome: 'Boa Oferta', link })] } });
    assert.equal(r.status, 400, `${link}: ${r.texto}`);
    assert.match(r.json.error, HTTP);
    assert.match(r.json.error, /Boa Oferta/, 'a frase diz QUAL campanha tem o link ruim');
  }
  assert.equal(guardado(), antes, 'a gravação recusada não mexeu em nada');
  const lido = await app.pedir('GET', '/api/super/gabinete/operacao', { token });
  assert.equal(lido.json.campanhas.length, 1);
  assert.equal(lido.json.campanhas[0].link, 'https://exemplo.com/oferta');
});

test('PUT /api/super/gabinete/operacao: link vazio, ausente e caminho do app seguem valendo; o link volta aparado', async () => {
  const { token } = superDoMundo();
  const { link, ...semLink } = campanha();
  const r = await app.pedir('PUT', '/api/super/gabinete/operacao', {
    token,
    corpo: { campanhas: [campanha({ id: 'a', link: '' }), { ...semLink, id: 'b' }, campanha({ id: 'c', link: '  /planos  ' }), campanha({ id: 'd', link: ' https://exemplo.com ' })] },
  });
  assert.equal(r.status, 200, r.texto);
  assert.deepEqual(r.json.campanhas.map((c) => c.link), ['', undefined, '/planos', 'https://exemplo.com']);
});

test('quem não é a super continua levando 403 (a validação não abre porta nenhuma)', async () => {
  const m = criarMundo(app);
  const r = await app.pedir('PUT', '/api/super/gabinete/operacao', { token: m.tok.admA, corpo: { campanhas: [campanha({ link: 'javascript:1' })] } });
  assert.equal(r.status, 403);
});

test('GET /api/ads: uma campanha que JÁ estava gravada com link perigoso (antes da trava) sai sem link; a de http(s) sai com ele', async () => {
  const { m } = superDoMundo();
  const gravar = (link) => {
    const operacao = { campanhas: [campanha({ link, paginas: ['inicio'] })], ads_ativo: true, toggles: { inicio: true }, cobertura: {}, custos_fixos: [], registros: [], acessos: [], seguranca_manual: {}, protecao_dados: {}, cambio_usd_eur: 0.92 };
    return operacao;
  };
  // grava direto no arquivo da operação (como se fosse de antes da trava) e lê pelo serviço de anúncios
  const gabineteStore = require('../utils/gabineteStore');
  const { obterAd } = require('../services/inicio');
  for (const [link, esperado] of [['javascript:alert(1)', null], ['data:text/html,x', null], ['https://exemplo.com/oferta', 'https://exemplo.com/oferta'], ['', null]]) {
    const original = gabineteStore.ler;
    gabineteStore.ler = async () => gravar(link);
    try {
      const { ad } = await obterAd('inicio', m.p.admA.id);
      assert.ok(ad, `a campanha devia ser servida (${link})`);
      assert.equal(ad.link, esperado, `link servido para "${link}"`);
    } finally { gabineteStore.ler = original; }
  }
});
