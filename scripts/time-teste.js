// Futty — Time de Teste "Várzea FC" (TIME-TESTE.md, 28-set-2026).
//
// Time de demonstração completo para os amigos do Pedro testarem o app sem
// mexer no Missa de Quinta. Fala DIRETO com o Supabase (service role,
// utils/db) — nunca chama o Cloud Run nem a fal. Não gera nenhuma figurinha
// por IA (custo zero): as 3 figurinhas do elenco entram por upload direto,
// no molde de scripts/_bench/repor-estado-demo.js --figurinha-de.
//
//   node scripts/time-teste.js                       cria tudo (aborta se o slug já existir)
//   node scripts/time-teste.js --status               link do convite, validade, datas, contagens
//   node scripts/time-teste.js --reagendar             recalcula J1/J2/J3 a partir de hoje
//   node scripts/time-teste.js --promover-convidados   promove a admin quem entrou pelo convite
//   node scripts/time-teste.js --limpar                só MOSTRA o que apagaria
//   node scripts/time-teste.js --limpar --sim          apaga de verdade
//
// Regras de segurança (TIME-TESTE.md §"Regras de segurança"): escreve só no
// time varzea-fc-teste e em contas teste-varzea-<slug>@futtymock.com. NUNCA
// toca em domingueira-fc-demo, demo-loja@, Missa de Quinta, nem na conta
// contatofuttyapp@gmail.com (só recebe um vínculo de membro). Correr a
// partir de backend/ (utils/db.js lê o .env do diretório atual).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { supabase, computeRatings } = require('../utils/db');
const { executarSorteio, mulberry32 } = require('../utils/sorteio');
const { RATING_DEFAULT } = require('../utils/helpers');
const { apagarUsuario } = require('../utils/apagarUsuario');
const { removerFicheirosPorUrl } = require('../utils/storage');
const { classificar } = require('../utils/nsfwFilter');
const { subirLogoTime } = require('./subir-logo-time');

const args = process.argv.slice(2);
const tem = (n) => args.includes(`--${n}`);
const STATUS = tem('status');
const REAGENDAR = tem('reagendar');
const PROMOVER = tem('promover-convidados');
const LIMPAR = tem('limpar');
const CONFIRMA_LIMPAR = tem('sim');

const ok = (m) => console.log('✓', m);
const info = (m) => console.log('·', m);
const aviso = (m) => console.warn('!', m);
const round1 = (n) => Math.round(n * 10) / 10;
// Nota do voto: 1 a 5 em passos de 0,5 (constraint votes_nota_check, migração 017).
const nota05 = (n) => Math.min(5, Math.max(1, Math.round(n * 2) / 2));

// ─── Constantes ────────────────────────────────────────────────────────────
const SLUG = 'varzea-fc-teste';
const PREFIXO = 'teste-varzea';
const DOMINIO = '@futtymock.com';
const EMAIL_PEDRO = 'contatofuttyapp@gmail.com';
const NOME_TIME = 'Várzea FC';
const KIT = 'dark-gold';
const LOCAL_QUINTA = 'Society Madalena — campo 2';
const LOCAL_SABADO = 'Arena Várzea — campo de grama';
const LOCAL_TERCA = 'Society Madalena — campo 1';
const NOMES_TIMES = ['Time A', 'Time B', 'Time C', 'Time D'];

const PASTA_TIME_TESTE = path.resolve(__dirname, '..', '..', '..', 'TIME-TESTE');
const PASTA_FOTOS = path.join(PASTA_TIME_TESTE, 'fotos');
const LOGO_ARQUIVO = path.join(PASTA_TIME_TESTE, 'logo-varzea-512.png');
const ARQ_ESTADO = path.join(PASTA_TIME_TESTE, 'estado.json');

const BASE_KITS = `${process.env.SUPABASE_URL}/storage/v1/object/public/kits`;
const GENERICO = {
  m1: `${BASE_KITS}/avatar-generico-1.png`, m2: `${BASE_KITS}/avatar-generico-2.png`, m3: `${BASE_KITS}/avatar-generico-3.png`,
  f1: `${BASE_KITS}/avatar-generico-f-1.png`, f2: `${BASE_KITS}/avatar-generico-f-2.png`, f3: `${BASE_KITS}/avatar-generico-f-3.png`,
};

// ─── Elenco (20 jogadores fictícios) ───────────────────────────────────────
// forca = nota média que os colegas dão. gr = goleiro. cabeca = cabeça de chave.
const JOGADORES = [
  { slug: 'tonhao', apelido: 'Tonhão', nome: 'Antônio Carlos Ribeiro', pos: 'DEF', av: 'm2', forca: 3.6, nasc: '1984-02-11', admin: true },
  { slug: 'magrao', apelido: 'Magrão', nome: 'Marcelo Augusto Dias', pos: 'ATA', av: 'm1', forca: 4.1, nasc: '1990-06-03', cabeca: true, figurinha: true },
  { slug: 'canhotinha', apelido: 'Canhotinha', nome: 'Vinícius Araújo', pos: 'MEI', av: 'm3', forca: 4.3, nasc: '1996-09-21', cabeca: true, figurinha: true },
  { slug: 'fumaca', apelido: 'Fumaça', nome: 'Wellington Rocha', pos: 'ATA', av: 'm1', forca: 4.2, nasc: '1998-12-02', cabeca: true },
  { slug: 'pezao', apelido: 'Pezão', nome: 'Rodrigo Tavares', pos: 'GL', av: 'm2', forca: 3.7, nasc: '1989-04-17', gr: true },
  { slug: 'muralha', apelido: 'Muralha', nome: 'Thiago Mendes', pos: 'GL', av: 'm3', forca: 3.4, nasc: '1993-01-29', gr: true },
  { slug: 'paredao', apelido: 'Paredão', nome: 'Everton Lima', pos: 'GL', av: 'm1', forca: 3.2, nasc: '1987-08-08', gr: true },
  { slug: 'baixinho', apelido: 'Baixinho', nome: 'Luiz Fernando Prado', pos: 'MEI', av: 'm2', forca: 3.9, nasc: '1995-03-14' },
  { slug: 'xerife', apelido: 'Xerife', nome: 'Márcio Queiroz', pos: 'DEF', av: 'm3', forca: 4.0, nasc: '1986-11-30', figurinha: true },
  { slug: 'bigode', apelido: 'Bigode', nome: 'Sérgio Nunes', pos: 'DEF', av: 'm1', forca: 3.3, nasc: '1982-07-19' },
  { slug: 'alemao', apelido: 'Alemão', nome: 'Gustavo Weber', pos: 'DEF', av: 'm2', forca: 3.5, nasc: '1994-05-25' },
  { slug: 'juninho', apelido: 'Juninho', nome: 'Júlio César Moura', pos: 'ATA', av: 'm3', forca: 3.8, nasc: '2000-10-10' },
  { slug: 'gordinho', apelido: 'Gordinho', nome: 'Leandro Barbosa', pos: 'MEI', av: 'm1', forca: 3.0, nasc: '1991-02-02' },
  { slug: 'tche', apelido: 'Tchê', nome: 'Guilherme Fontoura', pos: 'MEI', av: 'm2', forca: 3.6, nasc: '1997-07-07' },
  { slug: 'cabeca', apelido: 'Cabeça', nome: 'André Luiz Pinto', pos: 'ATA', av: 'm3', forca: 3.4, nasc: '1992-09-15' },
  { slug: 'doutor', apelido: 'Doutor', nome: 'Felipe Andrade', pos: 'MEI', av: 'm1', forca: 3.7, nasc: '1988-12-24' },
  { slug: 'zezinho', apelido: 'Zezinho', nome: 'José Carlos Neto', pos: 'DEF', av: 'm2', forca: 2.9, nasc: '1999-04-04' },
  { slug: 'portugues', apelido: 'Português', nome: 'Manuel Ferreira', pos: 'MEI', av: 'm3', forca: 3.1, nasc: '1985-10-31' },
  { slug: 'rafa', apelido: 'Rafa', nome: 'Rafaela Costa', pos: 'ATA', av: 'f1', forca: 3.8, nasc: '1997-06-12' },
  { slug: 'bia', apelido: 'Bia', nome: 'Beatriz Lopes', pos: 'MEI', av: 'f2', forca: 3.5, nasc: '1999-01-20' },
];
const emailDe = (j) => `${PREFIXO}-${j.slug}${DOMINIO}`;
const porApelido = (a) => JOGADORES.find((j) => j.apelido === a);

