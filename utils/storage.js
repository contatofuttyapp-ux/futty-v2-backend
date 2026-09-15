// Ajuda a APAGAR ficheiros no Supabase Storage a partir das suas URLs públicas.
// Tijolo 1B (peça 2): remover conteúdo tem de matar o objeto no bucket também —
// senão fica órfão, público e para sempre. Best-effort: se falhar, regista e segue
// (nunca quebra o fluxo do utilizador que só quer apagar o post).
const { supabase } = require('./db');
const { assinarToken } = require('./mediaToken');

/** Extrai o caminho dentro do bucket a partir de uma URL pública do Storage. */
function caminhoDeUrl(url, bucket) {
  if (typeof url !== 'string') return null;
  const marca = `/${bucket}/`;
  const i = url.indexOf(marca);
  if (i === -1) return null;
  // tira o bucket e a query (?v=…)
  return decodeURIComponent(url.slice(i + marca.length).split('?')[0]);
}

/**
 * Remove do `bucket` todos os ficheiros cujas URLs públicas são dadas.
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
// Tijolo 1C — buckets PRIVADOS + URLs ASSINADOS.
// Os URLs guardados na BD são públicos (formato .../object/public/<bucket>/...).
// Com os buckets privados, esses links morrem; assinamos na fronteira da API.
// ─────────────────────────────────────────────────────────────────────────────
const BUCKETS_PRIVADOS = ['avatars', 'resenha'];

// Deteta um URL público de um bucket nosso privado → { bucket, path, v } | null.
//
// VELOCIDADE 6A (15-set): o `?v=<timestamp>` que os uploads gravam (routes/auth.js
// :304 e :885, routes/teams.js :428) era simplesmente deitado fora aqui. É ele que
// diz "este ficheiro MUDOU" — o caminho no bucket é fixo (upsert), só o v muda.
// Agora é capturado e entra no token: conteúdo novo = v novo = URL novo (o cache
// do celular renova-se sozinho); conteúdo igual = URL igual (o cache acerta).
function parseUrlPublico(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/storage\/v1\/object\/public\/(avatars|resenha)\/([^?"'\s]+)(\?[^"'\s]*)?/);
  if (!m) return null;
  const v = m[3] ? new URLSearchParams(m[3].slice(1)).get('v') : null;
  return { bucket: m[1], path: decodeURIComponent(m[2]), v: v || null };
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
 * Reescreve, IN-PLACE, os URLs de buckets privados para URLs ESTÁVEIS do proxy
 * (`${base}/api/media/<token>`). Tijolo 2: o DOM deixa de segurar URLs assinados
 * de vida curta → sem expiração à vista; o bucket continua privado. `base` é a
 * origem do backend (ex. http://localhost:3001).
 */
function proxificarPayload(payload, base) {
  try {
    if (!payload || typeof payload !== 'object' || !base) return payload;
    percorrer(payload, (s) => {
      const p = parseUrlPublico(s);
      if (!p) return undefined;
      return `${base}/api/media/${assinarToken(p.bucket, p.path, { v: p.v })}`;
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
  assinarPayload,
  proxificarPayload,
  despublicarPayload,
  privatizarBuckets,
  BUCKETS_PRIVADOS,
};
