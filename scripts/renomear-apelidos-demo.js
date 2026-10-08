// Futty — Renomeia na conta demo das lojas os apelidos pejorativos já trocados em
// scripts/demo-loja.js (decisão do dono, Rodada 30D): Zé Gordo→Roberto, Careca→Carlos,
// Cabeção→Gonçalo, Paulinho Gaúcho→Paulinho, Tiãozinho→Tiago.
//
//   node scripts/renomear-apelidos-demo.js          mostra o que vai mudar, não grava nada
//   node scripts/renomear-apelidos-demo.js --sim    grava de verdade
//
// Só mexe no time da demo (domingueira-fc-demo) e nos times -demo do Radar (pelada-do-guara-demo,
// racha-da-asa-norte-demo, society-lago-sul-demo) — nunca em outro time. Troca três coisas:
// users.nome_jogador de quem é MEMBRO de um desses times, o texto dos posts/comentários da
// Resenha desses times, e o nome congelado dentro de games.times_resultado (o retrato do
// sorteio: routes/games.js devolve esse JSON como está, sem re-hidratar do banco — ver
// comAvataresAtuais, que só atualiza avatar_url, nunca nome).
//
// Correr a partir de backend/ (utils/db.js lê o .env do diretório atual).
const { supabase } = require('../utils/db');

const SIM = process.argv.includes('--sim');

const TROCAS = {
  'Zé Gordo': 'Roberto',
  Careca: 'Carlos',
  Cabeção: 'Gonçalo',
  'Paulinho Gaúcho': 'Paulinho',
  Tiãozinho: 'Tiago',
};

const SLUGS_DA_DEMO = ['domingueira-fc-demo', 'pelada-do-guara-demo', 'racha-da-asa-norte-demo', 'society-lago-sul-demo'];

const ok = (m) => console.log('✓', m);
const info = (m) => console.log('·', m);

// Troca ocorrências do apelido INTEIRO num texto (nunca um pedaço de palavra — as chaves de
// TROCAS são sempre o apelido completo, "Zé Gordo"/"Paulinho Gaúcho" incluídos).
function trocarNoTexto(txt) {
  if (!txt) return txt;
  let novo = txt;
  for (const [de, para] of Object.entries(TROCAS)) novo = novo.split(de).join(para);
  return novo;
}

// O retrato do sorteio (jogadores dos times + reservas) guarda nome solto, não user_id→nome.
function trocarNoResultado(tr) {
  if (!tr || !Array.isArray(tr.times)) return { tr, trocou: false };
  let trocou = false;
  const trocarJogador = (j) => {
    if (j?.nome && TROCAS[j.nome]) { trocou = true; return { ...j, nome: TROCAS[j.nome] }; }
    return j;
  };
  const times = tr.times.map((t) => ({ ...t, jogadores: (t.jogadores || []).map(trocarJogador) }));
  const reservas = (tr.reservas || []).map(trocarJogador);
  return { tr: { ...tr, times, reservas }, trocou };
}

