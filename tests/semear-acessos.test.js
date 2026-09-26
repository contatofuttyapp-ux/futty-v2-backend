// Pagamentos P2 — scripts/semear-acessos.js (CONTAS.md → Gabinete "Acessos & contas"), sem banco.
//
// O que isto prova:
//   1. as tabelas do CONTAS.md viram linhas com serviço, para quê, site, entra com e custo — a coluna
//      2FA fica de fora, o negrito some e pedaço de cartão ("cartão ••2419") nunca passa;
//   2. completar NUNCA troca o que já está na tabela (o dono pode ter editado): só preenche vazio e
//      acrescenta o serviço que falta;
//   3. a trava do Gabinete vale para a coluna nova: um custo com cara de chave derruba a gravação.
//
// Uso: npm test  (ou: node --test tests/semear-acessos.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lerContas, paraAcesso, completar, limparCusto } = require('../scripts/semear-acessos');

const CONTAS = [
  '# Contas do Futty',
  '',
  '## Contas do app',
  '',
  '| serviço | para quê | entra com | 2FA | custo €/mês |',
  '|---|---|---|---|---|',
  '| Supabase (projeto futty-v2, SP) | banco + login + fotos | GitHub | ✅ (via GitHub) | €21,92 (US$25) |',
  '| Resend | e-mails do app | ? | — | |',
  '| Loja Nova | teste | e-mail | — | €1,00 |',
  '',
  '## Pessoais',
  '',
  '| serviço | para quê | entra com | 2FA | custo €/mês |',
  '|---|---|---|---|---|',
  '| Claude (claude.ai) — plano Max | ferramenta | Google | ✅ | **€122,24** (renova dia 12; cartão ••2419 → trocar em 2-out) |',
].join('\n');

test('lerContas: as duas tabelas, sem a coluna 2FA; paraAcesso põe o id do SEED e o site conhecido', () => {
  const contas = lerContas(CONTAS);
  assert.equal(contas.length, 4);
  assert.deepEqual(Object.keys(contas[0]).sort(), ['custo', 'entra_com', 'para_que', 'servico']);
  const supabase = paraAcesso(contas[0]);
  assert.equal(supabase.id, 'supabase');
  assert.equal(supabase.site, 'https://supabase.com/dashboard/project/ynzmjcvqdljffgbeqglh');
  assert.equal(supabase.custo_eur, '€21,92 (US$25)');
  assert.equal(supabase.obs, '');
  assert.equal(paraAcesso(contas[2]).id, 'loja-nova', 'serviço desconhecido: id pelo nome, sem site');
});

test('limparCusto: sem negrito e sem pedaço de cartão', () => {
  const claude = paraAcesso(lerContas(CONTAS)[3]);
  assert.equal(claude.custo_eur, '€122,24 (renova dia 12)');
  assert.ok(!/cart|••|2419/.test(claude.custo_eur));
  assert.equal(limparCusto(''), '');
});

test('completar: nunca troca o que existe, preenche só o vazio e acrescenta o que falta', () => {
  const existentes = [
    { id: 'supabase', servico: 'Supabase', para_que: 'escrito à mão pelo dono', site: 'https://outro', entra_com: '', obs: 'nota' },
    { id: 'resend', servico: 'Resend', para_que: 'e-mails', site: 'https://resend.com/emails', entra_com: 'Google', custo_eur: 'grátis', obs: '' },
  ];
  const { lista, novas, preenchidas } = completar(existentes, lerContas(CONTAS));
  const supabase = lista.find((a) => a.id === 'supabase');
  assert.equal(supabase.para_que, 'escrito à mão pelo dono');
  assert.equal(supabase.site, 'https://outro');
  assert.equal(supabase.entra_com, 'GitHub', 'vazio → preenchido');
  assert.equal(supabase.custo_eur, '€21,92 (US$25)');
  assert.equal(supabase.obs, 'nota');
  assert.equal(lista.find((a) => a.id === 'resend').custo_eur, 'grátis');
  assert.equal(novas, 2, 'Loja Nova e Claude entram no fim');
  assert.equal(preenchidas, 2);
  assert.equal(lista.length, 4);
});

// A validação pura (a mesma que o gravar() chama ANTES de escrever) — nunca o gravar() de verdade:
// se a trava um dia quebrasse, o teste escreveria no Storage de produção.
test('a trava do Gabinete vale para o custo: cara de chave → 400', () => {
  const { validarAcessos } = require('../utils/gabineteStore');
  assert.throws(() => validarAcessos([{ id: 'x', servico: 'X', custo_eur: 'isto-nao-e-uma-chave-real-apenas-um-teste-da-trava-do-gabinete' }]), (e) => e.status === 400);
  assert.throws(() => validarAcessos([{ id: 'x', servico: 'X', obs: 'eyJhbGciOiJIUzI1NiJ9.token' }]), (e) => e.status === 400);
  const contas = lerContas(CONTAS).map(paraAcesso);
  assert.equal(validarAcessos(contas), contas, 'o que vem do CONTAS.md passa');
});
