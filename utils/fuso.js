// Futty v2.0 — O fuso horário do time.
//
// A hora de um jogo é a hora do CAMPO, sempre: quem viaja continua vendo "quinta, 20h". O jogo fica gravado como instante
// (UTC, timestamptz); o que diz "que horas são no campo" é o fuso do time (teams.fuso, migração 076, padrão
// America/Sao_Paulo), derivado da cidade quando o time nasce ou muda de cidade.
//
// Este módulo é puro (sem banco, sem rede): o padrão, a validação, a derivação a partir da coordenada, as contas de relógio
// de parede no fuso (para o servidor escrever e interpretar horas sem depender do TZ do processo — o Cloud Run roda em UTC) e
// a leitura tolerante da coluna `fuso` enquanto a migração 076 não foi aplicada.
const tzLookup = require('tz-lookup');

const FUSO_PADRAO = 'America/Sao_Paulo';

const fusoValido = (fuso) => {
  if (typeof fuso !== 'string' || !fuso.trim()) return false;
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: fuso }); // eslint-disable-line no-new
    return true;
  } catch {
    return false;
  }
};

/** O fuso que veio, se for um fuso de verdade; senão o padrão. Nunca lança. */
const normalizarFuso = (fuso) => (fusoValido(fuso) ? fuso : FUSO_PADRAO);

/** O fuso de um objeto de time (linha de `teams`, ou o `teams ( … )` embutido num jogo). */
const fusoDoTime = (time) => normalizarFuso(time?.fuso);

/**
 * O fuso de um ponto do mapa (a cidade geocodificada do time). `null` quando não dá para saber — quem chamou deixa o
 * padrão (ou o que o time já tinha) em vez de chutar.
 */
function fusoDaCoordenada(lat, lng) {
  const la = Number(lat);
  const lo = Number(lng);
  if (lat == null || lng == null || !Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  try {
    const fuso = tzLookup(la, lo);
    return fusoValido(fuso) ? fuso : null;
  } catch {
    return null;
  }
}

// ─── Relógio de parede no fuso ─────────────────────────────────────────────────────────────────────────────────────────

const cacheDeFormatadores = new Map();
function formatador(fuso) {
  let f = cacheDeFormatadores.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: fuso, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    cacheDeFormatadores.set(fuso, f);
  }
  return f;
}

/** Ano, mês (1–12), dia, hora, minuto e dia da semana (0 = domingo) de um instante, lidos no relógio do fuso. */
function partesNoFuso(instante, fuso = FUSO_PADRAO) {
  const d = instante instanceof Date ? instante : new Date(instante);
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(formatador(normalizarFuso(fuso)).formatToParts(d).map((x) => [x.type, Number(x.value)]));
  const diaDaSemana = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return { ano: p.year, mes: p.month, dia: p.day, hora: p.hour, minuto: p.minute, segundo: p.second, diaDaSemana };
}

/** Quanto o relógio do fuso está à frente do UTC naquele instante, em ms (Brasília: −3 h). */
function deslocamentoMs(instanteMs, fuso) {
  const p = partesNoFuso(new Date(instanteMs), fuso);
  const comoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  return comoUtc - Math.floor(instanteMs / 1000) * 1000;
}

/**
 * O instante em que o relógio do fuso marca `data` ("AAAA-MM-DD") e `hora` ("HH:MM") — "quinta, 20:00 no campo". Independe
 * do TZ do processo. Data ou hora inválida → null.
 */
function instanteNoFuso(data, hora, fuso = FUSO_PADRAO) {
  const md = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(data ?? '').slice(0, 10));
  const mh = /^(\d{1,2}):(\d{2})$/.exec(String(hora ?? ''));
  if (!md || !mh) return null;
  const [ano, mes, dia] = [Number(md[1]), Number(md[2]), Number(md[3])];
  const [h, min] = [Number(mh[1]), Number(mh[2])];
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || h > 23 || min > 59) return null;
  const f = normalizarFuso(fuso);
  const comoUtc = Date.UTC(ano, mes - 1, dia, h, min);
  // Corrige pelo deslocamento do fuso, duas vezes: a segunda cobre o dia em que o horário de verão vira.
  let t = comoUtc - deslocamentoMs(comoUtc, f);
  t = comoUtc - deslocamentoMs(t, f);
  const instante = new Date(t);
  const p = partesNoFuso(instante, f);
  if (p.dia !== dia || p.mes !== mes) return null; // "31 de fevereiro" não existe
  return instante;
}

const dois = (n) => String(n).padStart(2, '0');

/** "12/06 · 20:30" — a data curta do jogo, no relógio do campo, para o corpo das notificações. */
function dataCurtaNoFuso(iso, fuso = FUSO_PADRAO) {
  const p = partesNoFuso(iso, fuso);
  return p ? `${dois(p.dia)}/${dois(p.mes)} · ${dois(p.hora)}:${dois(p.minuto)}` : '';
}

