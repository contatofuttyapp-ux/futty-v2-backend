// Futty v2.0 — Arrumação 0, bloco 3 (A3): o CF-Connecting-IP só vale quando o pedido veio da Cloudflare (sem rede).
//
// Antes, o balde de rate limit por IP usava o cabeçalho de QUALQUER cliente: quem batia direto na URL pública do
// Cloud Run forjava um valor novo a cada pedido e ganhava um balde novo (o ZAP mediu RateLimit-Remaining 1999 por IP
// falso). Agora o cabeçalho só vale quando o endereço que o Google viu (req.ip, com trust proxy = 1) está nas faixas
// publicadas da Cloudflare (utils/cloudflareIps.js). Aqui se prova:
//   · a lista embutida: faixas v4/v6 certas, bordas das faixas, IPv4 dentro de IPv6, lixo;
//   · ipRealDoPedido: cabeçalho forjado de IP fora da Cloudflare → o balde do req.ip; de IP da Cloudflare → o do cabeçalho;
//   · nos limiters de verdade (geral, mídia, telemetria, avise-me): forjar 20 valores NÃO dá 20 baldes;
//   · o aviso no log, no máximo um por 10 min, para a lista velha não passar em silêncio;
//   · o script que regenera a lista: valida o que a Cloudflare devolve e troca só o trecho entre os marcadores;
//   · nenhum outro arquivo lê o cabeçalho por conta própria.
//
// Uso: npm test  (ou: node --test tests/cloudflare-ips.test.js)
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const {
  ehIpDaCloudflare, ipRealDoPedido, esquecerAvisos, COPIADO_EM, FAIXAS_V4, FAIXAS_V6, INTERVALO_DO_AVISO_MS,
} = require('../utils/cloudflareIps');
const {
  criarLimitesDaApi, criarLimiteDeMidia, criarLimiteDeTelemetria, criarLimiteDeAviseMe, chaveDoPedido,
} = require('../middleware/limiters');
const { lerFaixas, montarBloco, substituirBloco, ABRE, FECHA } = require('../scripts/atualizar-cloudflare-ips');

const RAIZ = path.join(__dirname, '..');
const BORDA = '173.245.48.5'; // dentro de 173.245.48.0/20
const FORA = '198.51.100.7'; // bloco de documentação: nunca é da Cloudflare

/** Um pedido de mentira com o que ipRealDoPedido lê: req.ip e req.get(). */
const pedidoDe = (ip, cabecalhos = {}) => ({ ip, get: (nome) => cabecalhos[nome.toLowerCase()] });

