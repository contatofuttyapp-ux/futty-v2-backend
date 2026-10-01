// Futty v2.0 — GET /api/inicio: agrega TUDO que a tela Início precisa num
// round-trip só. Motivo (11-set): motor em São Paulo, utilizador em Lisboa
// (~240ms/pedido) — os ~13 pedidos que o Início disparava ao abrir davam 3-4s
// só de latência de rede, antes de qualquer dado chegar. Cada peça usa a MESMA
// função de services/inicio.js que a rota antiga (nunca diverge do JSON que
// outras telas já dependem — as rotas antigas continuam de pé).
//
// Fila de idas ao banco (Rodada 29B, bloco 2, B): vínculos → jogos → RSVP = 3. Tudo o que não depende de ninguém arranca
// no instante zero; o que depende do time principal (votação, campeonato) ou do próximo jogo (RSVP) arranca assim que a
// sua dependência chega — não quando uma onda inteira acaba.
//
// Promise.allSettled (via `seguro`, não Promise.all): se uma parte falhar (ex.:
// um time suspenso a meio da leitura), essa chave vem null e as restantes
// continuam — a tela não pode cair por causa de UM pedaço.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { marcarFase, medir } = require('../middleware/tempo');
const { asyncHandler } = require('../utils/http');
const inicioService = require('../services/inicio');
const { temDireito } = require('../utils/direitoBrilhante');
const { timesEmQueSoOrganiza } = require('../utils/soOrganiza');
const { pedidosVivos } = require('./brilhantes');

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
    // O requireAuth já correu: tudo até aqui foi autenticação.
    marcarFase(res, 'auth');

    // RODADA 29B (bloco 2, B — "conta pesada"). Medido com a conta pesada (super-admin, 2 times) e a leve (1 time): o
    // /api/inicio levava ~990 ms de motor e 31 consultas nas DUAS — o que pesava era a FILA de idas ao banco (4 em série),
    // não o volume. A fila era esta:
    //   1ª ida   os times (team_members) e os convites (team_members de novo)…
    //   2ª ida   …+ os pedidos pendentes (team_join_requests) e os jogos (games); só então o time principal era conhecido…
    //   3ª ida   …votação e campeonato do principal, e o jogo do próximo convite (loadGame)…
    //   4ª ida   …e o resto do RSVP (membros, respostas, fila) só depois do loadGame.
    // Agora: UMA consulta de vínculos no instante zero, repartida entre todas as partes (11 consultas de team_members viram 1);
    // os times saem na hora (o contador de pedidos pendentes corre ao lado, fora do caminho crítico); a votação e o campeonato
    // arrancam assim que o principal é conhecido (sem esperar os jogos); e o RSVP do próximo jogo sai numa ida só (o time dele
    // já veio na lista de jogos). Fila: vínculos → jogos → RSVP = 3 idas. A lista de jogos também parou de crescer com o
    // histórico (ver obterConvites: os que vão acontecer + os 3 últimos de cada time, que é o que a tela mostra).
    const vinculosP = medir(res, 'vinculos', seguro(inicioService.obterVinculos(userId)));
    const soOrganizaP = seguro(timesEmQueSoOrganiza(userId));
    const baseP = Promise.all([vinculosP, soOrganizaP]);

    // Os times: montados na hora a partir dos vínculos. Se a leitura deles falhou, o caminho antigo (cada parte lê o seu).
    const teamsP = medir(res, 'teams', baseP.then(([vinculos, soOrganiza]) => (
      vinculos ? { teams: inicioService.montarTeams(vinculos, soOrganiza || new Set()) } : seguro(inicioService.obterTeams(userId))
    )));
    // O contador de pedidos pendentes (badge do chip de quem administra) sai ao lado: ninguém espera por ele, só a resposta.
    const pendentesP = teamsP.then((t) => (t?.teams && t.teams.some((x) => x.role === 'admin') ? seguro(inicioService.contarPedidosPendentes(t.teams)) : null));

    const convitesP = medir(res, 'convites', baseP.then(([vinculos, soOrganiza]) => (
      seguro(inicioService.obterConvites(userId, { vinculos, soOrganiza, limitar: true }))
    )));

    // Time principal = a 1ª equipa (os vínculos vêm por created_at ASC — o mesmo critério que o Início já usava). Próximo
    // jogo = o 1º não-encerrado (a lista vem por data ASC — idem). Votação e campeonato só precisam do principal; o RSVP,
    // do próximo jogo. Tudo arranca no instante em que a sua dependência chega, não quando a onda anterior inteira acaba.
    const principalP = teamsP.then((teams) => teams?.teams?.[0] || null);
    const onda2P = medir(res, 'onda2', Promise.all([
      principalP.then((principal) => (principal ? seguro(inicioService.obterVotacaoStatus(principal.slug, userId, principal)) : null)),
      principalP.then((principal) => (principal ? seguro(inicioService.obterCampeonato(principal.slug, userId, principal)) : null)),
      convitesP.then((convites) => {
        const proximo = (convites?.games || []).find((g) => g.status !== 'finished');
        return proximo ? seguro(inicioService.obterRsvp(proximo.id, userId, { teamId: proximo.team_id })) : null;
      }),
    ]));

    const [me, teams, , convites, pedidos, votacoes_pendentes, denuncias_desfechos, ads, brilhante, pedidos_brilhante, onda2] = await Promise.all([
      medir(res, 'me', seguro(inicioService.obterMe(req.user))),
      teamsP,
      pendentesP,
      convitesP,
      medir(res, 'pedidos', seguro(inicioService.obterPedidos(userId))),
      medir(res, 'votacoes', vinculosP.then((vinculos) => seguro(inicioService.obterVotacoesPendentes(userId, { vinculos })))),
      medir(res, 'denuncias', vinculosP.then((vinculos) => seguro(inicioService.obterDesfechosDenuncias(userId, { vinculos })))),
      // VELOCIDADE 9: vêm os slots de TODAS as páginas, não só o do Início. A
      // conta de servidor é a mesma (uma leitura do store, uma do utilizador) e
      // poupa um `GET /api/ads?pagina=…` por tela — eram 4 dos 22 pedidos do
      // percurso que o dono mediu, ~500 ms cada, de Lisboa.
      medir(res, 'ad', seguro(inicioService.obterAdsSessao(userId))),
      // O direito de gerar Brilhante vem JUNTO (SPEC-FIGURINHA-3 §7): o Início
      // mostra o cartão dourado "Você tem uma Brilhante para gerar" e dispara a
      // geração preguiçosa do pacote do time. Um pedido à parte só para isto
      // seria mais um round-trip na tela que a Velocidade 6A juntou num só.
      medir(res, 'brilhante', seguro(temDireito(userId))),
      // Os pedidos de ativação vivos (pendente/recusado recente) — bloco 2. O
      // Início tem de saber dizer "a gente ativa e avisa" e o motivo de uma
      // recusa; sem isto a pessoa pedia e a tela ficava igual a antes de pedir.
      // Query indexada por user_id, na mesma leva das outras.
      medir(res, 'pedidos_brilhante', seguro(pedidosVivos(userId))),
      onda2P,
    ]);
    const [votacao_status, campeonato, rsvp] = onda2;
    // 'dados' = o tempo real de espera de TODAS as partes juntas. As medidas por
    // parte acima sobrepõem-se entre si (correm em paralelo): servem para ver
    // qual é a lenta, não para somar.
    marcarFase(res, 'dados');

    res.json({
      me, teams, convites, pedidos, votacoes_pendentes, denuncias_desfechos, votacao_status, campeonato, rsvp,
      // `ad` continua a ser o slot do Início e com a MESMA forma de antes
      // ({ ad }) — telas e testes que já o liam não mudam. `ads` é a novidade:
      // os slots de todas as páginas, para o app não voltar a pedir por tela.
      ad: { ad: ads?.paginas?.inicio ?? null },
      ads: ads || null,
      // Pagamentos P2: `loja_pronta` (PAGAMENTOS_ATIVOS no motor) vai junto — a Figurinha abre a partir
      // deste payload e decide aqui se o convite é "Comprar" ou "Pedir ativação", sem pedir o /estado.
      brilhante: {
        ...(brilhante
          ? { fonte: brilhante.fonte, team_id: brilhante.teamId, kit_id: brilhante.kitId, creditos: brilhante.creditos, restantes: brilhante.restantes }
          : { fonte: null, team_id: null, kit_id: null, creditos: 0, restantes: 0 }),
        loja_pronta: process.env.PAGAMENTOS_ATIVOS === 'true',
      },
      // Nome próprio: `pedidos` (acima) são os pedidos de ENTRADA em times —
      // coisa completamente diferente.
      pedidos_brilhante: pedidos_brilhante || [],
    });
  })
);

module.exports = router;
