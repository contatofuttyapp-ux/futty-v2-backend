// Token de capacidade para o proxy de imagem (Tijolo 2).
// Um <img> não pode enviar o header Authorization, por isso a autorização viaja
// NO URL: um token HMAC assinado por nós, emitido só dentro de respostas já
// autenticadas (middleware mediaUrls). O proxy valida a assinatura + validade e
// serve o ficheiro do bucket privado. Segredo = server-only (nunca no cliente).
const crypto = require('crypto');

// O fallback para a chave secreta do Supabase/'dev-only' só é alcançável em dev —
// server.js recusa arrancar em produção sem MEDIA_TOKEN_SECRET definido.
const SEGREDO = process.env.MEDIA_TOKEN_SECRET || require('./chavesSupabase').chaveSecreta() || 'dev-only';

// VELOCIDADE 6A (15-set) — o token era `agora + 7 dias`, ou seja MUDAVA A CADA
// SEGUNDO. URL diferente a cada leitura = o cache do celular NUNCA acertava: a
// mesma foto foi medida a descer 3 vezes num único carregamento do Início,
// 390 KB e 1,4 s cada.
//
// Agora o `exp` é arredondado a uma JANELA de 7 dias: todos os tokens emitidos
// na mesma semana têm o mesmo `exp`, logo o MESMO token → a mesma URL → o
// celular reaproveita do disco. O `+2` janelas garante que o token vale sempre
// pelo menos 7 dias mesmo quando é emitido no último segundo de uma janela
// (nunca entrega ao cliente um URL prestes a expirar).
const JANELA = 7 * 24 * 3600;
const TTL_PADRAO = JANELA; // mantido no export: outros módulos leem-no

/** Fim da janela de 7 dias em que `agoraS` cai, mais uma janela de folga. */
function expDaJanela(agoraS = Math.floor(Date.now() / 1000)) {
  return (Math.floor(agoraS / JANELA) + 2) * JANELA;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deB64url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function assinatura(corpo) {
  return b64url(crypto.createHmac('sha256', SEGREDO).update(corpo).digest());
}

/**
 * Emite um token ESTÁVEL para {bucket, path}: o mesmo ficheiro dá o mesmo token
 * durante toda a janela de 7 dias.
 *
 * `v` é a versão do conteúdo (o `?v=<timestamp>` que os uploads gravam no URL).
 * É ela que quebra o cache quando o conteúdo muda: figurinha regenerada = v
 * novo = token novo = URL novo. Sem `v`, o token fica igual ao formato antigo.
 */
function assinarToken(bucket, path, { v } = {}) {
  const payload = { b: bucket, p: path, e: expDaJanela() };
  if (v) payload.v = String(v);
  const corpo = b64url(JSON.stringify(payload));
  return `${corpo}.${assinatura(corpo)}`;
}

/**
 * Decodifica um token (valida a ASSINATURA, ignora expiração). Uso interno:
 * saber a que ficheiro uma URL antiga se refere, mesmo que o token em si já
 * tenha expirado — é o caso de apagar um post/conta de meses atrás (Rodada
 * 15: sem isto, removerFicheirosPorUrl/apagarUsuario nunca resolviam a URL
 * salva em feed_post_media/comentario_anexos, que é sempre a do proxy desde
 * o Tijolo 2 — os arquivos ficavam órfãos no Storage para sempre). NUNCA
 * usar para decidir se um pedido pode VER o ficheiro agora — só verificarToken
 * faz essa checagem.
 */
function decodificarToken(token) {
  try {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [corpo, sig] = token.split('.');
    // comparação em tempo constante
    const esperada = assinatura(corpo);
    const a = deB64url(sig);
    const b = deB64url(esperada);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const { b: bucket, p: path, e: exp, v } = JSON.parse(deB64url(corpo).toString());
    if (!bucket || !path || !exp) return null;
    return { bucket, path, exp, v: v || null };
  } catch {
    return null;
  }
}

/** Valida um token PARA SERVIR AGORA: assinatura + ainda dentro da validade. Devolve {bucket, path, v} ou null. */
function verificarToken(token) {
  const alvo = decodificarToken(token);
  if (!alvo) return null;
  if (Math.floor(Date.now() / 1000) > alvo.exp) return null;
  // Tokens emitidos antes da Velocidade 6A não têm `v` — continuam válidos.
  return { bucket: alvo.bucket, path: alvo.path, v: alvo.v };
}

module.exports = { assinarToken, verificarToken, decodificarToken, TTL_PADRAO, JANELA, expDaJanela };
