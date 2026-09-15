// Futty — DEMO COMPLETA para o dono testar no celular (15-set).
//
//   node scripts/demo-completa.js                   cria tudo (idempotente: 2ª vez não duplica)
//   node scripts/demo-completa.js --limpar          desfaz TUDO o que este script criou
//   node scripts/demo-completa.js --email=x@y.com   adiciona mais um admin além dos dois do dono
//   node scripts/demo-completa.js --ensaio          só mostra os elencos/sorteios, não grava nada
//   node scripts/demo-completa.js --so-jogo-extra   só o 2º jogo futuro (Rodada 8B), sobre uma
//                                                    demo já criada; idempotente (não duplica)
//
// Correr a partir de backend/ (utils/db.js lê o .env do diretório atual).
//
// O QUE É "DELE" (e portanto o que o --limpar pode tocar):
//   · contas com prefixo `demo-vila-` em @futtymock.com;
//   · times com os slugs listados em SLUGS (todos terminam em `-demo-vila`);
//   · no Storage: campeonatos e denúncias desses times, fotos da Resenha desses posts;
//   · bloqueios e pedidos de entrada em que o alvo é uma conta `demo-vila-`.
// NADA MAIS. A conta demo-loja@futtymock.com e o time domingueira-fc-demo (conta do
// revisor das lojas, ver ONDE-ESTAMOS.md) ficam INTOCADOS — o --limpar nunca os vê,
// porque nenhum marcador acima bate com eles.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { supabase, computeRatings } = require('../utils/db');
const { executarSorteio, mulberry32 } = require('../utils/sorteio');
const { RATING_DEFAULT } = require('../utils/helpers');
const { apagarUsuario } = require('../utils/apagarUsuario');
const { removerFicheirosPorUrl } = require('../utils/storage');
const campStore = require('../utils/campeonatoStore');
const denunciaStore = require('../utils/denunciaStore');

const args = process.argv.slice(2);
const LIMPAR = args.includes('--limpar');
const ENSAIO = args.includes('--ensaio');
const SO_JOGO_EXTRA = args.includes('--so-jogo-extra');
const EMAIL_EXTRA = (args.find((a) => a.startsWith('--email=')) || '').slice(8).trim().toLowerCase() || null;

const PREFIXO = 'demo-vila';
const DOMINIO = '@futtymock.com';
const SLUG = 'vila-olimpica-fc-demo-vila';
const EMAILS_DONO = ['contatofuttyapp@gmail.com', 'phferreiraborgesbackup@gmail.com'];

const LOJA = path.resolve(__dirname, '..', '..', '..', 'LOJA');
const ARQ_ESTADO = path.join(LOJA, 'demo-completa-estado.json');
const FOTO_CAMPO = path.resolve(__dirname, '..', '..', 'frontend', 'public', 'stadium_bg.webp');
const BASE_KITS = `${process.env.SUPABASE_URL}/storage/v1/object/public/kits`;
const GENERICO = {
  m1: `${BASE_KITS}/avatar-generico-1.png`, m2: `${BASE_KITS}/avatar-generico-2.png`, m3: `${BASE_KITS}/avatar-generico-3.png`,
  f1: `${BASE_KITS}/avatar-generico-f-1.png`, f2: `${BASE_KITS}/avatar-generico-f-2.png`, f3: `${BASE_KITS}/avatar-generico-f-3.png`,
};

const ok = (m) => console.log('✓', m);
const info = (m) => console.log('·', m);
const aviso = (m) => console.warn('!', m);
const round1 = (n) => Math.round(n * 10) / 10;
const dias = (n) => new Date(Date.now() + n * 86400000).toISOString();
// Nota do voto: 0,5 a 5 em passos de 0,5 (constraint votes_nota_check, migração 017).
const nota05 = (n) => Math.min(5, Math.max(1, Math.round(n * 2) / 2));

// ─── Elenco ──────────────────────────────────────────────────────────────────
// forca = nota média que os colegas dão. gr = goleiro. cabeca = cabeça de chave no sorteio.
const JOGADORES = [
  { slug: 'cacau', apelido: 'Cacau', nome: 'Carlos Augusto Ribeiro', pos: 'ATA', av: 'm1', forca: 4.4, nasc: '1993-02-14', cabeca: true },
  { slug: 'tonho', apelido: 'Tonho', nome: 'Antônio Vieira Lopes', pos: 'MEI', av: 'm2', forca: 4.2, nasc: '1991-06-08', cabeca: true },
  { slug: 'gabi', apelido: 'Gabi', nome: 'Gabriela Menezes', pos: 'ATA', av: 'f1', forca: 4.1, nasc: '1996-09-25', cabeca: true },
  { slug: 'pipoca', apelido: 'Pipoca', nome: 'Felipe Andrade Cruz', pos: 'MEI', av: 'm3', forca: 3.9, nasc: '1998-01-30' },
  { slug: 'muralha', apelido: 'Muralha', nome: 'Wagner dos Santos', pos: 'GL', av: 'm1', forca: 4.0, nasc: '1989-11-12', gr: true },
  { slug: 'juninho', apelido: 'Juninho', nome: 'José Carlos Batista Filho', pos: 'DEF', av: 'm2', forca: 3.7, nasc: '1994-04-03' },
  { slug: 'nanda', apelido: 'Nanda', nome: 'Fernanda Correia', pos: 'MEI', av: 'f2', forca: 3.8, nasc: '1997-07-19' },
  { slug: 'bigode', apelido: 'Bigode', nome: 'Reinaldo Moreira', pos: 'DEF', av: 'm3', forca: 3.4, nasc: '1985-03-27' },
  { slug: 'gato', apelido: 'Gato', nome: 'Leandro Pinheiro', pos: 'GL', av: 'm1', forca: 3.6, nasc: '1992-12-01', gr: true },
  { slug: 'russo', apelido: 'Russo', nome: 'Rodrigo Steinbach', pos: 'ATA', av: 'm2', forca: 3.9, nasc: '1995-05-16' },
  { slug: 'lelê', apelido: 'Lelê', nome: 'Letícia Ramos', pos: 'DEF', av: 'f3', forca: 3.5, nasc: '1999-08-22' },
  { slug: 'formiga', apelido: 'Formiga', nome: 'Marcelo Tavares', pos: 'MEI', av: 'm3', forca: 3.3, nasc: '2000-02-09' },
  { slug: 'boi', apelido: 'Boi', nome: 'Everton Nogueira', pos: 'DEF', av: 'm1', forca: 3.2, nasc: '1987-10-14' },
  { slug: 'zequinha', apelido: 'Zequinha', nome: 'Ezequiel Farias', pos: 'ATA', av: 'm2', forca: 3.6, nasc: '2001-06-06' },
  { slug: 'paredao', apelido: 'Paredão', nome: 'Douglas Amaral', pos: 'GL', av: 'm3', forca: 3.3, nasc: '1990-09-18', gr: true },
  { slug: 'mel', apelido: 'Mel', nome: 'Melissa Cardoso', pos: 'MEI', av: 'f1', forca: 3.4, nasc: '1998-11-05' },
  { slug: 'serginho', apelido: 'Serginho', nome: 'Sérgio Barreto', pos: 'DEF', av: 'm1', forca: 3.0, nasc: '1986-07-21' },
  { slug: 'kiko', apelido: 'Kiko', nome: 'Henrique Sales', pos: 'ATA', av: 'm2', forca: 3.5, nasc: '2002-03-11' },
  { slug: 'duda', apelido: 'Duda', nome: 'Eduarda Prado', pos: 'ATA', av: 'f2', forca: 3.7, nasc: '2000-12-28' },
  { slug: 'baiano', apelido: 'Baiano', nome: 'Ubiratan Conceição', pos: 'MEI', av: 'm3', forca: 3.1, nasc: '1988-05-02' },
  { slug: 'canela', apelido: 'Canela', nome: 'Thiago Vilela', pos: 'DEF', av: 'm1', forca: 2.9, nasc: '2003-01-24' },
];
// Candidatos: existem só para PEDIR ENTRADA. Não são membros de nenhum time,
// não jogaram, não votaram — senão o pedido de entrada não faria sentido na tela.
const CANDIDATOS = [
  { slug: 'wesley', apelido: 'Wesley', nome: 'Wesley Aparecido Rocha', pos: 'DEF', av: 'm2', nasc: '1996-04-17',
    msg: 'Jogo de zagueiro, moro aqui em Alvalade. Consigo quarta e domingo.' },
  { slug: 'bruna', apelido: 'Bruna', nome: 'Bruna Vasconcelos', pos: 'MEI', av: 'f3', nasc: '1999-10-08',
    msg: 'Amiga do Tonho, jogava no Cerrado FC em Brasília. Cheguei em Lisboa em agosto.' },
];
const CONVIDADOS = ['Vizinho do Zé', 'Primo do Tonho', 'Amigo da Gabi'];
const emailDe = (j) => `${PREFIXO}-${j.slug.normalize('NFD').replace(/[̀-ͯ]/g, '')}${DOMINIO}`;
const porApelido = (a) => JOGADORES.find((j) => j.apelido === a);

