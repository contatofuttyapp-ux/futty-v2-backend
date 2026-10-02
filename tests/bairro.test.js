// Futty v2.0 — RODADA 29H (item 12 e 44): o BAIRRO do time e os dois prêmios do time (sem banco, sem rede).
//
// Supabase falso em memória + Nominatim falso (injetado no cache de módulos antes de routes/teams.js carregar). Prova:
//   · resolverBairro (puro): achou perto da cidade → o ponto é o do bairro; achou LONGE (mesmo nome em outro estado) ou não
//     achou → fica o da cidade; freguesia da lista (Portugal) → coordenada da lista, sem chamar o Nominatim; sem bairro ou sem
//     cidade → nada;
//   · POST /api/teams com bairro: ponto do bairro gravado, `bairro` e `bairro_normalizado`, resposta { encontrado, nomeOficial };
//   · PATCH: bairro novo geocodifica UMA vez; igual ao de antes não geocodifica; vazio devolve o ponto da cidade;
//   · migração 073 por aplicar: o time NASCE do mesmo jeito (a resposta diz `salvo: false`) e o PATCH responde 503 "ainda não
//     está disponível" em vez de fingir;
//   · prêmios do time: POST/PATCH gravam mostrar_artilheiro/mostrar_destaque; GET /api/teams/:slug devolve os dois (padrão ligado)
//     e continua de pé sem a migração.
//
// Uso: npm test  (ou: node --test tests/bairro.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir, injetar } = require('./_rotas');
const { resolverBairro, distanciaKm, RAIO_DO_BAIRRO_KM } = require('../utils/cidade');

const DONO = '33333333-3333-3333-3333-333333333333';
const TIME = '11111111-1111-1111-1111-111111111111';
const BH = { cidade: 'Belo Horizonte', uf: 'MG', pais: 'BR', lat: -19.92, lng: -43.94, origem: 'lista' };
const SAVASSI = { lat: -19.94, lng: -43.93 }; // a ~2 km do centro de BH
const SAVASSI_DE_OUTRO_ESTADO = { lat: -23.55, lng: -46.63 }; // São Paulo: ~490 km
const SEM_073 = { message: 'column "bairro" of relation "teams" does not exist' };

// ─── resolverBairro (puro) ────────────────────────────────────────────────────
function geocodarFalso(respostas = {}) {
  const chamadas = [];
  const geocodar = async (texto) => { chamadas.push(texto); return respostas[texto] ?? null; };
  return { geocodar, chamadas };
}
const CIDADE_BH = { cidade: 'Belo Horizonte, MG', geo: { lat: -19.92, lng: -43.94 } };

test('distanciaKm: BH → Savassi ≈ 2 km; BH → São Paulo ≈ 490 km', () => {
  assert.ok(distanciaKm({ lat: -19.92, lng: -43.94 }, SAVASSI) < 5);
  const sp = distanciaKm({ lat: -19.92, lng: -43.94 }, SAVASSI_DE_OUTRO_ESTADO);
  assert.ok(sp > 400 && sp < 600, String(sp));
  assert.ok(RAIO_DO_BAIRRO_KM < 100);
});

test('resolverBairro: achou perto da cidade → o ponto é o do bairro, "bairro, cidade" no aviso; geocodifica UMA vez', async () => {
  const { geocodar, chamadas } = geocodarFalso({ 'Savassi, Belo Horizonte, MG': SAVASSI });
  const r = await resolverBairro({ bairro: '  Savassi ' }, CIDADE_BH, { geocodar });
  assert.deepEqual(r.geo, SAVASSI);
  assert.equal(r.bairro, 'Savassi');
  assert.equal(r.normalizado, 'savassi');
  assert.deepEqual(r.info, { encontrado: true, nomeOficial: 'Savassi, Belo Horizonte, MG' });
  assert.deepEqual(chamadas, ['Savassi, Belo Horizonte, MG']);
});

test('resolverBairro: achou LONGE da cidade (mesmo nome em outro estado) não vale — fica o ponto da cidade e o aviso diz que não achou', async () => {
  const { geocodar } = geocodarFalso({ 'Vila Nova, Belo Horizonte, MG': SAVASSI_DE_OUTRO_ESTADO });
  const r = await resolverBairro({ bairro: 'Vila Nova' }, CIDADE_BH, { geocodar });
  assert.equal(r.geo, null);
  assert.deepEqual(r.info, { encontrado: false });
  assert.equal(r.bairro, 'Vila Nova', 'o texto fica guardado mesmo assim');
});

