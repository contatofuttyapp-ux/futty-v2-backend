// Futty v2.0 — RODADA 29B (D): POST /api/teams e PATCH /api/teams/:slug com a cidade da lista (sem banco, sem rede).
//
// Supabase falso em memória + Nominatim falso, injetados no cache de módulos antes de routes/teams.js ser carregado
// (o mesmo truque de tests/convite-rota.test.js). Prova:
//   · origem "lista" → a coordenada da lista é gravada (arredondada) e o Nominatim NÃO é chamado;
//   · sem origem → Nominatim; achou: { encontrada: true, nomeOficial }; não achou: o texto fica, sem ponto, { encontrada: false };
//   · `cidade_normalizada` gravada junto (sem acento/maiúscula/espaço duplo);
//   · PATCH: cidade igual à de antes não geocodifica nem apaga o ponto; vazia limpa tudo;
//   · migração 066 por aplicar (coluna ausente): o time nasce e edita do mesmo jeito, só sem a coluna nova.
//
// Uso: npm test  (ou: node --test tests/teams-cidade-rota.test.js)
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { criarSupabaseFalso } = require('./_supabaseFalso');

const DONO = '33333333-3333-3333-3333-333333333333';
const MEMBRO = '44444444-4444-4444-4444-444444444444';
const TIME = '11111111-1111-1111-1111-111111111111';
const BH = { cidade: 'Belo Horizonte', uf: 'MG', pais: 'BR', lat: -19.9191, lng: -43.9386, origem: 'lista' };

function injetar(caminho, exports) {
  const antigo = require.cache[caminho];
  require.cache[caminho] = { id: caminho, filename: caminho, loaded: true, path: path.dirname(caminho), children: [], paths: [], exports };
  return () => { if (antigo) require.cache[caminho] = antigo; else delete require.cache[caminho]; };
}

