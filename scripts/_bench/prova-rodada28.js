// ═══════════════════════════════════════════════════════════════════════════════
// CONTAS DESCARTÁVEIS DA RODADA 28 (25-set) — para a cena `rodada28` do scripts/ver-iphone.mjs.
//
// O que a cena prova pela tela, em servidor LOCAL (nunca a produção — CLAUDE.md, 25-set):
//   A · card com a FOTO: sem seletor de fundos, zoom com piso em "cobre a moldura", grade de
//       uniformes com o 1º liberado e cadeados que levam aos Planos (e o card do pacote do time,
//       com o uniforme do time pintável);
//   B · "Sair" só deste aparelho; 401 do motor → login com aviso, nunca "crie seu time";
//   C · cadastro com menos de 13 anos não cria conta (formulário e onboarding de Google/Apple);
//   D · Diagnóstico só para o super-admin, pelo Gabinete;
//   E · telemetria anônima de velocidade (o que sai do aparelho);
//   H · Gabinete: jogadores, gerações e custo por time.
// Nada gera figurinha (custo de IA zero). Tudo @futtymock; os times são só desta rodada.
//
//   node scripts/_bench/prova-rodada28.js            cria/refaz tudo e grava as sessões
//   node scripts/_bench/prova-rodada28.js --apagar   apaga times e contas
//
// Sai em ../frontend/scripts/capturas/sessao-rodada28.json (fora do git).
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('../../utils/db');
const { apagarUsuario } = require('../../utils/apagarUsuario');
const { chavePublica } = require('../../utils/chavesSupabase');

const SENHA = 'Prova!Rodada28-2026';
const SLUG_SEM = 'prova-r28';
const SLUG_PAC = 'prova-r28-pac';
const KITS = `${process.env.SUPABASE_URL}/storage/v1/object/public/kits`;
const DESTINO = path.join(__dirname, '..', '..', '..', 'frontend', 'scripts', 'capturas', 'sessao-rodada28.json');

const CONTAS = {
  // Card com a foto, sem direito de gerar, dono de um time SEM pacote. avatar_url fica com uma
  // imagem que não é figurinha nossa (≠ foto_url) — o estado da foto do Google que a regra antiga
  // (foto_url ≠ avatar_url) tratava como figurinha: seletor de fundos e zoom abaixo da moldura.
  foto: { email: 'prova-r28-foto@futtymock.com', nome: 'FOTO28', nasc: '1990-04-12', onboarding: true },
  // Card com a foto, dono de um time COM pacote ativo (Dark Purple): tem 5 gerações pelo pacote.
  pacote: { email: 'prova-r28-pacote@futtymock.com', nome: 'PAC28', nasc: '1992-08-03', onboarding: true },
  // Cadastro de Google/Apple em curso (sem data, onboarding por concluir): um adulto e um menor.
  adulto: { email: 'prova-r28-adulto@futtymock.com', nome: 'ADULTO28', nasc: null, onboarding: false },
  menor: { email: 'prova-r28-menor@futtymock.com', nome: 'MENOR28', nasc: null, onboarding: false },
  // O dono (Gabinete e Diagnóstico).
  super: { email: 'prova-r28-super@futtymock.com', nome: 'SUPER28', nasc: '1988-01-20', onboarding: true, super: true },
};

const tem = (n) => process.argv.includes(`--${n}`);
const ok = (m) => console.log('✓', m);

async function acharPorEmail(email) {
  const { data } = await supabase.auth.admin.listUsers({ perPage: 200 });
  return (data?.users || []).find((u) => (u.email || '').toLowerCase() === email) || null;
}

async function limpar() {
  for (const slug of [SLUG_SEM, SLUG_PAC]) {
    const { data: time } = await supabase.from('teams').select('id').eq('slug', slug).maybeSingle();
    if (time) {
      await supabase.from('brilhantes_time').delete().eq('team_id', time.id);
      const { error } = await supabase.from('teams').delete().eq('id', time.id);
      if (error) throw new Error(`apagar time ${slug}: ${error.message}`);
    }
  }
  for (const { email } of Object.values(CONTAS)) {
    const u = await acharPorEmail(email);
    if (u) await apagarUsuario(u.id).catch((e) => console.warn(`limpeza ${email}:`, e.message));
  }
  fs.rmSync(DESTINO, { force: true });
}

// Uma sessão NOVA a cada chamada: cada uma é um "aparelho" (a cena usa várias da mesma conta).
async function sessaoDe(email) {
  const anon = createClient(process.env.SUPABASE_URL, chavePublica(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password: SENHA });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  return [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(data.session) }];
}

