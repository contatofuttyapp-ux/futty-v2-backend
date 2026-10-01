// ═══════════════════════════════════════════════════════════════════════════════
// MEDIR A CONTA PESADA (1-out, Rodada 29B, bloco 2, parte B) — tempo, tamanho e idas ao banco por rota.
//
// Sobe o motor (server.js) DENTRO deste processo, numa porta livre, e conta tudo o que ele pede ao Supabase: cada
// `supabase.from()` (uma consulta), cada `supabase.rpc()` e cada chamada ao Storage. Em cada rota, para a conta pesada
// (super-admin, 2 times) e para a leve (1 time), faz 1 pedido FRIO (primeiro da conta, caches do motor vazios) e 5
// QUENTES, e escreve a mediana dos quentes. A conta de prova vem de scripts/_bench/prova-conta-pesada.js.
//
// Só LEITURA (GET). As rotas são as do arranque: Início, /api/me, Resenha, Figurinha (selos), ranking, times.
// Os milissegundos são DESTA máquina até o Supabase de São Paulo — o que não muda de máquina para máquina é o número de
// idas ao banco e o tamanho da resposta; é nesses dois que a parte B mexe.
//
//   node scripts/_bench/medir-conta-pesada.js --etiqueta antes
//   node scripts/_bench/medir-conta-pesada.js --etiqueta depois
//
// Saída: a tabela em markdown no terminal e scripts/_bench/saida-conta-pesada/<etiqueta>.json.
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createClient } = require('@supabase/supabase-js');
const { app, supabase } = require('../../server');
const { chavePublica } = require('../../utils/chavesSupabase');

const SENHA = 'Prova!Pesada29B-2026';
const SLUG_VARZEA = 'prova-r29b-pesada-varzea';
const SLUG_LEVE = 'prova-r29b-leve';
const QUENTES = 5;
const arg = (n, padrao) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : padrao; };
const ETIQUETA = arg('etiqueta', 'medicao');

// ── o contador de idas ao banco ──
const contagem = { consultas: 0, rpc: 0, storage: 0, porTabela: {} };
const zerar = () => { contagem.consultas = 0; contagem.rpc = 0; contagem.storage = 0; contagem.porTabela = {}; };
const from0 = supabase.from.bind(supabase);
supabase.from = (tabela) => { contagem.consultas += 1; contagem.porTabela[tabela] = (contagem.porTabela[tabela] || 0) + 1; return from0(tabela); };
const rpc0 = supabase.rpc.bind(supabase);
supabase.rpc = (...a) => { contagem.rpc += 1; return rpc0(...a); };
const storage0 = supabase.storage.from.bind(supabase.storage);
supabase.storage.from = (bucket) => {
  const b = storage0(bucket);
  return new Proxy(b, { get(alvo, prop) { const v = alvo[prop]; return typeof v === 'function' ? (...a) => { contagem.storage += 1; return v.apply(alvo, a); } : v; } });
};

const mediana = (v) => { const o = [...v].sort((a, b) => a - b); const m = Math.floor(o.length / 2); return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2; };

async function token(email) {
  const anon = createClient(process.env.SUPABASE_URL, chavePublica(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password: SENHA });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  return data.session.access_token;
}

const ROTAS = (slug) => [
  ['/api/me', 'AuthGuard: o 1º pedido de toda abertura'],
  ['/api/inicio', 'Início (1 pedido que junta tudo)'],
  ['/api/feed', 'Resenha (app já publicado: tudo de uma vez)'],
  ['/api/feed?limite=20', 'Resenha (app novo: 1ª página de 20)'],
  ['/api/teams', 'times (menu e chips)'],
  ['/api/me/selos', 'Figurinha: selos'],
  ['/api/brilhantes/estado', 'Figurinha: direito e pedidos'],
  [`/api/teams/${slug}/ranking`, 'Ranking do time'],
];

