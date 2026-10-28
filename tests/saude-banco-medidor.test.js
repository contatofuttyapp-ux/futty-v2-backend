// Futty v2.0 — o medidor do banco (utils/saudeBanco.js) com o cliente do Supabase DE VERDADE (supabase-js), falando com um servidor
// local que responde como a borda do Supabase (cf-ray com o datacenter, sb-gateway-version, tempo do upstream, um cookie e o eco da
// chave). Prova que: o medidor vê cada ida pelo fetch do motor, sabe se ela foi pelo agente quente, lê o datacenter do cf-ray, devolve
// só os cabeçalhos da lista (nunca a chave, o cookie ou o eco) e não escreve nada. E que ele DENUNCIA um cliente sem a ligação quente.
//
// Uso: node --test tests/saude-banco-medidor.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createClient } = require('@supabase/supabase-js');
const { fetchComLigacaoQuente, OCIOSA_MS } = require('../utils/ligacaoQuente');
const { medirBanco, linhaDoArranque, medirNoArranque } = require('../utils/saudeBanco');

const CHAVE = 'chave-de-teste-que-nao-pode-vazar';
let servidor;
let url;
const pedidos = [];

before(async () => {
  await fetch('data:,aquece'); // o despachante global nasce no primeiro fetch do processo
  servidor = http.createServer((req, res) => {
    pedidos.push({ metodo: req.method, caminho: req.url.split('?')[0] });
    res.writeHead(200, {
      'content-type': 'application/json',
      'cf-ray': '8f00aa11bb22cc33-GRU',
      server: 'cloudflare',
      'sb-gateway-version': '1',
      'x-kong-upstream-latency': '3',
      'x-sb-region': 'sa-east-1',
      'set-cookie': 'sessao=segredo; HttpOnly',
      'x-eco-apikey': String(req.headers.apikey || ''),
      'x-eco-authorization': String(req.headers.authorization || ''),
    });
    res.end('[{"id":"u1"}]');
  });
  await new Promise((r) => { servidor.listen(0, '127.0.0.1', r); });
  url = `http://127.0.0.1:${servidor.address().port}`;
});
after(() => new Promise((r) => { servidor.closeAllConnections?.(); servidor.close(r); }));

const clienteDasRotas = () => createClient(url, CHAVE, { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: fetchComLigacaoQuente } });

test('pelo cliente das rotas: 5 + 5 pings pelo agente quente, datacenter GRU, só os cabeçalhos da lista, nenhuma escrita', async () => {
  pedidos.length = 0;
  const r = await medirBanco({ supabase: clienteDasRotas(), url });
  assert.equal(r.dns.ip, '127.0.0.1');
  assert.equal(typeof r.tcp_tls.tcp_ms, 'number');
  assert.equal(r.tcp_tls.tls_ms, null, 'http local não tem TLS');
  assert.equal(r.ping_x5.ms.length, 5);
  assert.deepEqual(r.ping_x5.pelo_agente_quente, [true, true, true, true, true]);
  assert.deepEqual(r.ping_x5_paralelo.pelo_agente_quente, [true, true, true, true, true]);
  assert.equal(r.despachante.estado, 'quente');
  assert.equal(r.despachante.agente_quente, true);
  assert.equal(r.despachante.global_e_o_quente, false);
  assert.equal(r.despachante.mesma_classe_do_global, true);
  assert.equal(r.despachante.ociosa_ms, OCIOSA_MS);
  assert.equal(r.despachante.ociosa_do_global_ms, 4000);
  assert.ok(r.despachante.ligacoes_com_o_supabase.abertas >= 1, JSON.stringify(r.despachante));
  assert.equal(r.cabecalhos.colo, 'GRU');
  assert.equal(r.cabecalhos['cf-ray'], '8f00aa11bb22cc33-GRU');
  assert.equal(r.cabecalhos['sb-gateway-version'], '1');
  assert.equal(r.cabecalhos['x-sb-region'], 'sa-east-1');
  assert.equal(r.cabecalhos.tempos_da_borda['x-kong-upstream-latency'].length, 10);
  assert.equal(r.consulta_real, undefined, 'sem pessoa não há consulta real');

  const texto = JSON.stringify(r);
  assert.ok(!texto.includes(CHAVE), 'a chave vazou');
  assert.doesNotMatch(texto, /set-cookie|segredo|x-eco|authorization|apikey/i);
  // 10 leituras de users, nenhuma escrita.
  assert.equal(pedidos.length, 10);
  assert.ok(pedidos.every((p) => p.metodo === 'GET' && p.caminho === '/rest/v1/users'), JSON.stringify(pedidos));
  console.log(`# medidor no local (cliente de verdade, servidor local): ${texto}`);
});

test('um cliente que NÃO usa o fetch da ligação quente é denunciado: despachante=padrao, nenhum ping pelo agente', async () => {
  const semLigacaoQuente = createClient(url, CHAVE, { auth: { autoRefreshToken: false, persistSession: false } });
  const r = await medirBanco({ supabase: semLigacaoQuente, url });
  assert.equal(r.despachante.estado, 'padrao');
  assert.deepEqual(r.ping_x5.pelo_agente_quente, [false, false, false, false, false]);
  assert.equal(r.cabecalhos.colo, null, 'sem o fetch do motor não há como ver os cabeçalhos');
});

test('a linha do arranque: dns, tls, os 5 pings, o paralelo, o datacenter e o despachante numa linha só', async () => {
  const linhas = [];
  await medirNoArranque({ supabase: clienteDasRotas(), url, log: (l) => linhas.push(l) });
  assert.equal(linhas.length, 1);
  assert.match(linhas[0], /^\[saude-banco\] dns=[\d.]+ms tls=[\d.]+ms ping=\[[\d.]+(,[\d.]+){4}\] paralelo=[\d.]+ms colo=GRU despachante=quente ligacoes=\d+$/);
  assert.ok(!linhas[0].includes(CHAVE));
  console.log(`# ${linhas[0]}`);
  assert.equal(linhaDoArranque({}), '[saude-banco] dns=? tls=? ping=[] paralelo=? colo=? despachante=? ligacoes=?');
});

test('no arranque, um banco que não responde vira "não mediu" dentro do prazo total, sem segurar o processo', async () => {
  const pendurado = { from: () => ({ select: () => ({ limit: () => new Promise(() => {}) }) }) };
  const linhas = [];
  const de = Date.now();
  await medirNoArranque({ supabase: pendurado, url, log: (l) => linhas.push(l), prazoMs: 300 });
  assert.ok(Date.now() - de < 1500, `esperou ${Date.now() - de} ms`);
  assert.deepEqual(linhas, ['[saude-banco] não mediu: falhou']);
});