// Figurinhas SEM IA (custo zero): PNGs já pagos noutra rodada, publicados no
// molde de _bench/repor-estado-demo.js --figurinha-de. Pessoas inventadas
// pela IA a partir da silhueta genérica — nenhuma é real.
const FIGURINHAS = [
  { apelido: 'Magrão', arquivo: path.join(__dirname, '_bench', 'saida-producao', 'prova-real-2026-09-17-dark-gold.png') },
  { apelido: 'Canhotinha', arquivo: path.join(__dirname, '_bench', 'saida-producao', 'prova-real-2026-09-22-dark-gold.png') },
  { apelido: 'Xerife', arquivo: path.join(__dirname, '_bench', 'estado-demo', 'figurinha-reposta.png') },
];

// Rotação dos 6 jogos passados: quem confirmou em cada um (12-14 por jogo,
// todo mundo chega a ≥3 — o ranking exige 3). Ver relatório da rodada para a
// conta: 5 "titulares" (cabeça-de-chave/figurinha) em todos os 6; os 3
// goleiros revezam 2 de cada vez (sempre 2 presentes); os outros 12 entram
// em janelas de 3 jogos seguidos (sempre exatamente 3 presenças).
const CONFIRMADOS_PASSADOS = [
  ['Tonhão', 'Magrão', 'Canhotinha', 'Fumaça', 'Xerife', 'Muralha', 'Paredão', 'Baixinho', 'Gordinho', 'Tchê', 'Cabeça', 'Rafa', 'Bia'],
  ['Tonhão', 'Magrão', 'Canhotinha', 'Fumaça', 'Xerife', 'Pezão', 'Paredão', 'Baixinho', 'Bigode', 'Tchê', 'Cabeça', 'Doutor', 'Bia'],
  ['Tonhão', 'Magrão', 'Canhotinha', 'Fumaça', 'Xerife', 'Pezão', 'Muralha', 'Baixinho', 'Bigode', 'Alemão', 'Cabeça', 'Doutor', 'Zezinho'],
  ['Tonhão', 'Magrão', 'Canhotinha', 'Fumaça', 'Xerife', 'Muralha', 'Paredão', 'Bigode', 'Alemão', 'Juninho', 'Doutor', 'Zezinho', 'Português'],
  ['Tonhão', 'Magrão', 'Canhotinha', 'Fumaça', 'Xerife', 'Pezão', 'Paredão', 'Alemão', 'Juninho', 'Gordinho', 'Zezinho', 'Português', 'Rafa'],
  ['Tonhão', 'Magrão', 'Canhotinha', 'Fumaça', 'Xerife', 'Pezão', 'Muralha', 'Juninho', 'Gordinho', 'Tchê', 'Português', 'Rafa', 'Bia'],
];
const PLACARES_PASSADOS = [[5, 3], [2, 2], [7, 4], [3, 1], [4, 5], [6, 2]];

// J1: 11 confirmam, 2 recusam, 7 não respondem (molde demo-completa.js:528-553).
const CONFIRMADOS_J1 = ['Tonhão', 'Magrão', 'Canhotinha', 'Fumaça', 'Pezão', 'Muralha', 'Paredão', 'Baixinho', 'Xerife', 'Bigode', 'Alemão'];
const RECUSARAM_J1 = ['Juninho', 'Gordinho'];
// J2: os 3 goleiros + 14 de linha (17 no total) + 1 convidado sem app.
const CONFIRMADOS_J2 = JOGADORES.map((j) => j.apelido).filter((a) => !['Zezinho', 'Português', 'Bia'].includes(a));
const CONVIDADOS_J2 = ['Primo do Tonhão'];
// J3: 12 exatos, 2 goleiros.
const CONFIRMADOS_J3 = ['Pezão', 'Muralha', 'Tonhão', 'Magrão', 'Canhotinha', 'Fumaça', 'Xerife', 'Bigode', 'Alemão', 'Juninho', 'Tchê', 'Doutor'];

