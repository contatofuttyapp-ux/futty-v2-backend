// Ajuda a APAGAR arquivos no Supabase Storage a partir das suas URLs públicas.
// Remover conteúdo tem de matar o objeto no bucket também —
// senão fica órfão, público e para sempre. Best-effort: se falhar, registra e segue
// (nunca quebra o fluxo do usuário que só quer apagar o post).
const { supabase } = require('./db');
const { assinarToken, decodificarToken } = require('./mediaToken');
const { parametroDe: recorteDoArquivo } = require('./recortesAvatar');

/**
 * Extrai o caminho dentro do bucket a partir de uma URL de mídia — a URL
 * CRUA do Storage (.../object/public/<bucket>/<path>) OU a do PROXY que
 * emitimos (/api/media/<token>). Uma URL que veio do CLIENTE (salva em
 * feed_post_media.url, comentario_anexos.url — o que o usuário reenviou
 * depois de um upload) é SEMPRE a forma do proxy: sem este
 * segundo caminho, removerFicheirosPorUrl nunca achava o arquivo e ele
 * ficava órfão no Storage para sempre. Usa
 * decodificarToken (não verificarToken): apagar tem de continuar a
 * funcionar mesmo com o token há muito expirado — expiração é sobre PODER
 * SERVIR agora, não sobre saber a que arquivo a URL se refere.
 */
