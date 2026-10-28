// Futty v2.0 — O medidor do banco: onde vão os ~300 ms de cada ida ao Supabase.
//
// O motor e o banco estão os dois em São Paulo; uma consulta trivial devia levar 10–30 ms e leva 300–500. Trocar a máquina do banco
// não mudou nada, então o custo está no caminho (DNS, ligação nova a cada pedido, a borda da Cloudflare do Supabase fora da região)
// ou numa consulta específica. Em vez de consertar às cegas, o motor mede o caminho por partes, de dentro do Cloud Run:
//   · dns ............ quanto leva resolver o host do Supabase (e de novo, para ver se há cache);
//   · tcp_tls ........ quanto custa UMA ligação nova (TCP e o aperto de mão do TLS, separados);
//   · ping_x5 ........ 5 consultas triviais seguidas pelo MESMO cliente que as rotas usam: 1ª lenta e o resto rápido = ligação fria;
//                      todas lentas = o custo é de cada pedido;
//   · ping_x5_paralelo as mesmas 5 de uma vez: total ≈ uma = latência; ≈ 5× = fila;
//   · cabecalhos ..... por onde o Supabase respondeu (o sufixo do cf-ray é o datacenter da Cloudflare; o esperado é GRU);
//   · despachante .... se o agente que segura a ligação (utils/ligacaoQuente.js) está mesmo valendo neste processo, e quantas
//                      ligações ele tem abertas com o Supabase;
//   · consulta_real .. a parte mais lenta do /api/inicio (o direito à figurinha), isolada, com o tempo de cada ida dela.
// Só leitura: nenhuma escrita no banco. Os tempos saem em ms com uma casa.
const dns = require('node:dns');
const net = require('node:net');
const tls = require('node:tls');
const { escutarIdas, agenteQuente } = require('./ligacaoQuente');
const { comPrazo } = require('./comPrazo');

const PRAZO_MS = 5000;
// O medidor inteiro no arranque (dns, tls e 10 consultas em fila e em paralelo): com ~65 ms por consulta em produção ele não cabia em 5 s.
const PRAZO_DO_ARRANQUE_MS = 15000;
const PINGS = 5;
const SIMBOLO_DO_DESPACHANTE = Symbol.for('undici.globalDispatcher.1');
// O undici fecha a ligação ociosa aos 4 s quando o servidor não diz outro prazo — é o valor do despachante global sem opção.
const OCIOSA_PADRAO_DO_UNDICI_MS = 4000;
// Só estes cabeçalhos da resposta saem, por LISTA (dizem por onde e quanto, nunca quem): Authorization, apikey, cookies e o corpo
// ficam de fora porque não estão nela — não por um filtro de "proibidos" que alguém esquece de atualizar.
const CABECALHOS_DA_BORDA = ['cf-ray', 'server', 'sb-gateway-version', 'cf-cache-status'];
const CABECALHO_DE_REGIAO = /(^x-.*region|region$)/i;
const CABECALHO_DE_TEMPO = /(latency|upstream-service-time)/i;

const umaCasa = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const agora = () => performance.now();

// Para quem lê o JSON, só o código do erro (ENOTFOUND, ETIMEDOUT, PGRST…): a mensagem inteira vai para o log do motor.
function erroCurto(rotulo, e) {
  console.warn(`[saude-banco] ${rotulo}:`, String(e?.message || e).slice(0, 200));
  const codigo = String(e?.code || '');
  return /^[A-Z0-9_]{2,40}$/.test(codigo) ? codigo : 'falhou';
}

async function medirDns(host) {
  const de = agora();
  const primeiro = await comPrazo(dns.promises.lookup(host), PRAZO_MS, 'dns');
  const meio = agora();
  await comPrazo(dns.promises.lookup(host), PRAZO_MS, 'dns');
  return { ms: umaCasa(meio - de), ms_de_novo: umaCasa(agora() - meio), ip: primeiro.address, familia: `IPv${primeiro.family}` };
}

