// Futty v2.0 — As colunas da chamada (games.sorteio_em e games.chamados, migração 089) enquanto o dono não roda a migração.
//
// Leitura com lista de colunas (o Início, as pendências do admin) pede as duas; se o banco disser que não existem, repete sem elas e
// lembra por 5 minutos (para não errar uma vez por pedido). Escrita: `semColunasDaChamada` tira as duas da linha para repetir o insert.
// Sem elas, vale a regra de fábrica (utils/chamadaDoJogo.js): todo o elenco chamado e o sorteio 1 hora antes do jogo.
const COLUNAS = ', sorteio_em, chamados';
const MEMORIA_MS = 5 * 60 * 1000;
let faltaAte = 0;

const erroDaChamada = (erro) => !!erro && /sorteio_em|chamados/i.test(erro.message || '');

/** Roda `consulta(extra)`, onde `extra` é ", sorteio_em, chamados" ou "" (sem as colunas). Devolve o { data, error } que valeu. */
async function lerComChamada(consulta) {
  if (Date.now() < faltaAte) return consulta('');
  const r = await consulta(COLUNAS);
  if (!erroDaChamada(r.error)) return r;
  faltaAte = Date.now() + MEMORIA_MS;
  return consulta('');
}

/** A linha sem as colunas da 089 (para repetir uma escrita que o banco recusou por elas). */
function semColunasDaChamada(linha) {
  const { sorteio_em: _s, chamados: _c, ...resto } = linha;
  return resto;
}

/** Só para os testes. */
const esquecerFalta = () => { faltaAte = 0; };

module.exports = { lerComChamada, semColunasDaChamada, erroDaChamada, esquecerFalta };
