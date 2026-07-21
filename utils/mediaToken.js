// Token de capacidade para o proxy de imagem (Tijolo 2).
// Um <img> não pode enviar o header Authorization, por isso a autorização viaja
// NO URL: um token HMAC assinado por nós, emitido só dentro de respostas já
// autenticadas (middleware mediaUrls). O proxy valida a assinatura + validade e
// serve o ficheiro do bucket privado. Segredo = server-only (nunca no cliente).
const crypto = require('crypto');

const SEGREDO = process.env.MEDIA_TOKEN_SECRET || process.env.SUPABASE_SERVICE_KEY || 'dev-only';
const TTL_PADRAO = 7 * 24 * 3600; // 7 dias — o URL no DOM não expira à vista (mata o tradeoff da 1h)

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deB64url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function assinatura(corpo) {
  return b64url(crypto.createHmac('sha256', SEGREDO).update(corpo).digest());
}

/** Emite um token para {bucket, path} válido `ttl` segundos. */
function assinarToken(bucket, path, ttl = TTL_PADRAO) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const corpo = b64url(JSON.stringify({ b: bucket, p: path, e: exp }));
  return `${corpo}.${assinatura(corpo)}`;
}

/** Valida um token. Devolve {bucket, path} ou null (assinatura má / expirado). */
function verificarToken(token) {
  try {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [corpo, sig] = token.split('.');
    // comparação em tempo constante
    const esperada = assinatura(corpo);
    const a = deB64url(sig);
    const b = deB64url(esperada);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const { b: bucket, p: path, e: exp } = JSON.parse(deB64url(corpo).toString());
    if (!bucket || !path || !exp) return null;
    if (Math.floor(Date.now() / 1000) > exp) return null;
    return { bucket, path };
  } catch {
    return null;
  }
}

module.exports = { assinarToken, verificarToken, TTL_PADRAO };
