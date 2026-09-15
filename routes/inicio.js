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

    // VELOCIDADE 6A (15-set): a onda 2 esperava a onda 1 INTEIRA — incluindo as
    // partes lentas (votações pendentes, desfechos de denúncia). Mas só precisa
    // de duas coisas: o time principal (teams) e o próximo jogo (convites).
    //
    // Agora tudo arranca ao mesmo tempo e a onda 2 encadeia APENAS em
    // teams+convites. Enquanto as votações pendentes ainda correm, o campeonato
    // e o RSVP já estão a ser pedidos. O tempo da tela passa a ser o da parte
    // mais lenta, não a soma de duas ondas.
    const teamsP = seguro(inicioService.obterTeams(userId));
    const convitesP = seguro(inicioService.obterConvites(userId));

    const onda2P = Promise.all([teamsP, convitesP]).then(([teams, convites]) => {
      // Time principal = a 1ª equipa (teams vem ordenado por created_at ASC — o
      // mesmo critério que o Início já usava). Próximo jogo = o 1º não-encerrado
      // (convites vem ordenado por data ASC — idem).
      const principal = teams?.teams?.[0] || null;
      const nextId = (convites?.games || []).find((g) => g.status !== 'finished')?.id || null;
      return Promise.all([
        principal ? seguro(inicioService.obterVotacaoStatus(principal.slug, userId, principal)) : null,
        principal ? seguro(inicioService.obterCampeonato(principal.slug, userId, principal)) : null,
        nextId ? seguro(inicioService.obterRsvp(nextId, userId)) : null,
      ]);
    });

    const [me, teams, convites, pedidos, votacoes_pendentes, denuncias_desfechos, ad, onda2] = await Promise.all([
      seguro(inicioService.obterMe(req.user)),
      teamsP,
      convitesP,
      seguro(inicioService.obterPedidos(userId)),
      seguro(inicioService.obterVotacoesPendentes(userId)),
      seguro(inicioService.obterDesfechosDenuncias(userId)),
      seguro(inicioService.obterAd('inicio', userId)),
      onda2P,
    ]);
    const [votacao_status, campeonato, rsvp] = onda2;

    res.json({ me, teams, convites, pedidos, votacoes_pendentes, denuncias_desfechos, votacao_status, campeonato, rsvp, ad });
  })
);

module.exports = router;
