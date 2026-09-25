// ═══════════════════════════════════════════════════════════════════════════════
// CONTA DESCARTÁVEL NO ESTADO DO BUG DO "TROCAR FOTO" (Hotfix 26, 25-set).
//
// Para a cena 'hotfix26' do scripts/ver-iphone.mjs (frontend), que prova pela tela
// que trocar a foto de uma conta SEM figurinha muda o card. O estado é o que o
// trigger handle_new_user (001) deixava em quem entrava com o Google: uma foto
// (foto_url) e um avatar_url DIFERENTE dela que não é figurinha nossa. Sem
// figurinha de verdade: nada em brilhantes_time, nada em user_avatar_historico,
// nenhum arquivo -ai- no bucket avatars.
//
// A "foto do Google" aqui é uma silhueta do bucket `kits`: uma imagem qualquer que
// abre numa bancada sem internet liberada e que também não é figurinha nossa (a
// regra olha o NOME do arquivo, utils/figurinhaRegra.js). O upsert grava o estado
// direto, então vale igual antes e depois da migração 060.
//
//   node scripts/_bench/conta-hotfix26.js            cria/refaz a conta e grava a sessão
//   node scripts/_bench/conta-hotfix26.js --apagar   apaga a conta (e os arquivos dela)
//
// A sessão sai em ../frontend/scripts/capturas/sessao-hotfix26.json (fora do git).
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('../../utils/db');
const { apagarUsuario } = require('../../utils/apagarUsuario');

const EMAIL = 'prova-hotfix26@futtymock.com';
const SENHA = 'Prova!Hotfix26-2026';
const DESTINO = path.join(__dirname, '..', '..', '..', 'frontend', 'scripts', 'capturas', 'sessao-hotfix26.json');
const KITS = `${process.env.SUPABASE_URL}/storage/v1/object/public/kits`;
const FOTO_ANTERIOR = `${KITS}/kit1-dark-gold.png`; // "a foto que ela já tinha subido"
const AVATAR_DE_FORA = `${KITS}/avatar-generico-1.png`; // o que o Google deixou em avatar_url

async function acharPorEmail(email) {
  const { data } = await supabase.auth.admin.listUsers({ perPage: 200 });
  return (data?.users || []).find((u) => (u.email || '').toLowerCase() === email) || null;
}

(async () => {
  const existente = await acharPorEmail(EMAIL);

  if (process.argv.includes('--apagar')) {
    if (existente) {
      await apagarUsuario(existente.id).catch((e) => console.warn('apagarUsuario:', e.message));
      console.log('conta do hotfix26 apagada.');
    } else {
      console.log('não existe, nada a apagar.');
    }
    fs.rmSync(DESTINO, { force: true });
    return;
  }

  // Refaz do zero: a cena troca a foto de verdade, e a corrida anterior deixou a conta mudada.
  if (existente) await apagarUsuario(existente.id).catch((e) => console.warn('limpeza:', e.message));

  const { data: criado, error } = await supabase.auth.admin.createUser({
    email: EMAIL,
    password: SENHA,
    email_confirm: true,
    // Como a conta Google nasce: nome e avatar_url no metadata. Onboarding já feito.
    user_metadata: { nome: 'Prova Hotfix 26', full_name: 'Prova Hotfix 26', avatar_url: AVATAR_DE_FORA, onboarding_completo: true },
  });
  if (error) { console.error('createUser:', error.message); process.exit(1); }
  const userId = criado.user.id;

  const { error: erroUsuario } = await supabase.from('users').upsert(
    { id: userId, email: EMAIL, nome: 'Prova Hotfix 26', nome_jogador: 'Hotfix26', foto_url: FOTO_ANTERIOR, avatar_url: AVATAR_DE_FORA },
    { onConflict: 'id' },
  );
  if (erroUsuario) { console.error('users:', erroUsuario.message); process.exit(1); }

  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data: sessao, error: erroLogin } = await anon.auth.signInWithPassword({ email: EMAIL, password: SENHA });
  if (erroLogin) { console.error('login:', erroLogin.message); process.exit(1); }

  // O formato que o ver-iphone.mjs espera: as chaves do localStorage do Supabase Auth.
  const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
  fs.writeFileSync(DESTINO, JSON.stringify([{ name: `sb-${ref}-auth-token`, value: JSON.stringify(sessao.session) }], null, 2));

  console.log(`conta pronta: ${EMAIL} (${userId})`);
  console.log(`  foto_url   = ${FOTO_ANTERIOR}`);
  console.log(`  avatar_url = ${AVATAR_DE_FORA}  (≠ foto_url, e não é figurinha nossa)`);
  console.log(`sessão em ${DESTINO}`);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
