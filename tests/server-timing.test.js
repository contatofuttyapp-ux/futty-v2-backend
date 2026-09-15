// Velocidade 6A (15-set) — Server-Timing por fase.
//
// O header já dizia quanto tempo o motor levou (`app;dur`), mas não POR ONDE.
// Agora cada rota quente nomeia as suas fases. Isto tranca o contrato de que o
// Diagnóstico do app depende: `app;dur` existe e é o ÚLTIMO campo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { tempoPorRota, marcarFase, medir } = require('../middleware/tempo');

async function pedir(montarRota) {
  const app = express();
  app.use(tempoPorRota);
  montarRota(app);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/x`);
    return r.headers.get('server-timing');
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const campos = (st) => Object.fromEntries(st.split(', ').map((p) => {
  const [nome, dur] = p.split(';dur=');
  return [nome, Number(dur)];
}));

test('sem fases marcadas, sai só app;dur (como era antes)', async () => {
  const st = await pedir((app) => app.get('/x', (req, res) => res.json({ ok: true })));
  assert.match(st, /^app;dur=[\d.]+$/);
});

test('app;dur é sempre o ÚLTIMO campo (o Diagnóstico do app lê-o)', async () => {
  const st = await pedir((app) => app.get('/x', async (req, res) => {
    marcarFase(res, 'auth');
    await new Promise((r) => setTimeout(r, 20));
    marcarFase(res, 'dados');
    res.json({ ok: true });
  }));
  const partes = st.split(', ');
  assert.match(partes[partes.length - 1], /^app;dur=/, `app;dur não ficou no fim: ${st}`);
});

test('cada fase mede o trecho que ACABOU, e as fases somam o total', async () => {
  const st = await pedir((app) => app.get('/x', async (req, res) => {
    await new Promise((r) => setTimeout(r, 40));
    marcarFase(res, 'auth');
    await new Promise((r) => setTimeout(r, 80));
    marcarFase(res, 'dados');
    res.json({ ok: true });
  }));
  const c = campos(st);
  assert.ok(c.auth >= 35 && c.auth <= 75, `auth devia rondar 40ms, deu ${c.auth}`);
  assert.ok(c.dados >= 70 && c.dados <= 130, `dados devia rondar 80ms, deu ${c.dados}`);
  const soma = c.auth + c.dados + (c.resto || 0);
  assert.ok(Math.abs(soma - c.app) < 5, `as fases (${soma}) não somam o total (${c.app})`);
});

test('medir() cronometra partes em paralelo (sobrepõem-se de propósito)', async () => {
  const st = await pedir((app) => app.get('/x', async (req, res) => {
    const lenta = medir(res, 'lenta', new Promise((r) => setTimeout(r, 80)));
    const rapida = medir(res, 'rapida', new Promise((r) => setTimeout(r, 20)));
    await Promise.all([lenta, rapida]);
    res.json({ ok: true });
  }));
  const c = campos(st);
  assert.ok(c.lenta > c.rapida, 'a parte lenta devia aparecer com mais tempo que a rápida');
  // Correram em paralelo: o total é o da mais lenta, não a soma.
  assert.ok(c.app < c.lenta + c.rapida, 'o total não devia ser a soma de partes paralelas');
});

test('marcarFase e medir não rebentam sem o middleware montado', () => {
  assert.doesNotThrow(() => marcarFase(undefined, 'x'));
  assert.doesNotThrow(() => marcarFase({}, 'x'));
  assert.doesNotThrow(() => medir({}, 'x', Promise.resolve(1)));
});

// ─── Velocidade 7A: o Server-Timing diz quando o motor pagou cache frio ───────

const { criarCache } = require('../utils/cacheQuente');

async function comApp(montarRota, fn) {
  const app = express();
  app.use(tempoPorRota);
  montarRota(app);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const pedirX = async () => (await fetch(`http://127.0.0.1:${server.address().port}/x`)).headers.get('server-timing');
  try {
    return await fn(pedirX);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function rotaComCache(demoraMs) {
  const cache = criarCache({ nome: 'sessao', ttlMs: 60_000 });
  return (app) => app.get('/x', async (req, res) => {
    await cache.obter('token', async () => {
      await new Promise((r) => setTimeout(r, demoraMs));
      return { id: 'u1' };
    });
    res.json({ ok: true });
  });
}

test('cache frio: cache;desc=miss e a espera em cache-<nome>; quente: cache;desc=hit', async () => {
  await comApp(rotaComCache(40), async (pedirX) => {
    const frio = await pedirX();
    assert.match(frio, /(?:^|, )cache;desc=miss(?:,|$)/, `faltou o miss: ${frio}`);
    assert.ok(campos(frio)['cache-sessao'] >= 35, `a espera do cache frio não apareceu: ${frio}`);
    assert.match(frio.split(', ').pop(), /^app;dur=/, 'app;dur deixou de ser o último');

    const quente = await pedirX();
    assert.match(quente, /(?:^|, )cache;desc=hit(?:,|$)/, `faltou o hit: ${quente}`);
    assert.doesNotMatch(quente, /cache-sessao/, 'um acerto não devia aparecer como espera');
  });
});

test('pedidos simultâneos no cache frio: cada um registra a própria espera', async () => {
  await comApp(rotaComCache(60), async (pedirX) => {
    const [a, b] = await Promise.all([pedirX(), pedirX()]);
    for (const st of [a, b]) {
      assert.match(st, /cache;desc=miss/, `um dos pedidos não viu o cache frio: ${st}`);
      assert.ok(campos(st)['cache-sessao'] > 0, st);
    }
  });
});
