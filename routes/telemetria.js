// Futty v2.0 — POST /api/telemetria: a velocidade que o app mediu, sem ninguém dentro (Rodada 28, E).
//
// Sem requireAuth DE PROPÓSITO: a rota não lê o Authorization nem o IP (o limiter conta por IP em
// memória e esquece em 15 min). O que vai para a tabela é só o que utils/telemetria.js#montarLinha
// deixa passar — ver lá o porquê de cada campo. Responde 204 sempre que o corpo é válido: o app não
// espera nada disto e uma falha de gravação nunca vira erro na tela de ninguém.
const express = require('express');
const { supabase } = require('../utils/db');
const { criarLimiteDeTelemetria } = require('../middleware/limiters');
const { montarLinha, cabeNoTeto, limparAntigas } = require('../utils/telemetria');

// O banco é o mesmo para o motor local e o de produção: o que vem de fora do Cloud Run de
// produção fica marcado como 'teste' e o Gabinete não conta.
const AMBIENTE = process.env.NODE_ENV === 'production' ? 'producao' : 'teste';

async function gravarNoSupabase(linha) {
  const { error } = await supabase.from('telemetria_velocidade').insert(linha);
  if (error) throw new Error(error.message);
  limparAntigas(supabase).catch(() => {});
}

/** `gravar` e `ambiente` injetáveis para o teste provar o que entra na linha sem tocar no banco. */
function criarRotaTelemetria({ gravar = gravarNoSupabase, ambiente = AMBIENTE, limite = criarLimiteDeTelemetria() } = {}) {
  const router = express.Router();
  router.post('/api/telemetria', limite, async (req, res) => {
    const r = montarLinha(req.body, { ambiente });
    if (!r.ok) return res.status(400).json({ error: r.erro });
    // Grava ANTES de responder: no Cloud Run sem "CPU sempre alocada" o trabalho depois da resposta
    // pode ficar parado até o próximo pedido. O app não espera por isto (manda e esquece).
    if (cabeNoTeto()) {
      try {
        await gravar(r.linha);
      } catch (e) {
        console.warn('[telemetria] não gravou (migração 061 aplicada?):', e.message);
      }
    }
    return res.status(204).end();
  });
  return router;
}

module.exports = criarRotaTelemetria();
module.exports.criarRotaTelemetria = criarRotaTelemetria;
