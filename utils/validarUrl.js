// Futty v2.0 — Validação de URLs enviadas pelo usuário (SEGURANCA-REVISAO-
// 10SET.md secção 3). Sem isto, feed.js aceitava qualquer string como URL de
// mídia (o <img>/<video> do cliente ia buscar o que fosse — pixel de
// rastreio, SSRF interno, o que der) e push.js aceitava qualquer endpoint de
// subscrição push (o servidor fazia POST directo para onde mandassem).
const SUPABASE_HOST = (() => {
  try { return new URL(process.env.SUPABASE_URL).host; } catch { return null; }
})();

const { verificarToken } = require('./mediaToken');

const PREFIXO_CRU = '/storage/v1/object/public/';
const PREFIXO_PROXY = '/api/media/';

/**
 * O caminho, dentro do bucket `bucket`, a que uma URL de mídia aponta — ou null se ela não aponta para esse bucket nosso.
 * Duas formas valem: a crua do Storage do Supabase (`…/storage/v1/object/public/<bucket>/<arquivo>`, o que o upload devolve) e a do
 * proxy de mídia do próprio backend (`/api/media/<token>`), cujo token é assinado por nós: um token forjado não passa, e um token de
 * outro bucket também não. `req` só é usado para saber o host do backend (mesmo padrão de middleware/mediaUrls.js).
 * Só https. Qualquer outro endereço — outro host, outro bucket, `javascript:` — é null.
 */
// O proxy de mídia também é servido pelo SITE (a Cloudflare guarda as fotos na borda: o app pede futtyapp.com.br/api/media/…), então uma
// URL do proxy pode chegar com o host do site e não com o do motor. Quem manda é o token assinado; o host só diz que é um endereço nosso.
const HOSTS_DO_SITE = ['futtyapp.com.br', 'www.futtyapp.com.br'];
// Em dev e nas provas o motor roda em http://127.0.0.1 ou localhost; em produção, só https.
const ehLocal = (u) => u.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(u.hostname) && process.env.NODE_ENV !== 'production';

function caminhoNoBucket(url, bucket, req) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== 'https:' && !ehLocal(u)) return null;
  if (SUPABASE_HOST && u.host === SUPABASE_HOST && u.pathname.startsWith(`${PREFIXO_CRU}${bucket}/`)) {
    try { return decodeURIComponent(u.pathname.slice(`${PREFIXO_CRU}${bucket}/`.length)) || null; } catch { return null; }
  }
  if (req && (u.host === req.get('host') || HOSTS_DO_SITE.includes(u.host)) && u.pathname.startsWith(PREFIXO_PROXY)) {
    const alvo = verificarToken(u.pathname.slice(PREFIXO_PROXY.length));
    return alvo && alvo.bucket === bucket ? alvo.path : null;
  }
  return null;
}

/**
 * true se `url` é uma mídia da Resenha: o bucket `resenha` do Storage ou o proxy assinado que aponta para ele. Antes bastava o host ser
 * o do Supabase — e qualquer objeto de qualquer bucket do projeto (a foto de perfil de outra pessoa, por exemplo) passava como "mídia".
 */
function urlDeMidiaValida(url, req) {
  return caminhoNoBucket(url, 'resenha', req) !== null;
}

/**
 * A mídia é de quem está postando? O upload da Resenha dá ao arquivo o id de quem subiu como prefixo do nome (routes/feed.js,
 * POST /upload), então "é meu" se lê no próprio nome. Sem isto, qualquer um que visse o endereço de uma foto no feed (o proxy
 * mostra o caminho no token) a anexava ao seu post — e, ao apagar o post, o arquivo da outra pessoa ia junto.
 */
function midiaEhDe(url, req, userId) {
  const caminho = caminhoNoBucket(url, 'resenha', req);
  return !!caminho && !caminho.includes('/') && !!userId && caminho.startsWith(`${userId}-`);
}

/**
 * true se `url` é uma foto de perfil nossa (bucket `avatars`, crua ou pelo proxy). Quem guarda avatar de terceiros no sorteio,
 * no campeonato ou nos times à mão só deixa passar isto: o resto vira "sem foto" em vez de virar um `<img>` para qualquer endereço.
 */
function urlDeAvatarValida(url, req) {
  return caminhoNoBucket(url, 'avatars', req) !== null;
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

module.exports = { urlDeMidiaValida, midiaEhDe, urlDeAvatarValida, caminhoNoBucket, endpointPushValido };
