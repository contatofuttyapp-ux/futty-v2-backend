// ═══════════════════════════════════════════════════════════════════════════════
// A PINTURA DA FIGURINHA EM SEGUNDO PLANO.
//
// Por quê: a geração segura o pedido HTTP por ~45 s (~90 s com o retry da
// cabeça cortada) e a Cloudflare corta um pedido aos 100 s. Por isso o POST de gerar
// devolve na hora `{ jobId, estimativaSegundos }`, a pintura roda aqui — numa fila
// em memória do PRÓPRIO processo, uma por vez por usuário — e o app consulta
// GET /api/figurinha/job/:id. O trabalho em si (as chamadas à fal pela
// utils/falFila.js, o auditor da coroa, o débito do direito) é o da
// função `pintarFigurinha` de routes/auth.js; este módulo só cuida de
// QUEM está pintando, EM QUE PÉ, e do que fazer quando acaba ou quando o processo
// morre no meio.
//
// O registro durável é a tabela `geracoes_jobs` (migração 069). Sem ela o motor
// continua pintando — a fila vive em memória —, só perde o que sobrevive a um
// reinício (e a consulta vinda de outra instância do Cloud Run).
//
// LEI DA CASA: nunca gastar geração sem entregar. O direito só é debitado dentro
// da pintura, DEPOIS de a figurinha estar gravada; um job que morre antes disso
// (reinício, deploy, fal fora do ar) termina 'falhou' e não custa nada a ninguém.
//
// O QUE ESTE MÓDULO NÃO FAZ: não escolhe kit, não checa direito, não fala com a fal.
//
// COM O CLOUD TASKS LIGADO (utils/tarefasPintura.js) o POST só REGISTRA o job e
// enfileira uma tarefa; quem pinta é POST /api/interno/pintar/:jobId, DENTRO de um pedido (o Cloud
// Run só dá CPU enquanto há pedido). `reivindicar` é a porta de entrada desse pedido — atômica e
// idempotente — e `adotar` põe o job na memória DESTE processo para ele pintar.
// ═══════════════════════════════════════════════════════════════════════════════
const crypto = require('node:crypto');
const { supabase } = require('./db');
const { HttpError } = require('./http');
const { avatarEhFigurinhaNossa } = require('./figurinhaRegra');
const tarefasPintura = require('./tarefasPintura');

const ESTADOS_ATIVOS = ['na_fila', 'em_andamento'];
const ETAPAS = ['preparando', 'pintando', 'acabamento', 'pronta'];

const PADRAO_S = 45; // sem histórico nenhum, a estimativa de sempre
const JANELA_MEDIANA = 50; // "as últimas 50 gerações"
const MEDIANA_MIN_S = 10;
const MEDIANA_MAX_S = 240;
const CACHE_ESTIMATIVA_MS = 60 * 1000;
const TETO_PROGRESSO = 0.9; // a barra segura em 90% até existir a imagem

// Batimento: o processo que pinta renova `atualizado_em` a cada 10 s. Uma pintura
// "em andamento" sem batimento há mais de 60 s é de um processo que morreu.
const BATIMENTO_MS = 10 * 1000;
const SEM_BATIMENTO_MS = 60 * 1000;
// Com o Cloud Tasks, uma pintura parada (processo morto) NÃO está perdida: a tarefa é repetida (10, 20 e 40 s
// depois). Só vale dar por interrompida passado o último prazo de repetição — senão a consulta do app marcaria
// 'falhou' no meio da espera e a repetição acharia o job já encerrado.
const SEM_BATIMENTO_TAREFAS_MS = 5 * 60 * 1000;
// Quem atende a tarefa retoma uma pintura 'em andamento' sem batimento há mais de 40 s (4 batimentos perdidos).
// Menos que os 60 s acima de propósito: a 3ª repetição do Cloud Tasks cai ~70 s depois da queda.
const RECLAMAR_APOS_MS = 40 * 1000;
const janelaSemBatimento = () => (tarefasPintura.ativas() ? SEM_BATIMENTO_TAREFAS_MS : SEM_BATIMENTO_MS);

