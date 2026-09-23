// Futty v2.0 — CAPTURA DA CERIMÔNIA COM TIME MISTO (23-set).
//
// Cria um time DESCARTÁVEL "Prova Mista" com 10 jogadores: 4 com figurinha
// (PNGs já pagos de saida-prompt/saida-economia — nenhuma geração de IA nova,
// custo US$0) e 6 só com foto (BANCADA-FOTOS, card comum). Marca 1 goleiro e
// 1 cabeça de chave, cria um jogo, confirma os 10 e sorteia pelo algoritmo
// real (mesma função de routes/games.js) — a seed fica gravada em
// times_resultado, pronta para o ver-iphone.mjs reproduzir a cerimônia.
//
// Uso (a partir de backend/):
//   node scripts/_bench/prova-mista.js            cria tudo, sorteia, grava a sessão do capitão
//   node scripts/_bench/prova-mista.js --apagar   apaga o time e os 10 jogadores
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { supabase, computeRatings } = require('../../utils/db');
const { executarSorteio } = require('../../utils/sorteio');
const { RATING_DEFAULT } = require('../../utils/helpers');
const { apagarUsuario } = require('../../utils/apagarUsuario');

const APAGAR = process.argv.includes('--apagar');
const SENHA = 'Prova!Mista3-2026';
const SLUG = 'prova-mista-demo';
const NOMES_TIMES = ['Time A', 'Time B'];
const PASTA_BENCH = __dirname;
const BANCADA_FOTOS = path.resolve(__dirname, '..', '..', '..', '..', 'BANCADA-FOTOS');
const DESTINO_SESSAO = path.join(__dirname, '..', '..', '..', 'frontend', 'scripts', 'capturas', 'sessao-prova-mista.json');
const DESTINO_ESTADO = path.join(__dirname, '..', '..', '..', 'frontend', 'scripts', 'capturas', 'estado-prova-mista.json');

const ok = (m) => console.log('✓', m);
const info = (m) => console.log('·', m);
const round1 = (n) => Math.round(n * 10) / 10;

// 4 jogadores com FIGURINHA — PNG já pago (bancada de custo, não gera nada agora).
const FIGURINHA = [
  { apelido: 'Gui-Fig', nome: 'Guilherme (figurinha)', posicao: 'ATA', forca: 4.0, arq: path.join(PASTA_BENCH, 'saida-prompt', 'Gui', '6.png') },
  { apelido: 'Renato-Fig', nome: 'Renato (figurinha)', posicao: 'MEI', forca: 3.8, cabeca: false, arq: path.join(PASTA_BENCH, 'saida-prompt', 'Renato', '6.png') },
  { apelido: 'Menor-Fig', nome: 'Menor K (figurinha)', posicao: 'DEF', forca: 3.5, arq: path.join(PASTA_BENCH, 'saida-economia', 'Menor_K_churras', '3.png') },
  { apelido: 'Sdasad-Fig', nome: 'Sdasad (figurinha)', posicao: 'GL', forca: 3.6, gr: true, arq: path.join(PASTA_BENCH, 'saida-prompt', 'sdasad', '6.png') },
];
// 6 jogadores só com FOTO — card comum (grátis), BANCADA-FOTOS.
const FOTO = [
  { apelido: 'Gui-Foto', nome: 'Guilherme (foto)', posicao: 'MEI', forca: 3.2, arq: path.join(BANCADA_FOTOS, 'Gui.jpeg') },
  { apelido: 'Renato-Foto', nome: 'Renato (foto)', posicao: 'DEF', forca: 3.0, arq: path.join(BANCADA_FOTOS, 'Renato.jpeg') },
  { apelido: 'Menor-Foto', nome: 'Menor K (foto)', posicao: 'ATA', forca: 3.4, cabeca: true, arq: path.join(BANCADA_FOTOS, 'Menor K churras.jpeg') },
  { apelido: 'WA1-Foto', nome: 'Jogador WA1 (foto)', posicao: 'MEI', forca: 2.8, arq: path.join(BANCADA_FOTOS, 'WhatsApp Image 2026-04-19 at 15.01.22d - Cópia.jpeg') },
  { apelido: 'WA2-Foto', nome: 'Jogador WA2 (foto)', posicao: 'DEF', forca: 2.6, arq: path.join(BANCADA_FOTOS, 'WhatsApp Image 2026-04-19 at 15.01.22d - Cópia (3).jpeg') },
  { apelido: 'WA3-Foto', nome: 'Jogador WA3 (foto)', posicao: 'ATA', forca: 3.0, arq: path.join(BANCADA_FOTOS, 'WhatsApp Image 2026-04-19 at 15.01.22s.jpeg') },
];
const TODOS_DEF = FIGURINHA.concat(FOTO);
const emailDe = (apelido) => `prova-mista-${apelido.toLowerCase()}@futtymock.com`;

