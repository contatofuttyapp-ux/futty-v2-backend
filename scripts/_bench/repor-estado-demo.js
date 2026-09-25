// ═══════════════════════════════════════════════════════════════════════════════
// DEVOLVER A CONTA DEMO AO ESTADO DA LOJA (22-set).
//
// A conta demo-loja@futtymock.com é a que aparece nas capturas da loja. Uma
// bancada que mexa nela (a de reprodução do bug da foto antiga, por exemplo)
// deixa-a com a cara de outra pessoa — e isso não pode ficar assim.
//
// Este script repõe o retrato do modelo fictício guardado em
// `estado-demo/foto-silhueta-original.jpg`, pela ROTA REAL (multipart), e gera
// uma figurinha dark-gold nova a partir dele. Depois limpa do bucket tudo o que
// tenha ficado para trás de corridas anteriores — incluindo os nomes FIXOS do
// esquema antigo (`<id>.png`, `<id>-ai-<kit>.png`, `tmp/<id>-pad.jpg`), que já
// não são escritos por ninguém.
//
//   node scripts/_bench/repor-estado-demo.js --porta 3014
//   --sem-gerar             repõe só a foto e limpa o bucket (US$0,00)
//   --figurinha-de <arquivo> em vez de GERAR (rota paga), publica esse PNG já
//                            existente como a figurinha do kit — mesmo efeito
//                            final (bucket, users, slot), custo zero. Serve
//                            para repor depois de uma bancada que já pagou por
//                            uma figurinha boa da MESMA foto (ex.: a prova da
//                            Rodada 17) e não precisa pagar outra vez só para
//                            devolver a conta ao estado da loja. Ignorado
//                            junto com --sem-gerar.
//
// Custo: uma geração (~US$0,05); zero com --sem-gerar ou --figurinha-de.
// Não é para correr contra produção: pede a um servidor LOCAL.
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('../../utils/db');
const { sha256Hex } = require('../../utils/antiAbusoIA');

const EMAIL = 'demo-loja@futtymock.com';
const KIT = 'dark-gold';
const FOTO = path.join(__dirname, 'estado-demo', 'foto-silhueta-original.jpg');
const ARQUIVO_SENHA = path.join(__dirname, '..', '..', '..', '..', 'LOJA', 'demo-senha.txt');
const arg = (n, o) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : o; };
const tem = (n) => process.argv.includes(`--${n}`);

/** O caminho dentro do bucket, a partir do URL guardado. */
const caminhoDe = (url) => {
  const m = '/object/public/avatars/';
  const i = String(url || '').indexOf(m);
  return i === -1 ? null : url.slice(i + m.length).split('?')[0];
};

