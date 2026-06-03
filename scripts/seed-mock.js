// Futty v2.0 — Seed de dados mock para testar o sorteio.
// Cria utilizadores no Supabase Auth, perfis em public.users e adiciona-os
// como membros da equipa indicada.
//
// Uso:  node scripts/seed-mock.js
// Requer: backend/.env com SUPABASE_URL e SUPABASE_SERVICE_KEY.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[seed] Faltam SUPABASE_URL / SUPABASE_SERVICE_KEY no backend/.env');
  process.exit(1);
}

// --- Configuração ---------------------------------------------------------
const TEAM_SLUG = 'teste-1-ktbig';
// A constraint da BD só permite 'admin' | 'member'. 'jogador' = 'member'.
const ROLE = 'member';
const PASSWORD = 'FuttyMock123!';
const NOMES = [
  'Gui', 'Jefin', 'Kleverton', 'Kimzera', 'Gabriel',
  'Wesley', 'Eduardo', 'Marcus', 'Erick', 'Matheus',
];
const emailFor = (nome) => `${nome.toLowerCase()}@futtymock.com`;
// -------------------------------------------------------------------------

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function getExistingAuthUsers() {
  // Mapa email -> id (até 1000 utilizadores)
  const map = {};
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`listUsers: ${error.message}`);
  for (const u of data.users) map[u.email?.toLowerCase()] = u.id;
  return map;
}

async function main() {
  // 1) Resolve a equipa pelo slug
  const { data: team, error: teamErr } = await supabase
    .from('teams')
    .select('id, nome, slug')
    .eq('slug', TEAM_SLUG)
    .maybeSingle();

  if (teamErr) throw new Error(`teams: ${teamErr.message}`);
  if (!team) throw new Error(`Equipa com slug "${TEAM_SLUG}" não encontrada.`);
  console.log(`[seed] Equipa: ${team.nome} (${team.id})`);

  const existing = await getExistingAuthUsers();

  let criadosAuth = 0;
  let reutilizados = 0;
  let perfis = 0;
  let membros = 0;

  for (const nome of NOMES) {
    const email = emailFor(nome);

    // 1) Utilizador no Auth (cria ou reutiliza se já existir)
    let userId = existing[email];
    if (userId) {
      reutilizados += 1;
      console.log(`  - ${nome.padEnd(10)} já existia (${email})`);
    } else {
      const { data: created, error: createErr } = await supabase.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { nome },
      });
      if (createErr) {
        console.error(`  ! ${nome}: erro a criar auth user -> ${createErr.message}`);
        continue;
      }
      userId = created.user.id;
      criadosAuth += 1;
      console.log(`  + ${nome.padEnd(10)} criado (${email})`);
    }

    // 2) Perfil em public.users (o trigger pode já ter criado; garantimos o nome)
    const { error: profileErr } = await supabase
      .from('users')
      .upsert({ id: userId, email, nome }, { onConflict: 'id' });
    if (profileErr) {
      console.error(`  ! ${nome}: erro no perfil -> ${profileErr.message}`);
    } else {
      perfis += 1;
    }

    // 3) Membro da equipa
    const { error: memberErr } = await supabase
      .from('team_members')
      .upsert(
        { user_id: userId, team_id: team.id, role: ROLE },
        { onConflict: 'user_id,team_id' }
      );
    if (memberErr) {
      console.error(`  ! ${nome}: erro a adicionar à equipa -> ${memberErr.message}`);
    } else {
      membros += 1;
    }
  }

  console.log('\n[seed] Resumo:');
  console.log(`  Auth users criados : ${criadosAuth}`);
  console.log(`  Auth users reutilizados: ${reutilizados}`);
  console.log(`  Perfis (public.users) garantidos: ${perfis}/${NOMES.length}`);
  console.log(`  Membros da equipa garantidos: ${membros}/${NOMES.length} (role='${ROLE}')`);
}

main().catch((err) => {
  console.error('[seed] ERRO:', err.message);
  process.exit(1);
});
