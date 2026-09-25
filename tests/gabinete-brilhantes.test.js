// Futty v2.0 — Gabinete "Brilhantes" + pacote do time (SPEC-FIGURINHA-3, bloco 2).
//
// Duas coisas se provam aqui, as duas sobre DINHEIRO:
//
//   1. PORTÃO — as 4 rotas de ativação são do super-admin e de mais ninguém.
//      Quem conseguisse chamá-las dava a si próprio créditos de US$0,112 cada.
//   2. UNIFORME — no pacote do time, o uniforme é o que o dono fixou, e o
//      slot-reuse (build 9) NÃO pode devolver a Brilhante de outro kit. Se
//      devolvesse, o time pagava por 25 figurinhas do mesmo uniforme e recebia
//      um álbum às cores de quem gerou o quê.
//
// Nenhum teste aqui chama a fal: os dois casos de geração passam pelo
// slot-reuse, que responde antes de qualquer chamada paga. Custo: US$0.
//
// Uso: npm test  (ou: node --test tests/gabinete-brilhantes.test.js)
require('dotenv').config();
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@supabase/supabase-js');
const { app, supabase } = require('../server');

const { SUPABASE_URL } = process.env;
const SUPABASE_ANON_KEY = require('../utils/chavesSupabase').chavePublica();

const KIT_TIME = 'dark-purple'; // o uniforme que o dono fixa no pacote
const KIT_OUTRO = 'dark-gold'; // o que a pessoa poderia ter de antes

let server;
let baseUrl;
let teamId;
let pedidoPacoteId;
let pedidoMinhaId;
const contas = {};
// Saltar tudo (com aviso) se a 054 ainda não tiver sido corrida — é o Pedro
// que a aplica no SQL Editor, e um vermelho aqui não seria um defeito do código.
let temMigracao = true;

