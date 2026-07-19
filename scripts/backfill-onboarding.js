// Futty v2.0 — Backfill P1-1: marca onboarding_completo=true no user_metadata
// de TODAS as contas de Auth que já existem (grandfather). Contas criadas
// DEPOIS deste backfill nascem sem a flag → vêem o onboarding dia-1 uma vez.
// Corre à mão UMA vez: `node scripts/backfill-onboarding.js`.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  let page = 1;
  let marcados = 0;
  let saltados = 0;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data?.users || [];
    if (!users.length) break;
    for (const u of users) {
      if (u.user_metadata?.onboarding_completo === true) {
        saltados += 1;
        continue;
      }
      const meta = { ...(u.user_metadata || {}), onboarding_completo: true };
      const { error: upErr } = await supabase.auth.admin.updateUserById(u.id, { user_metadata: meta });
      if (upErr) {
        console.error('  falhou', u.email, upErr.message);
        continue;
      }
      marcados += 1;
    }
    if (users.length < 200) break;
    page += 1;
  }
  console.log(`[backfill-onboarding] concluído — marcados ${marcados}, já-completos ${saltados}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
