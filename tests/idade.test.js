// Rodada 29G (1-out) — o Futty é para maiores de 18 anos (antes: 13, Rodada 28 bloco C).
//
// O que isto prova:
//   1. a régua (utils/idade.js): faz 18 HOJE entra, faz 18 AMANHÃ não; 29/02; datas impossíveis e
//      futuras são recusadas; a 2ª linha (ehAdulto, do rosto público) usa a MESMA régua;
//   2. no cadastro (onboarding por concluir), menor de 18 não fica com conta: o PATCH da data (passo
//      do onboarding de quem entrou com Google/Apple) e a conclusão do onboarding (data que veio do
//      cadastro por e-mail) apagam a conta e respondem 403 MENOR_DE_18 — o mesmo token deixa de valer;
//   3. 18 anos ou mais segue normal (faz 18 hoje entra, faz amanhã não, mesmo pelo motor); conta que
//      já existia (onboarding concluído) não é apagada pelo motor — a tela de exclusão é do app.
//
// Contas descartáveis @futtymock, contra o Supabase de verdade (padrão da casa).
require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@supabase/supabase-js');
const { IDADE_MINIMA, MSG_MENOR, dataDeNascimentoValida, idadeEm, menorQueIdadeMinima, temIdadeMinima } = require('../utils/idade');
const { ehAdulto } = require('../utils/rostoPublico');
const { app, supabase } = require('../server');
const { COM_BANCO, MOTIVO_SKIP } = require('./_ajudaBanco');

const { SUPABASE_URL } = process.env;
const SUPABASE_ANON_KEY = require('../utils/chavesSupabase').chavePublica();

/** "AAAA-MM-DD" de quem faz `anos` anos HOJE (UTC, a régua do motor), deslocada `dias`. 29/02 cai em 28/02. */
function aniversarioHoje(anos, dias = 0) {
  const h = new Date();
  let d = new Date(Date.UTC(h.getUTCFullYear() - anos, h.getUTCMonth(), h.getUTCDate()));
  if (d.getUTCMonth() !== h.getUTCMonth()) d = new Date(Date.UTC(h.getUTCFullYear() - anos, h.getUTCMonth() + 1, 0));
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

test('a régua é de 18 anos, com a frase da casa', () => {
  assert.equal(IDADE_MINIMA, 18);
  assert.equal(MSG_MENOR, 'O Futty é para maiores de 18 anos.');
});

test('régua: faz 18 hoje entra, faz 18 amanhã não; 29/02; datas impossíveis', () => {
  const hoje = new Date(Date.UTC(2026, 8, 25)); // 25/09/2026
  assert.equal(idadeEm('2008-09-25', hoje), 18);
  assert.equal(idadeEm('2008-09-26', hoje), 17);
  assert.equal(menorQueIdadeMinima('2008-09-25', hoje), false, 'faz 18 hoje: pode');
  assert.equal(menorQueIdadeMinima('2008-09-26', hoje), true, 'faz 18 amanhã: ainda não');
  assert.equal(temIdadeMinima('2008-09-25', hoje), true);
  assert.equal(temIdadeMinima('2008-09-26', hoje), false);
  assert.equal(idadeEm('2008-02-29', new Date(Date.UTC(2026, 1, 28))), 17);
  assert.equal(idadeEm('2008-02-29', new Date(Date.UTC(2026, 2, 1))), 18);
  assert.equal(dataDeNascimentoValida('2026-02-30'), null, 'data que não existe');
  assert.equal(dataDeNascimentoValida('1899-12-31'), null);
  assert.equal(dataDeNascimentoValida('2999-01-01'), null, 'futuro');
  assert.equal(dataDeNascimentoValida('25/09/2000'), null);
  assert.equal(dataDeNascimentoValida('2000-09-25T10:00:00Z'), '2000-09-25');
  assert.equal(menorQueIdadeMinima(null), false, 'sem data não decide nada para o cadastro');
  assert.equal(temIdadeMinima(null), false, 'sem data não vale como 18 (fail-closed)');
});

test('o limite exato vale com a data de hoje de verdade (a mesma conta que o app faz)', () => {
  assert.equal(menorQueIdadeMinima(aniversarioHoje(18)), false, 'faz 18 hoje: entra');
  assert.equal(menorQueIdadeMinima(aniversarioHoje(18, 1)), true, 'faz 18 amanhã: não entra');
  assert.equal(menorQueIdadeMinima(aniversarioHoje(18, -1)), false, 'fez 18 ontem: entra');
});

test('2ª linha (rosto público e anúncio 18+): ehAdulto usa a mesma régua e falha para o lado seguro', () => {
  assert.equal(ehAdulto(aniversarioHoje(18)), true, 'faz 18 hoje');
  assert.equal(ehAdulto(aniversarioHoje(18, 1)), false, 'faz 18 amanhã');
  assert.equal(ehAdulto(aniversarioHoje(17)), false);
  assert.equal(ehAdulto('1990-01-01'), true);
  assert.equal(ehAdulto('1990-01-01T00:00:00+00:00'), true, 'timestamp do banco também vale');
  assert.equal(ehAdulto(null), false, 'sem data: silhueta / sem anúncio 18+');
  assert.equal(ehAdulto('lixo'), false);
});

// ─── Contra o motor e o Supabase ─────────────────────────────────────────────
let server;
let baseUrl;
const contas = [];

before(async () => {
  if (!COM_BANCO) return;
  if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_PUBLISHABLE_KEY (ou a antiga SUPABASE_ANON_KEY) em falta no .env.');
  server = app.listen(0);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!COM_BANCO) return;
  for (const c of contas) await supabase.auth.admin.deleteUser(c.id).catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function criarConta({ onboardingConcluido = false } = {}) {
  const email = `teste-idade-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
  const password = `Fx7!${crypto.randomUUID()}`;
  const { data, error } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: onboardingConcluido ? { onboarding_completo: true } : {},
  });
  if (error) throw error;
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: sessao, error: erroSessao } = await anon.auth.signInWithPassword({ email, password });
  if (erroSessao) throw erroSessao;
  const conta = { id: data.user.id, token: sessao.session.access_token };
  contas.push(conta);
  return conta;
}

function pedir(metodo, path, token, body) {
  return fetch(`${baseUrl}${path}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: metodo === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}

async function contaExiste(id) {
  const { data } = await supabase.auth.admin.getUserById(id);
  return !!data?.user;
}

const anosAtras = (n) => `${new Date().getUTCFullYear() - n}-06-15`;

test('onboarding (Google/Apple): data de menor de 18 → 403 MENOR_DE_18 e a conta some', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const conta = await criarConta();
  await pedir('GET', '/api/me', conta.token); // cria a linha em public.users, como o app faz
  const r = await pedir('PATCH', '/api/me', conta.token, { birthdate: anosAtras(10) });
  assert.equal(r.status, 403);
  const corpo = await r.json();
  assert.equal(corpo.code, 'MENOR_DE_18');
  assert.match(corpo.error, /maiores de 18 anos/);
  assert.equal(await contaExiste(conta.id), false, 'a conta de menor de 18 continuou existindo');
  const { data: linha } = await supabase.from('users').select('id').eq('id', conta.id).maybeSingle();
  assert.equal(linha, null, 'a linha em public.users ficou');
  const depois = await pedir('GET', '/api/me', conta.token);
  assert.equal(depois.status, 401, 'o token da conta apagada continuou valendo');
});

test('onboarding: 17 anos (o que tinha passado na régua de 13) agora é barrado', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const conta = await criarConta();
  await pedir('GET', '/api/me', conta.token);
  const r = await pedir('PATCH', '/api/me', conta.token, { birthdate: aniversarioHoje(17) });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'MENOR_DE_18');
  assert.equal(await contaExiste(conta.id), false);
});

