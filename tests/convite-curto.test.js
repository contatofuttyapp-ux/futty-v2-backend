// Futty v2.0 — RODADA 29H (item 7): o link curto do convite, futtyapp.com.br/c/<código> (sem banco, sem rede).
//
// Supabase falso em memória (com o embed `convites ( … )` que o falso aprendeu nesta rodada) por baixo do routes/teams.js.
// Prova:
//   · o código: 8 posições do alfabeto sem 0/o/1/l/i; lerCodigo aceita qualquer caixa e recusa uuid e lixo;
//   · POST /api/teams/:slug/convite devolve { token, codigo }; sem a tabela (migração 072 por aplicar) devolve `codigo: null`
//     e o convite nasce do mesmo jeito;
//   · GET /api/convite/<código> e POST /api/convite/<código>/aceitar chegam ao MESMO convite que o uuid, com o mesmo prazo;
//     o link longo continua válido, igual;
//   · convite expirado pelo código também diz "expirado"; código desconhecido ou com cara de lixo diz "não encontrado";
//   · revogar o convite derruba o código junto (ON DELETE CASCADE — aqui, o falso não cascateia, então prova-se pelo caminho
//     do convite que sumiu: o código aponta para o vazio e responde "não encontrado");
//   · a lista do admin traz o código de cada convite.
//
// Uso: npm test  (ou: node --test tests/convite-curto.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');
const { ALFABETO, TAMANHO, gerarCodigo, lerCodigo, criarCodigo, convitePorParametro } = require('../utils/conviteCodigo');

const TIME = '11111111-1111-1111-1111-111111111111';
const CONVITE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const TOKEN = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const DONO = '33333333-3333-3333-3333-333333333333';
const QUEM_ENTRA = '44444444-4444-4444-4444-444444444444';
const AMANHA = new Date(Date.now() + 86400000).toISOString();
const ONTEM = new Date(Date.now() - 86400000).toISOString();

function cenario(t, { convites, codigos, opcoes = {} } = {}) {
  const { carregados, tabelas, cliente } = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde' }],
    users: [{ id: DONO, nome: 'Antônio', nome_jogador: 'Tonhão' }, { id: QUEM_ENTRA, nome: 'Zeca' }],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin' }],
    games: [],
    convites: convites || [{ id: CONVITE, token: TOKEN, team_id: TIME, criado_por: DONO, expires_at: AMANHA }],
    convite_codigos: codigos || [{ codigo: 'k7m2p9qx', convite_id: CONVITE }],
    convite_usos: [],
  }, ['routes/teams'], opcoes);
  const pedir = subir([carregados['routes/teams']], t);
  return { pedir, tabelas, cliente };
}