const MSG_INTERROMPIDA = 'A pintura foi interrompida (o servidor reiniciou). Nada foi cobrado. É só tocar em gerar de novo.';
const MSG_GENERICA = 'Não deu desta vez. Tente de novo.';
const CODIGO_INTERROMPIDA = 'GERACAO_INTERROMPIDA';

// ── Estado deste processo ────────────────────────────────────────────────────
const jobs = new Map(); // id → job (os deste processo; saem da memória depois de um tempo)
const ativoPorUsuario = new Map(); // userId → job em curso
let duracoesRecentes = []; // ms das últimas pinturas prontas DESTE processo (plano B da mediana)
let cacheEstimativa = { em: 0, valor: null };
let tabelaOk = true; // vira false quando o PostgREST diz que a tabela não existe (069 por aplicar)
const GUARDA_NA_MEMORIA_MS = 30 * 60 * 1000;

// ── Contas puras (testadas à parte; o app tem a mesma regra em utils/progressoPintura.js) ─────────────

/** Mediana, em segundos, das durações (ms) recebidas; sem nenhuma, `padrao`. */
function medianaSegundos(duracoesMs, padrao = PADRAO_S) {
  const v = (duracoesMs || []).map(Number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!v.length) return padrao;
  const meio = Math.floor(v.length / 2);
  const ms = v.length % 2 ? v[meio] : (v[meio - 1] + v[meio]) / 2;
  return Math.min(MEDIANA_MAX_S, Math.max(MEDIANA_MIN_S, Math.round(ms / 1000)));
}

/**
 * Quanto da barra está cheio (0 a 1). Avança pelo tempo estimado até 90% e segura
 * ali; só 'pronta' (a imagem existe) chega a 1. 'falhou' não tem barra.
 */
function progressoDaPintura({ estado, decorridoMs, estimativaSegundos }) {
  if (estado === 'pronta') return 1;
  if (estado === 'falhou') return 0;
  const total = Math.max(1, (Number(estimativaSegundos) || PADRAO_S) * 1000);
  const fracao = Math.max(0, Number(decorridoMs) || 0) / total;
  return Math.min(TETO_PROGRESSO, fracao * TETO_PROGRESSO);
}

// ── Tabela ───────────────────────────────────────────────────────────────────

/** O erro do PostgREST quer dizer "esta tabela não existe" (a 069 ainda não foi aplicada)? */
function tabelaNaoExiste(erro) {
  if (!erro) return false;
  if (erro.code === '42P01' || erro.code === 'PGRST205') return true;
  return /geracoes_jobs/i.test(erro.message || '') && /does not exist|schema cache|could not find/i.test(erro.message || '');
}

/** Trata o erro de uma operação na tabela: sem tabela, desliga e avisa UMA vez; outro erro, só registra. */
function tratarErroDaTabela(erro, o_que) {
  if (tabelaNaoExiste(erro)) {
    if (tabelaOk) {
      tabelaOk = false;
      console.warn('[geracao-jobs] tabela geracoes_jobs ausente (migração 069 por correr) — a fila segue só em memória.');
    }
    return;
  }
  console.warn(`[geracao-jobs] ${o_que} falhou:`, erro?.message || erro);
}

/** Uma escrita na tabela, na ordem em que foram pedidas, e que nunca lança. */
function gravar(job, patch) {
  job.escrita = job.escrita.then(async () => {
    if (!tabelaOk) return;
    try {
      const { error } = await supabase
        .from('geracoes_jobs')
        .update({ ...patch, atualizado_em: new Date().toISOString() })
        .eq('id', job.id);
      if (error) tratarErroDaTabela(error, 'gravar');
    } catch (e) {
      tratarErroDaTabela(e, 'gravar');
    }
  });
  return job.escrita;
}