// Fotos livres de direitos (CREDITOS-FOTOS.md) — conferidas uma a uma à mão.
const FOTOS = {
  'bola-na-rede': 'bola-na-rede.jpg',
  'campo-linhas': 'campo-linhas.jpg',
  'churrasco-carne': 'churrasco-carne.jpg',
  'chuteiras': 'chuteiras.jpg',
  'trofeu': 'trofeu.jpg',
  'arquibancada': 'arquibancada.jpg',
  'grupo-de-longe': 'grupo-de-longe.jpg',
  'campo-varzea': 'campo-varzea.jpg',
  'society-sintetico': 'society-sintetico.jpg',
  'bola-no-gramado': 'bola-no-gramado.jpg',
  'churrasco-fogo': 'churrasco-fogo.jpg',
};
// Posts da Resenha: quem escreve, o quê, com que foto (chave de FOTOS) e com
// quantos comentários/reações. Emojis permitidos (migração 036): 👍 ❤️ 😂 😮 😢 😡 🍿.
const POSTS = [
  {
    autor: 'Fumaça', horas: 5, texto: 'Golaço de fora da área na quinta, alguém filmou? 🚀', foto: 'bola-na-rede',
    reacoes: { Tonhão: '😮', Magrão: '👍', Canhotinha: '😮', Xerife: '👍', Bigode: '👍', Rafa: '🍿' },
    comentarios: [
      { de: 'Xerife', txt: 'Eu vi, foi de primeira, subiu no ângulo.' },
      { de: 'Canhotinha', txt: 'Eu tava filmando mas travou o celular bem na hora 😢' },
      { de: 'Fumaça', txt: 'Clássico, Canhotinha 😂', resp: 1 },
    ],
  },
  {
    autor: 'Bia', horas: 20, texto: 'A grama nova do campo 2 ficou top demais 🌱', foto: 'campo-linhas',
    reacoes: { Tonhão: '👍', Doutor: '❤️', Tchê: '👍', Cabeça: '👍' },
    comentarios: [
      { de: 'Doutor', txt: 'Finalmente sem buraco perto do gol.' },
      { de: 'Bia', txt: 'Agora só falta a rede nova 😂', resp: 0 },
    ],
  },
  {
    autor: 'Juninho', horas: 30, texto: 'Quem leva a bola sábado? A minha furou 😂',
    reacoes: { Alemão: '😂', Gordinho: '😂', Baixinho: '👍' },
    comentarios: [
      { de: 'Tonhão', txt: 'Eu levo, já separei.' },
      { de: 'Xerife', txt: 'Furou de novo? Essa bola já era, Juninho 😂' },
      { de: 'Juninho', txt: 'Pisei em cima sem querer, jura 🙈', resp: 1 },
      { de: 'Bigode', txt: 'Compra uma decente que dura mais.' },
      { de: 'Cabeça', txt: 'Levo uma reserva também, por garantia.' },
    ],
  },
  {
    autor: 'Português', horas: 50, texto: 'Ó pá, depois do torneio tem churrasco? Eu levo o pão de alho 🍖', foto: 'churrasco-carne',
    reacoes: { Tonhão: '👍', Doutor: '👍', Zezinho: '❤️', Rafa: '👍', Bia: '🍿' },
    comentarios: [
      { de: 'Tonhão', txt: 'Tem sim, já separei o carvão.' },
      { de: 'Doutor', txt: 'Eu levo a linguiça então.' },
      { de: 'Português', txt: 'Fechado! 🍻', resp: 0 },
    ],
  },
  {
    autor: 'Rafa', horas: 70, texto: 'Chuteira nova estreando no sábado 👟⚽', foto: 'chuteiras',
    reacoes: { Bia: '❤️', Canhotinha: '👍', Magrão: '👍', Juninho: '😮' },
    comentarios: [
      { de: 'Bia', txt: 'Linda! Estreia com gol, hein.' },
      { de: 'Rafa', txt: 'Vou tentar 😂', resp: 0 },
    ],
  },
  {
    autor: 'Doutor', horas: 150, texto: 'Três anos de pelada toda quinta. Que venham mais trinta! 🏆', foto: 'trofeu', foto2: 'arquibancada',
    reacoes: { Tonhão: '❤️', Magrão: '👍', Canhotinha: '👍', Fumaça: '❤️', Xerife: '👍', Pezão: '👍', Bia: '❤️' },
    comentarios: [
      { de: 'Tonhão', txt: 'Três anos! Começou com 8 gente, olha isso agora.' },
      { de: 'Xerife', txt: 'E olha que quase não teve quinta passada, chovia muito.' },
      { de: 'Doutor', txt: 'Chovia mas ninguém desmarcou 💪', resp: 1 },
      { de: 'Muralha', txt: 'Bons tempos vindo aí, Doutor.' },
    ],
  },
  {
    autor: 'Xerife', horas: 200, texto: 'Aviso da diretoria: chegou atrasado, começa no gol 🧤😂',
    reacoes: { Baixinho: '😂', Gordinho: '😡', Tchê: '😂', Doutor: '👍', Bigode: '😂', Alemão: '👍' },
    comentarios: [
      { de: 'Gordinho', txt: 'Injusto, o trânsito não é minha culpa 😡' },
      { de: 'Xerife', txt: 'Regra é regra, Gordinho 😂', resp: 0 },
      { de: 'Tchê', txt: 'Eu já nasci no gol então tanto faz pra mim.' },
    ],
  },
  {
    autor: 'Canhotinha', horas: 260, texto: 'Resenha pós-jogo 🍻', foto: 'grupo-de-longe',
    reacoes: { Fumaça: '❤️', Magrão: '🍿', Tonhão: '👍', Rafa: '❤️', Zezinho: '👍' },
    comentarios: [
      { de: 'Fumaça', txt: 'Foi bom demais hoje.' },
      { de: 'Canhotinha', txt: 'Semana que vem tem mais 🙌', resp: 0 },
    ],
  },
];
const ANUNCIO = {
  horas: 2, titulo: 'Mensalidade de outubro', mensagem: 'Pix de R$40 até dia 5. Quem já pagou, deixa um 👍 aqui. Valeu, rapaziada!',
  reacoes: { Magrão: '👍', Canhotinha: '👍', Fumaça: '👍', Xerife: '👍', Bigode: '👍' },
  comentarios: [
    { de: 'Baixinho', txt: 'Já paguei, pode conferir.' },
    { de: 'Juninho', txt: 'Top, mando o comprovante no grupo.' },
  ],
};

// ─── Datas (horário de Brasília, America/Sao_Paulo) ────────────────────────

/** Offset (minutos) de America/Sao_Paulo no instante `d`. */
function offsetSPMin(d) {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', timeZoneName: 'shortOffset' }).formatToParts(d);
  const tz = partes.find((p) => p.type === 'timeZoneName')?.value || 'GMT-3';
  const m = tz.match(/GMT([+-]\d+)?/);
  return (m && m[1] ? parseInt(m[1], 10) : -3) * 60;
}
/** hora local de São Paulo (ano,mes 1-12,dia,hora,minuto) → Date UTC correto. */
function horaSP(ano, mes, dia, hora, minuto = 0) {
  const aproximado = new Date(Date.UTC(ano, mes - 1, dia, hora, minuto, 0));
  const offsetMin = offsetSPMin(aproximado);
  return new Date(Date.UTC(ano, mes - 1, dia, hora, minuto, 0) - offsetMin * 60000);
}
/** {ano,mes,dia} do "hoje" em São Paulo, a partir de um instante UTC qualquer. */
function dataSP(instanteUTC) {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instanteUTC);
  const o = Object.fromEntries(partes.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return { ano: Number(o.year), mes: Number(o.month), dia: Number(o.day) };
}
function maisDias({ ano, mes, dia }, n) {
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  d.setUTCDate(d.getUTCDate() + n);
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() };
}
function diaDaSemana({ ano, mes, dia }) {
  return new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay(); // 0=dom .. 6=sáb
}
/** Primeiro dia >= base+minDias cujo dia da semana seja `alvoSemana`. */
function proximoDiaSemana(baseYMD, alvoSemana, minDias) {
  for (let n = minDias; ; n += 1) {
    const d = maisDias(baseYMD, n);
    if (diaDaSemana(d) === alvoSemana) return d;
  }
}
/**
 * J1 = próxima quinta (4) a ≥5 dias de hoje, 20h. J2 = sábado (6) seguinte a
 * J1, 9h. J3 = terça (2) seguinte a J2, 21h. rsvpPrazo = véspera de J1, 18h.
 */
