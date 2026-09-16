// Futty v2.0 — Rodada 9: a flag de goleiro do TIME é o padrão do JOGO.
// Decisão do dono (16-set): a posição GR/DEF/MEI/ATA sai do app; fica só
// goleiro/linha. A flag de goleiro do time deixa de ser etiqueta e passa a
// valer como padrão: quem confirma presença sem dizer nada entra como goleiro
// — sem nunca sobrescrever o que o jogador ou o admin já marcaram NAQUELE jogo.
//
// Rodada 10B (16-set): até aqui havia DUAS colunas guardando a mesma decisão —
// `team_members.posicao` ('GL'|null, Rodada 9) e `team_members.categoria`
// ('GR'|'linha', a que já mandava no ranking). O dono escolheu ficar só com
// `categoria`; `posicao` fica no banco como coluna morta, nunca mais escrita,
// e as leituras/escritas todas passam a falar `goleiro` (booleano).
//
// Cobre os dois caminhos de confirmação:
//   1. RSVP: responder "confirmado" + admin fechar -> game_players.goleiro true
//      (a materialização do RSVP em game_players acontece no FECHAR, não no
//      responder — é lá que a linha do elenco nasce).
//   2. POST /api/games/:id/confirmar sem `goleiro` no body -> herda a flag.
//   3. Quem já tem linha no jogo com goleiro=false MANTÉM false nos dois casos.
// E a unificação da Rodada 10B:
//   4. PATCH .../membros/posicao aceita `goleiro` (novo) e `posicao` (antigo,
//      compatibilidade) — os dois escrevem a MESMA coluna (categoria).
//   5. A coluna `posicao`, morta, não influencia mais NADA que se leia.
//   6. A rota antiga do admin (.../membros/:userId com `categoria`) e a rota
//      .../membros/posicao nunca podem discordar — escrevem a mesma coluna.
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
    { team_id: teamId, user_id: contas.admin.id, role: 'admin', categoria: 'GR' },
    { team_id: teamId, user_id: contas.goleiro.id, role: 'member', categoria: 'GR' },
    { team_id: teamId, user_id: contas.marcado.id, role: 'member', categoria: 'GR' },
    { team_id: teamId, user_id: contas.linha.id, role: 'member', categoria: 'linha' },
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
  assert.equal(body.meuEstado.goleiro, true, 'membro com categoria GR devia confirmar já como goleiro');
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

