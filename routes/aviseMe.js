// Futty v2.0 — POST /api/avise-me: "Quero ser avisado quando o Futty chegar nas lojas".
//
// Pública DE PROPÓSITO: quem chega das redes não tem conta nem app. Por isso o cuidado é outro:
//   · limiter por IP real, 10 por hora (middleware/limiters.js#criarLimiteDeAviseMe) — o IP só vive na memória do
//     limiter, nunca na tabela;
//   · validação do e-mail e da origem (utils/aviseMe.js) e uma isca para robô (campo `site`, escondido na tela):
//     preenchida, finge que deu certo e não grava;
//   · responde igual para e-mail novo e e-mail que já estava na lista (201 nos dois): a rota não serve para descobrir
//     quem está na lista.
// NÃO manda e-mail nenhum: o "chegou nas lojas" sai no dia do lançamento, pelo Gabinete. A lista mora em
// `avisos_lancamento` (migração 068).
const express = require('express');
const { supabase: supabaseDoMotor } = require('../utils/db');
const { criarLimiteDeAviseMe } = require('../middleware/limiters');
const { validarPedido, tabelaEmFalta, TABELA } = require('../utils/aviseMe');

/** `supabase` e `limite` injetáveis: o teste prova a rota sem banco e sem esperar uma hora. */
function criarRotaAviseMe({ supabase = supabaseDoMotor, limite = criarLimiteDeAviseMe() } = {}) {
  const router = express.Router();
  router.post('/api/avise-me', limite, async (req, res) => {
    const v = validarPedido(req.body);
    if (!v.ok) return res.status(400).json({ error: v.erro });
    if (v.ignorar) return res.status(201).json({ ok: true }); // robô: nada é gravado
    try {
      const { error } = await supabase.from(TABELA).insert({ email: v.email, origem: v.origem });
      if (error) {
        if (error.code === '23505') return res.status(201).json({ ok: true }); // já estava na lista: não se diz a quem pergunta
        if (tabelaEmFalta(error.message)) {
          console.warn('[avise-me] migração 068 em falta:', error.message);
          return res.status(503).json({ error: 'Ainda não estamos recebendo e-mails. Tente de novo mais tarde.' });
        }
        throw new Error(error.message);
      }
      return res.status(201).json({ ok: true });
    } catch (e) {
      console.error('[avise-me] não gravou:', e.message);
      return res.status(500).json({ error: 'Não deu para anotar agora. Tente de novo.' });
    }
  });
  return router;
}

module.exports = criarRotaAviseMe();
module.exports.criarRotaAviseMe = criarRotaAviseMe;
