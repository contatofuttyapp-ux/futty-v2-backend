// ═══════════════════════════════════════════════════════════════════════════════
// CONTA DESCARTÁVEL PARA AS PROVAS DE TELA (22-set, Figurinha 3).
//
// A conta demo-loja tem a Brilhante das lojas e NÃO pode ser desfeita para
// provar a figurinha comum. Este script cria (ou refaz) uma conta @futtymock
// limpa — sem foto, sem figurinha, onboarding por fazer — e escreve a sessão
// num JSON que o scripts/ver-iphone.mjs do frontend lê com --sessao.
//
//   node scripts/_bench/conta-de-prova.js                      cria/refaz e grava a sessão
//   node scripts/_bench/conta-de-prova.js --apagar             apaga a conta
//   node scripts/_bench/conta-de-prova.js --credito 1          cria com N créditos (pede a 054)
//
// A sessão sai em ../frontend/scripts/capturas/sessao-prova.json (fora do git).
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('../../utils/db');
const { apagarUsuario } = require('../../utils/apagarUsuario');

const EMAIL = 'prova-figurinha3@futtymock.com';
const SENHA = 'Prova!Figurinha3-2026';
const DESTINO = path.join(__dirname, '..', '..', '..', 'frontend', 'scripts', 'capturas', 'sessao-prova.json');

const arg = (n, o = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : o;
};
const tem = (n) => process.argv.includes(`--${n}`);

async function acharPorEmail(email) {
  const { data } = await supabase.auth.admin.listUsers({ perPage: 200 });
  return (data?.users || []).find((u) => (u.email || '').toLowerCase() === email) || null;
}

(async () => {
  const existente = await acharPorEmail(EMAIL);

  if (tem('apagar')) {
    if (!existente) { console.log('não existe, nada a apagar.'); return; }
    await apagarUsuario(existente.id).catch((e) => console.warn('apagarUsuario:', e.message));
    console.log('conta de prova apagada.');
    return;
  }

  // Refaz do zero: a prova precisa de uma conta SEM foto e SEM figurinha, e a
  // corrida anterior deixou-a com as duas.
  if (existente) {
    await apagarUsuario(existente.id).catch((e) => console.warn('limpeza:', e.message));
  }
  const { data: criado, error } = await supabase.auth.admin.createUser({
    email: EMAIL, password: SENHA, email_confirm: true,
  });
  if (error) { console.error('createUser:', error.message); process.exit(1); }
  const userId = criado.user.id;

  // Nome de jogador, para a placa do card não sair "JOGADOR".
  await supabase.from('users').upsert({ id: userId, email: EMAIL, nome_jogador: 'PROVA' }, { onConflict: 'id' });

  const credito = Number(arg('credito', '0'));
  if (credito > 0) {
    const { error: erroCred } = await supabase.from('users').update({ brilhante_creditos: credito }).eq('id', userId);
    if (erroCred) console.warn(`crédito NÃO dado (migração 054 aplicada?): ${erroCred.message}`);
    else console.log(`crédito: ${credito}`);
  }

  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data: sessao, error: erroLogin } = await anon.auth.signInWithPassword({ email: EMAIL, password: SENHA });
  if (erroLogin) { console.error('login:', erroLogin.message); process.exit(1); }

  // O formato que o ver-iphone.mjs espera em --sessao: as chaves do
  // localStorage do Supabase Auth.
  const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  const linhas = [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(sessao.session) }];
  fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
  fs.writeFileSync(DESTINO, JSON.stringify(linhas, null, 2));

  console.log(`conta de prova pronta: ${EMAIL} (${userId})`);
  console.log(`sessão em ${DESTINO}`);
})();
