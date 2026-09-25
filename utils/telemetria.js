// Futty v2.0 — Telemetria ANÔNIMA de velocidade (Rodada 28, bloco E).
//
// Substitui o botão de Diagnóstico para todo mundo: o app manda, no máximo uma vez por tela por
// sessão, quanto a tela levou para ficar útil e quanto cada chamada ao motor custou. É o número do
// aparelho de quem usa, sem ninguém precisar tocar em nada.
//
// ANÔNIMA DE VERDADE, por construção — não por promessa:
//   · a linha gravada é montada só com os campos da LISTA abaixo; qualquer outro campo que chegue
//     (user id, e-mail, token, id de aparelho) é ignorado, nunca copiado;
//   · rotas e telas passam por `normalizarRota`: slug de time, id, token, número, e-mail — tudo o que
//     não for palavra fixa de rota vira `:slug`/`:id`/`:x`;
//   · a rota não lê o Authorization nem o IP. O IP só existe na memória do limiter (por 15 min) e
//     nos logs de acesso da infraestrutura; nunca numa tabela nossa.
// Retenção: 30 dias (`limparAntigas`, abaixo).

const PLATAFORMAS = new Set(['ios', 'android', 'web']);
const REDES = new Set(['slow-2g', '2g', '3g', '4g', '5g', 'wifi', 'cellular', 'ethernet', 'bluetooth', 'wimax', 'other', 'none', 'unknown']);
const FAIXA_APARELHO = /^(ios|android|web)-(baixo|medio|alto)$/;
const VERSAO = /^[\w .()+-]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Palavra fixa de rota: só letras minúsculas e hífen, como todas as rotas do app e do motor.
const PALAVRA_DE_ROTA = /^[a-z]+(-[a-z]+)*$/;
// Onde o segmento SEGUINTE é o slug de um time (app: /equipa/:slug, /admin/:slug; motor:
// /api/teams/:slug, /api/equipas/:slug). O slug de time pode ser só letras ("teste-abcde") e
// passaria por palavra de rota — por isso a posição manda, não a forma.
const ANTES_DO_SLUG = new Set(['teams', 'equipas', 'equipa', 'admin']);

const MS_MAX = 120000; // 2 minutos: acima disso não é tela lenta, é tela abandonada
const MAX_ROTAS = 20;
const MAX_ROTA_CHARS = 100;

/**
 * O padrão de uma rota, sem nada que identifique alguém ou algum time:
 *   /equipa/missa-de-quinta-ogqq6/jogador/5b1c…  →  /equipa/:slug/jogador/:id
 *   /api/teams/missa-de-quinta-ogqq6/ranking?x=1 →  /api/teams/:slug/ranking
 * Qualquer segmento que não seja palavra fixa de rota vira `:x` (número, token, e-mail, slug solto).
 */
