// Futty v2.0 — "Quem ganhou?": a regra do resultado de um jogo, pura (sem banco, sem rede), para o motor inteiro.
//
// UMA verdade só: `games.campeao_time_index` (o time que ganhou, pelo índice em times_resultado.times). Tudo o que
// diz "quem ganhou" nasce dele — o ranking, a Resenha, os selos e os cartões leem o mesmo dado:
//   · `time_vencedor` ('A' | 'B' | 'empate') é DERIVADO: só existe com exatamente 2 times (índice 0 → 'A', 1 → 'B');
//   · o empate é explícito: `campeao_time_index` nulo + `time_vencedor = 'empate'`. Jogo sem resultado é os dois nulos —
//     os dois estados nunca se confundem (sem isso o ranking contava "sem resultado" como empate).
// Os dois editores (PATCH /api/games/:id/resultado e PATCH /api/feed/games/:id/resultado) passam por aqui, então nenhum
// deles consegue gravar um vencedor que o outro contradiz.

// O resultado só abre depois que o jogo começou de verdade: 5 minutos depois do horário marcado (a mesma conta que faz o card "Quem ganhou?" do
// Início aparecer). Jogo histórico ("Jogo passado") não tem trava.
const ESPERA_DO_RESULTADO_MS = 5 * 60 * 1000;

/** O instante (ms) em que o resultado deste jogo abre, ou null para jogo sem data. */
function resultadoAbreEm(game) {
  const ms = game?.data ? new Date(game.data).getTime() : NaN;
  return Number.isNaN(ms) ? null : ms + ESPERA_DO_RESULTADO_MS;
}

/** O resultado já pode ser lançado? Jogo histórico sempre; os outros, 5 minutos depois do início. */
function resultadoJaAbriu(game, agora = Date.now()) {
  if (game?.historico) return true;
  const abre = resultadoAbreEm(game);
  return abre !== null && abre <= agora;
}

/** Quantos times o jogo tem (os do sorteio ou da montagem à mão). */
function quantosTimes(timesResultado) {
  return Array.isArray(timesResultado?.times) ? timesResultado.times.length : 0;
}

const { HttpError } = require('./http');
const { chaveDoJogador } = require('./registroDoSorteio');
const { textoCurto } = require('./entrada');

// Placar e gols de verdade cabem em dois dígitos (o cartão do jogo e a tabela do campeonato têm duas casas): acima disso é erro de digitação.
const MAX_GOLS = 99;
// Gol vazio, negativo ou ilegível vale 0 (como sempre valeu: o campo em branco do app); acima de 99 é erro de digitação e o admin é avisado.
const golsDe = (valor) => {
  const n = Math.max(0, Math.floor(Number(valor)) || 0);
  if (n > MAX_GOLS) throw new HttpError(400, `Gols: use um número de 0 a ${MAX_GOLS}.`);
  return n;
};

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
 * As linhas de gols_jogadores (sem game_id) a partir dos gols que o app mandou, cada uma com o time A/B de quem marcou. A chave é a do motor
 * (id de quem tem conta, nome de quem é convidado sem app): os dois times caem no mesmo objeto sem um sobrescrever o outro. Quem não está
 * nos dois primeiros times fica com `time: null` (a coluna só conhece A e B) — o gol vale para o artilheiro, não para o placar.
 */
function linhasDeGols(timesResultado, gols, membros = null) {
  const times = Array.isArray(timesResultado?.times) ? timesResultado.times : [];
  const timeDe = {};
  times.slice(0, 2).forEach((t, i) => (t?.jogadores || []).forEach((j) => { timeDe[chaveDoJogador(j)] = i === 0 ? 'A' : 'B'; }));
  // Quem marca é gente do time: os membros de hoje e quem jogou os times do sorteio (um jogador que saiu do time depois do jogo continua
  // podendo ter o gol). Sem esta conta, o admin de um time gravava gols para o id de qualquer pessoa — e a tela do jogo mostrava o nome dela.
  let permitidos = null;
  if (membros) {
    permitidos = new Set(membros);
    times.forEach((t) => (t?.jogadores || []).forEach((j) => { if (j?.user_id) permitidos.add(j.user_id); }));
    (timesResultado?.reservas || []).forEach((j) => { if (j?.user_id) permitidos.add(j.user_id); });
  }
  return (Array.isArray(gols) ? gols : [])
    .map((g) => {
      if (!g || typeof g !== 'object') return null;
      if (g.user_id && permitidos && !permitidos.has(g.user_id)) throw new HttpError(400, 'Esse jogador não é do time.');
      if (g.user_id && typeof g.user_id !== 'string') throw new HttpError(400, 'Esse jogador não é do time.');
      const convidadoNome = g.user_id ? null : textoCurto(g.convidado_nome, 60, 'Nome do convidado');
      if (!g.user_id && !convidadoNome) return null;
      const chave = chaveDoJogador({ user_id: g.user_id || null, nome: convidadoNome });
      return { user_id: g.user_id || null, convidado_nome: convidadoNome || null, gols: golsDe(g.gols), time: timeDe[chave] || null };
    })
    .filter(Boolean);
}

