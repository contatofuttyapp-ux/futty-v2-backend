// Futty v2.0 — Rodada 9: a flag de goleiro do TIME é o padrão do JOGO.
// Decisão do dono (16-set): a posição GR/DEF/MEI/ATA sai do app; fica só
// goleiro/linha. `team_members.posicao === 'GL'` deixa de ser etiqueta e passa
// a valer como padrão: quem confirma presença sem dizer nada entra como goleiro
// — sem nunca sobrescrever o que o jogador ou o admin já marcaram NAQUELE jogo.
//
// Cobre os dois caminhos de confirmação:
//   1. RSVP: responder "confirmado" + admin fechar -> game_players.goleiro true
//      (a materialização do RSVP em game_players acontece no FECHAR, não no
//      responder — é lá que a linha do elenco nasce).
//   2. POST /api/games/:id/confirmar sem `goleiro` no body -> herda a flag.
//   3. Quem já tem linha no jogo com goleiro=false MANTÉM false nos dois casos.
//
// Cria time/jogo/contas próprios e apaga tudo no fim (after), mesmo se falhar.
// Uso: npm test  (ou: node --test tests/goleiro-do-time.test.js)
require('dotenv').config();
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@supabase/supabase-js');
const { app, supabase } = require('../server');

const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;

let server;
let baseUrl;
let teamId;
let gameId;
const contas = {}; // papel -> { id, token }

