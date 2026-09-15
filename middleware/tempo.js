// Futty v2.0 — Middleware de tempo por rota (diagnóstico de lentidão, roteiro
// 10-set, achados 3/23; header Server-Timing 13-set, "Velocidade 3"; fases
// 15-set, "Velocidade 6A").
//
// O console.log continua só em dev (ruído/custo do hrtime não vale a pena em
// produção). O header Server-Timing, esse, vai em TODO pedido, produção
// incluída — é o que deixa medir de Lisboa quanto do tempo total é o MOTOR
// (São Paulo) e quanto é rede: `curl -w '...'`/DevTools separam o Server-Timing
// do round-trip total sem precisar de nenhum log do lado do servidor.
//
// As FASES respondem à pergunta seguinte: dentro dos ~500 ms do motor, onde é
// que eles foram? `marcarFase(res, 'teams')` fecha a fase anterior e abre esta;
// no fim sai `Server-Timing: auth;dur=…, teams;dur=…, resto;dur=…, app;dur=…`.
// O `app` fica sempre em ÚLTIMO porque o Diagnóstico do app lê `app;dur`.
//
// CACHE (15-set, "Velocidade 7A"): os caches quentes (utils/cacheQuente.js)
// avisam aqui se o pedido achou o valor pronto ou teve de esperar a rede. Sai
// `cache;desc=hit` (tudo pronto) ou `cache;desc=miss` (algum frio), e para cada
// cache frio uma fase `cache-<nome>;dur=…` com a espera — ex.: `cache-sessao;dur=612.3`.
// É o que mostra quando o motor pagou cache frio. O pedido corrente é achado
// pelo AsyncLocalStorage, para nenhum serviço precisar de receber o `res` só por isso.
const { AsyncLocalStorage } = require('node:async_hooks');

const pedidoAtual = new AsyncLocalStorage();
const AGORA = () => process.hrtime.bigint();
const MS = (de, ate) => Number(ate - de) / 1e6;

/**
 * Dá nome ao trecho que ACABOU DE TERMINAR (do início do pedido, ou da marca
 * anterior, até aqui). Chamar logo a seguir ao passo que se quer medir:
 *
 *   await requireAuth(...)        ← já correu
 *   marcarFase(res, 'auth');      → 'auth' = o tempo do requireAuth
 *   const equipas = await ...;
 *   marcarFase(res, 'equipas');   → 'equipas' = o tempo dessa consulta
 *
 * O que sobrar entre a última marca e a saída da resposta aparece como 'resto'.
 * Silencioso se o middleware não estiver montado (uma função chamada
 * diretamente por um teste, por exemplo).
 */
function marcarFase(res, nome) {
  const t = res?.locals?._tempo;
  if (!t) return;
  const agora = AGORA();
  t.fases[nome] = (t.fases[nome] || 0) + MS(t.faseDesde, agora);
  t.faseDesde = agora;
  t.marcou = true;
}

/**
 * Cronometra UMA promessa, para rotas onde as partes correm em PARALELO (o
 * /api/inicio e o /api/feed disparam tudo de uma vez). Aqui as fases
 * SOBREPÕEM-SE de propósito: a soma passa o `app;dur`, e é isso que se quer —
 * a pergunta não é "que fatia do tempo", é "qual das partes é a lenta".
 * Devolve a própria promessa, para se usar em linha dentro de um Promise.all.
 */
function medir(res, nome, promessa) {
  const t = res?.locals?._tempo;
  if (!t) return promessa;
  const de = AGORA();
  return Promise.resolve(promessa).finally(() => {
    t.fases[nome] = (t.fases[nome] || 0) + MS(de, AGORA());
  });
}

/**
 * Chamado pelos caches quentes. `acertou` = o valor já estava pronto (fresco ou
 * velho servido na hora); senão `esperaMs` é quanto este pedido ficou esperando
 * a rede. Silencioso fora de um pedido (aquecimento no arranque, testes).
 */
function registrarCache(nome, acertou, esperaMs = 0) {
  const t = pedidoAtual.getStore();
  if (!t) return;
  t.consultouCache = true;
  if (acertou) return;
  t.cacheFrio = true;
  const fase = `cache-${nome}`;
  t.fases[fase] = (t.fases[fase] || 0) + esperaMs;
}

function tempoPorRota(req, res, next) {
  const inicio = AGORA();
  const logar = process.env.NODE_ENV !== 'production';

  res.locals._tempo = { inicio, fases: {}, faseDesde: inicio, marcou: false, consultouCache: false, cacheFrio: false };

  // res.end é o ponto comum de saída (res.json/res.send/res.redirect chamam-no
  // por baixo) — intercetado para poder pôr o header ANTES dos headers saírem
  // (res.on('finish') já é tarde demais, os headers já foram enviados).
  const enviarOriginal = res.end;
  res.end = function interceptado(...args) {
    if (!res.headersSent) {
      const fim = AGORA();
      const t = res.locals._tempo;
      // O que sobrou entre a última marca e a saída (serialização, sobretudo).
      const sobra = MS(t.faseDesde, fim);
      if (t.marcou && sobra >= 0.1) t.fases.resto = (t.fases.resto || 0) + sobra;
      const total = MS(inicio, fim);
      const partes = Object.entries(t.fases).map(([nome, ms]) => `${nome};dur=${ms.toFixed(1)}`);
      if (t.consultouCache) partes.push(`cache;desc=${t.cacheFrio ? 'miss' : 'hit'}`);
      partes.push(`app;dur=${total.toFixed(1)}`); // SEMPRE por último
      res.setHeader('Server-Timing', partes.join(', '));

      // Em produção, um pedido lento diz POR ONDE se perdeu o tempo — sem isto,
      // saber que "demorou 700 ms" não leva a lado nenhum.
      if (!logar && total > 300 && partes.length > 1) {
        console.log(`[tempo] ${req.method} ${req.originalUrl} ${Math.round(total)}ms — ${partes.join(' ')}`);
      }
    }
    return enviarOriginal.apply(res, args);
  };

  if (logar) {
    res.on('finish', () => {
      const ms = MS(inicio, AGORA());
      if (ms > 500) console.log(`[tempo] ${req.method} ${req.originalUrl} ${Math.round(ms)}ms`);
    });
  }
  pedidoAtual.run(res.locals._tempo, next);
}

module.exports = { tempoPorRota, marcarFase, medir, registrarCache };
