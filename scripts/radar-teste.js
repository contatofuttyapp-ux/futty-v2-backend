// Futty — Peladas de teste para o "Radar de peladas" em Brasília (RADAR-TESTE.md, 4-out-2026).
//
// Seis peladas fictícias (Candangolândia, Núcleo Bandeirante, Guará, Riacho Fundo, Park Way, Cruzeiro) para o Pedro
// buscar e achar no Radar. Fala DIRETO com o Supabase (service role, utils/db) — nunca chama o Cloud Run nem a fal, e não
// gera figurinha: avatar genérico (m1–m3, f1–f3). Molde: scripts/time-teste.js (o Várzea FC), que não é alterado.
//
//   node scripts/radar-teste.js                    cria as seis peladas (aborta se algum slug radar-teste-* já existir)
//   node scripts/radar-teste.js --status           as seis: entrada, membros, próximo jogo e pedidos de entrada pendentes
//   node scripts/radar-teste.js --aprovar-pedidos  aprova os pedidos pendentes SÓ dos times radar-teste-* (o admin fictício aceitando)
//   node scripts/radar-teste.js --limpar           só MOSTRA o que apagaria
//   node scripts/radar-teste.js --limpar --sim     apaga de verdade
//
// Regras de segurança (RADAR-TESTE.md): escreve só em times de slug radar-teste-* e em contas
// teste-radar-<time>-<n>@futtymock.com. NUNCA toca no Várzea FC, no Missa de Quinta, no time e na conta do revisor da Apple
// (domingueira-fc-demo, demo-loja@futtymock.com) nem em contatofuttyapp@gmail.com. Correr a partir de backend/.
// Nada aqui corre com `require()`: o banco só é carregado dentro dos comandos, para tests/radar-teste.test.js nunca
// tocar em produção (o banco é ÚNICO e partilhado entre dev e produção).
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mulberry32 } = require('../utils/sorteio');
const { resolverCidade, resolverBairro } = require('../utils/cidade');
const { FUSO_PADRAO, instanteNoFuso, partesNoFuso } = require('../utils/fuso');

const PREFIXO_SLUG = 'radar-teste-';
const PREFIXO_CONTA = 'teste-radar';
const DOMINIO = '@futtymock.com';
const DESCRICAO = 'Pelada de demonstração do Futty, para testar o Radar de peladas. Os jogadores são fictícios.';
const UM_DIA_MS = 24 * 3600 * 1000;

const PASTA_TIME_TESTE = path.resolve(__dirname, '..', '..', '..', 'TIME-TESTE');
const ARQ_ESTADO = path.join(PASTA_TIME_TESTE, 'radar-estado.json');

// A linha de Brasília exatamente como a lista do app a manda (frontend/public/dados/cidades.json) quando a pessoa escolhe
// "Brasília, DF": é ela que o motor recebe em POST /api/teams, e resolverCidade a transforma no que grava.
const BRASILIA = { cidade: 'Brasília', uf: 'DF', pais: 'BR', lat: -15.78, lng: -47.93, origem: 'lista' };

// O Distrito Federal, com folga: lat entre −15,50 e −16,05; lng entre −47,30 e −48,30.
const LIMITES_DF = { latMin: -16.05, latMax: -15.50, lngMin: -48.30, lngMax: -47.30 };
const dentroDoDF = (lat, lng) => lat > LIMITES_DF.latMin && lat < LIMITES_DF.latMax && lng > LIMITES_DF.lngMin && lng < LIMITES_DF.lngMax;