// ─── Times ───────────────────────────────────────────────────────────────────
// created_at ANTIGO de propósito: o Início usa a equipa MAIS ANTIGA do utilizador
// como "time principal" (routes/inicio.js: teams[0], ordenado por created_at ASC).
// Sem isto, o card de campeonato/votação/RSVP apontaria para outro time do dono.
const TIME = {
  nome: 'Vila Olímpica FC', slug: SLUG, cor: 'verde',
  cidade: 'Lisboa', localizacao: 'Alvalade, Lisboa',
  descricao: 'Quarta 20h e domingo 10h, campo sintético do Alvalade. Colete é da casa, chuteira é sua.',
  geo_lat: 38.75, geo_lng: -9.14,
  created_at: '2026-06-01T18:00:00.000Z',
};
const TIMES_PUBLICOS = [
  { nome: 'Saudade FC', slug: 'saudade-fc-demo-vila', cor: 'azul', modo: 'publico_aberto', cidade: 'Lisboa', local: 'Benfica, Lisboa', geo: [38.75, -9.20], desc: 'Brasileiros em Lisboa, terça e quinta às 19h. Chega e joga, sem burocracia.', admin: 'Tonho', membros: ['Pipoca', 'Russo', 'Mel', 'Kiko'] },
  { nome: 'Tejo Bola', slug: 'tejo-bola-demo-vila', cor: 'vermelho', modo: 'publico_aprovacao', cidade: 'Lisboa', local: 'Parque das Nações, Lisboa', geo: [38.77, -9.10], desc: 'Society 7, sábado de manhã à beira-rio. Nível intermediário, sem carrinho.', admin: 'Gabi', membros: ['Nanda', 'Duda', 'Lelê'] },
  { nome: 'Amadora Athletic', slug: 'amadora-athletic-demo-vila', cor: 'preto', modo: 'publico_aberto', cidade: 'Amadora', local: 'Reboleira, Amadora', geo: [38.75, -9.23], desc: 'Domingo 18h, campo com luz. Churrasco no fim é lei.', admin: 'Bigode', membros: ['Boi', 'Serginho', 'Baiano', 'Canela', 'Formiga'] },
  { nome: 'Cerrado Futebol Clube', slug: 'cerrado-fc-demo-vila', cor: 'verde', modo: 'publico_aprovacao', cidade: 'Brasília', local: 'Sudoeste, Brasília, DF', geo: [-15.79, -47.92], desc: 'Pelada de quarta no Sudoeste, 20h. Time fechado há 6 anos, entra quem o grupo aprova.', admin: 'Muralha', membros: ['Juninho', 'Zequinha'] },
  { nome: 'Planalto Society', slug: 'planalto-society-demo-vila', cor: 'azul', modo: 'publico_aberto', cidade: 'Brasília', local: 'Asa Sul, Brasília, DF', geo: [-15.83, -47.91], desc: 'Sábado 8h antes do calor. Leva água, o bar só abre às 10h.', admin: 'Gato', membros: ['Paredão', 'Cacau'] },
];
const SLUGS = [SLUG].concat(TIMES_PUBLICOS.map((t) => t.slug));

// ─── Jogos ───────────────────────────────────────────────────────────────────
// placar = [time do dono, adversário]. `porTime` varia de propósito: dois desses
// jogos são os "sorteios guardados" que o dono vai rever (5x5 e 11x11).
const JOGOS_PASSADOS = [
  { diasAtras: 63, porTime: 6, placar: [3, 1], local: 'Alvalade, campo 2' },
  { diasAtras: 56, porTime: 6, placar: [2, 2], local: 'Alvalade, campo 2' },
  { diasAtras: 49, porTime: 5, placar: [4, 2], local: 'Benfica, society', guardado: '5x5' },
  { diasAtras: 42, porTime: 6, placar: [1, 3], local: 'Alvalade, campo 2' },
  { diasAtras: 35, porTime: 6, placar: [5, 3], local: 'Alvalade, campo 2' },
  { diasAtras: 28, porTime: 11, placar: [2, 1], local: 'Campo Grande, campo 1', guardado: '11x11' },
  { diasAtras: 21, porTime: 6, placar: [3, 2], local: 'Alvalade, campo 2' },
  { diasAtras: 7, porTime: 6, placar: [4, 4], local: 'Alvalade, campo 2' },
];

// ─── Resenha ─────────────────────────────────────────────────────────────────
// Emojis permitidos (migração 036): 👍 ❤️ 😂 😮 😢 😡 🍿 — UMA reação por pessoa/post.
const POSTS = [
  { autor: 'Cacau', horas: 3, texto: 'Domingo 10h, campo 2. Quem não avisar até sábado fica de fora do sorteio.',
    reacoes: { Tonho: '👍', Gabi: '👍', Pipoca: '👍', Muralha: '❤️', Russo: '👍', Nanda: '👍' },
    comentarios: [{ de: 'Boi', txt: 'Tô dentro. Levo as bolas novas.' }, { de: 'Formiga', txt: 'Chego 9h45, trânsito na Segunda Circular é traiçoeiro.' }, { de: 'Cacau', txt: 'Boi, leva o colete azul também que o outro rasgou.', resp: 0 }] },

  { autor: 'Gabi', horas: 9, gif: true, texto: 'O gol do Russo ontem, versão oficial. Reparem na dancinha depois.',
    reacoes: { Cacau: '😂', Tonho: '😂', Russo: '❤️', Pipoca: '😂', Kiko: '🍿', Duda: '😂', Mel: '😂' },
    comentarios: [{ de: 'Russo', txt: 'Isso é arte, não dancinha.' }, { de: 'Bigode', txt: 'Arte foi o goleiro deixar passar por baixo.' }, { de: 'Russo', txt: 'Bigode, no teu lugar eu ficava calado sobre defesa.', resp: 1 }, { de: 'Muralha', txt: 'Eu não estava no gol nesse dia. Fica registrado.' }] },

  { autor: 'Tonho', horas: 20, foto: true, texto: 'Campo liberado pra quarta. Gramado sintético novo, nada de desculpa de buraco.',
    reacoes: { Cacau: '👍', Gabi: '❤️', Juninho: '👍', Boi: '😮', Serginho: '👍', Lelê: '❤️', Nanda: '👍', Zequinha: '👍' },
    comentarios: [{ de: 'Serginho', txt: 'O buraco era real, tinha até poça quando chovia.' }, { de: 'Tonho', txt: 'Era. Agora não é mais.', resp: 0 }, { de: 'Kiko', txt: 'Sintético novo escorrega mais, cuidado com a trava alta.' }] },

  { autor: 'Pipoca', horas: 30, texto: 'Alguém viu meu par de meiões vermelho? Ficou no vestiário domingo. Se aparecer, chama.',
    reacoes: { Formiga: '😂', Boi: '😂', Mel: '👍', Russo: '😂' },
    comentarios: [{ de: 'Mel', txt: 'Vi um meião vermelho no cesto de perdidos da portaria.' }, { de: 'Pipoca', txt: 'Salvou. Passo lá amanhã.', resp: 0 }] },

  { autor: 'Nanda', horas: 44, youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    texto: 'Achei esse vídeo de treino de finalização. Kiko, é literalmente o teu problema resolvido em 4 minutos.',
    reacoes: { Kiko: '😢', Cacau: '😂', Gabi: '👍', Duda: '😂', Tonho: '🍿' },
    comentarios: [{ de: 'Kiko', txt: 'Injusto. Eu acerto o gol, o gol é que se move.' }, { de: 'Duda', txt: 'Vou assistir contigo, a gente treina sábado antes do jogo.' }, { de: 'Kiko', txt: 'Fechado, 9h no campo 2.', resp: 1 }] },

  { autor: 'Muralha', horas: 58, texto: 'Quatro jogos sem levar gol de fora da área. Só registrando antes que alguém diga que goleiro não faz nada.',
    reacoes: { Gato: '👍', Paredão: '❤️', Cacau: '👍', Tonho: '😮', Boi: '👍', Bigode: '😂' },
    comentarios: [{ de: 'Russo', txt: 'De fora da área. De dentro entraram uns quantos.' }, { de: 'Muralha', txt: 'De dentro da área é falha da defesa. Pergunta pro Bigode.', resp: 0 }, { de: 'Bigode', txt: 'Sempre sobra pra mim.' }] },

  { autor: 'Boi', horas: 70, texto: 'Rateio do campo de setembro fechado: 8 euros por cabeça. Quem ainda não passou, MB Way pro Tonho.',
    reacoes: { Tonho: '👍', Cacau: '👍', Juninho: '👍', Serginho: '👍', Formiga: '😢', Lelê: '👍' },
    comentarios: [{ de: 'Formiga', txt: 'Passo hoje à noite.' }, { de: 'Baiano', txt: 'Já mandei semana passada, confere aí.' }, { de: 'Tonho', txt: 'Confirmado, Baiano. Falta só o Canela e o Zequinha.', resp: 1 }] },

  { autor: 'Duda', horas: 88, instagram: 'https://www.instagram.com/p/C1abcdefghi/',
    texto: 'O pessoal do Tejo Bola postou o resumo do torneio de sábado. A gente aparece no fundo do vídeo, minuto 2.',
    reacoes: { Gabi: '❤️', Nanda: '😮', Mel: '👍', Lelê: '❤️', Cacau: '👍' },
    comentarios: [{ de: 'Gabi', txt: 'Vi! Dá pra ver o Cacau reclamando com o árbitro, clássico.' }, { de: 'Cacau', txt: 'Era impedimento e todos sabem.', resp: 0 }] },

  { autor: 'Bigode', horas: 110, denunciado: true, texto: 'Time que joga de sábado é time de perna mole, todo mundo sabe disso. Domingo é dia de futebol de verdade, o resto é recreação pra quem não aguenta ritmo.',
    reacoes: { Boi: '😂', Serginho: '😡', Formiga: '😂', Canela: '😡', Russo: '🍿' },
    comentarios: [{ de: 'Serginho', txt: 'Jogo sábado e corro mais que tu, Bigode.' }, { de: 'Canela', txt: 'Isso foi desnecessário.' }, { de: 'Bigode', txt: 'Brincadeira, gente. Sábado também é futebol.', resp: 1 }] },

  { autor: 'Lelê', horas: 140, longo: true,
    texto: 'Gente, aproveitando que ninguém está discutindo escalação agora, queria propor uma coisa pro grupo.\n\nA gente joga junto há mais de um ano e nunca fez nada fora do campo além do churrasco de dezembro. Andei conversando com a Nanda e com o Muralha e a ideia é simples: um fim de semana fora, dois dias, num sítio com campo e churrasqueira. Dá pra dividir a diária entre 20 pessoas e sair barato.\n\nO plano seria: sábado de manhã a gente chega e faz um torneio interno de quatro times, mata-mata, jogos de 20 minutos. À tarde, churrasco e descanso. Domingo de manhã, um jogo só, 11 contra 11, e volta depois do almoço.\n\nJá pesquisei três lugares a menos de uma hora de Lisboa. Preciso saber quem topa antes de reservar, porque sinal é sinal. Responde aqui embaixo com um sim ou não que eu faço a lista.',
    reacoes: { Nanda: '❤️', Muralha: '❤️', Gabi: '❤️', Cacau: '👍', Tonho: '👍', Mel: '❤️', Duda: '❤️', Pipoca: '👍' },
    comentarios: [{ de: 'Nanda', txt: 'Sim. Já tenho dois lugares favoritos, mando os links.' }, { de: 'Muralha', txt: 'Sim, e levo a churrasqueira portátil.' }, { de: 'Cacau', txt: 'Sim, mas o torneio tem que ser 4 times de verdade, com tabela.' }, { de: 'Lelê', txt: 'Cacau, tabela e tudo. Já sei quem vai fazer a arbitragem.', resp: 2 }, { de: 'Boi', txt: 'Depende da data. Outubro eu não posso.' }, { de: 'Mel', txt: 'Sim! Melhor ideia do ano.' }] },

  { autor: 'Russo', horas: 175, texto: 'Aviso de utilidade pública: o bar da esquina do campo fechou. O plano B é a padaria da rua de trás, abre até meia-noite.',
    reacoes: { Boi: '😢', Cacau: '😢', Tonho: '😮', Baiano: '😢', Formiga: '😡' },
    comentarios: [{ de: 'Baiano', txt: 'Que notícia triste pra começar a semana.' }, { de: 'Boi', txt: 'A padaria não tem imperial gelada, não é a mesma coisa.' }] },

  { autor: 'Muralha', horas: 200, texto: 'Quem deixou a bola furada dentro da rede? Se ninguém assumir até quarta, compro uma nova e divido no rateio de todo mundo.',
    reacoes: { Cacau: '😂', Pipoca: '😮', Gabi: '😂', Kiko: '😂', Tonho: '👍', Juninho: '😮' },
    comentarios: [{ de: 'Kiko', txt: 'Não fui eu. Dessa vez.' }, { de: 'Pipoca', txt: 'Foi trave, não foi chute. A bola já estava murcha antes.' }, { de: 'Muralha', txt: 'Pipoca, trave não fura bola. Compro a nova.', resp: 1 }] },
];
// Anúncio oficial (tipo='anuncio', só admin) — card dourado, sem like nem comentário.
const ANUNCIO = {
  horas: 15,
  titulo: 'Campeonato interno começa dia 1',
  mensagem: 'O Campeonato Vila Olímpica 2026/2 começa no primeiro domingo de outubro. Quatro times, pontos corridos, uma volta. A tabela já está na aba Campeonato. Quem não confirmar presença em duas rodadas seguidas sai do plantel.',
};

