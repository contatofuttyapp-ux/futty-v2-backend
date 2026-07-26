// Futty v2.0 — Serving REAL de publicidade + medição. As campanhas vivem no gabineteStore
// (operacao.json), geridas no Gabinete. LEIS SELADAS respeitadas:
//  · filtro etário FAIL-CLOSED: sem classificação = '18+'; menor/anónimo só recebe 'livre';
//  · toggle por página (default OFF) — página desligada = nenhum anúncio;
//  · rótulo "PUBLICIDADE" é do frontend.
const express = require('express');
const { optionalAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');
const { supabase } = require('../utils/db');
const gabineteStore = require('../utils/gabineteStore');
const adsStore = require('../utils/adsStore');
const { ehAdulto } = require('../utils/rostoPublico');

const router = express.Router();

const hojeStr = () => new Date().toISOString().slice(0, 10);
function ativa(c, hoje) {
  if (c.estado !== 'ativa') return false;
  if (c.inicio && c.inicio > hoje) return false;
  if (c.fim && c.fim < hoje) return false;
  return true;
}
// FAIL-CLOSED: sem cls → tratado como 18+ (só adulto autenticado vê).
function podeVer(c, adulto) {
  return (c.cls || '18+') === 'livre' ? true : adulto === true;
}

/** GET /api/ads?pagina=inicio|sorteio|p — devolve o anúncio a mostrar (ou {ad:null}). */
router.get(
  '/api/ads',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const pagina = String(req.query.pagina || '').trim();
    const store = await gabineteStore.ler();
    if (!store.toggles || store.toggles[pagina] !== true) return res.json({ ad: null }); // página OFF

    let adulto = false;
    if (req.user) {
      const { data: u } = await supabase.from('users').select('birthdate').eq('id', req.user.id).maybeSingle();
      adulto = ehAdulto(u && u.birthdate);
    }
    const hoje = hojeStr();
    const elegiveis = (store.campanhas || []).filter(
      (c) => Array.isArray(c.paginas) && c.paginas.includes(pagina) && ativa(c, hoje) && podeVer(c, adulto),
    );
    if (!elegiveis.length) return res.json({ ad: null });
    // rotação simples sem cookies (por minuto)
    const c = elegiveis[Math.floor(Date.now() / 60000) % elegiveis.length];
    res.json({
      ad: {
        id: c.id, anunciante: c.anunciante || '', imagem_url: c.imagem_url || null,
        texto: c.texto || c.nome || '', sub: c.sub || c.anunciante || '', cta: c.cta || 'Ver', link: c.link || null,
      },
    });
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
