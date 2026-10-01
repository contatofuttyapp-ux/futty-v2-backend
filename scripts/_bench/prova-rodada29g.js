// ═══════════════════════════════════════════════════════════════════════════════
// CONTAS DESCARTÁVEIS DA RODADA 29G (1-out) — para a cena `rodada29g` do scripts/ver-iphone.mjs.
//
// O Futty é 18+ de ponta a ponta. A cena prova pela tela, em servidor LOCAL (nunca a produção —
// CLAUDE.md, 25-set):
//   · cadastro por e-mail com menor (faz 18 amanhã) e com maior (faz 18 hoje);
//   · conta que JÁ existia com data menor de 18 → tela com a frase + "Excluir minha conta";
//   · conta existente sem data → entra normal, com o pedido da data no Início (e a data de menor
//     salva por ali também leva à tela);
//   · Termos e Privacidade com a cláusula de 18 anos.
// Nada gera figurinha (custo de IA zero). Tudo @futtymock. A cena NUNCA exclui conta de verdade:
// toda escrita à /api e o signUp são interceptados.
//
//   node scripts/_bench/prova-rodada29g.js            cria/refaz as contas e grava as sessões
//   node scripts/_bench/prova-rodada29g.js --apagar   apaga as contas
//
// Sai em ../frontend/scripts/capturas/sessao-rodada29g.json (fora do git).
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('../../utils/db');
const { apagarUsuario } = require('../../utils/apagarUsuario');
const { chavePublica } = require('../../utils/chavesSupabase');

const SENHA = 'Prova!Rodada29G-2026';
const DESTINO = path.join(__dirname, '..', '..', '..', 'frontend', 'scripts', 'capturas', 'sessao-rodada29g.json');

// Nascimento "17 anos atrás, hoje" (UTC): menor de 18 qualquer que seja o dia da prova.
const dezessete = (() => {
  const h = new Date();
  return `${h.getUTCFullYear() - 17}-${String(h.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(h.getUTCDate(), 28)).padStart(2, '0')}`;
})();

const CONTAS = {
  // Conta que já existia (onboarding concluído) com data de menor de 18: vê a tela de exclusão.
  menor: { email: 'prova-r29g-menor@futtymock.com', nome: 'MENOR29G', nasc: dezessete },
  // Conta que já existia, sem data: entra normal; o Início pede a data.
  semData: { email: 'prova-r29g-semdata@futtymock.com', nome: 'SEMDATA29G', nasc: null },
};

const tem = (n) => process.argv.includes(`--${n}`);

async function acharPorEmail(email) {
  const { data } = await supabase.auth.admin.listUsers({ perPage: 200 });
  return (data?.users || []).find((u) => (u.email || '').toLowerCase() === email) || null;
}

async function limpar() {
  for (const { email } of Object.values(CONTAS)) {
    const u = await acharPorEmail(email);
    if (u) await apagarUsuario(u.id).catch((e) => console.warn(`limpeza ${email}:`, e.message));
  }
  fs.rmSync(DESTINO, { force: true });
}

async function sessaoDe(email) {
  const anon = createClient(process.env.SUPABASE_URL, chavePublica(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password: SENHA });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  return [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(data.session) }];
}

(async () => {
  if (tem('apagar')) {
    await limpar();
    console.log('contas da rodada 29G apagadas.');
    return;
  }
  await limpar();

  for (const def of Object.values(CONTAS)) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: def.email, password: SENHA, email_confirm: true,
      user_metadata: { nome: def.nome, onboarding_completo: true },
    });
    if (error) throw new Error(`createUser ${def.email}: ${error.message}`);
    const linha = { id: data.user.id, email: def.email, nome: def.nome, nome_jogador: def.nome, birthdate: def.nasc };
    const { error: eUp } = await supabase.from('users').upsert(linha, { onConflict: 'id' });
    if (eUp) throw new Error(`users ${def.email}: ${eUp.message}`);
  }
  console.log(`✓ ${Object.keys(CONTAS).length} contas prontas (existente com 17 anos; existente sem data).`);

  const sessoes = {
    menor: await sessaoDe(CONTAS.menor.email),
    semData: await sessaoDe(CONTAS.semData.email),
  };
  fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
  fs.writeFileSync(DESTINO, JSON.stringify(sessoes, null, 2));
  console.log(`sessões em ${DESTINO}`);
})().catch((e) => { console.error('[prova-rodada29g] ERRO:', e.message); process.exit(1); });
