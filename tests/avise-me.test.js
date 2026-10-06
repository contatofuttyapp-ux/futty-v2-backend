// Futty v2.0 — RODADA 29B (F): a lista "Avise-me" (utils/aviseMe.js, routes/aviseMe.js, o limiter e a leitura do Gabinete),
// sem banco e sem rede (Supabase falso em memória).
//
// O que isto prova:
//   1. o e-mail é validado e guardado em minúsculas; a origem é limpa (utm) e cai em "site";
//   2. robô (isca preenchida) recebe "deu certo" e nada é gravado; e-mail repetido responde IGUAL (não dá para descobrir
//      quem está na lista) e não duplica;
//   3. sem a migração 068 a rota responde 503 (não 500) e o Gabinete diz que falta a migração;
//   4. limiter por IP real (CF-Connecting-IP): 10 por hora, o 11º leva 429 — e outro IP não paga pelo primeiro;
//   5. o Gabinete lê a lista inteira (paginada), resume por origem e exporta CSV sem deixar e-mail virar fórmula;
//   6. a rota está montada no server.js, e a tabela entra no backup e no restauro (tem e-mails).
//
// Uso: npm test  (ou: node --test tests/avise-me.test.js)
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { criarSupabaseFalso } = require('./_supabaseFalso');
const {
  normalizarEmail, limparOrigem, validarPedido, tabelaEmFalta, lerTodos, resumir, celulaCsv, montarCsv,
} = require('../utils/aviseMe');
const { criarRotaAviseMe } = require('../routes/aviseMe');
const { criarLimiteDeAviseMe } = require('../middleware/limiters');

const UNICOS = { avisos_lancamento: [['email']] };
const passaAdiante = (_req, _res, next) => next();

async function montar({ linhas = [], falhar = null, limite = passaAdiante } = {}, t) {
  const { cliente, tabelas } = criarSupabaseFalso({ avisos_lancamento: linhas }, { unicos: UNICOS, falhar });
  const app = express();
  app.set('trust proxy', 1); // como o server.js: o endereço que o Google viu vem em X-Forwarded-For
  app.use(express.json());
  app.use(criarRotaAviseMe({ supabase: cliente, limite }));
  const servidor = app.listen(0);
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const pedir = async (corpo, cabecalhos = {}) => {
    const r = await fetch(`${base}/api/avise-me`, { method: 'POST', headers: { 'content-type': 'application/json', ...cabecalhos }, body: JSON.stringify(corpo) });
    return { status: r.status, json: await r.json() };
  };
  return { pedir, tabelas, cliente };
}

// ─── 1. validar ───────────────────────────────────────────────────────────────
test('e-mail: aparado e em minúsculas; a origem é limpa e, vazia, vira "site"', () => {
  assert.equal(normalizarEmail('  Maria.Silva@Gmail.COM '), 'maria.silva@gmail.com');
  assert.equal(normalizarEmail(null), '');
  assert.equal(limparOrigem('Instagram / Bio'), 'instagram / bio');
  assert.equal(limparOrigem('  tiktok:abr<script>  '), 'tiktok:abrscript');
  assert.equal(limparOrigem(''), 'site');
  assert.equal(limparOrigem(undefined), 'site');
  assert.equal(limparOrigem('!!!'), 'site');
  assert.equal(limparOrigem('x'.repeat(200)).length, 60);
});

test('validar: e-mails certos passam; vazio, sem @, sem domínio, com espaço ou separador não', () => {
  for (const ok of ['a@b.co', 'maria.silva+futty@gmail.com', 'joão@exemplo.com.br', 'x_y-z@sub.dominio.pt']) {
    assert.equal(validarPedido({ email: ok }).ok, true, ok);
  }
  const erros = ['', '   ', 'maria', 'maria@', '@gmail.com', 'maria@gmail', 'maria@gmail.', 'ma ria@gmail.com', 'a@b@c.com', 'a,b@c.com', 'a@b.c', 'a..b@c.com', '<a>@b.com', `${'a'.repeat(250)}@b.com`];
  for (const ruim of erros) assert.equal(validarPedido({ email: ruim }).ok, false, `"${ruim}"`);
  assert.equal(validarPedido({ email: '' }).erro, 'Escreva seu e-mail.');
  assert.equal(validarPedido({ email: 'maria@' }).erro, 'Esse e-mail não parece certo. Confira e tente de novo.');
  assert.equal(validarPedido(null).ok, false);
  assert.equal(validarPedido({}).ok, false);
});

test('validar: devolve o e-mail já normalizado e a origem limpa', () => {
  assert.deepEqual(validarPedido({ email: ' Maria@Gmail.com ', origem: 'Instagram' }), { ok: true, email: 'maria@gmail.com', origem: 'instagram' });
  assert.deepEqual(validarPedido({ email: 'a@b.co' }), { ok: true, email: 'a@b.co', origem: 'site' });
});

