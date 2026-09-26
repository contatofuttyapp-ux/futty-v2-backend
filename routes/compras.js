// Futty v2.0 — Compras na loja (Pagamentos P1, 26-set). Ver docs/COMPRAS.md.
//
// O app compra pela App Store / Play Store através do SDK do RevenueCat; o RevenueCat
// avisa este motor pelo webhook, e é o webhook que credita (utils/compras.js). O app nunca
// credita nada sozinho: o que ele manda em "sincronizar" só vira crédito depois de a API
// do RevenueCat confirmar a transação.
//
// POST /api/compras/webhook/revenuecat — sem sessão. A autorização é o header
//   `Authorization: Bearer <RC_WEBHOOK_SECRET>` (o valor que o Pedro cola no painel do
//   RevenueCat), comparado em tempo constante. Fora do limiter geral por IP (os IPs do
//   RevenueCat não são gente), com limiter próprio de 120/min.
//   Responde 200 sempre que conseguiu REGISTRAR o evento — creditado, repetido ou
//   ignorado — para o RevenueCat não repetir para sempre; 5xx só se o banco falhou (aí o
//   RevenueCat reenvia, e o índice único de `compras` segura o crédito em dobro).
//
// Fábrica com tudo injetável (Supabase, compras, segredo, fetch): tests/compras-rotas.test.js
// corre sem banco e sem rede.
const crypto = require('node:crypto');
const express = require('express');
const { supabase: supabaseReal } = require('../utils/db');
const { criarLimiteDeWebhook } = require('../middleware/limiters');
const comprasPadrao = require('../utils/compras');

const { ErroCompra } = comprasPadrao;

