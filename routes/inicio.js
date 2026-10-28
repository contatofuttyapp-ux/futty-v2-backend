// Futty v2.0 — GET /api/inicio: agrega TUDO que a tela Início precisa num
// round-trip só. Motivo: motor em São Paulo, usuário em Lisboa
// (~240ms/pedido) — os ~13 pedidos que o Início disparava ao abrir davam 3-4s
// só de latência de rede, antes de qualquer dado chegar. Cada peça usa a MESMA
// função de services/inicio.js que a rota antiga (nunca diverge do JSON que
// outras telas já dependem — as rotas antigas continuam de pé).
//
// Fila de idas ao banco: vínculos (quase sempre do cache) → jogos → RSVP = 2 a 3. Tudo o que não depende de ninguém arranca
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
const { pedidosVivos } = require('./brilhantes');
const { lojaProntaDoPedido } = require('../utils/lojaPronta');
const { talvezEnviarLembretes } = require('../utils/lembretesMensalidade');

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
    // Os lembretes de vencimento da mensalidade pegam carona aqui (o pedido mais comum do app), no máximo a cada 10 min por
    // instância — o agendador é o caminho principal (utils/lembretesMensalidade.js). Só DEPOIS de a resposta sair: antes, as ~6
    // consultas da carona disputavam o pool do banco com as do próprio Início, justamente no pedido que a pessoa está esperando.
    res.once('finish', () => setImmediate(talvezEnviarLembretes));

    // O que pesava no /api/inicio era a FILA de idas ao banco, não o volume: medido com a conta pesada (super-admin,
    // 2 times) e a leve (1 time), com 4 idas em série levava ~990 ms de motor e 31 consultas nas DUAS.
    // Hoje: UMA consulta de vínculos no instante zero, repartida entre todas as partes (11 consultas de team_members viram 1);
    // os times saem na hora (o contador de pedidos pendentes corre ao lado, fora do caminho crítico); a votação e o campeonato
    // arrancam assim que o principal é conhecido (sem esperar os jogos); e o RSVP do próximo jogo sai numa ida só (o time dele
    // já vem na lista de jogos). Fila: vínculos → jogos → RSVP = 3 idas. A lista de jogos também não cresce com o
    // histórico (ver obterConvites: os que vão acontecer + os 3 últimos de cada time, que é o que a tela mostra).
    // Os vínculos e o "só organizo" saem do cache dos times da pessoa (60 s, esvaziado a cada escrita em times/vínculos —
    // utils/vinculosDaPessoa.js): na maioria das aberturas a fila começa já nos jogos.
    const baseP = medir(res, 'vinculos', seguro(inicioService.obterVinculosDaPessoa(userId)))
      .then((b) => [b?.vinculos || null, b?.soOrganiza || null]);
    const vinculosP = baseP.then(([vinculos]) => vinculos);

    // Os times: montados na hora a partir dos vínculos. Se a leitura deles falhou, o caminho antigo (cada parte lê o seu).
    const teamsP = medir(res, 'teams', baseP.then(([vinculos, soOrganiza]) => (
      vinculos ? { teams: inicioService.montarTeams(vinculos, soOrganiza || new Set()) } : seguro(inicioService.obterTeams(userId))
    )));
    // Leituras que DUAS partes faziam iguais saem uma vez e são divididas (cada parte, se a divisão falhar, lê a sua):
    //   · os pedidos de entrada pendentes dos meus times de admin — o badge do chip e o "Seu time";
    //   · o perfil — o "me" e o anúncio (idade e plano);
    //   · os meus votos em todos os times — a votação pendente e o status da votação do time principal;
    //   · os jogos crus da lista do Início — o "Seu time" lê deles os próximos e os últimos de cada time.
    const ehAdmin = (t) => t?.teams?.some((x) => x.role === 'admin');
    const pedidosAdminP = teamsP.then((t) => (ehAdmin(t) ? inicioService.lerPedidosPendentes(t.teams) : null)).catch(() => null);
    const perfilP = inicioService.lerPerfil(userId).catch(() => null);
    const meusVotosP = vinculosP.then((v) => (v ? inicioService.lerMeusVotos(userId, [...new Set(v.map((m) => m.team_id))]) : null)).catch(() => null);
    let entregarJogos;
    const jogosBrutosP = new Promise((resolve) => { entregarJogos = resolve; });

    // O contador de pedidos pendentes (badge do chip de quem administra) sai ao lado: ninguém espera por ele, só a resposta.
    const pendentesP = teamsP.then((t) => (ehAdmin(t) ? seguro(inicioService.contarPedidosPendentes(t.teams, { pedidos: pedidosAdminP })) : null));

    const convitesP = medir(res, 'convites', baseP.then(([vinculos, soOrganiza]) => (
      seguro(inicioService.obterConvites(userId, { vinculos, soOrganiza, limitar: true, aoLerJogos: entregarJogos }))
    )));
    convitesP.finally(() => entregarJogos(null)); // a lista falhou (ou a pessoa não tem time): o "Seu time" lê os seus

    // As pendências do card "Seu time" (só quem administra algum time) — ao lado, ninguém espera por elas.
    const seuTimeP = medir(res, 'seu_time', teamsP.then((t) => (
      ehAdmin(t) ? seguro(inicioService.obterSeuTime(t.teams, { pedidos: pedidosAdminP, jogos: jogosBrutosP })) : []
    )));

    // Time principal = a 1ª equipa (os vínculos vêm por created_at ASC — o mesmo critério que o Início já usava). Próximo
    // jogo = o 1º não-encerrado (a lista vem por data ASC — idem). Votação e campeonato só precisam do principal; o RSVP,
    // do próximo jogo. Tudo arranca no instante em que a sua dependência chega, não quando a onda anterior inteira acaba.
    const principalP = teamsP.then((teams) => teams?.teams?.[0] || null);
    // O `revotar_pedido_em` do principal veio nos vínculos (o status da votação não precisa reler o time).
    const revotarDoPrincipal = (vinculos, principal) => {
      const linha = (vinculos || []).find((m) => m.teams?.id === principal.id);
      return linha ? { revotarPedidoEm: linha.teams.revotar_pedido_em ?? null } : {};
    };
    const onda2P = medir(res, 'onda2', Promise.all([
      Promise.all([principalP, vinculosP]).then(([principal, vinculos]) => (principal
        ? seguro(inicioService.obterVotacaoStatus(principal.slug, userId, principal, { meusVotos: meusVotosP, ...revotarDoPrincipal(vinculos, principal) }))
        : null)),
      principalP.then((principal) => (principal ? seguro(inicioService.obterCampeonato(principal.slug, userId, principal)) : null)),
      Promise.all([convitesP, teamsP]).then(([convites, teams]) => {
        const proximo = (convites?.games || []).find((g) => g.status !== 'finished');
        // O meu papel no time do próximo jogo já está nos vínculos: o RSVP não precisa perguntar ao banco.
        const role = (teams?.teams || []).find((x) => x.id === proximo?.team_id)?.role || null;
        return proximo ? seguro(inicioService.obterRsvp(proximo.id, userId, { teamId: proximo.team_id, role })) : null;
      }),
      // O campeonato novo do time principal (todo membro vê): em andamento ou o campeão da última semana.
      principalP.then((principal) => (principal ? seguro(inicioService.obterCampeonatoNovo(principal, userId)) : null)),
    ]));

    const [me, teams, , convites, pedidos, votacoes_pendentes, denuncias_desfechos, ads, brilhante, pedidos_brilhante, onda2, seu_time] = await Promise.all([
      medir(res, 'me', seguro(inicioService.obterMe(req.user, { base: baseP, perfil: perfilP }))),
      teamsP,
      pendentesP,
      convitesP,
      medir(res, 'pedidos', seguro(inicioService.obterPedidos(userId))),
      medir(res, 'votacoes', vinculosP.then((vinculos) => seguro(inicioService.obterVotacoesPendentes(userId, { vinculos, meusVotos: meusVotosP })))),
      medir(res, 'denuncias', vinculosP.then((vinculos) => seguro(inicioService.obterDesfechosDenuncias(userId, { vinculos })))),
      // Vêm os slots de TODAS as páginas, não só o do Início. A
      // conta de servidor é a mesma (uma leitura do store, uma do usuário) e
      // poupa um `GET /api/ads?pagina=…` por tela — eram 4 dos 22 pedidos do
      // percurso que o dono mediu, ~500 ms cada, de Lisboa.
      medir(res, 'ad', seguro(inicioService.obterAdsSessao(userId, { perfil: perfilP }))),
      // O direito de gerar Brilhante vem JUNTO (SPEC-FIGURINHA-3 §7): o Início
      // mostra o cartão dourado "Você tem uma Brilhante para gerar" e dispara a
      // geração preguiçosa do pacote do time. Um pedido à parte só para isto
      // seria mais um round-trip numa tela que já junta tudo num só.
      medir(res, 'brilhante', seguro(temDireito(userId))),
      // Os pedidos de ativação vivos (pendente/recusado recente) — bloco 2. O
      // Início tem de saber dizer "a gente ativa e avisa" e o motivo de uma
      // recusa; sem isto a pessoa pedia e a tela ficava igual a antes de pedir.
      // Query indexada por user_id, na mesma leva das outras.
      medir(res, 'pedidos_brilhante', seguro(pedidosVivos(userId))),
      onda2P,
      seuTimeP,
    ]);
    const [votacao_status, campeonato, rsvp, campeonato_novo] = onda2;
    // 'dados' = o tempo real de espera de TODAS as partes juntas. As medidas por
    // parte acima sobrepõem-se entre si (correm em paralelo): servem para ver
    // qual é a lenta, não para somar.
    marcarFase(res, 'dados');

    res.json({
      me, teams, convites, pedidos, votacoes_pendentes, denuncias_desfechos, votacao_status, campeonato, rsvp,
      // O campeonato NOVO do time (ver obterCampeonatoNovo); `campeonato` acima é o antigo, de 2 times.
      campeonato_novo: campeonato_novo || null,
      // [{ team_id, slug, nome, fuso, pendencias }] — um por time em que a pessoa é admin ([] = não administra nenhum).
      seu_time: seu_time || [],
      // `ad` continua a ser o slot do Início e com a MESMA forma de antes
      // ({ ad }) — telas e testes que já o liam não mudam. `ads` é a novidade:
      // os slots de todas as páginas, para o app não voltar a pedir por tela.
      ad: { ad: ads?.paginas?.inicio ?? null },
      ads: ads || null,
      // `loja_pronta` (PAGAMENTOS_ATIVOS ou PAGAMENTOS_PLATAFORMAS no motor) vai junto — a Figurinha abre a partir
      // deste payload e decide aqui se o convite é "Comprar" ou "Pedir ativação", sem pedir o /estado.
      brilhante: {
        ...(brilhante
          ? { fonte: brilhante.fonte, team_id: brilhante.teamId, kit_id: brilhante.kitId, creditos: brilhante.creditos, restantes: brilhante.restantes, total: brilhante.total }
          : { fonte: null, team_id: null, kit_id: null, creditos: 0, restantes: 0, total: 0 }),
        loja_pronta: lojaProntaDoPedido(req),
      },
      // Nome próprio: `pedidos` (acima) são os pedidos de ENTRADA em times —
      // coisa completamente diferente.
      pedidos_brilhante: pedidos_brilhante || [],
    });
  })
);

module.exports = router;
