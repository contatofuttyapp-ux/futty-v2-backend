// Futty v2.0 — SEGURANÇA · debug desligado: o motor em modo PRODUÇÃO (NODE_ENV=production, o que o Cloud Run roda) não mostra stack trace, não
// loga dado pessoal nem segredo, não tem rota de teste e não abre as facilidades de desenvolvimento.
//
// O app de verdade (tests/_appFalsa.js, `producao: true`) sobre banco, Storage e Auth de mentira — nada de banco real, nada de rede.
//
// Uso: node --test tests/seguranca-debug.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { subirApp } = require('./_appFalsa');
const { criarMundo } = require('./_mundoDeSeguranca');

let app;
before(async () => { app = await subirApp({ producao: true }); });
after(() => app.fechar());

const RAIZ = path.join(__dirname, '..');
const FRASE_DA_CASA = 'Deu ruim do nosso lado. Tente de novo em instantes.';

test('o motor sobe em produção, e o 404 é JSON curto que não repete o caminho pedido', async () => {
  assert.equal(process.env.NODE_ENV, 'production');
  const raiz = await app.pedir('GET', '/');
  assert.equal(raiz.status, 200);
  assert.deepEqual(raiz.json, { name: 'Futty v2.0 API', status: 'running' });
  for (const rota of ['/.env', '/.git/config', '/api/debug', '/api/test', '/api/teste', '/api/admin', '/api/seed', '/swagger', '/api-docs', '/docs', '/metrics', '/actuator/health', '/graphql', '/phpinfo.php', '/server-status', '/api/env', '/api/config', '/console', '/_next/static', '/package.json', '/server.js', '/db/schema.sql', '/uploads/../.env', '/public/../.env']) {
    const r = await app.pedir('GET', rota);
    assert.equal(r.status, 404, `${rota} → ${r.status} ${r.texto.slice(0, 100)}`);
    assert.match(r.cabecalhos.get('content-type'), /application\/json/);
    assert.ok(!r.texto.includes(path.basename(rota)) || path.basename(rota).length < 4, `${rota}: a resposta repete o caminho pedido: ${r.texto}`);
    assert.doesNotMatch(r.texto, /Cannot GET|<html|<pre>|at \w+|node_modules/i);
  }
});

test('os cabeçalhos de produção: nada de X-Powered-By, helmet ligado, nada de versão do servidor', async () => {
  const r = await app.pedir('GET', '/api/health');
  assert.equal(r.cabecalhos.get('x-powered-by'), null);
  assert.equal(r.cabecalhos.get('x-content-type-options'), 'nosniff');
  assert.ok(r.cabecalhos.get('strict-transport-security'), 'HSTS');
  assert.ok(r.cabecalhos.get('x-frame-options') || /frame-ancestors/.test(r.cabecalhos.get('content-security-policy') || ''), 'proteção contra moldura');
  assert.ok(!/express|node|\d+\.\d+\.\d+/i.test(r.cabecalhos.get('server') || ''), `o cabeçalho Server entrega a versão: ${r.cabecalhos.get('server')}`);
  const saude = await app.pedir('GET', '/health');
  assert.equal(saude.status, 200);
  assert.deepEqual(Object.keys(saude.json).sort(), ['service', 'status', 'supabase', 'timestamp', 'uptime']);
  assert.doesNotMatch(saude.texto, /supabase\.co|\.supabase\.|projeto-falso|postgres|version|NODE_ENV|secret|https?:/i);
});

