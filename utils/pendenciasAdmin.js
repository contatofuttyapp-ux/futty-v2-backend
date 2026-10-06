// Futty v2.0 — O card "Seu time" do Início, só para quem administra algum time.
//
// "Admin não é um lugar" (dono): o que o Dashboard do painel mostrava vira, no Início, uma linha por pendência —
// pedido de entrada, jogo sem presença aberta, resultado por lançar, denúncia — e o card fica compacto ("Tudo tranquilo por
// aqui.") quando não há nenhuma. Aqui vive a conta, pura (sem banco), para testar no Node; a leitura está em services/inicio.js.

// "Jogo sem presença aberta" só é pendência quando o jogo está perto: com o jogo daqui a três semanas, presença fechada é o normal.
const JANELA_DA_PRESENCA_MS = 7 * 24 * 3600 * 1000;

const cancelado = (g) => !!g?.cancelado || g?.status === 'cancelado';

/**
 * As pendências de UM time, a partir do que o motor leu dele:
 *   pedidos    nº de pedidos de entrada pendentes
 *   jogos      os jogos do time (futuros e passados recentes): { id, data, status, cancelado, resultado_nivel, rsvp_aberto, rsvp_fechado }
 *   denuncias  nº de denúncias à espera do admin (fila + escaladas)
 * Devolve { pedidos, presenca: { game_id, data } | null, resultado: { game_id, data } | null, denuncias, total }.
 */
function pendenciasDoTime({ pedidos = 0, jogos = [], denuncias = 0 }, agora = Date.now()) {
  const validos = (jogos || []).filter((g) => g?.data && !cancelado(g) && Number.isFinite(new Date(g.data).getTime()));
  const ms = (g) => new Date(g.data).getTime();

  // O PRÓXIMO jogo (o primeiro daqui pra frente): se for nos próximos 7 dias e a presença nunca foi aberta, é pendência.
  const proximo = validos.filter((g) => ms(g) >= agora).sort((a, b) => ms(a) - ms(b))[0] || null;
  const presenca = proximo && ms(proximo) - agora <= JANELA_DA_PRESENCA_MS && !proximo.rsvp_aberto && !proximo.rsvp_fechado
    ? { game_id: proximo.id, data: proximo.data }
    : null;

  // O ÚLTIMO jogo que já aconteceu, sem resultado nenhum lançado.
  const ultimo = validos.filter((g) => ms(g) < agora).sort((a, b) => ms(b) - ms(a))[0] || null;
  const resultado = ultimo && !(ultimo.resultado_nivel > 0) ? { game_id: ultimo.id, data: ultimo.data } : null;

  const p = Math.max(0, pedidos | 0);
  const d = Math.max(0, denuncias | 0);
  return { pedidos: p, presenca, resultado, denuncias: d, total: p + d + (presenca ? 1 : 0) + (resultado ? 1 : 0) };
}

module.exports = { JANELA_DA_PRESENCA_MS, pendenciasDoTime };
