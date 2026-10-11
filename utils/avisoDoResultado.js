// Futty v2.0 — O aviso "Resultado registrado!" do time, uma vez só por jogo.
//
// O editor do resultado grava em dois pedidos (quem ganhou + gols em PATCH /api/games/:id/resultado; prêmios e foto em PATCH
// /api/feed/games/:id/resultado) e o mesmo jogo pode ser corrigido várias vezes. Se cada pedido avisasse, o time receberia dois toques
// a cada salvamento. Aqui vive a regra: avisa quando o jogo passa de "nada para ver" a "tem o que ver" (resultado — campeão ou empate —
// ou algum prêmio); corrigir o que já foi anunciado não avisa de novo. Puro: quem chama entrega os membros e o envio, então não guarda
// nem o banco nem o push na hora do require.
const { temResultado } = require('./resultadoDoJogo');

/** O jogo já tem algo que o time possa ver na Resenha: resultado ou algum prêmio. */
function temNovidade(g) {
  return temResultado(g) || !!(g && (g.artilheiro_user_id || g.destaque_user_id || g.rodada_user_id));
}

/**
 * @param {{ antes: object, depois: object, local?: string|null, membros: () => Promise<string[]>, enviar: Function }} p
 *   antes/depois: o jogo antes e depois do pedido; membros: devolve os ids a avisar; enviar: o enviarNotificacao do push.
 * @returns {Promise|null} a promessa do envio (para teste), ou null quando não havia novidade a anunciar
 */
function anunciarResultado({ antes, depois, local, membros, enviar }) {
  if (temNovidade(antes) || !temNovidade(depois)) return null;
  return Promise.resolve(membros()).then((ids) => enviar(ids, {
    title: '🏆 Resultado registrado!',
    body: `Veja quem foi o destaque em ${local || 'Jogo'}`,
    url: '/feed',
  }, { categoria: 'resenha' })); // o tipo "Resenha" do Perfil → Notificações
}

module.exports = { temNovidade, anunciarResultado };
