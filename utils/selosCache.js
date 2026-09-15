// Futty v2.0 — Cache dos selos do usuário (GET /api/me/selos), 15-set, "Velocidade 7A".
//
// computeSelos (routes/campeonatos.js) faz, POR TIME, um list no Storage + um
// download por campeonato + o ranking inteiro: 515-525 ms de motor no relatório
// do Diagnóstico, para uma resposta que muda poucas vezes por semana. Fica em
// cache por usuário durante 2 min, com renovação por trás (utils/cacheQuente.js),
// e é esquecido NA HORA quando acontece o que mexe nos selos:
//   · um campeonato termina ou é apagado          → routes/campeonatos.js
//   · um voto é registrado ou zerado               → routes/ranking.js
//   · alguém entra, sai ou muda de estado num time → routes/teams.js
// O resto (resultado de jogo, presença) mexe no ranking e aparece em até 2 min.
const { criarCache } = require('./cacheQuente');

const cache = criarCache({ nome: 'selos', ttlMs: 2 * 60 * 1000, max: 2000 });

/** @param {() => Promise<{ selos: object[], teamIds: string[] }>} calcular */
function obter(userId, calcular) {
  return cache.obter(userId, calcular);
}

/** O ranking ou os campeonatos do time mudaram: vale para todos os membros. */
function invalidarEquipa(teamId) {
  cache.invalidarSe((valor) => valor.teamIds.includes(teamId));
}

/** Alguém entrou ou saiu do time: muda a lista de times dessa pessoa e o ranking do time. */
function invalidarMembro(teamId, userId) {
  cache.invalidar(userId);
  invalidarEquipa(teamId);
}

module.exports = { obter, invalidarEquipa, invalidarMembro };
