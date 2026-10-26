// O Futty é para quem tem 13 anos ou mais (decisão do dono, 16-out; de 1-out a 16-out foi 18). A maioridade (18) continua sendo a
// régua do rosto público e do anúncio 18+.
//
// O que isto prova:
//   1. a régua do cadastro (utils/idade.js): faz 13 HOJE entra, faz 13 AMANHÃ não; 29/02; datas impossíveis e futuras são recusadas;
//   2. a maioridade é outra régua: ehAdulto (rosto público) só com 18 confirmados — 13 a 17 continuam em silhueta;
//   3. no cadastro (onboarding por concluir), abaixo de 13 não fica com conta: o PATCH da data (passo do onboarding de quem entrou com
//      Google/Apple) e a conclusão do onboarding (data que veio do cadastro por e-mail) apagam a conta e respondem 403 MENOR_DE_IDADE;
//   4. 13 anos ou mais segue normal; conta que já existia (onboarding concluído) não é apagada pelo motor — a tela de exclusão é do app.
//
// Os testes de 3 e 4 usam contas descartáveis @futtymock contra o Supabase de verdade (FUTTY_TESTES_COM_BANCO=1); a prova sem banco
// do mesmo caminho está em tests/idade-13-rota.test.js.
require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@supabase/supabase-js');
const { IDADE_MINIMA, MAIORIDADE, MSG_MENOR, dataDeNascimentoValida, idadeEm, menorQueIdadeMinima, temMaioridade } = require('../utils/idade');
const { ehAdulto } = require('../utils/rostoPublico');
const { app, supabase } = require('../server');
const { COM_BANCO, MOTIVO_SKIP } = require('./_ajudaBanco');

const { SUPABASE_URL } = process.env;
const SUPABASE_PUBLISHABLE_KEY = require('../utils/chavesSupabase').chavePublica();