function caminhoDeUrl(url, bucket) {
  if (typeof url !== 'string') return null;
  const marca = `/${bucket}/`;
  const i = url.indexOf(marca);
  if (i !== -1) return decodeURIComponent(url.slice(i + marca.length).split('?')[0]); // tira o bucket e a query (?v=…)
  const m = url.match(/\/api\/media\/([^/?#]+)/);
  if (!m) return null;
  const alvo = decodificarToken(m[1]);
  return alvo && alvo.bucket === bucket ? alvo.path : null;
}

/**
 * Remove do `bucket` todos os arquivos cujas URLs públicas são dadas.
 * Não lança: devolve { removidos, erro? }.
 */
async function removerFicheirosPorUrl(bucket, urls) {
  const caminhos = (Array.isArray(urls) ? urls : [urls])
    .map((u) => caminhoDeUrl(u, bucket))
    .filter(Boolean);
  if (!caminhos.length) return { removidos: 0 };
  try {
    const { error } = await supabase.storage.from(bucket).remove(caminhos);
    if (error) {
      console.error(`[storage] falha a remover de ${bucket}:`, error.message, caminhos);
      return { removidos: 0, erro: error.message };
    }
    return { removidos: caminhos.length };
  } catch (e) {
    console.error(`[storage] excepção a remover de ${bucket}:`, e.message);
    return { removidos: 0, erro: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Buckets PRIVADOS + URLs ASSINADOS.
// Os URLs guardados na BD são públicos (formato .../object/public/<bucket>/...).
// Com os buckets privados, esses links morrem; assinamos na fronteira da API.
// ─────────────────────────────────────────────────────────────────────────────
const BUCKETS_PRIVADOS = ['avatars', 'resenha'];

// Deteta um URL público de um bucket nosso privado → { bucket, path, v } | null.
//
// O `?v=<timestamp>` que os uploads gravam é capturado e entra no token:
// é ele que diz "este ficheiro MUDOU" — o caminho no bucket é fixo (upsert), só o v muda.
// Conteúdo novo = v novo = URL novo (o cache do celular renova-se sozinho);
// conteúdo igual = URL igual (o cache acerta).
function parseUrlPublico(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/storage\/v1\/object\/public\/(avatars|resenha)\/([^?"'\s]+)(\?[^"'\s]*)?/);
  if (!m) return null;
  const v = m[3] ? new URLSearchParams(m[3].slice(1)).get('v') : null;
  return { bucket: m[1], path: decodeURIComponent(m[2]), v: v || null };
}

/**
 * Descobre a que bucket privado (avatars/resenha) uma URL GUARDADA pertence
 * — crua OU do proxy — e o caminho dentro dele. Para LIMPEZA (apagarUsuario,
 * scripts/limpar-usuarios-teste.js), que recebe uma pilha de URLs de fontes
 * variadas (avatar, foto de campeão, mídia da Resenha…) sem saber de
 * antemão o bucket de cada uma. Diferente de propósito do parseUrlPublico:
 * aquele serve só o middleware de RESPOSTA (mediaUrls.js) e casa só com a
 * forma crua; a forma de proxy guardada no banco tem o token renovado à parte
 * (renovarUrlDeMidia), porque o token da época vence.
 */
function bucketEcaminho(url) {
  for (const bucket of BUCKETS_PRIVADOS) {
    const caminho = caminhoDeUrl(url, bucket);
    if (caminho) return { bucket, path: caminho };
  }
  return null;
}

// Uma URL do proxy de mídia, inteira (a string é só a URL — nunca um texto que a contém): origem opcional, o token e a query.
const URL_DO_PROXY = /^(https?:\/\/[^/\s"'?#]+)?\/api\/media\/([^/?#\s"']+)(\?[^#\s"']*)?$/;

/**
 * A URL do proxy GUARDADA no banco com o token da época (feed_post_media.url, comentario_anexos.url, games.campeao_foto_url,
 * games.rodada_foto_url, os avatares no JSON dos resultados) volta com um token NOVO, da janela de agora (utils/mediaToken.js).
 * Sem isto, duas semanas depois o token vencia e a foto sumia (o proxy responde 403). O token velho é decodificado sem olhar a
 * validade (decodificarToken), mas a ASSINATURA continua valendo: só renova o que fomos nós que assinamos, e só dos buckets privados.
 * `base` = a origem do backend de agora (a URL pode ter sido guardada com o endereço de outro tempo); sem ela, fica a da própria URL.
 * A query (`?rc=…`) segue igual. Qualquer outra coisa volta como veio.
 */
function renovarUrlDeMidia(url, base = null) {
  if (typeof url !== 'string') return url;
  const m = url.match(URL_DO_PROXY);
  if (!m) return url;
  const alvo = decodificarToken(m[2]);
  if (!alvo || !BUCKETS_PRIVADOS.includes(alvo.bucket)) return url;
  return `${base || m[1] || ''}/api/media/${assinarToken(alvo.bucket, alvo.path, { v: alvo.v })}${m[3] || ''}`;
}

/**
 * A forma de GUARDAR uma mídia: o endereço cru do Storage (bucket + caminho, mais o `?v=`), nunca o token do proxy, que vence.
 * Na leitura o middleware (mediaUrls.js) a transforma de novo em proxy, com token da hora. Quem chega aqui já passou pela validação
 * (validarUrl.js); sem SUPABASE_URL, ou uma URL que não é do proxy, volta como veio.
 */
function urlGuardavelDeMidia(url) {
  if (typeof url !== 'string') return url;
  const m = url.match(URL_DO_PROXY);
  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!m || !supabaseUrl) return url;
  const alvo = decodificarToken(m[2]);
  if (!alvo || !BUCKETS_PRIVADOS.includes(alvo.bucket)) return url;
  const caminho = alvo.path.split('/').map(encodeURIComponent).join('/');
  return `${supabaseUrl}/storage/v1/object/public/${alvo.bucket}/${caminho}${alvo.v ? `?v=${encodeURIComponent(alvo.v)}` : ''}`;
}

// Percorre o payload (objetos/arrays) e aplica fn a cada STRING; se fn devolver
// algo !== undefined, substitui no sítio. Profundidade limitada por segurança.
function percorrer(node, fn, prof = 0) {
  if (prof > 12 || node == null) return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (typeof v === 'string') { const nv = fn(v); if (nv !== undefined) node[i] = nv; }
      else if (v && typeof v === 'object') percorrer(v, fn, prof + 1);
    }
  } else if (typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string') { const nv = fn(v); if (nv !== undefined) node[k] = nv; }
      else if (v && typeof v === 'object') percorrer(v, fn, prof + 1);
    }
  }
}

/**
 * Assina, IN-PLACE, todos os URLs de buckets privados no payload. Batch por bucket
 * (createSignedUrls). Fail-open: em erro, deixa o que não conseguiu assinar como está.
 */
async function assinarPayload(payload, expiresIn = 3600) {
  try {
    if (!payload || typeof payload !== 'object') return payload;
    const paths = {}; // bucket -> Set(path)
    percorrer(payload, (s) => {
      const p = parseUrlPublico(s);
      if (p) (paths[p.bucket] ||= new Set()).add(p.path);
      return undefined;
    });
    const assinado = {}; // `${bucket}:${path}` -> signedUrl
    for (const bucket of Object.keys(paths)) {
      const lista = [...paths[bucket]];
      if (!lista.length) continue;
      const { data, error } = await supabase.storage.from(bucket).createSignedUrls(lista, expiresIn);
      if (error) { console.error('[media] createSignedUrls', bucket, error.message); continue; }
      for (const row of data || []) {
        if (row && row.signedUrl && !row.error) assinado[`${bucket}:${row.path}`] = row.signedUrl;
      }
    }
    percorrer(payload, (s) => {
      const p = parseUrlPublico(s);
      if (!p) return undefined;
      return assinado[`${p.bucket}:${p.path}`]; // undefined se não assinou → fica como está
    });
    return payload;
  } catch (e) {
    console.error('[media] assinarPayload falhou (fail-open):', e.message);
    return payload;
  }
}

/**
 * O URL do proxy de um arquivo ({ bucket, path, v }, de parseUrlPublico).
 * Se a pessoa escolheu um recorte para a miniatura deste arquivo (utils/recortesAvatar.js), ele
 * vai junto na query (`?rc=x,y,escala`); o proxy só o aplica nos pedidos quadrados (`sq=1`) e o
 * resto (card, cromo, fotos grandes) o ignora. Fica na URL — e não no token — para o app, que
 * acrescenta `&w=…`, nunca ter de decodificar nada, e porque o URL novo é o que quebra o cache.
 */
function urlDoProxy(base, p) {
  const rc = p.bucket === 'avatars' ? recorteDoArquivo(p.path) : null;
  return `${base}/api/media/${assinarToken(p.bucket, p.path, { v: p.v })}${rc ? `?rc=${rc}` : ''}`;
}

/**
 * Reescreve, IN-PLACE, os URLs de buckets privados para URLs ESTÁVEIS do proxy
 * (`${base}/api/media/<token>`). O DOM não segura URLs assinados
 * de vida curta → sem expiração à vista; o bucket continua privado. `base` é a
 * origem do backend (ex. http://localhost:3001).
 * As que já vêm em forma de proxy (guardadas assim) saem com o token renovado (renovarUrlDeMidia): o da época vence em ~2 semanas.
 */
function proxificarPayload(payload, base) {
  try {
    if (!payload || typeof payload !== 'object' || !base) return payload;
    percorrer(payload, (s) => {
      const p = parseUrlPublico(s);
      if (p) return urlDoProxy(base, p);
      if (!s.includes('/api/media/')) return undefined;
      const nova = renovarUrlDeMidia(s, base);
      return nova !== s ? nova : undefined;
    });
    return payload;
  } catch (e) {
    console.error('[media] proxificarPayload falhou (fail-open):', e.message);
    return payload;
  }
}

/**
 * Remove (para '') os URLs de buckets privados no payload — usado nas páginas
 * PÚBLICAS de partilha: sem sessão, cai na silhueta/fallback do frontend.
 */
function despublicarPayload(payload) {
  try {
    if (!payload || typeof payload !== 'object') return payload;
    percorrer(payload, (s) => (parseUrlPublico(s) ? '' : undefined));
    return payload;
  } catch (e) {
    console.error('[media] despublicarPayload falhou (fail-open):', e.message);
    return payload;
  }
}

/** Torna privados (idempotente) os buckets de avatares e resenha. */
async function privatizarBuckets() {
  for (const bucket of BUCKETS_PRIVADOS) {
    try {
      const { error } = await supabase.storage.updateBucket(bucket, { public: false });
      if (error) console.error(`[storage] privatizar ${bucket}:`, error.message);
      else console.log(`[storage] bucket ${bucket} → privado`);
    } catch (e) {
      console.error(`[storage] excepção a privatizar ${bucket}:`, e.message);
    }
  }
}

module.exports = {
  removerFicheirosPorUrl,
  caminhoDeUrl,
  parseUrlPublico,
  bucketEcaminho,
  assinarPayload,
  proxificarPayload,
  urlDoProxy,
  renovarUrlDeMidia,
  urlGuardavelDeMidia,
  despublicarPayload,
  privatizarBuckets,
  BUCKETS_PRIVADOS,
};
