// Futty v2.0 — Cada ida ao banco de um pedido, com hora de saída e de volta: onde vai o tempo do /api/inicio e do /api/feed.
//
// O Server-Timing diz QUANTO o motor levou e qual parte foi a lenta; não diz QUANTAS idas ao banco foram nem quantas delas
// esperaram umas pelas outras. É isso que pesa: com o banco a ~30 ms, três idas em fila custam 90 ms e trinta em paralelo custam
// os mesmos 30. Aqui cada consulta (PostgREST), cada leitura do Storage e cada getUser do Auth é anotada no pedido em curso, e na
// saída o log ganha uma linha (middleware/tempo.js):
//
//   [consultas] GET /api/inicio 212ms · 23 idas · fila 3 · games 5 · team_members 4 · users 3 …
//
// "fila" = a maior corrente de idas em que cada uma só saiu depois de a anterior voltar (o caminho crítico, visto de fora). É
// o número que se quer baixo; o total de idas importa menos.
//
// Só liga com MEDIR_CONSULTAS=1 (dev e prova). Em produção não: o embrulho custa pouco, mas a linha por pedido seria ruído no
// log do Cloud Run — lá o pedido lento já sai com as fases.
const { pedidoDoMomento } = require('../middleware/tempo');

/** Abre o registro de uma ida no pedido em curso; devolve a função que o fecha (no-op fora de um pedido). */
function anotar(tipo, alvo) {
  const t = pedidoDoMomento();
  if (!t) return () => {};
  const registro = { tipo, alvo, de: performance.now() - t.inicioMs, ate: null };
  (t.consultas ||= []).push(registro);
  return () => { if (registro.ate == null) registro.ate = performance.now() - t.inicioMs; };
}

/** O builder do PostgREST é "thenable": a volta é quando ele resolve (await, .then, maybeSingle ou single). */
function embrulharBuilder(builder, fechar) {
  const thenOriginal = builder.then?.bind(builder);
  if (thenOriginal) {
    builder.then = (ok, falha) => thenOriginal(
      (v) => { fechar(); return ok ? ok(v) : v; },
      (e) => { fechar(); if (falha) return falha(e); throw e; },
    );
  }
  for (const nome of ['maybeSingle', 'single']) {
    const original = builder[nome]?.bind(builder);
    if (original) builder[nome] = (...a) => Promise.resolve(original(...a)).finally(fechar);
  }
  return builder;
}

/**
 * Liga a anotação no cliente do Supabase (o de verdade ou o de mentira das provas). Idempotente.
 * @param {object} supabase o cliente de utils/db.js
 */
function ligar(supabase) {
  if (!supabase || supabase.__medindo) return;
  supabase.__medindo = true;

  const from0 = supabase.from.bind(supabase);
  supabase.from = (tabela) => embrulharBuilder(from0(tabela), anotar('db', tabela));

  if (supabase.storage?.from) {
    const storage0 = supabase.storage.from.bind(supabase.storage);
    supabase.storage.from = (bucket) => {
      const b = storage0(bucket);
      return new Proxy(b, {
        get(alvo, prop) {
          const v = alvo[prop];
          if (typeof v !== 'function' || !['download', 'list', 'upload', 'remove'].includes(prop)) return v;
          return (...a) => {
            const fechar = anotar('storage', `${bucket}.${prop}`);
            return Promise.resolve(v.apply(alvo, a)).finally(fechar);
          };
        },
      });
    };
  }

  if (supabase.auth?.getUser) {
    const getUser0 = supabase.auth.getUser.bind(supabase.auth);
    supabase.auth.getUser = (...a) => Promise.resolve(getUser0(...a)).finally(anotar('auth', 'getUser'));
  }
}

/**
 * O resumo das idas de um pedido: total, fila (a maior corrente de idas em série) e a contagem por alvo.
 * Uma ida "pode ter esperado" outra quando saiu depois de ela voltar — é a leitura de fora, sem saber o código. Por isso a
 * fila é um teto do caminho crítico de verdade, e é o número que se quer ver cair.
 */
function resumir(consultas = []) {
  const lista = [...consultas].sort((a, b) => a.de - b.de);
  const profundidade = [];
  for (let i = 0; i < lista.length; i += 1) {
    let p = 1;
    for (let j = 0; j < i; j += 1) {
      if (lista[j].ate != null && lista[j].ate <= lista[i].de + 0.5) p = Math.max(p, profundidade[j] + 1);
    }
    profundidade.push(p);
  }
  const porAlvo = {};
  for (const c of lista) porAlvo[c.alvo] = (porAlvo[c.alvo] || 0) + 1;
  return { idas: lista.length, fila: profundidade.length ? Math.max(...profundidade) : 0, porAlvo };
}

const ligado = () => process.env.MEDIR_CONSULTAS === '1';

module.exports = { ligar, resumir, ligado };