// ─── As seis peladas ───────────────────────────────────────────────────────────────────────────────────────────────────
// dia: 0 = domingo … 6 = sábado. Elenco: [apelido, nome, posição, 'f' se for mulher]; o primeiro é o admin.
// Escudo: cor principal + segunda cor + padrão (chaves da migração 077); premios: o que o time mostra (mostrar_gols,
// mostrar_artilheiro, mostrar_destaque) — o Candanga com tudo ligado, o Guará com tudo desligado. jogo: jogadores por
// time, teto de jogadores e quantos confirmaram presença (4 a 9).
const TIMES = [
  {
    slug: 'radar-teste-candanga', nome: 'Racha da Candanga', regiao: 'Candangolândia', lat: -15.851, lng: -47.951,
    dia: 4, hora: '20:00', modo: 'publico_aberto',
    escudo: { cor: 'gramado', cor2: 'ouro', padrao: 'faixa' }, premios: { gols: true, artilheiro: true, destaque: true },
    jogo: { porTime: 6, max: 12, confirmados: 7 },
    elenco: [
      ['Candango', 'Antônio Cândido Moreira', 'DEF'], ['Zé do Cerrado', 'José Raimundo Alves', 'MEI'],
      ['Baiano', 'Reginaldo Santos Pereira', 'ATA'], ['Mineirinho', 'Wanderley Souza Castro', 'MEI'],
      ['Goiano', 'Edmar Teixeira Lopes', 'DEF'], ['Pelézinho', 'Cláudio Roberto Faria', 'ATA'],
      ['Paredão', 'Genival Batista Rocha', 'GL'], ['Caveira', 'Ronaldo Nascimento Cruz', 'DEF'],
      ['Nenê', 'Marcos Vinícius Duarte', 'MEI'], ['Tatá', 'Tatiane Oliveira Gomes', 'MEI', 'f'],
      ['Fininho', 'Davi Lucas Barros', 'ATA'], ['Cabeção', 'Iuri Ferreira Matos', 'DEF'],
    ],
  },
  {
    slug: 'radar-teste-bandeirante', nome: 'Pelada do Bandeirante', regiao: 'Núcleo Bandeirante', lat: -15.871, lng: -47.968,
    dia: 2, hora: '21:00', modo: 'publico_aprovacao',
    escudo: { cor: 'azul', cor2: 'ouro', padrao: 'metade' }, premios: { gols: true, artilheiro: false, destaque: true },
    jogo: { porTime: 5, max: 15, confirmados: 9 },
    elenco: [
      ['Sargento', 'Hélio Gonçalves Lima', 'DEF'], ['Tião Maluco', 'Sebastião Alves Cardoso', 'ATA'],
      ['Rapadura', 'Francisco Aírton Nogueira', 'MEI'], ['Maranhão', 'Josué Pinheiro Sales', 'DEF'],
      ['Tubarão', 'Leonardo Brandão Reis', 'ATA'], ['Cebola', 'Wesley Andrade Pires', 'MEI'],
      ['Muralha', 'Cleiton Barros Santana', 'GL'], ['Pantera', 'Adriano Medeiros Lins', 'GL'],
      ['Mosca', 'Rômulo Vieira Azevedo', 'MEI'], ['Gaúcho', 'Tiago Schneider Prado', 'DEF'],
      ['Jana', 'Janaína Ribeiro Costa', 'ATA', 'f'], ['Pintado', 'Elias Moura Couto', 'DEF'],
      ['Beiçola', 'Adilson Franco Dias', 'MEI'], ['Zagueirão', 'Maurício Tavares Neto', 'DEF'],
      ['Kaká do Bairro', 'Kaique Henrique Lima', 'ATA'],
    ],
  },
  {
    slug: 'radar-teste-guara', nome: 'Racha do Guará', regiao: 'Guará', lat: -15.820, lng: -47.979,
    dia: 6, hora: '09:00', modo: 'publico_aberto',
    escudo: { cor: 'vermelho', cor2: 'preto', padrao: 'listras' }, premios: { gols: false, artilheiro: false, destaque: false },
    jogo: { porTime: 6, max: 18, confirmados: 8 },
    elenco: [
      ['Professor', 'Aluísio Mendes Carvalho', 'MEI'], ['Foguete', 'Jhonatan Silva Maia', 'ATA'],
      ['Lagartixa', 'Bruno Cesar Falcão', 'ATA'], ['Careca', 'Osvaldo Pimentel Rios', 'DEF'],
      ['Pirulito', 'Everton Dias Sampaio', 'MEI'], ['Jaguar', 'Fábio Antunes Leal', 'DEF'],
      ['Cobra', 'Rogério Bezerra Luz', 'GL'], ['Elástico', 'Lucas Matheus Prado', 'MEI'],
      ['Seu Raimundo', 'Raimundo Nonato Pinto', 'DEF'], ['Pardal', 'Gabriel Siqueira Neves', 'ATA'],
      ['Xodó', 'Camila Ferraz Braga', 'MEI', 'f'], ['Bola Murcha', 'Anderson Coelho Brito', 'DEF'],
      ['Jacaré', 'Valdemar Lopes Arruda', 'GL'], ['Churrasqueiro', 'Sandro Magalhães Rios', 'MEI'],
      ['Alemãozinho', 'Otávio Kruger Lemos', 'DEF'], ['Dentinho', 'Henrique Salgado Cunha', 'ATA'],
      ['Pezinho', 'Wallace Moreira Dantas', 'MEI'], ['Rainha', 'Larissa Campos Veloso', 'ATA', 'f'],
    ],
  },
  {
    slug: 'radar-teste-riacho', nome: 'Rachão do Riacho', regiao: 'Riacho Fundo', lat: -15.883, lng: -48.017,
    dia: 3, hora: '20:30', modo: 'publico_aprovacao',
    escudo: { cor: 'laranja', cor2: 'grafite', padrao: 'barra' }, premios: { gols: true, artilheiro: true, destaque: false },
    jogo: { porTime: 5, max: 10, confirmados: 4 },
    elenco: [
      ['Capitão', 'Valter Batista Freitas', 'DEF'], ['Biriba', 'Moisés Cavalcante Neri', 'ATA'],
      ['Tigrão', 'Alex Sandro Pacheco', 'DEF'], ['Gatão', 'Rodnei Aguiar Sena', 'GL'],
      ['Sombra', 'Ítalo Fernandes Lobo', 'MEI'], ['Perninha', 'Jorge Luiz Amaral', 'MEI'],
      ['Cacá', 'Carlos Eduardo Vaz', 'ATA'], ['Bolinha', 'Edson Rangel Moraes', 'MEI'],
      ['Vaqueiro', 'Nelson Dutra Peixoto', 'DEF'], ['Fatinha', 'Fátima Regina Bastos', 'ATA', 'f'],
    ],
  },
  {
    slug: 'radar-teste-parkway', nome: 'Fut de Domingo Park Way', regiao: 'Park Way', lat: -15.900, lng: -47.964,
    dia: 0, hora: '08:00', modo: 'publico_aberto',
    escudo: { cor: 'roxo', cor2: 'lima', padrao: 'aro' }, premios: { gols: false, artilheiro: false, destaque: true },
    jogo: { porTime: 7, max: 14, confirmados: 6 },
    elenco: [
      ['Marcão', 'Marcos Aurélio Villela', 'DEF'], ['Embaixador', 'Leopoldo Guimarães Neto', 'MEI'],
      ['Fominha', 'Rafael Bittencourt Lima', 'ATA'], ['Capivara', 'Murilo Albuquerque Reis', 'DEF'],
      ['Cerrado', 'Henrique Vasconcelos Pita', 'MEI'], ['Zico Jr', 'Francisco Ferraz Barreto Júnior', 'ATA'],
      ['Luva de Ouro', 'Cristiano Almeida Fontes', 'GL'], ['Maestro', 'Bernardo Rezende Lacerda', 'MEI'],
      ['Tucano', 'Ricardo Sá Menezes', 'ATA'], ['Vovô', 'Gilberto Prado Lacerda', 'DEF'],
      ['Pipoca', 'Priscila Andrade Maia', 'MEI', 'f'], ['Sabiá', 'Matheus Cordeiro Rego', 'DEF'],
      ['Chacal', 'Danilo Bastos Furtado', 'ATA'], ['Cabo Frio', 'Wagner Siqueira Lage', 'GL'],
    ],
  },
  {
    slug: 'radar-teste-cruzeiro', nome: 'Boleiros do Cruzeiro', regiao: 'Cruzeiro', lat: -15.792, lng: -47.937,
    dia: 1, hora: '21:00', modo: 'publico_aprovacao',
    escudo: { cor: 'ciano', cor2: null, padrao: null }, premios: { gols: true, artilheiro: true, destaque: true },
    jogo: { porTime: 5, max: 12, confirmados: 5 },
    elenco: [
      ['Tio Beto', 'Roberto Carlos Esteves', 'DEF'], ['Ligeirinho', 'Thales Rodrigues Paz', 'ATA'],
      ['Pitbull', 'Marcelo Duarte Veloso', 'DEF'], ['Chicão', 'Francisco Ney Barreira', 'MEI'],
      ['Doze', 'Paulo Henrique Araújo', 'MEI'], ['Trovão', 'Ednaldo Ramos Vidal', 'ATA'],
      ['Gandula', 'Joaquim Neves Cabral', 'GL'], ['Mãozinha', 'Evandro Pires Tavares', 'GL'],
      ['Boca', 'Washington Ribas Meireles', 'DEF'], ['Neguinho', 'Anselmo Cunha Prates', 'MEI'],
      ['Tica', 'Letícia Barbosa Nunes', 'ATA', 'f'],
    ],
  },
];