// ─── GIF da casa (GIF89a animado escrito à mão) ──────────────────────────────
// Não há nenhum .gif no repo e um GIF de terceiro (Giphy/Tenor) seria uma
// dependência externa numa tela do app — contra a regra "tudo definitivo" do
// CLAUDE.md. O sharp desta versão não escreve GIF animado (ignora pageHeight),
// por isso monta-se o ficheiro à mão: paleta de 3 cores e LZW em modo literal
// (sem dicionário — pesa mais, mas são 45 KB e zero dependências).
function lzwLiteral(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let proximo = eoi + 1;
  const bits = [];
  const push = (code) => { for (let i = 0; i < codeSize; i += 1) bits.push((code >> i) & 1); };
  push(clear);
  for (const px of indices) {
    push(px);
    proximo += 1;
    if (proximo >= (1 << codeSize) && codeSize < 12) codeSize += 1;
    if (proximo >= 4093) { push(clear); codeSize = minCodeSize + 1; proximo = eoi + 1; }
  }
  push(eoi);
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8 && i + k < bits.length; k += 1) b |= bits[i + k] << k;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}
function emBlocos(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i += 255) {
    const parte = buf.slice(i, i + 255);
    out.push(Buffer.from([parte.length]), parte);
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}
function gerarGifBola() {
  const W = 64; const H = 64; const N = 8;
  const paleta = [[13, 13, 18], [212, 160, 23], [240, 201, 74]];
  const potencia = 2; const tamPaleta = 4; const minCode = 2;
  const tabela = Buffer.alloc(tamPaleta * 3);
  paleta.forEach((c, i) => { tabela[i * 3] = c[0]; tabela[i * 3 + 1] = c[1]; tabela[i * 3 + 2] = c[2]; });

  const cab = Buffer.alloc(13);
  cab.write('GIF89a', 0, 'latin1');
  cab.writeUInt16LE(W, 6); cab.writeUInt16LE(H, 8);
  cab[10] = 0x80 | (potencia - 1);
  const loop = Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'latin1'), 0x03, 0x01, 0x00, 0x00, 0x00]);
  const partes = [cab, tabela, loop];

  for (let f = 0; f < N; f += 1) {
    const ang = (f / N) * Math.PI * 2;
    const px = new Uint8Array(W * H);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const dx = x - 32; const dy = y - 32;
        const r = Math.sqrt(dx * dx + dy * dy);
        let cor = 0;
        if (r < 26) {
          cor = 1;
          const t = Math.atan2(dy, dx) + ang;
          if (Math.cos(t * 3) > 0.55 && r > 7) cor = 0;
          if (r < 8) cor = 2;
        }
        px[y * W + x] = cor;
      }
    }
    const gce = Buffer.from([0x21, 0xf9, 0x04, 0x00, 9, 0x00, 0x00, 0x00]);
    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(W, 5); desc.writeUInt16LE(H, 7);
    partes.push(gce, desc, Buffer.from([minCode]), emBlocos(lzwLiteral(px, minCode)));
  }
  partes.push(Buffer.from([0x3b]));
  return Buffer.concat(partes);
}

// ─── Criação ─────────────────────────────────────────────────────────────────

async function jaExiste() {
  const { data } = await supabase.from('teams').select('id').eq('slug', SLUG).maybeSingle();
  return !!data;
}

async function acharDonos() {
  const alvos = [...EMAILS_DONO];
  if (EMAIL_EXTRA && !alvos.includes(EMAIL_EXTRA)) alvos.push(EMAIL_EXTRA);
  const encontrados = [];
  for (const email of alvos) {
    const { data } = await supabase.from('users').select('id, email, nome, nome_jogador').eq('email', email).maybeSingle();
    if (data) encontrados.push(data);
    else aviso(`${email} não tem conta no Futty — pulei (entra sozinho quando criar a conta e pedir entrada).`);
  }
  if (!encontrados.length) throw new Error('Nenhum dos e-mails do dono tem conta. Nada a fazer.');
  return encontrados;
}

