// Futty v2.0 — Arrumação 0, bloco 3 (A2): GET /health barato e atrás do limiter (sem banco, sem rede).
//
// O /health é público e fica FORA de /api. Antes, cada chamada fazia um count 'exact' na tabela users (~210 ms) e
// devolvia o texto de erro do Supabase se falhasse: quem martelasse a URL do Cloud Run martelava o banco. Agora:
//   · o banco é conferido no máximo uma vez a cada 30 s (100 chamadas seguidas ou ao mesmo tempo = 1 consulta);
//   · a conferência é count 'planned' (a estimativa, não a contagem);
//   · a resposta traz o mesmo de sempre (status, service, timestamp, uptime, supabase) e NUNCA o texto de erro;
//   · o server.js põe o /health nos mesmos baldes do limiter geral da /api.
//
// Uso: npm test  (ou: node --test tests/saude.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { criarSaude, TTL_DO_BANCO_MS } = require('../utils/saude');
const { app: appReal, supabase: supabaseReal } = require('../server');

/** Um supabase que só conta quantas vezes foi consultado e com que opções. */
function bancoContador({ erro = null, lancar = null, demoraMs = 0 } = {}) {
  const banco = {
    consultas: [],
    from(tabela) {
      return {
        select: async (colunas, opcoes) => {
          banco.consultas.push({ tabela, colunas, opcoes });
          if (demoraMs) await new Promise((r) => setTimeout(r, demoraMs));
          if (lancar) throw lancar;
          return { error: erro, count: 42 };
        },
      };
    },
  };
  return banco;
}

async function subirSaude(t, opcoes) {
  const app = express();
  app.get('/health', criarSaude(opcoes));
  const servidor = app.listen(0);
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;
  return async () => {
    const r = await fetch(`${base}/health`);
    return { status: r.status, json: await r.json() };
  };
}

test('100 chamadas seguidas tocam o banco UMA vez, e a conferência é count "planned"', async (t) => {
  const supabase = bancoContador();
  const chamar = await subirSaude(t, { supabase });
  for (let i = 0; i < 100; i += 1) {
    const r = await chamar();
    assert.equal(r.status, 200);
  }
  assert.equal(supabase.consultas.length, 1);
  assert.deepEqual(supabase.consultas[0].opcoes, { count: 'planned', head: true });
});

test('100 chamadas AO MESMO TEMPO com o banco lento: quem chega com a conferência em curso espera a mesma', async (t) => {
  const supabase = bancoContador({ demoraMs: 80 });
  const chamar = await subirSaude(t, { supabase });
  const respostas = await Promise.all(Array.from({ length: 100 }, () => chamar()));
  assert.equal(supabase.consultas.length, 1);
  assert.ok(respostas.every((r) => r.json.supabase === 'connected'));
});

test('a resposta é a de sempre: status ok, serviço, hora, uptime e supabase: connected', async (t) => {
  const chamar = await subirSaude(t, { supabase: bancoContador() });
  const { json } = await chamar();
  assert.equal(json.status, 'ok');
  assert.equal(json.service, 'futty-backend');
  assert.equal(json.supabase, 'connected');
  assert.ok(Number.isFinite(json.uptime) && json.uptime >= 0);
  assert.ok(!Number.isNaN(Date.parse(json.timestamp)));
  assert.deepEqual(Object.keys(json).sort(), ['service', 'status', 'supabase', 'timestamp', 'uptime']);
});

test('passados 30 s, a próxima chamada confere de novo (e só ela)', async (t) => {
  let agora = 1_000_000;
  const supabase = bancoContador();
  const chamar = await subirSaude(t, { supabase, agora: () => agora });
  await chamar();
  agora += TTL_DO_BANCO_MS - 1;
  await chamar();
  assert.equal(supabase.consultas.length, 1, 'aos 29,999 s ainda vale a conferência guardada');
  agora += 1;
  await chamar();
  assert.equal(supabase.consultas.length, 2, 'aos 30 s confere de novo');
  await chamar();
  assert.equal(supabase.consultas.length, 2);
  assert.equal(TTL_DO_BANCO_MS, 30_000);
});

test('banco com erro: supabase "error", sem o texto do banco na resposta; o texto vai para o log (uma vez por conferência)', async (t) => {
  const erros = [];
  t.mock.method(console, 'error', (...args) => { erros.push(args.join(' ')); });
  const supabase = bancoContador({ erro: { message: 'relation "public.users" does not exist (db.abcdefgh.supabase.co)' } });
  const chamar = await subirSaude(t, { supabase });
  const r = await chamar();
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'ok');
  assert.equal(r.json.supabase, 'error');
  assert.ok(!('supabaseError' in r.json));
  assert.ok(!JSON.stringify(r.json).includes('abcdefgh'));
  await chamar();
  await chamar();
  assert.equal(erros.length, 1, 'o log não enche: o erro é registrado quando se confere, não a cada chamada');
  assert.ok(erros[0].includes('db.abcdefgh.supabase.co'));
});

test('banco que lança (rede caiu): supabase "error", sem o texto na resposta', async (t) => {
  t.mock.method(console, 'error', () => {});
  const chamar = await subirSaude(t, { supabase: bancoContador({ lancar: new TypeError('fetch failed: ECONNRESET 34.95.12.7:443') }) });
  const { status, json } = await chamar();
  assert.equal(status, 200);
  assert.equal(json.supabase, 'error');
  assert.ok(!JSON.stringify(json).includes('34.95.12.7'));
});

// ─── o server.js de verdade ───────────────────────────────────────────────────
test('server.js: o /health passa pelo limiter geral (RateLimit-* na resposta, e o balde desce a cada chamada) e nunca tem supabaseError', async (t) => {
  // O cliente real do motor, trocado por um falso só neste teste: nada de rede.
  const original = supabaseReal.from;
  const supabase = bancoContador({ erro: { message: 'segredo do banco' } });
  supabaseReal.from = supabase.from.bind(supabase);
  t.after(() => { supabaseReal.from = original; });
  t.mock.method(console, 'error', () => {});

  const servidor = appReal.listen(0);
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const restante = (r) => Number(/remaining=(\d+)/.exec(r.headers.get('ratelimit') || '')?.[1] ?? r.headers.get('ratelimit-remaining'));
  // O IP de teste é só deste arquivo: o balde de outros testes não conta aqui.
  const cabecalhos = { 'x-forwarded-for': '198.51.100.77' };
  const a = await fetch(`${base}/health`, { headers: cabecalhos });
  const b = await fetch(`${base}/health`, { headers: cabecalhos });
  assert.equal(a.status, 200);
  assert.ok(a.headers.get('ratelimit') || a.headers.get('ratelimit-remaining'), 'sem cabeçalho RateLimit o limiter não está no caminho');
  assert.equal(restante(b), restante(a) - 1, 'a segunda chamada gastou uma do mesmo balde');
  const corpo = await b.json();
  assert.equal(corpo.supabase, 'error');
  assert.ok(!('supabaseError' in corpo));
  assert.ok(!JSON.stringify(corpo).includes('segredo do banco'));
  assert.equal(supabase.consultas.length, 1, 'duas chamadas ao /health real, uma consulta');
});