// ── A estimativa ─────────────────────────────────────────────────────────────

/** Mediana da duração das últimas 50 pinturas prontas (45 s sem histórico). Em cache por 1 min; nunca lança. */
async function estimativaSegundos() {
  if (cacheEstimativa.valor != null && Date.now() - cacheEstimativa.em < CACHE_ESTIMATIVA_MS) return cacheEstimativa.valor;
  let duracoes = null;
  if (tabelaOk) {
    try {
      const { data, error } = await supabase
        .from('geracoes_jobs')
        .select('duracao_ms')
        .eq('estado', 'pronta')
        .gt('duracao_ms', 0)
        .order('terminado_em', { ascending: false })
        .limit(JANELA_MEDIANA);
      if (error) tratarErroDaTabela(error, 'ler a mediana');
      else duracoes = (data || []).map((l) => l.duracao_ms);
    } catch (e) {
      tratarErroDaTabela(e, 'ler a mediana');
    }
  }
  if (!duracoes?.length) duracoes = duracoesRecentes;
  const valor = medianaSegundos(duracoes);
  cacheEstimativa = { em: Date.now(), valor };
  return valor;
}

function registrarDuracao(ms) {
  duracoesRecentes = [...duracoesRecentes, ms].slice(-JANELA_MEDIANA);
  cacheEstimativa = { em: 0, valor: null };
}

// ── A vista que o app recebe ─────────────────────────────────────────────────

function visaoDe({ estado, etapa, estimativaS, inicioMs, fimMs, avatarUrl, kitId, figurinhaAtiva, erro, codigo, status }, agora = Date.now()) {
  const decorridoMs = Math.max(0, (fimMs || agora) - inicioMs);
  const estimativa = estimativaS || PADRAO_S;
  const v = {
    estado,
    etapa,
    progresso: Number(progressoDaPintura({ estado, decorridoMs, estimativaSegundos: estimativa }).toFixed(3)),
    estimativaSegundos: estimativa,
    decorridoSegundos: Math.round(decorridoMs / 1000),
    avatar_url: avatarUrl || null,
  };
  if (estado === 'pronta') {
    v.kit = kitId || null;
    v.figurinha_ativa = !!figurinhaAtiva;
  }
  if (estado === 'falhou') {
    v.erro = erro || MSG_GENERICA;
    v.code = codigo || null;
    v.status = status || 500;
  }
  return v;
}

const visaoDoJob = (j, agora) => visaoDe({
  estado: j.estado,
  etapa: j.etapa,
  estimativaS: j.estimativaSegundos,
  inicioMs: j.iniciadoEm || j.criadoEm,
  fimMs: j.terminadoEm,
  avatarUrl: j.avatarUrl,
  kitId: j.kitId,
  figurinhaAtiva: j.resultado?.figurinha_ativa,
  erro: j.erro,
  codigo: j.codigo,
  status: j.status,
}, agora);

const visaoDaLinha = (l, agora) => visaoDe({
  estado: l.estado,
  etapa: l.etapa,
  estimativaS: l.estimativa_s,
  inicioMs: new Date(l.iniciado_em || l.criado_em).getTime(),
  fimMs: l.terminado_em ? new Date(l.terminado_em).getTime() : null,
  avatarUrl: l.avatar_url,
  kitId: l.kit_id,
  figurinhaAtiva: avatarEhFigurinhaNossa(l.avatar_url),
  erro: l.erro,
  codigo: l.erro_codigo,
  status: l.erro_status,
}, agora);

// ── O ciclo do job ───────────────────────────────────────────────────────────

const estaAtivo = (job) => !!job && ESTADOS_ATIVOS.includes(job.estado);

/**
 * Já há uma pintura desta pessoa em curso? Devolve `{ id, estimativaSegundos }` ou null.
 * Primeiro na memória (o caso de sempre: o toque duplo), depois na tabela (outra
 * instância do Cloud Run pintando); só vale a que bateu o coração há menos de 60 s.
 */
