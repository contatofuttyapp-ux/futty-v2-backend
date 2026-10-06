// ═══════════════════════════════════════════════════════════════════════════════
// A CONTA PESADA DE PROVA — a forma da conta Chavo, sem tocar em time de ninguém.
//
// No MESMO iPhone a conta nova de teste abre o Início rápido e a conta Chavo, devagar. A Chavo é
// super-admin e está em 2 times: o Missa de Quinta (1 membro, 16 posts de Resenha com foto) e o Várzea FC
// (22 membros, 9 jogos, 9 posts). Entrar nesses times com uma conta de prova poluiria o ranking e as
// listas de gente de verdade, então esta bancada monta a MESMA forma em times descartáveis, com contas
// @futtymock:
//
//   pesada  super-admin, admin dos 2 times:
//             prova-r29b-pesada-missa   (Missa-like)  1 membro · 16 posts com 1–2 fotos · 30 jogos passados
//             prova-r29b-pesada-varzea  (Várzea-like) 22 membros · 6 jogos passados + 3 futuros (RSVP aberto) · 9 posts · 462 votos
//   leve    1 time só, com 1 jogo futuro (a conta "nova de teste" que abre rápido)
//
// Só servidor LOCAL e só leitura depois de montada (scripts/_bench/medir-conta-pesada.js). Nada gera figurinha (custo de IA 0).
//
//   node scripts/_bench/prova-conta-pesada.js            cria/refaz tudo e grava as sessões
//   node scripts/_bench/prova-conta-pesada.js --apagar   apaga times e contas
//
// Sessões em ../frontend/scripts/capturas/sessao-pesada.json e sessao-leve.json (fora do git).
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('../../utils/db');
const { apagarUsuario } = require('../../utils/apagarUsuario');
const { chavePublica } = require('../../utils/chavesSupabase');

const SENHA = 'Prova!Pesada29B-2026';
const SLUGS = { missa: 'prova-r29b-pesada-missa', varzea: 'prova-r29b-pesada-varzea', leve: 'prova-r29b-leve' };
const PASTA = path.join(__dirname, '..', '..', '..', 'frontend', 'scripts', 'capturas');
const MEMBROS = 21; // + a pesada = 22, como o Várzea
const email = (n) => `prova-r29b-${n}@futtymock.com`;
const EMAILS = ['pesada', 'leve', ...Array.from({ length: MEMBROS }, (_, i) => `pm-${String(i + 1).padStart(2, '0')}`)].map(email);

const tem = (n) => process.argv.includes(`--${n}`);
const ok = (m) => console.log('✓', m);
const dias = (d) => new Date(Date.now() + d * 86400000).toISOString();

async function acharPorEmail(alvo) {
  const { data } = await supabase.auth.admin.listUsers({ perPage: 200 });
  return (data?.users || []).find((u) => (u.email || '').toLowerCase() === alvo) || null;
}

async function limpar() {
  for (const slug of Object.values(SLUGS)) {
    const { data: time } = await supabase.from('teams').select('id').eq('slug', slug).maybeSingle();
    if (!time) continue;
    const { data: posts } = await supabase.from('feed_posts').select('id').eq('team_id', time.id);
    const postIds = (posts || []).map((p) => p.id);
    if (postIds.length) await supabase.from('feed_post_media').delete().in('post_id', postIds);
    const { data: jogos } = await supabase.from('games').select('id').eq('team_id', time.id);
    const jogoIds = (jogos || []).map((g) => g.id);
    if (jogoIds.length) {
      await supabase.from('game_players').delete().in('game_id', jogoIds);
      await supabase.from('rsvp_respostas').delete().in('game_id', jogoIds);
    }
    await supabase.from('votes').delete().eq('team_id', time.id);
    const { error } = await supabase.from('teams').delete().eq('id', time.id);
    if (error) throw new Error(`apagar time ${slug}: ${error.message}`);
  }
  for (const alvo of EMAILS) {
    const u = await acharPorEmail(alvo);
    if (u) await apagarUsuario(u.id).catch((e) => console.warn(`limpeza ${alvo}:`, e.message));
  }
  fs.rmSync(path.join(PASTA, 'sessao-pesada.json'), { force: true });
  fs.rmSync(path.join(PASTA, 'sessao-leve.json'), { force: true });
}

