// Futty v2.0 — RODADA 19: conta descartável para a cena 'rodada19' do
// ver-iphone.mjs (enquadrar dentro de Trocar foto, Minhas figurinhas,
// miniatura pelo topo). Entra em domingueira-fc-demo (já tem 6+ jogos
// passados) e confirma em 3 deles só para passar do MIN_JOGOS do Ranking —
// não mexe em nada que já existe do time.
//
//   node scripts/_bench/prova-rodada19.js            cria a conta + sessão
//   node scripts/_bench/prova-rodada19.js --apagar   desfaz tudo
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('../../utils/db');
const { apagarUsuario } = require('../../utils/apagarUsuario');

const APAGAR = process.argv.includes('--apagar');
const EMAIL = 'prova-rodada19@futtymock.com';
const SENHA = 'Prova!Rodada19-2026';
const SLUG_TIME = 'domingueira-fc-demo';
const DESTINO_SESSAO = path.join(__dirname, '..', '..', '..', 'frontend', 'scripts', 'capturas', 'sessao-rodada19.json');

async function main() {
  const { data: time, error: eTime } = await supabase.from('teams').select('id').eq('slug', SLUG_TIME).single();
  if (eTime || !time) throw new Error(`time ${SLUG_TIME} não encontrado: ${eTime?.message}`);

  if (APAGAR) {
    const { data: u } = await supabase.from('users').select('id').eq('email', EMAIL).maybeSingle();
    if (u) {
      await supabase.from('game_players').delete().eq('user_id', u.id);
      await supabase.from('team_members').delete().eq('user_id', u.id).eq('team_id', time.id);
      await apagarUsuario(u.id);
      console.log('conta e vínculos da prova-rodada19 apagados.');
    } else {
      console.log('nada a apagar — conta já não existe.');
    }
    fs.rmSync(DESTINO_SESSAO, { force: true });
    return;
  }

  const { data: existente } = await supabase.from('users').select('id').eq('email', EMAIL).maybeSingle();
  if (existente) throw new Error(`${EMAIL} já existe — corra primeiro com --apagar.`);

  const { data: criado, error: eCriar } = await supabase.auth.admin.createUser({
    email: EMAIL, password: SENHA, email_confirm: true,
    user_metadata: { nome: 'Prova Rodada 19', onboarding_completo: true },
  });
  if (eCriar) throw new Error(`createUser: ${eCriar.message}`);
  const userId = criado.user.id;

  // Foto inicial genérica (bucket público "kits") — só para "Trocar foto"
  // nascer com algo, igual a qualquer conta real depois do onboarding.
  const fotoInicial = `${process.env.SUPABASE_URL}/storage/v1/object/public/kits/kit1-dark-gold.png`;
  const { error: eUpsert } = await supabase.from('users').upsert({
    id: userId, email: EMAIL, nome: 'Prova Rodada 19', nome_jogador: 'Rodada19',
    foto_url: fotoInicial, avatar_url: fotoInicial,
  }, { onConflict: 'id' });
  if (eUpsert) throw new Error(`users: ${eUpsert.message}`);

  const { error: eMembro } = await supabase.from('team_members').upsert(
    { team_id: time.id, user_id: userId, role: 'member', categoria: 'linha', pode_postar: true },
    { onConflict: 'team_id,user_id' },
  );
  if (eMembro) throw new Error(`team_members: ${eMembro.message}`);

  const { data: jogos, error: eJogos } = await supabase.from('games').select('id').eq('team_id', time.id).order('data', { ascending: true }).limit(3);
  if (eJogos) throw new Error(`games: ${eJogos.message}`);
  if ((jogos || []).length < 3) throw new Error(`${SLUG_TIME} tem menos de 3 jogos — Ranking não vai listar ninguém (MIN_JOGOS).`);
  const linhas = jogos.map((g) => ({ game_id: g.id, user_id: userId, confirmado: true }));
  const { error: eGp } = await supabase.from('game_players').insert(linhas);
  if (eGp) throw new Error(`game_players: ${eGp.message}`);
  console.log(`✓ conta em ${SLUG_TIME}, confirmada em ${jogos.length} jogos (Ranking já pode listar).`);

  const anon = createClient(process.env.SUPABASE_URL, require('../../utils/chavesSupabase').chavePublica());
  const { data: sess, error: eLogin } = await anon.auth.signInWithPassword({ email: EMAIL, password: SENHA });
  if (eLogin) throw new Error(`login: ${eLogin.message}`);
  const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  const sessao = [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(sess.session) }];
  fs.mkdirSync(path.dirname(DESTINO_SESSAO), { recursive: true });
  fs.writeFileSync(DESTINO_SESSAO, JSON.stringify(sessao, null, 2));
  console.log(`✓ sessão em ${path.relative(process.cwd(), DESTINO_SESSAO)}`);
  console.log(`\nSlug do time: ${SLUG_TIME} · userId: ${userId}`);
}

main().catch((e) => { console.error('[prova-rodada19] ERRO:', e.message); process.exitCode = 1; });