async function emCursoDoUsuario(userId) {
  const local = ativoPorUsuario.get(userId);
  if (estaAtivo(local)) return { id: local.id, estimativaSegundos: local.estimativaSegundos };
  if (!tabelaOk) return null;
  try {
    const desde = new Date(Date.now() - janelaSemBatimento()).toISOString();
    const { data, error } = await supabase
      .from('geracoes_jobs')
      .select('id, estimativa_s')
      .eq('user_id', userId)
      .in('estado', ESTADOS_ATIVOS)
      .gte('atualizado_em', desde)
      .order('criado_em', { ascending: false })
      .limit(1);
    if (error) tratarErroDaTabela(error, 'procurar pintura em curso');
    else if (data?.[0]) return { id: data[0].id, estimativaSegundos: data[0].estimativa_s || PADRAO_S };
  } catch (e) {
    tratarErroDaTabela(e, 'procurar pintura em curso');
  }
  return null;
}

/**
 * Reserva a vez desta pessoa — SÍNCRONO, de propósito: dois toques seguidos não
 * passam os dois (quem chega depois recebe o job do primeiro).
 * @returns {{ job: object, jaEmAndamento: boolean }}
 */
function novoJob(campos) {
  return {
    id: crypto.randomUUID(),
    userId: null,
    kitId: null,
    estado: 'na_fila',
    etapa: 'preparando',
    estimativaSegundos: PADRAO_S,
    criadoEm: Date.now(),
    iniciadoEm: null,
    terminadoEm: null,
    duracaoMs: null,
    avatarUrl: null,
    resultado: null,
    erro: null,
    codigo: null,
    status: null,
    erroOriginal: null,
    ultimaConsulta: 0,
    persistido: false, // a linha em geracoes_jobs existe? (a tarefa do Cloud Tasks só vale com ela)
    viaTarefa: false, // este processo pinta a pedido de uma tarefa do Cloud Tasks (bloco 2-A2)
    escrita: Promise.resolve(),
    promessa: null,
    ...campos,
  };
}

function reservar({ userId, kitId }) {
  const existente = ativoPorUsuario.get(userId);
  if (estaAtivo(existente)) return { job: existente, jaEmAndamento: true };
  const job = novoJob({ userId, kitId });
  jobs.set(job.id, job);
  ativoPorUsuario.set(userId, job);
  return { job, jaEmAndamento: false };
}

/** Anota a estimativa e cria a linha na tabela. Depois disto o POST pode responder. */
async function registrar(job) {
  job.estimativaSegundos = await estimativaSegundos();
  job.escrita = job.escrita.then(async () => {
    if (!tabelaOk) return;
    try {
      const { error } = await supabase.from('geracoes_jobs').insert({
        id: job.id,
        user_id: job.userId,
        estado: job.estado,
        etapa: job.etapa,
        kit_id: job.kitId,
        estimativa_s: job.estimativaSegundos,
        criado_em: new Date(job.criadoEm).toISOString(),
        // Explícito (e não só o DEFAULT now() da coluna): é por ele que a pintura enfileirada, sem batimento ainda, conta como "em curso".
        atualizado_em: new Date(job.criadoEm).toISOString(),
      });
      if (error) tratarErroDaTabela(error, 'registrar');
      else job.persistido = true;
    } catch (e) {
      tratarErroDaTabela(e, 'registrar');
    }
  });
  await job.escrita;
  return job;
}

// ── Bloco 2-A2: a pintura que anda por pedido (Cloud Tasks) ──────────────────

/**
 * O POST enfileirou a tarefa: dali em diante quem sabe do job é a tabela (e quem pinta é o pedido da tarefa,
 * neste processo ou em outro). Solta a reserva em memória — senão ela nunca seria liberada aqui — e a consulta
 * e o "já há uma pintura em curso" passam a olhar a linha.
 */
function entregarATarefa(job) {
  if (ativoPorUsuario.get(job.userId) === job) ativoPorUsuario.delete(job.userId);
  jobs.delete(job.id);
}

