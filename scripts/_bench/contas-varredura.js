// ═══════════════════════════════════════════════════════════════════════════════
// CONTAS DESCARTÁVEIS PARA A VARREDURA GERAL PÓS-FIGURINHA 3 (22-set).
//
// Os 4 papéis do roteiro (App.jsx logado como cada um):
//   novo     conta nova sem time (onboarding feito, figurinha comum, zero times)
//   membro   membro de um time sem Brilhante (comum, sem crédito, time sem pacote)
//   dono     dono de time — SEM time ainda: a cena de varredura cria o time pela
//            UI de propósito (é a própria prova de "criar time → presente →
//            Brilhante"), depois vira "dono de time com Brilhante"
//   super    super-admin (comum, is_super_admin)
//   convidado uma 5ª conta, à parte dos 4 papéis — só para a prova do convite
//            (entra pelo link, pede, leva recusa, vê o recado)
//
// novo/membro/super nascem já com a figurinha COMUM pronta (copiada do mesmo
// objeto de Storage da conta demo-loja — o modelo fictício de sempre, nunca
// uma pessoa real) para a varredura focar nas ROTAS, não em repetir o
// onboarding 4 vezes. `dono` nasce SEM foto — é a UI de criar time que a leva
// para lá pela primeira vez.
//
//   node scripts/_bench/contas-varredura.js                cria as 5 e grava as sessões
//   node scripts/_bench/contas-varredura.js --apagar        apaga tudo (contas + o time, se existir)
//   node scripts/_bench/contas-varredura.js --entrar-membro
//       depois da cena "criar time" ter corrido (acha o time pelo criado_por
//       = dono, não precisa saber o slug), põe `membro` lá — sem Brilhante
// ═════════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('../../utils/db');
const { apagarUsuario } = require('../../utils/apagarUsuario');

const SENHA = 'Prova!Varredura3-2026';
const PAPEIS = {
  novo: 'varredura-novo@futtymock.com',
  membro: 'varredura-membro@futtymock.com',
  dono: 'varredura-dono@futtymock.com',
  super: 'varredura-super@futtymock.com',
  convidado: 'varredura-convidado@futtymock.com',
};
const DESTINO = path.join(__dirname, '..', '..', '..', 'frontend', 'scripts', 'capturas', 'sessao-varredura.json');

const arg = (n, o = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : o;
};
const tem = (n) => process.argv.includes(`--${n}`);

async function acharPorEmail(email) {
  const { data } = await supabase.auth.admin.listUsers({ perPage: 200 });
  return (data?.users || []).find((u) => (u.email || '').toLowerCase() === email) || null;
}

async function limpar() {
  // O time nasce pela UI da cena "criar time" (nome livre, slug decidido pelo
  // servidor) — acha-se pelo dono, não por um slug fixo.
  const dono = await acharPorEmail(PAPEIS.dono);
  if (dono) {
    const { data: time } = await supabase.from('teams').select('id').eq('criado_por', dono.id).maybeSingle();
    if (time) await supabase.from('teams').delete().eq('id', time.id);
  }
  for (const email of Object.values(PAPEIS)) {
    const u = await acharPorEmail(email);
    if (u) await apagarUsuario(u.id).catch((e) => console.warn(`limpeza ${email}:`, e.message));
  }
}

async function sessaoDe(email) {
  const anon = createClient(process.env.SUPABASE_URL, require('../../utils/chavesSupabase').chavePublica());
  const { data, error } = await anon.auth.signInWithPassword({ email, password: SENHA });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  return [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(data.session) }];
}

(async () => {
  if (tem('apagar')) {
    await limpar();
    fs.rmSync(DESTINO, { force: true });
    console.log('contas e time da varredura apagados.');
    return;
  }

  if (tem('entrar-membro')) {
    const membro = await acharPorEmail(PAPEIS.membro);
    const dono = await acharPorEmail(PAPEIS.dono);
    if (!membro || !dono) { console.error('contas "membro"/"dono" não existem — corra sem flags primeiro.'); process.exit(1); }
    const { data: time, error: erroTime } = await supabase.from('teams').select('id, nome, slug').eq('criado_por', dono.id).maybeSingle();
    if (erroTime) { console.error('achar o time do dono:', erroTime.message); process.exit(1); }
    if (!time) { console.error('o dono ainda não criou nenhum time — corra a cena "criar time" primeiro.'); process.exit(1); }
    const { error } = await supabase.from('team_members').upsert(
      { team_id: time.id, user_id: membro.id, role: 'member' },
      { onConflict: 'team_id,user_id' },
    );
    if (error) { console.error('entrar-membro:', error.message); process.exit(1); }
    console.log(`membro (${PAPEIS.membro}) agora está em "${time.nome}" (${time.slug}) — sem Brilhante, sem crédito.`);
    return;
  }

  await limpar(); // refaz do zero: a varredura precisa de estado limpo e previsível

  // O molde da figurinha COMUM: o mesmo objeto de Storage da conta demo-loja
  // (nunca gera nada na hora, nunca é foto de gente real).
  const { data: molde, error: erroMolde } = await supabase
    .from('users').select('foto_url, foto_hash').eq('email', 'demo-loja@futtymock.com').maybeSingle();
  if (erroMolde || !molde?.foto_url) { console.error('molde (demo-loja) indisponível:', erroMolde?.message || 'sem foto_url'); process.exit(1); }

  const ids = {};
  for (const [papel, email] of Object.entries(PAPEIS)) {
    const { data, error } = await supabase.auth.admin.createUser({
      email, password: SENHA, email_confirm: true,
      // Onboarding já feito para todos (§3: cadastro não gera nada — não é o
      // que esta varredura mede) menos `dono`: a cena da varredura leva-a a
      // criar o time pela primeira vez, e é aí que ela vê a Figurinha comum
      // nascer, exatamente como uma pessoa nova veria.
      user_metadata: papel === 'dono' ? {} : { onboarding_completo: true },
    });
    if (error) { console.error(`createUser ${email}:`, error.message); process.exit(1); }
    ids[papel] = data.user.id;

    const linha = { id: data.user.id, email, nome_jogador: papel.toUpperCase(), is_super_admin: papel === 'super' };
    if (papel !== 'dono') {
      // COMUM pronta: mesma foto do molde, avatar_url = foto_url (sem Brilhante).
      Object.assign(linha, {
        foto_url: molde.foto_url, avatar_url: molde.foto_url, foto_hash: molde.foto_hash,
        figurinha_status: 'pronta', fundo_figurinha: 'estadio',
      });
    }
    const { error: erroUpsert } = await supabase.from('users').upsert(linha, { onConflict: 'id' });
    if (erroUpsert) { console.error(`upsert ${email}:`, erroUpsert.message); process.exit(1); }
  }

  const sessoes = { ids };
  for (const papel of Object.keys(PAPEIS)) sessoes[papel] = await sessaoDe(PAPEIS[papel]);

  fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
  fs.writeFileSync(DESTINO, JSON.stringify(sessoes, null, 2));

  console.log('contas de varredura prontas:');
  for (const [papel, email] of Object.entries(PAPEIS)) console.log(`  ${papel.padEnd(10)} ${email} (${ids[papel]})`);
  console.log(`sessões em ${DESTINO}`);
  console.log(`\nApós a cena "criar time" gerar o time do dono:`);
  console.log(`  node scripts/_bench/contas-varredura.js --entrar-membro <teamId>`);
})();
