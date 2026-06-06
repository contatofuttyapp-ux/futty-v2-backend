// Futty v2.0 — Normaliza os avatar_url da tabela users para URLs absolutas.
//
// Caminhos relativos do backend (ex.: /public/avatares/verde/gui.png) passam a
// URLs absolutas (BASE_URL + caminho). Genéricos do frontend (/avatares/...) e
// URLs já absolutas (http/https) são ignorados.
//
// Uso:
//   node backend/scripts/normalizar-avatares.js --dry-run   (não escreve)
//   node backend/scripts/normalizar-avatares.js             (aplica na BD)
//
// Idempotente: ao correr de novo, os já-absolutos são ignorados.

const { supabase } = require('../utils/db');

const DRY = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

// Base do backend (sem slash final). Em produção define-se API_BASE_URL.
let BASE_URL = process.env.API_BASE_URL || process.env.VITE_API_URL || 'http://localhost:3001';
BASE_URL = BASE_URL.replace(/\/+$/, '');

const stats = { normalizados: 0, jaCorretos: 0, erros: 0 };
const ok = (m) => console.log(`✅ ${m}`);
const skip = (m) => console.log(`⚠️  ${m}`);
const err = (m) => console.log(`❌ ${m}`);
const info = (m) => console.log(`ℹ️  ${m}`);

(async () => {
  console.log(`\n=== Normalizar avatar_url ${DRY ? '(DRY-RUN — sem escrever)' : '(A ESCREVER NA BD)'} ===`);
  info(`BASE_URL: ${BASE_URL}`);

  const { data: users, error } = await supabase
    .from('users')
    .select('id, email, avatar_url')
    .not('avatar_url', 'is', null);
  if (error) {
    err(`Ler users: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  info(`Users com avatar_url: ${users.length}`);

  for (const u of users) {
    const url = String(u.avatar_url || '').trim();
    if (!url) continue;

    // Já absoluto → correcto.
    if (/^https?:\/\//i.test(url)) {
      skip(`${u.email} → já correcto (absoluto)`);
      stats.jaCorretos += 1;
      continue;
    }
    // Genérico servido pelo frontend (Vite) → não normalizar.
    if (url.startsWith('/avatares/')) {
      skip(`${u.email} → genérico do frontend (ignorado)`);
      stats.jaCorretos += 1;
      continue;
    }

    // Caminho relativo do backend (/public/... ou outro) → BASE_URL + caminho.
    const novo = `${BASE_URL}${url.startsWith('/') ? url : `/${url}`}`;

    if (DRY) {
      ok(`[dry] ${u.email} → ${novo}`);
      stats.normalizados += 1;
      continue;
    }

    const { error: ue } = await supabase.from('users').update({ avatar_url: novo }).eq('id', u.id);
    if (ue) {
      err(`${u.email}: ${ue.message}`);
      stats.erros += 1;
    } else {
      ok(`${u.email} → ${novo}`);
      stats.normalizados += 1;
    }
  }

  console.log('─────────────────────────────────────');
  console.log(`Normalizados : ${stats.normalizados}`);
  console.log(`Já correctos : ${stats.jaCorretos}`);
  console.log(`Erros        : ${stats.erros}`);
  if (DRY) console.log('\n(DRY-RUN: nada foi escrito.)');
  process.exitCode = stats.erros > 0 ? 1 : 0;
})().catch((e) => {
  err(e.message);
  process.exitCode = 1;
});
