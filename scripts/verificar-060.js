#!/usr/bin/env node
// Futty v2.0 — A migração 060 (a foto do Google não é figurinha, Hotfix 26) já foi aplicada?
//
// Não há ligação direta ao Postgres nesta máquina (só a API REST do Supabase), então o
// que se confere é o COMPORTAMENTO, e não o catálogo:
//   1. o trigger handle_new_user: cria UMA conta descartável com a foto do Google no
//      metadata e olha o que o trigger gravou em public.users.avatar_url. NULL = a 060 já
//      foi aplicada; a URL do Google = o trigger antigo ainda copia. A conta é apagada.
//   2. o reparo: quantas contas têm avatar_url fora dos nossos buckets (avatars, kits) nem
//      são avatares migrados da V1. Depois da 060 deve ser 0.
// O motor funciona igual com ou sem a 060 (utils/figurinhaRegra.js); ela limpa a causa.
//
// Uso: node scripts/verificar-060.js   (a partir de backend/; sai com 0 se tudo em ordem)
require('dotenv').config({ quiet: true });
const crypto = require('node:crypto');
const { supabase } = require('../utils/db');

const GOOGLE = 'https://lh3.googleusercontent.com/a/ACg8ocK-sonda060=s96-c';
const NOSSA = /\/storage\/v1\/object\/public\/(avatars|kits)\/|^\/public\/avatares\//;

async function sondaDoTrigger() {
  const email = `sonda-060-${Date.now()}-${crypto.randomInt(1e6)}@futtymock.com`;
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: `Fx7!${crypto.randomUUID()}`,
    email_confirm: true,
    user_metadata: { full_name: 'Sonda 060', avatar_url: GOOGLE },
  });
  if (error) throw new Error(`não consegui criar a conta descartável: ${error.message}`);
  const id = data.user.id;
  try {
    const { data: linha, error: lerErr } = await supabase.from('users').select('avatar_url, nome').eq('id', id).maybeSingle();
    if (lerErr) throw new Error(lerErr.message);
    if (!linha) return { estado: 'sem-linha' };
    return { estado: linha.avatar_url === GOOGLE ? 'copia' : linha.avatar_url == null ? 'nao-copia' : 'outro', nome: linha.nome };
  } finally {
    await supabase.auth.admin.deleteUser(id).catch((e) => console.warn('! não consegui apagar a conta descartável', id, e.message));
  }
}

(async () => {
  const trigger = await sondaDoTrigger();
  const { data: contas, error } = await supabase.from('users').select('id, avatar_url').not('avatar_url', 'is', null);
  if (error) throw new Error(error.message);
  const deFora = (contas || []).filter((c) => !NOSSA.test(c.avatar_url));

  const ok1 = trigger.estado === 'nao-copia';
  const ok2 = deFora.length === 0;
  console.log(`${ok1 ? '✅' : '❌'} trigger handle_new_user: ${{
    'nao-copia': 'já NÃO copia a foto do Google (060 aplicada)',
    copia: 'AINDA copia a foto do Google para avatar_url (060 por aplicar)',
    'sem-linha': 'o trigger nem criou a linha em public.users (estranho: ver o trigger on_auth_user_created)',
    outro: 'gravou um avatar_url inesperado',
  }[trigger.estado]}`);
  console.log(`${ok2 ? '✅' : '❌'} reparo: ${deFora.length} conta(s) com avatar_url fora dos nossos buckets${ok2 ? '' : ` (ids: ${deFora.map((c) => c.id).join(', ')})`}`);
  process.exit(ok1 && ok2 ? 0 : 1);
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(2);
});
