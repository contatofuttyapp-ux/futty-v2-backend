// Futty v2.0 — Confirma que um upload é uma imagem de verdade (decodifica
// via sharp = magic bytes), não só um mimetype declarado pelo cliente
// (SEGURANCA-REVISAO-10SET.md secção 3). Mesmo princípio do olheiro de
// entrada (utils/olheiroEntrada.js), só a parte de decodificação — sem os
// limiares de nitidez/brilho, que são específicos de foto de rosto e não
// fazem sentido para um logo/ícone.
const sharp = require('sharp');
const { HttpError } = require('./http');

const IMAGENS = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Middleware Express — corre DEPOIS do multer. Rejeita 400 se o ficheiro
 * não decodificar como imagem estática (ficheiro corrompido ou disfarçado). */
async function verificarImagemReal(req, res, next) {
  const file = req.file;
  if (!file || !file.buffer) return next();
  if (!IMAGENS.has(file.mimetype)) return next();
  try {
    await sharp(file.buffer).metadata();
    return next();
  } catch (e) {
    console.warn('[imagem-real] rejeitada: não decodifica', { user: req.user?.id, erro: e.message });
    return next(new HttpError(400, 'Arquivo inválido — não é uma imagem.'));
  }
}

module.exports = { verificarImagemReal };
