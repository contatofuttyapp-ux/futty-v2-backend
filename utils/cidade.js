// Futty v2.0 — Rodada 29B (D): a cidade de um time.
//
// O app (CampoCidade) deixa a pessoa escolher numa lista estática — 5.570 municípios do Brasil e 308 concelhos de
// Portugal — e manda { cidade, uf, pais, lat, lng, origem: 'lista' }. Regra completa (dono, 30-set):
//   1. cidade DA LISTA → a coordenada vem da própria lista (arredondada como sempre, ~1 km); nenhuma chamada externa;
//   2. FORA da lista → tenta o Nominatim como antes; achou → "Encontramos: <nome oficial>" e guarda o ponto;
//   3. nada achou → guarda o TEXTO mesmo assim e avisa na tela; o Explorar passa a casar por texto normalizado
//      (sem acento, sem maiúscula, sem espaço sobrando) quando o time não tem coordenada.
// Este módulo é a parte pura dessa regra: normalizar, ler a escolha da lista, decidir e devolver o que gravar.
//
// RODADA 29H (item 12, dono 2-out): o BAIRRO, opcional. Antes o ponto do time era o centro da cidade (todos os times de
// "São Paulo" no mesmo ponto). Agora o admin pode declarar o bairro ("Pinheiros"; em Portugal, a freguesia) e o motor
// geocodifica "bairro, cidade" UMA vez (Nominatim, como a cidade; ver resolverBairro). Achou perto da cidade → o ponto do
// time passa a ser o do bairro (~1 km); não achou → fica o ponto da cidade e o app avisa. Freguesia escolhida na lista do app
// (Portugal) vem com a coordenada e dispensa a chamada. Só o bairro e a cidade, nunca o endereço.
const { geocodar: geocodarNominatim } = require('./geocode');

const ARREDONDA = (n) => Math.round(n * 100) / 100; // 2 casas ≈ 1,1 km — a mesma precisão do geocode.js
const PAISES_DA_LISTA = ['BR', 'PT'];

