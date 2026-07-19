// Futty v2.0 — Lógica do sorteio de times.
// Cada jogador é um objeto { user_id, nome, rating, goleiro, cabeca_chave }.
// Devolve { numTimes, times: [ [jogadores...] ], reservas: [jogadores...], seed }.
//
// SEMENTE (SPEC-SORTEIO §10): toda a aleatoriedade passa por um RNG determinístico
// (mulberry32) semeado — a MESMA seed reproduz o MESMO resultado e a MESMA sequência
// de picks. A seed persiste dentro de times_resultado → replay EXACTO da animação.

/** RNG determinístico (mulberry32) — pequeno, rápido e suficiente para o sorteio. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Baralha um array in-place (Fisher-Yates) com o RNG semeado. */
function fisherYates(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Ordena por rating desc com desempate aleatório (semeado).
 * Baralha primeiro e depois faz um sort estável — quando os ratings são iguais
 * (ex.: todos a zero) o resultado é praticamente aleatório (aleatoriedade máxima).
 */
function ordenarPorRating(jogadores, rng = Math.random) {
  const arr = fisherYates(jogadores.slice(), rng);
  arr.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  return arr;
}

/** Separa os confirmados em goleiros, cabeças de chave e jogadores de linha. */
function separarPorCategoria(jogadores) {
  const goleiros = jogadores.filter((j) => j.goleiro);
  const cabecas = jogadores.filter((j) => j.cabeca_chave && !j.goleiro);
  const linha = jogadores.filter((j) => !j.goleiro && !j.cabeca_chave);
  return { goleiros, cabecas, linha };
}

/** Snake draft clássico: distribui um array por N times no padrão A,B,C,C,B,A,A,... */
function snakeDraft(jogadores, numTimes) {
  const times = Array.from({ length: numTimes }, () => []);
  let idx = 0;
  let dir = 1;
  for (const j of jogadores) {
    times[idx].push(j);
    if (dir === 1) {
      if (idx === numTimes - 1) dir = -1;
      else idx += 1;
    } else if (idx === 0) dir = 1;
    else idx -= 1;
  }
  return times;
}

/**
 * Distribui goleiros — um por time (ordenados por rating desc, ordem de times
 * aleatória para não stackar sempre no mesmo time). O excesso vira linha.
 * @returns {{ assigned: Array, excesso: Array }} assigned[i] = goleiro do time i (ou null)
 */
function distribuirGoleiros(goleiros, numTimes, rng = Math.random) {
  const ord = ordenarPorRating(goleiros, rng);
  const assigned = new Array(numTimes).fill(null);
  const ordemTimes = fisherYates(Array.from({ length: numTimes }, (_, i) => i), rng);
  for (let i = 0; i < numTimes && i < ord.length; i += 1) {
    assigned[ordemTimes[i]] = ord[i];
  }
  return { assigned, excesso: ord.slice(numTimes) };
}

/**
 * Distribui cabeças de chave — snake draft por rating desc, um por time.
 * O excesso (mais cabeças do que times) vira linha.
 * @returns {{ assigned: Array, excesso: Array }} assigned[i] = cabeça do time i (ou null)
 */
function distribuirCabecasChave(cabecas, numTimes, rng = Math.random) {
  const ord = ordenarPorRating(cabecas, rng);
  const baldes = snakeDraft(ord, numTimes); // cada time recebe um "balde"
  const assigned = baldes.map((b) => b[0] || null); // 1º de cada balde = cabeça do time
  const excesso = baldes.flatMap((b) => b.slice(1)); // 2º+ = excesso -> linha
  return { assigned, excesso };
}

/**
 * Função principal do sorteio.
 * @param {Array} confirmados jogadores confirmados (membros; convidados vão em opts)
 * @param {number} jogadoresPorTime tamanho exato de cada time
 * @param {object} [opts]
 * @param {number} [opts.seed] semente do RNG (gerada se ausente) — replay exacto
 * @param {string[]} [opts.convidados] nomes de CONVIDADOS SEM APP (SPEC §11):
 *   entram como jogadores de linha sem user_id; zero impacto em users/ranking.
 * @returns {{ numTimes:number, times:Array<Array>, reservas:Array, seed:number }}
 */
function executarSorteio(confirmados, jogadoresPorTime, opts = {}) {
  const seed = Number.isInteger(opts.seed) ? opts.seed : Math.floor(Math.random() * 2147483647);
  const rng = mulberry32(seed);

  // Convidados sem app: só nome, sem conta — vivem apenas neste resultado.
  const convidados = (opts.convidados || [])
    .map((n) => String(n).trim())
    .filter(Boolean)
    .slice(0, 28)
    .map((nome, i) => ({ user_id: null, convidado: true, nome, rating: 0, goleiro: false, cabeca_chave: false, avatar_url: null }));
  const todos = confirmados.concat(convidados);

  const porTime = Math.max(1, parseInt(jogadoresPorTime, 10) || 1);
  const numTimes = Math.floor(todos.length / porTime);
  // Mínimo 2 times. O chamador valida antes, mas protegemos na mesma.
  if (numTimes < 2) {
    return { numTimes: 0, times: [], reservas: todos.slice(), seed };
  }

  const { goleiros, cabecas, linha } = separarPorCategoria(todos);
  const g = distribuirGoleiros(goleiros, numTimes, rng);
  const c = distribuirCabecasChave(cabecas, numTimes, rng);

  // Times começam com o goleiro e a cabeça de chave atribuídos.
  const times = Array.from({ length: numTimes }, () => []);
  for (let i = 0; i < numTimes; i += 1) {
    if (g.assigned[i]) times[i].push(g.assigned[i]);
    if (c.assigned[i]) times[i].push(c.assigned[i]);
  }

  // Pool a distribuir: primeiro os excessos de goleiros/cabeças (NUNCA podem ir
  // para reservas, por isso são colocados antes), depois a linha comum.
  const pool = ordenarPorRating(g.excesso.concat(c.excesso), rng).concat(ordenarPorRating(linha, rng));

  // Preenche os times por rondas em snake (A B C / C B A / ...) até cada time
  // ter EXACTAMENTE porTime jogadores. Times cheios são saltados.
  let p = 0;
  let round = 0;
  while (p < pool.length) {
    const ordem = round % 2 === 0
      ? times.map((_, i) => i)
      : times.map((_, i) => i).reverse();
    let colocou = false;
    for (const ti of ordem) {
      if (p >= pool.length) break;
      if (times[ti].length < porTime) {
        times[ti].push(pool[p]);
        p += 1;
        colocou = true;
      }
    }
    round += 1;
    if (!colocou) break; // todos os times cheios
  }

  // Banco de reservas: o que sobrar (apenas linha comum — os excessos de
  // goleiros/cabeças foram colocados à frente do pool, por isso NUNCA sobram).
  // Ordenado por rating DESC (o melhor entra primeiro) e numerado por posição.
  const reservas = pool
    .slice(p)
    .sort((a, b) => (b.rating || 0) - (a.rating || 0))
    .map((j, i) => {
      const r = {
        posicao: i + 1,
        user_id: j.user_id,
        convidado: j.convidado || undefined,
        nome: j.nome,
        avatar_url: j.avatar_url || null,
        rating: j.rating,
      };
      if (i === 0) r.ordem_entrada = 'primeiro'; // o mais provável de entrar
      return r;
    });

  return { numTimes, times, reservas, seed };
}

module.exports = {
  executarSorteio,
  mulberry32,
  // exportados para testes
  separarPorCategoria,
  distribuirGoleiros,
  distribuirCabecasChave,
  fisherYates,
  snakeDraft,
};
