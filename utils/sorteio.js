// Futty v2.0 — Lógica do sorteio de times.
// Cada jogador é um objeto { user_id, nome, rating, goleiro, cabeca_chave }.
// Devolve { numTimes, times: [ [jogadores...] ], reservas: [jogadores...] }.

/** Baralha um array in-place (Fisher-Yates) — aleatoriedade pura para desempate. */
function fisherYates(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Ordena por rating desc com desempate aleatório.
 * Baralha primeiro e depois faz um sort estável — quando os ratings são iguais
 * (ex.: todos a zero) o resultado é praticamente aleatório (aleatoriedade máxima).
 */
function ordenarPorRating(jogadores) {
  const arr = fisherYates(jogadores.slice());
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
function distribuirGoleiros(goleiros, numTimes) {
  const ord = ordenarPorRating(goleiros);
  const assigned = new Array(numTimes).fill(null);
  const ordemTimes = fisherYates(Array.from({ length: numTimes }, (_, i) => i));
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
function distribuirCabecasChave(cabecas, numTimes) {
  const ord = ordenarPorRating(cabecas);
  const baldes = snakeDraft(ord, numTimes); // cada time recebe um "balde"
  const assigned = baldes.map((b) => b[0] || null); // 1º de cada balde = cabeça do time
  const excesso = baldes.flatMap((b) => b.slice(1)); // 2º+ = excesso -> linha
  return { assigned, excesso };
}

/**
 * Função principal do sorteio.
 * @param {Array} confirmados jogadores confirmados
 * @param {number} jogadoresPorTime tamanho exato de cada time
 * @returns {{ numTimes:number, times:Array<Array>, reservas:Array }}
 */
function executarSorteio(confirmados, jogadoresPorTime) {
  const porTime = Math.max(1, parseInt(jogadoresPorTime, 10) || 1);
  const numTimes = Math.floor(confirmados.length / porTime);
  // Mínimo 2 times. O chamador valida antes, mas protegemos na mesma.
  if (numTimes < 2) {
    return { numTimes: 0, times: [], reservas: confirmados.slice() };
  }

  const { goleiros, cabecas, linha } = separarPorCategoria(confirmados);
  const g = distribuirGoleiros(goleiros, numTimes);
  const c = distribuirCabecasChave(cabecas, numTimes);

  // Times começam com o goleiro e a cabeça de chave atribuídos.
  const times = Array.from({ length: numTimes }, () => []);
  for (let i = 0; i < numTimes; i += 1) {
    if (g.assigned[i]) times[i].push(g.assigned[i]);
    if (c.assigned[i]) times[i].push(c.assigned[i]);
  }

  // Pool a distribuir: primeiro os excessos de goleiros/cabeças (NUNCA podem ir
  // para reservas, por isso são colocados antes), depois a linha comum.
  const pool = ordenarPorRating(g.excesso.concat(c.excesso)).concat(ordenarPorRating(linha));

  // Preenche os times por rondas em snake (A B C / C B A / ...) até cada time
  // ter EXACTAMENTE porTime jogadores. Times cheios são saltados.
  const reservas = [];
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

  // O que sobrar (apenas linha comum, em condições normais) vai para reservas.
  while (p < pool.length) {
    reservas.push(pool[p]);
    p += 1;
  }

  return { numTimes, times, reservas };
}

module.exports = {
  executarSorteio,
  // exportados para testes
  separarPorCategoria,
  distribuirGoleiros,
  distribuirCabecasChave,
  fisherYates,
  snakeDraft,
};
