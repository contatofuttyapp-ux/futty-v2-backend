// Futty v2.0 — GET /api/inicio: agrega TUDO que a tela Início precisa num
// round-trip só. Motivo (11-set): motor em São Paulo, utilizador em Lisboa
// (~240ms/pedido) — os ~13 pedidos que o Início disparava ao abrir davam 3-4s
// só de latência de rede, antes de qualquer dado chegar. Cada peça usa a MESMA
// função de services/inicio.js que a rota antiga (nunca diverge do JSON que
// outras telas já dependem — as rotas antigas continuam de pé).
//
// 2 levas: a 1ª não depende de nada (corre tudo junto); a 2ª (votacao_status,
// campeonato, rsvp) depende de saber o time principal e o próximo jogo — só dá
// para calcular depois de teams/convites responderem.
//
// Promise.allSettled (via `seguro`, não Promise.all): se uma parte falhar (ex.:
// um time suspenso a meio da leitura), essa chave vem null e as restantes
// continuam — a tela não pode cair por causa de UM pedaço.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');
const inicioService = require('../services/inicio');

const router = express.Router();

async function seguro(promessa) {
  try {
    return await promessa;
  } catch (e) {
    console.error('[GET /api/inicio] uma parte falhou:', e.message);
    return null;
  }
}

router.get(
  '/api/inicio',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const [me, teams, convites, pedidos, votacoes_pendentes, denuncias_desfechos, ad] = await Promise.all([
      seguro(inicioService.obterMe(req.user)),
      seguro(inicioService.obterTeams(userId)),
      seguro(inicioService.obterConvites(userId)),
      seguro(inicioService.obterPedidos(userId)),
      seguro(inicioService.obterVotacoesPendentes(userId)),
      seguro(inicioService.obterDesfechosDenuncias(userId)),
      seguro(inicioService.obterAd('inicio', userId)),
    ]);

    // Time principal = a 1ª equipa (teams vem ordenado por created_at ASC — o
    // mesmo critério que o Início já usava). Próximo jogo = o 1º não-encerrado
    // (convites vem ordenado por data ASC — idem).
    const campSlug = teams?.teams?.[0]?.slug || null;
    const proximoJogo = (convites?.games || []).find((g) => g.status !== 'finished') || null;
    const nextId = proximoJogo?.id || null;

    const [votacao_status, campeonato, rsvp] = await Promise.all([
      campSlug ? seguro(inicioService.obterVotacaoStatus(campSlug, userId)) : null,
      campSlug ? seguro(inicioService.obterCampeonato(campSlug, userId)) : null,
      nextId ? seguro(inicioService.obterRsvp(nextId, userId)) : null,
    ]);

    res.json({ me, teams, convites, pedidos, votacoes_pendentes, denuncias_desfechos, votacao_status, campeonato, rsvp, ad });
  })
);

module.exports = router;