test('resolverBairro: não achou → sem ponto, o texto fica; cidade sem ponto aceita o que o Nominatim der', async () => {
  const { geocodar } = geocodarFalso({ 'Xyz, Cidadezinha': SAVASSI });
  assert.deepEqual((await resolverBairro({ bairro: 'Abc' }, CIDADE_BH, { geocodar })).info, { encontrado: false });
  const r = await resolverBairro({ bairro: 'Xyz' }, { cidade: 'Cidadezinha', geo: null }, { geocodar });
  assert.deepEqual(r.geo, SAVASSI, 'sem ponto da cidade não há com o que comparar a distância');
});

test('resolverBairro: freguesia escolhida na lista (Portugal) traz a coordenada — nenhuma chamada ao Nominatim', async () => {
  const { geocodar, chamadas } = geocodarFalso();
  const lisboa = { cidade: 'Lisboa, Portugal', geo: { lat: 38.72, lng: -9.14 } };
  const r = await resolverBairro({ bairro: 'Alvalade', bairro_origem: 'lista', bairro_lat: 38.7523, bairro_lng: -9.1451 }, lisboa, { geocodar });
  assert.deepEqual(r.geo, { lat: 38.75, lng: -9.15 }, 'arredondado a 2 casas (~1 km)');
  assert.deepEqual(r.info, { encontrado: true, nomeOficial: 'Alvalade, Lisboa, Portugal' });
  assert.deepEqual(chamadas, []);
  // coordenada fora de Portugal não vale como "da lista": vai ao Nominatim como texto livre
  const falsa = await resolverBairro({ bairro: 'Alvalade', bairro_origem: 'lista', bairro_lat: -19.9, bairro_lng: -43.9 }, lisboa, { geocodar });
  assert.deepEqual(chamadas, ['Alvalade, Lisboa, Portugal']);
  assert.equal(falsa.geo, null);
});

test('resolverBairro: sem bairro, ou sem cidade onde pôr um, não faz nada (e não chama a rede)', async () => {
  const { geocodar, chamadas } = geocodarFalso();
  for (const [corpo, cidade] of [[{}, CIDADE_BH], [{ bairro: '   ' }, CIDADE_BH], [{ bairro: 'Savassi' }, { cidade: null, geo: null }], [{ bairro: 'Savassi' }, null]]) {
    const r = await resolverBairro(corpo, cidade, { geocodar });
    assert.deepEqual([r.bairro, r.geo, r.info, r.vazio], [null, null, null, true]);
  }
  assert.deepEqual(chamadas, []);
});

// ─── as rotas ─────────────────────────────────────────────────────────────────
function cenario(t, { respostas = {}, teams = [], falhar = null } = {}) {
  const { geocodar, chamadas } = geocodarFalso(respostas);
  const restaurar = injetar('utils/geocode', { geocodar, nomeOficialDoNominatim: () => null });
  const { carregados, tabelas } = carregar({
    teams,
    users: [{ id: DONO, nome: 'Dono' }],
    team_members: teams.length ? [{ team_id: TIME, user_id: DONO, role: 'admin' }] : [],
  }, ['routes/teams'], { falhar });
  restaurar();
  return { pedir: subir([carregados['routes/teams']], t), tabelas, chamadas };
}
const TIME_SP = { id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde' };
const TIME_BH = { ...TIME_SP, cidade: 'Belo Horizonte, MG', cidade_normalizada: 'belo horizonte', geo_lat: -19.92, geo_lng: -43.94, bairro: null, bairro_normalizado: null };

test('POST /api/teams com cidade da lista + bairro achado: o ponto do time é o do bairro e o motor diz "Encontramos"', async (t) => {
  const { pedir, tabelas, chamadas } = cenario(t, { respostas: { 'Savassi, Belo Horizonte, MG': SAVASSI } });
  const r = await pedir('POST', '/api/teams', { nome: 'Savassi FC', ...BH, bairro: 'Savassi' }, DONO);
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.bairro, { encontrado: true, nomeOficial: 'Savassi, Belo Horizonte, MG' });
  assert.deepEqual(r.json.geo, { encontrada: true, nomeOficial: 'Belo Horizonte, MG' });
  const time = tabelas.teams[0];
  assert.deepEqual([time.geo_lat, time.geo_lng], [SAVASSI.lat, SAVASSI.lng]);
  assert.deepEqual([time.bairro, time.bairro_normalizado], ['Savassi', 'savassi']);
  assert.deepEqual(chamadas, ['Savassi, Belo Horizonte, MG'], 'UMA chamada ao Nominatim, só do bairro (a cidade veio da lista)');
});

test('POST: bairro que ninguém acha → o time fica com o ponto da CIDADE, o texto do bairro guardado, e o motor diz que não achou', async (t) => {
  const { pedir, tabelas } = cenario(t);
  const r = await pedir('POST', '/api/teams', { nome: 'Savassi FC', ...BH, bairro: 'Bairro Inventado' }, DONO);
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.bairro, { encontrado: false });
  assert.deepEqual([tabelas.teams[0].geo_lat, tabelas.teams[0].geo_lng], [BH.lat, BH.lng]);
  assert.equal(tabelas.teams[0].bairro, 'Bairro Inventado');
});