/** "AAAA-MM-DD" de quem faz `anos` anos HOJE (UTC, a régua do motor), deslocada `dias`. 29/02 cai em 28/02. */
function aniversarioHoje(anos, dias = 0) {
  const h = new Date();
  let d = new Date(Date.UTC(h.getUTCFullYear() - anos, h.getUTCMonth(), h.getUTCDate()));
  if (d.getUTCMonth() !== h.getUTCMonth()) d = new Date(Date.UTC(h.getUTCFullYear() - anos, h.getUTCMonth() + 1, 0));
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

test('a régua do cadastro é de 13 anos e a maioridade de 18, com a frase da casa', () => {
  assert.equal(IDADE_MINIMA, 13);
  assert.equal(MAIORIDADE, 18);
  assert.equal(MSG_MENOR, 'O Futty é para quem tem 13 anos ou mais.');
});

test('régua: faz 13 hoje entra, faz 13 amanhã não; 29/02; datas impossíveis', () => {
  const hoje = new Date(Date.UTC(2026, 9, 16)); // 16/10/2026
  assert.equal(idadeEm('2013-10-16', hoje), 13);
  assert.equal(idadeEm('2013-10-17', hoje), 12);
  assert.equal(menorQueIdadeMinima('2013-10-16', hoje), false, 'faz 13 hoje: pode');
  assert.equal(menorQueIdadeMinima('2013-10-17', hoje), true, 'faz 13 amanhã: ainda não');
  assert.equal(menorQueIdadeMinima('2009-10-17', hoje), false, '16 anos: pode (era barrado na régua de 18)');
  assert.equal(temMaioridade('2008-10-16', hoje), true, 'faz 18 hoje: maior');
  assert.equal(temMaioridade('2008-10-17', hoje), false, 'faz 18 amanhã: ainda não');
  assert.equal(idadeEm('2012-02-29', new Date(Date.UTC(2025, 1, 28))), 12);
  assert.equal(idadeEm('2012-02-29', new Date(Date.UTC(2025, 2, 1))), 13);
  assert.equal(dataDeNascimentoValida('2026-02-30'), null, 'data que não existe');
  assert.equal(dataDeNascimentoValida('1899-12-31'), null);
  assert.equal(dataDeNascimentoValida('2999-01-01'), null, 'futuro');
  assert.equal(dataDeNascimentoValida('25/09/2000'), null);
  assert.equal(dataDeNascimentoValida('2000-09-25T10:00:00Z'), '2000-09-25');
  assert.equal(menorQueIdadeMinima(null), false, 'sem data não decide nada para o cadastro');
  assert.equal(temMaioridade(null), false, 'sem data não vale como 18 (fail-closed)');
});

test('o limite exato vale com a data de hoje de verdade (a mesma conta que o app faz)', () => {
  assert.equal(menorQueIdadeMinima(aniversarioHoje(13)), false, 'faz 13 hoje: entra');
  assert.equal(menorQueIdadeMinima(aniversarioHoje(13, 1)), true, 'faz 13 amanhã: não entra');
  assert.equal(menorQueIdadeMinima(aniversarioHoje(13, -1)), false, 'fez 13 ontem: entra');
  assert.equal(menorQueIdadeMinima(aniversarioHoje(12)), true, '12 anos: não entra');
});

test('rosto público e anúncio 18+: ehAdulto exige 18 confirmados (13 a 17 ficam em silhueta) e falha para o lado seguro', () => {
  assert.equal(ehAdulto(aniversarioHoje(18)), true, 'faz 18 hoje');
  assert.equal(ehAdulto(aniversarioHoje(18, 1)), false, 'faz 18 amanhã');
  assert.equal(ehAdulto(aniversarioHoje(17)), false);
  assert.equal(ehAdulto(aniversarioHoje(13)), false, '13 anos: conta existe, rosto não sai');
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
  if (!SUPABASE_PUBLISHABLE_KEY) throw new Error('SUPABASE_PUBLISHABLE_KEY em falta no .env.');
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
  const anon = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
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

test('onboarding (Google/Apple): data abaixo de 13 → 403 MENOR_DE_IDADE e a conta some', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const conta = await criarConta();
  await pedir('GET', '/api/me', conta.token); // cria a linha em public.users, como o app faz
  const r = await pedir('PATCH', '/api/me', conta.token, { birthdate: anosAtras(10) });
  assert.equal(r.status, 403);
  const corpo = await r.json();
  assert.equal(corpo.code, 'MENOR_DE_IDADE');
  assert.match(corpo.error, /13 anos ou mais/);
  assert.equal(await contaExiste(conta.id), false, 'a conta abaixo de 13 continuou existindo');
  const { data: linha } = await supabase.from('users').select('id').eq('id', conta.id).maybeSingle();
  assert.equal(linha, null, 'a linha em public.users ficou');
  const depois = await pedir('GET', '/api/me', conta.token);
  assert.equal(depois.status, 401, 'o token da conta apagada continuou valendo');
});

test('onboarding: 16 anos (barrado na régua de 18) agora entra e conclui', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const conta = await criarConta();
  await pedir('GET', '/api/me', conta.token);
  const r = await pedir('PATCH', '/api/me', conta.token, { birthdate: aniversarioHoje(16) });
  assert.equal(r.status, 200);
  const fim = await pedir('POST', '/api/me/onboarding-completo', conta.token);
  assert.equal(fim.status, 200);
  assert.equal(await contaExiste(conta.id), true);
});

test('onboarding: faz 13 amanhã → barrado; faz 13 hoje → entra e conclui', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const amanha = await criarConta();
  await pedir('GET', '/api/me', amanha.token);
  const barrada = await pedir('PATCH', '/api/me', amanha.token, { birthdate: aniversarioHoje(13, 1) });
  assert.equal(barrada.status, 403, 'faz 13 amanhã entrou');
  assert.equal((await barrada.json()).code, 'MENOR_DE_IDADE');
  assert.equal(await contaExiste(amanha.id), false);

  const hoje = await criarConta();
  await pedir('GET', '/api/me', hoje.token);
  const r = await pedir('PATCH', '/api/me', hoje.token, { birthdate: aniversarioHoje(13) });
  assert.equal(r.status, 200, 'faz 13 hoje foi barrado');
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

test('cadastro por e-mail com data abaixo de 13 (forçado) → a conclusão do onboarding apaga a conta', { skip: !COM_BANCO && MOTIVO_SKIP }, async () => {
  const conta = await criarConta();
  await pedir('GET', '/api/me', conta.token);
  // o que o ensureUserRow grava a partir do metadata do signUp — aqui direto, sem depender da trava do banco (085)
  await supabase.from('users').update({ birthdate: anosAtras(9) }).eq('id', conta.id);
  const r = await pedir('POST', '/api/me/onboarding-completo', conta.token);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'MENOR_DE_IDADE');
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
