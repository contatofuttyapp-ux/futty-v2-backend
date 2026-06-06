// Futty v2.0 — Seed da Resenha (dados de demonstração reais na Domingueira).
// Cria 3 jogos com resultado, 2 posts, 3 comentários e várias reações.
//
// Uso:
//   node backend/scripts/seed-resenha.js --dry-run   (não escreve; só mostra)
//   node backend/scripts/seed-resenha.js             (aplica na BD)
//
// Idempotente: verifica antes de inserir (não duplica). Busca todos os IDs em
// runtime a partir da equipa "domingueira" e dos membros migrados.

const { supabase } = require('../utils/db');

const DRY = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const TEAM_SLUG = 'domingueira';

// Emails dos 10 jogadores (mock) — ordem usada para montar os 2 times.
const PLAYER_EMAILS = [
  'gui@futtymock.com',
  'jefin@futtymock.com',
  'kleverton@futtymock.com',
  'wesley@futtymock.com',
  'erick@futtymock.com',
  'marcus@futtymock.com',
  'gabriel@futtymock.com',
  'eduardo@futtymock.com',
  'kimzera@futtymock.com',
  'matheus@futtymock.com',
];
const PEDRO_EMAIL = 'contatofuttyapp@gmail.com';

const ok = (m) => console.log(`✅ ${m}`);
const skip = (m) => console.log(`⚠️  ${m}`);
const err = (m) => console.log(`❌ ${m}`);
const info = (m) => console.log(`ℹ️  ${m}`);
const stats = { jogos: 0, posts: 0, comentarios: 0, reacoes: 0 };

// Monta o times_resultado (2 times de 5) a partir de uma lista de membros.
function montarTimes(jogadores) {
  const carta = (m) => ({ user_id: m.user_id, nome: m.nome, avatar_url: m.avatar_url || null, rating: 3, goleiro: false, cabeca_chave: false });
  return {
    num_times: 2,
    total_jogadores: jogadores.length,
    avisos: [],
    times: [
      { nome: 'Time A', rating_medio: 3, jogadores: jogadores.slice(0, 5).map(carta) },
      { nome: 'Time B', rating_medio: 3, jogadores: jogadores.slice(5, 10).map(carta) },
    ],
    reservas: [],
  };
}

