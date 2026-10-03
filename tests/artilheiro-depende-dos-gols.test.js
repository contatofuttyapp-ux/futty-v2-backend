// Futty v2.0 — Rodada 29I (achado 78): o "Artilheiro do dia" depende dos "gols" do time.
//
// A varredura (3-out): na criação do time dava para ligar o artilheiro com os gols desligados — o texto do próprio "Mostrar gols" diz que
// ele traz "radar de 5 eixos, bloco de Gols e troféu de Artilheiro". Decisão do dono: o artilheiro depende dos gols. O app já apaga o
// artilheiro quando os gols estão desligados; aqui se prova que o MOTOR também recusa a combinação incoerente (POST /api/teams e
// PATCH /api/teams/:slug), e que religar os gols NÃO religa o artilheiro. Sem banco e sem rede (Supabase falso em memória).
//
// Uso: npm test  (ou: node --test tests/artilheiro-depende-dos-gols.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');
const { combinacaoDePremiosCoerente, MSG_ARTILHEIRO_PRECISA_DOS_GOLS } = require('../utils/premiosDoTime');

const ADMIN = '11111111-1111-1111-1111-111111111111';
const TIME = { id: 'time-1', nome: 'Missa de Quinta', slug: 'missa', cor: 'verde', criado_por: ADMIN, created_at: '2026-01-01T00:00:00Z', mostrar_gols: true, mostrar_artilheiro: true, mostrar_destaque: true };

function mundo(t, time = TIME) {
  const { carregados, tabelas } = carregar({
    users: [{ id: ADMIN }],
    teams: [{ ...time }],
    team_members: [{ team_id: time.id, user_id: ADMIN, role: 'admin', created_at: '2026-01-01T00:00:00Z' }],
  }, ['routes/teams']);
  return { pedir: subir([carregados['routes/teams']], t), tabelas };
}

test('a regra: só é incoerente com gols desligados E artilheiro ligado (e valores ausentes contam como ligados)', () => {
  assert.equal(combinacaoDePremiosCoerente({ mostrar_gols: true, mostrar_artilheiro: true }), true);
  assert.equal(combinacaoDePremiosCoerente({ mostrar_gols: true, mostrar_artilheiro: false }), true);
  assert.equal(combinacaoDePremiosCoerente({ mostrar_gols: false, mostrar_artilheiro: false }), true);
  assert.equal(combinacaoDePremiosCoerente({ mostrar_gols: false, mostrar_artilheiro: true }), false);
  assert.equal(combinacaoDePremiosCoerente({ mostrar_gols: false }), false, 'sem a coluna do artilheiro: padrão ligado');
  assert.equal(combinacaoDePremiosCoerente({}), true);
  assert.equal(MSG_ARTILHEIRO_PRECISA_DOS_GOLS, 'O artilheiro precisa dos gols ligados.');
});

test('criar time com gols desligados e artilheiro ligado: o motor recusa (400) e nada é criado', async (t) => {
  const { pedir, tabelas } = mundo(t);
  const r = await pedir('POST', '/api/teams', { nome: 'Time Novo', mostrar_gols: false }, ADMIN); // artilheiro não veio: o padrão é ligado
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.equal(r.json.error, MSG_ARTILHEIRO_PRECISA_DOS_GOLS);
  const explicito = await pedir('POST', '/api/teams', { nome: 'Time Novo', mostrar_gols: false, mostrar_artilheiro: true }, ADMIN);
  assert.equal(explicito.status, 400);
  assert.equal(tabelas.teams.length, 1, 'nenhum time novo');
});

test('criar time com gols desligados e artilheiro desligado: nasce coerente, com os gols desligados já no POST', async (t) => {
  const { pedir, tabelas } = mundo(t);
  const r = await pedir('POST', '/api/teams', { nome: 'Time Novo', mostrar_gols: false, mostrar_artilheiro: false }, ADMIN);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const criado = tabelas.teams.find((x) => x.nome === 'Time Novo');
  assert.equal(criado.mostrar_gols, false);
  assert.equal(criado.mostrar_artilheiro, false);
  // gols ligados e artilheiro desligado também vale (a pessoa decide)
  const outro = await pedir('POST', '/api/teams', { nome: 'Outro Time', mostrar_artilheiro: false }, ADMIN);
  assert.equal(outro.status, 201);
});