async function criarConta(etiqueta) {
  const email = `teste-gabbrilh-${etiqueta}-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
  const password = `Fx7!${crypto.randomUUID()}`;
  const { data: criado, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  await supabase.from('users').upsert({ id: criado.user.id, email, nome_jogador: etiqueta.toUpperCase() }, { onConflict: 'id' });
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: entrou, error: erroLogin } = await anon.auth.signInWithPassword({ email, password });
  if (erroLogin) throw erroLogin;
  return { id: criado.user.id, email, token: entrou.session.access_token };
}

async function pedir(metodo, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { method: metodo, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* 204/erro sem corpo */ }
  return { status: res.status, json };
}

before(async () => {
  if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_PUBLISHABLE_KEY (ou a antiga SUPABASE_ANON_KEY) em falta no .env.');

  server = app.listen(0);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  contas.dono = await criarConta('dono'); // admin do time, quem pede o pacote
  contas.membro = await criarConta('membro'); // quem vai gerar pelo pacote
  contas.comum = await criarConta('comum'); // não é super-admin: tem de levar 403
  contas.super = await criarConta('super');
  await supabase.from('users').update({ is_super_admin: true }).eq('id', contas.super.id);

  const sufixo = `${Date.now()}-${crypto.randomInt(1e6)}`;
  const { data: time, error: erroTime } = await supabase
    .from('teams')
    .insert({ nome: `Teste Brilhantes ${sufixo}`, slug: `teste-brilhantes-${sufixo}`, cor: '#d4a017', criado_por: contas.dono.id })
    .select()
    .single();
  if (erroTime) throw erroTime;
  teamId = time.id;

  const { error: erroMembros } = await supabase.from('team_members').insert([
    { team_id: teamId, user_id: contas.dono.id, role: 'admin' },
    { team_id: teamId, user_id: contas.membro.id, role: 'member' },
  ]);
  if (erroMembros) throw erroMembros;

  // Os dois pedidos que o dono vai resolver na aba.
  const { data: pacote, error: erroPacote } = await supabase
    .from('pedidos_ativacao').insert({ user_id: contas.dono.id, team_id: teamId, produto: 'pacote' }).select('id').single();
  if (erroPacote) {
    // Sem a 054 não há tabela nenhuma — os testes dizem-no e saltam.
    temMigracao = false;
    return;
  }
  pedidoPacoteId = pacote.id;
  const { data: minha } = await supabase
    .from('pedidos_ativacao').insert({ user_id: contas.membro.id, produto: 'minha' }).select('id').single();
  pedidoMinhaId = minha?.id || null;

  // O membro tem foto e a impressão digital dela (migração 052): é o que o
  // slot-reuse exige para reutilizar em vez de gerar.
  await supabase.from('users').update({
    foto_url: 'https://exemplo.invalid/object/public/avatars/public/foto-de-teste.jpg',
    foto_hash: `hash-teste-${sufixo}`,
  }).eq('id', contas.membro.id);
});

after(async () => {
  try {
    if (teamId) {
      await supabase.from('brilhantes_time').delete().eq('team_id', teamId);
      await supabase.from('teams').delete().eq('id', teamId);
    }
    for (const c of Object.values(contas)) {
      await supabase.from('pedidos_ativacao').delete().eq('user_id', c.id);
      await supabase.from('user_avatar_slots').delete().eq('user_id', c.id);
      await supabase.from('users').delete().eq('id', c.id);
      await supabase.auth.admin.deleteUser(c.id).catch(() => {});
    }
  } finally {
    if (server) await new Promise((r) => server.close(r));
  }
});

const ROTAS = [
  ['POST', '/api/super/gabinete/brilhantes/ativar-pacote'],
  ['POST', '/api/super/gabinete/brilhantes/creditos'],
  ['POST', '/api/super/gabinete/brilhantes/recusar'],
];

// ─── 1. O PORTÃO ─────────────────────────────────────────────────────────────
test('as rotas do Gabinete são do super-admin: 401 sem token, 403 com conta comum', async (t) => {
  // Rodada 28: a aba Velocidade (telemetria anônima agregada) atrás do mesmo portão.
  const todas = [['GET', '/api/super/gabinete/brilhantes'], ['GET', '/api/super/gabinete/velocidade'], ...ROTAS];
  for (const [metodo, path] of todas) {
    const sem = await pedir(metodo, path);
    assert.equal(sem.status, 401, `${metodo} ${path} sem token devia dar 401, deu ${sem.status}`);
    const comum = await pedir(metodo, path, { token: contas.comum.token, body: metodo === 'GET' ? undefined : {} });
    assert.equal(comum.status, 403, `${metodo} ${path} com conta comum devia dar 403, deu ${comum.status}`);
  }
  // O dono do TIME também não é super-admin: pedir o pacote é uma coisa,
  // ativá-lo é outra. Sem esta linha, qualquer dono se autoativava.
  const dono = await pedir('POST', '/api/super/gabinete/brilhantes/ativar-pacote', {
    token: contas.dono.token, body: { teamId, kitId: KIT_TIME },
  });
  assert.equal(dono.status, 403, 'o dono do time não pode ativar o próprio pacote');
  t.diagnostic('5 rotas × (sem token, conta comum) + o dono do time = 11 portas fechadas');
});

// ─── 2. A LISTA ──────────────────────────────────────────────────────────────
test('GET /brilhantes lista o pedido pendente com quem pediu e de que time', async (t) => {
  if (!temMigracao) return t.skip('migração 054 ainda não aplicada — ver db/migrations/054_brilhante.sql');
  const r = await pedir('GET', '/api/super/gabinete/brilhantes', { token: contas.super.token });
  assert.equal(r.status, 200);
  assert.equal(r.json.indisponivel, false);
  assert.ok(r.json.kits.includes(KIT_TIME), 'os 5 uniformes vêm do motor (KITS_IA), não de uma lista à parte');

  const meu = r.json.pedidos.find((p) => p.id === pedidoPacoteId);
  assert.ok(meu, 'o pedido pendente tem de aparecer na fila');
  assert.equal(meu.email, contas.dono.email);
  assert.equal(meu.team_id, teamId);
  assert.equal(meu.produto, 'pacote');
  assert.equal(meu.fase2, false);

  const time = r.json.times.find((x) => x.id === teamId);
  assert.ok(time, 'um time com pedido aparece na lista mesmo sem pacote ainda');
  assert.equal(time.brilhante_ativo, false);
  assert.equal(time.membros, 2);
  assert.equal(time.geradas, 0, 'ativar não gera nada em lote — começa em 0 e sobe quando cada um abre o app');
});

// ─── 3. ATIVAR O PACOTE ──────────────────────────────────────────────────────
test('ativar-pacote liga o time no uniforme escolhido e resolve o pedido', async (t) => {
  if (!temMigracao) return t.skip('migração 054 ainda não aplicada');
  const mau = await pedir('POST', '/api/super/gabinete/brilhantes/ativar-pacote', {
    token: contas.super.token, body: { teamId, kitId: 'uniforme-que-nao-existe' },
  });
  assert.equal(mau.status, 400, 'uniforme fora do catálogo do motor não passa');

  const r = await pedir('POST', '/api/super/gabinete/brilhantes/ativar-pacote', {
    token: contas.super.token, body: { teamId, kitId: KIT_TIME },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.membros_avisados, 2);

  const { data: time } = await supabase.from('teams').select('brilhante_ativo, brilhante_kit, brilhante_ativado_em').eq('id', teamId).maybeSingle();
  assert.equal(time.brilhante_ativo, true);
  assert.equal(time.brilhante_kit, KIT_TIME);
  assert.ok(time.brilhante_ativado_em, 'a data da ativação fica gravada');

  const { data: pedido } = await supabase.from('pedidos_ativacao').select('estado, resolvido_em').eq('id', pedidoPacoteId).maybeSingle();
  assert.equal(pedido.estado, 'ativado', 'o pedido sai da fila sozinho ao ser atendido');
  assert.ok(pedido.resolvido_em);
});

// ─── 4. CRÉDITOS ─────────────────────────────────────────────────────────────
test('creditos soma à pessoa e resolve o pedido "minha"', async (t) => {
  if (!temMigracao || !pedidoMinhaId) return t.skip('migração 054 ainda não aplicada');
  const mau = await pedir('POST', '/api/super/gabinete/brilhantes/creditos', {
    token: contas.super.token, body: { userId: contas.membro.id, quantidade: 0 },
  });
  assert.equal(mau.status, 400, 'zero crédito não é uma ativação, é um engano');

  // RODADA 21 (24-set): "Minha Figurinha" dá 10 gerações (era 2) — o valor que
  // o Gabinete manda por padrão. A rota em si aceita qualquer quantidade de
  // 1 a 25; 10 é o número real do produto, não um limite da rota.
  const r = await pedir('POST', '/api/super/gabinete/brilhantes/creditos', {
    token: contas.super.token, body: { userId: contas.membro.id, quantidade: 10 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.creditos, 10, 'a "Minha Figurinha" dá 10 gerações (Rodada 21)');

  const { data: pedido } = await supabase.from('pedidos_ativacao').select('estado').eq('id', pedidoMinhaId).maybeSingle();
  assert.equal(pedido.estado, 'ativado');

  // Volta a zero: os testes de uniforme abaixo precisam do membro SEM crédito,
  // senão o crédito paga um kit diferente do time (e é suposto pagar mesmo).
  await supabase.from('users').update({ brilhante_creditos: 0 }).eq('id', contas.membro.id);
});

// ─── 4B. CRÉDITOS POR E-MAIL (RODADA 21) — quem ainda não tem pedido nem
// crédito nenhum não aparece em NENHUMA das duas listas que a aba já lê. ────
test('creditos por e-mail resolve o userId no servidor (RODADA 21)', async (t) => {
  if (!temMigracao) return t.skip('migração 054 ainda não aplicada');
  const semNada = await pedir('POST', '/api/super/gabinete/brilhantes/creditos', {
    token: contas.super.token, body: { quantidade: 10 },
  });
  assert.equal(semNada.status, 400, 'sem userId e sem email não há quem creditar');

  const naoExiste = await pedir('POST', '/api/super/gabinete/brilhantes/creditos', {
    token: contas.super.token, body: { email: 'ninguem-com-este-email@futtymock.invalid', quantidade: 10 },
  });
  assert.equal(naoExiste.status, 404, 'e-mail sem conta não pode virar um userId qualquer');

  const r = await pedir('POST', '/api/super/gabinete/brilhantes/creditos', {
    token: contas.super.token, body: { email: contas.comum.email, quantidade: 10 },
  });
  assert.equal(r.status, 200, `devia resolver o e-mail para o userId, deu ${r.status} (${r.json?.error || ''})`);
  assert.equal(r.json.user_id, contas.comum.id, 'o e-mail tem de resolver para o userId certo, nunca um id inventado no cliente');
  assert.equal(r.json.creditos, 10);

  const { data: pessoa } = await supabase.from('users').select('brilhante_creditos').eq('id', contas.comum.id).maybeSingle();
  assert.equal(pessoa.brilhante_creditos, 10, 'o banco bate com o que a rota respondeu');

  await supabase.from('users').update({ brilhante_creditos: 0 }).eq('id', contas.comum.id);
});

// ─── 5. RECUSAR COM MOTIVO ───────────────────────────────────────────────────
test('recusar fecha o pedido com motivo, e o motivo volta na tela de quem pediu', async (t) => {
  if (!temMigracao) return t.skip('migração 054 ainda não aplicada');
  const { data: novo } = await supabase
    .from('pedidos_ativacao').insert({ user_id: contas.comum.id, produto: 'minha' }).select('id').single();

  const vazio = await pedir('POST', '/api/super/gabinete/brilhantes/recusar', {
    token: contas.super.token, body: { pedidoId: novo.id, motivo: '   ' },
  });
  assert.equal(vazio.status, 400, 'recusar sem motivo é uma porta batida na cara');

  const r = await pedir('POST', '/api/super/gabinete/brilhantes/recusar', {
    token: contas.super.token, body: { pedidoId: novo.id, motivo: 'Pagamento não identificado.' },
  });
  assert.equal(r.status, 200);

  const { data: pedido } = await supabase.from('pedidos_ativacao').select('estado').eq('id', novo.id).maybeSingle();
  assert.equal(pedido.estado, 'recusado');

  // A volta completa: a pessoa abre o app e lê o motivo.
  const estado = await pedir('GET', '/api/brilhantes/estado', { token: contas.comum.token });
  assert.equal(estado.status, 200);
  const meu = (estado.json.pedidos || []).find((p) => p.id === novo.id);
  assert.ok(meu, 'um pedido recusado continua a aparecer para quem o fez');
  assert.equal(meu.estado, 'recusado');
  if (r.json.motivo_guardado === false) {
    t.diagnostic('migração 055 ainda não aplicada: o estado fechou, o texto do motivo não ficou');
  } else {
    assert.equal(meu.motivo, 'Pagamento não identificado.');
  }
});

// ─── 6. O UNIFORME DO PACOTE MANDA ───────────────────────────────────────────
test('geração pelo pacote: o uniforme é o do time, mesmo pedindo outro', async (t) => {
  if (!temMigracao) return t.skip('migração 054 ainda não aplicada');
  const { data: perfil } = await supabase.from('users').select('foto_hash').eq('id', contas.membro.id).maybeSingle();
  // Slot do uniforme DO TIME, da foto atual: o caminho certo reutiliza-o e não
  // gasta um cêntimo.
  await supabase.from('user_avatar_slots').upsert({
    user_id: contas.membro.id, kit_id: KIT_TIME,
    avatar_url: 'https://exemplo.invalid/brilhante-do-time.png',
    foto_fingerprint: perfil.foto_hash,
  }, { onConflict: 'user_id,kit_id' });

  const r = await pedir('POST', '/api/me/avatar/ai', { token: contas.membro.token, body: { kit: KIT_OUTRO } });
  assert.equal(r.status, 200, `devia reutilizar o slot do time, deu ${r.status} (${r.json?.error || ''})`);
  assert.equal(r.json.kit, KIT_TIME, 'pediu dark-gold sem crédito: quem manda é o uniforme que o dono fixou');
  assert.equal(r.json.reutilizado, true, 'nada de gerar — e nada de gastar');
});

test('o slot-reuse não devolve a Brilhante de OUTRO uniforme', async (t) => {
  if (!temMigracao) return t.skip('migração 054 ainda não aplicada');
  const { data: perfil } = await supabase.from('users').select('foto_hash').eq('id', contas.membro.id).maybeSingle();
  // Agora a pessoa tem os DOIS slots da mesma foto: um do uniforme do time e
  // um de antes. Pedir o de antes, sem crédito, tem de continuar a dar o do
  // time — se desse o outro, o álbum do time saía às cores.
  await supabase.from('user_avatar_slots').upsert({
    user_id: contas.membro.id, kit_id: KIT_OUTRO,
    avatar_url: 'https://exemplo.invalid/brilhante-antiga.png',
    foto_fingerprint: perfil.foto_hash,
  }, { onConflict: 'user_id,kit_id' });

  const r = await pedir('POST', '/api/me/avatar/ai', { token: contas.membro.token, body: { kit: KIT_OUTRO } });
  assert.equal(r.status, 200);
  assert.equal(r.json.kit, KIT_TIME);
  assert.equal(r.json.avatar_url, 'https://exemplo.invalid/brilhante-do-time.png', 'devolveu a Brilhante do uniforme errado');
});

// ─── ACHADO DA VARREDURA PÓS-FIGURINHA 3 (22-set) ───────────────────────────
test('PUT /api/me/kit veste um kit não-default já gerado, sem gate de plano', async (t) => {
  if (!temMigracao) return t.skip('migração 054 ainda não aplicada');
  // Regressão: a rota ainda comparava users.plan (sempre 'free' agora que o
  // modelo Free/Pro/Elite saiu) contra kit.planos — nenhum kit fora o
  // dark-gold tinha 'free' na lista, então NINGUÉM conseguia voltar a vestir
  // uma Brilhante já gerada em qualquer outro uniforme. O membro tem os dois
  // slots (dark-purple do time, dark-gold de antes) do teste anterior.
  const r = await pedir('PUT', '/api/me/kit', { token: contas.membro.token, body: { kit: KIT_TIME } });
  assert.equal(r.status, 200, `vestir um kit já gerado tem de ser sempre livre, deu ${r.status} (${r.json?.error || ''})`);
  assert.equal(r.json.kit, KIT_TIME);
});

// ─── 6B. UNIFORME GUARDADO: NUNCA GERA, NUNCA DEBITA (RODADA 21) ────────────
test('PUT /api/me/kit num uniforme já pintado não chama a fal nem debita', async (t) => {
  if (!temMigracao) return t.skip('migração 054 ainda não aplicada');
  await supabase.from('users').update({ brilhante_creditos: 3 }).eq('id', contas.comum.id);
  const { data: perfil } = await supabase.from('users').select('foto_hash, avatar_url, kit_ativo').eq('id', contas.comum.id).maybeSingle();
  // Restaura o que já estava lá, não `null` a martelo — kit_ativo é NOT NULL
  // no banco (achado ao rodar este teste: o UPDATE de limpeza rebentava em
  // silêncio, código 23502, e o "fundo de cima" lá embaixo herdava a
  // Brilhante desta conta por engano).
  const avatarUrlOriginal = perfil?.avatar_url ?? null;
  const kitAtivoOriginal = perfil?.kit_ativo ?? 'dark-gold';
  await supabase.from('user_avatar_slots').upsert({
    user_id: contas.comum.id, kit_id: KIT_OUTRO,
    avatar_url: 'https://exemplo.invalid/ja-pintado.png',
    foto_fingerprint: perfil?.foto_hash || null,
  }, { onConflict: 'user_id,kit_id' });

  // Monkey-patch de global.fetch só para esta janela: conta qualquer chamada
  // rumo à fal (queue.fal.run), a prova de que "não chama a fal" não é só
  // "respondeu rápido" — é ZERO chamadas de verdade.
  const fetchOriginal = global.fetch;
  let chamadasFal = 0;
  global.fetch = (...args) => {
    if (String(args[0]).includes('fal.run')) chamadasFal += 1;
    return fetchOriginal(...args);
  };
  let r;
  try {
    r = await pedir('PUT', '/api/me/kit', { token: contas.comum.token, body: { kit: KIT_OUTRO } });
  } finally {
    global.fetch = fetchOriginal;
  }
  assert.equal(r.status, 200);
  assert.equal(r.json.avatar_url, 'https://exemplo.invalid/ja-pintado.png');
  assert.equal(chamadasFal, 0, 'trocar para um uniforme já pintado não pode tocar na fal — mock deve registrar zero chamadas');

  const { data: pessoa } = await supabase.from('users').select('brilhante_creditos').eq('id', contas.comum.id).maybeSingle();
  assert.equal(pessoa.brilhante_creditos, 3, 'e não debita nada — o crédito continua o mesmo de antes');

  await supabase.from('user_avatar_slots').delete().eq('user_id', contas.comum.id).eq('kit_id', KIT_OUTRO);
  // O PUT /api/me/kit acima vestiu de verdade (users.avatar_url/kit_ativo) —
  // desfaz também isso, senão contas.comum "ganha" uma Brilhante que vaza
  // para o teste "fundo de cima" lá embaixo (achado ao rodar este arquivo:
  // 403 esperado virou 200 porque a conta continuava com avatar_url de figurinha).
  await supabase.from('users').update({ brilhante_creditos: 0, avatar_url: avatarUrlOriginal, kit_ativo: kitAtivoOriginal }).eq('id', contas.comum.id);
});

// ─── 6C. O CONTADOR "N GERAÇÕES RESTANTES" BATE COM O BANCO (RODADA 21) ─────
test('GET /api/brilhantes/estado.direito.restantes bate com brilhante_creditos', async (t) => {
  if (!temMigracao) return t.skip('migração 054 ainda não aplicada');
  await supabase.from('users').update({ brilhante_creditos: 10 }).eq('id', contas.comum.id);
  const r = await pedir('GET', '/api/brilhantes/estado', { token: contas.comum.token });
  assert.equal(r.status, 200);
  assert.equal(r.json.direito.fonte, 'credito');
  assert.equal(r.json.direito.restantes, 10, 'o contador da tela vem do banco, não de um número fixo no frontend');
  assert.equal(r.json.creditos, 10);
  await supabase.from('users').update({ brilhante_creditos: 0 }).eq('id', contas.comum.id);
});

test('GET /api/brilhantes/estado.direito.restantes bate com o saldo do pacote do time', async (t) => {
  if (!temMigracao) return t.skip('migração 054 ainda não aplicada');
  const sonda = await supabase.from('brilhantes_time').select('geracoes').limit(1);
  if (sonda.error?.code === '42703' || sonda.error?.code === 'PGRST204') {
    return t.skip('migração 059 (brilhantes_time.geracoes) ainda não aplicada');
  }
  // O membro (do time deste arquivo, pacote no KIT_TIME) ainda não gerou nada
  // neste bloco — 5 de 5 restantes (RODADA 22: o DEFAULT da 059 é 5).
  await supabase.from('brilhantes_time').delete().eq('team_id', teamId).eq('user_id', contas.membro.id);
  const r0 = await pedir('GET', '/api/brilhantes/estado', { token: contas.membro.token });
  assert.equal(r0.json.direito.fonte, 'time');
  assert.equal(r0.json.direito.restantes, 5, 'pacote novo: 5 de 5 restantes (DEFAULT 5 da migração 059 aplicado no banco?)');

  await supabase.from('brilhantes_time').upsert({
    team_id: teamId, user_id: contas.membro.id, kit_id: KIT_TIME, avatar_url: 'https://exemplo.invalid/r21.png', geracoes: 4,
  }, { onConflict: 'team_id,user_id' });
  const r2 = await pedir('GET', '/api/brilhantes/estado', { token: contas.membro.token });
  assert.equal(r2.json.direito.restantes, 1, 'usou 4 de 5 — resta 1, e é o banco que diz isso, não a tela');

  await supabase.from('brilhantes_time').delete().eq('team_id', teamId).eq('user_id', contas.membro.id);
});

// ─── 6D. CINCO GERAÇÕES, A 6ª RECUSADA — no banco REAL (RODADA 22) ───────────
// Sem a fal: usa o mesmo temDireito()/debitar() que POST /api/me/avatar/ai
// chama, contra a coluna de verdade. Prova o ciclo inteiro do pacote: cada
// geração debita 1, o contador desce de 5 a 1, e a 6ª não tem direito.
test('pacote de 5: cinco gerações debitam e a 6ª é recusada (banco real)', async (t) => {
  if (!temMigracao) return t.skip('migração 054 ainda não aplicada');
  const sonda = await supabase.from('brilhantes_time').select('geracoes').limit(1);
  if (sonda.error?.code === '42703' || sonda.error?.code === 'PGRST204') {
    return t.skip('migração 059 (brilhantes_time.geracoes) ainda não aplicada');
  }
  const { temDireito, debitar } = require('../utils/direitoBrilhante');
  await supabase.from('brilhantes_time').delete().eq('team_id', teamId).eq('user_id', contas.membro.id);

  for (let i = 1; i <= 5; i += 1) {
    const d = await temDireito(contas.membro.id);
    assert.equal(d.fonte, 'time', `geração ${i}: devia ter direito pelo pacote`);
    assert.equal(d.restantes, 6 - i, `geração ${i}: o contador devia dizer ${6 - i} restante(s)`);
    const ok = await debitar(d, { userId: contas.membro.id, kitId: KIT_TIME, avatarUrl: `https://exemplo.invalid/r22-${i}.png`, custoCents: 11 });
    assert.equal(ok, true, `o débito da geração ${i} devia ter gravado`);
  }

  const sexta = await temDireito(contas.membro.id);
  assert.equal(sexta.fonte, null, 'a 6ª geração não tem direito — as 5 do pacote foram usadas');
  assert.equal(sexta.restantes, 0);
  const { data: linha } = await supabase.from('brilhantes_time').select('geracoes').eq('team_id', teamId).eq('user_id', contas.membro.id).maybeSingle();
  assert.equal(linha.geracoes, 5, 'o banco guarda 5 — bate com o que o contador contou');

  await supabase.from('brilhantes_time').delete().eq('team_id', teamId).eq('user_id', contas.membro.id);
});

