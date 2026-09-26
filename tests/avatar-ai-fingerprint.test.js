// Futty v2.0 — Teste do slot de avatar IA preso à foto errada (build 9,
// achado real nos logs do Cloud Run): POST /api/me/avatar seguido de POST
// /api/me/avatar/ai devolvia "slot reutilizado (sem geração, sem quota)" em
// 136ms mesmo depois de uma foto NOVA — o slot foi gerado da foto ANTIGA e o
// motor não tinha como saber que a foto tinha mudado (nada ligava o slot à
// foto que o gerou).
//
// Fix: user_avatar_slots ganhou foto_fingerprint (migração 052, = foto_hash
// da migração 048); routes/auth.js só reutiliza o slot se a fingerprint
// gravada nele bater com a foto_hash ATUAL do usuário.
//
// Este teste NÃO passa por fal.ai de verdade (indisponível neste ambiente,
// ver CLAUDE.md — "fal.run não tem DNS"): monta o cenário directamente no
// banco (mesmo padrão dos outros testes, conta real descartável) e confirma
// só a DECISÃO de reutilizar ou não — nunca uma geração completa.
//
// A migração 052 é DDL manual (ver o próprio arquivo) — enquanto o Pedro não
// a correr no Supabase, os dois testes abaixo saem "skipped", não "failed":
// scripts/conferir-migracoes.js já é quem aponta "falta aplicar" de forma
// acionável; este arquivo não devia ficar vermelho por um passo que não é
// dele (mesmo raciocínio do IF NOT EXISTS nas migrações — o lado seguro do
// desconhecido não é gritar).
//
// Uso: npm test  (ou: node --test tests/)
require('dotenv').config();
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@supabase/supabase-js');
const { app, supabase } = require('../server');
const { COM_BANCO, MOTIVO_SKIP } = require('./_ajudaBanco');

const { SUPABASE_URL } = process.env;
const SUPABASE_ANON_KEY = require('../utils/chavesSupabase').chavePublica();
const KIT = 'dark-gold'; // grátis, sempre ativo — nenhum gate de plano no caminho

let server;
let baseUrl;
let accessToken;
let testUserId;
let migracao052Pendente = false;

