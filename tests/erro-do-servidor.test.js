// Futty v2.0 — Arrumação 0, bloco 3 (A1): o erro do banco não chega ao cliente (sem banco, sem rede).
//
// O pentest do ZAP (6-out) viu uma página inteira do WAF, com o IP de saída do motor, voltar no JSON de um 500
// em /api/teams/explorar. Quase toda rota faz `throw new HttpError(500, error.message)`; em vez de mexer em
// 125 lugares, o tratador central (middleware/erros.js) decide pelo status. Aqui se prova:
//   · 5xx responde a frase da casa com ERRO_INTERNO e o texto real só vai para o log (cortado);
//   · 4xx e 502/503/504 (frase escrita por nós, o app lê o `code`) seguem exatamente como eram;
//   · nenhuma rota passa mensagem de variável para um 502/503/504 (senão o banco vazaria por aí);
//   · o server.js usa o tratador, depois do Sentry;
//   · /api/teams/explorar com texto que o WAF recusa → 200 com lista vazia; erro de banco de verdade → 500 genérico.
//
// Uso: npm test  (ou: node --test tests/erro-do-servidor.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { HttpError } = require('../utils/http');
const { tratadorDeErros, corpoDoErro, MENSAGEM_ERRO_INTERNO, CODIGO_ERRO_INTERNO } = require('../middleware/erros');
const { recusaDoWaf } = require('../utils/recusaDoWaf');
const { carregar, subir } = require('./_rotas');

const RAIZ = path.join(__dirname, '..');
const SEGREDO_DO_BANCO = 'relation "public.users_secretas" does not exist (host db.abcdefgh.supabase.co, 34.95.12.7)';
const PAGINA_DO_WAF = `<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>${'Sorry, you have been blocked. '.repeat(150)}Ray ID: 8f2a</body></html>`;

/** Um express com UMA rota que lança o erro dado, e o tratador de verdade por último. */
async function pedirErro(t, lancar, caminho = '/x') {
  const logs = [];
  t.mock.method(console, 'error', (...args) => { logs.push(args.join(' ')); });
  const app = express();
  app.get('/x', (req, res, next) => next(lancar()));
  app.get('/api/media/:token', (req, res, next) => next(lancar()));
  app.use(tratadorDeErros);
  const servidor = app.listen(0);
  t.after(() => servidor.close());
  const r = await fetch(`http://127.0.0.1:${servidor.address().port}${caminho}`);
  return { status: r.status, json: await r.json(), logs };
}

// ─── o tratador ───────────────────────────────────────────────────────────────
test('500 com a mensagem crua do banco: o cliente recebe a frase da casa e ERRO_INTERNO, nunca o texto', async (t) => {
  const r = await pedirErro(t, () => new HttpError(500, SEGREDO_DO_BANCO));
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: MENSAGEM_ERRO_INTERNO, code: CODIGO_ERRO_INTERNO });
  assert.equal(MENSAGEM_ERRO_INTERNO, 'Deu ruim do nosso lado. Tente de novo em instantes.');
  assert.ok(!JSON.stringify(r.json).includes('users_secretas'), 'o nome da tabela não pode estar no corpo');
  assert.ok(!JSON.stringify(r.json).includes('34.95.12.7'), 'o IP não pode estar no corpo');
  assert.ok(r.logs.some((l) => l.includes('users_secretas')), 'o texto real vai para o log');
});

test('erro que não é HttpError (TypeError, falha de rede do cliente do banco) também vira a frase da casa', async (t) => {
  const r = await pedirErro(t, () => new TypeError("Cannot read properties of undefined (reading 'id')"));
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: MENSAGEM_ERRO_INTERNO, code: CODIGO_ERRO_INTERNO });
  assert.ok(r.logs.some((l) => l.includes("reading 'id'")));
});

test('a página inteira do WAF (milhares de caracteres) não vai para o corpo e entra cortada no log', async (t) => {
  const r = await pedirErro(t, () => new HttpError(500, PAGINA_DO_WAF));
  assert.ok(PAGINA_DO_WAF.length > 4000);
  assert.ok(!JSON.stringify(r.json).includes('Cloudflare'));
  assert.deepEqual(r.json, { error: MENSAGEM_ERRO_INTERNO, code: CODIGO_ERRO_INTERNO });
  const linha = r.logs.find((l) => l.includes('Attention Required'));
  assert.ok(linha, 'o começo da página está no log');
  assert.ok(linha.length < 700, `o log não cabe a página inteira (${linha.length})`);
});