async function criarUsuarios() {
  const ids = {};
  for (const j of JOGADORES.concat(CANDIDATOS)) {
    const email = emailDe(j);
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: crypto.randomBytes(16).toString('base64url'),
      email_confirm: true,
      user_metadata: { nome: j.nome, onboarding_completo: true, tour_visto: true },
    });
    if (error) throw new Error(`createUser ${email}: ${error.message}`);
    ids[j.apelido] = data.user.id;
    const { error: e2 } = await supabase.from('users').upsert({
      id: data.user.id, email, nome: j.nome, nome_jogador: j.apelido, birthdate: j.nasc,
      avatar_generico: j.av, avatar_url: GENERICO[j.av], plan: 'free',
      cor_frame: 'dourado', fundo_figurinha: 'estadio', kit_ativo: 'dark-gold',
    }, { onConflict: 'id' });
    if (e2) throw new Error(`users ${email}: ${e2.message.slice(0, 180)}`);
  }
  ok(`${JOGADORES.length} jogadores fictícios + ${CANDIDATOS.length} candidatos criados (avatares genéricos da casa, sem IA)`);
  return ids;
}

async function criarTimePrincipal(ids, donos) {
  const { data: time, error } = await supabase.from('teams').insert({
    nome: TIME.nome, slug: TIME.slug, cor: TIME.cor,
    criado_por: ids.Cacau, // um fictício cria: assim o --limpar derruba o time em cascata
    publica: true, modo_visibilidade: 'publico_aprovacao',
    localizacao: TIME.localizacao, descricao: TIME.descricao, cidade: TIME.cidade,
    geo_lat: TIME.geo_lat, geo_lng: TIME.geo_lng, mostrar_gols: true,
    created_at: TIME.created_at,
  }).select().single();
  if (error) throw new Error(`teams: ${error.message}`);

  // created_at do MEMBERSHIP também antigo: o Início ordena os times pela data em
  // que a pessoa ENTROU no time (services/inicio.js#obterTeams ordena team_members
  // por created_at), não pela data do time. Sem isto, um time onde o dono já
  // estivesse antes tomaria o lugar de "time principal" e o card de campeonato,
  // a votação e o RSVP do Início apontariam para o time errado.
  const membros = JOGADORES.map((j) => ({
    user_id: ids[j.apelido], team_id: time.id,
    role: j.apelido === 'Cacau' ? 'admin' : 'member',
    categoria: j.gr ? 'GR' : 'linha', posicao: j.pos, pode_postar: true,
    created_at: TIME.created_at,
  }));
  // Os dois e-mails do dono entram como ADMINISTRADORES.
  for (const d of donos) membros.push({ user_id: d.id, team_id: time.id, role: 'admin', categoria: 'linha', posicao: 'MEI', pode_postar: true, created_at: TIME.created_at });
  const { error: e2 } = await supabase.from('team_members').insert(membros);
  if (e2) throw new Error(`team_members: ${e2.message}`);
  ok(`time "${TIME.nome}" com ${JOGADORES.length} fictícios + ${donos.length} admin(s) do dono`);
  return time;
}

async function criarTimesPublicos(ids) {
  for (const t of TIMES_PUBLICOS) {
    const { data: time, error } = await supabase.from('teams').insert({
      nome: t.nome, slug: t.slug, cor: t.cor, criado_por: ids[t.admin],
      publica: true, modo_visibilidade: t.modo,
      localizacao: t.local, descricao: t.desc, cidade: t.cidade,
      geo_lat: t.geo[0], geo_lng: t.geo[1],
    }).select().single();
    if (error) throw new Error(`teams ${t.slug}: ${error.message}`);
    const membros = [{ user_id: ids[t.admin], team_id: time.id, role: 'admin' }]
      .concat(t.membros.map((a) => ({ user_id: ids[a], team_id: time.id, role: 'member' })));
    const { error: e2 } = await supabase.from('team_members').insert(membros);
    if (e2) throw new Error(`team_members ${t.slug}: ${e2.message}`);
  }
  ok(`${TIMES_PUBLICOS.length} times públicos (3 em Lisboa/Amadora, 2 em Brasília) para o Explorar`);
}

// Votos entre os fictícios + 8 deles a avaliar o dono (para ele já ter nota no
// ranking: o app só mostra nota com 3 votos recebidos). O dono NÃO vota em
// ninguém, de propósito: é isso que faz o Início mostrar "você tem colegas para
// avaliar" (services/inicio.js#obterVotacoesPendentes conta quem falta votar).
async function criarVotos(ids, teamId, donos) {
  const rng = mulberry32(20260915);
  const linhas = [];
  const agora = new Date().toISOString();
  for (const de of JOGADORES) {
    for (const para of JOGADORES) {
      if (de === para) continue;
      linhas.push({
        de_user_id: ids[de.apelido], para_user_id: ids[para.apelido], team_id: teamId,
        nota: nota05(para.forca + (rng() - 0.5)), game_id: null, created_at: agora, updated_at: agora,
      });
    }
    for (const d of donos) {
      if (JOGADORES.indexOf(de) >= 8) continue; // só os 8 primeiros avaliam o dono
      linhas.push({
        de_user_id: ids[de.apelido], para_user_id: d.id, team_id: teamId,
        nota: nota05(3.8 + (rng() - 0.5)), game_id: null, created_at: agora, updated_at: agora,
      });
    }
  }
  for (let i = 0; i < linhas.length; i += 400) {
    const { error } = await supabase.from('votes').insert(linhas.slice(i, i + 400));
    if (error) throw new Error(`votes: ${error.message}`);
  }
  ok(`${linhas.length} notas lançadas (o dono já tem nota, mas ainda não avaliou ninguém — é o card "vote agora")`);
}

function paraSorteio(j, ids, ratings) {
  return {
    user_id: ids[j.apelido], nome: j.apelido, avatar_url: GENERICO[j.av],
    rating: round1(ratings[ids[j.apelido]] ?? RATING_DEFAULT),
    goleiro: !!j.gr, cabeca_chave: !!j.cabeca,
  };
}
function montarResultado(sorteio, total, convidados = 0) {
  const times = sorteio.times.map((jogadores, i) => ({
    nome: `Time ${String.fromCharCode(65 + i)}`,
    rating_medio: Math.round((jogadores.reduce((s, j) => s + j.rating, 0) / (jogadores.length || 1)) * 100) / 100,
    jogadores,
  }));
  return { num_times: sorteio.numTimes, total_jogadores: total, convidados_total: convidados, seed: sorteio.seed, avisos: [], times, reservas: sorteio.reservas };
}
// Quem marca: atacante mais que meia, meia mais que zagueiro, goleiro nunca.
// Quem não está no elenco fictício (dono, convidado) conta como meia mediano —
// senão o dono nunca marcaria um gol e o ranking dele ficava sem eixo de gols.
function distribuirGols(jogadores, quantos, rng) {
  const peso = { ATA: 3, MEI: 2, DEF: 1, GL: 0 };
  const pesoDe = (j) => {
    const p = porApelido(j.nome);
    if (p) return peso[p.pos] * p.forca;
    return j.goleiro ? 0 : 2 * 3.5;
  };
  const candidatos = jogadores.filter((j) => pesoDe(j) > 0);
  const gols = {};
  for (let g = 0; g < quantos; g += 1) {
    const total = candidatos.reduce((s, j) => s + pesoDe(j), 0);
    if (!total) break;
    let r = rng() * total;
    for (const j of candidatos) {
      r -= pesoDe(j);
      if (r <= 0) { gols[j.user_id] = (gols[j.user_id] || 0) + 1; break; }
    }
  }
  return gols;
}

// Monta o elenco de UM jogo com o total EXATO de porTime*2, para o sorteio dar
// sempre 2 times (executarSorteio faz numTimes = floor(total/porTime); com 21
// jogadores e 6 por time dariam 3 times, e o placar A/B deixaria de fazer sentido).
// Rotaciona a linha a cada jogo: assim todos os 21 acumulam jogos e entram no
// ranking, que exige 3 jogos por pessoa (routes/ranking.js MIN_JOGOS).
function elencoDoJogo(i, porTime, ids, ratings, donos) {
  const goleiros = JOGADORES.filter((j) => j.gr);
  const linha = JOGADORES.filter((j) => !j.gr);
  const vagas = porTime * 2;
  const convidados = porTime === 11 ? [CONVIDADOS[0]] : [];

  const doisGoleiros = [goleiros[i % goleiros.length], goleiros[(i + 1) % goleiros.length]];
  const nLinha = vagas - doisGoleiros.length - donos.length - convidados.length;
  const escolhidos = [];
  for (let k = 0; k < nLinha; k += 1) escolhidos.push(linha[(i * 5 + k) % linha.length]);

  const membros = doisGoleiros.concat(escolhidos).map((j) => paraSorteio(j, ids, ratings));
  // O dono entra no sorteio de verdade: sem estar num time do times_resultado,
  // o ranking dele não contaria vitórias (utils/agregados.js lê os times daqui).
  for (const d of donos) {
    membros.push({
      user_id: d.id, nome: d.nome_jogador || d.nome || 'Você', avatar_url: null,
      rating: round1(ratings[d.id] ?? RATING_DEFAULT), goleiro: false, cabeca_chave: false,
    });
  }
  return { membros, convidados };
}