// ─── Filtros do --limpar (só o que este script criou) ─────────────────────────────────────────────────────────────────
const RE_SLUG = /^radar-teste-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RE_CONTA = /^teste-radar-[a-z0-9]+(?:-[a-z0-9]+)*-\d+@futtymock\.com$/;
const eSlugDoScript = (slug) => typeof slug === 'string' && RE_SLUG.test(slug);
const eContaDoScript = (email) => typeof email === 'string' && RE_CONTA.test(email);

// ─── Datas (relógio de São Paulo, via utils/fuso — a hora do jogo é a do campo) ─────────────────────────────────────
const SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const dois = (n) => String(n).padStart(2, '0');
const ymdTexto = ({ ano, mes, dia }) => `${ano}-${dois(mes)}-${dois(dia)}`;
function maisDias({ ano, mes, dia }, n) {
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  d.setUTCDate(d.getUTCDate() + n);
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() };
}

/**
 * A próxima vez que o relógio de São Paulo marca `hora` num `diaDaSemana` (0 = domingo): a pelo menos 1 dia (24 h) de
 * `agora`, com o prazo da presença — a véspera às 18h — ainda no futuro (senão a presença nasceria fechada). Devolve
 * { data, prazo } como Date (UTC). Nunca no passado; vira o mês e o ano sozinho.
 */
