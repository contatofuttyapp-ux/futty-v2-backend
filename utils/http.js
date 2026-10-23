// Futty v2.0 — Utilitários HTTP: erro com status + wrapper de handlers async.

/**
 * Erro com código HTTP. Lançado pelos handlers/helpers e tratado pelo
 * error handler central em server.js (devolve { error } com o status certo).
 */
class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    // Código opcional legível pela máquina (ex.: 'CONTA_SUSPENSA') — o frontend
    // distingue o motivo sem depender do texto da mensagem.
    this.code = code;
  }
}

// Quem não é do time e abre o jogo, o ranking, o elenco ou a Resenha dele. Frase e código únicos: a tela mostra a verdade ("você não
// faz parte") pelo código, em vez de tratar o 403 como falha de internet.
const MSG_FORA_DO_TIME = 'Você não faz parte deste time.';
const CODIGO_FORA_DO_TIME = 'FORA_DO_TIME';
const foraDoTime = () => new HttpError(403, MSG_FORA_DO_TIME, CODIGO_FORA_DO_TIME);

/**
 * Envolve um handler async para que qualquer erro (throw/rejeição) seja
 * encaminhado para o error handler central via next(err).
 * @param {Function} fn handler async (req, res, next)
 */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { HttpError, asyncHandler, MSG_FORA_DO_TIME, CODIGO_FORA_DO_TIME, foraDoTime };