before(async () => {
  if (!COM_BANCO) return;
  if (!SUPABASE_ANON_KEY) throw new Error('SUPABASE_PUBLISHABLE_KEY (ou a antiga SUPABASE_ANON_KEY) em falta no .env — precisa dela para assinar sessão de teste.');

  // Sonda barata (mesma lógica de scripts/conferir-migracoes.js): sem a
  // coluna, os testes abaixo saem skipped em vez de failed.
  const sonda = await supabase.from('user_avatar_slots').select('foto_fingerprint').limit(1);
  if (sonda.error?.code === '42703' || sonda.error?.code === 'PGRST204') {
    migracao052Pendente = true;
    return; // sem servidor, sem conta de teste — nada disto é preciso só para constatar isto
  }

  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const email = `teste-fingerprint-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
  const password = `Fx7!${crypto.randomUUID()}`;
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (createErr) throw createErr;
  testUserId = created.user.id;

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({ email, password });
  if (signInErr) throw signInErr;
  accessToken = signIn.session.access_token;

  // users precisa existir (trigger de signUp já cria a linha em public.users,
  // mas foto_url/foto_hash começam vazios) — grava a foto A directo no banco,
  // sem passar por Storage/upload real (o teste é da DECISÃO, não do upload).
  const { error: upErr } = await supabase.from('users').update({
    foto_url: 'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/avatars/public/fake-fingerprint-test.jpg',
    foto_hash: 'hash-foto-A',
  }).eq('id', testUserId);
  if (upErr) throw upErr;

  // Slot já existente, gerado (supostamente) a partir da foto A.
  const { error: slotErr } = await supabase.from('user_avatar_slots').upsert(
    { user_id: testUserId, kit_id: KIT, avatar_url: 'https://exemplo.com/avatar-da-foto-A.png', foto_fingerprint: 'hash-foto-A' },
    { onConflict: 'user_id,kit_id' }
  );
  if (slotErr) throw slotErr;
});

after(async () => {
  if (!COM_BANCO) return;
  if (testUserId) {
    try {
      await supabase.from('user_avatar_slots').delete().eq('user_id', testUserId);
    } catch {
      /* tabela/coluna pode não existir ainda (migração pendente) — não é o que o after() precisa garantir */
    }
    await supabase.auth.admin.deleteUser(testUserId).catch(() => {});
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

function pedir(metodo, path, { token, body, timeoutMs } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, {
    method: metodo,
    headers,
    body: metodo === 'GET' ? undefined : JSON.stringify(body ?? {}),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
}

test('mesma foto (fingerprint bate) -> reutiliza o slot, sem gerar', { skip: !COM_BANCO && MOTIVO_SKIP }, async (t) => {
  if (migracao052Pendente) return t.skip('migração 052 (user_avatar_slots.foto_fingerprint) ainda não aplicada no banco — ver scripts/conferir-migracoes.js');
  const res = await pedir('POST', '/api/me/avatar/ai', { token: accessToken, body: { kit: KIT } });
  assert.equal(res.status, 200, `devia reutilizar (200), deu ${res.status}`);
  const corpo = await res.json();
  assert.equal(corpo.do_slot, true, 'do_slot devia ser true (reutilizou)');
  assert.equal(corpo.reutilizado, true, 'reutilizado devia ser true — é o campo que o frontend lê para avisar o usuário');
  assert.equal(corpo.avatar_url, 'https://exemplo.com/avatar-da-foto-A.png', 'devia devolver o avatar do SLOT existente, sem gerar de novo');
});

test('foto NOVA (fingerprint não bate) -> NÃO reutiliza o slot da foto antiga', { skip: !COM_BANCO && MOTIVO_SKIP }, async (t) => {
  if (migracao052Pendente) return t.skip('migração 052 (user_avatar_slots.foto_fingerprint) ainda não aplicada no banco — ver scripts/conferir-migracoes.js');
  // Troca a foto (B): mesmo efeito de POST /api/me/avatar com uma foto diferente —
  // muda foto_hash sem tocar no slot (é exatamente o que o upload real faz).
  const { error } = await supabase.from('users').update({ foto_hash: 'hash-foto-B' }).eq('id', testUserId);
  if (error) throw error;

  // Passado o check de fingerprint (é o que este teste mede), a rota segue
  // para gerar de verdade via fal.ai — indisponível nesta máquina (sem DNS
  // para fal.run, ver CLAUDE.md). timeoutMs curto: não é isso que se mede
  // aqui, e sem prazo o teste ficava preso no timeout de rede do SO (minutos).
  let res;
  let corpo = {};
  try {
    res = await pedir('POST', '/api/me/avatar/ai', { token: accessToken, body: { kit: KIT }, timeoutMs: 10_000 });
    corpo = await res.json().catch(() => ({}));
  } catch (e) {
    // abort/timeout ou erro de rede a caminho do fal.ai — também prova que
    // NÃO voltou instantaneamente com o slot antigo (esse caminho é síncrono
    // e rápido, sem tocar na rede externa).
    res = { status: 0 };
    corpo = { _erroRede: e.message };
  }
  // Não pode ser o caminho de reuso: nem 200 com o avatar da foto A, nem
  // reutilizado:true.
  const reutilizouSlotAntigo = res.status === 200 && corpo.avatar_url === 'https://exemplo.com/avatar-da-foto-A.png';
  assert.equal(reutilizouSlotAntigo, false, `com foto nova, NUNCA pode devolver o avatar da foto antiga — devolveu status ${res.status} corpo ${JSON.stringify(corpo)}`);
  assert.notEqual(corpo.reutilizado, true, 'reutilizado não pode ser true com a foto trocada');
});