function calcularDatas(agora = new Date()) {
  const hojeSP = dataSP(agora);
  const j1YMD = proximoDiaSemana(hojeSP, 4, 5);
  const j2YMD = proximoDiaSemana(j1YMD, 6, 1);
  const j3YMD = proximoDiaSemana(j2YMD, 2, 1);
  const vesperaJ1 = maisDias(j1YMD, -1);
  return {
    j1: { ymd: j1YMD, data: horaSP(j1YMD.ano, j1YMD.mes, j1YMD.dia, 20, 0) },
    j2: { ymd: j2YMD, data: horaSP(j2YMD.ano, j2YMD.mes, j2YMD.dia, 9, 0) },
    j3: { ymd: j3YMD, data: horaSP(j3YMD.ano, j3YMD.mes, j3YMD.dia, 21, 0) },
    rsvpPrazo: horaSP(vesperaJ1.ano, vesperaJ1.mes, vesperaJ1.dia, 18, 0),
  };
}
/** As 6 quintas-feiras (20h SP) anteriores a hoje, da mais antiga à mais recente. */
function seisQuintasAnteriores(agora = new Date()) {
  const hojeSP = dataSP(agora);
  const ultima = proximoDiaSemana(hojeSP, 4, -6); // primeira quinta ao voltar 6 dias — refinado abaixo
  // Acha a quinta mais recente ANTERIOR a hoje (n negativo até bater quinta).
  let n = -1;
  while (diaDaSemana(maisDias(hojeSP, n)) !== 4) n -= 1;
  const maisRecente = maisDias(hojeSP, n);
  const seis = [];
  for (let i = 5; i >= 0; i -= 1) {
    const ymd = maisDias(maisRecente, -7 * i);
    seis.push({ ymd, data: horaSP(ymd.ano, ymd.mes, ymd.dia, 20, 0) });
  }
  void ultima; // (mantido só pelo nome semântico acima; a conta real é a do while)
  return seis;
}

// ─── Sorteio (mesma forma que routes/games.js grava em times_resultado) ───
function jogadorParaSorteio(j, ids, ratings) {
  return {
    user_id: ids[j.apelido],
    nome: j.apelido,
    avatar_url: GENERICO[j.av],
    rating: round1(ratings[ids[j.apelido]] ?? RATING_DEFAULT),
    goleiro: !!j.gr,
    cabeca_chave: !!j.cabeca,
  };
}
function montarResultado(sorteio, totalJogadores, convidadosTotal = 0) {
  const times = sorteio.times.map((jogadores, i) => ({
    nome: NOMES_TIMES[i] || `Time ${i + 1}`,
    rating_medio: Math.round((jogadores.reduce((s, j) => s + j.rating, 0) / (jogadores.length || 1)) * 100) / 100,
    jogadores,
  }));
  return { num_times: sorteio.numTimes, total_jogadores: totalJogadores, convidados_total: convidadosTotal, seed: sorteio.seed, avisos: [], times, reservas: sorteio.reservas };
}
// Quem marca: atacante > meia > zagueiro, os mais fortes mais que os fracos. Goleiro não marca.
function distribuirGols(jogadores, quantos, rng) {
  const peso = { ATA: 3, MEI: 2, DEF: 1, GL: 0 };
  const pesoDe = (j) => { const p = porApelido(j.nome); return p ? peso[p.pos] * p.forca : 0; };
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

// ─── Filtros do --limpar (só o que este script criou) ──────────────────────
function eContaDoScript(email) {
  return typeof email === 'string' && email.startsWith(`${PREFIXO}-`) && email.endsWith(DOMINIO);
}
function eSlugDoScript(slug) {
  return slug === SLUG;
}

module.exports = {
  SLUG, PREFIXO, DOMINIO, JOGADORES, CONFIRMADOS_PASSADOS, PLACARES_PASSADOS,
  calcularDatas, seisQuintasAnteriores, montarResultado, distribuirGols,
  eContaDoScript, eSlugDoScript, jogadorParaSorteio,
};

// A partir daqui, tudo fala com o banco — nada disto corre com `require()`
// (só com `node scripts/time-teste.js`), para os testes (tests/time-teste.test.js)
// nunca tocarem em produção.
if (require.main === module) {
  (async () => {
    if (STATUS) await statusCmd();
    else if (REAGENDAR) await reagendarCmd();
    else if (PROMOVER) await promoverConvidadosCmd();
    else if (LIMPAR) await limparCmd();
    else await criar();
  })().catch((e) => { console.error('[time-teste] ERRO:', e.message); process.exitCode = 1; });
}

// ─── Passo 1-2: contas + time ───────────────────────────────────────────────
async function criarUsuarios() {
  const ids = {};
  for (const j of JOGADORES) {
    const email = emailDe(j);
    const password = crypto.randomBytes(16).toString('base64url');
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { nome: j.nome, onboarding_completo: true, tour_inicio_visto: true },
    });
    if (error) throw new Error(`createUser ${email}: ${error.message}`);
    ids[j.apelido] = data.user.id;
    // eslint-disable-next-line no-await-in-loop
    const { error: e2 } = await supabase.from('users').upsert({
      id: data.user.id, email, nome: j.nome, nome_jogador: j.apelido, birthdate: j.nasc,
      avatar_generico: j.av, avatar_url: GENERICO[j.av], plan: 'free',
      cor_frame: 'dourado', fundo_figurinha: 'estadio', kit_ativo: KIT,
    }, { onConflict: 'id' });
    if (e2) throw new Error(`users ${email}: ${e2.message.slice(0, 200)}`);
  }
  ok(`${JOGADORES.length} contas criadas (${PREFIXO}-*${DOMINIO})`);
  return ids;
}

async function criarTimeEMembros(ids) {
  const { data: time, error } = await supabase.from('teams').insert({
    nome: NOME_TIME, slug: SLUG, cor: 'azul', criado_por: ids.Tonhão,
    publica: false, modo_visibilidade: 'privado',
    localizacao: 'Vila Madalena, São Paulo, SP', cidade: 'São Paulo',
    geo_lat: -23.5557, geo_lng: -46.6906, mostrar_gols: true,
    descricao: 'Time de demonstração do Futty — os jogadores são fictícios. Pode confirmar presença, abrir os sorteios e comentar na Resenha à vontade.',
  }).select().single();
  if (error) throw new Error(`teams: ${error.message}`);

  const criadoHa60Dias = new Date(Date.now() - 60 * 86400000).toISOString();
  const membros = JOGADORES.map((j) => ({
    user_id: ids[j.apelido], team_id: time.id,
    role: j.admin ? 'admin' : 'member',
    categoria: j.gr ? 'GR' : 'linha', posicao: j.pos, pode_postar: true,
    created_at: criadoHa60Dias,
  }));
  const { error: e2 } = await supabase.from('team_members').insert(membros);
  if (e2) throw new Error(`team_members: ${e2.message}`);

  const { data: pedro } = await supabase.from('users').select('id').eq('email', EMAIL_PEDRO).maybeSingle();
  if (pedro) {
    const { error: e3 } = await supabase.from('team_members').insert({
      user_id: pedro.id, team_id: time.id, role: 'admin', categoria: 'linha', pode_postar: true, created_at: new Date().toISOString(),
    });
    if (e3) throw new Error(`team_members (Pedro): ${e3.message}`);
    ok(`vínculo de admin criado para ${EMAIL_PEDRO}`);
  } else {
    aviso(`conta ${EMAIL_PEDRO} não encontrada — o Pedro precisa entrar pelo convite para virar admin.`);
  }

  ok(`time "${NOME_TIME}" (${SLUG}, ${time.id}) com ${membros.length} jogadores`);
  return time;
}

