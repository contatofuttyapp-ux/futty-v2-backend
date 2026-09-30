// Futty v2.0 — Em que pé está a pintura da figurinha (Rodada 29B, bloco 2, parte A).
//
// POST /api/me/avatar/ai devolve na hora `{ jobId, estimativaSegundos }` (routes/auth.js); o trabalho
// roda em segundo plano (utils/geracaoJobs.js) e o app pergunta aqui, a cada 3 s enquanto a aba está
// visível e ao voltar para ela:
//
//   GET /api/figurinha/job/:id  →  { estado, etapa, progresso, avatar_url, estimativaSegundos,
//                                    decorridoSegundos } + (pronta) { kit, figurinha_ativa }
//                                  + (falhou) { erro, code, status }
//
// `estado`: na_fila | em_andamento | pronta | falhou. `etapa`: preparando | pintando | acabamento | pronta.
// `progresso` (0–1) avança pelo tempo estimado até 0,9 e segura ali; só 'pronta' vale 1 — nunca 100%
// antes de existir a imagem. Só o DONO da pintura a enxerga (outro usuário ou id inventado → 404).
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const geracaoJobs = require('../utils/geracaoJobs');
const { marcarFigurinhaStatus } = require('../services/inicio');

const router = express.Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get(
  '/api/figurinha/job/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!UUID.test(id)) throw new HttpError(404, 'Pintura não encontrada.');
    // Uma pintura cujo processo morreu (reinício, deploy) é descoberta aqui, na primeira consulta depois do
    // prazo do batimento: vira 'falhou' e o usuário deixa de aparecer como "gerando" no Início.
    const visao = await geracaoJobs.ler(id, req.user.id, {
      aoInterromper: (userId) => marcarFigurinhaStatus(userId, 'falhou'),
    });
    if (!visao) throw new HttpError(404, 'Pintura não encontrada.');
    res.set('Cache-Control', 'no-store'); // é um estado que muda a cada 3 s: nunca do cache
    res.json(visao);
  }),
);

module.exports = router;
