// Futty v2.0 — A chamada do jogo: quem foi chamado, até quando dá para responder "Vou / Não vou" e a hora do sorteio.
//
// Regras do dono (Rodada 32H):
//   · o jogo nasce CHAMANDO: o elenco inteiro (games.chamados NULL) ou só quem o admin escolheu (games.chamados = [ids]). Não existe
//     mais "abrir presença", "fechar presença" nem prazo — a lista está aberta desde que o jogo existe;
//   · o jogo tem a HORA DO SORTEIO (games.sorteio_em; sem ela, 1 hora antes do jogo). Nessa hora a lista FECHA SOZINHA (ninguém mais
//     responde) — é conta de relógio, sem job. Se o admin sortear antes, a lista fecha naquele momento (sorteio_realizado);
//   · cancelado, ou já começado, também fecha.
// Só a regra (sem banco), para testar no Node. As duas colunas são da migração 089: sem ela, todo jogo chama o elenco e sorteia 1 h antes.
const UMA_HORA_MS = 60 * 60 * 1000;

const ms = (iso) => (iso ? new Date(iso).getTime() : NaN);

/** A hora do sorteio "de fábrica": 1 hora antes do jogo. Se isso já passou (jogo marcado em cima da hora), a hora do próprio jogo. */
function sorteioPadrao(dataDoJogo, agora = Date.now()) {
  const inicio = ms(dataDoJogo);
  if (!Number.isFinite(inicio)) return null;
  const umaHoraAntes = inicio - UMA_HORA_MS;
  return new Date(umaHoraAntes > agora ? umaHoraAntes : inicio).toISOString();
}

/** A hora do sorteio que vale para o jogo: a gravada ou, sem ela, 1 hora antes do jogo. */
function sorteioDoJogo(game) {
  if (game?.sorteio_em && Number.isFinite(ms(game.sorteio_em))) return new Date(game.sorteio_em).toISOString();
  const inicio = ms(game?.data);
  return Number.isFinite(inicio) ? new Date(inicio - UMA_HORA_MS).toISOString() : null;
}

const cancelado = (g) => !!g?.cancelado || g?.status === 'cancelado';

/**
 * A lista de presença ainda aceita resposta? Fecha na hora do sorteio, quando o admin já sorteou (ou montou os times), quando o jogo
 * foi cancelado e quando ele já começou.
 */
function listaAberta(game, agora = Date.now()) {
  if (!game || cancelado(game) || game.sorteio_realizado) return false;
  const inicio = ms(game.data);
  if (Number.isFinite(inicio) && agora >= inicio) return false;
  const sorteio = ms(sorteioDoJogo(game));
  return !(Number.isFinite(sorteio) && agora >= sorteio);
}

/** O elenco chamado: todo o elenco (chamados NULL) ou os escolhidos que ainda são do time. Quem só organiza nunca é chamado. */
function chamadosDoJogo(game, idsDoElenco, organizam = new Set()) {
  const elenco = (idsDoElenco || []).filter((id) => id && !organizam.has(id));
  if (!Array.isArray(game?.chamados)) return elenco;
  const escolhidos = new Set(game.chamados);
  return elenco.filter((id) => escolhidos.has(id));
}

/** Esta pessoa foi chamada? (para quem já sabe que ela é do time e joga) */
function foiChamado(game, userId) {
  return !Array.isArray(game?.chamados) || game.chamados.includes(userId);
}

/**
 * A hora do sorteio que o admin escolheu (instante ISO, já convertido do relógio do time), conferida: tem de ser um instante de verdade,
 * não depois do jogo e não no passado (alguns segundos de folga para o relógio do celular). Devolve { iso } ou { erro }.
 */
function sorteioEscolhido(iso, dataDoJogo, agora = Date.now()) {
  const t = ms(iso);
  if (!Number.isFinite(t)) return { erro: 'Hora do sorteio inválida.' };
  if (t > ms(dataDoJogo)) return { erro: 'O sorteio tem de ser antes do jogo (ou na hora dele).' };
  if (t < agora - 60 * 1000) return { erro: 'A hora do sorteio já passou.' };
  return { iso: new Date(t).toISOString() };
}

/**
 * Ao mudar a data/hora do jogo sem dizer a do sorteio: se o sorteio estava no "de fábrica" (1 h antes), ele anda junto; se o admin
 * tinha escolhido outra hora, ela fica — a não ser que o jogo novo comece antes dela (aí volta para o de fábrica).
 */
function sorteioAoMudarOJogo({ sorteioAntigo, dataAntiga, dataNova }, agora = Date.now()) {
  const eraDeFabrica = !sorteioAntigo || ms(sorteioAntigo) === ms(dataAntiga) - UMA_HORA_MS || ms(sorteioAntigo) === ms(dataAntiga);
  if (eraDeFabrica || ms(sorteioAntigo) > ms(dataNova)) return sorteioPadrao(dataNova, agora);
  return new Date(sorteioAntigo).toISOString();
}

module.exports = { UMA_HORA_MS, sorteioPadrao, sorteioDoJogo, listaAberta, chamadosDoJogo, foiChamado, sorteioEscolhido, sorteioAoMudarOJogo };
