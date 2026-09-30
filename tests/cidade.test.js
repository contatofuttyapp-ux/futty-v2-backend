// Futty v2.0 — RODADA 29B (D): a cidade do time — utils/cidade.js (sem banco, sem rede).
//
// Prova a regra completa do dono (30-set):
//   1. cidade da LISTA → coordenada da lista, arredondada como sempre, sem chamar o Nominatim;
//   2. fora da lista → Nominatim; achou → { encontrada: true, nomeOficial };
//   3. nada achou → guarda o texto mesmo assim ({ encontrada: false }) e o Explorar casa por texto NORMALIZADO
//      (sem acento, sem maiúscula, sem espaço duplo) quando o time não tem coordenada.
//
// Uso: npm test  (ou: node --test tests/cidade.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizarCidade, rotuloDaCidade, lerEscolhaDaLista, resolverCidade, timeCasaPorCidade, condicaoPorCidade,
} = require('../utils/cidade');
const { nomeOficialDoNominatim } = require('../utils/geocode');

const BH = { cidade: 'Belo Horizonte', uf: 'MG', pais: 'BR', lat: -19.9191, lng: -43.9386, origem: 'lista' };
const LISBOA = { cidade: 'Lisboa', uf: 'Lisboa', pais: 'PT', lat: 38.7223, lng: -9.1393, origem: 'lista' };

/** Um geocodar de mentira que conta as chamadas (nenhuma rede). */
function geocodarFalso(respostas = {}) {
  const chamadas = [];
  const geocodar = async (texto) => { chamadas.push(texto); return respostas[texto] ?? null; };
  return { geocodar, chamadas };
}

// ─── normalização ─────────────────────────────────────────────────────────────
test('normalizar: sem acento, sem maiúscula, sem espaço duplo nem nas pontas', () => {
  assert.equal(normalizarCidade('São Paulo'), 'sao paulo');
  assert.equal(normalizarCidade('  SAO   paulo '), 'sao paulo');
  assert.equal(normalizarCidade('Brasília'), 'brasilia');
  assert.equal(normalizarCidade('Açu'), 'acu');
  assert.equal(normalizarCidade('Vila Nova de Gaia'), 'vila nova de gaia');
  assert.equal(normalizarCidade('Ribeirão\tPreto'), 'ribeirao preto', 'tabulação também é espaço');
  assert.equal(normalizarCidade('Olho d\'Água'), 'olho d\'agua', 'pontuação fica (só acento e caixa saem)');
});

test('normalizar: as grafias que a pessoa escreve dão o MESMO resultado', () => {
  const grafias = ['Brasília', 'brasilia', 'BRASILIA', ' Brasília ', 'Brasilia'];
  assert.equal(new Set(grafias.map(normalizarCidade)).size, 1);
});

test('normalizar: vazio, nulo e indefinido viram ""', () => {
  assert.equal(normalizarCidade(''), '');
  assert.equal(normalizarCidade(null), '');
  assert.equal(normalizarCidade(undefined), '');
  assert.equal(normalizarCidade('   '), '');
});

// ─── rótulo e escolha da lista ────────────────────────────────────────────────
test('rótulo: "Cidade, UF" no Brasil, "Concelho, Portugal" em Portugal, o texto puro fora da lista', () => {
  assert.equal(rotuloDaCidade(BH), 'Belo Horizonte, MG');
  assert.equal(rotuloDaCidade(LISBOA), 'Lisboa, Portugal');
  assert.equal(rotuloDaCidade({ cidade: 'Kyoto' }), 'Kyoto');
});

test('escolha da lista: só vale com origem "lista", país da lista e coordenada de verdade', () => {
  const ok = lerEscolhaDaLista(BH);
  assert.deepEqual(ok, { cidade: 'Belo Horizonte', uf: 'MG', pais: 'BR', lat: -19.92, lng: -43.94, rotulo: 'Belo Horizonte, MG' });
  assert.equal(lerEscolhaDaLista({ ...BH, origem: undefined }), null, 'sem origem é texto digitado');
  assert.equal(lerEscolhaDaLista({ ...BH, origem: 'nominatim' }), null);
  assert.equal(lerEscolhaDaLista({ ...BH, pais: 'JP' }), null, 'país fora da lista');
  assert.equal(lerEscolhaDaLista({ ...BH, lat: 'abc' }), null);
  assert.equal(lerEscolhaDaLista({ ...BH, lat: 91 }), null);
  assert.equal(lerEscolhaDaLista({ ...BH, lng: -181 }), null);
  assert.equal(lerEscolhaDaLista({ ...BH, lat: undefined }), null);
  assert.equal(lerEscolhaDaLista({ ...BH, cidade: '   ' }), null);
  assert.equal(lerEscolhaDaLista(null), null);
});