async function montar({ teams = [], respostasNominatim = {}, falhar = null } = {}, t) {
  const { cliente, tabelas } = criarSupabaseFalso({
    teams,
    users: [{ id: DONO, nome: 'Dono' }],
    team_members: teams.length ? [{ team_id: TIME, user_id: DONO, role: 'admin' }, { team_id: TIME, user_id: MEMBRO, role: 'member' }] : [],
  }, { falhar });

  const chamadasNominatim = [];
  const geocodarFalso = async (texto) => { chamadasNominatim.push(texto); return respostasNominatim[texto] ?? null; };

  const caminhoDb = require.resolve('../utils/db');
  const caminhoGeocode = require.resolve('../utils/geocode');
  const caminhoNsfw = require.resolve('../utils/nsfwFilter');
  const caminhoAuth = require.resolve('../middleware/auth');
  const caminhoCidade = require.resolve('../utils/cidade');
  const caminhoAlvo = require.resolve('../routes/teams');

  const getRole = async (teamId, userId) => {
    const { data } = await cliente.from('team_members').select('role').eq('team_id', teamId).eq('user_id', userId).maybeSingle();
    return data?.role || null;
  };
  const getTeamBySlug = async (slug) => {
    const { data } = await cliente.from('teams').select('*').eq('slug', slug).maybeSingle();
    return data;
  };
  const passaAdiante = (_req, _res, next) => next();
  const { HttpError } = require('../utils/http');
  // A autenticação de mentira: quem manda `x-teste-usuario` é esse usuário; sem ele, 401.
  const exigirLogin = (req, _res, next) => {
    const quem = req.get('x-teste-usuario');
    if (!quem) return next(new HttpError(401, 'Sem sessão.'));
    req.user = { id: quem, email: `${quem}@futtymock.com` };
    return next();
  };

  const restaurar = [
    injetar(caminhoDb, {
      supabase: cliente, getRole, getTeamBySlug, ensureUserRow: async () => {},
      requireTeamMember: async () => { throw new Error('não usado aqui'); },
    }),
    injetar(caminhoGeocode, { geocodar: geocodarFalso, nomeOficialDoNominatim: () => null }),
    injetar(caminhoNsfw, { filtroNSFWFailClosed: passaAdiante, filtroNSFW: passaAdiante }),
    injetar(caminhoAuth, { requireAuth: exigirLogin, optionalAuth: passaAdiante }),
  ];
  delete require.cache[caminhoCidade];
  delete require.cache[caminhoAlvo];
  // eslint-disable-next-line global-require
  const router = require('../routes/teams');
  delete require.cache[caminhoAlvo];
  delete require.cache[caminhoCidade];
  for (const r of restaurar) r();

  const app = express();
  app.use(express.json());
  app.use(router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const servidor = app.listen(0);
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const pedir = async (metodo, rota, corpo, usuario = DONO) => {
    const r = await fetch(`${base}${rota}`, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...(usuario ? { 'x-teste-usuario': usuario } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, json: await r.json() };
  };
  const time = () => (tabelas.teams || []).find((x) => x.slug !== undefined);
  return { pedir, tabelas, chamadasNominatim, time };
}

const TIME_COM_PONTO = { id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde', cidade: 'Brasília', cidade_normalizada: 'brasilia', geo_lat: -15.78, geo_lng: -47.93 };

// ─── POST /api/teams ──────────────────────────────────────────────────────────
test('POST com cidade da lista: grava a coordenada da lista (arredondada) e NÃO chama o Nominatim', async (t) => {
  const { pedir, chamadasNominatim, time } = await montar({}, t);
  const { status, json } = await pedir('POST', '/api/teams', { nome: 'Time da Lista', cidade: 'Belo Horizonte', uf: 'MG', pais: 'BR', lat: -19.9191, lng: -43.9386, origem: 'lista' });
  assert.equal(status, 201);
  assert.equal(chamadasNominatim.length, 0, 'cidade da lista é instantânea: nenhuma chamada externa');
  assert.equal(time().cidade, 'Belo Horizonte, MG');
  assert.equal(time().cidade_normalizada, 'belo horizonte');
  assert.equal(time().geo_lat, -19.92);
  assert.equal(time().geo_lng, -43.94);
  assert.deepEqual(json.geo, { encontrada: true, nomeOficial: 'Belo Horizonte, MG' });
  assert.equal(json.team.cidade, 'Belo Horizonte, MG');
});

test('POST com concelho de Portugal: "Lisboa, Portugal" e o ponto da lista', async (t) => {
  const { pedir, chamadasNominatim, time } = await montar({}, t);
  const { json } = await pedir('POST', '/api/teams', { nome: 'Time de Lisboa', cidade: 'Lisboa', uf: 'Lisboa', pais: 'PT', lat: 38.7223, lng: -9.1393, origem: 'lista' });
  assert.equal(chamadasNominatim.length, 0);
  assert.equal(time().cidade, 'Lisboa, Portugal');
  assert.equal(time().geo_lat, 38.72);
  assert.deepEqual(json.geo, { encontrada: true, nomeOficial: 'Lisboa, Portugal' });
});

test('POST com cidade fora da lista que o Nominatim acha: guarda o ponto e devolve o nome oficial', async (t) => {
  const { pedir, chamadasNominatim, time } = await montar({ respostasNominatim: { Kyoto: { lat: 35.01, lng: 135.77, nomeOficial: 'Kyoto, Kyoto Prefecture' } } }, t);
  const { json } = await pedir('POST', '/api/teams', { nome: 'Time de Kyoto', cidade: 'Kyoto' });
  assert.deepEqual(chamadasNominatim, ['Kyoto']);
  assert.equal(time().geo_lat, 35.01);
  assert.equal(time().cidade_normalizada, 'kyoto');
  assert.deepEqual(json.geo, { encontrada: true, nomeOficial: 'Kyoto, Kyoto Prefecture' });
});

test('POST com cidade que ninguém acha: o time nasce, guarda o TEXTO e devolve { encontrada: false }', async (t) => {
  const { pedir, time } = await montar({}, t);
  const { status, json } = await pedir('POST', '/api/teams', { nome: 'Time Perdido', cidade: '  Vila  XYZZY ' });
  assert.equal(status, 201);
  assert.equal(time().cidade, 'Vila  XYZZY', 'o texto fica como a pessoa escreveu (aparado)');
  assert.equal(time().cidade_normalizada, 'vila xyzzy');
  assert.equal(time().geo_lat, null);
  assert.equal(time().geo_lng, null);
  assert.deepEqual(json.geo, { encontrada: false });
});

test('POST sem cidade: nada de geocodificar e nenhuma `geo` na resposta', async (t) => {
  const { pedir, chamadasNominatim, time } = await montar({}, t);
  const { status, json } = await pedir('POST', '/api/teams', { nome: 'Time Sem Cidade' });
  assert.equal(status, 201);
  assert.equal(chamadasNominatim.length, 0);
  assert.equal(time().cidade, null);
  assert.equal(time().cidade_normalizada, null);
  assert.ok(!('geo' in json));
});

test('POST com origem "lista" mas sem coordenada válida é tratado como texto digitado (Nominatim)', async (t) => {
  const { pedir, chamadasNominatim } = await montar({}, t);
  await pedir('POST', '/api/teams', { nome: 'Time Torto', cidade: 'Belo Horizonte', pais: 'BR', origem: 'lista', lat: 'x', lng: 'y' });
  assert.deepEqual(chamadasNominatim, ['Belo Horizonte']);
});

test('POST com a migração 066 por aplicar: o time nasce igual, com o texto e o ponto, só sem a coluna nova', async (t) => {
  const falhar = (tabela, op, e) => (tabela === 'teams' && op === 'insert' && e.linhas.some((l) => 'cidade_normalizada' in l)
    ? { message: "Could not find the 'cidade_normalizada' column of 'teams' in the schema cache" } : null);
  const { pedir, time } = await montar({ falhar }, t);
  const { status, json } = await pedir('POST', '/api/teams', { nome: 'Time Sem 066', ...BH });
  assert.equal(status, 201);
  assert.equal(time().cidade, 'Belo Horizonte, MG');
  assert.equal(time().geo_lat, -19.92, 'o ponto da lista não se perde por causa da coluna que falta');
  assert.ok(!('cidade_normalizada' in time()));
  assert.equal(json.geo.encontrada, true);
});

test('POST sem sessão: 401 (a cidade não muda isso)', async (t) => {
  const { pedir } = await montar({}, t);
  const { status } = await pedir('POST', '/api/teams', { nome: 'X', ...BH }, null);
  assert.equal(status, 401);
});

// ─── PATCH /api/teams/:slug ───────────────────────────────────────────────────
test('PATCH com cidade da lista: troca o texto e o ponto pelos da lista, sem chamar o Nominatim', async (t) => {
  const { pedir, chamadasNominatim, tabelas } = await montar({ teams: [{ ...TIME_COM_PONTO }] }, t);
  const { status, json } = await pedir('PATCH', '/api/teams/varzea-fc', { cidade: 'Belo Horizonte', uf: 'MG', pais: 'BR', lat: -19.9191, lng: -43.9386, origem: 'lista' });
  assert.equal(status, 200);
  assert.equal(chamadasNominatim.length, 0);
  const linha = tabelas.teams[0];
  assert.equal(linha.cidade, 'Belo Horizonte, MG');
  assert.equal(linha.cidade_normalizada, 'belo horizonte');
  assert.equal(linha.geo_lat, -19.92);
  assert.deepEqual(json.geo, { encontrada: true, nomeOficial: 'Belo Horizonte, MG' });
});

test('PATCH com cidade que ninguém acha: guarda o texto e LIMPA o ponto (o de antes era de outra cidade)', async (t) => {
  const { pedir, tabelas } = await montar({ teams: [{ ...TIME_COM_PONTO }] }, t);
  const { json } = await pedir('PATCH', '/api/teams/varzea-fc', { cidade: 'Vila Xyzzy' });
  const linha = tabelas.teams[0];
  assert.equal(linha.cidade, 'Vila Xyzzy');
  assert.equal(linha.cidade_normalizada, 'vila xyzzy');
  assert.equal(linha.geo_lat, null);
  assert.equal(linha.geo_lng, null);
  assert.deepEqual(json.geo, { encontrada: false });
});

test('PATCH com a MESMA cidade de antes (o painel reenvia o campo): não geocodifica e não apaga o ponto', async (t) => {
  const { pedir, chamadasNominatim, tabelas } = await montar({ teams: [{ ...TIME_COM_PONTO, cidade_normalizada: null }] }, t);
  const { status, json } = await pedir('PATCH', '/api/teams/varzea-fc', { cidade: ' BRASILIA ', nome: 'Várzea FC Novo' });
  assert.equal(status, 200);
  assert.equal(chamadasNominatim.length, 0);
  const linha = tabelas.teams[0];
  assert.equal(linha.nome, 'Várzea FC Novo');
  assert.equal(linha.cidade, 'Brasília', 'o texto guardado não é tocado');
  assert.equal(linha.geo_lat, -15.78, 'o ponto continua');
  assert.equal(linha.cidade_normalizada, 'brasilia', 'mas a coluna nova se completa em time antigo');
  assert.ok(!('geo' in json));
});

test('PATCH com a cidade vazia: tira o time da busca por distância e por texto', async (t) => {
  const { pedir, tabelas } = await montar({ teams: [{ ...TIME_COM_PONTO }] }, t);
  await pedir('PATCH', '/api/teams/varzea-fc', { cidade: '' });
  const linha = tabelas.teams[0];
  assert.equal(linha.cidade, null);
  assert.equal(linha.cidade_normalizada, null);
  assert.equal(linha.geo_lat, null);
  assert.equal(linha.geo_lng, null);
});

test('PATCH com a migração 066 por aplicar: edita igual, sem a coluna nova', async (t) => {
  const falhar = (tabela, op, e) => (tabela === 'teams' && op === 'update' && 'cidade_normalizada' in (e.patch || {})
    ? { message: "Could not find the 'cidade_normalizada' column of 'teams' in the schema cache" } : null);
  const { pedir, tabelas } = await montar({ teams: [{ ...TIME_COM_PONTO }], falhar }, t);
  const { status } = await pedir('PATCH', '/api/teams/varzea-fc', { ...BH });
  assert.equal(status, 200);
  assert.equal(tabelas.teams[0].cidade, 'Belo Horizonte, MG');
  assert.equal(tabelas.teams[0].geo_lat, -19.92);
});

test('PATCH por quem não é admin: 403 e a cidade não muda', async (t) => {
  const { pedir, tabelas } = await montar({ teams: [{ ...TIME_COM_PONTO }] }, t);
  const { status } = await pedir('PATCH', '/api/teams/varzea-fc', { ...BH }, MEMBRO);
  assert.equal(status, 403);
  assert.equal(tabelas.teams[0].cidade, 'Brasília');
});
