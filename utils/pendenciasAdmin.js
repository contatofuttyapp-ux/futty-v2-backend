// Futty v2.0 — O card "Seu time" do Início, só para quem administra algum time.
//
// "Admin não é um lugar" (dono): o que o Dashboard do painel mostrava vira, no Início, uma linha por pendência —
// pedido de entrada, resultado por lançar, denúncia — e o card fica compacto ("Tudo tranquilo por aqui.") quando não há nenhuma.
// Aqui vive a conta, pura (sem banco), para testar no Node; a leitura está em services/inicio.js.
// "Presença ainda não aberta" deixou de ser pendência: o jogo nasce chamando o elenco (utils/chamadaDoJogo.js), não há o que abrir.
// O campo `presenca` continua no JSON, sempre null, para o app antigo não quebrar.

// Ficou exportada (o app antigo lê o nome); não decide mais nada aqui.
const JANELA_DA_PRESENCA_MS = 7 * 24 * 3600 * 1000;

const { temResultado, resultadoJaAbriu } = require('./resultadoDoJogo');

const cancelado = (g) => !!g?.cancelado || g?.status === 'cancelado';

/**
 * As pendências de UM time, a partir do que o motor leu dele:
 *   pedidos    nº de pedidos de entrada pendentes
 *   jogos      os jogos do time (futuros e passados recentes): { id, data, status, cancelado, campeao_time_index, time_vencedor }
 *   denuncias  nº de denúncias à espera do admin (fila + escaladas)
 * Devolve { pedidos, presenca: null, resultado: { game_id, data } | null, denuncias, total }.
 */
function pendenciasDoTime({ pedidos = 0, jogos = [], denuncias = 0 }, agora = Date.now()) {
  const validos = (jogos || []).filter((g) => g?.data && !cancelado(g) && Number.isFinite(new Date(g.data).getTime()));
  const ms = (g) => new Date(g.data).getTime();
  const presenca = null;

  // O ÚLTIMO jogo que já começou, sem campeão nem empate marcado — o mesmo critério do card "Quem ganhou?" do Início (nível, placar e gols
  // sozinhos não são resultado). Só vale depois que o resultado abre (5 minutos depois do início): antes disso não há o que lançar.
  const ultimo = validos.filter((g) => ms(g) < agora).sort((a, b) => ms(b) - ms(a))[0] || null;
  const resultado = ultimo && resultadoJaAbriu(ultimo, agora) && !temResultado(ultimo) ? { game_id: ultimo.id, data: ultimo.data } : null;

  const p = Math.max(0, pedidos | 0);
  const d = Math.max(0, denuncias | 0);
  return { pedidos: p, presenca, resultado, denuncias: d, total: p + d + (presenca ? 1 : 0) + (resultado ? 1 : 0) };
}

module.exports = { JANELA_DA_PRESENCA_MS, pendenciasDoTime };
