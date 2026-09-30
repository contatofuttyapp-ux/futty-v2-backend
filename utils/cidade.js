// Futty v2.0 — Rodada 29B (D): a cidade de um time.
//
// O app (CampoCidade) deixa a pessoa escolher numa lista estática — 5.570 municípios do Brasil e 308 concelhos de
// Portugal — e manda { cidade, uf, pais, lat, lng, origem: 'lista' }. Regra completa (dono, 30-set):
//   1. cidade DA LISTA → a coordenada vem da própria lista (arredondada como sempre, ~1 km); nenhuma chamada externa;
//   2. FORA da lista → tenta o Nominatim como antes; achou → "Encontramos: <nome oficial>" e guarda o ponto;
//   3. nada achou → guarda o TEXTO mesmo assim e avisa na tela; o Explorar passa a casar por texto normalizado
//      (sem acento, sem maiúscula, sem espaço sobrando) quando o time não tem coordenada.
// Este módulo é a parte pura dessa regra: normalizar, ler a escolha da lista, decidir e devolver o que gravar.
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

module.exports = { normalizarCidade, rotuloDaCidade, lerEscolhaDaLista, resolverCidade, timeCasaPorCidade, condicaoPorCidade, PAISES_DA_LISTA };
