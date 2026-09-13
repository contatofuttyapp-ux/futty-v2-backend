// Futty — Dados de demonstração para o material da Google Play (13-set).
//
//   node scripts/demo-loja.js              cria tudo (aborta se já existir)
//   node scripts/demo-loja.js --sortear    sorteia o próximo jogo (algoritmo real)
//   node scripts/demo-loja.js --limpar     apaga tudo o que o script criou
//   opções: --sem-figurinha (não chama a API de IA)
//
// Correr a partir de backend/ (utils/db.js lê o .env do diretório atual).
// Todas as contas são @futtymock.com com prefixo "demo-loja": é assim que o
// --limpar as encontra. Só a senha do Bruninho é gravada, em LOJA/demo-senha.txt.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { supabase, computeRatings } = require('../utils/db');
const { executarSorteio, mulberry32 } = require('../utils/sorteio');
const { RATING_DEFAULT } = require('../utils/helpers');
const { apagarUsuario } = require('../utils/apagarUsuario');
const { removerFicheirosPorUrl } = require('../utils/storage');

const args = process.argv.slice(2);
const LIMPAR = args.includes('--limpar');
const SORTEAR = args.includes('--sortear');
const SEM_FIGURINHA = args.includes('--sem-figurinha');

const LOJA = path.resolve(__dirname, '..', '..', '..', 'LOJA');
const ARQ_SENHA = path.join(LOJA, 'demo-senha.txt');
const ARQ_ESTADO = path.join(LOJA, 'demo-estado.json');
const FOTO_RESENHA = path.resolve(__dirname, '..', '..', 'frontend', 'public', 'stadium_bg.webp');
const API = process.env.DEMO_API_URL || 'https://futty-api-685039278359.southamerica-east1.run.app';
const BASE_KITS = `${process.env.SUPABASE_URL}/storage/v1/object/public/kits`;
const GENERICO = { m1: `${BASE_KITS}/avatar-generico-1.png`, m2: `${BASE_KITS}/avatar-generico-2.png`, m3: `${BASE_KITS}/avatar-generico-3.png` };

const EMAIL_BRUNINHO = 'demo-loja@futtymock.com';
const PREFIXO = 'demo-loja';
const SLUG_TIME = 'domingueira-fc-demo';
const NOMES_TIMES = ['Time A', 'Time B', 'Time C', 'Time D'];

