// Futty v2.0 — Serving REAL de publicidade + medição. As campanhas vivem no gabineteStore
// (operacao.json), geridas no Gabinete. LEIS SELADAS respeitadas:
//  · filtro etário FAIL-CLOSED: sem classificação = '18+'; quem não tem 18 anos confirmados pela
//    data (e o anónimo) só recebe 'livre' — o app aceita a partir de 13 anos;
//  · interruptor geral (Gabinete 2.0, aba Anúncios) — desligado corta tudo,
//    independente dos toggles por página;
//  · toggle por página (default OFF) — página desligada = nenhum anúncio;
//  · rótulo "PUBLICIDADE" é do frontend.
// Lógica em services/inicio.js#obterAd — a MESMA função que GET /api/inicio usa,
// para o JSON nunca divergir entre as duas rotas.
const express = require('express');
const { optionalAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');
const { obterAd, obterAdsSessao } = require('../services/inicio');
const adsStore = require('../utils/adsStore');
const gabineteStore = require('../utils/gabineteStore');

const router = express.Router();

// A medição é pública (o app conta impressão e clique com ou sem login) — por isso só conta campanha que existe. Sem esta conta, qualquer
// um mandava ids inventados e o arquivo de métricas (lido e regravado inteiro a cada 30 s, e aberto pelo Gabinete) crescia sem limite.
async function idsDeCampanhas() {
  const operacao = await gabineteStore.ler();
  return new Set((operacao.campanhas || []).map((c) => c.id));
}

/** GET /api/ads?pagina=inicio|resenha|ranking|figurinha|sorteio|p — devolve o anúncio a mostrar (ou {ad:null}). */
router.get(
  '/api/ads',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const pagina = String(req.query.pagina || '').trim();
    res.json(await obterAd(pagina, req.user?.id));
  }),
);

/**
 * GET /api/ads/sessao — os slots de TODAS as páginas de uma vez.
 * O app pede isto uma vez por sessão (ou recebe-o dentro do /api/inicio) e
 * serve as telas a partir dele durante `validadeMs`.
 */
router.get(
  '/api/ads/sessao',
  optionalAuth,
  asyncHandler(async (req, res) => {
    res.json(await obterAdsSessao(req.user?.id));
  }),
);

/** POST /api/ads/evento { id, tipo:'imp'|'cli' } — medição (agregação diária, sem cookies). */
router.post(
  '/api/ads/evento',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { id, tipo } = req.body || {};
    if (typeof id === 'string' && (await idsDeCampanhas()).has(id)) adsStore.registar(id, tipo === 'cli' ? 'cli' : 'imp');
    res.json({ ok: true });
  }),
);

/**
 * POST /api/ads/eventos { eventos: [{ id, tipo }] } — os mesmos eventos, em
 * lote. O app junta as impressões e manda-as de uma vez, por
 * `sendBeacon`, quando a tela sai da frente — fora do caminho de pintura.
 *
 * Teto de 50 por lote: um beacon é de confiança limitada e isto é contagem
 * agregada, não contabilidade — melhor recusar um lote absurdo do que deixar
 * uma chamada escrever mil linhas.
 */
router.post(
  '/api/ads/eventos',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const eventos = Array.isArray(req.body?.eventos) ? req.body.eventos.slice(0, 50) : [];
    const conhecidas = await idsDeCampanhas();
    for (const e of eventos) {
      if (typeof e?.id !== 'string' || !conhecidas.has(e.id)) continue;
      // Em série de propósito: o adsStore agrega no MESMO documento do dia, e
      // duas escritas em paralelo perderiam uma das contagens.
      // eslint-disable-next-line no-await-in-loop
      await adsStore.registar(e.id, e.tipo === 'cli' ? 'cli' : 'imp');
    }
    res.json({ ok: true, n: eventos.length });
  }),
);

module.exports = router;