async function criarJogosPassados(ids, teamId, donos) {
  const userIds = JOGADORES.map((j) => ids[j.apelido]).concat(donos.map((d) => d.id));
  const ratings = await computeRatings(teamId, userIds);
  const rng = mulberry32(4242);
  const guardados = {};
  for (const [i, jp] of JOGOS_PASSADOS.entries()) {
    const { membros, convidados } = elencoDoJogo(i, jp.porTime, ids, ratings, donos);
    const sorteio = executarSorteio(membros, jp.porTime, { seed: 7000 + i, convidados });
    if (sorteio.numTimes !== 2) throw new Error(`jogo ${i}: sorteio deu ${sorteio.numTimes} times, era para dar 2`);
    const resultado = montarResultado(sorteio, membros.length + convidados.length, convidados.length);

    // O placar vem escrito do ponto de vista do time do dono: se ele caiu no
    // time B, inverte, para o histórico dele bater com o que está em JOGOS_PASSADOS.
    const donoNoTimeA = resultado.times[0].jogadores.some((j) => j.user_id === donos[0].id);
    const [pa, pb] = donoNoTimeA ? jp.placar : [jp.placar[1], jp.placar[0]];
    const golsA = distribuirGols(resultado.times[0].jogadores, pa, rng);
    const golsB = distribuirGols(resultado.times[1].jogadores, pb, rng);
    const todosGols = { ...golsA, ...golsB };
    const [artilheiroId, artilheiroGols] = Object.entries(todosGols).sort((a, b) => b[1] - a[1])[0] || [null, 0];
    const vencedor = pa > pb ? 'A' : pb > pa ? 'B' : 'empate';
    const timeVenc = vencedor === 'B' ? resultado.times[1] : resultado.times[0];
    const destaque = vencedor === 'empate'
      ? timeVenc.jogadores.find((j) => j.goleiro) || timeVenc.jogadores[0]
      : timeVenc.jogadores.slice().sort((a, b) => (todosGols[b.user_id] || 0) - (todosGols[a.user_id] || 0))[0];

    const { data: game, error } = await supabase.from('games').insert({
      team_id: teamId, data: dias(-jp.diasAtras), local: jp.local,
      jogadores_por_time: jp.porTime, num_times: resultado.num_times,
      status: 'terminado', sorteio_realizado: true, times_resultado: resultado,
      resultado_nivel: 3, time_vencedor: vencedor, placar_a: pa, placar_b: pb,
      artilheiro_user_id: artilheiroId, artilheiro_gols: artilheiroGols,
      destaque_user_id: destaque.user_id, destaque_titulo: vencedor === 'empate' ? 'Muralha da rodada' : 'Craque da pelada',
      // campeao_time_index != null é o que faz o jogo APARECER na Resenha (routes/feed.js).
      campeao_time_index: vencedor === 'empate' ? 0 : (vencedor === 'A' ? 0 : 1),
      created_at: dias(-jp.diasAtras - 5),
    }).select().single();
    if (error) throw new Error(`games[${i}]: ${error.message}`);
    if (jp.guardado) guardados[jp.guardado] = game.id;

    // Presenças = exatamente quem entrou no sorteio (convidados não têm conta,
    // por isso não geram linha aqui). É isto que destrava "colegas para avaliar".
    const presentes = membros.map((m) => {
      const p = porApelido(m.nome);
      return { game_id: game.id, user_id: m.user_id, confirmado: true, goleiro: !!m.goleiro, cabeca_chave: !!(p && p.cabeca) };
    });
    const { error: e2 } = await supabase.from('game_players').insert(presentes);
    if (e2) throw new Error(`game_players[${i}]: ${e2.message}`);

    const timeDe = {};
    resultado.times[0].jogadores.forEach((j) => { if (j.user_id) timeDe[j.user_id] = 'A'; });
    resultado.times[1].jogadores.forEach((j) => { if (j.user_id) timeDe[j.user_id] = 'B'; });
    const linhasGols = Object.entries(todosGols)
      .filter(([uid]) => uid && uid !== 'null')
      .map(([user_id, gols]) => ({ game_id: game.id, user_id, gols, time: timeDe[user_id] || 'A' }));
    if (linhasGols.length) {
      const { error: e3 } = await supabase.from('gols_jogadores').insert(linhasGols);
      if (e3) throw new Error(`gols_jogadores[${i}]: ${e3.message}`);
    }
  }
  ok(`${JOGOS_PASSADOS.length} jogos passados com placar, gols, artilheiro e destaque (2 deles guardados: 5x5 e 11x11)`);
  return guardados;
}

// Jogo futuro: 18 confirmados (dá para o dono sortear ao vivo 2 times de 9),
// 3 recusaram, o resto sem resposta. NOTA: o app não tem "talvez" — o RSVP só
// aceita 'confirmado' ou 'recusado' (migração 022), por isso não há como semear
// um "talvez" honesto; quem não respondeu simplesmente não tem linha.
async function criarJogoFuturo(ids, teamId, donos) {
  const { data: game, error } = await supabase.from('games').insert({
    team_id: teamId, data: dias(3), local: 'Alvalade, campo 2',
    jogadores_por_time: 9, max_jogadores: 24,
    rsvp_aberto: true, rsvp_fechado: false, rsvp_prazo: dias(2),
  }).select().single();
  if (error) throw new Error(`games(futuro): ${error.message}`);

  const confirmados = JOGADORES.slice(0, 17).map((j) => j.apelido);
  const recusaram = JOGADORES.slice(17, 20).map((j) => j.apelido);
  const linhas = confirmados.map((a) => ({ game_id: game.id, user_id: ids[a], confirmado: true, goleiro: !!porApelido(a).gr, cabeca_chave: !!porApelido(a).cabeca }))
    .concat(recusaram.map((a) => ({ game_id: game.id, user_id: ids[a], confirmado: false, goleiro: false, cabeca_chave: false })));
  // O 1º dono entra confirmado: 17 fictícios + ele = 18 para o sorteio ao vivo.
  linhas.push({ game_id: game.id, user_id: donos[0].id, confirmado: true, goleiro: false, cabeca_chave: false });
  const { error: e2 } = await supabase.from('game_players').insert(linhas);
  if (e2) throw new Error(`game_players(futuro): ${e2.message}`);

  const rsvp = confirmados.map((a) => ({ game_id: game.id, user_id: ids[a], status: 'confirmado' }))
    .concat(recusaram.map((a) => ({ game_id: game.id, user_id: ids[a], status: 'recusado' })));
  rsvp.push({ game_id: game.id, user_id: donos[0].id, status: 'confirmado' });
  const { error: e3 } = await supabase.from('rsvp_respostas').insert(rsvp);
  if (e3) throw new Error(`rsvp_respostas: ${e3.message}`);

  ok(`jogo daqui a 3 dias: 18 confirmados (pronto para sortear 9x9 ao vivo), 3 recusaram, 2 sem resposta`);
  return game;
}

// Segundo jogo futuro (Rodada 8B, 15-set): outro dia, outro formato — para o
// Início mostrar DOIS sorteios ativos ao mesmo tempo (pedido do dono). 5x5,
// capacidade menor (14), RSVP aberto com prazo mais folgado (5 dias). Idempotente
// pelo par (team_id, local): rodar de novo (ou a demo inteira de novo) não duplica.
const LOCAL_JOGO_EXTRA = 'Quadra do Guará';
async function criarJogoExtra(ids, teamId, donos) {
  const { data: existente } = await supabase.from('games').select('id').eq('team_id', teamId).eq('local', LOCAL_JOGO_EXTRA).maybeSingle();
  if (existente) {
    info(`jogo em "${LOCAL_JOGO_EXTRA}" já existe (id ${existente.id}) — nada a fazer.`);
    return { id: existente.id, jaExistia: true };
  }

  const { data: game, error } = await supabase.from('games').insert({
    team_id: teamId, data: dias(6), local: LOCAL_JOGO_EXTRA,
    jogadores_por_time: 5, max_jogadores: 14,
    rsvp_aberto: true, rsvp_fechado: false, rsvp_prazo: dias(5),
  }).select().single();
  if (error) throw new Error(`games(extra): ${error.message}`);

  // 8 primeiros JOGADORES confirmados + o 1º dono; os 2 seguintes recusam; o
  // resto (11 jogadores + o 2º dono, se houver) fica sem resposta.
  const confirmados = JOGADORES.slice(0, 8).map((j) => j.apelido);
  const recusaram = JOGADORES.slice(8, 10).map((j) => j.apelido);
  const linhas = confirmados.map((a) => ({ game_id: game.id, user_id: ids[a], confirmado: true, goleiro: !!porApelido(a).gr, cabeca_chave: !!porApelido(a).cabeca }))
    .concat(recusaram.map((a) => ({ game_id: game.id, user_id: ids[a], confirmado: false, goleiro: false, cabeca_chave: false })));
  linhas.push({ game_id: game.id, user_id: donos[0].id, confirmado: true, goleiro: false, cabeca_chave: false });
  const { error: e2 } = await supabase.from('game_players').insert(linhas);
  if (e2) throw new Error(`game_players(extra): ${e2.message}`);

  const rsvp = confirmados.map((a) => ({ game_id: game.id, user_id: ids[a], status: 'confirmado' }))
    .concat(recusaram.map((a) => ({ game_id: game.id, user_id: ids[a], status: 'recusado' })));
  rsvp.push({ game_id: game.id, user_id: donos[0].id, status: 'confirmado' });
  const { error: e3 } = await supabase.from('rsvp_respostas').insert(rsvp);
  if (e3) throw new Error(`rsvp_respostas(extra): ${e3.message}`);

  ok(`jogo daqui a 6 dias em "${LOCAL_JOGO_EXTRA}" (5x5, máx 14): 9 confirmados (8 jogadores + você), 2 recusaram, resto sem resposta`);
  return { id: game.id, jaExistia: false };
}