/** Uma ligação nova até o Supabase, fechada logo depois: o TCP e o aperto de mão do TLS, cada um com o seu tempo. */
function medirLigacaoNova(url, ip) {
  return new Promise((resolve, reject) => {
    const seguro = url.protocol === 'https:';
    const porta = Number(url.port) || (seguro ? 443 : 80);
    const de = agora();
    let tcp = null;
    const socket = seguro
      ? tls.connect({ host: ip, port: porta, servername: url.hostname, ALPNProtocols: ['http/1.1'] })
      : net.connect({ host: ip, port: porta });
    const temporizador = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error('tcp_tls: sem resposta'), { code: 'ETIMEDOUT' })); }, PRAZO_MS);
    const terminar = (resultado) => { clearTimeout(temporizador); socket.destroy(); resolve(resultado); };
    socket.once('error', (e) => { clearTimeout(temporizador); socket.destroy(); reject(e); });
    socket.once('connect', () => {
      tcp = agora() - de;
      if (!seguro) terminar({ tcp_ms: umaCasa(tcp), tls_ms: null, total_ms: umaCasa(tcp), tls: null });
    });
    if (seguro) {
      socket.once('secureConnect', () => {
        const fim = agora() - de;
        terminar({ tcp_ms: umaCasa(tcp), tls_ms: umaCasa(fim - tcp), total_ms: umaCasa(fim), tls: socket.getProtocol() || null });
      });
    }
  });
}

/** Uma consulta trivial pelo cliente das rotas, ouvindo as idas que ela fez pelo fetch do motor. */
async function umPing(supabase, idasDeTodos) {
  const idas = [];
  const de = agora();
  try {
    const { error } = await comPrazo(
      escutarIdas((ida) => idas.push(ida), async () => supabase.from('users').select('id').limit(1)),
      PRAZO_MS,
      'ping',
    );
    idasDeTodos.push(...idas);
    return { ms: umaCasa(agora() - de), idas, erro: error ? erroCurto('ping', error) : null };
  } catch (e) {
    return { ms: null, idas, erro: erroCurto('ping', e) };
  }
}

const resumoDosPings = (pings) => ({
  ms: pings.map((p) => p.ms),
  // Cada ping passou pelo fetch do motor e pelo agente quente? `false` em todos = o cliente não usa o fetch da ligacaoQuente.
  pelo_agente_quente: pings.map((p) => p.idas.length > 0 && p.idas.every((i) => i.quente)),
  ...(pings.some((p) => p.erro) ? { erros: pings.map((p) => p.erro) } : {}),
});

/** O que a borda do Supabase disse nos cabeçalhos — só os da lista. */
function resumirCabecalhos(idas) {
  const colos = [...new Set(idas.map((i) => i.cabecalhos.get('cf-ray')).filter(Boolean).map((r) => r.split('-').pop()))];
  const saida = { colo: colos.length ? colos.join(',') : null };
  const ultima = idas.at(-1)?.cabecalhos;
  if (ultima) {
    for (const [nome, valor] of ultima) {
      if (CABECALHOS_DA_BORDA.includes(nome) || CABECALHO_DE_REGIAO.test(nome)) saida[nome] = String(valor).slice(0, 80);
    }
  }
  // Tempo que a própria borda diz ter gasto (se ela disser), ida a ida: separa o tempo do servidor do tempo da rede.
  const tempos = {};
  for (const { cabecalhos } of idas) {
    for (const [nome, valor] of cabecalhos) {
      if (CABECALHO_DE_TEMPO.test(nome)) (tempos[nome] ||= []).push(String(valor).slice(0, 20));
    }
  }
  if (Object.keys(tempos).length) saida.tempos_da_borda = tempos;
  return saida;
}

function opcoesDoDespachante(d) {
  if (!d) return null;
  const simbolo = Object.getOwnPropertySymbols(d).find((s) => s.description === 'options');
  return simbolo ? d[simbolo] : null;
}

function ligacoesCom(d, origem) {
  try {
    const s = d?.stats?.[origem];
    return s ? { abertas: s.connected, livres: s.free, em_uso: s.running, na_fila: s.pending } : { abertas: 0 };
  } catch {
    return null;
  }
}

/** Prova de que o agente da ligação quente está valendo NESTE processo, com os prazos em uso. */
function medirDespachante(origem) {
  const global = globalThis[SIMBOLO_DO_DESPACHANTE] || null;
  const quente = agenteQuente();
  const opcoesQuente = opcoesDoDespachante(quente);
  return {
    agente_quente: !!quente,
    // Falso de propósito: o agente quente vai pedido a pedido, só no Supabase; o global (fal, RevenueCat, push) fica no padrão.
    global_e_o_quente: !!quente && global === quente,
    mesma_classe_do_global: !!quente && !!global && quente instanceof global.constructor,
    ociosa_ms: opcoesQuente?.keepAliveTimeout ?? null,
    vida_maxima_ms: opcoesQuente?.keepAliveMaxTimeout ?? null,
    ociosa_do_global_ms: opcoesDoDespachante(global)?.keepAliveTimeout ?? (global ? OCIOSA_PADRAO_DO_UNDICI_MS : null),
    ligacoes_com_o_supabase: ligacoesCom(quente, origem),
    node: process.version,
    undici: process.versions.undici || null,
  };
}