/** "  SÃO  paulo " → "sao paulo": sem acento, sem maiúscula, espaços duplos e das pontas fora. */
function normalizarCidade(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** O que o time mostra de cidade: "Belo Horizonte, MG" · "Lisboa, Portugal" · o texto puro fora da lista. */
function rotuloDaCidade({ cidade, uf, pais }) {
  if (pais === 'BR' && uf) return `${cidade}, ${uf}`;
  if (pais === 'PT') return `${cidade}, Portugal`;
  return cidade;
}

const texto = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * A escolha da lista, validada — ou null (quem chamou cai no caminho do texto livre). Só vale com `origem: 'lista'`,
 * país da lista e coordenada de verdade; qualquer outra coisa é tratada como texto digitado.
 */
function lerEscolhaDaLista(corpo) {
  if (corpo?.origem !== 'lista') return null;
  const cidade = texto(corpo.cidade, 100);
  const uf = texto(corpo.uf, 40);
  const pais = texto(corpo.pais, 2).toUpperCase();
  const lat = Number(corpo.lat);
  const lng = Number(corpo.lng);
  if (!cidade || !PAISES_DA_LISTA.includes(pais)) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { cidade, uf, pais, lat: ARREDONDA(lat), lng: ARREDONDA(lng), rotulo: rotuloDaCidade({ cidade, uf, pais }).slice(0, 100) };
}

/**
 * Decide o que gravar para o corpo de um POST /api/teams ou PATCH /api/teams/:slug.
 *   cidade        o texto a guardar (ou null se a cidade veio vazia)
 *   normalizada   a mesma cidade normalizada, para o Explorar casar por texto
 *   geo           { lat, lng } a guardar, ou null (sem ponto)
 *   info          o que o app mostra: { encontrada: true, nomeOficial } | { encontrada: false } | null (sem cidade)
 *   vazia         true quando a cidade veio vazia (o PATCH usa para limpar o ponto)
 * `geocodar` é injetável para o teste não falar com a rede.
 */
async function resolverCidade(corpo, { geocodar = geocodarNominatim } = {}) {
  const escolha = lerEscolhaDaLista(corpo);
  if (escolha) {
    return {
      cidade: escolha.rotulo,
      normalizada: normalizarCidade(escolha.cidade),
      geo: { lat: escolha.lat, lng: escolha.lng },
      info: { encontrada: true, nomeOficial: escolha.rotulo },
      vazia: false,
    };
  }
  const digitada = texto(corpo?.cidade, 100);
  if (!digitada) return { cidade: null, normalizada: null, geo: null, info: null, vazia: true };
  const g = await geocodar(digitada);
  if (g) {
    return {
      cidade: digitada,
      normalizada: normalizarCidade(digitada),
      geo: { lat: g.lat, lng: g.lng },
      info: { encontrada: true, nomeOficial: g.nomeOficial || digitada },
      vazia: false,
    };
  }
  return { cidade: digitada, normalizada: normalizarCidade(digitada), geo: null, info: { encontrada: false }, vazia: false };
}

/**
 * O time aparece para quem busca esta cidade por TEXTO? Só quando não tem coordenada (com ponto, quem manda é a
 * distância) e a cidade normalizada é IGUAL à busca normalizada — "exatamente", como o aviso da tela promete.
 */
function timeCasaPorCidade(time, busca) {
  const procurada = normalizarCidade(busca);
  if (!procurada) return false;
  if (time?.geo_lat != null && time?.geo_lng != null) return false;
  return !!time?.cidade_normalizada && time.cidade_normalizada === procurada;
}

/**
 * A condição do filtro .or() do PostgREST que faz o Explorar casar por texto a cidade de um time SEM ponto — o mesmo
 * critério de timeCasaPorCidade, dito ao banco: "cidade_normalizada = a busca normalizada E sem geo_lat". Devolve ''
 * quando não há o que casar; vem com a vírgula na frente, pronta para colar depois das outras condições. `citar` é o
 * escape de valor do filtro (routes/teams.js#valorFiltroOr).
 */
function condicaoPorCidade(busca, citar = (v) => v) {
  const procurada = normalizarCidade(busca);
  return procurada ? `,and(cidade_normalizada.eq.${citar(procurada)},geo_lat.is.null)` : '';
}

// ─── O bairro (29H) ───────────────────────────────────────────────────────────────────────────────────────────────

const RAIO_DO_BAIRRO_KM = 60; // um bairro fica perto do centro da cidade; mais longe que isto é outro lugar com o mesmo nome

/** Distância em km entre dois pontos { lat, lng } (haversine). */
function distanciaKm(a, b) {
  const rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** O bairro que veio no corpo: texto aparado, até 80 letras; '' quando não veio. */
function lerBairro(corpo) {
  return texto(corpo?.bairro, 80);
}

/** A freguesia escolhida na lista do app (Portugal): { lat, lng } arredondado, ou null — só vale com coordenada de verdade em Portugal. */
function lerPontoDaLista(corpo) {
  if (corpo?.bairro_origem !== 'lista') return null;
  const lat = Number(corpo.bairro_lat);
  const lng = Number(corpo.bairro_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < 32 || lat > 43 || lng < -32 || lng > -6) return null;
  return { lat: ARREDONDA(lat), lng: ARREDONDA(lng) };
}

/**
 * Decide o que gravar do bairro de um POST /api/teams ou PATCH /api/teams/:slug.
 *   cidade   o resultado de resolverCidade (ou { cidade, geo } do que já está gravado): o bairro só existe DENTRO de uma cidade
 *   bairro / normalizado   o texto a guardar e o mesmo normalizado (null se veio vazio)
 *   geo      { lat, lng } do bairro, ou null (nada achou: o ponto continua o da cidade)
 *   info     { encontrado: true, nomeOficial: "<bairro>, <cidade>" } | { encontrado: false } | null (sem bairro)
 *   vazio    true quando o bairro veio vazio ou não há cidade onde pôr um bairro
 * geocodar é injetável para o teste não falar com a rede.
 */
async function resolverBairro(corpo, cidade, { geocodar = geocodarNominatim } = {}) {
  const vazio = { bairro: null, normalizado: null, geo: null, info: null, vazio: true };
  const bairro = lerBairro(corpo);
  if (!bairro || !cidade?.cidade) return vazio;
  const normalizado = normalizarCidade(bairro);
  const nomeOficial = `${bairro}, ${cidade.cidade}`;
  const daLista = lerPontoDaLista(corpo);
  if (daLista) return { bairro, normalizado, geo: daLista, info: { encontrado: true, nomeOficial }, vazio: false };
  const g = await geocodar(nomeOficial);
  // Perto da cidade ou nada: o mesmo nome em outro estado/país (há uma "Vila Nova" em todo canto) não vale.
  if (g && (!cidade.geo || distanciaKm(g, cidade.geo) <= RAIO_DO_BAIRRO_KM)) {
    return { bairro, normalizado, geo: { lat: g.lat, lng: g.lng }, info: { encontrado: true, nomeOficial }, vazio: false };
  }
  return { bairro, normalizado, geo: null, info: { encontrado: false }, vazio: false };
}

module.exports = { normalizarCidade, rotuloDaCidade, lerEscolhaDaLista, resolverCidade, timeCasaPorCidade, condicaoPorCidade, PAISES_DA_LISTA, lerBairro, resolverBairro, distanciaKm, RAIO_DO_BAIRRO_KM };