// Mapa apelido→id a partir de uma demo JÁ CRIADA (--so-jogo-extra corre sobre
// ela sem recriar nada) — os ids não ficam no ARQ_ESTADO, só os emails batem
// com o padrão fixo de emailDe(), por isso uma consulta por e-mail basta.
async function carregarIdsJogadores() {
  const emails = JOGADORES.map((j) => emailDe(j));
  const { data, error } = await supabase.from('users').select('id, email').in('email', emails);
  if (error) throw new Error(`users: ${error.message}`);
  const idPorEmail = new Map((data || []).map((u) => [u.email, u.id]));
  const ids = {};
  for (const j of JOGADORES) {
    const id = idPorEmail.get(emailDe(j));
    if (!id) throw new Error(`jogador ${j.apelido} (${emailDe(j)}) não existe — rode a demo completa primeiro: node scripts/demo-completa.js`);
    ids[j.apelido] = id;
  }
  return ids;
}

// --so-jogo-extra: insere SÓ o segundo jogo futuro sobre uma demo que já existe,
// sem tocar em mais nada (nem recriar usuários, nem repetir votos/posts/etc.).
async function criarSoJogoExtra() {
  const { data: time } = await supabase.from('teams').select('id, slug').eq('slug', SLUG).maybeSingle();
  if (!time) throw new Error(`time ${SLUG} não existe — rode a demo completa primeiro: node scripts/demo-completa.js`);
  const donos = await acharDonos();
  const ids = await carregarIdsJogadores();
  const jogo = await criarJogoExtra(ids, time.id, donos);
  if (!jogo.jaExistia) {
    ok('Pronto — o Início de quem é dono agora mostra DOIS jogos futuros com RSVP aberto (3 e 6 dias).');
  }
}

async function criarResenha(ids, teamId, donos) {
  const urls = [];
  const idPorApelido = (a) => ids[a];
  let postDenunciado = null;

  for (const p of POSTS) {
    const criadoEm = dias(-p.horas / 24);
    const { data: post, error } = await supabase.from('feed_posts').insert({
      team_id: teamId, author_id: idPorApelido(p.autor), body: p.texto, tipo: 'post',
      created_at: criadoEm, updated_at: criadoEm,
    }).select().single();
    if (error) throw new Error(`feed_posts: ${error.message}`);
    if (p.denunciado) postDenunciado = post;

    if (p.foto) {
      const nome = `${crypto.randomUUID()}.webp`;
      const { error: eU } = await supabase.storage.from('resenha').upload(nome, fs.readFileSync(FOTO_CAMPO), { contentType: 'image/webp' });
      if (eU) throw new Error(`storage resenha (foto): ${eU.message}`);
      const url = `${process.env.SUPABASE_URL}/storage/v1/object/public/resenha/${nome}`;
      urls.push(url);
      const { error: eM } = await supabase.from('feed_post_media').insert({ post_id: post.id, url, media_type: 'image', position: 0 });
      if (eM) throw new Error(`feed_post_media (foto): ${eM.message}`);
    }
    if (p.gif) {
      const nome = `${crypto.randomUUID()}.gif`;
      const { error: eU } = await supabase.storage.from('resenha').upload(nome, gerarGifBola(), { contentType: 'image/gif' });
      if (eU) throw new Error(`storage resenha (gif): ${eU.message}`);
      const url = `${process.env.SUPABASE_URL}/storage/v1/object/public/resenha/${nome}`;
      urls.push(url);
      const { error: eM } = await supabase.from('feed_post_media').insert({ post_id: post.id, url, media_type: 'gif', position: 0 });
      if (eM) throw new Error(`feed_post_media (gif): ${eM.message}`);
    }

    const reacoes = Object.entries(p.reacoes || {}).map(([a, emoji]) => ({ target_type: 'post', target_id: post.id, user_id: idPorApelido(a), emoji }));
    if (reacoes.length) {
      const { error: eR } = await supabase.from('reacoes').insert(reacoes);
      if (eR) throw new Error(`reacoes: ${eR.message}`);
    }

    // Comentários em ordem; `resp` aponta para o índice de outro comentário deste
    // post (vira reply_to = resposta aninhada).
    const criados = [];
    for (const [k, c] of (p.comentarios || []).entries()) {
      const quando = new Date(new Date(criadoEm).getTime() + (k + 1) * 23 * 60000).toISOString();
      const { data: com, error: eC } = await supabase.from('comentarios').insert({
        parent_type: 'post', parent_id: post.id, author_id: idPorApelido(c.de), body: c.txt,
        reply_to: c.resp != null && criados[c.resp] ? criados[c.resp].id : null,
        created_at: quando, updated_at: quando,
      }).select().single();
      if (eC) throw new Error(`comentarios: ${eC.message}`);
      criados.push(com);
    }
  }

  // Anúncio oficial do admin (card dourado, sem like/comentário).
  const quandoAnuncio = dias(-ANUNCIO.horas / 24);
  const { error: eA } = await supabase.from('feed_posts').insert({
    team_id: teamId, author_id: donos[0].id, tipo: 'anuncio', body: ANUNCIO.mensagem,
    conteudo: { titulo: ANUNCIO.titulo, mensagem: ANUNCIO.mensagem },
    created_at: quandoAnuncio, updated_at: quandoAnuncio,
  });
  if (eA) throw new Error(`feed_posts(anuncio): ${eA.message}`);

  ok(`${POSTS.length} posts na Resenha (foto, GIF, YouTube, Instagram, texto longo) + 1 anúncio oficial`);
  return { urls, postDenunciado };
}

// Duas frentes, porque o app tem duas filas diferentes:
//  · tabela `denuncias` (009) = fila do ADMIN DO TIME (GET /api/feed/denuncias);
//  · JSON no Storage = fila do GABINETE do super-admin (GET /api/super/denuncias/fila).
// Categoria 'assedio' com estado 'fila': a triagem nunca auto-arquiva, fica à espera de humano.
async function criarDenuncia(ids, teamId, post) {
  if (!post) return;
  const { error } = await supabase.from('denuncias').insert({
    target_type: 'post', target_id: post.id, reporter_id: ids.Serginho,
    motivo: 'conteudo_ofensivo', descricao: 'Ofensa a quem joga aos sábados, gerou discussão no grupo.',
    resolvida: false,
  });
  if (error) throw new Error(`denuncias: ${error.message}`);

  await denunciaStore.ensureDenunciasBucket();
  const agora = new Date().toISOString();
  const caso = denunciaStore.novoCaso({
    teamId, targetType: 'post', targetId: post.id, reporterId: ids.Serginho,
    categoria: 'assedio', descricao: 'Ofensa a quem joga aos sábados, gerou discussão no grupo.',
    pesoReporter: 1, agoraISO: agora,
  });
  caso.estado = 'fila'; // sem isto não aparece na fila do Gabinete
  denunciaStore.logar(caso, { quem: 'sistema', tipo: 'triagem', quando: agora, resultado: 'fila' });
  await denunciaStore.guardarCaso(caso);
  ok('1 post denunciado — aparece na fila do admin do time E na fila do Gabinete');
}