/** A parte mais lenta do /api/inicio (o direito à figurinha: várias idas em fila), isolada. Não há função de explain no banco. */
async function medirConsultaReal(userId) {
  // eslint-disable-next-line global-require
  const { temDireito } = require('./direitoBrilhante');
  const idas = [];
  const de = agora();
  try {
    await comPrazo(escutarIdas((ida) => idas.push(ida), async () => temDireito(userId)), PRAZO_MS * 2, 'consulta_real');
    return { nome: 'brilhante (direito à figurinha)', ms: umaCasa(agora() - de), idas: idas.length, idas_ms: idas.map((i) => umaCasa(i.ms)), explain: 'sem função de explain no banco' };
  } catch (e) {
    return { nome: 'brilhante (direito à figurinha)', ms: null, idas: idas.length, erro: erroCurto('consulta_real', e) };
  }
}

/**
 * Mede o caminho até o banco, por partes, em sequência (uma parte nunca disputa a rede com a outra).
 * @param {{ supabase: object, url: string, userId?: string|null }} o  `userId` liga a consulta real (a do Início dessa pessoa).
 */
async function medirBanco({ supabase, url, userId = null }) {
  const alvo = new URL(url);
  const resultado = { medido_em: new Date().toISOString(), revisao: process.env.K_REVISION || null };
  const ligacoesAntes = ligacoesCom(agenteQuente(), alvo.origin);

  try { resultado.dns = await medirDns(alvo.hostname); } catch (e) { resultado.dns = { erro: erroCurto('dns', e) }; }
  try {
    resultado.tcp_tls = await medirLigacaoNova(alvo, resultado.dns.ip || alvo.hostname);
  } catch (e) {
    resultado.tcp_tls = { erro: erroCurto('tcp_tls', e) };
  }

  const idas = [];
  const seguidos = [];
  for (let i = 0; i < PINGS; i += 1) seguidos.push(await umPing(supabase, idas)); // eslint-disable-line no-await-in-loop
  resultado.ping_x5 = resumoDosPings(seguidos);

  const de = agora();
  const juntos = await Promise.all(Array.from({ length: PINGS }, () => umPing(supabase, idas)));
  resultado.ping_x5_paralelo = { total_ms: umaCasa(agora() - de), ...resumoDosPings(juntos) };

  resultado.cabecalhos = resumirCabecalhos(idas);
  resultado.despachante = {
    estado: [...seguidos, ...juntos].every((p) => p.idas.length > 0 && p.idas.every((i) => i.quente)) ? 'quente' : 'padrao',
    ...medirDespachante(alvo.origin),
    ligacoes_antes: ligacoesAntes,
  };
  if (userId) resultado.consulta_real = await medirConsultaReal(userId);
  return resultado;
}

/** A linha única do arranque: o Cloud Run conta a história sem ninguém chamar a rota. */
function linhaDoArranque(r) {
  const ms = (v) => (v == null ? '?' : `${v}ms`);
  return `[saude-banco] dns=${ms(r.dns?.ms)} tls=${ms(r.tcp_tls?.total_ms)} ping=[${(r.ping_x5?.ms || []).map((v) => v ?? '?').join(',')}]`
    + ` paralelo=${ms(r.ping_x5_paralelo?.total_ms)} colo=${r.cabecalhos?.colo || '?'} despachante=${r.despachante?.estado || '?'}`
    + ` ligacoes=${r.despachante?.ligacoes_com_o_supabase?.abertas ?? '?'}`;
}

/**
 * Roda o medidor uma vez (sem a consulta real: no arranque não há pessoa) e escreve a linha. Nunca derruba o arranque e nunca
 * espera mais que `prazoMs` no total: um banco que não responde vira "não mediu", não uma medição pendurada no processo.
 */
async function medirNoArranque({ supabase, url, log = console.log, prazoMs = PRAZO_DO_ARRANQUE_MS }) {
  try {
    log(linhaDoArranque(await comPrazo(medirBanco({ supabase, url }), prazoMs, 'medidor do arranque')));
  } catch (e) {
    log(`[saude-banco] não mediu: ${erroCurto('arranque', e)}`);
  }
}

module.exports = { medirBanco, linhaDoArranque, medirNoArranque, resumirCabecalhos };