/**
 * Porta de entrada do pedido da tarefa: pega o job para pintar, de forma ATÔMICA (um UPDATE condicional — dois
 * pedidos ao mesmo tempo não pegam os dois) e IDEMPOTENTE:
 *   { resultado: 'ok', linha }        peguei (era 'na_fila', ou 'em_andamento' de um processo que morreu)
 *   { resultado: 'concluido', linha } já terminou ('pronta' ou 'falhou'): não repinta
 *   { resultado: 'em_curso' }         outro processo pinta agora, com batimento fresco
 *   { resultado: 'inexistente' }      sem linha (ou sem a tabela)
 * Erro do banco SOBE (o pedido vira 5xx e o Cloud Tasks tenta de novo): engolir aqui perderia a pintura.
 */
async function reivindicar(jobId) {
  if (!tabelaOk) return { resultado: 'inexistente' };
  const agora = new Date().toISOString();
  const pegar = { estado: 'em_andamento', etapa: 'preparando', iniciado_em: agora, atualizado_em: agora };
  try {
    let r = await supabase.from('geracoes_jobs').update(pegar).eq('id', jobId).eq('estado', 'na_fila').select('*');
    if (r.error) throw r.error;
    if (r.data?.length) return { resultado: 'ok', linha: r.data[0] };

    const limite = new Date(Date.now() - RECLAMAR_APOS_MS).toISOString();
    r = await supabase.from('geracoes_jobs').update(pegar).eq('id', jobId).eq('estado', 'em_andamento').lt('atualizado_em', limite).select('*');
    if (r.error) throw r.error;
    if (r.data?.length) return { resultado: 'ok', linha: r.data[0], retomada: true };

    const lida = await supabase.from('geracoes_jobs').select('*').eq('id', jobId).maybeSingle();
    if (lida.error) throw lida.error;
    if (!lida.data) return { resultado: 'inexistente' };
    if (!ESTADOS_ATIVOS.includes(lida.data.estado)) return { resultado: 'concluido', linha: lida.data };
    return { resultado: 'em_curso', linha: lida.data };
  } catch (e) {
    if (tabelaNaoExiste(e)) { tratarErroDaTabela(e, 'reivindicar'); return { resultado: 'inexistente' }; }
    console.warn('[geracao-jobs] reivindicar falhou:', e?.message || e);
    throw e;
  }
}

/** O job que `reivindicar` pegou, já na memória DESTE processo — daqui ele é pintado por `iniciar`, como sempre. */
function adotar(linha) {
  const job = novoJob({
    id: linha.id,
    userId: linha.user_id,
    kitId: linha.kit_id,
    estado: 'em_andamento',
    estimativaSegundos: linha.estimativa_s || PADRAO_S,
    criadoEm: new Date(linha.criado_em).getTime(),
    persistido: true,
    viaTarefa: true,
  });
  jobs.set(job.id, job);
  ativoPorUsuario.set(job.userId, job);
  return job;
}

/** A etapa mudou (preparando → pintando → acabamento). Não espera a tabela. */
function mudarEtapa(job, nome) {
  if (!ETAPAS.includes(nome) || job.estado === 'pronta' || job.estado === 'falhou') return;
  job.etapa = nome;
  gravar(job, { etapa: nome });
}

function esquecerDepois(job) {
  const t = setTimeout(() => jobs.delete(job.id), GUARDA_NA_MEMORIA_MS);
  t.unref?.();
}

/**
 * Começa a pintar em segundo plano. `executor({ etapa })` é a pintura (devolve o
 * que o POST devolvia antes: { avatar_url, kit, figurinha_ativa… }); lançar = falhou.
 * `job.promessa` nunca rejeita — resolve com o próprio job, já terminado (quem
 * precisa da resposta antiga, o app que não conhece o job, espera por ela).
 * `aoTerminar(job)` roda depois de gravado o desfecho (o push do "ficou pronta").
 */
