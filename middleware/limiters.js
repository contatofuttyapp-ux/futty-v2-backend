// Futty v2.0 — Rate limiters por rota (SEGURANCA-REVISAO-10SET.md secção 3).
// O limiter global (server.js, apiLimiter) conta por IP e cobre toda a /api;
// estes são mais apertados e contam por UTILIZADOR (não por IP) nas rotas que
// um único membro pode abusar sem sair do próprio limite de IP: gerar convites
// sem fim, mandar push em massa, ou spammar denúncias. Correm DEPOIS de
// requireAuth (precisam de req.user.id já resolvido).
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
  mensagem: 'Demasiados convites gerados. Tenta de novo daqui a uma hora.',
});

// POST /api/push/equipas/:slug/broadcast e .../membros/:userId/mensagem —
// 20/hora por admin, quota partilhada entre as duas rotas (mesma família de
// abuso: mandar push em massa).
const pushAdminLimiter = criarLimiter({
  windowMs: HORA,
  max: 20,
  mensagem: 'Demasiadas notificações enviadas. Tenta de novo daqui a uma hora.',
});

// POST /api/denuncias e /api/feed/denuncias — 20/hora por utilizador, quota
// partilhada entre as duas rotas (mesma família: denunciar conteúdo).
const denunciaLimiter = criarLimiter({
  windowMs: HORA,
  max: 20,
  mensagem: 'Demasiadas denúncias. Tenta de novo daqui a uma hora.',
});

module.exports = { criarLimiter, conviteLimiter, pushAdminLimiter, denunciaLimiter };
