// Proxy de imagem — GET /api/media/:token[?w=128|256|512|1024]
//
// VELOCIDADE 6A (15-set) — era um 302 para um signed URL do Supabase. Custava
// caro no celular: o redirect abria uma SEGUNDA ligação TLS (Cloud Run → CDN do
// Supabase) e devolvia o PNG original, 390 KB, medido a 1,4-1,6 s por imagem de
// Lisboa. Agora o proxy serve os BYTES ele próprio, já redimensionados e em
// WebP, e guarda o derivado em memória: a segunda pessoa a ver a mesma foto
// paga só a rede.
//
// Porquê `Cache-Control: public` (e não `private`): o URL é uma CAPACIDADE
// assinada por HMAC — quem não tem o token não tem o URL, exatamente como um
// signed URL de qualquer CDN. E `immutable` porque conteúdo novo gera `v` novo
// (ver utils/mediaToken.js) → URL novo; este URL, esse, nunca muda de bytes.
//
// Os derivados NÃO são gravados no Storage de propósito: um WebP de rosto que
// sobrevivesse à conta apagada seria um órfão com PII (LGPD). O LRU em memória
// morre com o processo, que é o comportamento certo.
const crypto = require('node:crypto');
const express = require('express');
const sharp = require('sharp');
const { criarLimiteDeMidia } = require('../middleware/limiters');
const { supabase } = require('../utils/db');
const { verificarToken } = require('../utils/mediaToken');

const router = express.Router();

const UM_ANO_S = 31536000;
const DEGRAUS = [128, 256, 512, 1024];
const LARGURA_MAX_SEM_W = 1600;
const TIPOS_REDIMENSIONAVEIS = new Set(['image/jpeg', 'image/png', 'image/webp']);

// LRU: 300 entradas ou 40 MB, o que bater primeiro. Map em JS preserva a ordem
// de inserção, por isso a chave mais antiga é sempre a primeira de keys().
const LRU_MAX_ENTRADAS = 300;
const LRU_MAX_BYTES = 40 * 1024 * 1024;
const cache = new Map();
let cacheBytes = 0;

function cacheLer(chave) {
  const item = cache.get(chave);
  if (!item) return null;
  // Reinsere no fim: passa a ser a mais recente.
  cache.delete(chave);
  cache.set(chave, item);
  return item;
}

function cacheGravar(chave, item) {
  if (cache.has(chave)) cacheBytes -= cache.get(chave).buf.length;
  cache.set(chave, item);
  cacheBytes += item.buf.length;
  while (cache.size > LRU_MAX_ENTRADAS || cacheBytes > LRU_MAX_BYTES) {
    const maisAntiga = cache.keys().next().value;
    if (maisAntiga === undefined) break;
    cacheBytes -= cache.get(maisAntiga).buf.length;
    cache.delete(maisAntiga);
  }
}

/** w pedido → o degrau mais próximo; sem w (ou lixo) → null (tamanho original). */
function normalizarLargura(bruto) {
  if (bruto === undefined || bruto === null || bruto === '') return null;
  const n = Number(bruto);
  if (!Number.isFinite(n) || n <= 0) return null;
  return DEGRAUS.reduce((melhor, d) => (Math.abs(d - n) < Math.abs(melhor - n) ? d : melhor), DEGRAUS[0]);
}

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
  // O `v` entra na chave: conteúdo novo nunca é servido a partir de um derivado velho.
  const chave = crypto
    .createHash('sha1')
    .update(`${alvo.bucket}:${alvo.path}:${alvo.v || ''}:${largura || 'orig'}:${quadrado ? 'sq' : 'livre'}`)
    .digest('hex');
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

  const emCache = cacheLer(chave);
  if (emCache) {
    cabecalhos();
    res.set('Content-Type', emCache.tipo);
    res.set('Content-Length', String(emCache.buf.length));
    res.set('X-Futty-Cache', 'hit');
    return res.end(emCache.buf);
  }

  try {
    const { data, error } = await supabase.storage.from(alvo.bucket).download(alvo.path);
    if (error || !data) return res.status(404).json({ error: 'Arquivo não encontrado.' });

    const original = Buffer.from(await data.arrayBuffer());
    const tipoOriginal = data.type || 'application/octet-stream';

    let buf = original;
    let tipo = tipoOriginal;
    // GIF (animado) e o que não for imagem conhecida passam intactos: converter
    // um GIF para WebP estático mataria a animação.
    if (TIPOS_REDIMENSIONAVEIS.has(tipoOriginal)) {
      const alvoLargura = largura || LARGURA_MAX_SEM_W;
      // RODADA 19 (23-set): 'top' em vez de sharp.strategy.attention. Desde
      // que o recorte 2:3 existe (CropModal, rosto no terço de cima "por
      // construção" — SPEC-FIGURINHA-3 §3), o quadrado pequeno não precisa
      // mais adivinhar onde está a cara: corta sempre do TOPO do recorte. A
      // 'attention' (maior entropia) falhava em fotos fora do padrão — achado
      // da bancada "Menor K churras" (corpo inteiro sentado): a região de
      // maior entropia era o pulso/relógio, não o rosto.
      const medida = quadrado
        ? { width: alvoLargura, height: alvoLargura, fit: 'cover', position: 'top', withoutEnlargement: true }
        : { width: alvoLargura, withoutEnlargement: true };
      buf = await sharp(original)
        .rotate() // respeita o EXIF antes de redimensionar
        .resize(medida)
        .webp({ quality: alvoLargura <= 256 ? 82 : 88, alphaQuality: 90, effort: 4 })
        .toBuffer();
      tipo = 'image/webp';
    }

    cacheGravar(chave, { buf, tipo });
    cabecalhos();
    res.set('Content-Type', tipo);
    res.set('Content-Length', String(buf.length));
    res.set('X-Futty-Cache', 'miss');
    return res.end(buf);
  } catch (e) {
    console.error('[media] falha a servir a imagem:', e.message);
    return res.status(500).json({ error: 'Erro ao carregar a imagem.' });
  }
});

module.exports = router;
