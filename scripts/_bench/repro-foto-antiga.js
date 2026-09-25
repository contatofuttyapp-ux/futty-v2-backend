// ═══════════════════════════════════════════════════════════════════════════════
// REPRODUZIR O BUG DA FOTO ANTIGA (22-set, conta do Pedro).
//
// O que aconteceu em produção: às 12:21:08 subiu uma foto nova, às 12:21:14
// pediu figurinha — e a figurinha saiu da foto ANTIGA. Seis segundos.
//
// A suspeita: a foto vai sempre para o MESMO caminho (public/<userId>.<ext>,
// com upsert e cacheControl 3600), e a geração faz download desse caminho logo
// a seguir. O CDN da Supabase pode servir a versão velha por até ~60 s.
//
// Este script mede isso sem opinião: sobe a foto A, gera, sobe a foto B, gera
// UM SEGUNDO depois, e compara o sha256 da foto que o motor baixou (o log da
// ETAPA 0) com o `users.foto_hash` de cada momento. Se a segunda geração usou
// o hash de A, o bug está reproduzido.
//
//   node scripts/_bench/repro-foto-antiga.js --porta 3013
//   --espera 1   segundos entre subir a foto B e pedir a figurinha
//   --so-upload  só sobe as fotos e compara hashes, SEM gerar (US$0,00)
//
// Custo: duas gerações (~US$0,10), ou zero com --so-upload.
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('../../utils/db');

const FOTOS = path.join(__dirname, '..', '..', '..', '..', 'BANCADA-FOTOS');
const EMAIL = 'demo-loja@futtymock.com';
const ARQUIVO_SENHA = path.join(__dirname, '..', '..', '..', '..', 'LOJA', 'demo-senha.txt');
const arg = (n, o) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : o; };
const tem = (n) => process.argv.includes(`--${n}`);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const porta = arg('porta', '3013');
  const base = `http://localhost:${porta}`;
  const segundos = Number(arg('espera', '1'));
  const soUpload = tem('so-upload');

  const bruto = fs.readFileSync(ARQUIVO_SENHA, 'utf8');
  const linha = bruto.split(new RegExp(String.fromCharCode(92, 114, 63, 92, 110))).map((l) => l.trim()).filter(Boolean).pop() || '';
  const senha = linha.includes(':') ? linha.split(':').pop().trim() : linha;

  const saude = await fetch(`${base}/api/health`).catch(() => null);
  if (!saude?.ok) { console.error(`Servidor não responde em ${base}.`); process.exit(1); }

  const auth = createClient(process.env.SUPABASE_URL, require('../../utils/chavesSupabase').chavePublica());
  const { data: sessao, error } = await auth.auth.signInWithPassword({ email: EMAIL, password: senha });
  if (error) { console.error('login falhou:', error.message); process.exit(1); }
  const token = sessao.session.access_token;
  const userId = sessao.user.id;

  const lerPerfil = async () => {
    const { data } = await supabase.from('users').select('foto_url, foto_hash, avatar_url').eq('id', userId).maybeSingle();
    return data || {};
  };
  const guardado = await lerPerfil();
  console.log(`conta demo ok · foto atual: ${(guardado.foto_hash || '(sem hash)').slice(0, 12)}\n`);

  /** Sobe uma foto pela rota real (multipart), como o app faz. */
  const subirFoto = async (ficheiro) => {
    const buf = fs.readFileSync(path.join(FOTOS, ficheiro));
    const form = new FormData();
    form.append('avatar', new Blob([buf], { type: 'image/jpeg' }), ficheiro);
    const r = await fetch(`${base}/api/me/avatar`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    if (!r.ok) throw new Error(`upload ${r.status}: ${(await r.text()).slice(0, 120)}`);
    return { hash: sha(buf), resposta: await r.json() };
  };

  const gerar = async () => {
    const t0 = Date.now();
    const r = await fetch(`${base}/api/me/avatar/ai`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kit: 'dark-gold' }),
    });
    const corpo = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, corpo, segundos: (Date.now() - t0) / 1000 };
  };

  // Para cada geração valer, o slot e a quota não podem servir de atalho.
  const desarmar = async () => {
    await supabase.from('user_avatar_slots').delete().eq('user_id', userId);
    await supabase.from('users').update({ avatar_ia_mes: 0 }).eq('id', userId);
  };

  const resultados = [];
  for (const [rotulo, ficheiro] of [['A', 'Gui.jpeg'], ['B', 'Renato.jpeg']]) {
    await desarmar();
    const up = await subirFoto(ficheiro);
    const depois = await lerPerfil();
    console.log(`foto ${rotulo} (${ficheiro}) subiu · sha256 do ficheiro ${up.hash.slice(0, 12)} · users.foto_hash ${(depois.foto_hash || '').slice(0, 12)}`);

    if (rotulo === 'B') {
      console.log(`   a esperar ${segundos}s antes de pedir a figurinha (o bug real foram 6 s)...`);
      await espera(segundos * 1000);
    }
    if (soUpload) { resultados.push({ rotulo, hashFicheiro: up.hash, hashTabela: depois.foto_hash }); continue; }

    const g = await gerar();
    console.log(`   geração: ${g.ok ? 'OK' : `FALHOU ${g.status} ${g.corpo?.codigo || ''}`} em ${g.segundos.toFixed(0)}s`);
    resultados.push({ rotulo, hashFicheiro: up.hash, hashTabela: depois.foto_hash, geracao: g });
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('Compare no log do servidor a linha "[avatar-ai] etapa 0 - foto baixada":');
  for (const r of resultados) {
    console.log(`  foto ${r.rotulo}: users.foto_hash ${(r.hashTabela || '—').slice(0, 12)}`);
  }
  // O sha do ficheiro em disco NÃO tem de bater com users.foto_hash: o
  // `receberAvatar` auto-orienta pelo EXIF (.rotate()) e isso reescreve o JPEG
  // antes de qualquer hash. O que tem de bater — e é o que a ETAPA 0 confere —
  // é o objeto GUARDADO com o foto_hash. Comparar com o ficheiro original só
  // dava um aviso falso a cada corrida.
  console.log('Se a ETAPA 0 da segunda geração baixou o hash da foto A, o bug está reproduzido.');
  console.log('='.repeat(78));

  // Deixa a conta como estava para o passo seguinte decidir o que fazer.
  console.log(`\n(a conta demo ficou com a foto B; o script de reposição devolve a silhueta)`);
})();
