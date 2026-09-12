// Proxy de imagem (Tijolo 2) — GET /api/media/:token
// O DOM aponta para URLs ESTÁVEIS deste proxy (o token vive 7 dias), o bucket
// continua PRIVADO. Aqui validamos o token e REDIRECIONAMOS (302) para um URL
// assinado do Supabase de vida curta — o CDN serve os bytes, o backend não faz
// streaming (custo quase nulo à nossa escala; ver justificação no telegrama).
const crypto = require('node:crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { supabase } = require('../utils/db');
const { verificarToken } = require('../utils/mediaToken');

const router = express.Router();

// Velocidade 2 (12-set): motor em São Paulo — recarregar a mesma foto a cada
// troca de tela custa uma ida ao Supabase Storage por imagem. `max-age` sobe
// de 50s para 24h ('private': só o browser do próprio utilizador, nunca um
// CDN/proxy partilhado — a imagem continua privada). O signed URL do Supabase
// tem de viver PELO MENOS esse tempo (era 60s "só para o redirect+fetch") —
// senão um 302 em cache aponta para uma assinatura já expirada e a imagem
// quebra antes do Cache-Control achar que devia.
const MEDIA_CACHE_MAX_AGE_S = 86400;

// ETag fraco por (bucket, path) — não olha o conteúdo do ficheiro (isso exigia
// outra chamada ao Storage). O mesmo caminho PODE trocar de conteúdo (upload
// com upsert:true), mas quando isso acontece o /api/me é recarregado e emite
// um TOKEN NOVO (exp diferente) — vira um URL /api/media/<token> diferente, o
// cache do URL antigo fica simplesmente ignorado. Nunca serve bytes errados
// sob o mesmo URL; o ETag serve só para poupar a chamada createSignedUrl
// quando o browser já tem a imagem e só quer confirmar que ainda vale.
function etagDoAlvo(alvo) {
  const hash = crypto.createHash('sha1').update(`${alvo.bucket}:${alvo.path}`).digest('hex');
  return `W/"${hash}"`;
}

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

  const etag = etagDoAlvo(alvo);
  if (req.headers['if-none-match'] === etag) {
    res.set('Cache-Control', `private, max-age=${MEDIA_CACHE_MAX_AGE_S}`);
    res.set('ETag', etag);
    return res.status(304).end();
  }

  try {
    const { data, error } = await supabase.storage
      .from(alvo.bucket)
      .createSignedUrl(alvo.path, MEDIA_CACHE_MAX_AGE_S);
    if (error || !data?.signedUrl) return res.status(404).json({ error: 'Ficheiro não encontrado.' });
    // O browser pode cachear a imagem (não só o redirect) — a imagem em si é imutável
    // sob este URL (ver etagDoAlvo acima: conteúdo novo = token novo = URL novo).
    res.set('Cache-Control', `private, max-age=${MEDIA_CACHE_MAX_AGE_S}`);
    res.set('ETag', etag);
    return res.redirect(302, data.signedUrl);
  } catch (e) {
    console.error('[media] proxy erro:', e.message);
    return res.status(500).json({ error: 'Erro a servir a imagem.' });
  }
});

module.exports = router;