test('escolha da lista: a coordenada sai arredondada a 2 casas (~1 km), como o Nominatim sempre saiu', () => {
  const e = lerEscolhaDaLista({ ...BH, lat: -23.550519, lng: -46.633309 });
  assert.equal(e.lat, -23.55);
  assert.equal(e.lng, -46.63);
});

// ─── a regra completa ─────────────────────────────────────────────────────────
test('1 · cidade da lista: a coordenada é a da lista e o Nominatim NÃO é chamado', async () => {
  const { geocodar, chamadas } = geocodarFalso();
  const r = await resolverCidade(BH, { geocodar });
  assert.equal(chamadas.length, 0);
  assert.deepEqual(r.geo, { lat: -19.92, lng: -43.94 });
  assert.equal(r.cidade, 'Belo Horizonte, MG');
  assert.equal(r.normalizada, 'belo horizonte', 'a normalizada é a do NOME, sem a UF');
  assert.deepEqual(r.info, { encontrada: true, nomeOficial: 'Belo Horizonte, MG' });
  const pt = await resolverCidade(LISBOA, { geocodar });
  assert.equal(chamadas.length, 0);
  assert.deepEqual(pt.geo, { lat: 38.72, lng: -9.14 });
  assert.equal(pt.cidade, 'Lisboa, Portugal');
});

test('2 · fora da lista, o Nominatim acha: guarda o ponto e devolve "Encontramos: <nome oficial>"', async () => {
  const { geocodar, chamadas } = geocodarFalso({ Kyoto: { lat: 35.01, lng: 135.77, nomeOficial: 'Kyoto, Kyoto Prefecture' } });
  const r = await resolverCidade({ cidade: ' Kyoto ' }, { geocodar });
  assert.deepEqual(chamadas, ['Kyoto'], 'chama com o texto aparado');
  assert.deepEqual(r.geo, { lat: 35.01, lng: 135.77 });
  assert.equal(r.cidade, 'Kyoto');
  assert.equal(r.normalizada, 'kyoto');
  assert.deepEqual(r.info, { encontrada: true, nomeOficial: 'Kyoto, Kyoto Prefecture' });
});

test('2 · Nominatim acha mas sem nome oficial: cai no texto digitado', async () => {
  const { geocodar } = geocodarFalso({ Kyoto: { lat: 35.01, lng: 135.77 } });
  const r = await resolverCidade({ cidade: 'Kyoto' }, { geocodar });
  assert.deepEqual(r.info, { encontrada: true, nomeOficial: 'Kyoto' });
});

test('3 · nada achou: guarda o TEXTO mesmo assim, sem ponto, e diz { encontrada: false }', async () => {
  const { geocodar } = geocodarFalso();
  const r = await resolverCidade({ cidade: 'Vila Xyzzy' }, { geocodar });
  assert.equal(r.geo, null);
  assert.equal(r.cidade, 'Vila Xyzzy');
  assert.equal(r.normalizada, 'vila xyzzy');
  assert.deepEqual(r.info, { encontrada: false });
});

test('escolha inválida (origem "lista" sem coordenada) cai no caminho do texto livre', async () => {
  const { geocodar, chamadas } = geocodarFalso({ 'Belo Horizonte': { lat: -19.92, lng: -43.94, nomeOficial: 'Belo Horizonte, Minas Gerais' } });
  const r = await resolverCidade({ cidade: 'Belo Horizonte', origem: 'lista', pais: 'BR' }, { geocodar });
  assert.deepEqual(chamadas, ['Belo Horizonte']);
  assert.equal(r.info.nomeOficial, 'Belo Horizonte, Minas Gerais');
});

