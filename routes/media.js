// Proxy de imagem — GET /api/media/:token[?w=128|256|512|1024][&sq=1]
//
// VELOCIDADE 6A (15-set) — era um 302 para um signed URL do Supabase. Custava
// caro no celular: o redirect abria uma SEGUNDA ligação TLS (Cloud Run → CDN do
// Supabase) e devolvia o PNG original, 390 KB, medido a 1,4-1,6 s por imagem de
// Lisboa. Agora o proxy serve os BYTES ele próprio, já redimensionados e em
// WebP, e guarda o derivado em memória: a segunda pessoa a ver a mesma foto
// paga só a rede.
//
// RODADA 27 (25-set) — o LRU e a receita moraram até aqui; agora vivem em
// utils/derivadosMidia.js, porque o upload da foto também os usa: quem grava a foto
// deixa os derivados que as telas vão pedir prontos, e o primeiro pedido da própria
// pessoa deixa de pagar a ida ao Storage e o sharp. Dois pedidos do mesmo derivado ao
// mesmo tempo esperam a mesma geração.
//
// Porquê `Cache-Control: public` (e não `private`): o URL é uma CAPACIDADE
// assinada por HMAC — quem não tem o token não tem o URL, exatamente como um
// signed URL de qualquer CDN. E `immutable` porque conteúdo novo gera `v` novo
// (ver utils/mediaToken.js) → URL novo; este URL, esse, nunca muda de bytes.
//
// Os derivados NÃO são gravados no Storage de propósito: um WebP de rosto que
// sobrevivesse à conta apagada seria um órfão com PII (LGPD). O LRU em memória
// morre com o processo, que é o comportamento certo.
const express = require('express');
const { criarLimiteDeMidia } = require('../middleware/limiters');
const { supabase } = require('../utils/db');
const { verificarToken } = require('../utils/mediaToken');
const { normalizarLargura, chaveDoDerivado, gerarDerivado, obterDerivado } = require('../utils/derivadosMidia');

const router = express.Router();

const UM_ANO_S = 31536000;

class ArquivoAusente extends Error {}

// SEGURANCA-REVISAO-10SET.md secção 3 (10-set): isento do limiter geral da
// /api (server.js) porque um feed com muitas fotos dispara uma chamada por
// <img>, de uma vez. Sem sessão (o token HMAC é a própria autorização), por isso
// conta por IP, o real (CF-Connecting-IP quando vem, senão req.ip). Teto e chave
// em middleware/limiters.js (hotfix 25).
const mediaLimiter = criarLimiteDeMidia();

router.get('/api/media/:token', mediaLimiter, async (req, res) => {
  const alvo = verificarToken(req.params.token);
  if (!alvo) return res.status(403).json({ error: 'Acesso inválido ou expirado.' });

  const largura = normalizarLargura(req.query.w);
  // `sq=1` — recorte central QUADRADO (SPEC-FIGURINHA-3 §3). A figurinha comum
  // é a foto 2:3 da pessoa, e os avatares pequenos (ranking, presença, Início)
  // mostram-na numa moldura quadrada: cortar aqui poupa um terço dos bytes e
  // garante o enquadramento no servidor em vez de depender do object-fit de
  // cada tela. É OPT-IN de propósito — o mesmo proxy serve os escudos de time,
  // e um escudo largo cortado ao meio seria um defeito.
  const quadrado = req.query.sq === '1';
  const chave = chaveDoDerivado({ bucket: alvo.bucket, path: alvo.path, v: alvo.v, largura, quadrado });
  const etag = `"${chave}"`;

  const cabecalhos = () => {
    res.set('Cache-Control', `public, max-age=${UM_ANO_S}, immutable`);
    res.set('ETag', etag);
    res.set('Timing-Allow-Origin', '*');
  };

  // O browser já tem estes bytes — não há nada a fazer, nem sequer ler o cache.
  if (req.headers['if-none-match'] === etag) {
    cabecalhos();
    res.set('X-Futty-Cache', 'hit');
    return res.status(304).end();
  }

  try {
    const item = await obterDerivado(chave, async () => {
      const { data, error } = await supabase.storage.from(alvo.bucket).download(alvo.path);
      if (error || !data) throw new ArquivoAusente();
      const original = Buffer.from(await data.arrayBuffer());
      return gerarDerivado(original, data.type || 'application/octet-stream', { largura, quadrado });
    });
    cabecalhos();
    res.set('Content-Type', item.tipo);
    res.set('Content-Length', String(item.buf.length));
    // 'hit' = já estava no LRU (inclui o que o upload deixou pronto); 'miss' = este pedido esperou a geração.
    res.set('X-Futty-Cache', item.origem === 'cache' ? 'hit' : 'miss');
    return res.end(item.buf);
  } catch (e) {
    if (e instanceof ArquivoAusente) return res.status(404).json({ error: 'Arquivo não encontrado.' });
    console.error('[media] falha a servir a imagem:', e.message);
    return res.status(500).json({ error: 'Erro ao carregar a imagem.' });
  }
});

module.exports = router;