(async () => {
  console.log(`\n=== Seed Resenha ${DRY ? '(DRY-RUN — sem escrever)' : '(A ESCREVER NA BD)'} ===`);

  // 1) Equipa
  const { data: team } = await supabase.from('teams').select('id, nome, slug').eq('slug', TEAM_SLUG).maybeSingle();
  if (!team) {
    err(`Equipa "${TEAM_SLUG}" não encontrada. Corre primeiro a migração de perfis.`);
    process.exitCode = 1;
    return;
  }
  info(`Equipa: ${team.nome} (${team.id})`);

  // 2) Membros (por email)
  const { data: membros } = await supabase
    .from('team_members')
    .select('user_id, users ( nome, nome_jogador, avatar_url, email )')
    .eq('team_id', team.id);
  const byEmail = {};
  for (const m of membros || []) {
    const u = m.users;
    if (u?.email) byEmail[u.email] = { user_id: m.user_id, nome: u.nome_jogador || u.nome || u.email, avatar_url: u.avatar_url };
  }

  // Verifica que todos os emails necessários existem.
  const necessarios = [...PLAYER_EMAILS, PEDRO_EMAIL];
  const faltam = necessarios.filter((e) => !byEmail[e]);
  if (faltam.length) {
    err(`Faltam membros na Domingueira: ${faltam.join(', ')}. Corre a migração de perfis primeiro.`);
    process.exitCode = 1;
    return;
  }
  const jogadores = PLAYER_EMAILS.map((e) => byEmail[e]); // 10 jogadores, ordem fixa
  const uid = (email) => byEmail[email].user_id;

  // 3) Config dos 3 jogos. (Motta não existe → fallback Kimzera; Dudu = Eduardo.)
  const JOGOS = [
    {
      local: 'Domingueira 03/05',
      data: '2026-05-03T12:00:00',
      campeao_time_index: 0,
      campeao_foto_url: '/public/fotos-jogos/03.05.2026.jpeg',
      artilheiro: 'gui@futtymock.com',
      artilheiro_gols: 2,
      destaque: 'jefin@futtymock.com',
      destaque_titulo: 'Melhor em campo',
      rodada: 'kimzera@futtymock.com', // "Motta" indisponível
      rodada_foto_url: null,
    },
    {
      local: 'Domingueira 26/04',
      data: '2026-04-26T12:00:00',
      campeao_time_index: 1,
      campeao_foto_url: '/public/fotos-jogos/26.04.2026.jpeg',
      artilheiro: 'wesley@futtymock.com',
      artilheiro_gols: 3,
      destaque: 'erick@futtymock.com',
      destaque_titulo: 'Craque do jogo',
      rodada: 'gabriel@futtymock.com',
      rodada_foto_url: '/public/fotos-jogos/23.04.2026.jpeg',
    },
    {
      local: 'Domingueira 12/04',
      data: '2026-04-12T12:00:00',
      campeao_time_index: 0,
      campeao_foto_url: '/public/fotos-jogos/12.04.2026.jpeg',
      artilheiro: 'kleverton@futtymock.com',
      artilheiro_gols: 1,
      destaque: 'marcus@futtymock.com',
      destaque_titulo: 'Goleiro do jogo',
      rodada: 'eduardo@futtymock.com', // "Dudu"
      rodada_foto_url: null,
    },
  ];

  // Jogos existentes (idempotência por `local`).
  const { data: existentes } = await supabase.from('games').select('id, local').eq('team_id', team.id);
  const jogoIdPorLocal = {};
  for (const g of existentes || []) jogoIdPorLocal[g.local] = g.id;

  const gameIds = {};
  for (const j of JOGOS) {
    if (jogoIdPorLocal[j.local]) {
      gameIds[j.local] = jogoIdPorLocal[j.local];
      skip(`Jogo "${j.local}" já existe (${gameIds[j.local]}).`);
      continue;
    }
    const row = {
      team_id: team.id,
      data: new Date(j.data).toISOString(),
      local: j.local,
      jogadores_por_time: 5,
      num_times: 2,
      status: 'terminado', // 'finished' não é válido no CHECK de games.status
      sorteio_realizado: true,
      times_resultado: montarTimes(jogadores),
      campeao_time_index: j.campeao_time_index,
      campeao_foto_url: j.campeao_foto_url,
      artilheiro_user_id: uid(j.artilheiro),
      artilheiro_gols: j.artilheiro_gols,
      destaque_user_id: uid(j.destaque),
      destaque_titulo: j.destaque_titulo,
      rodada_user_id: uid(j.rodada),
      rodada_foto_url: j.rodada_foto_url,
    };
    if (DRY) {
      gameIds[j.local] = `(dry:${j.local})`;
      ok(`[dry] criaria jogo "${j.local}"`);
      stats.jogos += 1;
      continue;
    }
    const { data: created, error } = await supabase.from('games').insert(row).select('id').single();
    if (error) {
      err(`Jogo "${j.local}": ${error.message}`);
      continue;
    }
    gameIds[j.local] = created.id;
    ok(`Jogo "${j.local}" criado (ID: ${created.id})`);
    stats.jogos += 1;

    // game_players: todos os 10 jogadores confirmados.
    const gpRows = jogadores.map((m) => ({ game_id: created.id, user_id: m.user_id, confirmado: true }));
    const { error: gpErr } = await supabase.from('game_players').upsert(gpRows, { onConflict: 'game_id,user_id' });
    if (gpErr) err(`game_players de "${j.local}": ${gpErr.message}`);
  }

  // 4) Posts (idempotência por body)
  const POSTS = [
    { author: PEDRO_EMAIL, body: 'Que jogo incrível hoje! Time A arrasou do início ao fim. Parabéns a todos! 🏆⚽' },
    { author: 'gui@futtymock.com', body: 'Alguém viu o golaço do Kleverton? Absurdo! 🔥' },
  ];
  const { data: postsExist } = await supabase.from('feed_posts').select('id, body').eq('team_id', team.id);
  const postIdPorBody = {};
  for (const p of postsExist || []) postIdPorBody[p.body] = p.id;

  const postIds = {};
  for (const p of POSTS) {
    if (postIdPorBody[p.body]) {
      postIds[p.body] = postIdPorBody[p.body];
      skip(`Post já existe ("${p.body.slice(0, 24)}…").`);
      continue;
    }
    if (DRY) {
      postIds[p.body] = `(dry-post)`;
      ok(`[dry] criaria post de ${p.author}`);
      stats.posts += 1;
      continue;
    }
    const { data: created, error } = await supabase
      .from('feed_posts')
      .insert({ team_id: team.id, author_id: uid(p.author), body: p.body })
      .select('id')
      .single();
    if (error) {
      err(`Post: ${error.message}`);
      continue;
    }
    postIds[p.body] = created.id;
    stats.posts += 1;
  }
  if (!DRY) ok(`${stats.posts} posts criados`);

  // 5) Comentários (idempotência por parent + autor + body)
  const jogo1 = gameIds['Domingueira 03/05'];
  const post1 = postIds[POSTS[0].body];
  const COMENTARIOS = [
    { parent_type: 'game', parent_id: jogo1, author: 'jefin@futtymock.com', body: 'Que jogo! Merecemos muito!' },
    { parent_type: 'game', parent_id: jogo1, author: 'wesley@futtymock.com', body: 'Gui arrasou hoje 👏' },
    { parent_type: 'post', parent_id: post1, author: 'erick@futtymock.com', body: 'Demais! Próximo domingo tem mais!' },
  ];
  for (const c of COMENTARIOS) {
    if (!c.parent_id || String(c.parent_id).startsWith('(dry')) {
      if (DRY) {
        ok(`[dry] comentário de ${c.author} em ${c.parent_type}`);
        stats.comentarios += 1;
      } else {
        skip(`Comentário ignorado (parent ${c.parent_type} inexistente).`);
      }
      continue;
    }
    const { data: existe } = await supabase
      .from('comentarios')
      .select('id')
      .eq('parent_type', c.parent_type)
      .eq('parent_id', c.parent_id)
      .eq('author_id', uid(c.author))
      .eq('body', c.body)
      .maybeSingle();
    if (existe) {
      skip(`Comentário já existe ("${c.body.slice(0, 20)}…").`);
      continue;
    }
    const { error } = await supabase
      .from('comentarios')
      .insert({ parent_type: c.parent_type, parent_id: c.parent_id, author_id: uid(c.author), body: c.body });
    if (error) {
      err(`Comentário: ${error.message}`);
      continue;
    }
    stats.comentarios += 1;
  }
  if (!DRY) ok(`${stats.comentarios} comentários criados`);

  // 6) Reações (upsert — unique por target+user)
  const jogo2 = gameIds['Domingueira 26/04'];
  const post2 = postIds[POSTS[1].body];
  const REACOES = [
    // Jogo 1: 3× ❤️
    { tt: 'game', ti: jogo1, email: 'jefin@futtymock.com', emoji: '❤️' },
    { tt: 'game', ti: jogo1, email: 'wesley@futtymock.com', emoji: '❤️' },
    { tt: 'game', ti: jogo1, email: 'erick@futtymock.com', emoji: '❤️' },
    // Jogo 2: 2× 👍 + 1× 😂
    { tt: 'game', ti: jogo2, email: 'gui@futtymock.com', emoji: '👍' },
    { tt: 'game', ti: jogo2, email: 'marcus@futtymock.com', emoji: '👍' },
    { tt: 'game', ti: jogo2, email: 'kleverton@futtymock.com', emoji: '😂' },
    // Post 1: 4× 👍
    { tt: 'post', ti: post1, email: 'gui@futtymock.com', emoji: '👍' },
    { tt: 'post', ti: post1, email: 'jefin@futtymock.com', emoji: '👍' },
    { tt: 'post', ti: post1, email: 'wesley@futtymock.com', emoji: '👍' },
    { tt: 'post', ti: post1, email: 'kleverton@futtymock.com', emoji: '👍' },
    // Post 2: 2× 😮 + 1× ❤️
    { tt: 'post', ti: post2, email: 'erick@futtymock.com', emoji: '😮' },
    { tt: 'post', ti: post2, email: 'gabriel@futtymock.com', emoji: '😮' },
    { tt: 'post', ti: post2, email: 'wesley@futtymock.com', emoji: '❤️' },
  ];
  for (const r of REACOES) {
    if (!r.ti || String(r.ti).startsWith('(dry')) {
      if (DRY) stats.reacoes += 1;
      continue;
    }
    if (DRY) {
      stats.reacoes += 1;
      continue;
    }
    const { error } = await supabase
      .from('reacoes')
      .upsert({ target_type: r.tt, target_id: r.ti, user_id: uid(r.email), emoji: r.emoji }, { onConflict: 'target_type,target_id,user_id' });
    if (error) err(`Reação (${r.tt}): ${error.message}`);
    else stats.reacoes += 1;
  }
  ok(`${stats.reacoes} reações criadas`);

  console.log('─────────────────────────────────────');
  console.log(`Jogos       : ${stats.jogos}`);
  console.log(`Posts       : ${stats.posts}`);
  console.log(`Comentários : ${stats.comentarios}`);
  console.log(`Reações     : ${stats.reacoes}`);
  console.log(DRY ? '\n(DRY-RUN: nada foi escrito.)' : '\nSeed completo! Abre a Resenha para ver.');
})().catch((e) => {
  err(e.message);
  process.exitCode = 1;
});
