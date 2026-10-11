// Futty v2.0 — "Quem ganhou?": a regra do resultado de um jogo, pura (sem banco, sem rede), para o motor inteiro.
//
// UMA verdade só: `games.campeao_time_index` (o time que ganhou, pelo índice em times_resultado.times). Tudo o que
// diz "quem ganhou" nasce dele — o ranking, a Resenha, os selos e os cartões leem o mesmo dado:
//   · `time_vencedor` ('A' | 'B' | 'empate') é DERIVADO: só existe com exatamente 2 times (índice 0 → 'A', 1 → 'B');
//   · o empate é explícito: `campeao_time_index` nulo + `time_vencedor = 'empate'`. Jogo sem resultado é os dois nulos —
//     os dois estados nunca se confundem (sem isso o ranking contava "sem resultado" como empate).
// Os dois editores (PATCH /api/games/:id/resultado e PATCH /api/feed/games/:id/resultado) passam por aqui, então nenhum
// deles consegue gravar um vencedor que o outro contradiz.

/** Quantos times o jogo tem (os do sorteio ou da montagem à mão). */
function quantosTimes(timesResultado) {
  return Array.isArray(timesResultado?.times) ? timesResultado.times.length : 0;
}

const { HttpError } = require('./http');

const indiceValido = (n) => Number.isInteger(n) && n >= 0;

/** `time_vencedor` a partir do campeão: só com 2 times a letra existe; com 3 ou 4 não há A/B que descreva o campeão. */
function vencedorDerivado({ nTimes, campeaoIdx, empate }) {
  if (nTimes !== 2) return null;
  if (campeaoIdx === 0) return 'A';
  if (campeaoIdx === 1) return 'B';
  return empate ? 'empate' : null;
}

/**
 * O que o jogo diz hoje: `{ tipo: 'campeao', idx }`, `{ tipo: 'empate' }` ou null (sem resultado).
 * `campeao_time_index` manda. O `time_vencedor` sozinho só vale para jogo antigo, gravado pela tela do jogo
 * antes de a regra ser única (campeão nulo + 'A'/'B'): lê-se como se o campeão estivesse preenchido, até o conserto
 * dos dados (scripts/consertar-campeao-antigo.js) preencher o campeão de verdade.
 */
function resultadoGravado(g) {
  if (!g) return null;
  if (indiceValido(g.campeao_time_index)) return { tipo: 'campeao', idx: g.campeao_time_index };
  if (g.time_vencedor === 'empate') return { tipo: 'empate' };
  if (g.time_vencedor === 'A') return { tipo: 'campeao', idx: 0 };
  if (g.time_vencedor === 'B') return { tipo: 'campeao', idx: 1 };
  return null;
}

/** O jogo já tem campeão ou empate marcado? (É o critério de "resultado lançado": nível, placar e gols não bastam.) */
function temResultado(g) {
  return resultadoGravado(g) !== null;
}

/** Os jogadores do time campeão (lista vazia se não há campeão, se o índice não existe ou se foi empate). */
function jogadoresDoCampeao(g) {
  const r = resultadoGravado(g);
  if (!r || r.tipo !== 'campeao') return [];
  const t = g.times_resultado?.times?.[r.idx];
  return Array.isArray(t?.jogadores) ? t.jogadores : [];
}

/**
 * Como cada jogador saiu do jogo, por user_id (convidado sem app não tem conta e fica de fora): quem esteve no time campeão
 * venceu e os dos outros times perderam; no empate, todos os que jogaram empataram. Reserva e quem não estava nos times não
 * ganha nem perde. Sem resultado, as três listas vêm vazias.
 * @returns {{ venceram: string[], empataram: string[], perderam: string[] }}
 */
function desfechoDoJogo(g) {
  const saida = { venceram: [], empataram: [], perderam: [] };
  const r = resultadoGravado(g);
  if (!r) return saida;
  const times = Array.isArray(g.times_resultado?.times) ? g.times_resultado.times : [];
  times.forEach((t, i) => {
    const ids = (Array.isArray(t?.jogadores) ? t.jogadores : []).map((x) => x.user_id).filter(Boolean);
    if (r.tipo === 'empate') saida.empataram.push(...ids);
    else if (i === r.idx) saida.venceram.push(...ids);
    else saida.perderam.push(...ids);
  });
  return saida;
}

/** Como o jogador saiu do jogo: 'vitoria' | 'empate' | 'derrota', ou null (jogo sem resultado, ou ele não esteve em nenhum time). */
function resultadoDoJogador(g, userId) {
  const d = desfechoDoJogo(g);
  if (d.venceram.includes(userId)) return 'vitoria';
  if (d.empataram.includes(userId)) return 'empate';
  if (d.perderam.includes(userId)) return 'derrota';
  return null;
}

/**
 * Lê a escolha de "quem ganhou" de um corpo de pedido. Dois jeitos de dizer a mesma coisa:
 *   · o novo: `campeao_time_index` (0, 1, 2, 3 ou null) e `empate: true`;
 *   · o antigo (apps que ainda mandam `time_vencedor`): 'A' → 0, 'B' → 1, 'empate' → empate.
 * `campeao_time_index` presente no corpo ganha do `time_vencedor`. Devolve { campeaoIdx, empate, informado }; `informado` é
 * falso quando o corpo não diz nada sobre quem ganhou.
 * @throws {HttpError} 400 se o índice ou a letra não fazem sentido
 */
function escolhaDoCorpo(b = {}) {
  if ('campeao_time_index' in b || b.empate === true) {
    const bruto = b.campeao_time_index;
    const idx = bruto === null || bruto === undefined || bruto === '' ? null : Number(bruto);
    if (idx !== null && !indiceValido(idx)) throw new HttpError(400, 'campeao_time_index inválido.');
    return { campeaoIdx: idx, empate: idx === null && b.empate === true, informado: true };
  }
  if ('time_vencedor' in b && b.time_vencedor !== undefined) {
    const v = b.time_vencedor;
    if (v === null) return { campeaoIdx: null, empate: false, informado: true };
    if (v === 'A') return { campeaoIdx: 0, empate: false, informado: true };
    if (v === 'B') return { campeaoIdx: 1, empate: false, informado: true };
    if (v === 'empate') return { campeaoIdx: null, empate: true, informado: true };
    throw new HttpError(400, 'Indique quem venceu.');
  }
  return { campeaoIdx: null, empate: false, informado: false };
}

/**
 * A decisão do resultado: dado o número de times e a escolha, os campos que o jogo grava.
 * @param {{ nTimes: number, campeaoIdx?: number|null, empate?: boolean }} entrada
 * @returns {{ campeao_time_index: number|null, time_vencedor: string|null, resultado_nivel: number }}
 * @throws {HttpError} 400, com a frase pronta para o usuário
 */
function decidirResultado({ nTimes, campeaoIdx = null, empate = false }) {
  const escolheu = campeaoIdx !== null || empate;
  if (escolheu && !nTimes) throw new HttpError(400, 'Sorteie ou monte os times antes de dizer quem ganhou.');
  if (campeaoIdx !== null && campeaoIdx >= nTimes) throw new HttpError(400, 'Esse time não existe neste jogo.');
  return {
    campeao_time_index: campeaoIdx,
    time_vencedor: vencedorDerivado({ nTimes, campeaoIdx, empate }),
    resultado_nivel: escolheu ? 1 : 0,
  };
}

module.exports = {
  quantosTimes, vencedorDerivado, resultadoGravado, temResultado, jogadoresDoCampeao, desfechoDoJogo, resultadoDoJogador,
  escolhaDoCorpo, decidirResultado,
};