async function acharTime() {
  const { data } = await supabase.from('teams').select('id').eq('slug', SLUG).maybeSingle();
  return data;
}

async function limpar() {
  const time = await acharTime();
  if (time) {
    const { error } = await supabase.from('teams').delete().eq('id', time.id);
    if (error) throw new Error(`apagar teams: ${error.message}`);
    info('time "Prova Mista" apagado (team_members/games/game_players em cascata).');
  }
  for (const j of TODOS_DEF) {
    const email = emailDe(j.apelido);
    const { data: u } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    if (u) {
      // eslint-disable-next-line no-await-in-loop
      await apagarUsuario(u.id);
      info(`conta ${email} apagada.`);
    }
  }
  fs.rmSync(DESTINO_SESSAO, { force: true });
  fs.rmSync(DESTINO_ESTADO, { force: true });
}

async function criarJogador(j, comFigurinha) {
  const email = emailDe(j.apelido);
  const { data, error } = await supabase.auth.admin.createUser({
    email, password: SENHA, email_confirm: true,
    user_metadata: { nome: j.nome, onboarding_completo: true },
  });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  const id = data.user.id;

  const buffer = fs.readFileSync(j.arq);
  const ext = comFigurinha ? 'png' : 'jpg';
  const nomeArq = comFigurinha ? `public/${id}-ai-dark-gold.png` : `public/${id}.jpg`;
  const { error: eUp } = await supabase.storage.from('avatars').upload(nomeArq, buffer, {
    contentType: comFigurinha ? 'image/png' : 'image/jpeg', upsert: true,
  });
  if (eUp) throw new Error(`upload ${email}: ${eUp.message}`);
  const url = `${process.env.SUPABASE_URL}/storage/v1/object/public/avatars/${nomeArq}`;

  const linha = comFigurinha
    ? { id, email, nome: j.nome, nome_jogador: j.apelido, avatar_url: url, kit_ativo: 'dark-gold', fundo_figurinha: 'estadio', cor_frame: 'dourado', figurinha_status: 'pronta' }
    : { id, email, nome: j.nome, nome_jogador: j.apelido, avatar_url: url, foto_url: url };
  const { error: eUps } = await supabase.from('users').upsert(linha, { onConflict: 'id' });
  if (eUps) throw new Error(`upsert ${email}: ${eUps.message}`);
  return id;
}

