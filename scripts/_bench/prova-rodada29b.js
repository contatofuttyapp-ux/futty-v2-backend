// ═══════════════════════════════════════════════════════════════════════════════
// CONTAS DESCARTÁVEIS PARA AS CENAS `rodada29b-*` do scripts/ver-iphone.mjs.
//
// Grade de uniformes: a MESMA grade para os três direitos, e o estado de cada tile sai do direito.
//   gratis     card com a FOTO, sem direito de gerar               → os 5 uniformes com cadeado
//   pacote     card com a FOTO, dono de time com pacote (Dark Purple) → o do time aberto, os outros com cadeado
//   pacoteFig  figurinha do time vestida (Dark Purple), 1 geração gasta → vestido ✓, "Refazer" pequeno embaixo
//   minha      card com a FOTO, 3 créditos (Minha Figurinha)       → os 5 abertos, com o selo "pintar · 1 geração · ~45 s"
//   minhaFig   figurinha Dark Gold vestida + White Gold pintado, 3 créditos → vestido, pintado, 3 abertos, "Refazer"
// Boas-vindas do time: dois MEMBROS (não-admin) do time "gratis":
//   novato     sem foto nenhuma (avatar_url nulo)  → a 1ª visita à página do time abre as boas-vindas
//   membroFoto com foto                            → só abre logo depois de aceitar um convite (state.primeiraEntrada)
// "Avise-me": `super` — super-admin de prova para a aba do Gabinete.
// "Só organizo": o time "gratis" tem um jogo futuro (id em sessao-rodada29b.json → jogo) para as telas de presença.
// Nada gera figurinha (custo de IA zero): as "figurinhas" são PNGs desenhados aqui, com `-ai-` no nome como as de verdade.
// Tudo @futtymock; os times são só desta cena. Só servidor LOCAL (CLAUDE.md).
//
//   node scripts/_bench/prova-rodada29b.js            cria/refaz tudo e grava as sessões
//   node scripts/_bench/prova-rodada29b.js --apagar   apaga times e contas
//
// Sai em ../frontend/scripts/capturas/sessao-rodada29b.json (fora do git).
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('../../utils/db');
const { apagarUsuario } = require('../../utils/apagarUsuario');
const { chavePublica } = require('../../utils/chavesSupabase');

const SENHA = 'Prova!Rodada29B-2026';
const SLUGS = { gratis: 'prova-r29b-gratis', pacote: 'prova-r29b-pacote', pacoteFig: 'prova-r29b-pacote-fig', minha: 'prova-r29b-minha', minhaFig: 'prova-r29b-minha-fig' };
const DESTINO = path.join(__dirname, '..', '..', '..', 'frontend', 'scripts', 'capturas', 'sessao-rodada29b.json');

const CONTAS = {
  gratis: { email: 'prova-r29b-gratis@futtymock.com', nome: 'GRATIS29', nasc: '1990-04-12' },
  pacote: { email: 'prova-r29b-pacote@futtymock.com', nome: 'PAC29', nasc: '1992-08-03' },
  pacoteFig: { email: 'prova-r29b-pacote-fig@futtymock.com', nome: 'PACFIG29', nasc: '1991-02-14' },
  minha: { email: 'prova-r29b-minha@futtymock.com', nome: 'MINHA29', nasc: '1993-11-30' },
  minhaFig: { email: 'prova-r29b-minha-fig@futtymock.com', nome: 'MINHAFIG29', nasc: '1989-06-21' },
  novato: { email: 'prova-r29b-novato@futtymock.com', nome: 'NOVATO29', nasc: '1995-03-09' },
  membroFoto: { email: 'prova-r29b-membro-foto@futtymock.com', nome: 'MEMBROFOTO29', nasc: '1994-12-01' },
  super: { email: 'prova-r29b-super@futtymock.com', nome: 'SUPER29', nasc: '1988-01-20' },
};

const tem = (n) => process.argv.includes(`--${n}`);
const ok = (m) => console.log('✓', m);

async function acharPorEmail(email) {
  const { data } = await supabase.auth.admin.listUsers({ perPage: 200 });
  return (data?.users || []).find((u) => (u.email || '').toLowerCase() === email) || null;
}