// ─── 7. SAIR DO TIME ─────────────────────────────────────────────────────────
test('quem sai do time mantém a Brilhante já gerada', async (t) => {
  if (!temMigracao) return t.skip('migração 054 ainda não aplicada');
  await supabase.from('brilhantes_time').upsert({
    team_id: teamId, user_id: contas.membro.id, kit_id: KIT_TIME,
    avatar_url: 'https://exemplo.invalid/brilhante-do-time.png', custo_cents: 11,
  }, { onConflict: 'team_id,user_id' });
  // O avatar dela é uma figurinha NOSSA (arquivo -ai- no bucket avatars, como o do motor): é o que a
  // regra única (utils/figurinhaRegra.js) reconhece. Uma URL de fora não vale como figurinha
  // desde o Hotfix 26 (a foto do Google, que o trigger 001 copiava, contava).
  const avatarDaFigurinha = `${SUPABASE_URL}/storage/v1/object/public/avatars/public/${contas.membro.id}-ai-${KIT_TIME}-1.png`;
  await supabase.from('users').update({ avatar_url: avatarDaFigurinha }).eq('id', contas.membro.id);

  // O Gabinete conta a geração e o custo REAL dela.
  const antes = await pedir('GET', '/api/super/gabinete/brilhantes', { token: contas.super.token });
  const timeAntes = antes.json.times.find((x) => x.id === teamId);
  assert.equal(timeAntes.geradas, 1);
  assert.equal(timeAntes.limite, 25);
  assert.equal(timeAntes.custo_usd, 0.11, 'o custo é o que a fal cobrou, somado por time');

  await supabase.from('team_members').delete().eq('team_id', teamId).eq('user_id', contas.membro.id);

  const { data: pessoa } = await supabase.from('users').select('avatar_url').eq('id', contas.membro.id).maybeSingle();
  assert.equal(pessoa.avatar_url, avatarDaFigurinha, 'sair do time não desfaz a figurinha de ninguém');
  const { data: linha } = await supabase.from('brilhantes_time').select('user_id').eq('team_id', teamId).eq('user_id', contas.membro.id).maybeSingle();
  assert.ok(linha, 'a linha do pacote fica: o time gastou aquela vaga de verdade');

  // Devolve a filiação, para o `after` limpar como espera.
  await supabase.from('team_members').insert({ team_id: teamId, user_id: contas.membro.id, role: 'member' });
});