function proximoJogo({ diaDaSemana, hora }, agora = new Date()) {
  const hoje = partesNoFuso(agora, FUSO_PADRAO);
  for (let n = 0; n <= 21; n += 1) {
    const ymd = maisDias(hoje, n);
    if (new Date(Date.UTC(ymd.ano, ymd.mes - 1, ymd.dia)).getUTCDay() !== diaDaSemana) continue;
    const data = instanteNoFuso(ymdTexto(ymd), hora, FUSO_PADRAO);
    const prazo = instanteNoFuso(ymdTexto(maisDias(ymd, -1)), '18:00', FUSO_PADRAO);
    if (data && prazo && data.getTime() - agora.getTime() >= UM_DIA_MS && prazo.getTime() > agora.getTime()) return { data, prazo };
  }
  throw new Error(`não achei uma próxima ocorrência de ${SEMANA[diaDaSemana]} ${hora}`);
}

/** "qui 08/10 · 20:00" — o jogo no relógio de São Paulo. */
function rotuloDoJogo(instante) {
  const p = partesNoFuso(instante, FUSO_PADRAO);
  return p ? `${SEMANA[p.diaDaSemana]} ${dois(p.dia)}/${dois(p.mes)} · ${dois(p.hora)}:${dois(p.minuto)}` : '(sem data)';
}

// ─── O que se grava (puro — testável sem banco) ───────────────────────────────────────────────────────────────────────
const hashDe = (texto) => [...texto].reduce((h, c) => ((h * 31) + c.charCodeAt(0)) >>> 0, 7);
const emailDe = (slug, n) => `${PREFIXO_CONTA}-${slug.slice(PREFIXO_SLUG.length)}-${n}${DOMINIO}`;

/**
 * O elenco do time: o primeiro é o admin, os outros members; 1 ou 2 goleiros (categoria GR).
 * Nascimento de adulto (1981–2004, lei: 18+) e avatar genérico variado, tudo determinístico por slug.
 */
function elencoDe(time) {
  const rng = mulberry32(hashDe(time.slug));
  return time.elenco.map(([apelido, nome, pos, sexo], i) => {
    const feminino = sexo === 'f';
    const ano = 1981 + Math.floor(rng() * 24);
    const mes = 1 + Math.floor(rng() * 12);
    const dia = 1 + Math.floor(rng() * 28);
    return {
      apelido, nome, pos, gr: pos === 'GL', admin: i === 0,
      email: emailDe(time.slug, i + 1),
      av: `${feminino ? 'f' : 'm'}${1 + ((i + hashDe(time.slug)) % 3)}`,
      nasc: `${ano}-${dois(mes)}-${dois(dia)}`,
    };
  });
}

/** Quem confirmou presença no próximo jogo: o admin e mais alguns, sempre `jogo.confirmados` no total (4 a 9). */
function confirmadosDe(time) {
  const rng = mulberry32(hashDe(`${time.slug}:rsvp`));
  const outros = time.elenco.map((_, i) => i).slice(1);
  for (let i = outros.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [outros[i], outros[j]] = [outros[j], outros[i]];
  }
  return [0, ...outros.slice(0, time.jogo.confirmados - 1)].sort((a, b) => a - b);
}

