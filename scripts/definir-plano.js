// Futty v2.0 — Ferramenta definitiva do dono para mudar o plano de uma conta
// pelo service key, sem passar pelo painel Super (útil quando é o próprio
// dono a testar um plano pago, ex.: uniformes do Elite).
//
// Uso:
//   node scripts/definir-plano.js <email> <free|pro|elite>              → SIMULAÇÃO (default), mostra antes/depois sem gravar
//   node scripts/definir-plano.js <email> <free|pro|elite> --confirmo   → grava de verdade
//
// Mesmo padrão de dupla-checagem do limpar-usuarios-teste.js: sem --confirmo
// nada é alterado, só relatado.
require('dotenv').config();
const { supabase } = require('../utils/db');

const PLANOS = ['free', 'pro', 'elite'];

async function main() {
  const [emailArg, planoArg, ...resto] = process.argv.slice(2);
  const confirmou = resto.includes('--confirmo');

  if (!emailArg || !planoArg) {
    console.error('[definir-plano] Uso: node scripts/definir-plano.js <email> <free|pro|elite> [--confirmo]');
    process.exit(1);
  }
  const email = emailArg.toLowerCase();
  if (!PLANOS.includes(planoArg)) {
    console.error(`[definir-plano] Plano inválido: "${planoArg}". Use um de: ${PLANOS.join(', ')}.`);
    process.exit(1);
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('id, nome, email, plan')
    .eq('email', email)
    .maybeSingle();
  if (error) {
    console.error(`[definir-plano] ERRO ao buscar usuário: ${error.message}`);
    process.exit(1);
  }
  if (!user) {
    console.error(`[definir-plano] Nenhum usuário com o e-mail "${email}".`);
    process.exit(1);
  }

  console.log(`[definir-plano] ${user.email} (${user.nome || 'sem nome'}, id ${user.id})`);
  console.log(`[definir-plano] plano atual: ${user.plan || 'free'}`);

  if (user.plan === planoArg) {
    console.log(`[definir-plano] já está em "${planoArg}" — nada a fazer.`);
    return;
  }

  console.log(`[definir-plano] plano novo:   ${planoArg}`);

  if (!confirmou) {
    console.log('\n[definir-plano] simulação — nada foi alterado. Rode com --confirmo para gravar de verdade.');
    return;
  }

  const { data: atualizado, error: upErr } = await supabase
    .from('users')
    .update({ plan: planoArg })
    .eq('id', user.id)
    .select('id, nome, email, plan')
    .single();
  if (upErr) {
    console.error(`[definir-plano] ERRO ao gravar: ${upErr.message}`);
    process.exit(1);
  }

  console.log(`\n[definir-plano] OK — ${atualizado.email}: ${user.plan || 'free'} → ${atualizado.plan}`);
}

main().catch((e) => {
  console.error(`[definir-plano] ERRO: ${e.message}`);
  process.exit(1);
});
