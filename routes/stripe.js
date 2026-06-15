// Futty v2.0 — Pagamentos via Stripe (Checkout + Webhook).
// O webhook precisa do corpo cru (raw) para validar a assinatura, por isso é
// registado à parte no server.js (antes do express.json). O checkout vai no
// router normal. Chaves/preços vêm do .env (placeholders por agora).
const express = require('express');
const Stripe = require('stripe');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase } = require('../utils/db');

// Fallback não-vazio evita rebentar o arranque enquanto a chave é placeholder;
// chamadas reais só funcionam com a STRIPE_SECRET_KEY verdadeira.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

const router = express.Router();

// plano + moeda → nome da variável de ambiente com o PRICE ID.
const PRICE_ENV = {
  pro: { BRL: 'STRIPE_PRICE_PRO_BRL', EUR: 'STRIPE_PRICE_PRO_EUR' },
  elite: { BRL: 'STRIPE_PRICE_ELITE_BRL', EUR: 'STRIPE_PRICE_ELITE_EUR' },
};

// Determina o plano (pro/elite) a partir de um PRICE ID conhecido.
function planoDoPrice(priceId) {
  if (priceId === process.env.STRIPE_PRICE_PRO_BRL || priceId === process.env.STRIPE_PRICE_PRO_EUR) return 'pro';
  if (priceId === process.env.STRIPE_PRICE_ELITE_BRL || priceId === process.env.STRIPE_PRICE_ELITE_EUR) return 'elite';
  return null;
}

/**
 * POST /api/stripe/checkout — cria uma Checkout Session de subscrição e devolve
 * o URL de pagamento do Stripe.
 * Body: { plan: 'pro'|'elite', moeda: 'BRL'|'EUR' }
 */
router.post(
  '/api/stripe/checkout',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { plan, moeda } = req.body || {};
    if (!['pro', 'elite'].includes(plan)) throw new HttpError(400, 'Plano inválido.');
    if (!['BRL', 'EUR'].includes(moeda)) throw new HttpError(400, 'Moeda inválida.');

    const priceId = process.env[PRICE_ENV[plan][moeda]];
    if (!priceId) throw new HttpError(500, 'Preço não configurado para este plano/moeda.');

    const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card', 'pix', 'multibanco'],
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: req.user.id,
      // Guarda o user_id na subscrição → permite reagir ao subscription.deleted.
      subscription_data: { metadata: { user_id: req.user.id } },
      success_url: `${frontend}/planos?sucesso=1`,
      cancel_url: `${frontend}/planos`,
    });

    res.json({ url: session.url });
  })
);

/**
 * POST /api/stripe/webhook — recebe eventos do Stripe. Registado no server.js
 * com express.raw (corpo cru) para validar a assinatura. NÃO usa requireAuth.
 */
async function webhookHandler(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Assinatura de webhook inválida: ${err.message}` });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id;
      // line_items não vêm no objeto do evento → ir buscá-los.
      const itens = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
      const priceId = itens.data[0]?.price?.id;
      const plano = planoDoPrice(priceId);
      if (userId && plano) {
        await supabase.from('users').update({ plan: plano }).eq('id', userId);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const userId = event.data.object?.metadata?.user_id;
      if (userId) {
        await supabase.from('users').update({ plan: 'free' }).eq('id', userId);
      }
    }
  } catch (err) {
    // Não falha o webhook por erro de processamento (evita re-tentativas infinitas).
    console.error('[Futty] Stripe webhook — erro a processar:', err.message);
  }

  res.json({ received: true });
}

module.exports = { router, webhookHandler };