(async () => {
  const base = `http://localhost:${arg('porta', '3014')}`;
  const semGerar = tem('sem-gerar');
  const figurinhaDe = arg('figurinha-de', null);

  if (!fs.existsSync(FOTO)) { console.error(`falta a foto guardada: ${FOTO}`); process.exit(1); }
  if (figurinhaDe && !fs.existsSync(figurinhaDe)) { console.error(`--figurinha-de: arquivo não existe: ${figurinhaDe}`); process.exit(1); }
  const saude = await fetch(`${base}/api/health`).catch(() => null);
  if (!saude?.ok) { console.error(`Servidor não responde em ${base}.`); process.exit(1); }

  const bruto = fs.readFileSync(ARQUIVO_SENHA, 'utf8');
  const linha = bruto.split(new RegExp(String.fromCharCode(92, 114, 63, 92, 110))).map((l) => l.trim()).filter(Boolean).pop() || '';
  const senha = linha.includes(':') ? linha.split(':').pop().trim() : linha;

  const auth = createClient(process.env.SUPABASE_URL, require('../../utils/chavesSupabase').chavePublica());
  const { data: sessao, error } = await auth.auth.signInWithPassword({ email: EMAIL, password: senha });
  if (error) { console.error('login falhou:', error.message); process.exit(1); }
  const token = sessao.session.access_token;
  const userId = sessao.user.id;

  // 1) A foto do modelo fictício, pela rota real — ganha nome por versão, hash
  //    gravado no mesmo update e a versão anterior apagada, como qualquer foto.
  const buf = fs.readFileSync(FOTO);
  const form = new FormData();
  form.append('avatar', new Blob([buf], { type: 'image/jpeg' }), 'demo-loja.jpg');
  const rUp = await fetch(`${base}/api/me/avatar`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  if (!rUp.ok) { console.error(`upload ${rUp.status}:`, (await rUp.text()).slice(0, 200)); process.exit(1); }
  console.log('foto da loja reposta.');

  // 2) A figurinha.
  if (figurinhaDe) {
    // PUBLICA sem gerar: escreve o PNG já pago no caminho por versão (mesmo
    // padrão de caminhoFigurinhaNova em routes/auth.js), aponta users/slot
    // para ele e apaga a versão anterior — o mesmo resultado final de uma
    // geração real, sem chamar a fal.
    const { data: antes } = await supabase.from('users').select('foto_hash').eq('id', userId).maybeSingle();
    const { data: slotAntes } = await supabase.from('user_avatar_slots').select('avatar_url').eq('user_id', userId).eq('kit_id', KIT).maybeSingle();
    const pngBuf = fs.readFileSync(figurinhaDe);
    const caminhoFig = `public/${userId}-ai-${KIT}-${Date.now()}.png`;
    const { error: upFigErr } = await supabase.storage.from('avatars').upload(caminhoFig, pngBuf, {
      contentType: 'image/png', upsert: false, cacheControl: '3600',
    });
    if (upFigErr) { console.error('upload da figurinha falhou:', upFigErr.message); process.exit(1); }
    const { data: pubFig } = supabase.storage.from('avatars').getPublicUrl(caminhoFig);
    const avatarUrl = `${pubFig.publicUrl}?v=${Date.now()}`;
    const { error: slotErr } = await supabase.from('user_avatar_slots')
      .upsert({ user_id: userId, kit_id: KIT, avatar_url: avatarUrl, foto_fingerprint: antes?.foto_hash || null }, { onConflict: 'user_id,kit_id' });
    if (slotErr) { console.error('slot falhou:', slotErr.message); process.exit(1); }
    const { error: userErr } = await supabase.from('users').update({ avatar_url: avatarUrl, kit_ativo: KIT }).eq('id', userId);
    if (userErr) { console.error('update users falhou:', userErr.message); process.exit(1); }
    const antigoFig = caminhoDe(slotAntes?.avatar_url);
    if (antigoFig && antigoFig !== caminhoFig) await supabase.storage.from('avatars').remove([antigoFig]).catch(() => {});
    console.log(`figurinha ${KIT} publicada de ${path.basename(figurinhaDe)} (sha256 ${sha256Hex(pngBuf).slice(0, 12)}, sem gerar — US$0,00)`);
  } else if (!semGerar) {
    // O slot antigo é de outra foto, por isso não serve de atalho — mas
    // apaga-se na mesma para a geração ser mesmo uma geração.
    await supabase.from('user_avatar_slots').delete().eq('user_id', userId).eq('kit_id', KIT);
    const t0 = Date.now();
    const rGer = await fetch(`${base}/api/me/avatar/ai`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kit: KIT }),
    });
    const corpo = await rGer.json().catch(() => ({}));
    if (!rGer.ok) { console.error(`geração ${rGer.status}:`, JSON.stringify(corpo).slice(0, 200)); process.exit(1); }
    console.log(`figurinha ${KIT} nova em ${Math.round((Date.now() - t0) / 1000)}s`);
  }

  // 3) Varre o bucket: fica só o que o banco aponta AGORA. Tudo o resto com o
  //    prefixo deste utilizador é sobra — de bancadas antigas ou do tempo do
  //    nome fixo — e não serve a ninguém.
  const { data: perfil } = await supabase.from('users').select('foto_url, avatar_url, kit_ativo, avatar_ia_mes').eq('id', userId).maybeSingle();
  const { data: slots } = await supabase.from('user_avatar_slots').select('avatar_url').eq('user_id', userId);
  const emUso = new Set([perfil?.foto_url, perfil?.avatar_url, ...(slots || []).map((s) => s.avatar_url)].map(caminhoDe).filter(Boolean));

  let apagados = 0;
  for (const pasta of ['public', 'tmp']) {
    // eslint-disable-next-line no-await-in-loop
    const { data: lista } = await supabase.storage.from('avatars').list(pasta, { limit: 1000, search: userId });
    const sobras = (lista || [])
      .filter((f) => f.name.startsWith(userId))
      .map((f) => `${pasta}/${f.name}`)
      .filter((c) => !emUso.has(c));
    if (!sobras.length) continue;
    // eslint-disable-next-line no-await-in-loop
    const { error: rmErr } = await supabase.storage.from('avatars').remove(sobras);
    if (rmErr) { console.warn(`limpeza de ${pasta} falhou:`, rmErr.message); continue; }
    sobras.forEach((c) => console.log('  apagado:', c));
    apagados += sobras.length;
  }

  console.log(`\nconta demo reposta · kit ${perfil?.kit_ativo} · ${apagados} sobra(s) apagada(s)`);
  console.log('foto  :', caminhoDe(perfil?.foto_url));
  console.log('cromo :', caminhoDe(perfil?.avatar_url));
})();
