// Rodada 28 (bloco C) — cadastro só a partir de 13 anos (LGPD art. 14).
//
// O que isto prova:
//   1. a régua (utils/idade.js): aniversário hoje conta, véspera não; 29/02; datas impossíveis e
//      futuras são recusadas;
//   2. no cadastro (onboarding por concluir), menor de 13 não fica com conta: o PATCH da data (passo
//      do onboarding de quem entrou com Google/Apple) e a conclusão do onboarding (data que veio do
//      cadastro por e-mail) apagam a conta e respondem 403 MENOR_DE_13 — o mesmo token deixa de valer;
//   3. 13 anos ou mais segue normal; conta que já existia (onboarding concluído) não é tocada.
//
// Contas descartáveis @futtymock, contra o Supabase de verdade (padrão da casa).
require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@supabase/supabase-js');
const { dataDeNascimentoValida, idadeEm, menorQueIdadeMinima } = require('../utils/idade');
const { app, supabase } = require('../server');

const { SUPABASE_URL } = process.env;
const SUPABASE_ANON_KEY = require('../utils/chavesSupabase').chavePublica();

test('régua: aniversário de 13 hoje pode, véspera não; 29/02; datas impossíveis', () => {
  const hoje = new Date(Date.UTC(2026, 8, 25)); // 25/09/2026
  assert.equal(idadeEm('2013-09-25', hoje), 13);
  assert.equal(idadeEm('2013-09-26', hoje), 12);
  assert.equal(menorQueIdadeMinima('2013-09-25', hoje), false, 'faz 13 hoje: pode');
  assert.equal(menorQueIdadeMinima('2013-09-26', hoje), true, 'faz 13 amanhã: ainda não');
  assert.equal(idadeEm('2012-02-29', new Date(Date.UTC(2025, 1, 28))), 12);
  assert.equal(idadeEm('2012-02-29', new Date(Date.UTC(2025, 2, 1))), 13);
  assert.equal(dataDeNascimentoValida('2026-02-30'), null, 'data que não existe');
  assert.equal(dataDeNascimentoValida('1899-12-31'), null);
  assert.equal(dataDeNascimentoValida('2999-01-01'), null, 'futuro');
  assert.equal(dataDeNascimentoValida('25/09/2000'), null);
  assert.equal(dataDeNascimentoValida('2000-09-25T10:00:00Z'), '2000-09-25');
  assert.equal(menorQueIdadeMinima(null), false, 'sem data não decide nada');
});

// ─── Contra o motor e o Supabase ─────────────────────────────────────────────
let server;
let baseUrl;
const contas = [];

before(async () => {
  if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_PUBLISHABLE_KEY (ou a antiga SUPABASE_ANON_KEY) em falta no .env.');
  server = app.listen(0);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
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

test('onboarding (Google/Apple): data de menor de 13 → 403 MENOR_DE_13 e a conta some', async () => {
  const conta = await criarConta();
  await pedir('GET', '/api/me', conta.token); // cria a linha em public.users, como o app faz
  const r = await pedir('PATCH', '/api/me', conta.token, { birthdate: anosAtras(10) });
  assert.equal(r.status, 403);
  const corpo = await r.json();
  assert.equal(corpo.code, 'MENOR_DE_13');
  assert.match(corpo.error, /maiores de 13 anos/);
  assert.equal(await contaExiste(conta.id), false, 'a conta de menor de 13 continuou existindo');
  const { data: linha } = await supabase.from('users').select('id').eq('id', conta.id).maybeSingle();
  assert.equal(linha, null, 'a linha em public.users ficou');
  const depois = await pedir('GET', '/api/me', conta.token);
  assert.equal(depois.status, 401, 'o token da conta apagada continuou valendo');
});

test('onboarding: 13 anos ou mais segue normal e conclui', async () => {
  const conta = await criarConta();
  await pedir('GET', '/api/me', conta.token);
  const r = await pedir('PATCH', '/api/me', conta.token, { birthdate: anosAtras(20) });
  assert.equal(r.status, 200);
  const fim = await pedir('POST', '/api/me/onboarding-completo', conta.token);
  assert.equal(fim.status, 200);
  assert.equal(await contaExiste(conta.id), true);
});

test('cadastro por e-mail com data de menor de 13 (forçado) → a conclusão do onboarding apaga a conta', async () => {
  const conta = await criarConta();
  await pedir('GET', '/api/me', conta.token);
  // o que o ensureUserRow grava a partir do metadata do signUp — aqui direto, sem depender da trava da 062
  await supabase.from('users').update({ birthdate: anosAtras(9) }).eq('id', conta.id);
  const r = await pedir('POST', '/api/me/onboarding-completo', conta.token);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'MENOR_DE_13');
  assert.equal(await contaExiste(conta.id), false);
});

test('conta que já existia (onboarding concluído) não é tocada', async () => {
  const conta = await criarConta({ onboardingConcluido: true });
  await pedir('GET', '/api/me', conta.token);
  const r = await pedir('PATCH', '/api/me', conta.token, { birthdate: anosAtras(10) });
  assert.equal(r.status, 200, 'conta existente foi barrada pela regra do cadastro');
  assert.equal(await contaExiste(conta.id), true);
});