test('um erro de verdade do servidor, em produção: a frase da casa, nunca a mensagem, o stack, o nome da tabela ou o caminho do arquivo', async () => {
  const m = criarMundo(app);
  const original = app.cliente.from;
  const logs = [];
  const logOriginal = console.error;
  console.error = (...args) => { logs.push(args.join(' ')); };
  app.cliente.from = (tabela) => {
    if (tabela === 'team_members') throw new Error('relation "public.team_members" does not exist at /app/node_modules/pg/lib/client.js:526:17 (host db.projeto.supabase.co 34.95.12.7)');
    return original(tabela);
  };
  try {
    const r = await app.pedir('GET', '/api/teams', { token: m.tok.memA });
    assert.ok([200, 500].includes(r.status), `${r.status} ${r.texto}`);
    const dono = await app.pedir('POST', '/api/games', { token: m.tok.admA, corpo: { team_slug: m.A.slug, data: new Date(Date.now() + 86400000).toISOString() } });
    for (const resposta of [r, dono]) {
      assert.doesNotMatch(resposta.texto, /relation|does not exist|node_modules|client\.js|supabase|34\.95|team_members|stack/i, resposta.texto);
      if (resposta.status === 500) assert.deepEqual(resposta.json, { error: FRASE_DA_CASA, code: 'ERRO_INTERNO' });
    }
    assert.ok(logs.some((l) => /team_members/.test(l)) || r.status === 200, 'o texto real do erro vai para o log, não para a resposta');
  } finally {
    app.cliente.from = original;
    console.error = logOriginal;
  }
});

test('o endereço com percentual quebrado e o corpo torto não viram página de erro nem 500: 400 com a frase da casa', async () => {
  const m = criarMundo(app);
  const url = await app.pedir('GET', '/api/teams/%E0%A4%A', { token: m.tok.memA });
  assert.ok([400, 404].includes(url.status), `${url.status} ${url.texto}`);
  assert.doesNotMatch(url.texto, /URIError|decode|at \w+|node_modules/i);
  const corpo = await app.pedir('POST', '/api/games', { token: m.tok.admA, bruto: '{"a":' });
  assert.equal(corpo.status, 400);
  assert.doesNotMatch(corpo.texto, /Unexpected|JSON|position|SyntaxError/);
});

test('em produção o CORS de desenvolvimento está desligado: um IP da rede local não é origem aceita; o site e o app nativo continuam', async () => {
  const pergunta = (origem) => app.pedir('OPTIONS', '/api/health', { cabecalhos: { origin: origem, 'access-control-request-method': 'GET' } });
  for (const origem of ['http://192.168.1.50:5173', 'http://10.0.0.7:5173', 'http://172.20.3.4:5173', 'https://evil.example', 'null']) {
    const r = await pergunta(origem);
    assert.equal(r.cabecalhos.get('access-control-allow-origin'), null, `${origem} foi aceita em produção`);
  }
  for (const origem of ['capacitor://localhost', 'https://localhost']) {
    const r = await pergunta(origem);
    assert.equal(r.cabecalhos.get('access-control-allow-origin'), origem, `${origem} (app nativo) devia ser aceita`);
  }
});

test('nenhuma rota do motor tem cara de teste, debug ou administração do servidor', () => {
  const caminhos = [];
  const andar = (stack) => {
    for (const layer of stack) {
      if (layer.route) caminhos.push(layer.route.path);
      else if (layer.handle && Array.isArray(layer.handle.stack)) andar(layer.handle.stack);
    }
  };
  andar(app.app.router.stack);
  assert.ok(caminhos.length > 150);
  const PALAVRAS = /(^|\/)(debug|test|teste|tests|dev|seed|mock|fixture|swagger|openapi|graphql|metrics|actuator|phpinfo|console|shell|exec|eval|sql|dump|backup|env|config|reset|truncate|wipe|sandbox)(\/|$|-)/i;
  const suspeitas = caminhos.filter((c) => PALAVRAS.test(c));
  assert.deepEqual(suspeitas, [], `rotas com nome de teste/debug: ${suspeitas.join(', ')}`);
});