// Campeonato do STORAGE (N times) = a tela /equipa/:slug/campeonato e os SELOS.
async function criarCampeonatosStorage(ids, teamId, donos) {
  await campStore.ensureCampeonatosBucket();
  const plantel = (apelidos) => apelidos.map((a) => ({ user_id: ids[a], nome: a, avatar_url: GENERICO[porApelido(a).av], convidado: false }));

  // 1) Pontos corridos, EM ANDAMENTO: 4 times, 3 de 6 confrontos jogados.
  const emCurso = await campStore.criar(teamId, donos[0].id, {
    nome: 'Campeonato Vila Olímpica 2026/2', formato: 'pontos', usar_sorteio: false,
    nomes: ['Leões do Alvalade', 'Fúria Verde', 'Os Intocáveis', 'Rebeldes FC'],
    plantel: [
      plantel(['Cacau', 'Muralha', 'Juninho', 'Formiga', 'Duda']).concat([{ user_id: donos[0].id, nome: donos[0].nome_jogador || 'Você', avatar_url: null, convidado: false }]),
      plantel(['Tonho', 'Gato', 'Bigode', 'Russo', 'Mel']),
      plantel(['Gabi', 'Paredão', 'Lelê', 'Zequinha', 'Baiano']),
      plantel(['Pipoca', 'Boi', 'Serginho', 'Kiko', 'Nanda', 'Canela']),
    ],
  });
  const placares = [[3, 1], [2, 2], [4, 2]];
  for (const [i, pl] of placares.entries()) {
    campStore.aplicarResultado(emCurso, emCurso.confrontos[i].id, pl[0], pl[1]);
  }
  await campStore.guardar(emCurso);

  // 2) Mata-mata TERMINADO: 4 times, campeão coroado → vira selo de honra (30 dias).
  const mata = await campStore.criar(teamId, donos[0].id, {
    nome: 'Copa de Verão do Alvalade', formato: 'mata', usar_sorteio: false,
    nomes: ['Leões do Alvalade', 'Tejo Azul', 'Sporting da Rua', 'Cerrado Unido'],
    plantel: [
      plantel(['Cacau', 'Muralha', 'Juninho', 'Gabi', 'Duda']).concat([{ user_id: donos[0].id, nome: donos[0].nome_jogador || 'Você', avatar_url: null, convidado: false }]),
      plantel(['Tonho', 'Gato', 'Russo', 'Mel', 'Formiga']),
      plantel(['Pipoca', 'Paredão', 'Bigode', 'Kiko', 'Nanda']),
      plantel(['Boi', 'Serginho', 'Lelê', 'Zequinha', 'Baiano', 'Canela']),
    ],
  });
  const semis = mata.confrontos.filter((c) => c.ronda === 1);
  campStore.aplicarResultado(mata, semis[0].id, 3, 1);
  campStore.aplicarResultado(mata, semis[1].id, 2, 4);
  const final = mata.confrontos.find((c) => c.ronda === 2);
  campStore.aplicarResultado(mata, final.id, 2, 1);
  mata.criado_em = dias(-20);
  mata.terminado_em = dias(-12);
  await campStore.guardar(mata);

  const campeao = mata.times.find((t) => t.id === mata.campeao_time_id);
  ok(`2 campeonatos: "${emCurso.nome}" em andamento (3 de 6 rodadas) e "${mata.nome}" terminado — campeão ${campeao?.nome}`);
  return { emCurso, mata };
}

// Campeonato da TABELA ANTIGA (2 times) — é o ÚNICO que alimenta o card do
// Início (services/inicio.js lê a tabela `campeonatos`, não o Storage).
async function criarCampeonatoDoInicio(teamId) {
  const { error } = await supabase.from('campeonatos').insert({
    team_id: teamId, nome: 'Duelo de Quarta', num_jornadas: 8, jornadas_jogadas: 3, estado: 'ativo',
    time_a_nome: 'Coletes', time_b_nome: 'Sem Colete',
    time_a_pontos: 7, time_b_pontos: 2, time_a_vitorias: 2, time_b_vitorias: 0,
    time_a_empates: 1, time_b_empates: 1, time_a_derrotas: 0, time_b_derrotas: 2,
    criado_em: dias(-30),
  });
  if (error) throw new Error(`campeonatos(tabela antiga): ${error.message}`);
  ok('campeonato "Duelo de Quarta" 3/8 jornadas — é o card que aparece no Início');
}

async function criarPendencias(ids, time, donos) {
  // Convite por link ATIVO (usado_por null + expires_at no futuro).
  const { data: convite, error } = await supabase.from('convites').insert({
    team_id: time.id, criado_por: donos[0].id, expires_at: dias(7),
  }).select().single();
  if (error) throw new Error(`convites: ${error.message}`);

  // 2 pedidos de entrada à espera (o time é publico_aprovacao) → badge dourado
  // no chip do time, no Início de quem é admin. Vêm dos CANDIDATOS, que não são
  // membros de time nenhum — um pedido de quem já está dentro não faria sentido.
  const pedidos = CANDIDATOS.map((c, i) => ({
    team_id: time.id, user_id: ids[c.apelido], status: 'pending', mensagem: c.msg,
    created_at: dias(-2 + i), updated_at: dias(-2 + i),
  }));
  const { error: e2 } = await supabase.from('team_join_requests').insert(pedidos);
  if (e2) throw new Error(`team_join_requests: ${e2.message}`);

  ok('1 convite por link ativo (7 dias) + 2 pedidos de entrada à espera de aprovação');
  return convite;
}

// Bloqueio: o dono bloqueia um fictício. Serve para ver a Resenha a filtrar —
// os posts e comentários do bloqueado desaparecem para ele (blocksStore#conjuntoMutuo).
async function criarBloqueio(ids, donos) {
  const { error } = await supabase.from('user_blocks').insert({ blocker_id: donos[0].id, blocked_id: ids.Bigode });
  if (error && !/duplicate|unique/i.test(error.message)) throw new Error(`user_blocks: ${error.message}`);
  ok('Bigode bloqueado pelo dono — os posts e comentários dele somem da Resenha dele');
}

async function criar() {
  if (await jaExiste()) {
    info(`o time ${SLUG} já existe — nada a fazer (idempotente).`);
    info('Para refazer do zero: node scripts/demo-completa.js --limpar && node scripts/demo-completa.js');
    return;
  }
  const donos = await acharDonos();
  info(`admin(s) do dono: ${donos.map((d) => d.email).join(', ')}`);

  const ids = await criarUsuarios();
  const time = await criarTimePrincipal(ids, donos);
  await criarTimesPublicos(ids);
  await criarVotos(ids, time.id, donos);
  const guardados = await criarJogosPassados(ids, time.id, donos);
  const futuro = await criarJogoFuturo(ids, time.id, donos);
  const futuroExtra = await criarJogoExtra(ids, time.id, donos);
  const { urls, postDenunciado } = await criarResenha(ids, time.id, donos);
  await criarDenuncia(ids, time.id, postDenunciado);
  const camps = await criarCampeonatosStorage(ids, time.id, donos);
  await criarCampeonatoDoInicio(time.id);
  const convite = await criarPendencias(ids, time, donos);
  await criarBloqueio(ids, donos);

  fs.mkdirSync(LOJA, { recursive: true });
  fs.writeFileSync(ARQ_ESTADO, JSON.stringify({
    criadoEm: new Date().toISOString(), teamSlug: SLUG, teamId: time.id,
    donos: donos.map((d) => d.email), jogoFuturoId: futuro.id, jogoExtraId: futuroExtra.id,
    sorteioGuardado5x5: guardados['5x5'], sorteioGuardado11x11: guardados['11x11'],
    conviteToken: convite.token, campeonatoEmCurso: camps.emCurso.id, campeonatoTerminado: camps.mata.id,
    fotosResenha: urls,
  }, null, 2), 'utf8');

  resumo(time, futuro, guardados, convite, camps, donos);
}

