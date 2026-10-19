// Futty v2.0 — O envio de foto, GIF e vídeo da Resenha: tipos aceitos, formato real dos bytes, filtro de nudez, compressão, cota
// do time e o bucket privado. Montadas por routes/feed.js.

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { requireAuth } = require('../middleware/auth');
const { uploadResenhaLimiter } = require('../middleware/limiters');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase } = require('../utils/db');
const { filtroNSFW } = require('../utils/nsfwFilter');
const { exigirImagemReal, exigirVideoReal, formatoReal, MSG_FORMATO, LIMITE_PIXELS } = require('../utils/imagemReal');
const { STORAGE_BUCKET } = require('../utils/ajudaDaResenha');

const router = express.Router();

// Upload: lê o arquivo para memória; envia-se depois ao Supabase Storage.
//
// O teto geral é 12MB: fotos JPG/PNG/WebP passam por compressão (ver comprimirImagem) antes de gravar,
// então chegam bem abaixo disto; GIF tem o seu PRÓPRIO teto, mais apertado (GIF_MAX_BYTES), porque não
// é comprimido (perderia a animação). Vídeo segue sem transcodificação — 12MB é o teto dele também.
const UPLOAD_MAX_BYTES = 12 * 1024 * 1024;
const GIF_MAX_BYTES = 8 * 1024 * 1024;
// Lado maior de uma foto comprimida (px) e qualidade do WebP de saída.
const COMPRESSAO_LADO_MAX = 1600;
const COMPRESSAO_QUALIDADE = 80;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: UPLOAD_MAX_BYTES } });
// Wrapper que traduz o erro de tamanho do multer numa mensagem clara.
function receberFicheiro(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new HttpError(413, `Arquivo grande demais: o limite é ${UPLOAD_MAX_BYTES / (1024 * 1024)}MB. Fotos são otimizadas automaticamente; GIFs até ${GIF_MAX_BYTES / (1024 * 1024)}MB.`));
      }
      return next(new HttpError(400, 'Falha ao receber o arquivo.'));
    }
    next();
  });
}
// mimetype -> extensão (lista branca de tipos aceites no upload).
const UPLOAD_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};
// Fotos estáticas que passam por compressão (o GIF fica de fora: animado).
const IMAGENS_COMPRIMIVEIS = new Set(['image/jpeg', 'image/png', 'image/webp']);
// O formato REAL dos bytes de uma imagem tem de ser um destes (vídeo não passa por aqui: não vai ao sharp).
const IMAGENS_DA_RESENHA = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * Comprime uma foto estática antes de gravar: respeita a orientação EXIF, reduz o lado maior a
 * COMPRESSAO_LADO_MAX (nunca amplia) e converte para WebP. Fail-open: se o sharp falhar (arquivo
 * corrompido de um jeito que passou pelo NSFW mas não pelo decode aqui), grava o ORIGINAL em vez de
 * derrubar o upload — melhor uma foto grande que nenhuma foto.
 * Devolve { buffer, mimetype, ext }.
 */
async function comprimirImagem(buffer, mimetypeOriginal, extOriginal) {
  try {
    const comprimido = await sharp(buffer, { limitInputPixels: LIMITE_PIXELS })
      .rotate() // aplica a orientação EXIF antes de qualquer coisa — sem isto a rotação vai junto para o WebP
      .resize(COMPRESSAO_LADO_MAX, COMPRESSAO_LADO_MAX, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: COMPRESSAO_QUALIDADE })
      .toBuffer();
    return { buffer: comprimido, mimetype: 'image/webp', ext: 'webp' };
  } catch (e) {
    console.error('[feed] compressão falhou, gravando o arquivo original:', e.message);
    return { buffer, mimetype: mimetypeOriginal, ext: extOriginal };
  }
}

/** Garante (uma vez por processo) que o bucket da Resenha existe — PRIVADO: as fotos saem só pelo proxy assinado (/api/media). */
let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  // Ignora erro caso o bucket já exista (idempotente).
  await supabase.storage.createBucket(STORAGE_BUCKET, { public: false }).catch(() => {});
  bucketReady = true;
}

// =====================================================================
// UPLOAD DE FOTOS / VÍDEOS (Supabase Storage)
// =====================================================================

/**
 * POST /api/feed/upload — recebe um arquivo (multipart, campo "file"),
 * envia-o ao bucket público do Supabase Storage e devolve a URL pública.
 */
router.post(
  '/api/feed/upload',
  requireAuth,
  uploadResenhaLimiter,
  receberFicheiro,
  exigirImagemReal(IMAGENS_DA_RESENHA), // SVG (ou outro formato) com Content-Type de imagem: 400, antes de qualquer sharp
  exigirVideoReal, // video/mp4 só passa se os bytes são de um MP4 de verdade
  filtroNSFW, // bloqueia imagem explícita da resenha antes de guardar
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Nenhum arquivo enviado.');
    const mimetypeOriginal = req.file.mimetype;
    const extOriginal = UPLOAD_MIME[mimetypeOriginal];
    if (!extOriginal) throw new HttpError(400, 'Tipo de arquivo não permitido.');
    // A Resenha só guarda imagem que abre. A compressão mais abaixo é fail-open de propósito (melhor uma foto grande que nenhuma), mas só
    // vale para foto de verdade: um arquivo vazio, ou bytes que nenhum leitor decodifica, entrariam no bucket com o tipo que o cliente
    // declarou. (Vídeo segue como estava: o upload de vídeo está dormente na v1.)
    if (mimetypeOriginal.startsWith('image/')) {
      const formato = await formatoReal(req.file.buffer);
      if (!formato || formato === 'marcacao') throw new HttpError(400, MSG_FORMATO);
    }

    // GIF: fica animado, não passa por sharp — mas tem teto PRÓPRIO, mais
    // apertado que o geral (a lei do app leve não abre exceção pra "é GIF").
    if (mimetypeOriginal === 'image/gif' && req.file.buffer.length > GIF_MAX_BYTES) {
      throw new HttpError(413, `GIF grande demais: o limite é ${GIF_MAX_BYTES / (1024 * 1024)}MB para manter a animação. Tente um arquivo menor.`);
    }

    const { buffer, mimetype, ext } = IMAGENS_COMPRIMIVEIS.has(mimetypeOriginal)
      ? await comprimirImagem(req.file.buffer, mimetypeOriginal, extOriginal)
      : { buffer: req.file.buffer, mimetype: mimetypeOriginal, ext: extOriginal };

    await ensureBucket();

    // O id de quem subiu vai no nome: é assim que o post sabe que a mídia é de quem a anexa (utils/validarUrl.js#midiaEhDe).
    const filename = `${req.user.id}-${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(filename, buffer, { contentType: mimetype, upsert: false });
    if (error) throw new HttpError(500, error.message);

    const { data: pub } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(filename);
    // O tipo de mídia (para a UI) segue o arquivo ORIGINAL — comprimir um JPEG
    // para WebP não faz dele um "outro tipo", continua 'image'.
    const mediaType =
      mimetypeOriginal === 'image/gif' ? 'gif' : mimetypeOriginal.startsWith('video/') ? 'video' : 'image';

    res.status(201).json({ url: pub.publicUrl, media_type: mediaType });
  })
);

module.exports = router;
