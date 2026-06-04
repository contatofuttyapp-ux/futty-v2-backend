// Futty v2.0 — Utilitários HTTP: erro com status + wrapper de handlers async.

/**
 * Erro com código HTTP. Lançado pelos handlers/helpers e tratado pelo
 * error handler central em server.js (devolve { error } com o status certo).
 */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * Envolve um handler async para que qualquer erro (throw/rejeição) seja
 * encaminhado para o error handler central via next(err).
 * @param {Function} fn handler async (req, res, next)
 */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { HttpError, asyncHandler };