async function aplicarFigurinhas(ids) {
  for (const f of FIGURINHAS) {
    const userId = ids[f.apelido];
    const pngBuf = fs.readFileSync(f.arquivo);
    const caminho = `public/${userId}-ai-${KIT}-${Date.now()}.png`;
    // eslint-disable-next-line no-await-in-loop
    const { error: eUp } = await supabase.storage.from('avatars').upload(caminho, pngBuf, { contentType: 'image/png', upsert: false, cacheControl: '3600' });
    if (eUp) throw new Error(`figurinha (${f.apelido}): ${eUp.message}`);
    const { data: pub } = supabase.storage.from('avatars').getPublicUrl(caminho);
    const avatarUrl = `${pub.publicUrl}?v=${Date.now()}`;
    // eslint-disable-next-line no-await-in-loop
    const { error: eSlot } = await supabase.from('user_avatar_slots').upsert({ user_id: userId, kit_id: KIT, avatar_url: avatarUrl }, { onConflict: 'user_id,kit_id' });
    if (eSlot) throw new Error(`user_avatar_slots (${f.apelido}): ${eSlot.message}`);
    // eslint-disable-next-line no-await-in-loop
    const { error: eUser } = await supabase.from('users').update({ avatar_url: avatarUrl, kit_ativo: KIT }).eq('id', userId);
    if (eUser) throw new Error(`users avatar (${f.apelido}): ${eUser.message}`);
  }
  ok(`${FIGURINHAS.length} figurinhas publicadas sem IA (US$0,00): ${FIGURINHAS.map((f) => f.apelido).join(', ')}`);
}

async function criarVotos(teamId, ids) {
  const rng = mulberry32(20260928);
  const agora = new Date().toISOString();
  const votos = [];
  for (const de of JOGADORES) {
    for (const para of JOGADORES) {
      if (de === para) continue;
      const nota = nota05(para.forca + (rng() - 0.5) * 1.0);
      votos.push({ de_user_id: ids[de.apelido], para_user_id: ids[para.apelido], team_id: teamId, nota, game_id: null, created_at: agora, updated_at: agora });
    }
  }
  const { error } = await supabase.from('votes').insert(votos);
  if (error) throw new Error(`votes: ${error.message}`);
  ok(`${votos.length} votos`);
}

// ─── Passo 7: fotos livres de direitos → bucket resenha ────────────────────
async function comprimirImagem(buffer) {
  return sharp(buffer).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
}
async function subirFotos() {
  const urls = {};
  for (const [chave, arquivo] of Object.entries(FOTOS)) {
    const caminhoLocal = path.join(PASTA_FOTOS, arquivo);
    if (!fs.existsSync(caminhoLocal)) throw new Error(`foto ausente: ${caminhoLocal} (ver CREDITOS-FOTOS.md)`);
    const original = fs.readFileSync(caminhoLocal);
    // eslint-disable-next-line no-await-in-loop
    const comprimida = await comprimirImagem(original);
    // eslint-disable-next-line no-await-in-loop
    const classe = await classificar(comprimida).catch(() => null);
    if (classe && classe.explicito > 0.75) { aviso(`foto ${arquivo} pulada (NSFW)`); continue; }
    const nomeStorage = `${crypto.randomUUID()}.webp`;
    // eslint-disable-next-line no-await-in-loop
    const { error } = await supabase.storage.from('resenha').upload(nomeStorage, comprimida, { contentType: 'image/webp', upsert: false });
    if (error) throw new Error(`storage resenha (${arquivo}): ${error.message}`);
    const { data: pub } = supabase.storage.from('resenha').getPublicUrl(nomeStorage);
    urls[chave] = { url: pub.publicUrl, bytes: comprimida.length };
  }
  ok(`${Object.keys(urls).length} fotos livres de direitos publicadas no bucket resenha`);
  return urls;
}

// ─── Passo 5: 6 jogos passados ──────────────────────────────────────────────
async function criarJogosPassados(teamId, ids, fotosUrl) {
  const ratings = await computeRatings(teamId, JOGADORES.map((j) => ids[j.apelido]));
  const rngGols = mulberry32(9000);
  const datas = seisQuintasAnteriores();
  const poolFotos = ['trofeu', 'arquibancada', 'grupo-de-longe', 'campo-varzea', 'bola-no-gramado'].filter((k) => fotosUrl[k]);

  for (const [i, confirmados] of CONFIRMADOS_PASSADOS.entries()) {
    if (confirmados.length < 12 || confirmados.length > 14) throw new Error(`jogo passado ${i}: ${confirmados.length} confirmados (esperado 12-14)`);
    const todos = confirmados.map((a) => jogadorParaSorteio(porApelido(a), ids, ratings));
    // eslint-disable-next-line no-await-in-loop
    const sorteio = executarSorteio(todos, 6, { seed: 5000 + i });
    if (sorteio.numTimes !== 2) throw new Error(`jogo passado ${i}: deu ${sorteio.numTimes} times, era para dar 2`);
    const resultado = montarResultado(sorteio, confirmados.length, 0);

    const [pa, pb] = PLACARES_PASSADOS[i];
    const golsA = distribuirGols(resultado.times[0].jogadores, pa, rngGols);
    const golsB = distribuirGols(resultado.times[1].jogadores, pb, rngGols);
    const todosGols = { ...golsA, ...golsB };
    const [artilheiroId, artilheiroGols] = Object.entries(todosGols).sort((a, b) => b[1] - a[1])[0] || [null, 0];
    const vencedor = pa > pb ? 'A' : pb > pa ? 'B' : 'empate';
    const campeaoIdx = vencedor === 'A' ? 0 : vencedor === 'B' ? 1 : null;
    const destaqueId = artilheiroId || resultado.times[0].jogadores[0].user_id;
    const dataJogo = datas[i].data;

    // eslint-disable-next-line no-await-in-loop
    const { data: game, error } = await supabase.from('games').insert({
      team_id: teamId, data: dataJogo.toISOString(), local: LOCAL_QUINTA,
      jogadores_por_time: 6, num_times: resultado.num_times, status: 'terminado',
      sorteio_realizado: true, times_resultado: resultado, resultado_nivel: 3,
      time_vencedor: vencedor, placar_a: pa, placar_b: pb,
      artilheiro_user_id: artilheiroId, artilheiro_gols: artilheiroGols,
      destaque_user_id: destaqueId, destaque_titulo: 'Craque da pelada',
      campeao_time_index: campeaoIdx,
      campeao_foto_url: poolFotos.length ? fotosUrl[poolFotos[i % poolFotos.length]].url : null,
      created_at: new Date(dataJogo.getTime() - 5 * 86400000).toISOString(),
    }).select().single();
    if (error) throw new Error(`games (passado ${i}): ${error.message}`);

    const presentes = confirmados.map((a) => {
      const j = porApelido(a);
      return { game_id: game.id, user_id: ids[a], confirmado: true, goleiro: !!j.gr, cabeca_chave: !!j.cabeca };
    });
    // eslint-disable-next-line no-await-in-loop
    const { error: e2 } = await supabase.from('game_players').insert(presentes);
    if (e2) throw new Error(`game_players (passado ${i}): ${e2.message}`);

    const timeDe = {};
    resultado.times[0].jogadores.forEach((j) => { timeDe[j.user_id] = 'A'; });
    resultado.times[1].jogadores.forEach((j) => { timeDe[j.user_id] = 'B'; });
    const linhasGols = Object.entries(todosGols).map(([user_id, gols]) => ({ game_id: game.id, user_id, gols, time: timeDe[user_id] || 'A' }));
    if (linhasGols.length) {
      // eslint-disable-next-line no-await-in-loop
      const { error: e3 } = await supabase.from('gols_jogadores').insert(linhasGols);
      if (e3) throw new Error(`gols_jogadores (passado ${i}): ${e3.message}`);
    }
  }
  ok(`${CONFIRMADOS_PASSADOS.length} jogos passados (placares ${PLACARES_PASSADOS.map((p) => p.join('x')).join(', ')})`);
}