/**
 * A linha de `teams` como o motor a grava quando a pessoa escolhe "Brasília, DF" na lista e declara o bairro: a cidade e o
 * normalizado vêm de resolverCidade, o bairro e o normalizado de resolverBairro (o ponto do bairro é o da tabela, sem
 * chamar o Nominatim). `criadoPor` entra depois que a conta do admin existe.
 */
async function montarTime(time, criadoPor = null) {
  const cid = await resolverCidade(BRASILIA);
  const bar = await resolverBairro({ bairro: time.regiao }, cid, { geocodar: async () => ({ lat: time.lat, lng: time.lng }) });
  return {
    nome: time.nome,
    slug: time.slug,
    cor: time.escudo.cor,
    escudo_cor2: time.escudo.cor2,
    escudo_padrao: time.escudo.padrao,
    criado_por: criadoPor,
    publica: true, // a flag legada acompanha os dois modos públicos (routes/teams.js)
    modo_visibilidade: time.modo,
    cidade: cid.cidade, // "Brasília, DF"
    cidade_normalizada: cid.normalizada, // "brasilia"
    bairro: bar.bairro,
    bairro_normalizado: bar.normalizado,
    localizacao: `${time.regiao}, ${cid.cidade}`,
    geo_lat: bar.geo?.lat ?? cid.geo.lat,
    geo_lng: bar.geo?.lng ?? cid.geo.lng,
    fuso: FUSO_PADRAO,
    descricao: DESCRICAO,
    mostrar_gols: time.premios.gols,
    mostrar_artilheiro: time.premios.artilheiro,
    mostrar_destaque: time.premios.destaque,
  };
}

module.exports = {
  PREFIXO_SLUG, PREFIXO_CONTA, DOMINIO, TIMES, BRASILIA, LIMITES_DF,
  dentroDoDF, eSlugDoScript, eContaDoScript, proximoJogo, rotuloDoJogo, elencoDe, confirmadosDe, montarTime, emailDe,
};

// ─── A partir daqui, tudo fala com o banco — nada disto corre com require() ───────────────────────────────────────────
const args = process.argv.slice(2);
const tem = (n) => args.includes(`--${n}`);
const ok = (m) => console.log('✓', m);
const info = (m) => console.log('·', m);
const aviso = (m) => console.warn('!', m);

let clienteBanco = null;
const db = () => {
  if (!clienteBanco) clienteBanco = require('../utils/db').supabase; // eslint-disable-line global-require
  return clienteBanco;
};

const GENERICO = (av) => {
  const base = `${process.env.SUPABASE_URL}/storage/v1/object/public/kits`;
  const arquivo = { m1: 'avatar-generico-1.png', m2: 'avatar-generico-2.png', m3: 'avatar-generico-3.png', f1: 'avatar-generico-f-1.png', f2: 'avatar-generico-f-2.png', f3: 'avatar-generico-f-3.png' }[av];
  return `${base}/${arquivo}`;
};

if (require.main === module) {
  (async () => {
    const conhecidas = ['status', 'aprovar-pedidos', 'limpar', 'sim'];
    const desconhecidas = args.filter((a) => !conhecidas.some((c) => a === `--${c}`));
    if (desconhecidas.length) throw new Error(`opção desconhecida: ${desconhecidas.join(' ')} (use --status, --aprovar-pedidos, --limpar ou --limpar --sim)`);
    if (tem('sim') && !tem('limpar')) throw new Error('--sim só vale junto com --limpar.');
    if (['status', 'aprovar-pedidos', 'limpar'].filter(tem).length > 1) throw new Error('uma opção por vez.');
    if (tem('status')) await statusCmd();
    else if (tem('aprovar-pedidos')) await aprovarPedidosCmd();
    else if (tem('limpar')) await limparCmd(tem('sim'));
    else await criar();
  })().catch((e) => { console.error('[radar-teste] ERRO:', e.message); process.exitCode = 1; });
}

// ─── Leituras comuns ────────────────────────────────────────────────────────────────────────────────────────────────────
async function timesDoScript() {
  const { data, error } = await db().from('teams').select('id, slug, nome, modo_visibilidade').like('slug', `${PREFIXO_SLUG}%`);
  if (error) throw new Error(`teams: ${error.message}`);
  return (data || []).filter((t) => eSlugDoScript(t.slug));
}
async function contasDoScript() {
  const { data, error } = await db().from('users').select('id, email').ilike('email', `${PREFIXO_CONTA}-%${DOMINIO}`);
  if (error) throw new Error(`users: ${error.message}`);
  return (data || []).filter((u) => eContaDoScript(u.email));
}
async function proximoJogoNoBanco(teamId) {
  const { data } = await db().from('games').select('id, data, local, rsvp_aberto, rsvp_prazo').eq('team_id', teamId).eq('status', 'agendado').order('data', { ascending: true }).limit(1);
  return data?.[0] || null;
}

