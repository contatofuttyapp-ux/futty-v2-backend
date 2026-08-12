// Futty v2.0 — Olheiro de entrada (11-ago): barra foto sem futuro ANTES de
// gastar geração de avatar IA. Corre no upload da foto de perfil, ANTES de
// guardar — reprovado não consome nada (nem Storage, nem cota de IA).
//
// Pisos CONSERVADORES (provado na bancada: foto de nitidez 4 gera bem — por
// isso NITIDEZ NÃO reprova). Só barra o que é matematicamente impossível
// salvar: foto minúscula, ficheiro corrompido, ou preto/estourado total.
// Medições baratas via sharp (metadata + stats), sem modelo nenhum.
//
// Ao contrário do filtroNSFW (que falha ABERTO em qualquer erro técnico),
// aqui "não decodifica" é um dos critérios de reprovação — é um sinal em si
// (ficheiro corrompido nunca vai gerar nada de bom). Só um erro INESPERADO no
// próprio filtro (bug aqui, não na imagem) falha aberto.
const sharp = require('sharp');
const { HttpError } = require('./http');

const LADO_MIN = 200; // px — menor lado abaixo disto não dá para nada
const BRILHO_MIN = 15; // 0-255, greyscale mean — abaixo disto é foto preta
const BRILHO_MAX = 240; // acima disto é foto estourada/lavada
const IMAGENS = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MSG = 'Essa foto não vai dar um bom card. Tente uma de frente, nítida e bem iluminada.';

/**
 * Middleware Express — corre DEPOIS do multer. Reprova com 400 FOTO_FRACA
 * (sem guardar nada) se a foto for pequena demais, corrompida, ou preta/
 * estourada. Vídeo/gif ficam fora do âmbito (passam sem análise).
 */
async function olheiroEntrada(req, res, next) {
  const file = req.file;
  if (!file || !file.buffer) return next();
  if (!IMAGENS.has(file.mimetype)) return next();

  let metadata;
  try {
    metadata = await sharp(file.buffer).metadata();
  } catch (e) {
    console.warn('[olheiro-entrada] REPROVADA: não decodifica', { user: req.user?.id, erro: e.message });
    return next(new HttpError(400, MSG, 'FOTO_FRACA'));
  }

  try {
    const menorLado = Math.min(metadata.width || 0, metadata.height || 0);
    if (menorLado < LADO_MIN) {
      console.warn('[olheiro-entrada] REPROVADA: lado pequeno', { user: req.user?.id, menorLado });
      return next(new HttpError(400, MSG, 'FOTO_FRACA'));
    }

    const { channels } = await sharp(file.buffer).greyscale().stats();
    const brilho = channels[0].mean;
    if (brilho < BRILHO_MIN || brilho > BRILHO_MAX) {
      console.warn('[olheiro-entrada] REPROVADA: brilho fora do intervalo', { user: req.user?.id, brilho: Number(brilho.toFixed(1)) });
      return next(new HttpError(400, MSG, 'FOTO_FRACA'));
    }

    return next();
  } catch (e) {
    // Erro INESPERADO no próprio filtro (não na decodificação) — falha aberta,
    // um bug aqui não pode travar todos os uploads de foto.
    console.error('[olheiro-entrada] erro inesperado — deixa passar:', e.message);
    return next();
  }
}

module.exports = { olheiroEntrada, LADO_MIN, BRILHO_MIN, BRILHO_MAX, MSG };
