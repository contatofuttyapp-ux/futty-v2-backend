// Futty v2.0 — Rate limiters (SEGURANCA-REVISAO-10SET.md secção 3).
//
// Os gerais, montados em server.js e routes/media.js, estão no fim deste arquivo
// (criarLimitesDaApi, criarLimiteDeAvatar, criarLimiteDeMidia).
//
// Os por rota, logo abaixo, são mais apertados e contam por UTILIZADOR (não por
// IP) nas rotas que um único membro pode abusar sem sair do próprio limite de IP:
// gerar convites sem fim, mandar push em massa, ou spammar denúncias. Correm
// DEPOIS de requireAuth (precisam de req.user.id já resolvido).
const crypto = require('node:crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// Chave por utilizador autenticado; IP como fallback (rotas nunca deviam
// chegar aqui sem req.user, mas o fallback evita um TypeError se a ordem dos
// middlewares mudar um dia). ipKeyGenerator normaliza IPv6 (evita bypass).
function porUsuario(req) {
  return req.user?.id ? `user:${req.user.id}` : ipKeyGenerator(req.ip);
}

function criarLimiter({ windowMs, max, mensagem }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: porUsuario,
    message: { error: mensagem },
  });
}

const HORA = 60 * 60 * 1000;

// POST /api/teams/:slug/convite — 10/hora por utilizador.
const conviteLimiter = criarLimiter({
  windowMs: HORA,
  max: 10,
  mensagem: 'Muitos convites gerados. Tente de novo daqui a uma hora.',
});

// POST /api/push/equipas/:slug/broadcast e .../membros/:userId/mensagem —
// 20/hora por admin, quota partilhada entre as duas rotas (mesma família de
// abuso: mandar push em massa).
const pushAdminLimiter = criarLimiter({
  windowMs: HORA,
  max: 20,
  mensagem: 'Muitas notificações enviadas. Tente de novo daqui a uma hora.',
});

// POST /api/denuncias e /api/feed/denuncias — 20/hora por utilizador, quota
// partilhada entre as duas rotas (mesma família: denunciar conteúdo).
const denunciaLimiter = criarLimiter({
  windowMs: HORA,
  max: 20,
  mensagem: 'Muitas denúncias. Tente de novo daqui a uma hora.',
});

// DELETE /api/me — 3/hora por usuário. Ação irreversível (LGPD/exigência das
// lojas): o limite não é sobre abuso de custo, é um freio de segurança contra
// automação/erro (um clique perdido não pode virar uma corrida de exclusões).
const excluirContaLimiter = criarLimiter({
  windowMs: HORA,
  max: 3,
  mensagem: 'Muitas tentativas de excluir a conta. Tente de novo daqui a 1 hora.',
});

// POST /api/diagnostico — 10/hora por utilizador (VELOCIDADE 4). É um botão que
// se toca de propósito na tela de Diagnóstico, não um fluxo automático; o tecto
// existe para um relatório enviado em loop não encher o Storage.
const diagnosticoLimiter = criarLimiter({
  windowMs: HORA,
  max: 10,
  mensagem: 'Você já enviou relatórios de sobra nesta hora. Tente de novo mais tarde.',
});

// ─── Limites gerais (hotfix 25, 25-set) ──────────────────────────────────────
//
// Incidente real: o celular do dono levou "Muitos pedidos" no onboarding porque o
// IP da casa esgotou os 200/15 min, e no dia do time 20 celulares numa quadra
// dividem um IP de Wi-Fi ou de operadora (CGNAT). Um teto por IP sozinho junta
// gente diferente no mesmo balde. Agora o IP é só a rede grossa (anti-tráfego
// anônimo) e cada sessão tem o seu balde.

/**
 * Os tetos, num lugar só (o Gabinete lê daqui). Fora de produção sobem, como
 * sempre foi: numa tarde de teste o dono + o Claude + o hot-reload estouravam o
 * teto de produção e o app "morria" por 15 min.
 */
function limitesPara(emProducao) {
  return {
    janelaMs: 15 * 60 * 1000,
    apiPorIp: emProducao ? 1500 : 2000,
    apiPorSessao: emProducao ? 600 : 6000, // um percurso normal usa ~9 pedidos; 600 é abuso
    avatar: 20, // por pessoa
    midia: 2000, // por IP
  };
}
const LIMITES = limitesPara(process.env.NODE_ENV === 'production');