function normalizarRota(caminho) {
  const partes = String(caminho || '').split(/[?#]/)[0].split('/');
  const saida = partes.map((seg, i) => {
    if (!seg) return seg;
    const anterior = partes[i - 1];
    if (ANTES_DO_SLUG.has(anterior)) return ':slug';
    // /p/:slug/:gameId (sorteio público) e /p/campeonato/:slug/:id
    if (anterior === 'p' && seg !== 'campeonato' && !UUID.test(seg)) return ':slug';
    if (anterior === 'campeonato' && partes[i - 2] === 'p') return ':slug';
    if (UUID.test(seg)) return ':id';
    if (seg.length <= 24 && PALAVRA_DE_ROTA.test(seg)) return seg;
    return ':x';
  });
  return saida.join('/').slice(0, MAX_ROTA_CHARS);
}

function msValido(v) {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n >= 0 && n <= MS_MAX ? n : null;
}

/**
 * Valida o que o app mandou e monta a LINHA a gravar — só com os campos da lista.
 * Devolve `{ ok: true, linha }` ou `{ ok: false, erro }`.
 */
function montarLinha(corpo, { ambiente = 'teste' } = {}) {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return { ok: false, erro: 'corpo inválido' };

  const tela = typeof corpo.tela === 'string' && corpo.tela.startsWith('/') ? normalizarRota(corpo.tela) : null;
  if (!tela) return { ok: false, erro: 'tela inválida' };

  const msUtil = msValido(corpo.ms_util);
  if (msUtil == null) return { ok: false, erro: 'ms_util inválido' };

  const plataforma = PLATAFORMAS.has(corpo.plataforma) ? corpo.plataforma : null;
  if (!plataforma) return { ok: false, erro: 'plataforma inválida' };

  // Chamadas: { "/api/…": { ms, motor } } (ou só o número). Entradas estragadas somem, não derrubam a linha.
  const chamadas = {};
  if (corpo.chamadas && typeof corpo.chamadas === 'object' && !Array.isArray(corpo.chamadas)) {
    for (const [rotaBruta, valor] of Object.entries(corpo.chamadas).slice(0, MAX_ROTAS * 2)) {
      if (Object.keys(chamadas).length >= MAX_ROTAS) break;
      if (!rotaBruta.startsWith('/api/')) continue;
      const rota = normalizarRota(rotaBruta);
      const ms = msValido(typeof valor === 'object' && valor !== null ? valor.ms : valor);
      if (ms == null) continue;
      const motor = typeof valor === 'object' && valor !== null ? msValido(valor.motor) : null;
      // Duas rotas que viram o mesmo padrão ficam com a pior: é a que segurou a tela.
      if (!chamadas[rota] || chamadas[rota].ms < ms) chamadas[rota] = { ms, motor };
    }
  }

  const versao = typeof corpo.versao_app === 'string' && VERSAO.test(corpo.versao_app) ? corpo.versao_app : null;
  const rede = typeof corpo.rede === 'string' && REDES.has(corpo.rede) ? corpo.rede : null;
  const aparelho = typeof corpo.aparelho === 'string' && FAIXA_APARELHO.test(corpo.aparelho) ? corpo.aparelho : null;

  return {
    ok: true,
    linha: { ambiente, tela, ms_util: msUtil, chamadas, versao_app: versao, plataforma, rede, aparelho },
  };
}

// Teto de gravações por instância, além do limiter por IP: se alguém espalhar pedidos por muitos
// IPs, a tabela não enche — o que passar disto é descartado em silêncio (o app não espera nada).
const TETO_POR_JANELA = 3000;
const JANELA_TETO_MS = 10 * 60 * 1000;
let janelaDesde = 0;
let gravadasNaJanela = 0;

function cabeNoTeto(agora = Date.now()) {
  if (agora - janelaDesde > JANELA_TETO_MS) {
    janelaDesde = agora;
    gravadasNaJanela = 0;
  }
  if (gravadasNaJanela >= TETO_POR_JANELA) return false;
  gravadasNaJanela += 1;
  return true;
}

// Retenção de 30 dias: a limpeza vai de carona na gravação, no máximo a cada 6 h por instância
// (com min-instances=1 no Cloud Run há sempre uma instância a correr). Sem job à parte.
const RETENCAO_DIAS = 30;
const LIMPEZA_A_CADA_MS = 6 * 60 * 60 * 1000;
let ultimaLimpeza = 0;

async function limparAntigas(supabase, agora = Date.now()) {
  if (agora - ultimaLimpeza < LIMPEZA_A_CADA_MS) return false;
  ultimaLimpeza = agora;
  const corte = new Date(agora - RETENCAO_DIAS * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from('telemetria_velocidade').delete().lt('criado_em', corte);
  if (error) console.warn('[telemetria] limpeza dos antigos falhou (migração 061 aplicada?):', error.message);
  return !error;
}

module.exports = { normalizarRota, montarLinha, cabeNoTeto, limparAntigas, RETENCAO_DIAS };
