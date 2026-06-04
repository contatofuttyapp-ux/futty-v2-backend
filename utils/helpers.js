// Futty v2.0 — Funções puras reutilizáveis (sem acesso à base de dados).

// Rating por defeito de quem ainda não tem votos (meio da escala 1-5).
const RATING_DEFAULT = 3;

/** Arredonda a 2 casas decimais. */
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Gera um slug a partir de um nome (sem acentos, minúsculas, sufixo aleatório).
 * @param {string} nome
 * @returns {string}
 */
function slugify(nome) {
  const base = nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base || 'equipa'}-${suffix}`;
}

// NOTA: a lógica de sorteio (fisherYates, snakeDraft, ordenação por rating)
// foi movida para utils/sorteio.js.

/** Data de corte ISO para um período de ranking (null = geral). */
function periodoCutoffISO(periodo) {
  const now = Date.now();
  if (periodo === 'semana') return new Date(now - 7 * 86400000).toISOString();
  if (periodo === 'mes') return new Date(now - 30 * 86400000).toISOString();
  return null;
}

module.exports = {
  RATING_DEFAULT,
  round2,
  slugify,
  periodoCutoffISO,
};