/** "dd/mm/aaaa", no relógio do fuso. */
function dataNoFuso(iso, fuso = FUSO_PADRAO) {
  const p = partesNoFuso(iso, fuso);
  return p ? `${dois(p.dia)}/${dois(p.mes)}/${p.ano}` : null;
}

/** "HH:MM", no relógio do fuso. */
function horaNoFuso(iso, fuso = FUSO_PADRAO) {
  const p = partesNoFuso(iso, fuso);
  return p ? `${dois(p.hora)}:${dois(p.minuto)}` : null;
}

// ─── A coluna `fuso` enquanto a migração 076 não foi aplicada ──────────────────────────────────────────────────────────
// O deploy do código nunca pode depender da ordem em que o Pedro corre as migrações: se a leitura com `fuso` falhar por
// causa da coluna, repete sem ela e o time vale o padrão. A falta é lembrada por um minuto (sem repetir o erro a cada
// pedido); depois disso a leitura com a coluna é tentada de novo, e a migração aplicada passa a valer sozinha.
const MEMORIA_DA_FALTA_MS = 60 * 1000;
const faltaAte = new Map(); // coluna → até quando se dá por ausente

const erroDaColunaFuso = (erro) => !!erro && /\bfuso\b/i.test(erro.message || '');

// O mesmo jeito vale para TODAS as colunas novas do time — o fuso (076), o escudo de duas cores e padrão (077)
// e os jogadores por time padrão (079). Elas viajam juntas nas leituras do time (a mesma ida ao banco); a que faltar sai da leitura
// SOZINHA (o erro do banco diz qual é) e as outras continuam valendo — com a 076 aplicada e a 077 não, o fuso vale e o escudo fica
// sólido. Cada uma que falta vale o seu padrão (fuso de São Paulo, escudo sólido, 5 por time) até o Pedro aplicar a migração dela.
const COLUNAS_NOVAS_DO_TIME = ['fuso', 'escudo_cor2', 'escudo_padrao', 'jogadores_por_time'];
const COLUNAS_NOVAS_DO_TIME_SQL = COLUNAS_NOVAS_DO_TIME.join(', ');
const RE_COLUNA_NOVA = new RegExp(`\\b(${COLUNAS_NOVAS_DO_TIME.join('|')})\\b`, 'i');
const erroDeColunaNova = (erro) => !!erro && RE_COLUNA_NOVA.test(erro.message || '');

/** As colunas novas que, até onde se sabe, existem — "fuso, escudo_cor2, …" (vazio = nenhuma). */
function colunasPresentes() {
  const agora = Date.now();
  return COLUNAS_NOVAS_DO_TIME.filter((c) => !(faltaAte.get(c) > agora)).join(', ');
}

/** Qual das colunas novas o erro do banco diz que não existe (a primeira citada), ou null. */
function colunaQueFalta(erro) {
  const m = RE_COLUNA_NOVA.exec(erro?.message || '');
  return m ? m[1].toLowerCase() : null;
}

/**
 * Roda `consulta(novas)` — uma função que monta e dispara a leitura; `novas` é o pedaço do select com as colunas novas do time
 * que existem ("fuso, escudo_cor2, …"), ou '' quando nenhuma (o select pede as novas só se vier algo). A coluna que o banco disser que
 * não existe sai e a leitura repete com as outras. Devolve o { data, error } da consulta que valeu.
 */
async function lerComFuso(consulta) {
  for (let tentativa = 0; tentativa <= COLUNAS_NOVAS_DO_TIME.length; tentativa += 1) {
    const novas = colunasPresentes();
    const resposta = await consulta(novas);
    const falta = novas ? colunaQueFalta(resposta.error) : null;
    // Erro que não é de coluna nova — ou de uma que esta leitura nem pediu — não é assunto daqui: volta como veio.
    if (!falta || !novas.split(', ').includes(falta)) return resposta;
    faltaAte.set(falta, Date.now() + MEMORIA_DA_FALTA_MS);
  }
  return consulta('');
}

/** Só para os testes: esquece que as colunas faltavam. */
const esquecerFaltaDaColuna = () => { faltaAte.clear(); };

module.exports = {
  FUSO_PADRAO,
  fusoValido,
  normalizarFuso,
  fusoDoTime,
  fusoDaCoordenada,
  partesNoFuso,
  instanteNoFuso,
  dataCurtaNoFuso,
  dataNoFuso,
  horaNoFuso,
  erroDaColunaFuso,
  erroDeColunaNova,
  COLUNAS_NOVAS_DO_TIME,
  COLUNAS_NOVAS_DO_TIME_SQL,
  lerComFuso,
  esquecerFaltaDaColuna,
};
