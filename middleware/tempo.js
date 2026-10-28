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
// O header que SAI para quem pede é só `app;dur` — é o que o Diagnóstico e a telemetria do app leem (`app`; o `edge` quem põe é a
// função da Cloudflare). Os nomes das fases, as consultas e o estado dos caches são detalhe interno do motor: ficam no LOG do servidor
// (pedido lento) e, se alguém precisar medir de fora, no interruptor SERVER_TIMING_DETALHE=1 do próprio ambiente.
//
// As FASES respondem à pergunta seguinte: dentro dos ~500 ms do motor, onde é
// que eles foram? `marcarFase(res, 'teams')` fecha a fase anterior e abre esta;
// com o detalhe ligado sai `Server-Timing: auth;dur=…, teams;dur=…, resto;dur=…, app;dur=…`.
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
// Lido a cada pedido (não no arranque): o interruptor muda sem reiniciar e o teste liga e desliga.
const detalheLigado = () => process.env.SERVER_TIMING_DETALHE === '1';

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

/**
 * Onde o pedido bateu, para o log: o DESENHO da rota (`/api/convite/:token`), nunca o endereço pedido — o caminho real leva o token do
 * convite, o do proxy de mídia, o slug do time, e a busca digitada vai na query. É o mesmo cuidado do tratador de erros (middleware/erros.js).
 */
const ondeBateu = (req) => `${req.method} ${req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : '(sem rota)'}`;

function tempoPorRota(req, res, next) {
  const inicio = AGORA();
  const logar = process.env.NODE_ENV !== 'production';

  res.locals._tempo = { inicio, inicioMs: performance.now(), fases: {}, faseDesde: inicio, marcou: false, consultouCache: false, cacheFrio: false };

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
      res.setHeader('Server-Timing', detalheLigado() ? partes.join(', ') : `app;dur=${total.toFixed(1)}`);

      // Em produção, um pedido lento diz POR ONDE se perdeu o tempo — sem isto,
      // saber que "demorou 700 ms" não leva a lado nenhum.
      if (!logar && total > 300 && partes.length > 1) {
        console.log(`[tempo] ${ondeBateu(req)} ${Math.round(total)}ms — ${partes.join(' ')}`);
      }

      // MEDIR_CONSULTAS=1 (dev e prova, utils/medirConsultas.js): as idas ao banco deste pedido, no log e num cabeçalho que a prova lê.
      if (t.consultas) {
        // eslint-disable-next-line global-require
        const { resumir } = require('../utils/medirConsultas');
        const r = resumir(t.consultas);
        res.setHeader('X-Futty-Consultas', `idas=${r.idas}; fila=${r.fila}`);
        const porAlvo = Object.entries(r.porAlvo).sort((a, b) => b[1] - a[1]).map(([alvo, n]) => `${alvo} ${n}`).join(' · ');
        if (process.env.MEDIR_CONSULTAS_SILENCIO !== '1') console.log(`[consultas] ${ondeBateu(req)} ${Math.round(total)}ms · ${r.idas} idas · fila ${r.fila} · ${porAlvo}`);
        // Uma linha por ida (saída → volta, em ms desde a chegada do pedido): o tempo de cada consulta, para achar a que segura a fila.
        if (process.env.MEDIR_CONSULTAS_DETALHE === '1') {
          for (const c of [...t.consultas].sort((a, b) => a.de - b.de)) {
            console.log(`[consultas]   +${Math.round(c.de)} → ${c.ate == null ? 'depois da resposta' : `+${Math.round(c.ate)}`}  ${c.tipo} ${c.alvo}`);
          }
        }
      }
    }
    return enviarOriginal.apply(res, args);
  };

  if (logar) {
    res.on('finish', () => {
      const ms = MS(inicio, AGORA());
      if (ms > 500) console.log(`[tempo] ${ondeBateu(req)} ${Math.round(ms)}ms`);
    });
  }
  pedidoAtual.run(res.locals._tempo, next);
}

/** O registro de tempo do pedido em curso (undefined fora de um pedido) — o medidor de consultas anota nele. */
const pedidoDoMomento = () => pedidoAtual.getStore();

module.exports = { tempoPorRota, marcarFase, medir, registrarCache, ondeBateu, pedidoDoMomento };