test('o log diz a ROTA (o desenho do caminho), nunca o caminho pedido — que pode levar token', async (t) => {
  const r = await pedirErro(t, () => new HttpError(500, 'falhou'), '/api/media/TOKEN-SECRETO-123');
  assert.equal(r.status, 500);
  const linha = r.logs.find((l) => l.includes('falhou'));
  assert.ok(linha.includes('GET /api/media/:token'), linha);
  assert.ok(!linha.includes('TOKEN-SECRETO-123'), linha);
});

test('5xx de HttpError com código próprio (500 com code) também é genérico — o código vem do tratador', async (t) => {
  const r = await pedirErro(t, () => new HttpError(500, 'detalhe interno', 'OUTRO_CODIGO'));
  assert.deepEqual(r.json, { error: MENSAGEM_ERRO_INTERNO, code: CODIGO_ERRO_INTERNO });
});

test('4xx fica como sempre foi: o texto de quem escreveu a rota e o code', async (t) => {
  for (const [status, msg, code] of [[400, 'O nome do time é obrigatório.', null], [403, 'Você não é membro deste time.', 'SEM_TIME'], [404, 'Time não encontrado.', null], [413, 'Arquivo grande demais.', null]]) {
    const r = await pedirErro(t, () => new HttpError(status, msg, code));
    assert.equal(r.status, status);
    assert.deepEqual(r.json, code ? { error: msg, code } : { error: msg });
    assert.deepEqual(r.logs, [], 'erro do cliente não polui o log de erros');
  }
});

test('502/503/504 com frase nossa seguem como eram — o app mostra a frase e escolhe a tela pelo code', async (t) => {
  for (const [status, msg, code] of [
    [503, 'Estamos com procura recorde. Tente de novo mais tarde.', 'TETO_DIARIO_ATINGIDO'],
    [503, 'A geração de figurinha está indisponível agora. Tente de novo mais tarde.', 'IA_INDISPONIVEL'],
    [503, 'Não deu para confirmar sua sessão agora. Tente de novo em instantes.', 'AUTH_INDISPONIVEL'],
    [503, 'Essa opção ainda não está disponível.', null],
    [502, 'Não deu para confirmar com a loja agora. Tente de novo.', 'COMPRAS_INDISPONIVEL'],
    [504, 'Demorou demais. Tente de novo.', null],
  ]) {
    const r = await pedirErro(t, () => new HttpError(status, msg, code));
    assert.equal(r.status, status);
    assert.deepEqual(r.json, code ? { error: msg, code } : { error: msg });
  }
});

test('corpoDoErro: erro sem texto num 4xx cai na frase de sempre', () => {
  assert.deepEqual(corpoDoErro(new HttpError(400, '')), { error: 'Algo deu errado. Tente de novo em instantes.' });
});