test('editar: desligar os gols com o artilheiro ligado é recusado; desligar os dois juntos passa', async (t) => {
  const { pedir, tabelas } = mundo(t);
  const so = await pedir('PATCH', '/api/teams/missa', { mostrar_gols: false }, ADMIN);
  assert.equal(so.status, 400, JSON.stringify(so.json));
  assert.equal(so.json.error, MSG_ARTILHEIRO_PRECISA_DOS_GOLS);
  assert.equal(tabelas.teams[0].mostrar_gols, true, 'nada foi gravado');
  const juntos = await pedir('PATCH', '/api/teams/missa', { mostrar_gols: false, mostrar_artilheiro: false }, ADMIN);
  assert.equal(juntos.status, 200, JSON.stringify(juntos.json));
  assert.equal(tabelas.teams[0].mostrar_gols, false);
  assert.equal(tabelas.teams[0].mostrar_artilheiro, false);
});

test('editar: com os gols desligados o artilheiro não liga sozinho; religar os gols NÃO religa o artilheiro', async (t) => {
  const { pedir, tabelas } = mundo(t, { ...TIME, mostrar_gols: false, mostrar_artilheiro: false });
  const ligaArtilheiro = await pedir('PATCH', '/api/teams/missa', { mostrar_artilheiro: true }, ADMIN);
  assert.equal(ligaArtilheiro.status, 400, 'com os gols desligados o artilheiro não pode ser ligado');
  const religaGols = await pedir('PATCH', '/api/teams/missa', { mostrar_gols: true }, ADMIN);
  assert.equal(religaGols.status, 200, JSON.stringify(religaGols.json));
  assert.equal(tabelas.teams[0].mostrar_gols, true);
  assert.equal(tabelas.teams[0].mostrar_artilheiro, false, 'o artilheiro continua desligado: a pessoa decide');
  const agoraLiga = await pedir('PATCH', '/api/teams/missa', { mostrar_artilheiro: true }, ADMIN);
  assert.equal(agoraLiga.status, 200, 'com os gols ligados a pessoa pode ligar o artilheiro');
});

test('editar outra coisa (nome) num time que já está incoerente não é barrado — só quem mexe nos gols ou no artilheiro', async (t) => {
  const { pedir } = mundo(t, { ...TIME, mostrar_gols: false, mostrar_artilheiro: true });
  const r = await pedir('PATCH', '/api/teams/missa', { nome: 'Missa de Quinta FC' }, ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // e o painel salva as duas chaves juntas: salvar o time incoerente com o artilheiro corrigido passa
  const corrige = await pedir('PATCH', '/api/teams/missa', { mostrar_gols: false, mostrar_artilheiro: false }, ADMIN);
  assert.equal(corrige.status, 200);
});

test('sem a migração 073 (a coluna do artilheiro não existe) desligar os gols continua funcionando', async (t) => {
  // o motor simula a coluna ausente: ler mostrar_artilheiro dá erro de coluna inexistente
  const falhar = (tabela, op, e) => (tabela === 'teams' && op === 'select' && /mostrar_artilheiro/.test(e.cols || '')
    ? { message: 'column teams.mostrar_artilheiro does not exist' } : null);
  const { carregados, tabelas } = carregar({
    users: [{ id: ADMIN }],
    teams: [{ ...TIME }],
    team_members: [{ team_id: TIME.id, user_id: ADMIN, role: 'admin', created_at: '2026-01-01T00:00:00Z' }],
  }, ['routes/teams'], { falhar });
  const pedir = subir([carregados['routes/teams']], t);
  const r = await pedir('PATCH', '/api/teams/missa', { mostrar_gols: false }, ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(tabelas.teams[0].mostrar_gols, false);
});
