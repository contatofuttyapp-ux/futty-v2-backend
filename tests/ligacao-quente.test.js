// Futty v2.0 — a ligação com o Supabase sobrevive aos 4 s de folga entre uma tela e outra (utils/ligacaoQuente.js).
//
// Um servidor local que responde como o Supabase atrás da Cloudflare: `Connection: keep-alive` SEM o `Keep-Alive: timeout=…`. Dois
// pedidos com 4,6 s entre eles: o fetch padrão do Node joga a ligação fora aos 4 s e abre outra; o do cliente do Supabase reaproveita.
//
// Uso: npm test  (ou: node --test tests/ligacao-quente.test.js)  — ~10 s, por causa das duas esperas.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { fetchComLigacaoQuente, OCIOSA_MS } = require('../utils/ligacaoQuente');

const FOLGA_MS = 4600;
const esperar = (ms) => new Promise((r) => { setTimeout(r, ms); });

function servidorComoOSupabase() {
  let ligacoes = 0;
  const abertas = new Set();
  const srv = net.createServer((s) => {
    ligacoes += 1;
    abertas.add(s);
    s.on('data', () => s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok'));
    s.on('error', () => {});
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}/rest/v1/x`, ligacoes: () => ligacoes, fechar: () => new Promise((r) => { for (const a of abertas) a.destroy(); srv.close(r); }) }));
  });
}

async function doisPedidosComFolga(meuFetch) {
  const s = await servidorComoOSupabase();
  try {
    assert.equal(await (await meuFetch(s.url)).text(), 'ok');
    await esperar(FOLGA_MS);
    assert.equal(await (await meuFetch(s.url)).text(), 'ok');
    return s.ligacoes();
  } finally {
    await s.fechar();
  }
}

test('a folga é maior que a do fetch padrão e menor que meia hora', () => {
  assert.ok(OCIOSA_MS > FOLGA_MS && OCIOSA_MS <= 60_000);
});

test('o fetch padrão abre uma ligação nova depois de 4 s parado (é o que acontecia com o Supabase)', async () => {
  await fetch('data:,aquece'); // o despachante global nasce no primeiro fetch
  assert.equal(await doisPedidosComFolga((u) => fetch(u)), 2);
});

test('o fetch do cliente do Supabase reaproveita a mesma ligação depois de 4,6 s parado', async () => {
  await fetch('data:,aquece');
  assert.equal(await doisPedidosComFolga(fetchComLigacaoQuente), 1);
});