// ─── nenhuma rota repassa texto de variável num 502/503/504 ──────────────────
function arquivosJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '_bench' ? [] : arquivosJs(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

test('guarda: nenhum `new HttpError(502|503|504, <variável>)` — esses status levam o texto ao cliente, só frase escrita por nós (CONSTANTE_EM_CAIXA_ALTA vale)', () => {
  const culpados = [];
  for (const dir of ['routes', 'services', 'utils', 'middleware']) {
    for (const arquivo of arquivosJs(path.join(RAIZ, dir))) {
      const fonte = fs.readFileSync(arquivo, 'utf8');
      for (const m of fonte.matchAll(/HttpError\(\s*50[234]\s*,\s*([^\s'"`][^,)]*)/g)) {
        if (/^[A-Z][A-Z0-9_]*$/.test(m[1].trim())) continue; // MSG_AUTH_FORA: constante com a frase escrita no próprio arquivo
        culpados.push(`${path.relative(RAIZ, arquivo)}: ${m[0]}`);
      }
    }
  }
  assert.deepEqual(culpados, [], 'um 502/503/504 com mensagem de variável vazaria o texto do banco; escreva a frase ou use 500');
});

// ─── o server.js usa o tratador, e depois do Sentry ──────────────────────────
test('server.js: o tratador central é o ÚLTIMO middleware e o Sentry vem antes dele', () => {
  const { app } = require('../server');
  const pilha = app.router.stack;
  assert.equal(pilha.at(-1).handle, tratadorDeErros);
  const iSentry = pilha.findIndex((l) => l.handle.name === 'sentryErrorMiddleware');
  assert.ok(iSentry >= 0 && iSentry < pilha.length - 1, 'o Sentry vê o erro (com o texto real) antes de o tratador responder');
});

// ─── /api/teams/explorar ──────────────────────────────────────────────────────
const DONO = '33333333-3333-3333-3333-333333333333';
const TIME = '11111111-1111-1111-1111-111111111111';
const TIME_PUBLICO = { id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde', modo_visibilidade: 'publico_aprovacao', cidade: 'Brasília, DF', localizacao: 'Brasília' };

function cenario(t, falhar) {
  const { carregados, cliente } = carregar({
    teams: [TIME_PUBLICO],
    users: [{ id: DONO, nome: 'Dono' }],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin' }],
  }, ['routes/teams'], { falhar });
  // O Supabase falso não entende o .or() com ilike da busca por texto; aqui ele só precisa deixar a consulta seguir
  // (o que se prova é o destino do ERRO, não o filtro, que o PostgREST de verdade faz).
  const from = cliente.from;
  cliente.from = (tabela) => { const consulta = from(tabela); consulta.or = () => consulta; consulta.ilike = () => consulta; return consulta; };
  return subir([carregados['routes/teams']], t);
}
const wafRecusa = (tabela, op) => (tabela === 'teams' && op === 'select' ? { message: PAGINA_DO_WAF } : null);

test('explorar com texto que o WAF recusa (a;cat /etc/passwd;) → 200 com lista vazia, nunca 500', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const pedir = cenario(t, wafRecusa);
  const r = await pedir('GET', `/api/teams/explorar?q=${encodeURIComponent('a;cat /etc/passwd;')}`, null, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { teams: [] });
  const porLocal = await pedir('GET', `/api/teams/explorar?localizacao=${encodeURIComponent('x; sleep(15)')}`, null, DONO);
  assert.deepEqual([porLocal.status, porLocal.json], [200, { teams: [] }]);
});

test('explorar sem texto digitado e o banco devolvendo a página do WAF → 500 genérico (quem quebrou foi o banco), sem a página', async (t) => {
  t.mock.method(console, 'error', () => {});
  const pedir = cenario(t, wafRecusa);
  const r = await pedir('GET', '/api/teams/explorar', null, DONO);
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: MENSAGEM_ERRO_INTERNO, code: CODIGO_ERRO_INTERNO });
});

test('explorar com texto e erro de banco DE VERDADE (PostgREST, com code) → 500 genérico, sem o texto do banco', async (t) => {
  t.mock.method(console, 'error', () => {});
  const pedir = cenario(t, (tabela, op) => (tabela === 'teams' && op === 'select' ? { code: '42P01', message: SEGREDO_DO_BANCO } : null));
  const r = await pedir('GET', '/api/teams/explorar?q=varzea', null, DONO);
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: MENSAGEM_ERRO_INTERNO, code: CODIGO_ERRO_INTERNO });
  assert.ok(!JSON.stringify(r.json).includes('users_secretas'));
});

test('explorar com texto comum e banco bem segue igual: devolve a lista', async (t) => {
  const pedir = cenario(t, null);
  const r = await pedir('GET', `/api/teams/explorar?q=${encodeURIComponent('Várzea')}`, null, DONO);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.teams.map((x) => x.slug), ['varzea-fc']);
});

test('recusaDoWaf: página HTML ou 403 sem code = recusa; erro do PostgREST (com code) e falha de rede = não', () => {
  assert.equal(recusaDoWaf({ message: PAGINA_DO_WAF }), true);
  assert.equal(recusaDoWaf({ message: '  \n<html><body>blocked</body></html>' }), true);
  assert.equal(recusaDoWaf({ message: 'Forbidden' }, 403), true);
  assert.equal(recusaDoWaf({ code: '42703', message: 'column "x" does not exist' }, 400), false);
  assert.equal(recusaDoWaf({ message: 'TypeError: fetch failed' }, 0), false);
  assert.equal(recusaDoWaf({ message: PAGINA_DO_WAF, code: 'PGRST301' }), false);
  assert.equal(recusaDoWaf(null), false);
});