// ─── a lista ──────────────────────────────────────────────────────────────────
test('a lista embutida: data de cópia, 15 faixas IPv4 e 7 IPv6 (as de 6-out), todas CIDR', () => {
  assert.match(COPIADO_EM, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(FAIXAS_V4.length >= 8 && FAIXAS_V6.length >= 3);
  assert.deepEqual(lerFaixas(FAIXAS_V4.join('\n'), 4), FAIXAS_V4);
  assert.deepEqual(lerFaixas(FAIXAS_V6.join('\n'), 6), FAIXAS_V6);
  for (const f of ['173.245.48.0/20', '104.16.0.0/13', '172.64.0.0/13', '131.0.72.0/22']) assert.ok(FAIXAS_V4.includes(f), f);
  for (const f of ['2400:cb00::/32', '2606:4700::/32', '2a06:98c0::/29']) assert.ok(FAIXAS_V6.includes(f), f);
});

test('ehIpDaCloudflare: dentro e na borda das faixas v4 e v6, IPv4 dentro de IPv6, e fora', () => {
  for (const ip of ['173.245.48.5', '173.245.63.255', '104.16.0.1', '104.23.255.255', '172.71.255.255', '131.0.75.255', '2606:4700::1', '2606:4700:ffff::1', '2a06:98c7:ffff::1', '::ffff:173.245.48.5']) {
    assert.equal(ehIpDaCloudflare(ip), true, ip);
  }
  for (const ip of ['173.245.64.0', '173.245.47.255', '104.15.255.255', '104.28.0.0', '172.72.0.0', '131.0.76.0', '2606:4701::1', '2a06:98c8::1', '198.51.100.7', '203.0.113.9', '127.0.0.1', '::1', '10.0.0.1']) {
    assert.equal(ehIpDaCloudflare(ip), false, ip);
  }
});

test('ehIpDaCloudflare: lixo, vazio, undefined e IPv6 com escopo são "não", sem lançar', () => {
  for (const ip of ['', '   ', 'nao-e-ip', '999.1.1.1', '173.245.48.5/20', undefined, null, 'fe80::1%eth0']) {
    assert.equal(ehIpDaCloudflare(ip), false, String(ip));
  }
});

// ─── ipRealDoPedido ───────────────────────────────────────────────────────────
test('cabeçalho forjado por IP FORA da Cloudflare: vale o req.ip (mesmo balde de quem não manda cabeçalho)', () => {
  const avisos = [];
  const opcoes = { agora: () => 0, avisar: (m) => avisos.push(m) };
  esquecerAvisos();
  for (const forjado of ['1.1.1.1', '8.8.8.8', '2001:db8::1', 'qualquer-coisa']) {
    assert.equal(ipRealDoPedido(pedidoDe(FORA, { 'cf-connecting-ip': forjado }), opcoes), FORA);
  }
  assert.equal(chaveDoPedido(pedidoDe(FORA, { 'cf-connecting-ip': '1.1.1.1' })), chaveDoPedido(pedidoDe(FORA)), 'forjar o cabeçalho não muda o balde');
});

test('cabeçalho de IP DA Cloudflare: vale o do cabeçalho — o IP de quem usa o site, não o do edge', () => {
  assert.equal(ipRealDoPedido(pedidoDe(BORDA, { 'cf-connecting-ip': '203.0.113.10' })), '203.0.113.10');
  assert.equal(ipRealDoPedido(pedidoDe('2606:4700::1', { 'cf-connecting-ip': '2001:db8::5' })), '2001:db8::5');
  assert.equal(ipRealDoPedido(pedidoDe(`::ffff:${BORDA}`, { 'cf-connecting-ip': ' 203.0.113.10 ' })), '203.0.113.10', 'espaço em volta não atrapalha');
  assert.notEqual(chaveDoPedido(pedidoDe(BORDA, { 'cf-connecting-ip': '203.0.113.10' })), chaveDoPedido(pedidoDe(BORDA, { 'cf-connecting-ip': '203.0.113.11' })), 'dois visitantes pelo mesmo edge, dois baldes');
});

test('sem cabeçalho, ou da Cloudflare mas com lixo no cabeçalho: vale o req.ip', () => {
  assert.equal(ipRealDoPedido(pedidoDe(FORA)), FORA);
  assert.equal(ipRealDoPedido(pedidoDe(BORDA)), BORDA);
  assert.equal(ipRealDoPedido(pedidoDe(BORDA, { 'cf-connecting-ip': 'nao-e-ip' })), BORDA);
  assert.equal(ipRealDoPedido(pedidoDe(BORDA, { 'cf-connecting-ip': '' })), BORDA);
});

// ─── o aviso ──────────────────────────────────────────────────────────────────
test('o aviso no log: um por 10 min no máximo, com a contagem do que ficou de fora e a pista da lista velha', () => {
  esquecerAvisos();
  const avisos = [];
  let agora = 5_000_000;
  const opcoes = { agora: () => agora, avisar: (m) => avisos.push(m) };
  for (let i = 0; i < 50; i += 1) ipRealDoPedido(pedidoDe(FORA, { 'cf-connecting-ip': `9.9.9.${i}` }), opcoes);
  assert.equal(avisos.length, 1, '50 forjados, um aviso só');
  assert.match(avisos[0], /CF-Connecting-IP ignorado em 1 pedido/);
  assert.match(avisos[0], /198\.51\.100\.7/);
  assert.match(avisos[0], /scripts\/atualizar-cloudflare-ips\.js/);
  assert.ok(avisos[0].includes(COPIADO_EM), 'o aviso diz de quando é a lista');
  agora += INTERVALO_DO_AVISO_MS - 1;
  ipRealDoPedido(pedidoDe(FORA, { 'cf-connecting-ip': '9.9.9.9' }), opcoes);
  assert.equal(avisos.length, 1);
  agora += 1;
  ipRealDoPedido(pedidoDe(FORA, { 'cf-connecting-ip': '9.9.9.9' }), opcoes);
  assert.equal(avisos.length, 2);
  assert.match(avisos[1], /em 51 pedido\(s\)/, 'os 49 que ficaram de fora + o de 9 min 59 s + este entram na conta');
});

test('quem NÃO manda o cabeçalho (o app da loja, direto no Cloud Run) e quem vem da Cloudflare nunca geram aviso', () => {
  esquecerAvisos();
  const avisos = [];
  const opcoes = { agora: () => 0, avisar: (m) => avisos.push(m) };
  ipRealDoPedido(pedidoDe(FORA), opcoes);
  ipRealDoPedido(pedidoDe(BORDA, { 'cf-connecting-ip': '203.0.113.10' }), opcoes);
  assert.deepEqual(avisos, []);
});

// ─── nos limiters de verdade ──────────────────────────────────────────────────
const servidores = [];
after(async () => { await Promise.all(servidores.map((s) => new Promise((r) => s.close(r)))); });
async function subir(montar) {
  const app = express();
  app.set('trust proxy', 1); // como o server.js
  montar(app);
  const servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  servidores.push(servidor);
  return `http://127.0.0.1:${servidor.address().port}`;
}
/** n pedidos seguidos; `cabecalhos(i)` devolve os cabeçalhos do i-ésimo. Devolve os status. */
async function rajada(base, rota, n, cabecalhos = () => ({}), metodo = 'GET') {
  const status = [];
  for (let i = 0; i < n; i += 1) {
    const r = await fetch(`${base}${rota}`, { method: metodo, headers: cabecalhos(i) });
    await r.arrayBuffer();
    status.push(r.status);
  }
  return status;
}
const forjado = (i) => ({ 'cf-connecting-ip': `203.0.113.${i + 1}` }); // direto no Cloud Run: sem o edge, um valor novo por pedido
const pelaCloudflare = (i) => ({ 'x-forwarded-for': BORDA, 'cf-connecting-ip': `203.0.113.${i + 1}` });
const LIM = { janelaMs: 60_000, apiPorIp: 3, apiPorSessao: 2, avatar: 2, midia: 3, telemetria: 3 };

test('limiter geral da /api: forjar um IP novo a cada pedido NÃO escapa do teto; pela Cloudflare cada IP real tem o seu balde', async () => {
  const base = await subir((app) => {
    app.use('/api', ...criarLimitesDaApi({ tokenDoPedido: () => null, sessaoConhecida: () => false, limites: LIM }));
    app.get('/api/ping', (req, res) => res.json({ ok: true }));
  });
  assert.deepEqual(await rajada(base, '/api/ping', 6, forjado), [200, 200, 200, 429, 429, 429], 'o forjado tem um balde só (o do req.ip)');
});

test('limiter geral da /api pela Cloudflare: cada IP real (CF-Connecting-IP) tem o seu balde, o do outro não gasta', async () => {
  const base = await subir((app) => {
    app.use('/api', ...criarLimitesDaApi({ tokenDoPedido: () => null, sessaoConhecida: () => false, limites: LIM }));
    app.get('/api/ping', (req, res) => res.json({ ok: true }));
  });
  assert.deepEqual(await rajada(base, '/api/ping', 6, pelaCloudflare), [200, 200, 200, 200, 200, 200], '6 visitantes diferentes pelo mesmo edge, 6 baldes');
  const mesmo = { 'x-forwarded-for': BORDA, 'cf-connecting-ip': '203.0.113.200' };
  assert.deepEqual(await rajada(base, '/api/ping', 4, () => mesmo), [200, 200, 200, 429], 'o MESMO visitante gasta o próprio balde');
});

test('mídia, telemetria e avise-me (as rotas anônimas que gravam): forjar o cabeçalho não dá balde novo', async () => {
  const base = await subir((app) => {
    app.get('/api/media/x', criarLimiteDeMidia({ limites: LIM }), (req, res) => res.json({ ok: true }));
    app.post('/api/telemetria', criarLimiteDeTelemetria({ limites: LIM }), (req, res) => res.status(204).end());
    app.post('/api/avise-me', criarLimiteDeAviseMe({ max: 3 }), (req, res) => res.status(201).json({ ok: true }));
  });
  assert.deepEqual(await rajada(base, '/api/media/x', 5, forjado), [200, 200, 200, 429, 429]);
  assert.deepEqual(await rajada(base, '/api/telemetria', 5, forjado, 'POST'), [204, 204, 204, 429, 429]);
  assert.deepEqual(await rajada(base, '/api/avise-me', 5, forjado, 'POST'), [201, 201, 201, 429, 429]);
  // E o mesmo cabeçalho pela Cloudflare conta por visitante real.
  assert.deepEqual(await rajada(base, '/api/avise-me', 5, pelaCloudflare, 'POST'), [201, 201, 201, 201, 201]);
});

// ─── o script que regenera a lista ────────────────────────────────────────────
test('lerFaixas (script): aceita uma lista boa (com CRLF e linhas em branco) e recusa o que não é CIDR da família', () => {
  assert.deepEqual(lerFaixas('173.245.48.0/20\r\n\r\n103.21.244.0/22\n', 4), ['173.245.48.0/20', '103.21.244.0/22']);
  assert.deepEqual(lerFaixas('2400:cb00::/32\n', 6), ['2400:cb00::/32']);
  for (const [texto, familia] of [['<html>erro</html>', 4], ['173.245.48.0', 4], ['173.245.48.0/33', 4], ['2400:cb00::/32', 4], ['173.245.48.0/20', 6], ['1.2.3.4/20/3', 4], ['999.1.1.1/8', 4], ['2400:cb00::/129', 6]]) {
    assert.throws(() => lerFaixas(texto, familia), /não é um CIDR/, texto);
  }
});

test('substituirBloco (script): troca só o trecho entre os marcadores e guarda o fim de linha do arquivo', () => {
  const bloco = montarBloco({ v4: ['1.2.3.0/24'], v6: ['2001:db8::/32'], data: '2030-01-02' });
  assert.ok(bloco.startsWith(ABRE) && bloco.endsWith(FECHA));
  assert.ok(bloco.includes("const COPIADO_EM = '2030-01-02';") && bloco.includes("'1.2.3.0/24',") && bloco.includes("'2001:db8::/32',"));
  const lf = `antes\n${ABRE} — velho\nconst COPIADO_EM = 'x';\n${FECHA}\ndepois\n`;
  const saidaLf = substituirBloco(lf, bloco);
  assert.ok(saidaLf.startsWith('antes\n') && saidaLf.endsWith('\ndepois\n') && !saidaLf.includes('velho') && !saidaLf.includes('\r'));
  const saidaCrlf = substituirBloco(lf.replace(/\n/g, '\r\n'), bloco);
  assert.ok(saidaCrlf.startsWith('antes\r\n') && saidaCrlf.endsWith('\r\ndepois\r\n'));
  assert.equal(saidaCrlf.replace(/\r\n/g, '\n'), saidaLf);
  assert.throws(() => substituirBloco('sem marcadores', bloco), /marcadores/);
});

test('o arquivo da lista é exatamente o que o script gera a partir dela (rodar o script sem mudança na Cloudflare não muda nada)', () => {
  const fonte = fs.readFileSync(path.join(RAIZ, 'utils', 'cloudflareIps.js'), 'utf8');
  assert.equal(substituirBloco(fonte, montarBloco({ v4: FAIXAS_V4, v6: FAIXAS_V6, data: COPIADO_EM })), fonte);
});

// ─── ninguém mais lê o cabeçalho ──────────────────────────────────────────────
function arquivosJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === '_bench' ? [] : arquivosJs(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

test('guarda: só utils/cloudflareIps.js lê o cabeçalho cf-connecting-ip (as rotas anônimas passam por chaveDoPedido)', () => {
  const culpados = [];
  for (const dir of ['routes', 'services', 'utils', 'middleware']) {
    for (const arquivo of arquivosJs(path.join(RAIZ, dir))) {
      if (path.basename(arquivo) === 'cloudflareIps.js') continue;
      if (/(get|header)\s*[(\[]\s*['"`]cf-connecting-ip/i.test(fs.readFileSync(arquivo, 'utf8'))) culpados.push(path.relative(RAIZ, arquivo));
    }
  }
  if (/(get|header)\s*[(\[]\s*['"`]cf-connecting-ip/i.test(fs.readFileSync(path.join(RAIZ, 'server.js'), 'utf8'))) culpados.push('server.js');
  assert.deepEqual(culpados, []);
});

test('guarda: o comentário "de olhos abertos" (risco aceito) saiu do limiter', () => {
  const fonte = fs.readFileSync(path.join(RAIZ, 'middleware', 'limiters.js'), 'utf8');
  assert.ok(!/olhos abertos|risco aceito/i.test(fonte));
});