async function limpar() {
  for (const slug of Object.values(SLUGS)) {
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

// Uma sessão NOVA a cada chamada: cada uma é um "aparelho".
async function sessaoDe(email) {
  const anon = createClient(process.env.SUPABASE_URL, chavePublica(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password: SENHA });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  return [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(data.session) }];
}

async function subir(caminho, buf, contentType) {
  const { error } = await supabase.storage.from('avatars').upload(caminho, buf, { contentType, upsert: false });
  if (error) throw new Error(`upload ${caminho}: ${error.message}`);
  const { data } = supabase.storage.from('avatars').getPublicUrl(caminho);
  return data.publicUrl;
}

/** Foto 2:3 lisa, com um "rosto" claro no terço de cima e o tronco escuro. */
async function subirFoto(userId, cor) {
  const w = 800;
  const h = 1200;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" fill="rgb(${cor.join(',')})"/>
    <circle cx="${w / 2}" cy="${h / 3}" r="150" fill="rgb(235,200,160)"/>
    <rect x="${w / 2 - 230}" y="${h / 3 + 190}" width="460" height="${h}" rx="60" fill="rgb(20,20,30)"/>
  </svg>`;
  const carimbo = Date.now();
  const url = await subir(`public/${userId}-${carimbo}.jpg`, await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer(), 'image/jpeg');
  return `${url}?v=${carimbo}`;
}

/** "Figurinha": PNG 2:3 com o nome `-ai-<kit>` das de verdade (é o nome que o motor usa para dizer "isto é figurinha"). */
async function subirFigurinha(userId, kit, corCamisa) {
  const w = 800;
  const h = 1200;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <circle cx="${w / 2}" cy="${h / 3}" r="150" fill="rgb(235,200,160)"/>
    <rect x="${w / 2 - 260}" y="${h / 3 + 190}" width="520" height="${h}" rx="70" fill="${corCamisa}"/>
  </svg>`;
  const carimbo = Date.now();
  const url = await subir(`public/${userId}-ai-${kit}-${carimbo}.png`, await sharp(Buffer.from(svg)).png().toBuffer(), 'image/png');
  return `${url}?v=${carimbo}`;
}

(async () => {
  if (tem('apagar')) {
    await limpar();
    console.log('times e contas da rodada 29B apagados.');
    return;
  }
  await limpar();

  const ids = {};
  for (const [papel, def] of Object.entries(CONTAS)) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: def.email, password: SENHA, email_confirm: true,
      user_metadata: { nome: def.nome, onboarding_completo: true },
    });
    if (error) throw new Error(`createUser ${def.email}: ${error.message}`);
    ids[papel] = data.user.id;
  }

  const foto = {};
  const figurinha = {};
  const linhaBase = (papel) => ({ id: ids[papel], email: CONTAS[papel].email, nome: CONTAS[papel].nome, nome_jogador: CONTAS[papel].nome, birthdate: CONTAS[papel].nasc });

  // Card com a FOTO: avatar_url = foto_url, sem nada de figurinha.
  for (const [papel, cor] of [['gratis', [40, 110, 220]], ['pacote', [200, 70, 60]], ['minha', [60, 160, 90]], ['membroFoto', [150, 120, 40]]]) {
    foto[papel] = await subirFoto(ids[papel], cor);
    const { error } = await supabase.from('users').upsert({ ...linhaBase(papel), foto_url: foto[papel], avatar_url: foto[papel], figurinha_status: 'pronta' }, { onConflict: 'id' });
    if (error) throw new Error(`users ${papel}: ${error.message}`);
  }
  // Card com a FIGURINHA vestida: avatar_url = arquivo `-ai-<kit>`, e o slot do kit guardado.
  const vestirFigurinha = async (papel, kit, corCamisa, kitsPintados) => {
    foto[papel] = await subirFoto(ids[papel], [90, 90, 160]);
    figurinha[papel] = await subirFigurinha(ids[papel], kit, corCamisa);
    const { error } = await supabase.from('users').upsert({ ...linhaBase(papel), foto_url: foto[papel], avatar_url: figurinha[papel], kit_ativo: kit, figurinha_status: 'pronta' }, { onConflict: 'id' });
    if (error) throw new Error(`users ${papel}: ${error.message}`);
    for (const k of kitsPintados) {
      const url = k === kit ? figurinha[papel] : await subirFigurinha(ids[papel], k, '#e8e0c8');
      const { error: eSlot } = await supabase.from('user_avatar_slots').upsert({ user_id: ids[papel], kit_id: k, avatar_url: url }, { onConflict: 'user_id,kit_id' });
      if (eSlot) throw new Error(`slot ${papel}/${k}: ${eSlot.message}`);
    }
  };
  await vestirFigurinha('pacoteFig', 'dark-purple', '#5b3fb5', ['dark-purple']);
  await vestirFigurinha('minhaFig', 'dark-gold', '#1b1b22', ['dark-gold', 'white-gold']);

  // O novato: sem foto e sem avatar (o card do Início ainda é a silhueta).
  {
    const { error } = await supabase.from('users').upsert({ ...linhaBase('novato'), figurinha_status: 'pronta' }, { onConflict: 'id' });
    if (error) throw new Error(`users novato: ${error.message}`);
  }

  // O super-admin de prova (aba Avise-me do Gabinete).
  {
    const { error } = await supabase.from('users').upsert({ ...linhaBase('super'), is_super_admin: true, figurinha_status: 'pronta' }, { onConflict: 'id' });
    if (error) throw new Error(`users super: ${error.message}`);
  }

  // Créditos da Minha Figurinha.
  for (const papel of ['minha', 'minhaFig']) {
    const { error } = await supabase.from('users').update({ brilhante_creditos: 3 }).eq('id', ids[papel]);
    if (error) throw new Error(`créditos ${papel}: ${error.message}`);
  }
  ok(`${Object.keys(CONTAS).length} contas prontas (gratis, pacote, pacoteFig, minha, minhaFig, novato, membroFoto, super).`);

  const criarTime = async (slug, nome, dono, extra = {}) => {
    const { data: time, error } = await supabase.from('teams')
      .insert({ nome, slug, cor: 'verde', criado_por: dono, publica: false, modo_visibilidade: 'privado', cidade: 'Brasília', localizacao: 'Bancada da rodada 29B (descartável)', descricao: 'Time descartável — Rodada 29B.', ...extra })
      .select().single();
    if (error) throw new Error(`teams ${slug}: ${error.message}`);
    const { error: eMem } = await supabase.from('team_members').insert({ team_id: time.id, user_id: dono, role: 'admin', categoria: 'linha', pode_postar: true });
    if (eMem) throw new Error(`team_members ${slug}: ${eMem.message}`);
    return time;
  };
  const pacote = { brilhante_ativo: true, brilhante_kit: 'dark-purple', brilhante_ativado_em: new Date().toISOString(), brilhante_limite: 25 };
  const times = {
    gratis: await criarTime(SLUGS.gratis, 'Prova R29B Grátis', ids.gratis),
    pacote: await criarTime(SLUGS.pacote, 'Prova R29B Pacote', ids.pacote, pacote),
    pacoteFig: await criarTime(SLUGS.pacoteFig, 'Prova R29B Pacote Fig', ids.pacoteFig, pacote),
    minha: await criarTime(SLUGS.minha, 'Prova R29B Minha', ids.minha),
    minhaFig: await criarTime(SLUGS.minhaFig, 'Prova R29B Minha Fig', ids.minhaFig),
  };
  // A geração do pacote que a figurinha vestida já gastou (1 linha por jogador, com `geracoes`).
  const { error: eBt } = await supabase.from('brilhantes_time').upsert({ team_id: times.pacoteFig.id, user_id: ids.pacoteFig, kit_id: 'dark-purple', geracoes: 1 }, { onConflict: 'team_id,user_id' });
  if (eBt) throw new Error(`brilhantes_time: ${eBt.message}`);
  // Os dois membros (role 'member', não admin) entram no time "gratis".
  for (const papel of ['novato', 'membroFoto']) {
    const { error } = await supabase.from('team_members').insert({ team_id: times.gratis.id, user_id: ids[papel], role: 'member', categoria: 'linha', pode_postar: true });
    if (error) throw new Error(`team_members ${papel}: ${error.message}`);
  }
  // Um jogo futuro no time "gratis" (a tela do jogo e o card do Início precisam de um jogo de verdade).
  const { data: jogo, error: eJogo } = await supabase.from('games')
    .insert({ team_id: times.gratis.id, data: new Date(Date.now() + 3 * 86400000).toISOString(), local: 'Quadra da prova 29B', status: 'agendado', jogadores_por_time: 5 })
    .select().single();
  if (eJogo) throw new Error(`games: ${eJogo.message}`);
  ok('times criados (o de pacote fig já gastou 1 geração); novato e membroFoto entraram no time grátis; um jogo futuro no time grátis.');

  const sessoes = {
    ids,
    times: Object.fromEntries(Object.entries(times).map(([k, t]) => [k, { id: t.id, slug: t.slug }])),
    jogo: { id: jogo.id, team_id: times.gratis.id },
    gratis: await sessaoDe(CONTAS.gratis.email),
    pacote: await sessaoDe(CONTAS.pacote.email),
    pacoteFig: await sessaoDe(CONTAS.pacoteFig.email),
    minha: await sessaoDe(CONTAS.minha.email),
    minhaFig: await sessaoDe(CONTAS.minhaFig.email),
    novato: await sessaoDe(CONTAS.novato.email),
    membroFoto: await sessaoDe(CONTAS.membroFoto.email),
    super: await sessaoDe(CONTAS.super.email),
  };
  fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
  fs.writeFileSync(DESTINO, JSON.stringify(sessoes, null, 2));
  console.log(`sessões em ${DESTINO}`);
})().catch((e) => { console.error('[prova-rodada29b] ERRO:', e.message); process.exit(1); });
