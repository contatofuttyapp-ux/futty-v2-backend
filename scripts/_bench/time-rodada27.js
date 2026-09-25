// ═══════════════════════════════════════════════════════════════════════════════
// TIME DESCARTÁVEL DA RODADA 27 — "check-up da foto de verdade" (25-set).
//
// A cena `rodada27` do scripts/ver-iphone.mjs (frontend) mede, em servidor LOCAL, o que
// o dono relatou pelo celular: "Trocar visual" que não troca, foto que demora a aparecer,
// enquadramento que muda de tela para tela e troca de tela lenta. Para isso precisa de:
//   · uma conta COM foto (a foto de partida é uma imagem lisa, distinta da de prova);
//   · uma conta SEM foto (vê o genérico da casa, escolhe outro);
//   · um time onde as duas jogam, com Ranking (≥ 3 jogos), Presença e Sorteio de verdade
//     — as telas onde a foto aparece pequena, em quadrado e em cartão 3:4.
// Nada disto gera figurinha (custo de IA zero). Tudo é @futtymock e descartável; o time
// é SÓ desta rodada (nunca a domingueira-fc-demo, que é a conta dos revisores das lojas).
//
//   node scripts/_bench/time-rodada27.js            cria/refaz e grava as sessões
//   node scripts/_bench/time-rodada27.js --apagar   apaga o time e as contas
//
// Sai em ../frontend/scripts/capturas/sessao-rodada27.json (fora do git).
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');
const { supabase, computeRatings } = require('../../utils/db');
const { executarSorteio } = require('../../utils/sorteio');
const { RATING_DEFAULT } = require('../../utils/helpers');
const { apagarUsuario } = require('../../utils/apagarUsuario');

const SENHA = 'Prova!Rodada27-2026';
const SLUG = 'prova-r27';
const KITS = `${process.env.SUPABASE_URL}/storage/v1/object/public/kits`;
const DESTINO = path.join(__dirname, '..', '..', '..', 'frontend', 'scripts', 'capturas', 'sessao-rodada27.json');

// Os dois sujeitos + quatro companheiros de silhueta (bucket `kits`, sem proxy de mídia).
const SUJEITOS = {
  foto: { email: 'prova-r27-foto@futtymock.com', nome_jogador: 'FOTO27', admin: true },
  semfoto: { email: 'prova-r27-semfoto@futtymock.com', nome_jogador: 'SEM27' },
};
const FIGURANTES = ['1', '2', '3', '4'].map((n, i) => ({
  email: `prova-r27-f${n}@futtymock.com`,
  nome_jogador: `FIG${n}`,
  avatar_url: `${KITS}/avatar-generico-${(i % 3) + 1}.png`,
}));
const TODOS = [...Object.values(SUJEITOS), ...FIGURANTES];

const tem = (n) => process.argv.includes(`--${n}`);
const ok = (m) => console.log('✓', m);
const round1 = (n) => Math.round(n * 10) / 10;

async function acharPorEmail(email) {
  const { data } = await supabase.auth.admin.listUsers({ perPage: 200 });
  return (data?.users || []).find((u) => (u.email || '').toLowerCase() === email) || null;
}

async function limpar() {
  const { data: time } = await supabase.from('teams').select('id').eq('slug', SLUG).maybeSingle();
  if (time) {
    const { error } = await supabase.from('teams').delete().eq('id', time.id);
    if (error) throw new Error(`apagar time: ${error.message}`);
  }
  for (const { email } of TODOS) {
    const u = await acharPorEmail(email);
    if (u) await apagarUsuario(u.id).catch((e) => console.warn(`limpeza ${email}:`, e.message));
  }
  fs.rmSync(DESTINO, { force: true });
}

async function sessaoDe(email) {
  const anon = createClient(process.env.SUPABASE_URL, require('../../utils/chavesSupabase').chavePublica());
  const { data, error } = await anon.auth.signInWithPassword({ email, password: SENHA });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  return [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(data.session) }];
}

/** A foto de partida da conta COM foto: 2:3, lisa (verde), sem nada que se confunda com a de prova. */
async function subirFotoDePartida(userId) {
  const buf = await sharp({ create: { width: 800, height: 1200, channels: 3, background: { r: 30, g: 150, b: 80 } } })
    .jpeg({ quality: 90 })
    .toBuffer();
  const carimbo = Date.now();
  const caminho = `public/${userId}-${carimbo}.jpg`;
  const { error } = await supabase.storage.from('avatars').upload(caminho, buf, { contentType: 'image/jpeg', upsert: false });
  if (error) throw new Error(`upload da foto de partida: ${error.message}`);
  const { data } = supabase.storage.from('avatars').getPublicUrl(caminho);
  return `${data.publicUrl}?v=${carimbo}`;
}

