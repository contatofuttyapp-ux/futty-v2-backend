// Futty v2.0 — Diagnóstico do app (VELOCIDADE 4).
//
// O app mede-se a si próprio e a pessoa envia o que mediu. Serve para responder
// com número a "está lento": o relatório separa o tempo do MOTOR (Server-Timing,
// posto pelo backend em todo pedido) do tempo de REDE, e mostra quanto demora
// entre tocar numa aba e a tela aparecer.
//
// O que entra aqui não tem corpo de pedido, token, nem conteúdo de utilizador —
// só rotas, estados e tempos. Ver frontend/src/lib/diagnostico.js.
const express = require('express');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { diagnosticoLimiter } = require('../middleware/limiters');
const { asyncHandler, HttpError } = require('../utils/http');
const { guardarRelatorio, obterRelatorio, listarUltimos } = require('../utils/diagnosticoStore');

const router = express.Router();

// Envio do relatório pela própria pessoa (botão na tela Perfil → Diagnóstico).
// 10/hora por utilizador: é um botão que se toca de propósito, não um fluxo.
router.post(
  '/api/diagnostico',
  requireAuth,
  diagnosticoLimiter,
  asyncHandler(async (req, res) => {
    const relatorio = req.body;
    if (!relatorio || typeof relatorio !== 'object' || Array.isArray(relatorio)) {
      throw new HttpError(400, 'Relatório inválido.');
    }

    // Carimbado no servidor: a hora do aparelho pode estar errada, e o relatório
    // é para ler daqui.
    const comCarimbo = {
      ...relatorio,
      recebido_em: new Date().toISOString(),
      user_id: req.user.id,
    };

    try {
      const ficheiro = await guardarRelatorio(req.user.id, comCarimbo);
      res.json({ ok: true, ficheiro });
    } catch (e) {
      if (e.grande) throw new HttpError(413, 'Relatório grande demais.');
      throw e;
    }
  })
);

// Gabinete do Dono: os últimos relatórios, com resumo de cada um.
router.get(
  '/api/super/diagnostico',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const limite = Math.min(50, Math.max(1, Number(req.query.limite) || 20));
    res.json({ relatorios: await listarUltimos(limite) });
  })
);

// Gabinete do Dono: um relatório inteiro.
router.get(
  '/api/super/diagnostico/:userId/:ficheiro',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const relatorio = await obterRelatorio(req.params.userId, req.params.ficheiro);
    if (!relatorio) throw new HttpError(404, 'Relatório não encontrado.');
    res.json({ relatorio });
  })
);

module.exports = router;
