// Proxy de imagem (Tijolo 2) — GET /api/media/:token
// O DOM aponta para URLs ESTÁVEIS deste proxy (o token vive 7 dias), o bucket
// continua PRIVADO. Aqui validamos o token e REDIRECIONAMOS (302) para um URL
// assinado do Supabase de vida curta — o CDN serve os bytes, o backend não faz
// streaming (custo quase nulo à nossa escala; ver justificação no telegrama).
const express = require('express');
const { supabase } = require('../utils/db');
const { verificarToken } = require('../utils/mediaToken');

const router = express.Router();

router.get('/api/media/:token', async (req, res) => {
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