function iniciar(job, executor, { aoTerminar } = {}) {
  job.promessa = (async () => {
    job.estado = 'em_andamento';
    job.iniciadoEm = Date.now();
    gravar(job, { estado: 'em_andamento', iniciado_em: new Date(job.iniciadoEm).toISOString() });
    const batimento = setInterval(() => gravar(job, {}), BATIMENTO_MS);
    batimento.unref?.();
    try {
      const resultado = await executor({ etapa: (nome) => mudarEtapa(job, nome) });
      job.terminadoEm = Date.now();
      job.duracaoMs = job.terminadoEm - job.iniciadoEm;
      job.resultado = resultado || {};
      job.avatarUrl = job.resultado.avatar_url || null;
      job.etapa = 'pronta';
      job.estado = 'pronta';
      registrarDuracao(job.duracaoMs);
      gravar(job, {
        estado: 'pronta',
        etapa: 'pronta',
        avatar_url: job.avatarUrl,
        terminado_em: new Date(job.terminadoEm).toISOString(),
        duracao_ms: job.duracaoMs,
      });
    } catch (err) {
      job.terminadoEm = Date.now();
      job.estado = 'falhou';
      job.erroOriginal = err;
      // Só a mensagem de uma HttpError é feita para a pessoa ler; o resto (fal, rede, banco) fica no log.
      job.erro = err instanceof HttpError ? err.message : MSG_GENERICA;
      job.codigo = err instanceof HttpError ? err.code || null : null;
      job.status = err instanceof HttpError ? err.status : 500;
      gravar(job, {
        estado: 'falhou',
        erro: job.erro,
        erro_codigo: job.codigo,
        erro_status: job.status,
        terminado_em: new Date(job.terminadoEm).toISOString(),
      });
    } finally {
      clearInterval(batimento);
      if (ativoPorUsuario.get(job.userId) === job) ativoPorUsuario.delete(job.userId);
      esquecerDepois(job);
    }
    await job.escrita;
    if (aoTerminar) {
      try { await aoTerminar(job); } catch (e) { console.warn('[geracao-jobs] aoTerminar falhou:', e.message); }
    }
    return job;
  })();
  return job.promessa;
}

// ── Consulta, reinício e desligamento ────────────────────────────────────────

/** Uma linha ativa cujo processo morreu vira 'falhou' (sem cobrar). Devolve a linha já atualizada. */
async function marcarInterrompida(linha, { aoMarcar } = {}) {
  const patch = {
    estado: 'falhou',
    erro: MSG_INTERROMPIDA,
    erro_codigo: CODIGO_INTERROMPIDA,
    erro_status: 503,
    terminado_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString(),
  };
  try {
    const { error } = await supabase.from('geracoes_jobs').update(patch).eq('id', linha.id).in('estado', ESTADOS_ATIVOS);
    if (error) tratarErroDaTabela(error, 'marcar interrompida');
  } catch (e) {
    tratarErroDaTabela(e, 'marcar interrompida');
  }
  if (aoMarcar) {
    try { await aoMarcar(linha.user_id); } catch { /* a leitura não pode cair por isto */ }
  }
  return { ...linha, ...patch };
}

/**
 * O estado de uma pintura, SÓ para o dono dela (outro usuário, id inventado ou
 * id que não existe: null → 404). Na memória primeiro; se foi outra instância (ou
 * antes de um reinício), na tabela — e uma pintura ativa sem batimento há mais de
 * 60 s é uma pintura que morreu.
 */
