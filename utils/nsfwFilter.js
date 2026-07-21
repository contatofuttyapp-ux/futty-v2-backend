// Filtro de conteúdo — NSFWJS no caminho dos uploads de imagem.
// Tijolo 1 da fase Segurança: bloqueia explícito ANTES de a imagem ser guardada.
//
// Decisões (SPEC-SEGURANCA v2):
// - modelo carrega UMA vez (singleton) — ideal: no arranque do servidor;
// - só bloqueia em ALTA confiança (Porn/Hentai > LIMIAR); "Sexy" médio NÃO bloqueia
//   (a calibração fina é o tijolo 2 — Fable);
// - falso-positivo custa mais que falso-negativo numa rede de amigos → limiar alto;
// - FALHA ABERTA em erro de infra (modelo não carrega / decode falha): regista e
//   deixa passar, para um problema técnico não derrubar TODOS os uploads. A recusa
//   é só por deteção positiva, nunca por avaria.
const sharp = require('sharp');
const { HttpError } = require('./http');

const LIMIAR = 0.85; // Porn/Hentai acima disto = recusa
const MSG = 'Esta imagem não pode entrar no Futty. Escolhe outra e segue em frente.';
// Só sabemos decodificar imagem estática; vídeo/gif passam sem análise (fora do
// âmbito do NSFWJS — anotado para a fase de vídeo/moderação reativa).
const IMAGENS = new Set(['image/jpeg', 'image/png', 'image/webp']);

let _tf = null;
let _modeloPromise = null;

function carregarModeloInterno() {
  if (!_modeloPromise) {
    _modeloPromise = (async () => {
      _tf = require('@tensorflow/tfjs');
      const nsfw = require('nsfwjs');
      const modelo = await nsfw.load(); // MobileNetV2 (224, quantizado)
      return modelo;
    })();
  }
  return _modeloPromise;
}

/** Pré-carrega o modelo no arranque (não bloqueia nem rebenta se falhar). */
async function carregarModelo() {
  try {
    await carregarModeloInterno();
    console.log('[nsfw] modelo carregado (uploads de imagem filtrados)');
  } catch (e) {
    console.error('[nsfw] falha a carregar o modelo — uploads seguem SEM filtro:', e.message);
  }
}

/**
 * Classifica um buffer de imagem. Devolve { explicito, scores } ou null se não
 * for imagem estática. NUNCA lança — o chamador decide.
 */
async function classificar(buffer) {
  const modelo = await carregarModeloInterno();
  const { data } = await sharp(buffer)
    .flatten({ background: '#ffffff' })
    .resize(224, 224, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const img = _tf.tensor3d(new Uint8Array(data), [224, 224, 3], 'int32');
  try {
    const preds = await modelo.classify(img);
    const scores = Object.fromEntries(preds.map((p) => [p.className, p.probability]));
    const explicito = Math.max(scores.Porn || 0, scores.Hentai || 0);
    return { explicito, scores };
  } finally {
    img.dispose();
  }
}

/**
 * Middleware Express — corre DEPOIS do multer. Analisa req.file (imagem estática);
 * explícito → 403 com mensagem digna; caso contrário segue. Vídeo/gif ou avaria
 * técnica = passa (falha aberta, registada).
 */
async function filtroNSFW(req, res, next) {
  try {
    const file = req.file;
    if (!file || !file.buffer) return next();
    if (!IMAGENS.has(file.mimetype)) return next(); // vídeo/gif: fora do âmbito
    const r = await classificar(file.buffer);
    if (r && r.explicito > LIMIAR) {
      console.warn('[nsfw] BLOQUEADO', { user: req.user?.id, explicito: r.explicito.toFixed(2) });
      return next(new HttpError(403, MSG));
    }
    return next();
  } catch (e) {
    // Falha aberta: um erro técnico não pode trancar todos os uploads.
    console.error('[nsfw] erro na análise — deixa passar:', e.message);
    return next();
  }
}

module.exports = { filtroNSFW, carregarModelo, classificar, LIMIAR, MSG };
