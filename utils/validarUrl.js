// Futty v2.0 — Validação de URLs enviadas pelo utilizador (SEGURANCA-REVISAO-
// 10SET.md secção 3). Sem isto, feed.js aceitava qualquer string como URL de
// mídia (o <img>/<video> do cliente ia buscar o que fosse — pixel de
// rastreio, SSRF interno, o que der) e push.js aceitava qualquer endpoint de
// subscrição push (o servidor fazia POST directo para onde mandassem).
const SUPABASE_HOST = (() => {
  try { return new URL(process.env.SUPABASE_URL).host; } catch { return null; }
})();

/**
 * true se `url` for https e apontar para o Storage do Supabase ou para o
 * proxy de mídia do próprio backend (/api/media/...). `req` só é usado para
 * saber o host do backend (mesmo padrão de middleware/mediaUrls.js).
 */
function urlDeMidiaValida(url, req) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (SUPABASE_HOST && u.host === SUPABASE_HOST) return true;
  if (u.host === req.get('host') && u.pathname.startsWith('/api/media/')) return true;
  return false;
}

// Serviços de push conhecidos (um por navegador/SO). Endpoints reais têm path
// próprio depois do host (ex.: fcm.googleapis.com/fcm/send/xxxxx) — só o host
// importa aqui. *.notify.windows.com cobre os vários subdomínios da Microsoft.
const HOSTS_PUSH_CONHECIDOS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
];
const SUFIXO_PUSH_WINDOWS = '.notify.windows.com';

/** true se `endpoint` for https e o host for um serviço de push conhecido. */
function endpointPushValido(endpoint) {
  let u;
  try { u = new URL(String(endpoint)); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (HOSTS_PUSH_CONHECIDOS.includes(u.host)) return true;
  if (u.host.endsWith(SUFIXO_PUSH_WINDOWS)) return true;
  return false;
}

module.exports = { urlDeMidiaValida, endpointPushValido };
