// Futty v2.0 — Serving REAL de publicidade + medição. As campanhas vivem no gabineteStore
// (operacao.json), geridas no Gabinete. LEIS SELADAS respeitadas:
//  · filtro etário FAIL-CLOSED: sem classificação = '18+'; menor/anónimo só recebe 'livre';
//  · interruptor geral (Gabinete 2.0, aba Anúncios) — desligado corta tudo,
//    independente dos toggles por página;
//  · toggle por página (default OFF) — página desligada = nenhum anúncio;
//  · rótulo "PUBLICIDADE" é do frontend.
// Lógica em services/inicio.js#obterAd — a MESMA função que GET /api/inicio usa,
// para o JSON nunca divergir entre as duas rotas.
const express = require('express');
const { optionalAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');
const { obterAd } = require('../services/inicio');
const adsStore = require('../utils/adsStore');

const router = express.Router();

/** GET /api/ads?pagina=inicio|resenha|ranking|figurinha|sorteio|p — devolve o anúncio a mostrar (ou {ad:null}). */
router.get(
  '/api/ads',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const pagina = String(req.query.pagina || '').trim();
    res.json(await obterAd(pagina, req.user?.id));
  }),
);

/** POST /api/ads/evento { id, tipo:'imp'|'cli' } — medição (agregação diária, sem cookies). */
router.post(
  '/api/ads/evento',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { id, tipo } = req.body || {};
    await adsStore.registar(id, tipo === 'cli' ? 'cli' : 'imp');
    res.json({ ok: true });
  }),
);

module.exports = router;