test('POST: sem bairro nada muda (nenhuma chamada extra, nenhuma coluna nova no insert, resposta sem `bairro`)', async (t) => {
  const { pedir, tabelas, chamadas } = cenario(t);
  const r = await pedir('POST', '/api/teams', { nome: 'Sem Bairro FC', ...BH }, DONO);
  assert.equal(r.status, 201);
  assert.equal('bairro' in r.json, false);
  assert.equal('bairro' in tabelas.teams[0], false);
  assert.equal('mostrar_artilheiro' in tabelas.teams[0], false);
  assert.deepEqual(chamadas, []);
});

test('POST sem a migração 073: o time nasce igual e a resposta diz `salvo: false` — nada de bairro gravado', async (t) => {
  const falhar = (tabela, op, e) => (tabela === 'teams' && op === 'insert' && e.linhas.some((l) => 'bairro' in l) ? SEM_073 : null);
  const { pedir, tabelas } = cenario(t, { respostas: { 'Savassi, Belo Horizonte, MG': SAVASSI }, falhar });
  const r = await pedir('POST', '/api/teams', { nome: 'Savassi FC', ...BH, bairro: 'Savassi' }, DONO);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual(r.json.bairro, { encontrado: true, nomeOficial: 'Savassi, Belo Horizonte, MG', salvo: false });
  assert.equal(tabelas.teams.length, 1);
  assert.equal('bairro' in tabelas.teams[0], false);
  assert.ok(tabelas.teams[0].geo_lat != null, 'a cidade (o ponto) continua valendo');
});

// ─── PATCH ────────────────────────────────────────────────────────────────────
test('PATCH bairro novo: geocodifica UMA vez e o ponto passa a ser o do bairro', async (t) => {
  const { pedir, tabelas, chamadas } = cenario(t, { teams: [{ ...TIME_BH }], respostas: { 'Savassi, Belo Horizonte, MG': SAVASSI } });
  const r = await pedir('PATCH', '/api/teams/varzea-fc', { cidade: 'Belo Horizonte, MG', bairro: 'Savassi' }, DONO);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.bairro, { encontrado: true, nomeOficial: 'Savassi, Belo Horizonte, MG' });
  assert.deepEqual([tabelas.teams[0].geo_lat, tabelas.teams[0].geo_lng], [SAVASSI.lat, SAVASSI.lng]);
  assert.equal(tabelas.teams[0].bairro_normalizado, 'savassi');
  assert.ok(chamadas.includes('Savassi, Belo Horizonte, MG'));
});

test('PATCH com o mesmo bairro e a mesma cidade (o painel reenvia a cada "Salvar"): não geocodifica de novo nem mexe no ponto', async (t) => {
  const noBairro = { ...TIME_BH, bairro: 'Savassi', bairro_normalizado: 'savassi', geo_lat: SAVASSI.lat, geo_lng: SAVASSI.lng };
  const { pedir, tabelas, chamadas } = cenario(t, { teams: [noBairro] });
  const r = await pedir('PATCH', '/api/teams/varzea-fc', { cidade: 'Belo Horizonte, MG', bairro: 'SAVASSI', nome: 'Outro Nome' }, DONO);
  assert.equal(r.status, 200);
  assert.deepEqual(chamadas, []);
  assert.deepEqual([tabelas.teams[0].geo_lat, tabelas.teams[0].geo_lng], [SAVASSI.lat, SAVASSI.lng]);
  assert.equal('bairro' in r.json, false);
});

test('PATCH com o bairro vazio: o bairro sai e o ponto volta a ser o da CIDADE', async (t) => {
  const noBairro = { ...TIME_BH, bairro: 'Savassi', bairro_normalizado: 'savassi', geo_lat: SAVASSI.lat, geo_lng: SAVASSI.lng };
  const { pedir, tabelas } = cenario(t, { teams: [noBairro], respostas: { 'Belo Horizonte, MG': { lat: -19.92, lng: -43.94 } } });
  const r = await pedir('PATCH', '/api/teams/varzea-fc', { cidade: 'Belo Horizonte, MG', bairro: '' }, DONO);
  assert.equal(r.status, 200);
  assert.deepEqual([tabelas.teams[0].bairro, tabelas.teams[0].bairro_normalizado], [null, null]);
  assert.deepEqual([tabelas.teams[0].geo_lat, tabelas.teams[0].geo_lng], [-19.92, -43.94]);
});