/** Conta descartável com sessão real (o mesmo access_token que requireAuth valida). */
async function criarConta(papel) {
  const email = `teste-goleiro-${papel}-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
  const password = `Fx7!${crypto.randomUUID()}`;
  const { data: created, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({ email, password });
  if (signInErr) throw signInErr;

  await supabase.from('users').upsert({ id: created.user.id, email, nome: `Teste ${papel}` }, { onConflict: 'id' });
  return { id: created.user.id, email, token: signIn.session.access_token };
}

function pedir(metodo, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, { method: metodo, headers, body: body ? JSON.stringify(body) : undefined });
}

/** Linha do elenco (game_players) de um jogador neste jogo. */
async function linhaDoElenco(userId) {
  const { data } = await supabase
    .from('game_players')
    .select('confirmado, goleiro')
    .eq('game_id', gameId)
    .eq('user_id', userId)
    .maybeSingle();
  return data || null;
}

before(async () => {
  if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_ANON_KEY em falta no .env — precisa dela para assinar sessão de teste.');

  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  contas.admin = await criarConta('admin'); // admin do time, goleiro do time
  contas.goleiro = await criarConta('goleiro'); // membro goleiro do time (via RSVP)
  contas.marcado = await criarConta('marcado'); // goleiro do time, mas já desmarcado NESTE jogo
  contas.linha = await criarConta('linha'); // jogador de linha

  const sufixo = `${Date.now()}-${crypto.randomInt(1e6)}`;
  const { data: time, error: teamErr } = await supabase
    .from('teams')
    .insert({ nome: `Teste Goleiro ${sufixo}`, slug: `teste-goleiro-${sufixo}`, cor: '#d4a017', criado_por: contas.admin.id })
    .select()
    .single();
  if (teamErr) throw teamErr;
  teamId = time.id;

  const { error: memErr } = await supabase.from('team_members').insert([
    { team_id: teamId, user_id: contas.admin.id, role: 'admin', posicao: 'GL' },
    { team_id: teamId, user_id: contas.goleiro.id, role: 'member', posicao: 'GL' },
    { team_id: teamId, user_id: contas.marcado.id, role: 'member', posicao: 'GL' },
    { team_id: teamId, user_id: contas.linha.id, role: 'member', posicao: null },
  ]);
  if (memErr) throw memErr;

  const daquiADias = (n) => new Date(Date.now() + n * 864e5).toISOString();
  const { data: jogo, error: gameErr } = await supabase
    .from('games')
    .insert({
      team_id: teamId,
      data: daquiADias(3),
      local: 'Quadra de Teste',
      jogadores_por_time: 5,
      rsvp_aberto: true,
      rsvp_fechado: false,
      rsvp_prazo: daquiADias(2),
    })
    .select()
    .single();
  if (gameErr) throw gameErr;
  gameId = jogo.id;

  // O admin já decidiu que ESTE goleiro do time joga na linha neste jogo.
  const { error: gpErr } = await supabase
    .from('game_players')
    .insert({ game_id: gameId, user_id: contas.marcado.id, confirmado: false, goleiro: false });
  if (gpErr) throw gpErr;
});

after(async () => {
  // PostgREST devolve { error } em vez de rejeitar — nada de .catch() aqui (não
  // existe no builder do supabase-js e a excepção deixava o servidor aberto).
  try {
    if (gameId) await supabase.from('games').delete().eq('id', gameId);
    if (teamId) await supabase.from('teams').delete().eq('id', teamId);
    for (const c of Object.values(contas)) {
      await supabase.from('users').delete().eq('id', c.id);
      await supabase.auth.admin.deleteUser(c.id).catch(() => {});
    }
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
});

test('confirmar sem `goleiro` no body herda a flag do time', async () => {
  const r = await pedir('POST', `/api/games/${gameId}/confirmar`, { token: contas.goleiro.token, body: { confirmado: true } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.meuEstado.goleiro, true, 'membro com posicao GL devia confirmar já como goleiro');
  assert.deepEqual(await linhaDoElenco(contas.goleiro.id), { confirmado: true, goleiro: true });
});

test('confirmar com `goleiro: false` explícito manda mais que a flag do time', async () => {
  const r = await pedir('POST', `/api/games/${gameId}/confirmar`, { token: contas.goleiro.token, body: { confirmado: true, goleiro: false } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).meuEstado.goleiro, false);
  assert.deepEqual(await linhaDoElenco(contas.goleiro.id), { confirmado: true, goleiro: false });

  // E uma nova confirmação sem o campo NÃO volta a ligar: respeita o jogo.
  const r2 = await pedir('POST', `/api/games/${gameId}/confirmar`, { token: contas.goleiro.token, body: { confirmado: true } });
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).meuEstado.goleiro, false, 'não pode sobrescrever o que já foi marcado no jogo');
});

test('jogador de linha continua de linha ao confirmar', async () => {
  const r = await pedir('POST', `/api/games/${gameId}/confirmar`, { token: contas.linha.token, body: { confirmado: true } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).meuEstado.goleiro, false);
});

test('membro com posicao GL que confirma pelo RSVP aparece como goleiro no elenco', async () => {
  // 1. Os três respondem "confirmado" ao RSVP (nada disto toca em game_players).
  for (const papel of ['admin', 'marcado', 'goleiro']) {
    const r = await pedir('POST', `/api/jogos/${gameId}/rsvp/responder`, { token: contas[papel].token, body: { status: 'confirmado' } });
    assert.equal(r.status, 200, `RSVP de ${papel} devia passar`);
  }
  assert.equal(await linhaDoElenco(contas.admin.id), null, 'o responder não cria linha no elenco — quem cria é o fechar');

  // 2. O admin fecha o RSVP: é aqui que o elenco nasce.
  const fechou = await pedir('POST', `/api/jogos/${gameId}/rsvp/fechar`, { token: contas.admin.token });
  assert.equal(fechou.status, 200);

  // 3. Quem é goleiro do time e ainda não tinha linha entra como goleiro.
  assert.deepEqual(await linhaDoElenco(contas.admin.id), { confirmado: true, goleiro: true });

  // 4. Quem já tinha linha mantém o que estava lá (admin/jogador mandam no jogo).
  assert.deepEqual(await linhaDoElenco(contas.marcado.id), { confirmado: true, goleiro: false }, 'goleiro do time desmarcado no jogo continua desmarcado');
  assert.deepEqual(await linhaDoElenco(contas.goleiro.id), { confirmado: true, goleiro: false }, 'o que o jogador marcou no jogo manda');

  // 5. O elenco que a tela lê conta a mesma história.
  const detalhe = await pedir('GET', `/api/games/${gameId}`, { token: contas.admin.token });
  assert.equal(detalhe.status, 200);
  const { players } = await detalhe.json();
  assert.equal(players.find((p) => p.user_id === contas.admin.id).goleiro, true);
  assert.equal(players.find((p) => p.user_id === contas.marcado.id).goleiro, false);
});

test('PATCH da posição só aceita GL ou null — DEF/MEI/ATA viram linha', async () => {
  const { data: time } = await supabase.from('teams').select('slug').eq('id', teamId).single();

  const r = await pedir('PATCH', `/api/equipas/${time.slug}/membros/posicao`, { token: contas.linha.token, body: { posicao: 'MEI' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).posicao, null, 'posição antiga tinha de virar null');

  const r2 = await pedir('PATCH', `/api/equipas/${time.slug}/membros/posicao`, { token: contas.linha.token, body: { posicao: 'GL' } });
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).posicao, 'GL');
});

test('leitura do time só devolve GL ou null, mesmo com DEF/MEI/ATA no banco', async () => {
  const { data: time } = await supabase.from('teams').select('slug').eq('id', teamId).single();
  // Valor antigo posto à força no banco (é o que existe hoje em contas reais).
  await supabase.from('team_members').update({ posicao: 'ATA' }).eq('team_id', teamId).eq('user_id', contas.linha.id);

  const r = await pedir('GET', `/api/teams/${time.slug}`, { token: contas.admin.token });
  assert.equal(r.status, 200);
  const { members } = await r.json();
  assert.equal(members.find((m) => m.id === contas.linha.id).posicao, null, 'ATA não pode aparecer na tela');
  assert.equal(members.find((m) => m.id === contas.admin.id).posicao, 'GL');

  const rm = await pedir('GET', `/api/teams/${time.slug}/membros`, { token: contas.admin.token });
  assert.equal(rm.status, 200);
  const { membros } = await rm.json();
  assert.equal(membros.find((m) => m.user_id === contas.linha.id).posicao, null);
  assert.equal(membros.find((m) => m.user_id === contas.admin.id).posicao, 'GL');
});