// ─── Criar ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Sem as migrações 066/073/076/077 o motor "tolera" e grava um time pela metade; aqui o resultado seria um Radar enganoso
// (sem bairro, sem escudo), então a criação para antes de gravar qualquer coisa.
async function conferirColunas() {
  const { error } = await db().from('teams')
    .select('id, cidade_normalizada, bairro, bairro_normalizado, mostrar_artilheiro, mostrar_destaque, fuso, escudo_cor2, escudo_padrao').limit(1);
  if (error) throw new Error(`o banco ainda não tem as colunas do time (migrações 066, 073, 076 e 077): ${error.message}`);
}

async function criarContas(time) {
  const supabase = db();
  const elenco = elencoDe(time);
  for (const j of elenco) {
    const password = crypto.randomBytes(16).toString('base64url'); // aleatória e jogada fora: ninguém entra nestas contas
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase.auth.admin.createUser({
      email: j.email, password, email_confirm: true,
      user_metadata: { nome: j.nome, onboarding_completo: true, tour_inicio_visto: true },
    });
    if (error) throw new Error(`createUser ${j.email}: ${error.message}`);
    j.id = data.user.id;
    // eslint-disable-next-line no-await-in-loop
    const { error: e2 } = await supabase.from('users').upsert({
      id: j.id, email: j.email, nome: j.nome, nome_jogador: j.apelido, birthdate: j.nasc,
      avatar_generico: j.av, avatar_url: GENERICO(j.av), plan: 'free',
      cor_frame: 'dourado', fundo_figurinha: 'estadio', kit_ativo: 'dark-gold',
    }, { onConflict: 'id' });
    if (e2) throw new Error(`users ${j.email}: ${e2.message.slice(0, 200)}`);
  }
  return elenco;
}

async function criarUmTime(time) {
  const supabase = db();
  const elenco = await criarContas(time);
  const admin = elenco[0];

  const { data: criado, error } = await supabase.from('teams').insert(await montarTime(time, admin.id)).select('id, slug').single();
  if (error) throw new Error(`teams ${time.slug}: ${error.message}`);

  const base = Date.now() - 20 * UM_DIA_MS;
  const membros = elenco.map((j, i) => ({
    user_id: j.id, team_id: criado.id, role: j.admin ? 'admin' : 'member',
    categoria: j.gr ? 'GR' : 'linha', posicao: j.pos, pode_postar: true,
    created_at: new Date(base + i * 60000).toISOString(),
  }));
  const { error: e2 } = await supabase.from('team_members').insert(membros);
  if (e2) throw new Error(`team_members ${time.slug}: ${e2.message}`);

  const prox = proximoJogo({ diaDaSemana: time.dia, hora: time.hora });
  const { data: jogo, error: e3 } = await supabase.from('games').insert({
    team_id: criado.id, data: prox.data.toISOString(), local: `${time.regiao}, ${BRASILIA.cidade}, ${BRASILIA.uf}`,
    jogadores_por_time: time.jogo.porTime, max_jogadores: time.jogo.max, status: 'agendado',
    sorteio_realizado: false, rsvp_aberto: true, rsvp_fechado: false, rsvp_prazo: prox.prazo.toISOString(),
  }).select('id').single();
  if (e3) throw new Error(`games ${time.slug}: ${e3.message}`);

  const quem = confirmadosDe(time).map((i) => elenco[i]);
  const { error: e4 } = await supabase.from('game_players').insert(
    quem.map((j) => ({ game_id: jogo.id, user_id: j.id, confirmado: true, goleiro: j.gr, cabeca_chave: false })),
  );
  if (e4) throw new Error(`game_players ${time.slug}: ${e4.message}`);
  const { error: e5 } = await supabase.from('rsvp_respostas').insert(quem.map((j) => ({ game_id: jogo.id, user_id: j.id, status: 'confirmado' })));
  if (e5) throw new Error(`rsvp_respostas ${time.slug}: ${e5.message}`);

  ok(`${time.nome} (${time.slug}) — ${elenco.length} jogadores (${elenco.filter((j) => j.gr).length} GR), ${time.modo === 'publico_aberto' ? 'aberto' : 'com aprovação'}, jogo ${rotuloDoJogo(prox.data)}, ${quem.length} confirmados`);
  return { slug: time.slug, id: criado.id, jogo: jogo.id };
}