// ─── Passo 6: J1, J2, J3 ─────────────────────────────────────────────────
async function criarProximosJogos(teamId, ids) {
  const datas = calcularDatas();

  // J1 — jogo para confirmar presença.
  const { data: j1, error: e1 } = await supabase.from('games').insert({
    team_id: teamId, data: datas.j1.data.toISOString(), local: LOCAL_QUINTA,
    jogadores_por_time: 6, max_jogadores: 18, status: 'agendado',
    sorteio_realizado: false, rsvp_aberto: true, rsvp_fechado: false,
    rsvp_prazo: datas.rsvpPrazo.toISOString(),
  }).select().single();
  if (e1) throw new Error(`games (J1): ${e1.message}`);
  const linhasJ1 = CONFIRMADOS_J1.map((a) => {
    const j = porApelido(a);
    return { game_id: j1.id, user_id: ids[a], confirmado: true, goleiro: !!j.gr, cabeca_chave: !!j.cabeca };
  }).concat(RECUSARAM_J1.map((a) => ({ game_id: j1.id, user_id: ids[a], confirmado: false, goleiro: false, cabeca_chave: false })));
  const { error: e1b } = await supabase.from('game_players').insert(linhasJ1);
  if (e1b) throw new Error(`game_players (J1): ${e1b.message}`);
  const rsvpJ1 = CONFIRMADOS_J1.map((a) => ({ game_id: j1.id, user_id: ids[a], status: 'confirmado' }))
    .concat(RECUSARAM_J1.map((a) => ({ game_id: j1.id, user_id: ids[a], status: 'recusado' })));
  const { error: e1c } = await supabase.from('rsvp_respostas').insert(rsvpJ1);
  if (e1c) throw new Error(`rsvp_respostas (J1): ${e1c.message}`);
  ok(`J1 (${datas.j1.data.toISOString()}): ${CONFIRMADOS_J1.length} confirmados, ${RECUSARAM_J1.length} recusaram, RSVP aberto até ${datas.rsvpPrazo.toISOString()}`);

  // J2 — 3 times com reservas + 1 convidado sem app.
  const ratings = await computeRatings(teamId, JOGADORES.map((j) => ids[j.apelido]));
  const jogadoresJ2 = CONFIRMADOS_J2.map((a) => jogadorParaSorteio(porApelido(a), ids, ratings));
  const sorteioJ2 = executarSorteio(jogadoresJ2, 5, { seed: 3303, convidados: CONVIDADOS_J2 });
  if (sorteioJ2.numTimes !== 3 || sorteioJ2.reservas.length !== 3) {
    throw new Error(`J2: deu ${sorteioJ2.numTimes} times e ${sorteioJ2.reservas.length} reservas (esperado 3 times + 3 reservas)`);
  }
  const resultadoJ2 = montarResultado(sorteioJ2, CONFIRMADOS_J2.length, CONVIDADOS_J2.length);
  const { data: j2, error: e2 } = await supabase.from('games').insert({
    team_id: teamId, data: datas.j2.data.toISOString(), local: LOCAL_SABADO,
    jogadores_por_time: 5, max_jogadores: 20, num_times: sorteioJ2.numTimes,
    status: 'agendado', sorteio_realizado: true, times_resultado: resultadoJ2,
  }).select().single();
  if (e2) throw new Error(`games (J2): ${e2.message}`);
  const linhasJ2 = CONFIRMADOS_J2.map((a) => {
    const j = porApelido(a);
    return { game_id: j2.id, user_id: ids[a], confirmado: true, goleiro: !!j.gr, cabeca_chave: !!j.cabeca };
  });
  const { error: e2b } = await supabase.from('game_players').insert(linhasJ2);
  if (e2b) throw new Error(`game_players (J2): ${e2b.message}`);
  ok(`J2 (${datas.j2.data.toISOString()}): ${sorteioJ2.numTimes} times de 5 + ${sorteioJ2.reservas.length} reservas + 1 convidado`);

  // J3 — 2 times sem reserva.
  const jogadoresJ3 = CONFIRMADOS_J3.map((a) => jogadorParaSorteio(porApelido(a), ids, ratings));
  const sorteioJ3 = executarSorteio(jogadoresJ3, 6, { seed: 2202 });
  if (sorteioJ3.numTimes !== 2 || sorteioJ3.reservas.length !== 0) {
    throw new Error(`J3: deu ${sorteioJ3.numTimes} times e ${sorteioJ3.reservas.length} reservas (esperado 2 times + 0 reservas)`);
  }
  const resultadoJ3 = montarResultado(sorteioJ3, CONFIRMADOS_J3.length, 0);
  const { data: j3, error: e3 } = await supabase.from('games').insert({
    team_id: teamId, data: datas.j3.data.toISOString(), local: LOCAL_TERCA,
    jogadores_por_time: 6, num_times: sorteioJ3.numTimes, status: 'agendado',
    sorteio_realizado: true, times_resultado: resultadoJ3,
  }).select().single();
  if (e3) throw new Error(`games (J3): ${e3.message}`);
  const linhasJ3 = CONFIRMADOS_J3.map((a) => {
    const j = porApelido(a);
    return { game_id: j3.id, user_id: ids[a], confirmado: true, goleiro: !!j.gr, cabeca_chave: !!j.cabeca };
  });
  const { error: e3b } = await supabase.from('game_players').insert(linhasJ3);
  if (e3b) throw new Error(`game_players (J3): ${e3b.message}`);
  ok(`J3 (${datas.j3.data.toISOString()}): ${sorteioJ3.numTimes} times de 6, sem reservas`);

  return { j1, j2, j3, datas };
}

