// Futty v2.0 — Geocodificação de CIDADES de EQUIPAS (Nominatim/OSM, grátis).
// Respeita a política do OSM: User-Agent que identifica o Futty, MÁX 1 req/s, e CACHE
// do resultado (nunca geocodificar em loop). Arredonda a 2 casas (~1,1 km) AQUI, no
// servidor, antes de devolver — a morada exata nunca sai daqui. Só para EQUIPAS.
const cache = new Map(); // cidade (lower) -> {lat,lng,nomeOficial} | null
let ultimoReq = 0;

/**
 * O nome que a pessoa vê em "Encontramos: …" (Rodada 29B, D): o nome do lugar e a região — "Brasília, Distrito Federal",
 * "Porto, Portugal". Só o que o Nominatim diz do lugar; nunca a morada.
 */
function nomeOficialDoNominatim(item) {
  const a = item?.address || {};
  const nome = item?.name || a.city || a.town || a.village || a.municipality || String(item?.display_name || '').split(',')[0].trim();
  const regiao = a.state || a.region || a.county || a.country;
  return [nome, regiao].filter(Boolean).join(', ') || null;
}

/** Geocodifica uma cidade → {lat,lng,nomeOficial} (lat/lng arredondados, ~1km) ou null. Rate-limited + cache. */
async function geocodar(cidade) {
  const termo = String(cidade || '').trim();
  if (!termo) return null;
  const chave = termo.toLowerCase();
  if (cache.has(chave)) return cache.get(chave);

  // MÁX 1 req/s (política Nominatim).
  const espera = 1000 - (Date.now() - ultimoReq);
  if (espera > 0) await new Promise((r) => setTimeout(r, espera));
  ultimoReq = Date.now();

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=${encodeURIComponent(termo)}`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Futty/1.0 (https://futtyapp.com.br; contato@futtyapp.com)' } });
    if (!resp.ok) { cache.set(chave, null); return null; }
    const arr = await resp.json();
    if (!Array.isArray(arr) || !arr.length) { cache.set(chave, null); return null; }
    const lat = Math.round(parseFloat(arr[0].lat) * 100) / 100; // 2 casas ≈ 1,1 km
    const lng = Math.round(parseFloat(arr[0].lon) * 100) / 100;
    if (Number.isNaN(lat) || Number.isNaN(lng)) { cache.set(chave, null); return null; }
    const res = { lat, lng, nomeOficial: nomeOficialDoNominatim(arr[0]) };
    cache.set(chave, res);
    return res;
  } catch {
    return null; // não cacheia erros de rede (pode voltar a tentar mais tarde)
  }
}

module.exports = { geocodar, nomeOficialDoNominatim };
