// Futty v2.0 — o ESTADO de um jogo, puro (sem banco, sem rede): a regra única do rótulo e da lista, para o motor inteiro.
//
//   · antes do início ................................ 'agendado'
//   · do início até o PRIMEIRO de (a) resultado lançado — campeão ou empate marcado, o mesmo critério de "Quem ganhou?" —
//     ou (b) 2 horas depois do início .................. 'em_curso' (a tela diz "Em andamento")
//   · depois disso ................................... 'terminado'
//   · jogo cancelado ................................. 'cancelado', sempre
//
// O jogo é gravado como INSTANTE (UTC) e o fuso do time só diz em que relógio ele se lê: a conta é entre instantes, então o
// estado é o mesmo para quem olha de São Paulo, de Lisboa ou de qualquer lugar.
//
// É SÓ rótulo e lista. Ranking, perfil, presença, o card "Quem ganhou?" e toda conta que hoje usa "data <= agora" continuam
// com a conta deles: um jogo que já começou deixou de aceitar presença, esteja "em curso" ou "terminado".
const { temResultado } = require('./resultadoDoJogo');

// Um jogo de futebol amador cabe em duas horas; sem resultado lançado, passado esse tempo ele deixa de estar "em andamento".
const JANELA_EM_ANDAMENTO_MS = 2 * 60 * 60 * 1000;

/**
 * @param {{ data?: string|null, status?: string, cancelado?: boolean, campeao_time_index?: number|null, time_vencedor?: string|null }} game
 * @param {number} [agora] Date.now() — injetado para o teste ser determinístico
 * @returns {'agendado'|'em_curso'|'terminado'|'cancelado'}
 */
function estadoDoJogo(game, agora = Date.now()) {
  if (game?.cancelado || game?.status === 'cancelado') return 'cancelado';
  if (game?.status === 'terminado' || temResultado(game)) return 'terminado';
  const inicio = game?.data ? new Date(game.data).getTime() : NaN;
  if (Number.isNaN(inicio) || inicio > agora) return 'agendado';
  return agora < inicio + JANELA_EM_ANDAMENTO_MS ? 'em_curso' : 'terminado';
}

module.exports = { estadoDoJogo, JANELA_EM_ANDAMENTO_MS };