// ─── o código ─────────────────────────────────────────────────────────────────
test('gerarCodigo: 8 posições, só do alfabeto (sem 0, o, 1, l, i) e sem repetir em mil sorteios', () => {
  assert.equal(TAMANHO, 8);
  assert.ok(!/[01oli]/.test(ALFABETO), 'o alfabeto não tem os que se confundem');
  const vistos = new Set();
  for (let i = 0; i < 1000; i += 1) {
    const c = gerarCodigo();
    assert.match(c, /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
    vistos.add(c);
  }
  assert.equal(vistos.size, 1000);
});

test('lerCodigo: qualquer caixa e espaços das pontas valem; uuid, token estranho e lixo não são código', () => {
  assert.equal(lerCodigo('K7M2P9QX'), 'k7m2p9qx');
  assert.equal(lerCodigo('  k7m2p9qx '), 'k7m2p9qx');
  assert.equal(lerCodigo('k7m2p9'), 'k7m2p9', '6 posições ainda valem (a leitura aceita 6–8)');
  assert.equal(lerCodigo(TOKEN), null, 'uuid');
  assert.equal(lerCodigo('token-de-teste'), null);
  assert.equal(lerCodigo('k7m2p9q'.replace('k', '0')), null, 'o 0 não existe no alfabeto');
  assert.equal(lerCodigo('k7m2p9qxz'), null, '9 posições');
  assert.equal(lerCodigo(''), null);
  assert.equal(lerCodigo(undefined), null);
});

test('criarCodigo: colisão tenta outro; tabela ausente devolve null sem lançar', async () => {
  const { cliente } = carregar({ convite_codigos: [{ codigo: 'aaaaaaaa', convite_id: 'outro' }] }, []);
  const sequencia = ['aaaaaaaa', 'bbbbbbbb'];
  const codigo = await criarCodigo(cliente, CONVITE, { gerar: () => sequencia.shift() });
  assert.equal(codigo, 'bbbbbbbb', 'a colisão (23505) sorteia de novo');
  const { cliente: semTabela } = carregar({}, [], { falhar: (tabela) => (tabela === 'convite_codigos' ? { code: '42P01', message: 'relation "convite_codigos" does not exist' } : null) });
  const aviso = console.warn; console.warn = () => {};
  try { assert.equal(await criarCodigo(semTabela, CONVITE), null); } finally { console.warn = aviso; }
});

// ─── POST /api/teams/:slug/convite ────────────────────────────────────────────
test('gerar convite devolve o token longo E o código curto, e o código fica apontando para o convite', async (t) => {
  const { pedir, tabelas } = cenario(t, { convites: [], codigos: [] });
  const r = await pedir('POST', '/api/teams/varzea-fc/convite', null, DONO);
  assert.equal(r.status, 201);
  assert.match(r.json.token, /^[0-9a-f-]{36}$/);
  assert.match(r.json.codigo, /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
  const convite = tabelas.convites.find((c) => c.token === r.json.token);
  assert.ok(convite, 'o convite foi gravado');
  assert.equal(tabelas.convite_codigos.find((c) => c.codigo === r.json.codigo)?.convite_id, convite.id);
});

test('sem a migração 072 o convite nasce igual, com `codigo: null` (só o link longo)', async (t) => {
  const aviso = console.warn; console.warn = () => {};
  t.after(() => { console.warn = aviso; });
  const { pedir, tabelas } = cenario(t, {
    convites: [], codigos: [],
    opcoes: { falhar: (tabela, op) => (tabela === 'convite_codigos' && op === 'insert' ? { code: '42P01', message: 'relation "convite_codigos" does not exist' } : null) },
  });
  const r = await pedir('POST', '/api/teams/varzea-fc/convite', null, DONO);
  assert.equal(r.status, 201);
  assert.equal(r.json.codigo, null);
  assert.ok(r.json.token);
  assert.equal(tabelas.convites.length, 1);
});

// ─── GET e aceitar pelo código ────────────────────────────────────────────────
test('GET /api/convite/<código> abre o MESMO convite que o uuid (time, quem convidou, validade)', async (t) => {
  const { pedir } = cenario(t);
  const pelaUuid = await pedir('GET', `/api/convite/${TOKEN}`);
  const peloCodigo = await pedir('GET', '/api/convite/k7m2p9qx');
  assert.equal(pelaUuid.status, 200);
  assert.equal(peloCodigo.status, 200);
  assert.equal(peloCodigo.json.valido, true);
  assert.equal(peloCodigo.json.team.slug, 'varzea-fc');
  assert.equal(peloCodigo.json.convidadoPor, 'Tonhão');
  assert.deepEqual(peloCodigo.json, pelaUuid.json, 'o link curto e o longo mostram exatamente o mesmo convite');
  const maiuscula = await pedir('GET', '/api/convite/K7M2P9QX');
  assert.equal(maiuscula.json.valido, true, 'a caixa não importa');
});

test('o prazo é o do convite: expirado pelo código também diz "expirado" (e mostra o time, para pedir entrada)', async (t) => {
  const { pedir } = cenario(t, { convites: [{ id: CONVITE, token: TOKEN, team_id: TIME, criado_por: DONO, expires_at: ONTEM }] });
  const r = await pedir('GET', '/api/convite/k7m2p9qx');
  assert.equal(r.json.valido, false);
  assert.equal(r.json.motivo, 'expirado');
  assert.equal(r.json.team.slug, 'varzea-fc');
});

test('código desconhecido, com cara de lixo, ou de convite que sumiu: "não encontrado" (200, sem time)', async (t) => {
  const { pedir, tabelas } = cenario(t);
  for (const lixo of ['zzzzzzzz', 'abc', 'k7m2p9qx-1', '00000000']) {
    const r = await pedir('GET', `/api/convite/${lixo}`);
    assert.equal(r.status, 200, lixo);
    assert.deepEqual([r.json.valido, r.json.motivo, r.json.team], [false, 'nao_encontrado', null], lixo);
  }
  tabelas.convites.length = 0; // o admin revogou o convite: o código aponta para o vazio
  const r = await pedir('GET', '/api/convite/k7m2p9qx');
  assert.equal(r.json.motivo, 'nao_encontrado');
});

test('POST /api/convite/<código>/aceitar entra no time, registra o uso no convite certo e devolve o id do time', async (t) => {
  const { pedir, tabelas } = cenario(t);
  const r = await pedir('POST', '/api/convite/k7m2p9qx/aceitar', null, QUEM_ENTRA);
  assert.equal(r.status, 201);
  assert.equal(r.json.jaMembro, false);
  assert.deepEqual(r.json.team, { id: TIME, slug: 'varzea-fc', nome: 'Várzea FC', cor: 'verde' });
  assert.ok(tabelas.team_members.some((m) => m.user_id === QUEM_ENTRA && m.team_id === TIME && m.role === 'member'));
  assert.deepEqual(tabelas.convite_usos.map((u) => [u.convite_id, u.user_id]), [[CONVITE, QUEM_ENTRA]]);
  const de_novo = await pedir('POST', `/api/convite/${TOKEN}/aceitar`, null, QUEM_ENTRA);
  assert.equal(de_novo.json.jaMembro, true, 'o link longo do mesmo convite vê a pessoa como membro');
});

test('aceitar pelo código de convite vencido: 400 "Este convite expirou."; código desconhecido: 404', async (t) => {
  const venceu = cenario(t, { convites: [{ id: CONVITE, token: TOKEN, team_id: TIME, criado_por: DONO, expires_at: ONTEM }] });
  const a = await venceu.pedir('POST', '/api/convite/k7m2p9qx/aceitar', null, QUEM_ENTRA);
  assert.equal(a.status, 400);
  assert.match(a.json.error, /expirou/);
  const sem = cenario(t);
  const b = await sem.pedir('POST', '/api/convite/zzzzzzzz/aceitar', null, QUEM_ENTRA);
  assert.equal(b.status, 404);
});

// ─── a lista do admin ─────────────────────────────────────────────────────────
test('a lista de convites do admin traz o código de cada um (null quando o convite é só de link longo)', async (t) => {
  const OUTRO = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const { pedir } = cenario(t, {
    convites: [
      { id: CONVITE, token: TOKEN, team_id: TIME, criado_por: DONO, expires_at: AMANHA, created_at: '2026-10-02T10:00:00Z' },
      { id: OUTRO, token: 'ffffffff-ffff-ffff-ffff-ffffffffffff', team_id: TIME, criado_por: DONO, expires_at: AMANHA, created_at: '2026-10-01T10:00:00Z' },
    ],
  });
  const r = await pedir('GET', '/api/teams/varzea-fc/convites', null, DONO);
  assert.equal(r.status, 200);
  const porId = Object.fromEntries(r.json.convites.map((c) => [c.id, c.codigo]));
  assert.deepEqual(porId, { [CONVITE]: 'k7m2p9qx', [OUTRO]: null });
});

test('convitePorParametro: uuid e código chegam à mesma linha, pedindo só as colunas dadas', async () => {
  const { cliente } = carregar({
    convites: [{ id: CONVITE, token: TOKEN, team_id: TIME, criado_por: DONO, expires_at: AMANHA }],
    convite_codigos: [{ codigo: 'k7m2p9qx', convite_id: CONVITE }],
  }, []);
  const a = await convitePorParametro(cliente, TOKEN, 'id, team_id');
  const b = await convitePorParametro(cliente, 'k7m2p9qx', 'id, team_id');
  assert.equal(a.id, CONVITE);
  assert.equal(b.id, CONVITE);
  assert.equal(await convitePorParametro(cliente, 'nao-existe', 'id'), null);
});