test('sem cidade: nada a guardar, nada a geocodificar', async () => {
  const { geocodar, chamadas } = geocodarFalso();
  for (const corpo of [{}, { cidade: '' }, { cidade: '   ' }, null]) {
    const r = await resolverCidade(corpo, { geocodar });
    assert.equal(r.vazia, true);
    assert.equal(r.cidade, null);
    assert.equal(r.geo, null);
    assert.equal(r.info, null);
  }
  assert.equal(chamadas.length, 0);
});

// ─── casamento por texto no Explorar ──────────────────────────────────────────
test('Explorar: time SEM ponto casa pela cidade normalizada IGUAL à busca normalizada', () => {
  const time = { cidade: 'Brasília', cidade_normalizada: 'brasilia', geo_lat: null, geo_lng: null };
  for (const busca of ['Brasília', 'brasilia', 'BRASILIA', '  Brasília  ']) assert.equal(timeCasaPorCidade(time, busca), true, busca);
});

test('Explorar: "exatamente" — pedaço da cidade, outra cidade ou busca vazia não casam', () => {
  const time = { cidade_normalizada: 'sao paulo', geo_lat: null, geo_lng: null };
  assert.equal(timeCasaPorCidade(time, 'sao'), false);
  assert.equal(timeCasaPorCidade(time, 'sao paulo capital'), false);
  assert.equal(timeCasaPorCidade(time, 'campinas'), false);
  assert.equal(timeCasaPorCidade(time, ''), false);
  assert.equal(timeCasaPorCidade(time, '   '), false);
});

test('Explorar: time COM ponto não casa por texto (a distância é que manda) e time sem texto nunca casa', () => {
  assert.equal(timeCasaPorCidade({ cidade_normalizada: 'brasilia', geo_lat: -15.78, geo_lng: -47.93 }, 'brasilia'), false);
  assert.equal(timeCasaPorCidade({ cidade_normalizada: 'brasilia', geo_lat: null, geo_lng: -47.93 }, 'brasilia'), true, 'meio ponto não serve à distância (o app pede os dois): casa pelo texto');
  assert.equal(timeCasaPorCidade({ cidade_normalizada: null, geo_lat: null, geo_lng: null }, 'brasilia'), false);
  assert.equal(timeCasaPorCidade({}, 'brasilia'), false);
  assert.equal(timeCasaPorCidade(null, 'brasilia'), false);
});

test('filtro do banco: a condição do .or() é a mesma regra (texto normalizado + sem ponto), com o valor citado', () => {
  assert.equal(condicaoPorCidade('Brasília'), ',and(cidade_normalizada.eq.brasilia,geo_lat.is.null)');
  assert.equal(condicaoPorCidade('  SÃO   Paulo '), ',and(cidade_normalizada.eq.sao paulo,geo_lat.is.null)');
  assert.equal(condicaoPorCidade('Olho d\'Água', (v) => `"${v}"`), ',and(cidade_normalizada.eq."olho d\'agua",geo_lat.is.null)');
  assert.equal(condicaoPorCidade(''), '');
  assert.equal(condicaoPorCidade('   '), '');
});

// ─── o nome oficial do Nominatim ──────────────────────────────────────────────
test('nome oficial do Nominatim: o lugar e a região — nunca a morada', () => {
  assert.equal(nomeOficialDoNominatim({ name: 'Brasília', address: { state: 'Distrito Federal', country: 'Brasil' }, display_name: 'Brasília, Região Geral de Brasília, Distrito Federal, Brasil' }), 'Brasília, Distrito Federal');
  assert.equal(nomeOficialDoNominatim({ name: 'Porto', address: { country: 'Portugal' } }), 'Porto, Portugal');
  assert.equal(nomeOficialDoNominatim({ address: { town: 'Sintra', county: 'Lisboa' } }), 'Sintra, Lisboa');
  assert.equal(nomeOficialDoNominatim({ display_name: 'Kyoto, Japan' }), 'Kyoto');
  assert.equal(nomeOficialDoNominatim({}), null);
  assert.equal(nomeOficialDoNominatim(null), null);
});