// ─── Passo 8: Resenha ────────────────────────────────────────────────────
async function criarResenha(teamId, ids, fotosUrl) {
  const dias = (horas) => new Date(Date.now() - horas * 3600000).toISOString();

  for (const p of POSTS) {
    const criadoEm = dias(p.horas);
    // eslint-disable-next-line no-await-in-loop
    const { data: post, error } = await supabase.from('feed_posts').insert({
      team_id: teamId, author_id: ids[p.autor], body: p.texto, tipo: 'post', created_at: criadoEm, updated_at: criadoEm,
    }).select().single();
    if (error) throw new Error(`feed_posts (${p.autor}): ${error.message}`);

    const fotosDoPost = [p.foto, p.foto2].filter(Boolean);
    for (const [pos, chave] of fotosDoPost.entries()) {
      const f = fotosUrl[chave];
      if (!f) continue;
      // eslint-disable-next-line no-await-in-loop
      const { error: eM } = await supabase.from('feed_post_media').insert({ post_id: post.id, url: f.url, media_type: 'image', position: pos, bytes: f.bytes });
      if (eM) throw new Error(`feed_post_media (${p.autor}): ${eM.message}`);
    }

    const reacoes = Object.entries(p.reacoes || {}).map(([a, emoji]) => ({ target_type: 'post', target_id: post.id, user_id: ids[a], emoji }));
    if (reacoes.length) {
      // eslint-disable-next-line no-await-in-loop
      const { error: eR } = await supabase.from('reacoes').insert(reacoes);
      if (eR) throw new Error(`reacoes (${p.autor}): ${eR.message}`);
    }

    const criados = [];
    for (const [k, c] of (p.comentarios || []).entries()) {
      const quando = new Date(new Date(criadoEm).getTime() + (k + 1) * 23 * 60000).toISOString();
      // eslint-disable-next-line no-await-in-loop
      const { data: com, error: eC } = await supabase.from('comentarios').insert({
        parent_type: 'post', parent_id: post.id, author_id: ids[c.de], body: c.txt,
        reply_to: c.resp != null && criados[c.resp] ? criados[c.resp].id : null,
        created_at: quando, updated_at: quando,
      }).select().single();
      if (eC) throw new Error(`comentarios (${p.autor}): ${eC.message}`);
      criados.push(com);
    }
  }

  const quandoAnuncio = dias(ANUNCIO.horas);
  const { data: anuncio, error: eA } = await supabase.from('feed_posts').insert({
    team_id: teamId, author_id: ids.Tonhão, tipo: 'anuncio', body: ANUNCIO.mensagem,
    conteudo: { titulo: ANUNCIO.titulo, mensagem: ANUNCIO.mensagem },
    created_at: quandoAnuncio, updated_at: quandoAnuncio,
  }).select().single();
  if (eA) throw new Error(`feed_posts (anúncio): ${eA.message}`);
  const reacoesAnuncio = Object.entries(ANUNCIO.reacoes || {}).map(([a, emoji]) => ({ target_type: 'post', target_id: anuncio.id, user_id: ids[a], emoji }));
  if (reacoesAnuncio.length) {
    const { error: eRA } = await supabase.from('reacoes').insert(reacoesAnuncio);
    if (eRA) throw new Error(`reacoes (anúncio): ${eRA.message}`);
  }
  const criadosAnuncio = [];
  for (const [k, c] of (ANUNCIO.comentarios || []).entries()) {
    const quando = new Date(new Date(quandoAnuncio).getTime() + (k + 1) * 23 * 60000).toISOString();
    // eslint-disable-next-line no-await-in-loop
    const { data: com, error: eC } = await supabase.from('comentarios').insert({
      parent_type: 'post', parent_id: anuncio.id, author_id: ids[c.de], body: c.txt, created_at: quando, updated_at: quando,
    }).select().single();
    if (eC) throw new Error(`comentarios (anúncio): ${eC.message}`);
    criadosAnuncio.push(com);
  }

  ok(`${POSTS.length} posts + 1 anúncio na Resenha, com fotos, comentários e reações`);
}

async function criarConvite(teamId, criadoPorId) {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
  const { error } = await supabase.from('convites').insert({ team_id: teamId, token, criado_por: criadoPorId, expires_at: expiresAt });
  if (error) throw new Error(`convites: ${error.message}`);
  const link = `https://futtyapp.com.br/convite/${token}`;
  ok(`convite criado: ${link} (expira ${expiresAt})`);
  return { token, link, expiresAt };
}

function gravarEstado(estado) {
  fs.mkdirSync(PASTA_TIME_TESTE, { recursive: true });
  fs.writeFileSync(ARQ_ESTADO, JSON.stringify(estado, null, 2), 'utf8');
  ok(`estado gravado em ${ARQ_ESTADO}`);
}

// ─── Verificação final (lendo do banco) ────────────────────────────────────
async function verificarTudo(teamId) {
  const linhas = [];
  const { data: contas } = await supabase.from('users').select('id, email').ilike('email', `${PREFIXO}-%${DOMINIO}`);
  linhas.push(`contas fictícias: ${contas?.length ?? 0} (esperado 20)`);

  const { data: membros } = await supabase.from('team_members').select('user_id, users(email)').eq('team_id', teamId);
  const pedroMembro = (membros || []).some((m) => m.users?.email === EMAIL_PEDRO);
  linhas.push(`vínculo do Pedro: ${pedroMembro ? 'OK' : 'AUSENTE'}`);

  const { data: games } = await supabase.from('games').select('id, data, status, sorteio_realizado, rsvp_aberto, times_resultado').eq('team_id', teamId).order('data', { ascending: true });
  const passados = (games || []).filter((g) => g.status === 'terminado');
  const futuros = (games || []).filter((g) => g.status !== 'terminado').sort((a, b) => new Date(a.data) - new Date(b.data));
  linhas.push(`jogos: ${games?.length ?? 0} (esperado 9 = 6 passados + 3 futuros); passados=${passados.length}`);
  const j1 = futuros[0];
  linhas.push(`J1 (futuro mais próximo) tem rsvp_aberto: ${j1?.rsvp_aberto ? 'OK' : 'FALTOU'}`);
  const comSorteio = futuros.filter((g) => g.sorteio_realizado);
  const tr3 = comSorteio.find((g) => g.times_resultado?.num_times === 3);
  const tr2 = comSorteio.find((g) => g.times_resultado?.num_times === 2);
  linhas.push(`J2 (3 times): ${tr3 ? `OK (${tr3.times_resultado.reservas.length} reservas, ${tr3.times_resultado.convidados_total} convidado)` : 'FALTOU'}`);
  linhas.push(`J3 (2 times): ${tr2 ? `OK (${tr2.times_resultado.reservas.length} reservas)` : 'FALTOU'}`);
  const seedsNaoInteiros = (games || []).filter((g) => g.times_resultado && !Number.isInteger(g.times_resultado.seed));
  linhas.push(`seeds não-inteiros: ${seedsNaoInteiros.length} (esperado 0)`);

  const { data: posts } = await supabase.from('feed_posts').select('id').eq('team_id', teamId);
  const postIds = (posts || []).map((p) => p.id);
  const { data: midias } = postIds.length ? await supabase.from('feed_post_media').select('id').in('post_id', postIds) : { data: [] };
  const { data: comentarios } = postIds.length ? await supabase.from('comentarios').select('id').eq('parent_type', 'post').in('parent_id', postIds) : { data: [] };
  const { data: reacoes } = postIds.length ? await supabase.from('reacoes').select('id').eq('target_type', 'post').in('target_id', postIds) : { data: [] };
  linhas.push(`Resenha: ${posts?.length ?? 0} posts, ${midias?.length ?? 0} mídias, ${comentarios?.length ?? 0} comentários, ${reacoes?.length ?? 0} reações`);

  const { data: time } = await supabase.from('teams').select('logo_url').eq('id', teamId).maybeSingle();
  linhas.push(`logo_url: ${time?.logo_url ? 'preenchido' : 'AUSENTE'}`);

  const { data: gp } = await supabase.from('game_players').select('user_id').eq('confirmado', true).in('game_id', (games || []).map((g) => g.id));
  const porJogador = {};
  (gp || []).forEach((r) => { porJogador[r.user_id] = (porJogador[r.user_id] || 0) + 1; });
  const comTresOuMais = Object.values(porJogador).filter((n) => n >= 3).length;
  linhas.push(`ranking: ${comTresOuMais} jogador(es) com ≥3 jogos confirmados (de ${Object.keys(porJogador).length})`);

  console.log('\n── Verificação ──');
  linhas.forEach((l) => console.log('·', l));
  console.log('─────────────────\n');
}

