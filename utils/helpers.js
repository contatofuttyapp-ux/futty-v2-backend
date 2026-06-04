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

/** Baralha um array in-place (Fisher-Yates). */
function fisherYates(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Ordena por rating desc; dentro do mesmo rating a ordem é aleatória.
 * Baralha primeiro (Fisher-Yates) e depois faz um sort estável por rating, por
 * isso "Sortear novamente" dá times diferentes mesmo com ratings iguais.
 */
function orderByRatingDesc(players) {
  const arr = fisherYates(players.slice());
  arr.sort((a, b) => b.rating - a.rating);
  return arr;
}

/** Snake draft: distribui os jogadores por N times no padrão A,B,C,C,B,A,A,... */
function snakeDraft(players, numTimes) {
  const teams = Array.from({ length: numTimes }, () => []);
  let idx = 0;
  let dir = 1;
  for (const p of players) {
    teams[idx].push(p);
    if (dir === 1) {
      if (idx === numTimes - 1) dir = -1;
      else idx += 1;
    } else if (idx === 0) dir = 1;
    else idx -= 1;
  }
  return teams;
}

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
  fisherYates,
  orderByRatingDesc,
  snakeDraft,
  periodoCutoffISO,
};