/** Foto 2:3 lisa, com um "rosto" claro no terço de cima (onde o zoom ancora) e o tronco escuro. */
async function subirFoto(userId, cor) {
  const w = 800;
  const h = 1200;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" fill="rgb(${cor.join(',')})"/>
    <circle cx="${w / 2}" cy="${h / 3}" r="150" fill="rgb(235,200,160)"/>
    <rect x="${w / 2 - 230}" y="${h / 3 + 190}" width="460" height="${h}" rx="60" fill="rgb(20,20,30)"/>
  </svg>`;
  const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
  const carimbo = Date.now();
  const caminho = `public/${userId}-${carimbo}.jpg`;
  const { error } = await supabase.storage.from('avatars').upload(caminho, buf, { contentType: 'image/jpeg', upsert: false });
  if (error) throw new Error(`upload da foto: ${error.message}`);
  const { data } = supabase.storage.from('avatars').getPublicUrl(caminho);
  return `${data.publicUrl}?v=${carimbo}`;
}

(async () => {
  if (tem('apagar')) {
    await limpar();
    console.log('times e contas da rodada 28 apagados.');
    return;
  }
  await limpar(); // refaz do zero: a cena sai de contas e apaga a do menor

  const ids = {};
  for (const [papel, def] of Object.entries(CONTAS)) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: def.email, password: SENHA, email_confirm: true,
      user_metadata: { nome: def.nome, ...(def.onboarding ? { onboarding_completo: true } : {}) },
    });
    if (error) throw new Error(`createUser ${def.email}: ${error.message}`);
    ids[papel] = data.user.id;
    const linha = { id: data.user.id, email: def.email, nome: def.nome, nome_jogador: def.nome, birthdate: def.nasc };
    if (def.super) linha.is_super_admin = true;
    if (papel === 'foto') {
      const url = await subirFoto(data.user.id, [40, 110, 220]);
      Object.assign(linha, { foto_url: url, avatar_url: `${KITS}/avatar-generico-1.png`, figurinha_status: 'pronta' });
    } else if (papel === 'pacote') {
      const url = await subirFoto(data.user.id, [200, 70, 60]);
      Object.assign(linha, { foto_url: url, avatar_url: url, figurinha_status: 'pronta' });
    }
    const { error: eUp } = await supabase.from('users').upsert(linha, { onConflict: 'id' });
    if (eUp) throw new Error(`users ${def.email}: ${eUp.message}`);
  }
  ok(`${Object.keys(CONTAS).length} contas prontas (foto, pacote, adulto e menor em cadastro, super).`);

  const criarTime = async (slug, nome, dono, extra = {}) => {
    const { data: time, error } = await supabase.from('teams')
      .insert({ nome, slug, cor: 'roxo', criado_por: dono, publica: false, modo_visibilidade: 'privado', cidade: 'Brasília', localizacao: 'Bancada da rodada 28 (descartável)', descricao: 'Time descartável — Rodada 28.', ...extra })
      .select().single();
    if (error) throw new Error(`teams ${slug}: ${error.message}`);
    const { error: eMem } = await supabase.from('team_members').insert({ team_id: time.id, user_id: dono, role: 'admin', categoria: 'linha', pode_postar: true });
    if (eMem) throw new Error(`team_members ${slug}: ${eMem.message}`);
    return time;
  };
  const timeSem = await criarTime(SLUG_SEM, 'Prova R28', ids.foto);
  const timePac = await criarTime(SLUG_PAC, 'Prova R28 Pacote', ids.pacote, {
    brilhante_ativo: true, brilhante_kit: 'dark-purple', brilhante_ativado_em: new Date().toISOString(), brilhante_limite: 25,
  });
  ok(`times: ${SLUG_SEM} (sem pacote) e ${SLUG_PAC} (pacote ativo, Dark Purple).`);

  const sessoes = {
    times: { sem: { id: timeSem.id, slug: SLUG_SEM }, pac: { id: timePac.id, slug: SLUG_PAC } },
    ids,
    // "foto": telas do A, D e E; "fotoSair": o aparelho que toca em Sair; "fotoOutro": o outro
    // aparelho, que tem de continuar logado; "foto401": o aparelho cuja sessão o motor recusa.
    foto: await sessaoDe(CONTAS.foto.email),
    fotoSair: await sessaoDe(CONTAS.foto.email),
    fotoOutro: await sessaoDe(CONTAS.foto.email),
    foto401: await sessaoDe(CONTAS.foto.email),
    pacote: await sessaoDe(CONTAS.pacote.email),
    adulto: await sessaoDe(CONTAS.adulto.email),
    menor: await sessaoDe(CONTAS.menor.email),
    super: await sessaoDe(CONTAS.super.email),
  };
  fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
  fs.writeFileSync(DESTINO, JSON.stringify(sessoes, null, 2));
  console.log(`sessões em ${DESTINO}`);
})().catch((e) => { console.error('[prova-rodada28] ERRO:', e.message); process.exit(1); });