/** O que as linhas de gols dizem: os gols de cada time (A, B) e se algum gol foi marcado. */
function somaDeGols(linhas) {
  const soma = { porTime: [0, 0], temGols: false };
  for (const l of linhas || []) {
    if (l.gols > 0) soma.temGols = true;
    if (l.time === 'A') soma.porTime[0] += l.gols;
    else if (l.time === 'B') soma.porTime[1] += l.gols;
  }
  return soma;
}

/**
 * O placar que o corpo do pedido digitou, ou null se não digitou nenhum. Os dois campos vêm juntos (um vazio é 0 só se o outro foi
 * preenchido); número que não é inteiro não negativo é recusado.
 * @returns {{ a: number, b: number }|null}
 * @throws {HttpError} 400 'Placar inválido.'
 */
function placarDoCorpo(b = {}) {
  const vazio = (v) => v === undefined || v === null || v === '';
  if (vazio(b.placar_a) && vazio(b.placar_b)) return null;
  const a = vazio(b.placar_a) ? 0 : Number(b.placar_a);
  const c = vazio(b.placar_b) ? 0 : Number(b.placar_b);
  if (!Number.isInteger(a) || a < 0 || a > MAX_GOLS || !Number.isInteger(c) || c < 0 || c > MAX_GOLS) throw new HttpError(400, 'Placar inválido.');
  return { a, b: c };
}

/**
 * A decisão do resultado: dado o número de times e o que foi informado, os campos que o jogo grava. Placar e vencedor nunca são escolhas
 * separadas — com 2 times quem manda é, nesta ordem:
 *   1. os GOLS por jogador, se algum foi lançado: o placar é a soma por time e ele define o vencedor (ou o empate);
 *   2. o PLACAR digitado, que define o vencedor (ou o empate);
 *   3. o vencedor tocado (campeaoIdx / empate), sem placar.
 * Nada informado = sem resultado.
 * Com 3 ou 4 times (rodízio) não há placar nem empate: só o campeão tocado. Os gols por jogador continuam valendo (artilheiro, nível 3), mas
 * não decidem nada — o rodízio não tem placar que some.
 * @param {{ nTimes: number, campeaoIdx?: number|null, empate?: boolean, placar?: {a:number,b:number}|null, golsPorTime?: number[]|null, temGols?: boolean }} entrada
 * @returns {{ campeao_time_index: number|null, time_vencedor: string|null, placar_a: number|null, placar_b: number|null, resultado_nivel: number }}
 * @throws {HttpError} 400, com a frase pronta para o usuário
 */
function decidirResultado({ nTimes, campeaoIdx = null, empate = false, placar = null, golsPorTime = null, temGols = false }) {
  let idx = campeaoIdx;
  let eEmpate = empate;
  let placarFinal = null;
  if (nTimes === 2) {
    const [golsA, golsB] = golsPorTime || [0, 0];
    if (golsA + golsB > 0) placarFinal = { a: golsA, b: golsB };
    else if (placar) placarFinal = { a: placar.a, b: placar.b };
    if (placarFinal) {
      idx = placarFinal.a > placarFinal.b ? 0 : placarFinal.a < placarFinal.b ? 1 : null;
      eEmpate = placarFinal.a === placarFinal.b;
    }
  }
  if (nTimes >= 3) {
    if (eEmpate) throw new HttpError(400, 'Com 3 ou 4 times não há empate: escolha o campeão.');
    if (placar) throw new HttpError(400, 'Com 3 ou 4 times não há placar: escolha só o campeão.');
  }
  if (placar && nTimes < 2) throw new HttpError(400, 'Sorteie ou monte os times antes de dizer quem ganhou.');
  const escolheu = idx !== null || eEmpate;
  if (escolheu && !nTimes) throw new HttpError(400, 'Sorteie ou monte os times antes de dizer quem ganhou.');
  if (idx !== null && idx >= nTimes) throw new HttpError(400, 'Esse time não existe neste jogo.');
  return {
    campeao_time_index: idx,
    time_vencedor: vencedorDerivado({ nTimes, campeaoIdx: idx, empate: eEmpate }),
    placar_a: placarFinal ? placarFinal.a : null,
    placar_b: placarFinal ? placarFinal.b : null,
    resultado_nivel: temGols ? 3 : placarFinal ? 2 : escolheu ? 1 : 0,
  };
}

module.exports = {
  ESPERA_DO_RESULTADO_MS, resultadoAbreEm, resultadoJaAbriu, quantosTimes, vencedorDerivado, resultadoGravado, temResultado, jogadoresDoCampeao, desfechoDoJogo, resultadoDoJogador,
  escolhaDoCorpo, linhasDeGols, somaDeGols, placarDoCorpo, decidirResultado, MAX_GOLS, golsDe,
};
