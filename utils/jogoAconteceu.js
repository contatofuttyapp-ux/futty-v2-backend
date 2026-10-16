// Futty v2.0 — QUANDO UMA PRESENÇA CONTA. Confirmar presença é dizer "vou"; o jogo só vira número (ranking, vitrine, "N jogos",
// "mais presente", médias do admin) depois que acontece. Um jogo conta a partir do horário marcado (ou antes, se o admin já o deu por
// terminado) e nunca se foi cancelado. Uma regra só para todo lugar que soma presença — a presença de fundador também passa por aqui.
// A lista de presença do jogo, o sorteio e os avisos continuam lendo a confirmação como sempre: lá ela é "quem vai", não "quem jogou".

/** O jogo já aconteceu para efeito de presença? (não cancelado e já começou, ou foi dado por terminado) */
function jogoAconteceu(g, agora = Date.now()) {
  if (!g || g.cancelado || g.status === 'cancelado') return false;
  if (g.status === 'terminado') return true;
  const inicio = g.data ? new Date(g.data).getTime() : NaN;
  return Number.isFinite(inicio) && inicio <= agora;
}

/** Os ids dos jogos que já aconteceram. */
function idsDosJogosQueAconteceram(jogos, agora = Date.now()) {
  return (jogos || []).filter((g) => g?.id && jogoAconteceu(g, agora)).map((g) => g.id);
}

module.exports = { jogoAconteceu, idsDosJogosQueAconteceram };