function resumo(time, futuro, guardados, convite, camps, donos) {
  const l = console.log;
  l('\n════════════════════════════════════════════════════════════════');
  l('  DEMO COMPLETA PRONTA — Vila Olímpica FC');
  l('════════════════════════════════════════════════════════════════\n');
  l(`Entre com: ${donos.map((d) => d.email).join('  ou  ')}`);
  l('(a senha é a que você já usa — as suas contas não foram tocadas)\n');
  l('O QUE FOI CRIADO');
  l(`  · 21 jogadores fictícios (3 goleiros, 4 jogadoras), avatares genéricos da casa — nenhuma IA gastou crédito`);
  l(`  · 3 convidados sem app (${CONVIDADOS.join(', ')}) — só dentro do JSON do sorteio`);
  l(`  · time "Vila Olímpica FC" em Lisboa, público com aprovação — você é ADMIN`);
  l(`  · 5 times públicos extra: 3 em Lisboa/Amadora, 2 em Brasília`);
  l(`  · 8 jogos passados com placar, gols, artilheiro e destaque`);
  l(`  · 2 jogos futuros com RSVP aberto: daqui a 3 dias (9x9) e daqui a 6 dias (5x5)`);
  l(`  · 2 campeonatos (1 rolando, 1 terminado) + 1 campeonato de 2 times para o card do Início`);
  l(`  · 12 posts na Resenha + 1 anúncio oficial, com comentários, respostas e reações`);
  l('');
  l('ONDE VER CADA COISA (tela → o que procurar)');
  l('');
  l('  INÍCIO');
  l('    → "Você tem colegas para avaliar": você ainda não deu nota a ninguém. Toque e avalie.');
  l('    → Card do campeonato "Duelo de Quarta": 3 de 8 jornadas, Coletes 7 x 2 Sem Colete.');
  l('    → Card do próximo jogo (3 dias) com botão de presença — 18 já confirmaram.');
  l('    → Segundo card de jogo (6 dias, Quadra do Guará, 5x5) — dois sorteios ativos ao mesmo tempo.');
  l('    → Chip do time com BOLINHA DOURADA: 2 pessoas pedindo entrada.');
  l('    → Últimos Jogos: os 3 mais recentes, com placar.');
  l('');
  l('  RESENHA');
  l('    → Post com GIF (bola girando) e post com foto do campo.');
  l('    → Post com link do YouTube: toque na miniatura para tocar ali mesmo.');
  l('    → Post com link do Instagram: card que abre em outra aba.');
  l('    → Post longo da Lelê (fim de semana fora) com 6 comentários e respostas aninhadas.');
  l('    → Card dourado do anúncio oficial (sem curtida, sem comentário).');
  l('    → Cards de jogo com campeão, artilheiro e craque da pelada.');
  l('    → O Bigode está BLOQUEADO por você: os posts dele não aparecem. Desbloqueie em Perfil → Bloqueados para ver sumir e voltar.');
  l('');
  l('  RANKING');
  l('    → Lista única com os 21 mais você, score de 0 a 100. Você já tem nota');
  l('      (8 colegas te avaliaram) e 8 jogos, bem acima dos 3 que o app exige.');
  l('    → Toque num jogador para ver o radar (nota, vitórias, gols, artilharia, destaque, fidelidade).');
  l('');
  l('  JOGO → SORTEIO');
  l(`    → Sorteio guardado 5x5:   /equipa/${SLUG}/jogo/${guardados['5x5']}/sorteio`);
  l(`    → Sorteio guardado 11x11: /equipa/${SLUG}/jogo/${guardados['11x11']}/sorteio`);
  l(`    → Sorteio AO VIVO (18 confirmados, 2 times de 9): abra o jogo de ${new Date(futuro.data).toLocaleDateString('pt-BR')} e toque em Sortear.`);
  l('');
  l('  CAMPEONATO (aba do time)');
  l(`    → "${camps.emCurso.nome}": 4 times, pontos corridos, 3 de 6 rodadas jogadas — tabela viva.`);
  l(`    → "${camps.mata.nome}": mata-mata terminado, campeão coroado.`);
  l('       Como você está no time campeão, ganhou SELO DE HONRA (ouro) — veja no cromo da Figurinha.');
  l('');
  l('  EXPLORAR');
  l('    → 3 times perto de Lisboa (Saudade FC, Tejo Bola, Amadora Athletic) e 2 em Brasília.');
  l('    → Saudade FC e Amadora são "abertos" (botão Entrar); Tejo Bola e Cerrado pedem aprovação.');
  l('    → Ligue o filtro de raio para ver a distância funcionando.');
  l('');
  l('  TIME → PEDIDOS');
  l(`    → 2 pessoas esperando: ${CANDIDATOS.map((c) => c.apelido).join(' e ')}, com mensagem. Aprove ou recuse.`);
  l(`    → Convite por link ativo (vale 7 dias): /convite/${convite.token}`);
  l('');
  l('  GABINETE (só na conta contatofuttyapp, que é super-admin)');
  l('    → Pessoas & times → Denúncias: 1 caso na fila (post do Bigode, categoria assédio).');
  l('    → O mesmo caso aparece na fila do admin do time, dentro da Resenha.');
  l('');
  l('O QUE O APP NÃO TEM (pedido no bloco, não existe no produto)');
  l('  · ENQUETE na Resenha: não existe. Os tipos de post são post/anúncio apenas.');
  l('  · "TALVEZ" na presença: o RSVP só aceita confirmado ou recusado. Quem está');
  l('    em dúvida simplesmente não responde (e aparece como sem resposta).');
  l('  · RANKING com 3 abas: hoje é lista única (as abas por período foram removidas).');
  l('');
  l('PARA APAGAR TUDO ISTO');
  l('  cd /c/Users/phfer/Desktop/FUT/FUTTY-V2/backend && node scripts/demo-completa.js --limpar');
  l('  (só toca no que este script criou; a conta demo-loja e o Domingueira FC ficam intactos)');
  l('════════════════════════════════════════════════════════════════');
}

// ─── Limpeza ─────────────────────────────────────────────────────────────────

async function limpar() {
  // 1) Times do script (pelos slugs) — precisamos dos ids antes de apagar contas.
  const { data: times } = await supabase.from('teams').select('id, slug').in('slug', SLUGS);
  const teamIds = (times || []).map((t) => t.id);

  // 2) Fotos/GIF da Resenha no Storage, antes do cascade levar as linhas.
  if (teamIds.length) {
    const { data: posts } = await supabase.from('feed_posts').select('id').in('team_id', teamIds);
    const postIds = (posts || []).map((p) => p.id);
    if (postIds.length) {
      const { data: media } = await supabase.from('feed_post_media').select('url').in('post_id', postIds);
      const urls = (media || []).map((m) => m.url).filter(Boolean);
      if (urls.length) {
        const r = await removerFicheirosPorUrl('resenha', urls);
        info(`${r.removidos} ficheiro(s) da Resenha removido(s) do Storage`);
      }
    }
  }

  // 3) Campeonatos e denúncias no Storage (ficam fora do cascade do Postgres).
  for (const tid of teamIds) {
    const camps = await campStore.listar(tid).catch(() => []);
    for (const c of camps) await campStore.apagar(tid, c.id);
    if (camps.length) info(`${camps.length} campeonato(s) do Storage apagado(s)`);
    const casos = await denunciaStore.listarEquipa(tid).catch(() => []);
    if (casos.length) {
      await supabase.storage.from('denuncias').remove(casos.map((c) => `casos/${tid}/${c.id}.json`));
      info(`${casos.length} denúncia(s) do Storage apagada(s)`);
    }
  }

  // 4) Os times, DIRETO pelo slug. O cascade do Postgres leva com eles membros,
  //    jogos, presenças, gols, votos, posts, comentários, reações, convites,
  //    pedidos de entrada e a linha da tabela `campeonatos`. É determinístico:
  //    não depende da ordem em que as contas caem.
  for (const t of times || []) {
    const { error } = await supabase.from('teams').delete().eq('id', t.id);
    if (error) throw new Error(`apagar time ${t.slug}: ${error.message}`);
    info(`time ${t.slug} apagado (com jogos, posts e tudo em cascata)`);
  }

  // 5) Contas do script: public.users + órfãos do Auth (criação interrompida).
  const { data: rows } = await supabase.from('users').select('id, email').ilike('email', `${PREFIXO}-%${DOMINIO}`);
  const contas = new Map((rows || []).map((u) => [u.id, u.email]));
  const { data: lista } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  for (const u of lista?.users || []) {
    if (u.email && u.email.startsWith(`${PREFIXO}-`) && u.email.endsWith(DOMINIO)) contas.set(u.id, u.email);
  }
  const idsFicticios = [...contas.keys()];

  // 6) Bloqueios dos dois lados (senão sobrava resíduo na conta do dono).
  if (idsFicticios.length) {
    await supabase.from('user_blocks').delete().in('blocked_id', idsFicticios);
    await supabase.from('user_blocks').delete().in('blocker_id', idsFicticios);
  }

  // 7) As contas em si (public.users + auth + avatar no Storage).
  for (const [id, email] of contas) {
    await apagarUsuario(id);
    info(`${email} apagado`);
  }

  if (fs.existsSync(ARQ_ESTADO)) fs.unlinkSync(ARQ_ESTADO);
  ok(`${contas.size} conta(s) e ${(times || []).length} time(s) apagados. A conta demo-loja e o Domingueira FC não foram tocados.`);
}

// Ensaio: monta os 8 jogos EM MEMÓRIA, sem tocar no banco, e confere o que
// interessa — 2 times em cada sorteio e ninguém abaixo de 3 jogos (o ranking
// exige 3). Serve para não descobrir um elenco mal montado já em produção.
function ensaio() {
  const ids = Object.fromEntries(JOGADORES.concat(CANDIDATOS).map((j, i) => [j.apelido, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`]));
  const donos = [{ id: 'dono-1', nome: 'Pedro Borges', nome_jogador: 'Chavo' }, { id: 'dono-2', nome: 'Pedro Borges', nome_jogador: null }];
  const ratings = {};
  const jogosPor = {};
  for (const [i, jp] of JOGOS_PASSADOS.entries()) {
    const { membros, convidados } = elencoDoJogo(i, jp.porTime, ids, ratings, donos);
    const sorteio = executarSorteio(membros, jp.porTime, { seed: 7000 + i, convidados });
    const tamanhos = sorteio.times.map((t) => t.length).join('+');
    console.log(`jogo ${i + 1} (${jp.porTime}x${jp.porTime}): ${membros.length} pessoas + ${convidados.length} convidado → ${sorteio.numTimes} times (${tamanhos}), ${sorteio.reservas.length} reserva(s)`);
    if (sorteio.numTimes !== 2) throw new Error(`  ✗ deu ${sorteio.numTimes} times, era para dar 2`);
    for (const m of membros) jogosPor[m.nome] = (jogosPor[m.nome] || 0) + 1;
  }
  const poucos = JOGADORES.filter((j) => (jogosPor[j.apelido] || 0) < 3);
  console.log(`\njogos por pessoa: ${JOGADORES.map((j) => `${j.apelido}=${jogosPor[j.apelido] || 0}`).join(' ')}`);
  if (poucos.length) {
    aviso(`${poucos.length} ficariam fora do ranking (menos de 3 jogos): ${poucos.map((j) => j.apelido).join(', ')}`);
  } else {
    ok('todos os 21 chegam a 3+ jogos — ninguém fica de fora do ranking');
  }
  ok('ensaio terminado — nada foi gravado');
}

(async () => {
  if (ENSAIO) ensaio();
  else if (LIMPAR) await limpar();
  else if (SO_JOGO_EXTRA) await criarSoJogoExtra();
  else await criar();
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