test('o código do motor: nenhum `debugger`, nenhum console.* que escreva e-mail, token, segredo ou o corpo do pedido, e nada que devolva process.env', () => {
  const arquivos = [];
  const andar = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'tests', 'scripts', 'db', 'docs', 'public'].includes(e.name)) andar(p); } else if (e.name.endsWith('.js')) arquivos.push(p);
    }
  };
  andar(RAIZ);
  assert.ok(arquivos.length > 80);
  const problemas = [];
  // o que um log não pode carregar: a identidade de alguém (e-mail, nome, telefone, nascimento), o que dá acesso (token, segredo, chave, o
  // cabeçalho Authorization, o endpoint de push) ou o corpo inteiro do pedido
  const PROIBIDO = /\b(email|e-mail|telefone|phone|nome_jogador|birthdate|nascimento|authorization|password|senha|secret|segredo|api_?key|p256dh|req\.body|req\.headers|req\.ip|req\.originalUrl)\b|\btoken\b/i;
  for (const arquivo of arquivos) {
    const texto = fs.readFileSync(arquivo, 'utf8');
    const rel = path.relative(RAIZ, arquivo).split(path.sep).join('/');
    if (/\bdebugger\b/.test(texto.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''))) problemas.push(`${rel}: debugger`);
    if (/res\.(json|send)\(\s*process\.env\b/.test(texto)) problemas.push(`${rel}: devolve process.env`);
    for (const m of texto.matchAll(/console\.(log|info|debug|warn|error)\(/g)) {
      // um "console.log(" que está DENTRO de um texto (a mensagem de erro do arranque ensina a gerar o segredo com node -e) não é chamada:
      // aspas ímpares antes dele, na mesma linha
      const antesNaLinha = texto.slice(texto.lastIndexOf('\n', m.index) + 1, m.index);
      if (['\'', '"', '`'].some((q) => (antesNaLinha.split(q).length - 1) % 2 === 1)) continue;
      let i = m.index + m[0].length; let fundo = 1; let aspas = null;
      for (; i < texto.length && fundo > 0; i += 1) {
        const c = texto[i];
        if (aspas) { if (c === '\\') i += 1; else if (c === aspas) aspas = null; continue; }
        if (c === "'" || c === '"' || c === '`') { aspas = c; continue; }
        if (c === '(') fundo += 1; else if (c === ')') fundo -= 1;
      }
      const chamada = texto.slice(m.index, i);
      // o texto fixo da mensagem não conta ("não loga e-mail" é uma frase, não um dado): só o que é interpolado ou passado como valor
      const soValores = chamada.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\$]|\\.|\$(?!\{))*`/g, (s) => (/\$\{/.test(s) ? s : '""'));
      if (PROIBIDO.test(soValores)) problemas.push(`${rel}:${texto.slice(0, m.index).split('\n').length} ${chamada.replace(/\s+/g, ' ').slice(0, 140)}`);
    }
  }
  assert.deepEqual(problemas, [], `logs ou facilidades que não devem existir em produção:\n${problemas.join('\n')}`);
});

test('o log de pedido lento mostra o DESENHO da rota, não o endereço (que leva token de convite, token de mídia, slug e a busca digitada)', async () => {
  const { ondeBateu } = require('../middleware/tempo');
  const pedido = (extra) => ({ method: 'GET', originalUrl: '/api/convite/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed?q=maria', baseUrl: '', route: { path: '/api/convite/:token' }, ...extra });
  assert.equal(ondeBateu(pedido()), 'GET /api/convite/:token');
  assert.equal(ondeBateu(pedido({ route: undefined })), 'GET (sem rota)');
  assert.doesNotMatch(ondeBateu(pedido()), /1b9d6bcd|maria/);
  // e o app inteiro, de ponta a ponta: um pedido lento a /api/convite/<token> não escreve o token no log
  const linhas = [];
  const original = console.log;
  console.log = (...args) => { linhas.push(args.join(' ')); };
  try {
    const m = criarMundo(app);
    const lento = app.cliente.from;
    app.cliente.from = (tabela) => { const b = lento(tabela); return b; };
    await app.pedir('GET', `/api/convite/${m.tokenDoConviteA}?q=maria`, { token: m.tok.fora });
    app.cliente.from = lento;
  } finally {
    console.log = original;
  }
  assert.ok(!linhas.some((l) => /\[tempo\].*(conv-a-|q=maria)/.test(l)), linhas.join(' | '));
});