async function criar() {
  await conferirColunas();
  const jaExistem = await timesDoScript();
  if (jaExistem.length) {
    throw new Error(`já existe(m) ${jaExistem.length} time(s) radar-teste-* (${jaExistem.map((t) => t.slug).join(', ')}) — rode --limpar --sim antes de criar de novo.`);
  }
  const contas = await contasDoScript();
  if (contas.length) throw new Error(`já existem ${contas.length} conta(s) ${PREFIXO_CONTA}-*${DOMINIO} sem time — rode --limpar --sim antes de criar de novo.`);

  const feitos = [];
  for (const time of TIMES) {
    // eslint-disable-next-line no-await-in-loop
    feitos.push(await criarUmTime(time));
  }
  fs.mkdirSync(PASTA_TIME_TESTE, { recursive: true });
  fs.writeFileSync(ARQ_ESTADO, JSON.stringify({ times: feitos, criadoEm: new Date().toISOString() }, null, 2), 'utf8');
  ok(`estado gravado em ${ARQ_ESTADO}`);
  ok(`Pronto — ${feitos.length} peladas de Brasília no Radar. Busque "Brasília" (ou o nome da região).`);
}

// ─── --status ────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function pedidosPendentes(ids) {
  if (!ids.length) return [];
  const { data, error } = await db().from('team_join_requests')
    .select('id, team_id, user_id, mensagem, created_at, users ( nome, nome_jogador )').in('team_id', ids).eq('status', 'pending').order('created_at', { ascending: true });
  if (error) throw new Error(`team_join_requests: ${error.message}`);
  return data || [];
}

async function statusCmd() {
  const times = await timesDoScript();
  const porSlug = Object.fromEntries(times.map((t) => [t.slug, t]));
  const { data: membros } = times.length ? await db().from('team_members').select('team_id').in('team_id', times.map((t) => t.id)) : { data: [] };
  const contagem = {};
  (membros || []).forEach((m) => { contagem[m.team_id] = (contagem[m.team_id] || 0) + 1; });
  const pendentes = await pedidosPendentes(times.map((t) => t.id));

  for (const alvo of TIMES) {
    const t = porSlug[alvo.slug];
    if (!t) { aviso(`${alvo.slug}: NÃO existe (rode sem opções para criar)`); continue; }
    // eslint-disable-next-line no-await-in-loop
    const jogo = await proximoJogoNoBanco(t.id);
    const { count } = jogo ? await db().from('game_players').select('user_id', { count: 'exact', head: true }).eq('game_id', jogo.id).eq('confirmado', true) : { count: 0 };
    const meus = pendentes.filter((p) => p.team_id === t.id);
    console.log(`· ${t.nome} (${t.slug})`);
    console.log(`    entrada: ${t.modo_visibilidade === 'publico_aberto' ? 'aberto' : t.modo_visibilidade === 'publico_aprovacao' ? 'com aprovação' : t.modo_visibilidade} · membros: ${contagem[t.id] || 0}`);
    console.log(`    próximo jogo: ${jogo ? `${rotuloDoJogo(jogo.data)} · ${count} confirmados · presença ${jogo.rsvp_aberto ? 'aberta' : 'fechada'}` : '(nenhum)'}`);
    console.log(`    pedidos pendentes: ${meus.length ? meus.map((p) => p.users?.nome_jogador || p.users?.nome || p.user_id).join(', ') : 'nenhum'}`);
  }
  const extras = times.filter((t) => !TIMES.some((a) => a.slug === t.slug));
  if (extras.length) aviso(`times radar-teste-* fora da tabela: ${extras.map((t) => t.slug).join(', ')}`);
}

// ─── --aprovar-pedidos ──────────────────────────────────────────────────────────────────────────────────────────────────
// Faz o que PATCH /api/teams/:slug/pedidos/:id (status approved) faz — entra como membro, o pedido vira "approved" e quem
// foi aceito recebe o push "Você entrou no time …!" — só que para os times radar-teste-*: o admin fictício aceitando.
async function avisarAceite(time, userId) {
  try {
    const { enviarNotificacao } = require('../routes/push'); // eslint-disable-line global-require
    await Promise.race([
      Promise.resolve(enviarNotificacao([userId], {
        title: `Você entrou no time ${time.nome}!`, body: 'Confirme presença e veja o próximo jogo.', url: `/time/${time.slug}?entrou=1`,
      })),
      new Promise((resolve) => { setTimeout(resolve, 4000).unref?.(); }),
    ]);
    return true;
  } catch (e) {
    aviso(`push do aceite não saiu (o aceite foi gravado): ${e?.message || e}`);
    return false;
  }
}