(async () => {
  const { data: times, error: eTimes } = await supabase.from('teams').select('id, slug').in('slug', SLUGS_DA_DEMO);
  if (eTimes) throw new Error(`teams: ${eTimes.message}`);
  if (!times?.length) { info('nenhum time da demo encontrado — rode backend/scripts/demo-loja.js primeiro.'); return; }
  const teamIds = times.map((t) => t.id);
  info(`times da demo: ${times.map((t) => t.slug).join(', ')}`);

  const plano = { usuarios: [], posts: [], comentarios: [], jogos: [] };

  // 1) users.nome_jogador — só quem é membro de um time da demo (nunca um jogador de outro time
  //    que por acaso tenha o mesmo apelido antigo).
  const { data: membros, error: eMembros } = await supabase.from('team_members').select('user_id').in('team_id', teamIds);
  if (eMembros) throw new Error(`team_members: ${eMembros.message}`);
  const userIds = [...new Set((membros || []).map((m) => m.user_id))];
  const { data: usuarios, error: eUsuarios } = await supabase.from('users').select('id, email, nome_jogador').in('id', userIds);
  if (eUsuarios) throw new Error(`users: ${eUsuarios.message}`);
  for (const u of usuarios || []) {
    const novo = TROCAS[u.nome_jogador];
    if (novo) plano.usuarios.push({ id: u.id, email: u.email, de: u.nome_jogador, para: novo });
  }

  // 2) feed_posts.body dos times da demo.
  const { data: posts, error: ePosts } = await supabase.from('feed_posts').select('id, body').in('team_id', teamIds);
  if (ePosts) throw new Error(`feed_posts: ${ePosts.message}`);
  for (const p of posts || []) {
    const novo = trocarNoTexto(p.body);
    if (novo !== p.body) plano.posts.push({ id: p.id, de: p.body, para: novo });
  }

  // 3) comentarios.body — só os que respondem a um post de um time da demo.
  const postIds = (posts || []).map((p) => p.id);
  let comentarios = [];
  if (postIds.length) {
    const { data, error } = await supabase.from('comentarios').select('id, body').eq('parent_type', 'post').in('parent_id', postIds);
    if (error) throw new Error(`comentarios: ${error.message}`);
    comentarios = data || [];
  }
  for (const c of comentarios) {
    const novo = trocarNoTexto(c.body);
    if (novo !== c.body) plano.comentarios.push({ id: c.id, de: c.body, para: novo });
  }

  // 4) games.times_resultado dos times da demo (passados e o próximo, se já sorteado).
  const { data: jogos, error: eJogos } = await supabase.from('games').select('id, times_resultado').in('team_id', teamIds).not('times_resultado', 'is', null);
  if (eJogos) throw new Error(`games: ${eJogos.message}`);
  for (const g of jogos || []) {
    const { tr, trocou } = trocarNoResultado(g.times_resultado);
    if (trocou) plano.jogos.push({ id: g.id, tr });
  }

  console.log(`\nPlano (${SIM ? 'GRAVANDO' : 'simulação — rode com --sim para gravar'}):`);
  for (const u of plano.usuarios) console.log(`  users ${u.email}: "${u.de}" → "${u.para}"`);
  for (const p of plano.posts) console.log(`  feed_posts ${p.id.slice(0, 8)}: "${p.de}" → "${p.para}"`);
  for (const c of plano.comentarios) console.log(`  comentarios ${c.id.slice(0, 8)}: "${c.de}" → "${c.para}"`);
  for (const g of plano.jogos) console.log(`  games ${g.id.slice(0, 8)}: nome(s) trocado(s) no retrato do sorteio`);
  console.log(`\nTotal: ${plano.usuarios.length} jogador(es), ${plano.posts.length} post(s), ${plano.comentarios.length} comentário(s), ${plano.jogos.length} jogo(s).`);

  if (!SIM) { info('nada gravado — confira acima e rode de novo com --sim.'); return; }

  for (const u of plano.usuarios) {
    const { error } = await supabase.from('users').update({ nome_jogador: u.para }).eq('id', u.id);
    if (error) throw new Error(`users ${u.email}: ${error.message}`);
  }
  for (const p of plano.posts) {
    const { error } = await supabase.from('feed_posts').update({ body: p.para }).eq('id', p.id);
    if (error) throw new Error(`feed_posts ${p.id}: ${error.message}`);
  }
  for (const c of plano.comentarios) {
    const { error } = await supabase.from('comentarios').update({ body: c.para }).eq('id', c.id);
    if (error) throw new Error(`comentarios ${c.id}: ${error.message}`);
  }
  for (const g of plano.jogos) {
    const { error } = await supabase.from('games').update({ times_resultado: g.tr }).eq('id', g.id);
    if (error) throw new Error(`games ${g.id}: ${error.message}`);
  }
  ok(`gravado: ${plano.usuarios.length} jogador(es), ${plano.posts.length} post(s), ${plano.comentarios.length} comentário(s), ${plano.jogos.length} jogo(s).`);
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