async function criarTudo() {
  if (await acharTime()) {
    console.error(`o time ${SLUG} já existe. Corra primeiro: node scripts/_bench/prova-mista.js --apagar`);
    process.exit(1);
  }

  const ids = {};
  for (const j of FIGURINHA) ids[j.apelido] = await criarJogador(j, true);
  for (const j of FOTO) ids[j.apelido] = await criarJogador(j, false);
  ok(`10 jogador(es) prontos (4 figurinha + 6 foto).`);

  const capitao = FIGURINHA[0];
  const { data: time, error } = await supabase.from('teams').insert({
    nome: 'Prova Mista', slug: SLUG, cor: 'roxo', criado_por: ids[capitao.apelido],
    publica: false, modo_visibilidade: 'privado', cidade: 'Brasília',
    localizacao: 'Bancada de captura (descartável)', descricao: 'Time descartável — prova visual figurinha × foto.',
  }).select().single();
  if (error) throw new Error(`teams: ${error.message}`);

  const membros = TODOS_DEF.map((j) => ({
    user_id: ids[j.apelido], team_id: time.id,
    role: j.apelido === capitao.apelido ? 'admin' : 'member',
    categoria: j.gr ? 'GR' : 'linha', posicao: j.posicao, pode_postar: true,
  }));
  const { error: e2 } = await supabase.from('team_members').insert(membros);
  if (e2) throw new Error(`team_members: ${e2.message}`);
  ok(`time "Prova Mista" (${SLUG}) com ${membros.length} jogadores.`);

  // Ranking v2 (routes/ranking.js) só lista quem tem >= 3 jogos confirmados —
  // sem isto o Ranking sai vazio. 2 jogos "de enchimento" (passados, sem
  // sorteio) bastam: só contam presença, não precisam de placar nem votos.
  for (let i = 1; i <= 2; i += 1) {
    const dataPassada = new Date(Date.now() - i * 7 * 86400000).toISOString();
    // eslint-disable-next-line no-await-in-loop
    const { data: jogoEnchimento, error: eJE } = await supabase.from('games').insert({
      team_id: time.id, data: dataPassada, local: 'Society da Bancada', jogadores_por_time: 5, max_jogadores: 10,
    }).select().single();
    if (eJE) throw new Error(`games(enchimento ${i}): ${eJE.message}`);
    const linhasJE = TODOS_DEF.map((j) => ({ game_id: jogoEnchimento.id, user_id: ids[j.apelido], confirmado: true }));
    // eslint-disable-next-line no-await-in-loop
    const { error: eGpJE } = await supabase.from('game_players').insert(linhasJE);
    if (eGpJE) throw new Error(`game_players(enchimento ${i}): ${eGpJE.message}`);
  }
  ok('2 jogos de enchimento (presença) para o Ranking passar do mínimo de 3 jogos.');

  const daqui3dias = new Date(Date.now() + 3 * 86400000);
  daqui3dias.setUTCHours(12, 0, 0, 0); // 9h em Brasília (UTC-3)
  const { data: game, error: eGame } = await supabase.from('games').insert({
    team_id: time.id, data: daqui3dias.toISOString(), local: 'Society da Bancada',
    jogadores_por_time: 5, max_jogadores: 10,
  }).select().single();
  if (eGame) throw new Error(`games: ${eGame.message}`);

  const linhasConfirmacao = TODOS_DEF.map((j) => ({
    game_id: game.id, user_id: ids[j.apelido], confirmado: true,
    goleiro: !!j.gr, cabeca_chave: !!j.cabeca,
  }));
  const { error: eGp } = await supabase.from('game_players').insert(linhasConfirmacao);
  if (eGp) throw new Error(`game_players: ${eGp.message}`);
  ok(`jogo criado, ${linhasConfirmacao.length} confirmados (1 goleiro, 1 cabeça de chave).`);

  // Sorteio pelo algoritmo real (idêntico a POST /api/games/:id/sortear).
  const { data: gp } = await supabase
    .from('game_players').select('goleiro, cabeca_chave, users ( id, nome, nome_jogador, avatar_url )')
    .eq('game_id', game.id).eq('confirmado', true);
  const confirmados = (gp || []).filter((p) => p.users);
  const ratings = await computeRatings(time.id, confirmados.map((p) => p.users.id));
  const todos = confirmados.map((p) => ({
    user_id: p.users.id, nome: p.users.nome_jogador || p.users.nome || 'Jogador',
    avatar_url: p.users.avatar_url || null, rating: round1(ratings[p.users.id] ?? RATING_DEFAULT),
    goleiro: p.goleiro, cabeca_chave: p.cabeca_chave,
  }));
  const sorteio = executarSorteio(todos, 5, {});
  const times = sorteio.times.map((jogadores, i) => ({
    nome: NOMES_TIMES[i] || `Time ${i + 1}`,
    rating_medio: Math.round((jogadores.reduce((s, j) => s + j.rating, 0) / (jogadores.length || 1)) * 100) / 100,
    jogadores,
  }));
  const resultado = { num_times: sorteio.numTimes, total_jogadores: todos.length, convidados_total: 0, seed: sorteio.seed, avisos: [], times, reservas: sorteio.reservas };
  const { error: eSort } = await supabase.from('games')
    .update({ num_times: sorteio.numTimes, sorteio_realizado: true, times_resultado: resultado })
    .eq('id', game.id);
  if (eSort) throw new Error(`sorteio: ${eSort.message}`);
  for (const t of resultado.times) info(`${t.nome}: ${t.jogadores.map((j) => j.nome).join(', ')}`);
  ok(`sorteio gravado — semente ${resultado.seed}.`);

  // Sessão do capitão (figurinha), para o ver-iphone.mjs navegar já autenticado.
  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data: sess, error: eLogin } = await anon.auth.signInWithPassword({ email: emailDe(capitao.apelido), password: SENHA });
  if (eLogin) throw new Error(`login capitão: ${eLogin.message}`);
  const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
  const sessao = [{ name: `sb-${ref}-auth-token`, value: JSON.stringify(sess.session) }];
  fs.mkdirSync(path.dirname(DESTINO_SESSAO), { recursive: true });
  fs.writeFileSync(DESTINO_SESSAO, JSON.stringify(sessao, null, 2));

  const estado = { teamSlug: SLUG, teamId: time.id, gameId: game.id, seed: resultado.seed, capitaoEmail: emailDe(capitao.apelido) };
  fs.writeFileSync(DESTINO_ESTADO, JSON.stringify(estado, null, 2));
  ok(`sessão do capitão em ${path.relative(process.cwd(), DESTINO_SESSAO)}`);
  console.log(`\nSorteio: /equipa/${SLUG}/jogo/${game.id}/sorteio`);
  console.log(`Ranking: /equipa/${SLUG}/ranking`);
  console.log(`Jogo (presença): /equipa/${SLUG}/jogo/${game.id}`);
}

(async () => {
  try {
    if (APAGAR) await limpar();
    else await criarTudo();
  } catch (e) {
    console.error('[prova-mista] ERRO:', e.message);
    process.exit(1);
  }
})();
