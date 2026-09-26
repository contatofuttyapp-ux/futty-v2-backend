// Pagamentos P2 — o dono escolhe o uniforme do pacote (utils/uniformeDoPacote.js), sem banco.
//
// O que isto prova:
//   1. a 1ª escolha fixa o uniforme e avisa os membros (é agora que dá para gerar);
//   2. só o admin do time escolhe; membro comum → 403;
//   3. sem pacote ativo → 409; uniforme fora do catálogo → 400;
//   4. trocar vale enquanto ninguém gerou; depois da 1ª geração → 409 (o álbum já tem um uniforme);
//   5. no servidor de verdade a rota PUT /api/teams/:slug/brilhante-kit está montada e pede sessão.
//
// Uso: npm test  (ou: node --test tests/uniforme-do-pacote.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarUniformeDoPacote } = require('../utils/uniformeDoPacote');
const { criarSupabaseFalso } = require('./_supabaseFalso');

const DONO = '33333333-3333-3333-3333-333333333333';
const MEMBRO = '22222222-2222-2222-2222-222222222222';
const TIME = '11111111-1111-1111-1111-111111111111';
const KITS = ['dark-gold', 'dark-purple', 'white-gold', 'elite-gold', 'royal-purple'];

function montar({ ativo = true, kit = null, geradas = 0 } = {}) {
  const avisos = [];
  const { cliente, tabelas } = criarSupabaseFalso({
    teams: [{ id: TIME, nome: 'Missa de Quinta', brilhante_ativo: ativo, brilhante_kit: kit }],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin' }, { team_id: TIME, user_id: MEMBRO, role: 'member' }],
    brilhantes_time: Array.from({ length: geradas }, (_, i) => ({ team_id: TIME, user_id: `u${i}`, geracoes: 1 })),
  });
  const { escolherUniforme } = criarUniformeDoPacote({ supabase: cliente, notificar: (ids, payload) => avisos.push({ ids, payload }) });
  const escolher = (userId, kitId) => escolherUniforme({ teamId: TIME, userId, kitId, kitsValidos: KITS });
  return { escolher, tabelas, avisos };
}

test('1ª escolha do dono fixa o uniforme e avisa os membros', async () => {
  const { escolher, tabelas, avisos } = montar();
  const r = await escolher(DONO, 'dark-purple');
  assert.deepEqual(r, { kit_id: 'dark-purple', primeira_escolha: true, membros_avisados: 2 });
  assert.equal(tabelas.teams[0].brilhante_kit, 'dark-purple');
  assert.deepEqual(avisos[0].ids.sort(), [DONO, MEMBRO].sort());
  assert.equal(avisos[0].payload.url, '/figurinha');
});

test('membro comum não escolhe (403 SO_DONO) e nada muda', async () => {
  const { escolher, tabelas } = montar();
  await assert.rejects(escolher(MEMBRO, 'dark-gold'), (e) => e.status === 403 && e.code === 'SO_DONO');
  assert.equal(tabelas.teams[0].brilhante_kit, null);
});

test('sem pacote ativo → 409 SEM_PACOTE; uniforme fora do catálogo → 400', async () => {
  const semPacote = montar({ ativo: false });
  await assert.rejects(semPacote.escolher(DONO, 'dark-gold'), (e) => e.status === 409 && e.code === 'SEM_PACOTE');
  const { escolher } = montar();
  await assert.rejects(escolher(DONO, 'camisa-do-vasco'), (e) => e.status === 400 && e.code === 'KIT_INVALIDO');
});

test('trocar antes da 1ª geração vale (sem novo aviso); depois dela → 409 UNIFORME_EM_USO', async () => {
  const antes = montar({ kit: 'dark-gold' });
  const r = await antes.escolher(DONO, 'white-gold');
  assert.equal(r.primeira_escolha, false);
  assert.equal(antes.tabelas.teams[0].brilhante_kit, 'white-gold');
  assert.equal(antes.avisos.length, 0, 'os membros já foram avisados na 1ª escolha');

  const depois = montar({ kit: 'dark-gold', geradas: 1 });
  await assert.rejects(depois.escolher(DONO, 'white-gold'), (e) => e.status === 409 && e.code === 'UNIFORME_EM_USO');
  assert.equal(depois.tabelas.teams[0].brilhante_kit, 'dark-gold');
});

test('escolher o mesmo uniforme de novo não faz nada', async () => {
  const { escolher, avisos } = montar({ kit: 'dark-gold', geradas: 3 });
  const r = await escolher(DONO, 'dark-gold');
  assert.equal(r.primeira_escolha, false);
  assert.equal(avisos.length, 0);
});

test('no servidor de verdade: PUT /api/teams/:slug/brilhante-kit montada e pede sessão', async (t) => {
  const { app } = require('../server');
  const servidor = app.listen(0);
  t.after(() => servidor.close());
  const r = await fetch(`http://127.0.0.1:${servidor.address().port}/api/teams/qualquer/brilhante-kit`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"kitId":"dark-gold"}',
  });
  assert.equal(r.status, 401);
});