async function sessaoDe(alvo) {
  const anon = createClient(process.env.SUPABASE_URL, chavePublica(), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email: alvo, password: SENHA });
  if (error) throw new Error(`login ${alvo}: ${error.message}`);
  const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  return [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(data.session) }];
}

(async () => {
  if (tem('apagar')) {
    await limpar();
    console.log('times e contas da conta pesada apagados.');
    return;
  }
  await limpar();

  // ── contas ──
  const ids = {};
  for (const alvo of EMAILS) {
    const nome = alvo.replace('prova-r29b-', '').replace('@futtymock.com', '').toUpperCase();
    const { data, error } = await supabase.auth.admin.createUser({ email: alvo, password: SENHA, email_confirm: true, user_metadata: { nome, onboarding_completo: true } });
    if (error) throw new Error(`createUser ${alvo}: ${error.message}`);
    ids[alvo] = data.user.id;
    const { error: eU } = await supabase.from('users').upsert({
      id: data.user.id, email: alvo, nome, nome_jogador: nome, birthdate: '1990-05-05', figurinha_status: 'pronta',
      ...(alvo === email('pesada') ? { is_super_admin: true } : {}),
    }, { onConflict: 'id' });
    if (eU) throw new Error(`users ${alvo}: ${eU.message}`);
  }
  const pesada = ids[email('pesada')];
  const leve = ids[email('leve')];
  const membros = EMAILS.filter((e) => e.includes('-pm-')).map((e) => ids[e]);
  ok(`${EMAILS.length} contas prontas (pesada super-admin, leve, ${membros.length} membros).`);

  const criarTime = async (slug, nome, dono, antiguidadeDias) => {
    const { data: time, error } = await supabase.from('teams')
      .insert({ nome, slug, cor: 'verde', criado_por: dono, publica: false, modo_visibilidade: 'privado', cidade: 'Brasília', localizacao: 'Bancada da conta pesada (descartável)', descricao: 'Time descartável — Rodada 29B, conta pesada.' })
      .select().single();
    if (error) throw new Error(`teams ${slug}: ${error.message}`);
    const { error: eMem } = await supabase.from('team_members').insert({ team_id: time.id, user_id: dono, role: 'admin', categoria: 'linha', pode_postar: true, created_at: dias(-antiguidadeDias) });
    if (eMem) throw new Error(`team_members ${slug}: ${eMem.message}`);
    return time;
  };
  const missa = await criarTime(SLUGS.missa, 'Prova Pesada Missa', pesada, 400);
  const varzea = await criarTime(SLUGS.varzea, 'Prova Pesada Várzea', pesada, 60);
  const timeLeve = await criarTime(SLUGS.leve, 'Prova Leve', leve, 5);

  // ── Várzea-like: 21 membros ──
  {
    const linhas = membros.map((id, i) => ({ team_id: varzea.id, user_id: id, role: 'member', categoria: i % 7 === 0 ? 'GR' : 'linha', pode_postar: true, created_at: dias(-60) }));
    const { error } = await supabase.from('team_members').insert(linhas);
    if (error) throw new Error(`team_members várzea: ${error.message}`);
  }
  const todosVarzea = [pesada, ...membros];

  // Jogos de um time: `passados` encerrados (com placar/artilheiro, para a Resenha e o ranking) e `futuros` agendados.
  const criarJogos = async (time, jogadores, passados, futuros) => {
    for (let i = 0; i < passados; i += 1) {
      const quando = dias(-7 * (i + 1));
      const presentes = jogadores.slice(0, Math.min(jogadores.length, 12 + (i % 3)));
      const { data: g, error } = await supabase.from('games').insert({
        team_id: time.id, data: quando, local: 'Society da prova', jogadores_por_time: 6, num_times: 2, status: 'terminado',
        sorteio_realizado: true, resultado_nivel: 3, time_vencedor: i % 2 ? 'A' : 'B', placar_a: 3, placar_b: i % 4,
        artilheiro_user_id: presentes[i % presentes.length], artilheiro_gols: 2, destaque_user_id: presentes[(i + 1) % presentes.length],
        destaque_titulo: 'Craque da pelada', campeao_time_index: i % 2, created_at: dias(-7 * (i + 1) - 5),
      }).select().single();
      if (error) throw new Error(`games passado ${i}: ${error.message}`);
      const { error: eP } = await supabase.from('game_players').insert(presentes.map((id) => ({ game_id: g.id, user_id: id, confirmado: true, goleiro: false, cabeca_chave: false })));
      if (eP) throw new Error(`game_players passado ${i}: ${eP.message}`);
    }
    for (let i = 0; i < futuros; i += 1) {
      const { data: g, error } = await supabase.from('games').insert({
        team_id: time.id, data: dias(2 + i * 3), local: 'Quadra da prova', jogadores_por_time: 6, max_jogadores: 18, status: 'agendado',
        sorteio_realizado: false, rsvp_aberto: true, rsvp_fechado: false, rsvp_prazo: dias(1 + i * 3),
      }).select().single();
      if (error) throw new Error(`games futuro ${i}: ${error.message}`);
      const confirmados = jogadores.slice(0, Math.min(jogadores.length, 10 + i));
      const { error: eP } = await supabase.from('game_players').insert(confirmados.map((id) => ({ game_id: g.id, user_id: id, confirmado: true, goleiro: false, cabeca_chave: false })));
      if (eP) throw new Error(`game_players futuro ${i}: ${eP.message}`);
      const { error: eR } = await supabase.from('rsvp_respostas').insert(confirmados.map((id) => ({ game_id: g.id, user_id: id, status: 'confirmado' })));
      if (eR) throw new Error(`rsvp_respostas futuro ${i}: ${eR.message}`);
    }
  };
  await criarJogos(varzea, todosVarzea, 6, 3);
  // O Missa tem 1 membro (a pesada): o "histórico" são as jogadas dele sozinho + os convidados que não viram linha.
  await criarJogos(missa, [pesada], 30, 0);
  await criarJogos(timeLeve, [leve], 0, 1);
  ok('jogos criados (Várzea 6 passados + 3 futuros; Missa 30 passados; leve 1 futuro).');

  // ── votos do Várzea-like: todos contra todos ──
  {
    const agora = new Date().toISOString();
    const votos = [];
    for (const de of todosVarzea) for (const para of todosVarzea) {
      if (de !== para) votos.push({ de_user_id: de, para_user_id: para, team_id: varzea.id, nota: 3 + ((de.charCodeAt(0) + para.charCodeAt(1)) % 5) / 2, game_id: null, created_at: agora, updated_at: agora });
    }
    const { error } = await supabase.from('votes').insert(votos);
    if (error) throw new Error(`votes: ${error.message}`);
    ok(`${votos.length} votos`);
  }

  // ── Resenha: posts com fotos (as URLs são do bucket `resenha`, só para a conta do proxy de imagem) ──
  const postar = async (time, autor, n, comFoto) => {
    for (let i = 0; i < n; i += 1) {
      const criadoEm = new Date(Date.now() - (i + 1) * 5 * 3600000).toISOString();
      const { data: post, error } = await supabase.from('feed_posts').insert({ team_id: time.id, author_id: autor, body: `Post ${i + 1} da prova da conta pesada.`, tipo: 'post', created_at: criadoEm, updated_at: criadoEm }).select().single();
      if (error) throw new Error(`feed_posts: ${error.message}`);
      if (!comFoto) continue;
      for (let p = 0; p < 1 + (i % 2); p += 1) {
        const url = `${process.env.SUPABASE_URL}/storage/v1/object/public/resenha/prova-r29b-pesada-${time.slug}-${i}-${p}.webp`;
        const { error: eM } = await supabase.from('feed_post_media').insert({ post_id: post.id, url, media_type: 'image', position: p, bytes: 180000 });
        if (eM) throw new Error(`feed_post_media: ${eM.message}`);
      }
    }
  };
  await postar(missa, pesada, 16, true);
  await postar(varzea, pesada, 9, true);
  ok('Resenha: 16 posts no Missa-like e 9 no Várzea-like (com fotos).');

  fs.mkdirSync(PASTA, { recursive: true });
  const sessaoPesada = await sessaoDe(email('pesada'));
  const sessaoLeve = await sessaoDe(email('leve'));
  fs.writeFileSync(path.join(PASTA, 'sessao-pesada.json'), JSON.stringify(sessaoPesada, null, 2));
  fs.writeFileSync(path.join(PASTA, 'sessao-leve.json'), JSON.stringify(sessaoLeve, null, 2));
  console.log(`sessões em ${PASTA} (sessao-pesada.json, sessao-leve.json)`);
})().catch((e) => { console.error('[prova-conta-pesada] ERRO:', e.message); process.exit(1); });