test('PATCH trocando a CIDADE junto com o bairro: o bairro é procurado na cidade NOVA', async (t) => {
  const { pedir, tabelas, chamadas } = cenario(t, { teams: [{ ...TIME_BH }], respostas: { 'Pinheiros, São Paulo, SP': { lat: -23.57, lng: -46.69 } } });
  const sp = { cidade: 'São Paulo', uf: 'SP', pais: 'BR', lat: -23.55, lng: -46.63, origem: 'lista' };
  const r = await pedir('PATCH', '/api/teams/varzea-fc', { ...sp, bairro: 'Pinheiros' }, DONO);
  assert.equal(r.status, 200);
  assert.deepEqual(chamadas, ['Pinheiros, São Paulo, SP']);
  assert.deepEqual([tabelas.teams[0].geo_lat, tabelas.teams[0].geo_lng], [-23.57, -46.69]);
});

test('PATCH sem a migração 073: bairro e prêmios respondem 503 "ainda não está disponível" (nada é fingido)', async (t) => {
  const falhar = (tabela, op, e) => (tabela === 'teams' && ((op === 'update' && ('bairro' in e.patch || 'mostrar_artilheiro' in e.patch)) || (op === 'select' && /bairro_normalizado/.test(e.cols || ''))) ? SEM_073 : null);
  const { pedir } = cenario(t, { teams: [{ ...TIME_BH }], falhar });
  const a = await pedir('PATCH', '/api/teams/varzea-fc', { cidade: 'Belo Horizonte, MG', bairro: 'Savassi' }, DONO);
  assert.equal(a.status, 503);
  assert.match(a.json.error, /ainda não está disponível/);
  const b = await pedir('PATCH', '/api/teams/varzea-fc', { mostrar_artilheiro: false }, DONO);
  assert.equal(b.status, 503);
});

// ─── os prêmios do time ───────────────────────────────────────────────────────
test('prêmios: POST grava só o que foi desligado; PATCH liga e desliga cada um sem mexer no outro', async (t) => {
  const { pedir, tabelas } = cenario(t);
  const r = await pedir('POST', '/api/teams', { nome: 'Sem Troféu FC', mostrar_artilheiro: false }, DONO);
  assert.equal(r.status, 201);
  assert.equal(tabelas.teams[0].mostrar_artilheiro, false);
  assert.equal('mostrar_destaque' in tabelas.teams[0], false, 'padrão ligado: nem vai no insert');
  const p = await pedir('PATCH', `/api/teams/${tabelas.teams[0].slug}`, { mostrar_destaque: false }, DONO);
  assert.equal(p.status, 200);
  assert.deepEqual([tabelas.teams[0].mostrar_artilheiro, tabelas.teams[0].mostrar_destaque], [false, false]);
  await pedir('PATCH', `/api/teams/${tabelas.teams[0].slug}`, { mostrar_artilheiro: true }, DONO);
  assert.deepEqual([tabelas.teams[0].mostrar_artilheiro, tabelas.teams[0].mostrar_destaque], [true, false]);
});

test('POST pedindo prêmios desligados sem a migração 073: o time nasce e a resposta diz `premios_salvos: false`', async (t) => {
  const falhar = (tabela, op, e) => (tabela === 'teams' && op === 'insert' && e.linhas.some((l) => 'mostrar_artilheiro' in l) ? { message: 'column "mostrar_artilheiro" of relation "teams" does not exist' } : null);
  const { pedir, tabelas } = cenario(t, { falhar });
  const r = await pedir('POST', '/api/teams', { nome: 'Sem Troféu FC', mostrar_artilheiro: false }, DONO);
  assert.equal(r.status, 201);
  assert.equal(r.json.premios_salvos, false);
  assert.equal(tabelas.teams.length, 1);
});

test('GET /api/teams/:slug devolve bairro e os dois prêmios (padrão ligado) — e continua de pé sem a migração 073', async (t) => {
  const completo = cenario(t, { teams: [{ ...TIME_BH, bairro: 'Savassi', mostrar_artilheiro: false }] });
  const a = await completo.pedir('GET', '/api/teams/varzea-fc', null, DONO);
  assert.equal(a.status, 200);
  assert.deepEqual([a.json.team.bairro, a.json.team.mostrar_artilheiro, a.json.team.mostrar_destaque], ['Savassi', false, true]);
  // sem a migração: o select com as colunas novas volta vazio (coluna inexistente) e a página do time cai para as colunas de sempre
  const falhar = (tabela, op, e) => (tabela === 'teams' && op === 'select' && /mostrar_artilheiro/.test(e.cols || '') ? SEM_073 : null);
  const antigo = cenario(t, { teams: [{ ...TIME_BH }], falhar });
  const b = await antigo.pedir('GET', '/api/teams/varzea-fc', null, DONO);
  assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.deepEqual([b.json.team.bairro, b.json.team.mostrar_artilheiro, b.json.team.mostrar_destaque], [null, true, true]);
  const inexistente = await antigo.pedir('GET', '/api/teams/nao-existe', null, DONO);
  assert.equal(inexistente.status, 404);
});