async function ler(jobId, userId, { aoInterromper } = {}) {
  const local = jobs.get(jobId);
  if (local) {
    if (local.userId !== userId) return null;
    local.ultimaConsulta = Date.now();
    return visaoDoJob(local);
  }
  if (!tabelaOk) return null;
  try {
    const { data, error } = await supabase.from('geracoes_jobs').select('*').eq('id', jobId).maybeSingle();
    if (error) { tratarErroDaTabela(error, 'ler o job'); return null; }
    if (!data || data.user_id !== userId) return null;
    let linha = data;
    if (ESTADOS_ATIVOS.includes(linha.estado) && Date.now() - new Date(linha.atualizado_em).getTime() > janelaSemBatimento()) {
      linha = await marcarInterrompida(linha, { aoMarcar: aoInterromper });
    }
    return visaoDaLinha(linha);
  } catch (e) {
    tratarErroDaTabela(e, 'ler o job');
    return null;
  }
}

/** No arranque do processo: o que ficou "em andamento" sem batimento é de um processo que morreu. */
async function varrerInterrompidas({ aoMarcar } = {}) {
  if (!tabelaOk) return 0;
  try {
    const limite = new Date(Date.now() - janelaSemBatimento()).toISOString();
    const { data, error } = await supabase
      .from('geracoes_jobs')
      .select('id, user_id')
      .in('estado', ESTADOS_ATIVOS)
      .lt('atualizado_em', limite);
    if (error) { tratarErroDaTabela(error, 'varrer interrompidas'); return 0; }
    for (const linha of data || []) await marcarInterrompida(linha, { aoMarcar });
    if (data?.length) console.log('[geracao-jobs] pinturas interrompidas por reinício marcadas como falhou:', data.length);
    return data?.length || 0;
  } catch (e) {
    tratarErroDaTabela(e, 'varrer interrompidas');
    return 0;
  }
}

/**
 * SIGTERM (deploy, escala do Cloud Run): o que está pintando aqui não termina. Marca
 * 'falhou' já — quem consulta vê a mensagem em segundos, em vez de esperar o prazo do
 * batimento. Se a pintura acabar de fato antes de o processo sair, o desfecho real
 * (pronta) escreve por cima.
 */
async function interromperTodas({ aoMarcar } = {}) {
  const ativos = [...jobs.values()].filter(estaAtivo);
  await Promise.all(ativos.map(async (job) => {
    if (job.viaTarefa) {
      // Pintura a pedido do Cloud Tasks: este processo vai morrer, o pedido cai e a tarefa é repetida. Devolve o job
      // à fila (sem batimento a esperar) e NÃO marca falha — marcar 'falhou' enterraria a repetição que vem aí.
      // Se a pintura acabar antes de o processo sair, o desfecho real (pronta) escreve por cima.
      await gravar(job, { estado: 'na_fila', etapa: 'preparando' });
      return;
    }
    job.estado = 'falhou';
    job.erro = MSG_INTERROMPIDA;
    job.codigo = CODIGO_INTERROMPIDA;
    job.status = 503;
    job.terminadoEm = Date.now();
    await gravar(job, { estado: 'falhou', erro: MSG_INTERROMPIDA, erro_codigo: CODIGO_INTERROMPIDA, erro_status: 503, terminado_em: new Date().toISOString() });
    if (aoMarcar) {
      try { await aoMarcar(job.userId); } catch { /* saindo */ }
    }
  }));
  return ativos.length;
}

/** Só para os testes: esquece tudo o que este processo sabe. */
function _zerar() {
  jobs.clear();
  ativoPorUsuario.clear();
  duracoesRecentes = [];
  cacheEstimativa = { em: 0, valor: null };
  tabelaOk = true;
}

module.exports = {
  medianaSegundos,
  progressoDaPintura,
  estimativaSegundos,
  emCursoDoUsuario,
  reservar,
  registrar,
  entregarATarefa,
  reivindicar,
  adotar,
  iniciar,
  ler,
  varrerInterrompidas,
  interromperTodas,
  MSG_INTERROMPIDA,
  CODIGO_INTERROMPIDA,
  PADRAO_S,
  TETO_PROGRESSO,
  SEM_BATIMENTO_MS,
  SEM_BATIMENTO_TAREFAS_MS,
  RECLAMAR_APOS_MS,
  _zerar,
};
