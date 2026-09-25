// ═══════════════════════════════════════════════════════════════════════════════
// TIME DESCARTÁVEL PARA A PROVA DO PACOTE (22-set, Figurinha 3 bloco 2).
//
// O percurso do pacote tem TRÊS pessoas: o dono pede a ativação, o super-admin
// ativa no Gabinete, e o membro é quem gera. A conta-de-prova.js faz uma conta
// só — esta faz as três e o time que as junta, e escreve as três sessões num
// JSON que o scripts/ver-iphone.mjs do frontend lê com --sessoes.
//
//   node scripts/_bench/time-de-prova.js            cria/refaz e grava as sessões
//   node scripts/_bench/time-de-prova.js --apagar   apaga time e contas
//
// O super-admin é uma conta @futtymock descartável com `is_super_admin` ligado,
// nunca a do Pedro: uma prova não entra na conta do dono.
//
// Sai em ../frontend/scripts/capturas/sessao-time.json (fora do git).
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('../../utils/db');
const { apagarUsuario } = require('../../utils/apagarUsuario');

const SENHA = 'Prova!Pacote3-2026';
const PAPEIS = {
  dono: 'prova-pacote-dono@futtymock.com',
  membro: 'prova-pacote-membro@futtymock.com',
  super: 'prova-pacote-super@futtymock.com',
};
const SLUG = 'time-de-prova-brilhantes';
const DESTINO = path.join(__dirname, '..', '..', '..', 'frontend', 'scripts', 'capturas', 'sessao-time.json');

const tem = (n) => process.argv.includes(`--${n}`);

async function acharPorEmail(email) {
  const { data } = await supabase.auth.admin.listUsers({ perPage: 200 });
  return (data?.users || []).find((u) => (u.email || '').toLowerCase() === email) || null;
}

/** Sessão no formato do localStorage do Supabase Auth (o que o --sessoes espera). */
async function sessaoDe(email) {
  const anon = createClient(process.env.SUPABASE_URL, require('../../utils/chavesSupabase').chavePublica());
  const { data, error } = await anon.auth.signInWithPassword({ email, password: SENHA });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  return [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(data.session) }];
}

async function limpar() {
  const { data: time } = await supabase.from('teams').select('id').eq('slug', SLUG).maybeSingle();
  if (time) {
    // brilhantes_time cai por CASCADE com o time; os pedidos também.
    await supabase.from('teams').delete().eq('id', time.id);
  }
  for (const email of Object.values(PAPEIS)) {
    const u = await acharPorEmail(email);
    if (u) await apagarUsuario(u.id).catch((e) => console.warn(`limpeza ${email}:`, e.message));
  }
}

(async () => {
  if (tem('apagar')) {
    await limpar();
    fs.rmSync(DESTINO, { force: true });
    console.log('time e contas de prova apagados.');
    return;
  }

  // Refaz do zero: a prova precisa do membro SEM foto e SEM figurinha, e o
  // time sem pacote — a corrida anterior deixa as três coisas feitas.
  await limpar();

  const ids = {};
  for (const [papel, email] of Object.entries(PAPEIS)) {
    // `onboarding_completo` vive no user_metadata do Auth (routes/auth.js), e o
    // portão do frontend devolve TUDO a /onboarding sem ele. O dono e o
    // super-admin já entram com ele: o cadastro deles não é o que esta prova
    // mede. O MEMBRO não — é ele quem faz o caminho todo, da foto à Brilhante.
    const { data, error } = await supabase.auth.admin.createUser({
      email, password: SENHA, email_confirm: true,
      user_metadata: papel === 'membro' ? {} : { onboarding_completo: true },
    });
    if (error) { console.error(`createUser ${email}:`, error.message); process.exit(1); }
    ids[papel] = data.user.id;
    await supabase.from('users').upsert(
      { id: data.user.id, email, nome_jogador: papel.toUpperCase(), is_super_admin: papel === 'super' },
      { onConflict: 'id' },
    );
  }

  const { data: time, error: erroTime } = await supabase
    .from('teams')
    .insert({ nome: 'Time de Prova', slug: SLUG, cor: '#d4a017', criado_por: ids.dono })
    .select('id, nome, slug')
    .single();
  if (erroTime) { console.error('createTeam:', erroTime.message); process.exit(1); }

  const { error: erroMembros } = await supabase.from('team_members').insert([
    { team_id: time.id, user_id: ids.dono, role: 'admin' },
    { team_id: time.id, user_id: ids.membro, role: 'member' },
  ]);
  if (erroMembros) { console.error('team_members:', erroMembros.message); process.exit(1); }

  // O dono cria o time por fora, portanto não passa pelo POST /api/teams —
  // logo não recebe o presente do criador. É de propósito: esta prova é do
  // PACOTE, e um crédito solto no dono mascararia o direito que se quer medir.
  const sessoes = { time, ids };
  for (const papel of Object.keys(PAPEIS)) sessoes[papel] = await sessaoDe(PAPEIS[papel]);

  fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
  fs.writeFileSync(DESTINO, JSON.stringify(sessoes, null, 2));

  console.log(`time de prova pronto: ${time.nome} (${time.slug})`);
  console.log(`  dono   ${PAPEIS.dono} (${ids.dono})`);
  console.log(`  membro ${PAPEIS.membro} (${ids.membro})`);
  console.log(`  super  ${PAPEIS.super} (${ids.super})`);
  console.log(`sessões em ${DESTINO}`);
})();