test('validar: a isca de robô preenchida é ignorada (sem erro, para o robô não aprender)', () => {
  assert.deepEqual(validarPedido({ email: 'a@b.co', site: 'http://spam.example' }), { ok: true, ignorar: true });
  assert.equal(validarPedido({ email: 'a@b.co', site: '   ' }).ignorar, undefined, 'só espaços não é isca');
});

// ─── 2. a rota ────────────────────────────────────────────────────────────────
test('POST guarda o e-mail em minúsculas com a origem e responde 201', async (t) => {
  const { pedir, tabelas } = await montar({}, t);
  const r = await pedir({ email: ' Maria@Gmail.COM ', origem: 'Instagram' });
  assert.deepEqual([r.status, r.json], [201, { ok: true }]);
  assert.equal(tabelas.avisos_lancamento.length, 1);
  assert.deepEqual([tabelas.avisos_lancamento[0].email, tabelas.avisos_lancamento[0].origem], ['maria@gmail.com', 'instagram']);
  assert.deepEqual(Object.keys(tabelas.avisos_lancamento[0]).sort(), ['criada_em', 'email', 'id', 'origem'].sort(), 'só e-mail e origem (o resto é id e data): nada de IP, nome ou aparelho');
});

test('e-mail repetido responde IGUAL (201) e não duplica — a rota não serve para descobrir quem está na lista', async (t) => {
  const { pedir, tabelas } = await montar({}, t);
  const a = await pedir({ email: 'maria@gmail.com' });
  const b = await pedir({ email: 'MARIA@gmail.com', origem: 'tiktok' });
  assert.deepEqual([b.status, b.json], [a.status, a.json]);
  assert.equal(tabelas.avisos_lancamento.length, 1);
  assert.equal(tabelas.avisos_lancamento[0].origem, 'site', 'a primeira origem fica');
});

test('e-mail torto: 400 com a frase da tela e nada gravado', async (t) => {
  const { pedir, tabelas } = await montar({}, t);
  const r = await pedir({ email: 'maria@' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'Esse e-mail não parece certo. Confira e tente de novo.');
  assert.equal((tabelas.avisos_lancamento || []).length, 0);
  assert.equal((await pedir({})).status, 400);
});

test('robô (isca preenchida): 201 "deu certo" e NADA gravado', async (t) => {
  const { pedir, tabelas } = await montar({}, t);
  const r = await pedir({ email: 'robo@spam.com', site: 'https://spam.example' });
  assert.deepEqual([r.status, r.json], [201, { ok: true }]);
  assert.equal((tabelas.avisos_lancamento || []).length, 0);
});

test('sem a migração 068 (tabela não existe): 503 com mensagem digna, não 500', async (t) => {
  const falhar = (tabela) => (tabela === 'avisos_lancamento' ? { message: "Could not find the table 'public.avisos_lancamento' in the schema cache" } : null);
  const { pedir } = await montar({ falhar }, t);
  const r = await pedir({ email: 'a@b.co' });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'Ainda não estamos recebendo e-mails. Tente de novo mais tarde.');
  assert.ok(tabelaEmFalta('relation "public.avisos_lancamento" does not exist'));
  assert.ok(!tabelaEmFalta('connection reset'));
});

test('outro erro do banco: 500 sem vazar a mensagem interna', async (t) => {
  const falhar = (tabela) => (tabela === 'avisos_lancamento' ? { message: 'connection reset by peer' } : null);
  const { pedir } = await montar({ falhar }, t);
  const r = await pedir({ email: 'a@b.co' });
  assert.equal(r.status, 500);
  assert.equal(r.json.error, 'Não deu para anotar agora. Tente de novo.');
  assert.ok(!JSON.stringify(r.json).includes('connection reset'));
});

// ─── 4. limiter ───────────────────────────────────────────────────────────────
test('limiter: 10 por hora por IP real — o 11º leva 429, e outro IP (CF-Connecting-IP) não paga por ele', async (t) => {
  const { pedir } = await montar({ limite: criarLimiteDeAviseMe() }, t);
  // Pela Cloudflare: o edge (X-Forwarded-For) e o IP real em CF-Connecting-IP — só assim o cabeçalho vale (tests/cloudflare-ips.test.js).
  const pelaCloudflare = (ip) => ({ 'x-forwarded-for': '173.245.48.5', 'cf-connecting-ip': ip });
  const doIpA = pelaCloudflare('203.0.113.10');
  for (let i = 1; i <= 10; i += 1) {
    const r = await pedir({ email: `pessoa${i}@exemplo.com` }, doIpA);
    assert.equal(r.status, 201, `pedido ${i}`);
  }
  const barrado = await pedir({ email: 'pessoa11@exemplo.com' }, doIpA);
  assert.equal(barrado.status, 429);
  assert.match(barrado.json.error, /Tente de novo mais tarde/);
  const outroIp = await pedir({ email: 'outra@exemplo.com' }, pelaCloudflare('203.0.113.99'));
  assert.equal(outroIp.status, 201, 'cada IP tem o seu balde (20 celulares no mesmo Wi-Fi é outro problema, o do IP da Cloudflare)');
});

