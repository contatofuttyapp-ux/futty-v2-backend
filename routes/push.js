// Futty v2.0 — Notificações push (Web Push API).
// Endpoints de subscrição + helper enviarNotificacao() usado pelos outros routers.
// As env vars VAPID_* têm de existir; se faltarem, o envio é no-op (servidor
// continua a funcionar — não crasha).
const express = require('express');
const webpush = require('web-push');
const { requireAuth } = require('../middleware/auth');
const { pushAdminLimiter } = require('../middleware/limiters');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, ensureUserRow, getTeamBySlug, getRole } = require('../utils/db');
const { endpointPushValido } = require('../utils/validarUrl');

const router = express.Router();

const { VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
const pushConfigurado = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushConfigurado) {
  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:suporte@futty.app', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('[Futty] Push desativado: faltam VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY no .env.');
}

// COFRE 25-set — o par VAPID foi trocado. Toda subscrição feita com a chave ANTIGA passa a ser recusada pelo push
// service com 403 (FCM: "SenderId mismatch"; os outros: JWT que não bate com a inscrição): ela nunca mais serve, então
// sai do banco — e o cliente se inscreve de novo sozinho na próxima abertura do app (usePushNotifications).
// 404/410 = expirada/removida pelo próprio browser, como sempre. Qualquer outro código (429, 5xx, rede) é passageiro:
// a linha fica.
const CODIGOS_DE_SUBSCRICAO_MORTA = [403, 404, 410];

/** O erro do web-push diz que ESTA subscrição nunca mais vai servir? */
function subscricaoMorta(err) {
  return CODIGOS_DE_SUBSCRICAO_MORTA.includes(err?.statusCode);
}

/** Apaga a subscrição se o erro diz que ela morreu. Devolve true se apagou. Nunca lança. */
async function limparSeMorta(err, subscricaoId) {
  if (!subscricaoMorta(err)) return false;
  try {
    await supabase.from('push_subscriptions').delete().eq('id', subscricaoId);
    return true;
  } catch {
    return false; // o erro que importa é o do envio; a limpeza tenta de novo no próximo
  }
}

/** POST /api/push/subscribe — guarda (upsert) a subscrição do utilizador. */
router.post(
  '/subscribe',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) throw new HttpError(400, 'Subscrição inválida.');
    // SEGURANCA-REVISAO-10SET.md secção 3 (10-set): sem isto o servidor fazia
    // POST (webpush.sendNotification) para qualquer endpoint que mandassem —
    // só aceita hosts de serviços de push conhecidos.
    if (!endpointPushValido(endpoint)) throw new HttpError(400, 'Endpoint de subscrição não reconhecido.');

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
 * POST /api/push/equipas/:slug/broadcast — admin envia um aviso push a todos os
 * membros da equipa que tenham subscrição. Devolve { enviadas, falhas }.
 */
router.post(
  '/equipas/:slug/broadcast',
  requireAuth,
  pushAdminLimiter,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');
    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem enviar avisos.');
    if (!pushConfigurado) throw new HttpError(503, 'Notificações push não estão configuradas no servidor.');

    const titulo = String(req.body?.titulo || '').trim();
    const mensagem = String(req.body?.mensagem || '').trim();
    if (!titulo) throw new HttpError(400, 'Indique o título.');
    if (!mensagem) throw new HttpError(400, 'Indique a mensagem.');

    // Subscrições de todos os membros da equipa.
    const { data: membros } = await supabase.from('team_members').select('user_id').eq('team_id', team.id);
    const ids = (membros || []).map((m) => m.user_id).filter(Boolean);
    if (!ids.length) return res.json({ enviadas: 0, falhas: 0 });

    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .in('user_id', ids);
    if (!subs?.length) return res.json({ enviadas: 0, falhas: 0 });

    const body = JSON.stringify({
      title: titulo.slice(0, 60),
      body: mensagem.slice(0, 200),
      icon: '/icons/icon-192.png',
      url: `/equipa/${team.slug}`,
    });

    let enviadas = 0;
    let falhas = 0;
    const resultados = await Promise.allSettled(
      subs.map(async (s) => {
        const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
        try {
          await webpush.sendNotification(subscription, body);
        } catch (err) {
          await limparSeMorta(err, s.id); // 403 (VAPID trocado) / 404 / 410: não serve mais
          throw err;
        }
      })
    );
    resultados.forEach((r) => {
      if (r.status === 'fulfilled') enviadas += 1;
      else falhas += 1;
    });

    res.json({ enviadas, falhas });
  })
);

/**
 * POST /api/push/equipas/:slug/membros/:userId/mensagem — admin envia uma
 * notificação push directa a UM jogador específico (não vai ao feed nem a
 * todos). Devolve { enviadas, falhas }.
 */
router.post(
  '/equipas/:slug/membros/:userId/mensagem',
  requireAuth,
  pushAdminLimiter,
  asyncHandler(async (req, res) => {
    const team = await getTeamBySlug(req.params.slug, 'id, slug');
    if (!team) throw new HttpError(404, 'Time não encontrado.');
    const role = await getRole(team.id, req.user.id);
    if (role !== 'admin') throw new HttpError(403, 'Só admins podem enviar mensagens.');
    if (!pushConfigurado) throw new HttpError(503, 'Notificações push não estão configuradas no servidor.');

    const titulo = String(req.body?.titulo || '').trim();
    const mensagem = String(req.body?.mensagem || '').trim();
    if (!titulo) throw new HttpError(400, 'Indique o título.');
    if (!mensagem) throw new HttpError(400, 'Indique a mensagem.');

    // Confirma que o destinatário é membro da equipa.
    const { userId } = req.params;
    const destRole = await getRole(team.id, userId);
    if (!destRole) throw new HttpError(404, 'Jogador não é membro deste time.');

    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('user_id', userId);
    if (!subs?.length) throw new HttpError(404, 'Este jogador não tem notificações ativas.');

    const body = JSON.stringify({
      title: titulo.slice(0, 60),
      body: mensagem.slice(0, 200),
      icon: '/icons/icon-192.png',
      url: `/equipa/${team.slug}`,
    });

    let enviadas = 0;
    let falhas = 0;
    const resultados = await Promise.allSettled(
      subs.map(async (s) => {
        const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
        try {
          await webpush.sendNotification(subscription, body);
        } catch (err) {
          await limparSeMorta(err, s.id); // 403 (VAPID trocado) / 404 / 410: não serve mais
          throw err;
        }
      })
    );
    resultados.forEach((r) => {
      if (r.status === 'fulfilled') enviadas += 1;
      else falhas += 1;
    });

    res.json({ enviadas, falhas });
  })
);

/**
 * Envia uma notificação push a uma lista de utilizadores (fire-and-forget).
 * Nunca lança: erros são engolidos; subscrições mortas (403/404/410) são apagadas.
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
          await limparSeMorta(err, s.id); // 403 (VAPID trocado) / 404 / 410: não serve mais
        }
      })
    );
  } catch {
    // fire-and-forget: nunca propaga erro para a resposta da API.
  }
}

router.enviarNotificacao = enviarNotificacao;
router.subscricaoMorta = subscricaoMorta;
module.exports = router;
