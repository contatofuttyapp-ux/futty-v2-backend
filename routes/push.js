// Futty v2.0 — Notificações push (Web Push API).
// Endpoints de subscrição + helper enviarNotificacao() usado pelos outros routers.
// As env vars VAPID_* têm de existir; se faltarem, o envio é no-op (servidor
// continua a funcionar — não crasha).
const express = require('express');
const webpush = require('web-push');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, ensureUserRow } = require('../utils/db');

const router = express.Router();

const { VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
const pushConfigurado = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushConfigurado) {
  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:suporte@futty.app', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('[Futty] Push desativado: faltam VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY no .env.');
}

/** POST /api/push/subscribe — guarda (upsert) a subscrição do utilizador. */
router.post(
  '/subscribe',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) throw new HttpError(400, 'Subscrição inválida.');

    await ensureUserRow(req.user);
    const { error } = await supabase.from('push_subscriptions').upsert(
      {
        user_id: req.user.id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,endpoint' }
    );
    if (error) throw new HttpError(500, error.message);
    res.json({ subscribed: true });
  })
);

/** DELETE /api/push/subscribe — remove a subscrição do utilizador (por endpoint). */
router.delete(
  '/subscribe',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { endpoint } = req.body || {};
    if (!endpoint) throw new HttpError(400, 'endpoint em falta.');
    const { error } = await supabase
      .from('push_subscriptions')
      .delete()
      .eq('user_id', req.user.id)
      .eq('endpoint', endpoint);
    if (error) throw new HttpError(500, error.message);
    res.json({ unsubscribed: true });
  })
);

/** GET /api/push/vapid-public-key — chave pública VAPID (sem auth). */
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY || null });
});

/**
 * Envia uma notificação push a uma lista de utilizadores (fire-and-forget).
 * Nunca lança: erros são engolidos; subscrições mortas (404/410) são apagadas.
 * @param {string[]} userIds destinatários
 * @param {{title:string, body?:string, url?:string}} payload
 */
async function enviarNotificacao(userIds, payload) {
  try {
    if (!pushConfigurado) return;
    const ids = (userIds || []).filter(Boolean);
    if (!ids.length) return;

    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .in('user_id', ids);
    if (!subs?.length) return;

    const body = JSON.stringify({
      title: payload.title || 'Futty',
      body: payload.body || '',
      url: payload.url || '/home',
    });

    await Promise.allSettled(
      subs.map(async (s) => {
        const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
        try {
          await webpush.sendNotification(subscription, body);
        } catch (err) {
          // 404/410 = subscrição expirada/removida pelo browser → limpar.
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            await supabase.from('push_subscriptions').delete().eq('id', s.id);
          }
        }
      })
    );
  } catch {
    // fire-and-forget: nunca propaga erro para a resposta da API.
  }
}

router.enviarNotificacao = enviarNotificacao;
module.exports = router;