// Repete uma chamada que falhou por erro transitório de rede/gateway (502, 503, fetch failed).
async function tentar(fn, vezes = 3) {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (e) {
      const transitorio = /502|503|504|Bad gateway|fetch failed|ECONNRESET|ETIMEDOUT/i.test(e.message || '');
      if (!transitorio || i >= vezes) throw e;
      console.warn(`! tentativa ${i} falhou (${e.message.slice(0, 60)}…); repetindo em ${2 * i} s`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

const ok = (m) => console.log('✓', m);
const info = (m) => console.log('·', m);
const aviso = (m) => console.warn('!', m);
const round1 = (n) => Math.round(n * 10) / 10;
// Brasília é UTC-3 sem horário de verão: 9h locais = 12h UTC.
const brt = (y, m, d, h = 9, min = 0) => new Date(Date.UTC(y, m - 1, d, h + 3, min)).toISOString();

// forca = nota média que os colegas dão (0,5 a 5). gr = goleiro. cabeca = cabeça de chave.
const JOGADORES = [
  { apelido: 'Bruninho', nome: 'Bruno Henrique Santos', slug: '', posicao: 'MEI', avatar: 'm1', forca: 4.2, nasc: '1994-03-12', cabeca: true },
  { apelido: 'Tiãozinho', nome: 'Sebastião Ferreira', slug: 'tiaozinho', posicao: 'ATA', avatar: 'm2', forca: 4.0, nasc: '1990-07-01', cabeca: true },
  { apelido: 'Careca', nome: 'Carlos Eduardo Lima', slug: 'careca', posicao: 'DEF', avatar: 'm3', forca: 3.5, nasc: '1988-11-23' },
  { apelido: 'Índio', nome: 'Anderson Souza', slug: 'indio', posicao: 'GL', avatar: 'm1', forca: 3.8, nasc: '1992-05-30', gr: true },
  { apelido: 'Zé Gordo', nome: 'José Roberto Alves', slug: 'ze-gordo', posicao: 'DEF', avatar: 'm2', forca: 3.0, nasc: '1986-09-09' },
  { apelido: 'Marquinhos', nome: 'Marcos Vinícius Rocha', slug: 'marquinhos', posicao: 'MEI', avatar: 'm3', forca: 3.8, nasc: '1997-01-17' },
  { apelido: 'Paulinho Gaúcho', nome: 'Paulo Ricardo Machado', slug: 'paulinho-gaucho', posicao: 'ATA', avatar: 'm1', forca: 3.9, nasc: '1995-12-05' },
  { apelido: 'Dudu', nome: 'Eduardo Nascimento', slug: 'dudu', posicao: 'MEI', avatar: 'm2', forca: 3.4, nasc: '1999-04-21' },
  { apelido: 'Cabeção', nome: 'Rafael Oliveira', slug: 'cabecao', posicao: 'GL', avatar: 'm3', forca: 3.4, nasc: '1991-08-14', gr: true },
  { apelido: 'Nego Di', nome: 'Diego Silva', slug: 'nego-di', posicao: 'ATA', avatar: 'm1', forca: 3.5, nasc: '1998-02-27' },
  { apelido: 'Fabinho', nome: 'Fábio Costa', slug: 'fabinho', posicao: 'DEF', avatar: 'm2', forca: 3.0, nasc: '1993-06-18' },
  { apelido: 'Renatinho', nome: 'Renato Pereira', slug: 'renatinho', posicao: 'MEI', avatar: 'm3', forca: 2.6, nasc: '2001-10-02' },
];
const emailDe = (j) => (j.slug ? `${PREFIXO}-${j.slug}@futtymock.com` : EMAIL_BRUNINHO);
const porApelido = (a) => JOGADORES.find((j) => j.apelido === a);

const TIME = {
  nome: 'Domingueira FC',
  slug: SLUG_TIME,
  cor: 'verde',
  cidade: 'Brasília',
  localizacao: 'Guará II, Brasília, DF',
  descricao: 'Pelada de domingo, 9h em ponto, desde 2019. Chega cedo que o Índio tranca o gol.',
  geo_lat: -15.83,
  geo_lng: -47.98,
};

// Times públicos: são o que o Explorar mostra. Criados por outros jogadores do
// demo (o Bruninho não é membro, para a tela mostrar "Entrar" e "Pedir entrada").
const TIMES_PUBLICOS = [
  { nome: 'Pelada do Guará', slug: 'pelada-do-guara-demo', cor: 'azul', modo: 'publico_aberto', localizacao: 'Guará I, Brasília, DF', geo: [-15.82, -47.97], descricao: 'Quarta e sábado à noite, society sintético. Tem colete, traz só a chuteira.', admin: 'Tiãozinho', membros: ['Careca', 'Dudu', 'Fabinho', 'Nego Di'] },
  { nome: 'Racha da Asa Norte', slug: 'racha-da-asa-norte-demo', cor: 'vermelho', modo: 'publico_aprovacao', localizacao: 'Asa Norte, Brasília, DF', geo: [-15.77, -47.88], descricao: 'Sábado 16h no campo da 410 Norte. Nível intermediário, sem carrinho.', admin: 'Marquinhos', membros: ['Renatinho', 'Paulinho Gaúcho'] },
  { nome: 'Society Lago Sul', slug: 'society-lago-sul-demo', cor: 'preto', modo: 'publico_aberto', localizacao: 'Lago Sul, Brasília, DF', geo: [-15.84, -47.87], descricao: 'Domingo 17h, campo com iluminação. Churrasco depois é tradição.', admin: 'Zé Gordo', membros: ['Índio', 'Cabeção', 'Careca', 'Dudu', 'Tiãozinho'] },
];

// placar = [gols do time mais forte no sorteio, gols do mais fraco]: o time com
// maior média de rating ganha 4, perde 1 e empata 1, para o ranking bater com as notas.
const JOGOS_PASSADOS = [
  { data: brt(2026, 8, 2), placar: [4, 2] },
  { data: brt(2026, 8, 9), placar: [3, 1] },
  { data: brt(2026, 8, 16), placar: [2, 3] },
  { data: brt(2026, 8, 23), placar: [5, 2] },
  { data: brt(2026, 8, 30), placar: [3, 3] },
  { data: brt(2026, 9, 6), placar: [4, 3] },
];
const PROXIMO_JOGO = { data: brt(2026, 9, 20), local: 'Society do Guará II', porTime: 4 };
const CONFIRMADOS_PROXIMO = ['Bruninho', 'Tiãozinho', 'Careca', 'Índio', 'Marquinhos', 'Paulinho Gaúcho', 'Dudu', 'Cabeção', 'Nego Di'];
const RECUSARAM_PROXIMO = ['Fabinho', 'Renatinho'];

const POSTS = [
  // Os comentários aparecem do mais novo para o mais antigo: cada um tem de fazer sentido sozinho.
  { autor: 'Bruninho', diasAtras: 1, texto: 'Sorteio domingo às 8h45 em ponto. Quem chegar atrasado entra no time do Cabeção e ainda paga a água.', reacoes: { Tiãozinho: '😂', Careca: '😂', Dudu: '👍', Cabeção: '😡', 'Nego Di': '🍿' }, comentarios: [{ autor: 'Cabeção', texto: 'Meu time tá invicto há dois domingos, respeita.' }, { autor: 'Tiãozinho', texto: '8h30 eu já tô lá, com o colete escolhido.' }] },
  { autor: 'Tiãozinho', diasAtras: 2, texto: 'Domingo tem clássico. Quem perder paga o churrasco, e o Careca já tá devendo dois.', reacoes: { Bruninho: '😂', 'Zé Gordo': '👍', Marquinhos: '😂', Fabinho: '🍿' }, comentarios: [{ autor: 'Careca', texto: 'Devo um. O outro foi empate e empate não paga.' }] },
  { autor: 'Paulinho Gaúcho', diasAtras: 4, texto: 'Campo liberado pra domingo! Gramado tá um tapete. Zé Gordo, sem desculpa de buraco dessa vez.', foto: true, reacoes: { Bruninho: '❤️', Índio: '👍', Renatinho: '😮', Dudu: '❤️', 'Nego Di': '👍', Marquinhos: '👍' }, comentarios: [{ autor: 'Zé Gordo', texto: 'O buraco era real. Tinha até placa.' }] },
  { autor: 'Índio', diasAtras: 5, texto: 'Três jogos sem tomar gol de fora da área. O Nego Di chuta pra fora desde 2019 e ainda pede pênalti.', reacoes: { 'Nego Di': '😡', Bruninho: '😂', Tiãozinho: '😂', Careca: '😂', Cabeção: '👍' }, comentarios: [{ autor: 'Nego Di', texto: 'Foi pênalti sim. Vou levar pro VAR do grupo.' }] },
];

// ---------------------------------------------------------------------------

async function jaExiste() {
  const { data } = await supabase.from('users').select('id').eq('email', EMAIL_BRUNINHO).maybeSingle();
  return !!data;
}

async function criarUsuarios() {
  const senhaBruninho = crypto.randomBytes(12).toString('base64url');
  const ids = {};
  for (const j of JOGADORES) {
    const email = emailDe(j);
    const password = j.apelido === 'Bruninho' ? senhaBruninho : crypto.randomBytes(16).toString('base64url');
    // onboarding_completo no user_metadata: sem isto o frontend manda toda
    // navegação para /onboarding (services/inicio.js:133).
    const id = await tentar(async () => {
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { nome: j.nome, onboarding_completo: true },
      });
      if (error) throw new Error(`createUser ${email}: ${error.message}`);
      return data.user.id;
    });
    ids[j.apelido] = id;
    // O trigger já criou a linha em public.users; o upsert garante os campos do card.
    // avatar_url = o mesmo genérico que o app mostraria (kits bucket), para a máquina
    // do sorteio e o ranking mostrarem figurinha em vez de silhueta.
    await tentar(async () => {
      const { error: e2 } = await supabase.from('users').upsert({
        id,
        email,
        nome: j.nome,
        nome_jogador: j.apelido,
        birthdate: j.nasc,
        avatar_generico: j.avatar,
        avatar_url: GENERICO[j.avatar],
        plan: 'free',
        cor_frame: 'dourado',
        fundo_figurinha: 'estadio',
        kit_ativo: 'dark-gold',
      }, { onConflict: 'id' });
      if (e2) throw new Error(`users ${email}: ${e2.message.slice(0, 200)}`);
    });
  }
  fs.mkdirSync(LOJA, { recursive: true });
  fs.writeFileSync(ARQ_SENHA, `e-mail: ${EMAIL_BRUNINHO}\nsenha: ${senhaBruninho}\n`, 'utf8');
  ok(`${JOGADORES.length} usuários criados (senha do Bruninho em LOJA/demo-senha.txt)`);
  return ids;
}

async function criarTime(ids) {
  const { data: time, error } = await supabase.from('teams').insert({
    nome: TIME.nome,
    slug: TIME.slug,
    cor: TIME.cor,
    criado_por: ids.Bruninho,
    publica: false,
    modo_visibilidade: 'privado',
    localizacao: TIME.localizacao,
    descricao: TIME.descricao,
    cidade: TIME.cidade,
    geo_lat: TIME.geo_lat,
    geo_lng: TIME.geo_lng,
    mostrar_gols: true,
  }).select().single();
  if (error) throw new Error(`teams: ${error.message}`);

  const membros = JOGADORES.map((j) => ({
    user_id: ids[j.apelido],
    team_id: time.id,
    role: j.apelido === 'Bruninho' ? 'admin' : 'member',
    categoria: j.gr ? 'GR' : 'linha',
    posicao: j.posicao,
    pode_postar: true,
  }));
  const { error: e2 } = await supabase.from('team_members').insert(membros);
  if (e2) throw new Error(`team_members: ${e2.message}`);
  ok(`time "${TIME.nome}" (${TIME.slug}) com ${membros.length} jogadores`);
  return time;
}

async function criarTimesPublicos(ids) {
  for (const t of TIMES_PUBLICOS) {
    const { data: time, error } = await supabase.from('teams').insert({
      nome: t.nome,
      slug: t.slug,
      cor: t.cor,
      criado_por: ids[t.admin],
      publica: true,
      modo_visibilidade: t.modo,
      localizacao: t.localizacao,
      descricao: t.descricao,
      cidade: 'Brasília',
      geo_lat: t.geo[0],
      geo_lng: t.geo[1],
    }).select().single();
    if (error) throw new Error(`teams ${t.slug}: ${error.message}`);
    const membros = [{ user_id: ids[t.admin], team_id: time.id, role: 'admin' }]
      .concat(t.membros.map((a) => ({ user_id: ids[a], team_id: time.id, role: 'member' })));
    const { error: e2 } = await supabase.from('team_members').insert(membros);
    if (e2) throw new Error(`team_members ${t.slug}: ${e2.message}`);
  }
  ok(`${TIMES_PUBLICOS.length} times públicos em Brasília (para o Explorar)`);
}

async function criarVotos(ids, teamId) {
  const rng = mulberry32(20260913);
  const votos = [];
  const agora = new Date().toISOString();
  for (const de of JOGADORES) {
    for (const para of JOGADORES) {
      if (de === para) continue;
      let nota = para.forca + (rng() - 0.5) * 1.0;
      nota = Math.min(5, Math.max(1, Math.round(nota * 2) / 2));
      votos.push({ de_user_id: ids[de.apelido], para_user_id: ids[para.apelido], team_id: teamId, nota, game_id: null, created_at: agora, updated_at: agora });
    }
  }
  const { error } = await supabase.from('votes').insert(votos);
  if (error) throw new Error(`votes: ${error.message}`);
  ok(`${votos.length} votos`);
}

function jogadorParaSorteio(j, ids, ratings) {
  return {
    user_id: ids[j.apelido],
    nome: j.apelido,
    avatar_url: GENERICO[j.avatar],
    rating: round1(ratings[ids[j.apelido]] ?? RATING_DEFAULT),
    goleiro: !!j.gr,
    cabeca_chave: !!j.cabeca,
  };
}

// Mesma forma que routes/games.js grava em times_resultado.
function montarResultado(sorteio, totalJogadores) {
  const times = sorteio.times.map((jogadores, i) => ({
    nome: NOMES_TIMES[i] || `Time ${i + 1}`,
    rating_medio: Math.round((jogadores.reduce((s, j) => s + j.rating, 0) / (jogadores.length || 1)) * 100) / 100,
    jogadores,
  }));
  return { num_times: sorteio.numTimes, total_jogadores: totalJogadores, convidados_total: 0, seed: sorteio.seed, avisos: [], times, reservas: sorteio.reservas };
}

// Quem marca: atacantes mais que meias, meias mais que zagueiros, e os mais
// fortes mais que os fracos. Goleiro não marca.
function distribuirGols(jogadores, quantos, rng) {
  const peso = { ATA: 3, MEI: 2, DEF: 1, GL: 0 };
  const pesoDe = (j) => { const p = porApelido(j.nome); return peso[p.posicao] * p.forca; };
  const candidatos = jogadores.filter((j) => pesoDe(j) > 0);
  const gols = {};
  for (let g = 0; g < quantos; g += 1) {
    const total = candidatos.reduce((s, j) => s + pesoDe(j), 0);
    let r = rng() * total;
    for (const j of candidatos) {
      r -= pesoDe(j);
      if (r <= 0) { gols[j.user_id] = (gols[j.user_id] || 0) + 1; break; }
    }
  }
  return gols;
}

async function criarJogosPassados(ids, teamId) {
  const userIds = JOGADORES.map((j) => ids[j.apelido]);
  const ratings = await computeRatings(teamId, userIds);
  const rng = mulberry32(777);
  let n = 0;
  for (const [i, jp] of JOGOS_PASSADOS.entries()) {
    const todos = JOGADORES.map((j) => jogadorParaSorteio(j, ids, ratings));
    const sorteio = executarSorteio(todos, 6, { seed: 1000 + i });
    const resultado = montarResultado(sorteio, todos.length);
    // placar é [forte, fraco]; traduz para A/B conforme quem saiu mais forte no sorteio.
    const aMaisForte = resultado.times[0].rating_medio >= resultado.times[1].rating_medio;
    const [pa, pb] = aMaisForte ? jp.placar : [jp.placar[1], jp.placar[0]];
    const golsA = distribuirGols(resultado.times[0].jogadores, pa, rng);
    const golsB = distribuirGols(resultado.times[1].jogadores, pb, rng);
    const todosGols = { ...golsA, ...golsB };
    const [artilheiroId, artilheiroGols] = Object.entries(todosGols).sort((a, b) => b[1] - a[1])[0] || [null, 0];
    const vencedor = pa > pb ? 'A' : pb > pa ? 'B' : 'empate';
    // Destaque: o artilheiro do time vencedor; em empate, o goleiro do Time A.
    const timeVenc = vencedor === 'B' ? resultado.times[1] : resultado.times[0];
    const destaque = vencedor === 'empate'
      ? timeVenc.jogadores.find((j) => j.goleiro) || timeVenc.jogadores[0]
      : timeVenc.jogadores.slice().sort((a, b) => (todosGols[b.user_id] || 0) - (todosGols[a.user_id] || 0))[0];

    const { data: game, error } = await supabase.from('games').insert({
      team_id: teamId,
      data: jp.data,
      local: PROXIMO_JOGO.local,
      jogadores_por_time: 6,
      num_times: 2,
      status: 'terminado',
      sorteio_realizado: true,
      times_resultado: resultado,
      resultado_nivel: 3,
      time_vencedor: vencedor,
      placar_a: pa,
      placar_b: pb,
      artilheiro_user_id: artilheiroId,
      artilheiro_gols: artilheiroGols,
      destaque_user_id: destaque.user_id,
      destaque_titulo: 'Craque da pelada',
      created_at: new Date(new Date(jp.data).getTime() - 5 * 86400000).toISOString(),
    }).select().single();
    if (error) throw new Error(`games[${i}]: ${error.message}`);

    const presencas = JOGADORES.map((j) => ({ game_id: game.id, user_id: ids[j.apelido], confirmado: true, goleiro: !!j.gr, cabeca_chave: !!j.cabeca }));
    const { error: e2 } = await supabase.from('game_players').insert(presencas);
    if (e2) throw new Error(`game_players[${i}]: ${e2.message}`);

    const timeDe = {};
    resultado.times[0].jogadores.forEach((j) => { timeDe[j.user_id] = 'A'; });
    resultado.times[1].jogadores.forEach((j) => { timeDe[j.user_id] = 'B'; });
    const linhasGols = Object.entries(todosGols).map(([user_id, gols]) => ({ game_id: game.id, user_id, gols, time: timeDe[user_id] }));
    if (linhasGols.length) {
      const { error: e3 } = await supabase.from('gols_jogadores').insert(linhasGols);
      if (e3) throw new Error(`gols_jogadores[${i}]: ${e3.message}`);
    }
    n += 1;
  }
  ok(`${n} jogos passados com placar, gols, artilheiro e destaque`);
}

async function criarProximoJogo(ids, teamId) {
  const { data: game, error } = await supabase.from('games').insert({
    team_id: teamId,
    data: PROXIMO_JOGO.data,
    local: PROXIMO_JOGO.local,
    jogadores_por_time: PROXIMO_JOGO.porTime,
    max_jogadores: 12,
  }).select().single();
  if (error) throw new Error(`games(próximo): ${error.message}`);
  const linhas = CONFIRMADOS_PROXIMO.map((a) => ({ game_id: game.id, user_id: ids[a], confirmado: true, goleiro: !!porApelido(a).gr, cabeca_chave: !!porApelido(a).cabeca }))
    .concat(RECUSARAM_PROXIMO.map((a) => ({ game_id: game.id, user_id: ids[a], confirmado: false, goleiro: false, cabeca_chave: false })));
  const { error: e2 } = await supabase.from('game_players').insert(linhas);
  if (e2) throw new Error(`game_players(próximo): ${e2.message}`);
  ok(`próximo jogo domingo 20/09 às 9h com ${CONFIRMADOS_PROXIMO.length} confirmados`);
  return game;
}

async function criarResenha(ids, teamId) {
  let fotoUrl = null;
  for (const p of POSTS) {
    const criadoEm = new Date(Date.now() - p.diasAtras * 86400000 - 3 * 3600000).toISOString();
    const { data: post, error } = await supabase.from('feed_posts').insert({ team_id: teamId, author_id: ids[p.autor], body: p.texto, created_at: criadoEm, updated_at: criadoEm }).select().single();
    if (error) throw new Error(`feed_posts: ${error.message}`);

    if (p.foto) {
      const nome = `${crypto.randomUUID()}.webp`;
      const { error: eUp } = await supabase.storage.from('resenha').upload(nome, fs.readFileSync(FOTO_RESENHA), { contentType: 'image/webp', upsert: false });
      if (eUp) throw new Error(`storage resenha: ${eUp.message}`);
      fotoUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/resenha/${nome}`;
      const { error: eM } = await supabase.from('feed_post_media').insert({ post_id: post.id, url: fotoUrl, media_type: 'image', position: 0 });
      if (eM) throw new Error(`feed_post_media: ${eM.message}`);
    }

    const reacoes = Object.entries(p.reacoes).map(([apelido, emoji]) => ({ target_type: 'post', target_id: post.id, user_id: ids[apelido], emoji }));
    const { error: eR } = await supabase.from('reacoes').insert(reacoes);
    if (eR) throw new Error(`reacoes: ${eR.message}`);

    for (const [k, c] of p.comentarios.entries()) {
      const quando = new Date(new Date(criadoEm).getTime() + (k + 1) * 25 * 60000).toISOString();
      const { error: eC } = await supabase.from('comentarios').insert({ parent_type: 'post', parent_id: post.id, author_id: ids[c.autor], body: c.texto, created_at: quando, updated_at: quando });
      if (eC) throw new Error(`comentarios: ${eC.message}`);
    }
  }
  ok(`${POSTS.length} posts na Resenha (1 com foto), com reações e comentários`);
  return fotoUrl;
}

// Figurinha do Bruninho pelo fluxo real do app: o avatar genérico entra como
// "foto" (POST /api/me/avatar) e a IA pinta a figurinha (POST /api/me/avatar/ai).
// Custa ~US$0,02. Se falhar, o app continua a mostrar o genérico no card.
async function gerarFigurinha(senha) {
  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: sess, error } = await anon.auth.signInWithPassword({ email: EMAIL_BRUNINHO, password: senha });
  if (error) throw new Error(`login demo: ${error.message}`);
  const auth = { Authorization: `Bearer ${sess.session.access_token}` };

  const png = Buffer.from(await (await fetch(GENERICO.m1)).arrayBuffer());
  const fd = new FormData();
  fd.append('avatar', new Blob([png], { type: 'image/png' }), 'bruninho.png');
  info('enviando a "foto" (avatar genérico) para a API…');
  const r1 = await fetch(`${API}/api/me/avatar`, { method: 'POST', headers: auth, body: fd });
  if (!r1.ok) throw new Error(`upload da foto: HTTP ${r1.status} ${await r1.text()}`);

  info('gerando a figurinha com IA (até 90 s)…');
  const t0 = Date.now();
  const r2 = await fetch(`${API}/api/me/avatar/ai`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ kit: 'dark-gold' }) });
  const corpo = await r2.text();
  if (!r2.ok) throw new Error(`geração: HTTP ${r2.status} ${corpo}`);
  const json = JSON.parse(corpo);
  ok(`figurinha gerada em ${Math.round((Date.now() - t0) / 1000)} s: ${json.avatar_url}`);
  return json.avatar_url;
}

async function criar() {
  if (await jaExiste()) {
    aviso(`${EMAIL_BRUNINHO} já existe. Corra primeiro: node scripts/demo-loja.js --limpar`);
    process.exit(1);
  }
  const ids = await criarUsuarios();
  const time = await criarTime(ids);
  await criarTimesPublicos(ids);
  await criarVotos(ids, time.id);
  await criarJogosPassados(ids, time.id);
  const proximo = await criarProximoJogo(ids, time.id);
  const fotoResenha = await criarResenha(ids, time.id);

  let figurinha = null;
  if (!SEM_FIGURINHA) {
    try {
      const senha = fs.readFileSync(ARQ_SENHA, 'utf8').match(/senha: (.+)/)[1].trim();
      figurinha = await gerarFigurinha(senha);
    } catch (e) {
      aviso(`figurinha por IA não saiu (${e.message}). O card fica com o avatar genérico.`);
    }
  }

  const estado = {
    criadoEm: new Date().toISOString(),
    email: EMAIL_BRUNINHO,
    userId: ids.Bruninho,
    teamSlug: TIME.slug,
    teamId: time.id,
    proximoJogoId: proximo.id,
    figurinhaIA: figurinha,
    fotoResenha,
    ids,
  };
  fs.writeFileSync(ARQ_ESTADO, JSON.stringify(estado, null, 2), 'utf8');
  ok(`estado em LOJA/demo-estado.json (sem senha)`);
  console.log(`\nPronto. Login: ${EMAIL_BRUNINHO} · senha em ${ARQ_SENHA}`);
  console.log(`Início: https://futty.pages.dev/home · Sorteio: /equipa/${TIME.slug}/jogo/${proximo.id}/sorteio (depois de --sortear)`);
}

// Sorteio do próximo jogo, igual a POST /api/games/:id/sortear (routes/games.js).
async function sortear() {
  if (!fs.existsSync(ARQ_ESTADO)) throw new Error('LOJA/demo-estado.json não existe: corra o script sem opções primeiro.');
  const estado = JSON.parse(fs.readFileSync(ARQ_ESTADO, 'utf8'));
  const { data: game, error } = await supabase.from('games').select('*').eq('id', estado.proximoJogoId).single();
  if (error || !game) throw new Error(`jogo não encontrado: ${error?.message}`);

  const { data: gp } = await supabase
    .from('game_players')
    .select('goleiro, cabeca_chave, users ( id, nome, nome_jogador, avatar_url )')
    .eq('game_id', game.id)
    .eq('confirmado', true);
  const confirmados = (gp || []).filter((p) => p.users);
  const ratings = await computeRatings(game.team_id, confirmados.map((p) => p.users.id));
  const todos = confirmados.map((p) => ({
    user_id: p.users.id,
    nome: p.users.nome_jogador || p.users.nome || 'Jogador',
    avatar_url: p.users.avatar_url || null,
    rating: round1(ratings[p.users.id] ?? RATING_DEFAULT),
    goleiro: p.goleiro,
    cabeca_chave: p.cabeca_chave,
  }));
  const porTime = game.jogadores_por_time || PROXIMO_JOGO.porTime;
  const sorteio = executarSorteio(todos, porTime, {});
  const resultado = montarResultado(sorteio, todos.length);
  const { error: e2 } = await supabase.from('games')
    .update({ jogadores_por_time: porTime, num_times: sorteio.numTimes, sorteio_realizado: true, times_resultado: resultado })
    .eq('id', game.id);
  if (e2) throw new Error(`games(sorteio): ${e2.message}`);
  for (const t of resultado.times) info(`${t.nome} (média ${t.rating_medio}): ${t.jogadores.map((j) => j.nome).join(', ')}`);
  if (resultado.reservas.length) info(`reservas: ${resultado.reservas.map((r) => r.nome).join(', ')}`);
  ok(`sorteio gravado (semente ${resultado.seed}) — /equipa/${estado.teamSlug}/jogo/${game.id}/sorteio`);
}

async function limpar() {
  // 1) Contas do demo: public.users + auth (órfãos de uma criação interrompida).
  const { data: rows } = await supabase.from('users').select('id, email').ilike('email', `${PREFIXO}%@futtymock.com`);
  const contas = new Map((rows || []).map((u) => [u.id, u.email]));
  const { data: lista } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  for (const u of lista?.users || []) {
    if (u.email && u.email.startsWith(PREFIXO) && u.email.endsWith('@futtymock.com')) contas.set(u.id, u.email);
  }
  if (!contas.size) { info('nada para apagar.'); }

  // 2) Fotos da Resenha dos times do demo, antes que o cascade apague as linhas.
  const slugs = [SLUG_TIME].concat(TIMES_PUBLICOS.map((t) => t.slug));
  const { data: times } = await supabase.from('teams').select('id, slug').in('slug', slugs);
  const teamIds = (times || []).map((t) => t.id);
  if (teamIds.length) {
    const { data: posts } = await supabase.from('feed_posts').select('id').in('team_id', teamIds);
    const postIds = (posts || []).map((p) => p.id);
    if (postIds.length) {
      const { data: media } = await supabase.from('feed_post_media').select('url').in('post_id', postIds);
      const urls = (media || []).map((m) => m.url).filter(Boolean);
      if (urls.length) {
        const r = await removerFicheirosPorUrl('resenha', urls);
        info(`${r.removidos} foto(s) da Resenha removida(s) do Storage`);
      }
    }
  }

  // 3) Usuários: os outros primeiro, o Bruninho por último (é o criador do time —
  //    quando sai o último membro, apagarUsuario apaga o time e tudo em cascata).
  const ordem = [...contas.entries()].sort(([, a], [, b]) => (a === EMAIL_BRUNINHO) - (b === EMAIL_BRUNINHO));
  for (const [id, email] of ordem) {
    // eslint-disable-next-line no-await-in-loop
    const r = await apagarUsuario(id);
    info(`${email} apagado${r.timesApagados.length ? ` (times apagados: ${r.timesApagados.join(', ')})` : ''}`);
  }

  // 4) Times do demo que tenham sobrado (não deveria acontecer).
  const { data: sobras } = await supabase.from('teams').select('id, slug').in('slug', slugs);
  for (const t of sobras || []) {
    // eslint-disable-next-line no-await-in-loop
    await supabase.from('teams').delete().eq('id', t.id);
    aviso(`time ${t.slug} apagado à mão`);
  }

  for (const f of [ARQ_SENHA, ARQ_ESTADO]) if (fs.existsSync(f)) fs.unlinkSync(f);
  ok(`${contas.size} conta(s) apagada(s); LOJA/demo-senha.txt e demo-estado.json removidos`);
}

(async () => {
  if (LIMPAR) await limpar();
  else if (SORTEAR) await sortear();
  else await criar();
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