test('onboarding: faz 18 amanhã → barrado; faz 18 hoje → entra e conclui', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const amanha = await criarConta();
  await pedir('GET', '/api/me', amanha.token);
  const barrada = await pedir('PATCH', '/api/me', amanha.token, { birthdate: aniversarioHoje(18, 1) });
  assert.equal(barrada.status, 403, 'faz 18 amanhã entrou');
  assert.equal((await barrada.json()).code, 'MENOR_DE_18');
  assert.equal(await contaExiste(amanha.id), false);

  const hoje = await criarConta();
  await pedir('GET', '/api/me', hoje.token);
  const r = await pedir('PATCH', '/api/me', hoje.token, { birthdate: aniversarioHoje(18) });
  assert.equal(r.status, 200, 'faz 18 hoje foi barrado');
  const fim = await pedir('POST', '/api/me/onboarding-completo', hoje.token);
  assert.equal(fim.status, 200);
  assert.equal(await contaExiste(hoje.id), true);
});

test('onboarding: 20 anos segue normal e conclui', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const conta = await criarConta();
  await pedir('GET', '/api/me', conta.token);
  const r = await pedir('PATCH', '/api/me', conta.token, { birthdate: anosAtras(20) });
  assert.equal(r.status, 200);
  const fim = await pedir('POST', '/api/me/onboarding-completo', conta.token);
  assert.equal(fim.status, 200);
  assert.equal(await contaExiste(conta.id), true);
});

test('cadastro por e-mail com data de menor de 18 (forçado) → a conclusão do onboarding apaga a conta', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const conta = await criarConta();
  await pedir('GET', '/api/me', conta.token);
  // o que o ensureUserRow grava a partir do metadata do signUp — aqui direto, sem depender da trava da 071
  await supabase.from('users').update({ birthdate: anosAtras(9) }).eq('id', conta.id);
  const r = await pedir('POST', '/api/me/onboarding-completo', conta.token);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'MENOR_DE_18');
  assert.equal(await contaExiste(conta.id), false);
});

test('conta que já existia (onboarding concluído) não é apagada pelo motor (a tela de exclusão é do app)', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const conta = await criarConta({ onboardingConcluido: true });
  await pedir('GET', '/api/me', conta.token);
  const r = await pedir('PATCH', '/api/me', conta.token, { birthdate: anosAtras(10) });
  assert.equal(r.status, 200, 'conta existente foi barrada pela regra do cadastro');
  assert.equal(await contaExiste(conta.id), true);
  const eu = await (await pedir('GET', '/api/me', conta.token)).json();
  assert.equal(eu.user.birthdate, anosAtras(10), 'o motor devolve a data para o app decidir a tela');
});
