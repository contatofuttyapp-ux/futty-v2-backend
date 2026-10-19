// Futty v2.0 — O recebimento da foto do avatar (multipart): tamanho, tipos aceitos, formato REAL dos bytes e orientação pelo EXIF.
const multer = require('multer');
const { HttpError } = require('../utils/http');
const { orientarSePreciso } = require('../utils/orientarFoto');
const { exigirFormatoReal } = require('../utils/imagemReal');

// Upload do avatar: arquivo em memória, só imagens, máximo 5MB.
const MAX_AVATAR = 5 * 1024 * 1024;
const AVATAR_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MIMES_DA_FOTO = Object.keys(AVATAR_MIME);
// "Escolher outra foto" manda dois arquivos no mesmo pedido: o
// recorte 2:3 (campo "avatar", como sempre) e, opcional, a foto ORIGINAL
// antes do recorte (campo "original", para "Ajustar enquadramento" mais
// tarde). .fields() em vez de .single(): quem só manda "avatar" (Onboarding,
// clientes antigos) continua a funcionar sem mudar nada.
const uploadAvatarMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR },
  fileFilter: (req, file, cb) => {
    if (AVATAR_MIME[file.mimetype]) cb(null, true);
    else cb(new HttpError(400, 'Só são aceitas imagens JPEG, PNG ou WebP.'));
  },
}).fields([{ name: 'avatar', maxCount: 1 }, { name: 'original', maxCount: 1 }]);

// Wrapper que corre o multer, auto-orienta pelo EXIF e converte os erros dele
// em HttpError(400). Normaliza req.file (o recorte) e req.fileOriginal (a
// original, se vier) — o resto da rota lê req.file como sempre lia.
function receberAvatar(req, res, next) {
  uploadAvatarMw(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        const msg = err.code === 'LIMIT_FILE_SIZE' ? 'A imagem excede o limite de 5MB.' : 'Falha no upload da imagem.';
        return next(new HttpError(400, msg));
      }
      return next(err); // HttpError do fileFilter ou outro
    }
    req.file = req.files?.avatar?.[0] || null;
    req.fileOriginal = req.files?.original?.[0] || null;
    // O formato REAL dos bytes tem de ser um dos aceitos: o Content-Type é só o que o cliente diz, e um SVG
    // com cara de PNG não pode chegar ao sharp (utils/imagemReal.js). Primeira coisa a tocar no buffer.
    try {
      if (req.file) await exigirFormatoReal(req.file.buffer, MIMES_DA_FOTO);
      if (req.fileOriginal) await exigirFormatoReal(req.fileOriginal.buffer, MIMES_DA_FOTO);
    } catch (e) {
      return next(e);
    }
    // EXIF (caso real: selfie do iPhone girada 180°). .rotate() sem
    // argumentos lê a tag Orientation, reescreve os pixels já em pé e apaga a
    // tag — ninguém depois (NSFW, Olheiro, Storage, IA) precisa de voltar a
    // interpretar orientação. O frontend já normaliza antes de subir
    // (utils/normalizarFoto.js) — isto é o cinto e suspensório: cobre
    // qualquer caminho que não passe por lá (API directa, cliente antigo).
    // Logo depois da conferência do formato, antes de qualquer outra operação.
    if (req.file) {
      try {
        req.file.buffer = await orientarSePreciso(req.file.buffer);
      } catch {
        return next(new HttpError(400, 'Não foi possível ler essa imagem.'));
      }
    }
    if (req.fileOriginal) {
      try {
        req.fileOriginal.buffer = await orientarSePreciso(req.fileOriginal.buffer);
      } catch {
        return next(new HttpError(400, 'Não foi possível ler a foto original.'));
      }
    }
    next();
  });
}

// PUT /api/me/avatar/recorte: um arquivo só (campo "recorte"),
// o resultado de reabrir o CropModal sobre a original (ou o fallback, sobre
// o recorte atual). Mesmo teto/mesmos tipos do avatar normal.
const uploadRecorteMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR },
  fileFilter: (req, file, cb) => {
    if (AVATAR_MIME[file.mimetype]) cb(null, true);
    else cb(new HttpError(400, 'Só são aceitas imagens JPEG, PNG ou WebP.'));
  },
}).single('recorte');

function receberRecorte(req, res, next) {
  uploadRecorteMw(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        const msg = err.code === 'LIMIT_FILE_SIZE' ? 'A imagem excede o limite de 5MB.' : 'Falha no upload da imagem.';
        return next(new HttpError(400, msg));
      }
      return next(err);
    }
    if (req.file) {
      try {
        await exigirFormatoReal(req.file.buffer, MIMES_DA_FOTO); // o formato real, como no avatar
      } catch (e) {
        return next(e);
      }
      try {
        req.file.buffer = await orientarSePreciso(req.file.buffer);
      } catch {
        return next(new HttpError(400, 'Não foi possível ler essa imagem.'));
      }
    }
    next();
  });
}

module.exports = { receberAvatar, receberRecorte, MAX_AVATAR, AVATAR_MIME, MIMES_DA_FOTO };
