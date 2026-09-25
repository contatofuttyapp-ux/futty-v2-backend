// Futty v2.0 — RODADA 21: conta descartável para a cena 'rodada21' do
// ver-iphone.mjs (gerações generosas + uniformes guardados). Uma pessoa com
// crédito (Minha Figurinha), um kit já pintado (dark-gold) e outro por pintar
// (dark-purple) — dá para provar, na mesma conta: o contador "N restantes",
// o selo "pintar · 1 geração", o diálogo de confirmação e a troca instantânea
// para um uniforme já pintado. Super-admin também, para a mesma sessão abrir
// o Gabinete → Figurinhas (campo "Dar crédito a um e-mail").
//
//   node scripts/_bench/prova-rodada21.js            cria a conta + sessão
//   node scripts/_bench/prova-rodada21.js --apagar   desfaz tudo
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('../../utils/db');
const { apagarUsuario } = require('../../utils/apagarUsuario');

const APAGAR = process.argv.includes('--apagar');
const EMAIL = 'prova-rodada21@futtymock.com';
const SENHA = 'Prova!Rodada21-2026';
const DESTINO_SESSAO = path.join(__dirname, '..', '..', '..', 'frontend', 'scripts', 'capturas', 'sessao-rodada21.json');
const KIT_PINTADO = 'dark-gold';

async function main() {
  if (APAGAR) {
    const { data: u } = await supabase.from('users').select('id').eq('email', EMAIL).maybeSingle();
    if (u) {
      await supabase.from('user_avatar_slots').delete().eq('user_id', u.id);
      await apagarUsuario(u.id);
      console.log('conta e vínculos da prova-rodada21 apagados.');
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
    user_metadata: { nome: 'Prova Rodada 21', onboarding_completo: true },
  });
  if (eCriar) throw new Error(`createUser: ${eCriar.message}`);
  const userId = criado.user.id;

  // Foto genérica (bucket público "kits") — só para avatarEhIA comparar contra
  // algo; a figurinha "pintada" é OUTRA imagem (dark-gold), diferente dela.
  const fotoUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/kits/kit1-dark-gold.png`;
  const avatarPintado = `${process.env.SUPABASE_URL}/storage/v1/object/public/kits/kit1-dark-gold.png?v=prova-rodada21`;

  const { error: eUpsert } = await supabase.from('users').upsert({
    id: userId, email: EMAIL, nome: 'Prova Rodada 21', nome_jogador: 'Rodada21',
    foto_url: fotoUrl, avatar_url: avatarPintado, kit_ativo: KIT_PINTADO,
    brilhante_creditos: 3, is_super_admin: true,
  }, { onConflict: 'id' });
  if (eUpsert) throw new Error(`users: ${eUpsert.message}`);

  // Só o dark-gold pintado — os outros 4 ficam "por pintar" na grelha (selo
  // "pintar · 1 geração"), o estado que a cena precisa mostrar.
  const { error: eSlot } = await supabase.from('user_avatar_slots').upsert(
    { user_id: userId, kit_id: KIT_PINTADO, avatar_url: avatarPintado, foto_fingerprint: null },
    { onConflict: 'user_id,kit_id' },
  );
  if (eSlot) throw new Error(`user_avatar_slots: ${eSlot.message}`);
  console.log(`✓ conta com 3 créditos, kit ${KIT_PINTADO} pintado, super-admin.`);

  const anon = createClient(process.env.SUPABASE_URL, require('../../utils/chavesSupabase').chavePublica());
  const { data: sess, error: eLogin } = await anon.auth.signInWithPassword({ email: EMAIL, password: SENHA });
  if (eLogin) throw new Error(`login: ${eLogin.message}`);
  const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  const sessao = [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(sess.session) }];
  fs.mkdirSync(path.dirname(DESTINO_SESSAO), { recursive: true });
  fs.writeFileSync(DESTINO_SESSAO, JSON.stringify(sessao, null, 2));
  console.log(`✓ sessão em ${path.relative(process.cwd(), DESTINO_SESSAO)}`);
  console.log(`\nuserId: ${userId}`);
}

main().catch((e) => { console.error('[prova-rodada21] ERRO:', e.message); process.exitCode = 1; });