test('membro com categoria GR que confirma pelo RSVP aparece como goleiro no elenco', async () => {
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

test('PATCH .../membros/posicao com `posicao` (contrato antigo) só aceita GL — DEF/MEI/ATA viram linha', async () => {
  const { data: time } = await supabase.from('teams').select('slug').eq('id', teamId).single();

  const r = await pedir('PATCH', `/api/equipas/${time.slug}/membros/posicao`, { token: contas.linha.token, body: { posicao: 'MEI' } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.posicao, null, 'posição antiga tinha de virar null');
  assert.equal(body.goleiro, false);

  const r2 = await pedir('PATCH', `/api/equipas/${time.slug}/membros/posicao`, { token: contas.linha.token, body: { posicao: 'GL' } });
  assert.equal(r2.status, 200);
  const body2 = await r2.json();
  assert.equal(body2.posicao, 'GL');
  assert.equal(body2.goleiro, true);

  // Devolve o jogador de linha ao estado inicial para não vazar para os testes seguintes.
  const desfaz = await pedir('PATCH', `/api/equipas/${time.slug}/membros/posicao`, { token: contas.linha.token, body: { goleiro: false } });
  assert.equal(desfaz.status, 200);
});

test('PATCH .../membros/posicao com `goleiro` (contrato novo, Rodada 10B) grava categoria', async () => {
  const { data: time } = await supabase.from('teams').select('slug').eq('id', teamId).single();

  const r = await pedir('PATCH', `/api/equipas/${time.slug}/membros/posicao`, { token: contas.linha.token, body: { goleiro: true } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body, { ok: true, goleiro: true, posicao: 'GL' });

  const { data: linha } = await supabase.from('team_members').select('categoria, posicao').eq('team_id', teamId).eq('user_id', contas.linha.id).single();
  assert.equal(linha.categoria, 'GR', 'a rota grava categoria, não posicao');
  assert.equal(linha.posicao, null, 'a coluna posicao (morta) nunca mais é escrita por esta rota');

  const r2 = await pedir('PATCH', `/api/equipas/${time.slug}/membros/posicao`, { token: contas.linha.token, body: { goleiro: false } });
  assert.equal(r2.status, 200);
  assert.deepEqual(await r2.json(), { ok: true, goleiro: false, posicao: null });
});

test('a coluna posicao (morta) não influencia mais nenhuma leitura — só categoria manda', async () => {
  const { data: time } = await supabase.from('teams').select('slug').eq('id', teamId).single();
  // Contradiz de propósito: posicao diz uma coisa, categoria diz outra. Se a
  // leitura ainda olhasse para posicao, este teste apanhava.
  await supabase.from('team_members').update({ posicao: 'GL', categoria: 'linha' }).eq('team_id', teamId).eq('user_id', contas.marcado.id);
  await supabase.from('team_members').update({ posicao: 'ATA', categoria: 'GR' }).eq('team_id', teamId).eq('user_id', contas.linha.id);

  const r = await pedir('GET', `/api/teams/${time.slug}`, { token: contas.admin.token });
  assert.equal(r.status, 200);
  const { members } = await r.json();
  const marcado = members.find((m) => m.id === contas.marcado.id);
  const linha = members.find((m) => m.id === contas.linha.id);
  assert.deepEqual({ goleiro: marcado.goleiro, posicao: marcado.posicao }, { goleiro: false, posicao: null }, 'posicao=GL no banco não pode virar goleiro');
  assert.deepEqual({ goleiro: linha.goleiro, posicao: linha.posicao }, { goleiro: true, posicao: 'GL' }, 'categoria=GR manda, mesmo com posicao=ATA no banco');

  const rm = await pedir('GET', `/api/teams/${time.slug}/membros`, { token: contas.admin.token });
  assert.equal(rm.status, 200);
  const { membros } = await rm.json();
  const marcadoDet = membros.find((m) => m.user_id === contas.marcado.id);
  const linhaDet = membros.find((m) => m.user_id === contas.linha.id);
  assert.deepEqual({ goleiro: marcadoDet.goleiro, posicao: marcadoDet.posicao }, { goleiro: false, posicao: null });
  assert.deepEqual({ goleiro: linhaDet.goleiro, posicao: linhaDet.posicao }, { goleiro: true, posicao: 'GL' });

  // Desfaz para não vazar estado para outros testes (nenhum corre depois deste
  // hoje, mas a higiene é a mesma dos outros testes do arquivo).
  await supabase.from('team_members').update({ categoria: 'GR' }).eq('team_id', teamId).eq('user_id', contas.marcado.id);
  await supabase.from('team_members').update({ categoria: 'linha' }).eq('team_id', teamId).eq('user_id', contas.linha.id);
});

test('a pastilha "GR" do admin (rota antiga) e o chip/botão de goleiro (rota nova) nunca discordam — mesma coluna', async () => {
  const { data: time } = await supabase.from('teams').select('slug').eq('id', teamId).single();

  // A rota ANTIGA do admin (AdminPanel → categoria) liga o goleiro...
  const r1 = await pedir('PATCH', `/api/teams/${time.slug}/membros/${contas.linha.id}`, { token: contas.admin.token, body: { categoria: 'GR' } });
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).membro.categoria, 'GR');

  // ...e a rota NOVA (chip do jogador / botão do admin) já vê o mesmo estado.
  const r2 = await pedir('GET', `/api/teams/${time.slug}/membros`, { token: contas.admin.token });
  const linhaDet = (await r2.json()).membros.find((m) => m.user_id === contas.linha.id);
  assert.equal(linhaDet.goleiro, true, 'a leitura nova tem de ver o que a rota antiga gravou');

  // E o caminho inverso: a rota NOVA desliga...
  const r3 = await pedir('PATCH', `/api/equipas/${time.slug}/membros/posicao`, { token: contas.linha.token, body: { goleiro: false } });
  assert.equal(r3.status, 200);

  // ...e a rota ANTIGA (a mesma leitura que alimenta a pastilha "GR") já vê.
  const r4 = await pedir('GET', `/api/teams/${time.slug}/membros`, { token: contas.admin.token });
  const linhaDet2 = (await r4.json()).membros.find((m) => m.user_id === contas.linha.id);
  assert.equal(linhaDet2.categoria, 'linha');
  assert.equal(linhaDet2.goleiro, false);
});