function resumirTempos(cabecalho) {
  const fase = {};
  for (const parte of String(cabecalho || '').split(',')) {
    const m = parte.trim().match(/^([\w-]+);dur=([\d.]+)/);
    if (m) fase[m[1]] = Math.round(Number(m[2]));
  }
  return fase;
}

async function medir(base, jwt, rota) {
  const pedir = async () => {
    zerar();
    const t0 = process.hrtime.bigint();
    const r = await fetch(`${base}${rota}`, { headers: { Authorization: `Bearer ${jwt}`, 'Accept-Encoding': 'gzip' } });
    const texto = await r.text();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return {
      ms, status: r.status, bytes: Buffer.byteLength(texto), gzip: zlib.gzipSync(texto).length,
      consultas: contagem.consultas, rpc: contagem.rpc, storage: contagem.storage, porTabela: { ...contagem.porTabela },
      fases: resumirTempos(r.headers.get('server-timing')), cache: r.headers.get('cache-control') || null,
    };
  };
  const fria = await pedir();
  const quentes = [];
  for (let i = 0; i < QUENTES; i += 1) quentes.push(await pedir());
  const q = quentes[Math.floor(QUENTES / 2)];
  return {
    rota, status: fria.status, friaMs: Math.round(fria.ms), quenteMs: Math.round(mediana(quentes.map((x) => x.ms))),
    motorMs: mediana(quentes.map((x) => x.fases.app ?? 0)), bytes: q.bytes, gzip: q.gzip,
    consultasFria: fria.consultas, consultas: q.consultas, storage: q.storage, rpc: q.rpc, porTabela: q.porTabela,
    fases: q.fases, cache: q.cache,
  };
}

(async () => {
  const servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const saida = { etiqueta: ETIQUETA, quando: new Date().toISOString(), contas: {} };

  for (const [conta, email, slug] of [['pesada', 'prova-r29b-pesada@futtymock.com', SLUG_VARZEA], ['leve', 'prova-r29b-leve@futtymock.com', SLUG_LEVE]]) {
    const jwt = await token(email);
    saida.contas[conta] = [];
    for (const [rota] of ROTAS(slug)) saida.contas[conta].push(await medir(base, jwt, rota));
  }
  servidor.close();

  const nomes = Object.fromEntries(ROTAS('{slug}').map(([r, d]) => [r.replace(SLUG_VARZEA, '{slug}'), d]));
  console.log(`\n### ${ETIQUETA} — ${saida.quando}\n`);
  console.log('| conta | rota | 1ª (fria) ms | mediana ms | motor ms | JSON bytes | gzip bytes | consultas (fria→quente) | Storage | Cache-Control |');
  console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const [conta, linhas] of Object.entries(saida.contas)) {
    for (const l of linhas) {
      const r = l.rota.replace(SLUG_VARZEA, '{slug}').replace(SLUG_LEVE, '{slug}');
      console.log(`| ${conta} | ${r}${l.status !== 200 ? ` (HTTP ${l.status})` : ''} | ${l.friaMs} | ${l.quenteMs} | ${l.motorMs} | ${l.bytes} | ${l.gzip} | ${l.consultasFria}→${l.consultas} | ${l.storage} | ${l.cache || '—'} |`);
    }
  }
  const inicio = saida.contas.pesada.find((l) => l.rota === '/api/inicio');
  console.log('\nFases do /api/inicio (conta pesada, ms, em paralelo entre si):', JSON.stringify(inicio.fases));
  console.log('Consultas por tabela no /api/inicio (conta pesada):', JSON.stringify(inicio.porTabela));
  void nomes;

  const pasta = path.join(__dirname, 'saida-conta-pesada');
  fs.mkdirSync(pasta, { recursive: true });
  fs.writeFileSync(path.join(pasta, `${ETIQUETA}.json`), JSON.stringify(saida, null, 2));
  process.exit(0);
})().catch((e) => { console.error('[medir-conta-pesada] ERRO:', e.message); process.exit(1); });