/**
 * IP real de quem pediu. Pela função da Cloudflare (o site) todo pedido chega ao
 * Cloud Run do MESMO IP, o do edge; ela reencaminha o IP de verdade em
 * CF-Connecting-IP, e é ele que conta. Direto no Cloud Run (as imagens, o app da
 * loja) o header não vem e vale req.ip. O empate, de olhos abertos: quem bate
 * direto no Cloud Run pode forjar o header e trocar de balde. O teto por IP é a
 * rede grossa; a fina é por sessão, e essa não se forja sem a sessão de alguém.
 */
function chaveDoPedido(req) {
  return ipKeyGenerator(req.get('cf-connecting-ip') || req.ip);
}

/** O balde de UMA sessão: "sessao:" + 16 hex do sha256 do token (o token em si não fica na memória do limiter). */
function chaveDaSessao(token) {
  return `sessao:${crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}

/**
 * Limite geral da /api em DOIS baldes, e cada pedido cai em UM só:
 *  · por IP, a rede grossa: tudo o que não vem de uma sessão conhecida;
 *  · por sessão, a rede fina: pedidos de uma sessão que o motor já validou.
 * O critério é sessão CONHECIDA, não "tem Authorization": um header qualquer não
 * custa nada, e cada token falso ganharia um balde próprio (e uma ida ao Supabase
 * Auth), o que apagava o teto por IP. Só sai do balde por IP quem o motor já
 * validou; o resto, forjado ou o 1º pedido de uma sessão, conta nele.
 * `tokenDoPedido(req)` devolve o token Bearer (ou null) e `sessaoConhecida(token)`
 * diz se o motor já o validou (middleware/auth.js).
 * /media tem o limiter próprio (routes/media.js). O preflight já morre no cors()
 * lá em cima; ignorar OPTIONS aqui é a rede de segurança para o dia em que
 * alguém trocar a ordem, e evita contar duas vezes cada chamada. NB: dentro de
 * app.use('/api', ...) o Express já tira o prefixo /api de req.path.
 */
function criarLimitesDaApi({ tokenDoPedido, sessaoConhecida, limites = LIMITES }) {
  const deSessaoConhecida = (req) => {
    const token = tokenDoPedido(req);
    return !!token && sessaoConhecida(token);
  };
  const ignorado = (req) => req.method === 'OPTIONS' || req.path.startsWith('/media');
  const comum = {
    windowMs: limites.janelaMs,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Muitos pedidos. Tente de novo mais tarde.' },
  };
  return [
    rateLimit({
      ...comum,
      max: limites.apiPorIp,
      keyGenerator: chaveDoPedido,
      skip: (req) => ignorado(req) || deSessaoConhecida(req),
    }),
    rateLimit({
      ...comum,
      max: limites.apiPorSessao,
      keyGenerator: (req) => chaveDaSessao(tokenDoPedido(req)),
      skip: (req) => ignorado(req) || !deSessaoConhecida(req),
    }),
  ];
}

/**
 * Upload e geração de avatar (POST /api/me/avatar e /ai): caro (a geração custa no
 * fal.ai) e abusável. Conta por PESSOA: por IP, 20 celulares num Wi-Fi de quadra
 * dividiam um balde só e a 21ª foto do time era barrada. Sem Authorization, por IP.
 * Roda antes do requireAuth, então a pessoa é a sessão (o hash do token), não o
 * user id.
 */
function criarLimiteDeAvatar({ tokenDoPedido, limites = LIMITES }) {
  return rateLimit({
    windowMs: limites.janelaMs,
    max: limites.avatar,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const token = tokenDoPedido(req);
      return token ? chaveDaSessao(token) : chaveDoPedido(req);
    },
    message: { error: 'Muitas tentativas. Tente de novo em 15 minutos.' },
  });
}

/**
 * GET /api/media/:token (o proxy de imagem). Um feed com muitas fotos dispara uma
 * chamada por <img>, de uma vez, por isso tem o limiter próprio e mais largo. Sem
 * sessão (o token HMAC é a própria autorização), conta por IP, o real: com o
 * req.ip puro, tudo o que passa pela Cloudflare cai num balde só.
 */
function criarLimiteDeMidia({ limites = LIMITES } = {}) {
  return rateLimit({
    windowMs: limites.janelaMs,
    max: limites.midia,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: chaveDoPedido,
    message: { error: 'Muitos pedidos de imagem. Tente de novo em alguns minutos.' },
  });
}

module.exports = {
  criarLimiter,
  conviteLimiter,
  pushAdminLimiter,
  denunciaLimiter,
  excluirContaLimiter,
  diagnosticoLimiter,
  LIMITES,
  limitesPara,
  chaveDoPedido,
  chaveDaSessao,
  criarLimitesDaApi,
  criarLimiteDeAvatar,
  criarLimiteDeMidia,
};
