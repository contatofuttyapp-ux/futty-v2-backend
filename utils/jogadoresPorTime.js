// Futty v2.0 — Rodada 29I, bloco 3 (item 68 da Rodada 29): jogadores por time, UM padrão no time.
//
// Era perguntado duas vezes — na criação do time e em cada jogo novo. Agora o time guarda o seu padrão (teams.jogadores_por_time,
// migração 079; Ajustes do time) e o "Novo jogo" e os recorrentes já nascem com ele; cada jogo continua podendo mudar só para si
// (games.jogadores_por_time). Sem a migração, ou sem padrão escolhido, vale 5 — o que os recorrentes sempre usaram.
// Puro (sem banco), para testar no Node.

const PADRAO = 5;
const MINIMO = 2;
const MAXIMO = 11;

/** O que veio no corpo → número de 2 a 11, null (= volta ao padrão da casa) ou undefined (= inválido, 400). */
function lerJogadoresPorTime(valor) {
  if (valor == null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < MINIMO || n > MAXIMO) return undefined;
  return n;
}

/** O padrão do time (sem a 079 a coluna não vem: 5). */
function jogadoresPorTimeDoTime(team) {
  const n = Number(team?.jogadores_por_time);
  return Number.isInteger(n) && n >= MINIMO && n <= MAXIMO ? n : PADRAO;
}

const erroDaColunaJogadoresPorTime = (erro) => !!erro && /jogadores_por_time/i.test(erro.message || '');

module.exports = { PADRAO, MINIMO, MAXIMO, lerJogadoresPorTime, jogadoresPorTimeDoTime, erroDaColunaJogadoresPorTime };