// ─── 8. OS 6 FUNDOS VÊM COM A BRILHANTE, NÃO COM UM PLANO ────────────────────
test('fundo de cima: livre para quem tem Brilhante, barrado para quem não tem', async () => {
  // O membro tem Brilhante (avatar_url = uma figurinha nossa, posto no teste anterior) e
  // plano "free" — no modelo antigo levava 403 "exige um plano superior", com
  // "Os 6 fundos liberados" escrito na compra que o time fez.
  const comBrilhante = await pedir('PATCH', '/api/me', { token: contas.membro.token, body: { fundo_figurinha: 'aura' } });
  assert.equal(comBrilhante.status, 200, `quem tem Brilhante escolhe qualquer fundo, deu ${comBrilhante.status}`);

  // A conta comum não tem Brilhante nenhuma: continua barrada (defesa em
  // profundidade — na tela ela nem vê seletor de fundo).
  const semBrilhante = await pedir('PATCH', '/api/me', { token: contas.comum.token, body: { fundo_figurinha: 'aura' } });
  assert.equal(semBrilhante.status, 403);
  assert.equal(semBrilhante.json?.code, 'SEM_BRILHANTE');

  // Os 3 de baixo nunca dependeram de nada.
  const gratis = await pedir('PATCH', '/api/me', { token: contas.comum.token, body: { fundo_figurinha: 'estadio' } });
  assert.equal(gratis.status, 200);
});