async function aprovarPedidosCmd() {
  const times = await timesDoScript();
  const porId = Object.fromEntries(times.map((t) => [t.id, t]));
  const pendentes = (await pedidosPendentes(times.map((t) => t.id))).filter((p) => porId[p.team_id]);
  if (!pendentes.length) { info('nenhum pedido de entrada pendente nos times radar-teste-*.'); return; }
  const supabase = db();
  for (const p of pendentes) {
    const time = porId[p.team_id];
    const quem = p.users?.nome_jogador || p.users?.nome || p.user_id;
    // eslint-disable-next-line no-await-in-loop
    const { error: e1 } = await supabase.from('team_members').upsert({ team_id: time.id, user_id: p.user_id, role: 'member' }, { onConflict: 'user_id,team_id' });
    if (e1) throw new Error(`team_members (${quem} em ${time.slug}): ${e1.message}`);
    // eslint-disable-next-line no-await-in-loop
    const { error: e2 } = await supabase.from('team_join_requests').update({ status: 'approved', updated_at: new Date().toISOString() }).eq('id', p.id);
    if (e2) throw new Error(`team_join_requests (${quem} em ${time.slug}): ${e2.message}`);
    // eslint-disable-next-line no-await-in-loop
    await avisarAceite(time, p.user_id);
    ok(`${quem} aprovado em ${time.nome} (${time.slug})`);
  }
  info('o app pode levar até 2 min para mostrar o time novo nos selos (cache do motor); o card "Você entrou no time" aparece no Início.');
}

// ─── --limpar / --limpar --sim ─────────────────────────────────────────────────────────────────────────────────────────
async function limparCmd(confirmado) {
  const times = await timesDoScript();
  const contas = await contasDoScript();

  if (!confirmado) {
    info(`(simulação) apagaria ${times.length} time(s): ${times.map((t) => t.slug).join(', ') || '(nenhum)'}`);
    info(`(simulação) e ${contas.length} conta(s) ${PREFIXO_CONTA}-*${DOMINIO}${fs.existsSync(ARQ_ESTADO) ? ' e o radar-estado.json' : ''}.`);
    info('os vínculos de pessoas reais nesses times somem junto; as contas delas ficam intactas.');
    info('rode com --limpar --sim para apagar de verdade.');
    return;
  }

  const supabase = db();
  const { removerFicheirosPorUrl } = require('../utils/storage'); // eslint-disable-line global-require
  const { apagarUsuario } = require('../utils/apagarUsuario'); // eslint-disable-line global-require

  for (const time of times) {
    // Fotos que alguém tenha postado nestes times (a cascata do banco não apaga arquivo do Storage).
    // eslint-disable-next-line no-await-in-loop
    const { data: posts } = await supabase.from('feed_posts').select('id').eq('team_id', time.id);
    const postIds = (posts || []).map((p) => p.id);
    if (postIds.length) {
      // eslint-disable-next-line no-await-in-loop
      const { data: media } = await supabase.from('feed_post_media').select('url').in('post_id', postIds);
      const urls = (media || []).map((m) => m.url).filter(Boolean);
      // eslint-disable-next-line no-await-in-loop
      if (urls.length) await removerFicheirosPorUrl('resenha', urls);
    }
    // eslint-disable-next-line no-await-in-loop
    const { error } = await supabase.from('teams').delete().eq('id', time.id);
    if (error) throw new Error(`apagar time ${time.slug}: ${error.message}`);
    info(`time ${time.slug} apagado (jogos, vínculos e pedidos em cascata)`);
  }
  for (const c of contas) {
    // eslint-disable-next-line no-await-in-loop
    await apagarUsuario(c.id);
    info(`${c.email} apagado`);
  }
  if (fs.existsSync(ARQ_ESTADO)) { fs.unlinkSync(ARQ_ESTADO); info('radar-estado.json apagado'); }
  ok(`limpeza concluída: ${times.length} time(s) e ${contas.length} conta(s) apagados.`);
}