// ─── Fluxo CRIAR ────────────────────────────────────────────────────────────
async function criar() {
  const { data: existente } = await supabase.from('teams').select('id').eq('slug', SLUG).maybeSingle();
  if (existente) throw new Error(`o time ${SLUG} já existe (id ${existente.id}) — rode --limpar --sim antes de criar de novo.`);

  const ids = await criarUsuarios();
  const time = await criarTimeEMembros(ids);
  await subirLogoTime({ slug: SLUG, arquivo: LOGO_ARQUIVO });
  await aplicarFigurinhas(ids);
  await criarVotos(time.id, ids);
  const fotosUrl = await subirFotos();
  await criarJogosPassados(time.id, ids, fotosUrl);
  const { j1, j2, j3 } = await criarProximosJogos(time.id, ids);
  await criarResenha(time.id, ids, fotosUrl);
  const convite = await criarConvite(time.id, ids.Tonhão);
  gravarEstado({
    teamId: time.id, slug: SLUG, conviteLink: convite.link, conviteExpira: convite.expiresAt,
    jogos: { j1: j1.id, j2: j2.id, j3: j3.id }, criadoEm: new Date().toISOString(),
  });
  await verificarTudo(time.id);
  ok(`Pronto — Várzea FC criado. Convite: ${convite.link}`);
}

// ─── --status ───────────────────────────────────────────────────────────────
async function statusCmd() {
  if (!fs.existsSync(ARQ_ESTADO)) throw new Error(`${ARQ_ESTADO} não existe — rode sem opções para criar o time primeiro.`);
  const estado = JSON.parse(fs.readFileSync(ARQ_ESTADO, 'utf8'));
  const { data: games } = await supabase.from('games').select('id, data, status, sorteio_realizado').eq('team_id', estado.teamId).order('data', { ascending: true });
  const { data: posts } = await supabase.from('feed_posts').select('id').eq('team_id', estado.teamId);
  info(`convite: ${estado.conviteLink} (expira ${estado.conviteExpira})`);
  for (const chave of ['j1', 'j2', 'j3']) {
    const g = (games || []).find((x) => x.id === estado.jogos[chave]);
    info(`${chave}: ${g ? `${g.data} · ${g.status}${g.sorteio_realizado ? ' · sorteado' : ''}` : 'não encontrado'}`);
  }
  info(`jogos no total: ${games?.length ?? 0} · posts na Resenha: ${posts?.length ?? 0}`);
}

// ─── --reagendar ────────────────────────────────────────────────────────────
async function reagendarCmd() {
  if (!fs.existsSync(ARQ_ESTADO)) throw new Error(`${ARQ_ESTADO} não existe — rode sem opções para criar o time primeiro.`);
  const estado = JSON.parse(fs.readFileSync(ARQ_ESTADO, 'utf8'));
  const datas = calcularDatas();

  const { error: e1 } = await supabase.from('games').update({ data: datas.j1.data.toISOString(), rsvp_prazo: datas.rsvpPrazo.toISOString() }).eq('id', estado.jogos.j1);
  if (e1) throw new Error(`reagendar J1: ${e1.message}`);
  const { error: e2 } = await supabase.from('games').update({ data: datas.j2.data.toISOString() }).eq('id', estado.jogos.j2);
  if (e2) throw new Error(`reagendar J2: ${e2.message}`);
  const { error: e3 } = await supabase.from('games').update({ data: datas.j3.data.toISOString() }).eq('id', estado.jogos.j3);
  if (e3) throw new Error(`reagendar J3: ${e3.message}`);
  ok(`datas recalculadas — J1 ${datas.j1.data.toISOString()}, J2 ${datas.j2.data.toISOString()}, J3 ${datas.j3.data.toISOString()}`);

  const diasParaVencer = (new Date(estado.conviteExpira).getTime() - Date.now()) / 86400000;
  if (diasParaVencer < 7) {
    const convite = await criarConvite(estado.teamId, null);
    estado.conviteLink = convite.link;
    estado.conviteExpira = convite.expiresAt;
    aviso(`convite antigo vencia em <7 dias — novo convite: ${convite.link}`);
  }
  fs.writeFileSync(ARQ_ESTADO, JSON.stringify(estado, null, 2), 'utf8');
}

// ─── --promover-convidados ─────────────────────────────────────────────────
async function promoverConvidadosCmd() {
  const { data: time } = await supabase.from('teams').select('id').eq('slug', SLUG).maybeSingle();
  if (!time) throw new Error(`time ${SLUG} não existe.`);
  const { data: membros } = await supabase.from('team_members').select('user_id, role, users(email)').eq('team_id', time.id);
  const alvos = (membros || []).filter((m) => m.role !== 'admin' && m.users?.email && !m.users.email.endsWith(DOMINIO));
  for (const m of alvos) {
    // eslint-disable-next-line no-await-in-loop
    await supabase.from('team_members').update({ role: 'admin' }).eq('team_id', time.id).eq('user_id', m.user_id);
    ok(`promovido a admin: ${m.users.email}`);
  }
  if (!alvos.length) info('nenhum convidado (fora de @futtymock.com) para promover.');
}

// ─── --limpar / --limpar --sim ──────────────────────────────────────────────
async function limparCmd() {
  const { data: time } = await supabase.from('teams').select('id, slug').eq('slug', SLUG).maybeSingle();
  const { data: rows } = await supabase.from('users').select('id, email').ilike('email', `${PREFIXO}-%${DOMINIO}`);
  const contas = (rows || []).filter((u) => eContaDoScript(u.email));

  if (!CONFIRMA_LIMPAR) {
    info(`(simulação) apagaria o time "${time?.slug ?? '(inexistente)'}" e ${contas.length} conta(s) ${PREFIXO}-*${DOMINIO}.`);
    info('rode com --limpar --sim para apagar de verdade.');
    return;
  }

  if (time) {
    const { data: posts } = await supabase.from('feed_posts').select('id').eq('team_id', time.id);
    const postIds = (posts || []).map((p) => p.id);
    if (postIds.length) {
      const { data: media } = await supabase.from('feed_post_media').select('url').in('post_id', postIds);
      const urls = (media || []).map((m) => m.url).filter(Boolean);
      if (urls.length) {
        const r = await removerFicheirosPorUrl('resenha', urls);
        info(`${r.removidos} arquivo(s) da Resenha removido(s) do Storage`);
      }
    }
    const { data: games } = await supabase.from('games').select('campeao_foto_url').eq('team_id', time.id);
    const fotosCampeao = (games || []).map((g) => g.campeao_foto_url).filter(Boolean);
    if (fotosCampeao.length) {
      const r = await removerFicheirosPorUrl('resenha', fotosCampeao);
      info(`${r.removidos} foto(s) de campeão removida(s) do Storage`);
    }
    await supabase.storage.from('avatars').remove([`logos/${time.id}.webp`]).catch(() => {});
    const { error: eDel } = await supabase.from('teams').delete().eq('id', time.id);
    if (eDel) throw new Error(`apagar time: ${eDel.message}`);
    info(`time ${SLUG} apagado (jogos, posts e tudo em cascata)`);
  }

  for (const c of contas) {
    // eslint-disable-next-line no-await-in-loop
    await apagarUsuario(c.id);
    info(`${c.email} apagado`);
  }

  if (fs.existsSync(ARQ_ESTADO)) fs.unlinkSync(ARQ_ESTADO);
  ok(`limpeza concluída: ${contas.length} conta(s) e o time (se existia) apagados.`);
}