// ─── 5. o Gabinete ────────────────────────────────────────────────────────────
const linhaDe = (n, origem = 'site') => ({ id: `id${n}`, email: `p${n}@exemplo.com`, origem, criado_em: new Date(Date.UTC(2026, 8, 1, 12, n)).toISOString() });

test('lerTodos: lê a lista em páginas, do mais recente ao mais antigo', async () => {
  const { cliente } = criarSupabaseFalso({ avisos_lancamento: [1, 2, 3, 4, 5].map((n) => linhaDe(n)) }, { unicos: UNICOS });
  const { indisponivel, linhas } = await lerTodos(cliente, { pagina: 2 }); // 3 páginas: 2 + 2 + 1
  assert.equal(indisponivel, false);
  assert.deepEqual(linhas.map((l) => l.email), ['p5@exemplo.com', 'p4@exemplo.com', 'p3@exemplo.com', 'p2@exemplo.com', 'p1@exemplo.com']);
});

test('lerTodos: sem a 068 diz "indisponível" (não lança); outro erro lança', async () => {
  const semTabela = criarSupabaseFalso({}, { falhar: () => ({ message: 'relation "avisos_lancamento" does not exist' }) }).cliente;
  assert.deepEqual(await lerTodos(semTabela), { indisponivel: true, linhas: [] });
  const quebrado = criarSupabaseFalso({}, { falhar: () => ({ message: 'connection reset' }) }).cliente;
  await assert.rejects(() => lerTodos(quebrado), /connection reset/);
});

test('resumir: total, por origem (do maior para o menor) e os mais recentes', () => {
  const linhas = [linhaDe(6, 'instagram'), linhaDe(5, 'tiktok'), linhaDe(4, 'instagram'), linhaDe(3, 'site'), linhaDe(2, 'instagram'), linhaDe(1, 'tiktok')];
  const r = resumir(linhas, { recentes: 3 });
  assert.equal(r.total, 6);
  assert.deepEqual(r.por_origem, [{ origem: 'instagram', total: 3 }, { origem: 'tiktok', total: 2 }, { origem: 'site', total: 1 }]);
  assert.deepEqual(r.recentes.map((l) => l.id), ['id6', 'id5', 'id4']);
  assert.deepEqual(resumir([]), { total: 0, por_origem: [], recentes: [] });
});

test('CSV: cabeçalho + uma linha por e-mail, com aspas quando precisa', () => {
  const csv = montarCsv([
    { email: 'a@b.co', origem: 'instagram', criado_em: '2026-09-01T12:00:00.000Z' },
    { email: 'c@d.co', origem: 'campanha, setembro', criado_em: '2026-09-02T12:00:00.000Z' },
  ]);
  assert.equal(csv, 'email,origem,criado_em\r\na@b.co,instagram,2026-09-01T12:00:00.000Z\r\nc@d.co,"campanha, setembro",2026-09-02T12:00:00.000Z\r\n');
  assert.equal(montarCsv([]), 'email,origem,criado_em\r\n');
});

test('CSV: e-mail que começa com = + - @ não vira fórmula na planilha do dono (apóstrofo na frente)', () => {
  assert.equal(celulaCsv('+fulano@exemplo.com'), "'+fulano@exemplo.com");
  assert.equal(celulaCsv('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(celulaCsv('-1@exemplo.com'), "'-1@exemplo.com");
  assert.equal(celulaCsv('@a@b.co'), "'@a@b.co");
  assert.equal(celulaCsv('maria@exemplo.com'), 'maria@exemplo.com');
  assert.equal(celulaCsv('diz "oi"'), '"diz ""oi"""');
});

// ─── 6. fiação ────────────────────────────────────────────────────────────────
test('fiação: a rota está montada no server.js e a tabela entra no backup e no restauro (tem e-mails)', () => {
  const raiz = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  assert.match(server, /require\('\.\/routes\/aviseMe'\)/);
  assert.match(server, /app\.use\(aviseMeRoutes\)/);
  assert.match(fs.readFileSync(path.join(raiz, 'scripts', 'backup-banco.js'), 'utf8'), /'avisos_lancamento'/);
  const { ORDEM_TABELAS } = require('../utils/restauro');
  assert.ok(ORDEM_TABELAS.includes('avisos_lancamento'));
  const gabinete = fs.readFileSync(path.join(raiz, 'routes', 'gabinete.js'), 'utf8');
  assert.match(gabinete, /'\/api\/super\/gabinete\/avise-me',\s*requireSuperAdmin/, 'só o super-admin lê a lista');
});
