// Futty v2.0 — RODADA 20: contas + convite reutilizável para a cena
// "rodada-20" do ver-iphone.mjs. Cria um time descartável com um convite já
// usado por UMA conta, para a 2ª conta (cuja sessão a cena usa) entrar pelo
// MESMO link — a prova visual de que o link não morre no 1º uso. Também
// grava a sessão de uma conta nova (sem figurinha) e lê a senha real da
// demo-loja (LOJA/demo-senha.txt) para as duas capturas do interruptor.
//
//   node scripts/_bench/prova-rodada20.js            cria tudo
//   node scripts/_bench/prova-rodada20.js --apagar   desfaz (não toca a demo-loja)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('../../utils/db');
const { apagarUsuario } = require('../../utils/apagarUsuario');

const APAGAR = process.argv.includes('--apagar');
const SLUG = 'prova-convite-r20';
const SENHA = 'Prova!Rodada20-2026';
const PASTA_CAPTURAS = path.join(__dirname, '..', '..', '..', 'frontend', 'scripts', 'capturas');
const EMAIL_DEMO = 'demo-loja@futtymock.com';
const ARQ_SENHA_DEMO = path.join(__dirname, '..', '..', '..', '..', 'LOJA', 'demo-senha.txt');

const PAPEIS = {
  capitao: 'prova-r20-capitao@futtymock.com',
  primeiro: 'prova-r20-primeiro@futtymock.com',
  segundo: 'prova-r20-segundo@futtymock.com',
  contaNova: 'prova-r20-nova@futtymock.com',
};

async function acharPorEmail(email) {
  const { data } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
  return data?.id || null;
}

async function limpar() {
  const { data: time } = await supabase.from('teams').select('id').eq('slug', SLUG).maybeSingle();
  if (time) await supabase.from('teams').delete().eq('id', time.id);
  for (const email of Object.values(PAPEIS)) {
    const id = await acharPorEmail(email);
    if (id) await apagarUsuario(id);
  }
  for (const f of ['sessao-rodada20-capitao.json', 'sessao-rodada20-segundo.json', 'sessao-rodada20-nova.json', 'sessao-rodada20-demo.json', 'estado-rodada20.json']) {
    fs.rmSync(path.join(PASTA_CAPTURAS, f), { force: true });
  }
  console.log('time e contas da prova-rodada20 apagados (demo-loja intocada).');
}

async function sessaoDe(email, senha) {
  const anon = createClient(process.env.SUPABASE_URL, require('../../utils/chavesSupabase').chavePublica());
  const { data, error } = await anon.auth.signInWithPassword({ email, password: senha });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  return [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(data.session) }];
}

async function main() {
  const ids = {};
  for (const [papel, email] of Object.entries(PAPEIS)) {
    const { data, error } = await supabase.auth.admin.createUser({
      email, password: SENHA, email_confirm: true,
      user_metadata: { nome: `Prova R20 ${papel}`, onboarding_completo: true },
    });
    if (error) throw new Error(`createUser ${email}: ${error.message}`);
    ids[papel] = data.user.id;
    const { error: eUp } = await supabase.from('users').upsert({ id: data.user.id, email, nome_jogador: papel }, { onConflict: 'id' });
    if (eUp) throw new Error(`users ${email}: ${eUp.message}`);
  }
  console.log('✓ 4 contas descartáveis prontas.');

  const { data: time, error: eTime } = await supabase.from('teams').insert({
    nome: 'Prova Convite', slug: SLUG, cor: 'roxo', criado_por: ids.capitao,
    publica: false, modo_visibilidade: 'privado', descricao: 'Time descartável — prova do convite reutilizável.',
  }).select().single();
  if (eTime) throw new Error(`teams: ${eTime.message}`);
  const { error: eMembro } = await supabase.from('team_members').insert({ team_id: time.id, user_id: ids.capitao, role: 'admin' });
  if (eMembro) throw new Error(`team_members: ${eMembro.message}`);
  console.log(`✓ time "${SLUG}" criado, capitão é admin.`);

  // Convite (30 dias, igual à rota real) já usado por UMA conta ("primeiro").
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
  const { data: convite, error: eConvite } = await supabase
    .from('convites').insert({ team_id: time.id, token, criado_por: ids.capitao, expires_at: expiresAt }).select('id, token').single();
  if (eConvite) throw new Error(`convites: ${eConvite.message}`);

  const { error: eMembroPrimeiro } = await supabase.from('team_members').insert({ team_id: time.id, user_id: ids.primeiro, role: 'member' });
  if (eMembroPrimeiro) throw new Error(`team_members(primeiro): ${eMembroPrimeiro.message}`);
  const { error: eUso } = await supabase.from('convite_usos').insert({ convite_id: convite.id, user_id: ids.primeiro });
  if (eUso) throw new Error(`convite_usos: ${eUso.message}`);
  console.log(`✓ convite ${token} já usado por "primeiro" — "segundo" vai tentar o MESMO link na cena.`);

  fs.mkdirSync(PASTA_CAPTURAS, { recursive: true });
  fs.writeFileSync(path.join(PASTA_CAPTURAS, 'sessao-rodada20-capitao.json'), JSON.stringify(await sessaoDe(PAPEIS.capitao, SENHA), null, 2));
  fs.writeFileSync(path.join(PASTA_CAPTURAS, 'sessao-rodada20-segundo.json'), JSON.stringify(await sessaoDe(PAPEIS.segundo, SENHA), null, 2));
  fs.writeFileSync(path.join(PASTA_CAPTURAS, 'sessao-rodada20-nova.json'), JSON.stringify(await sessaoDe(PAPEIS.contaNova, SENHA), null, 2));

  if (fs.existsSync(ARQ_SENHA_DEMO)) {
    const senhaDemo = fs.readFileSync(ARQ_SENHA_DEMO, 'utf8').match(/senha: (.+)/)[1].trim();
    fs.writeFileSync(path.join(PASTA_CAPTURAS, 'sessao-rodada20-demo.json'), JSON.stringify(await sessaoDe(EMAIL_DEMO, senhaDemo), null, 2));
    console.log('✓ sessão da demo-loja gravada (LOJA/demo-senha.txt).');
  } else {
    console.warn(`! ${ARQ_SENHA_DEMO} não encontrado — a cena vai pular a captura da demo.`);
  }

  fs.writeFileSync(path.join(PASTA_CAPTURAS, 'estado-rodada20.json'), JSON.stringify({ teamSlug: SLUG, tokenUsado: token }, null, 2));
  console.log(`\nEquipa: /equipa/${SLUG} (como capitão) · Convite já usado: /convite/${token} (como "segundo")`);
}

(async () => {
  try {
    if (APAGAR) await limpar();
    else await main();
  } catch (e) {
    console.error('[prova-rodada20] ERRO:', e.message);
    process.exitCode = 1;
  }
})();