// product_id da loja → produto. Os ids são os mesmos na App Store e na Play Store.
const PRODUTOS_LOJA = { futty_minha: 'minha', futty_pacote: 'pacote', futty_manto: 'manto' };
// `store` do RevenueCat → `compras.loja`. O resto (STRIPE, AMAZON, …) não vendemos: 'outra'.
const LOJAS_RC = { APP_STORE: 'app_store', MAC_APP_STORE: 'app_store', PLAY_STORE: 'play_store', PROMOTIONAL: 'promo' };
const TIPOS_COMPRA = ['INITIAL_PURCHASE', 'NON_RENEWING_PURCHASE'];
// CANCELLATION de um consumível só acontece por reembolso; CUSTOMER_SUPPORT é o motivo que
// a Apple e o Google mandam quando devolvem o dinheiro. UNSUBSCRIBE e afins são de
// assinatura — não vendemos — e ficam como 'ignorada'.
const MOTIVOS_REEMBOLSO = ['CUSTOMER_SUPPORT'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O segredo do header confere? sha256 dos dois lados: tempo constante e sem vazar o tamanho. */
function segredoConfere(cabecalho, segredo) {
  if (!segredo || !cabecalho) return false;
  const recebido = String(cabecalho).replace(/^Bearer\s+/i, '').trim();
  const a = crypto.createHash('sha256').update(recebido).digest();
  const b = crypto.createHash('sha256').update(String(segredo)).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Um atributo do assinante: o RevenueCat manda `{ team_id: { value, updated_at_ms } }`. */
function atributo(atributos, nome) {
  const a = atributos?.[nome];
  if (a == null) return null;
  const v = typeof a === 'object' ? a.value : a;
  return v == null || v === '' ? null : String(v);
}

const numeroOuNull = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function notificarReal(ids, payload) {
  // eslint-disable-next-line global-require
  return require('./push').enviarNotificacao(ids, payload);
}

function criarRotasCompras({
  supabase = supabaseReal,
  compras = comprasPadrao,
  segredo = process.env.RC_WEBHOOK_SECRET,
  aceitarSandbox = process.env.RC_ACEITAR_SANDBOX !== 'false',
  notificar = notificarReal,
  limiteWebhook = criarLimiteDeWebhook(),
} = {}) {
  const router = express.Router();

  /** O primeiro id (app_user_id, o original ou um alias) que é um usuário nosso. */
  async function acharUsuario(ev) {
    const candidatos = [ev.app_user_id, ev.original_app_user_id, ...(Array.isArray(ev.aliases) ? ev.aliases : [])]
      .filter((id) => typeof id === 'string' && UUID.test(id));
    for (const id of [...new Set(candidatos)]) {
      const { data, error } = await supabase.from('users').select('id').eq('id', id).maybeSingle();
      if (error) throw new Error(error.message);
      if (data) return data.id;
    }
    return null;
  }

  /** Avisa os super-admins (push) — dinheiro que entrou e não virou crédito. Best-effort. */
  async function avisarDono(texto) {
    try {
      const { data } = await supabase.from('users').select('id').eq('is_super_admin', true);
      const ids = (data || []).map((u) => u.id);
      if (ids.length) notificar(ids, { title: 'Compra sem crédito ⚠️', body: texto, url: '/gabinete' });
    } catch (e) {
      console.warn('[compras/webhook] aviso ao dono falhou:', e.message);
    }
  }

  /** Guarda o id do RevenueCat na pessoa (auditoria). Nunca derruba nada. */
  async function guardarAppUserId(userId, appUserId) {
    if (!appUserId) return;
    try {
      await supabase.from('users').update({ rc_app_user_id: String(appUserId) }).eq('id', userId).is('rc_app_user_id', null);
    } catch { /* coluna da 064 em falta: segue */ }
  }

  router.post('/api/compras/webhook/revenuecat', limiteWebhook, async (req, res) => {
    if (!segredoConfere(req.get('authorization'), segredo)) {
      return res.status(401).json({ error: 'Não autorizado.' });
    }
    const ev = req.body?.event;
    if (!ev || typeof ev !== 'object' || !ev.type) return res.status(400).json({ error: 'Evento em falta.' });
    if (ev.type === 'TEST') return res.json({ ok: true, teste: true });

    const loja = LOJAS_RC[ev.store] || 'outra';
    const ambiente = ev.environment === 'SANDBOX' ? 'sandbox' : 'producao';
    const produto = PRODUTOS_LOJA[ev.product_id] || null;
    const base = {
      loja,
      ambiente,
      produto,
      eventoId: ev.id || null,
      transacaoId: ev.transaction_id || null,
      transacaoOriginalId: ev.original_transaction_id || null,
      appUserId: ev.app_user_id || null,
      moeda: ev.currency || null,
      preco: numeroOuNull(ev.price_in_purchased_currency),
      precoUsd: numeroOuNull(ev.price),
      payload: req.body,
    };
    let userId = null;
    const ignorar = async (motivo, extra = {}) => {
      await compras.registrarIgnorada({ ...base, userId, motivo, ...extra });
      return res.json({ ok: true, estado: 'ignorada', motivo });
    };

    try {
      if (ambiente === 'sandbox' && !aceitarSandbox) return await ignorar('SANDBOX_DESLIGADO');

      if (TIPOS_COMPRA.includes(ev.type)) {
        if (!produto) return await ignorar('PRODUTO_DESCONHECIDO');
        if (loja === 'outra') return await ignorar('LOJA_DESCONHECIDA');
        if (!base.transacaoId) return await ignorar('SEM_TRANSACAO');
        userId = await acharUsuario(ev);
        if (!userId) {
          console.error('[compras/webhook] compra de um app_user_id que não é usuário — dinheiro sem crédito', {
            appUserId: base.appUserId, produto, loja, transacao: base.transacaoId,
          });
          await avisarDono(`${produto} (${loja}) de um app_user_id desconhecido. Conferir no RevenueCat.`);
          return await ignorar('USUARIO_DESCONHECIDO');
        }
        const teamIdAttr = atributo(ev.subscriber_attributes, 'team_id');
        const teamId = teamIdAttr && UUID.test(teamIdAttr) ? teamIdAttr : null;
        try {
          const r = await compras.aplicarCompra({ ...base, userId, teamId });
          guardarAppUserId(userId, base.appUserId);
          return res.json({ ok: true, estado: r.repetida ? 'repetida' : 'creditada', produto });
        } catch (e) {
          if (!(e instanceof ErroCompra)) throw e;
          // Regra que falhou (não é dono, manto sem pacote…): a loja já cobrou. Fica gravado
          // e o dono é avisado — reenviar não mudaria nada.
          console.error('[compras/webhook] compra paga que não pôde ser aplicada', { codigo: e.codigo, userId, produto, teamId });
          await avisarDono(`${produto} pago mas não aplicado (${e.codigo}). Conferir no Gabinete.`);
          return await ignorar(e.codigo, { teamId });
        }
      }

      if (ev.type === 'CANCELLATION' && MOTIVOS_REEMBOLSO.includes(ev.cancel_reason)) {
        if (!base.transacaoId || loja === 'outra') return await ignorar('REEMBOLSO_SEM_TRANSACAO');
        const r = await compras.reembolsar({ loja, transacaoId: base.transacaoId });
        if (!r.encontrada) return await ignorar('REEMBOLSO_DE_COMPRA_DESCONHECIDA');
        return res.json({ ok: true, estado: r.repetida ? 'repetida' : 'reembolsada', produto: r.produto });
      }

      return await ignorar(`TIPO_${ev.type}`);
    } catch (e) {
      console.error('[compras/webhook] falha ao registrar — o RevenueCat vai reenviar:', e.message);
      return res.status(500).json({ error: 'Falha ao registrar o evento.' });
    }
  });

  return router;
}

module.exports = criarRotasCompras();
module.exports.criarRotasCompras = criarRotasCompras;
module.exports.PRODUTOS_LOJA = PRODUTOS_LOJA;
module.exports.LOJAS_RC = LOJAS_RC;
module.exports.segredoConfere = segredoConfere;
