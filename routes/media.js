// Proxy de imagem (Tijolo 2) — GET /api/media/:token
// O DOM aponta para URLs ESTÁVEIS deste proxy (o token vive 7 dias), o bucket
// continua PRIVADO. Aqui validamos o token e REDIRECIONAMOS (302) para um URL
// assinado do Supabase de vida curta — o CDN serve os bytes, o backend não faz
// streaming (custo quase nulo à nossa escala; ver justificação no telegrama).
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { supabase } = require('../utils/db');
const { verificarToken } = require('../utils/mediaToken');

const router = express.Router();

// SEGURANCA-REVISAO-10SET.md secção 3 (10-set): isento do limiter geral da
// /api (server.js, apiLimiter — 200/15min) porque um feed com muitas fotos
// dispara uma chamada por <img>, de uma vez. Sem sessão (o token HMAC é a
// própria autorização), por isso conta por IP, não por utilizador.
const mediaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados pedidos de imagem. Tenta mais tarde.' },
});

router.get('/api/media/:token', mediaLimiter, async (req, res) => {
  const alvo = verificarToken(req.params.token);
  if (!alvo) return res.status(403).json({ error: 'Acesso inválido ou expirado.' });
  try {
    const { data, error } = await supabase.storage
      .from(alvo.bucket)
      .createSignedUrl(alvo.path, 60); // 60s: só o tempo do redirect+fetch
    if (error || !data?.signedUrl) return res.status(404).json({ error: 'Ficheiro não encontrado.' });
    // O browser pode cachear a imagem (não o redirect) — a imagem em si é imutável.
    res.set('Cache-Control', 'private, max-age=50');
    return res.redirect(302, data.signedUrl);
  } catch (e) {
    console.error('[media] proxy erro:', e.message);
    return res.status(500).json({ error: 'Erro a servir a imagem.' });
  }
});

module.exports = router;