(async () => {
  if (tem('apagar')) {
    await limpar();
    console.log('time e contas da rodada 27 apagados.');
    return;
  }
  await limpar(); // refaz do zero: a cena troca a foto de verdade

  const ids = {};
  for (const [papel, def] of [...Object.entries(SUJEITOS), ...FIGURANTES.map((f, i) => [`fig${i + 1}`, f])]) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: def.email, password: SENHA, email_confirm: true,
      user_metadata: { nome: def.nome_jogador, onboarding_completo: true },
    });
    if (error) throw new Error(`createUser ${def.email}: ${error.message}`);
    ids[papel] = data.user.id;
    const linha = { id: data.user.id, email: def.email, nome: def.nome_jogador, nome_jogador: def.nome_jogador };
    if (papel === 'foto') {
      const url = await subirFotoDePartida(data.user.id);
      Object.assign(linha, { foto_url: url, avatar_url: url, figurinha_status: 'pronta' });
    } else if (def.avatar_url) {
      linha.avatar_url = def.avatar_url; // silhueta do bucket kits, como as contas fictícias da demo
    }
    const { error: eUp } = await supabase.from('users').upsert(linha, { onConflict: 'id' });
    if (eUp) throw new Error(`users ${def.email}: ${eUp.message}`);
  }
  ok(`6 contas prontas (com foto, sem foto, 4 figurantes).`);

  const { data: time, error: eTime } = await supabase.from('teams')
    .insert({ nome: 'Prova R27', slug: SLUG, cor: 'roxo', criado_por: ids.foto, publica: false, modo_visibilidade: 'privado', cidade: 'Brasília', localizacao: 'Bancada da rodada 27 (descartável)', descricao: 'Time descartável — check-up da foto.' })
    .select().single();
  if (eTime) throw new Error(`teams: ${eTime.message}`);
  const papeis = Object.keys(ids);
  const { error: eMem } = await supabase.from('team_members').insert(
    papeis.map((p) => ({ team_id: time.id, user_id: ids[p], role: p === 'foto' ? 'admin' : 'member', categoria: 'linha', pode_postar: true })),
  );
  if (eMem) throw new Error(`team_members: ${eMem.message}`);

  // Ranking só lista quem tem ≥ 3 jogos confirmados: dois de enchimento (passados) + o do sorteio.
  for (let i = 1; i <= 2; i += 1) {
    const { data: jogo, error: eJ } = await supabase.from('games')
      .insert({ team_id: time.id, data: new Date(Date.now() - i * 7 * 86400000).toISOString(), local: 'Society da Bancada', jogadores_por_time: 3, max_jogadores: 6 })
      .select().single();
    if (eJ) throw new Error(`games(enchimento ${i}): ${eJ.message}`);
    const { error: eGp } = await supabase.from('game_players').insert(papeis.map((p) => ({ game_id: jogo.id, user_id: ids[p], confirmado: true })));
    if (eGp) throw new Error(`game_players(enchimento ${i}): ${eGp.message}`);
  }
  const daqui3dias = new Date(Date.now() + 3 * 86400000);
  daqui3dias.setUTCHours(12, 0, 0, 0); // 9h em Brasília
  const { data: game, error: eGame } = await supabase.from('games')
    .insert({ team_id: time.id, data: daqui3dias.toISOString(), local: 'Society da Bancada', jogadores_por_time: 3, max_jogadores: 6 })
    .select().single();
  if (eGame) throw new Error(`games: ${eGame.message}`);
  const { error: eConf } = await supabase.from('game_players').insert(papeis.map((p) => ({ game_id: game.id, user_id: ids[p], confirmado: true, goleiro: false, cabeca_chave: false })));
  if (eConf) throw new Error(`game_players: ${eConf.message}`);
  ok('3 jogos (2 de enchimento + 1 marcado), os 6 confirmados.');

  // Sorteio pelo algoritmo real (o mesmo de POST /api/games/:id/sortear).
  const { data: gp } = await supabase.from('game_players')
    .select('goleiro, cabeca_chave, users ( id, nome, nome_jogador, avatar_url )')
    .eq('game_id', game.id).eq('confirmado', true);
  const confirmados = (gp || []).filter((p) => p.users);
  const ratings = await computeRatings(time.id, confirmados.map((p) => p.users.id));
  const todos = confirmados.map((p) => ({
    user_id: p.users.id, nome: p.users.nome_jogador || p.users.nome || 'Jogador', avatar_url: p.users.avatar_url || null,
    rating: round1(ratings[p.users.id] ?? RATING_DEFAULT), goleiro: p.goleiro, cabeca_chave: p.cabeca_chave,
  }));
  const sorteio = executarSorteio(todos, 3, {});
  const times = sorteio.times.map((jogadores, i) => ({
    nome: ['Time A', 'Time B'][i] || `Time ${i + 1}`,
    rating_medio: Math.round((jogadores.reduce((s, j) => s + j.rating, 0) / (jogadores.length || 1)) * 100) / 100,
    jogadores,
  }));
  const resultado = { num_times: sorteio.numTimes, total_jogadores: todos.length, convidados_total: 0, seed: sorteio.seed, avisos: [], times, reservas: sorteio.reservas };
  const { error: eSort } = await supabase.from('games').update({ num_times: sorteio.numTimes, sorteio_realizado: true, times_resultado: resultado }).eq('id', game.id);
  if (eSort) throw new Error(`sorteio: ${eSort.message}`);
  ok(`sorteio gravado — semente ${resultado.seed}.`);

  const sessoes = { time: { id: time.id, slug: SLUG }, jogo: { id: game.id }, ids, foto: await sessaoDe(SUJEITOS.foto.email), semfoto: await sessaoDe(SUJEITOS.semfoto.email) };
  fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
  fs.writeFileSync(DESTINO, JSON.stringify(sessoes, null, 2));
  console.log(`sessões em ${DESTINO}`);
  console.log(`  Ranking:  /equipa/${SLUG}/ranking`);
  console.log(`  Presença: /equipa/${SLUG}/jogo/${game.id}`);
  console.log(`  Sorteio:  /equipa/${SLUG}/jogo/${game.id}/sorteio`);
})().catch((e) => { console.error('[time-rodada27] ERRO:', e.message); process.exit(1); });
