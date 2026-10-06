// ═══════════════════════════════════════════════════════════════════════════════
// A PINTURA POR PEDIDO, NÃO POR CPU OCIOSA.
//
// No Cloud Run a CPU só existe enquanto um pedido está aberto. A pintura em segundo plano
// roda DEPOIS de responder, então sem "CPU sempre alocada" (~R$250/mês, recusada)
// ela só anda enquanto o app consulta. O padrão certo do Cloud Run: o trabalho roda
// DENTRO de um pedido, e quem faz esse pedido é o Cloud Tasks. Custo ≈ zero (1 milhão de
// operações grátis por mês) e, se o processo reiniciar no meio, a tarefa é repetida sozinha.
//
// Este módulo só cuida de DUAS coisas: (1) enfileirar a tarefa de uma pintura; (2) conferir que
// o pedido que chega em POST /api/interno/pintar/:jobId veio mesmo do Cloud Tasks. Quem pinta
// continua sendo routes/auth.js (pintarFigurinha); quem sabe de estado é utils/geracaoJobs.js.
//
// LIGADO só com as TRÊS variáveis (senão a fila em memória de sempre, como no dev/local):
//   CLOUD_TASKS_QUEUE  projects/<projeto>/locations/<região>/queues/futty-pintura
//   URL_DO_SERVICO     https://<serviço>.run.app — para onde a tarefa bate e a audiência do token
//   INTERNO_SEGREDO    o segredo que a tarefa leva no cabeçalho x-futty-interno
// A URL vem SEMPRE da variável, nunca do Host do pedido: um Host forjado mandaria o segredo e o
// token para fora.
//
// SEGURANÇA: nenhum log daqui imprime o segredo nem o token.
// ═══════════════════════════════════════════════════════════════════════════════
const crypto = require('node:crypto');
const { HttpError } = require('./http');

const CABECALHO = 'x-futty-interno';
const FILA_FORMATO = /^projects\/[^/\s]+\/locations\/[^/\s]+\/queues\/[^/\s]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// O Cloud Run corta o pedido aos 300 s (padrão); a tarefa espera um pouco mais para o 504 dele chegar primeiro.
const PRAZO_DA_TAREFA_S = 320;
const ALREADY_EXISTS = 6; // código gRPC: a tarefa com este nome já existe (enfileirar é idempotente)

const limpo = (v) => String(v ?? '').trim();

/** A configuração, ou null se faltar qualquer uma das três (ou se a URL/fila vierem malformadas). */
function configuracao() {
  const fila = limpo(process.env.CLOUD_TASKS_QUEUE);
  const alvo = limpo(process.env.URL_DO_SERVICO).replace(/\/+$/, '');
  const segredo = limpo(process.env.INTERNO_SEGREDO);
  if (!fila || !alvo || !segredo) return null;
  if (!FILA_FORMATO.test(fila)) return null;
  const local = process.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(alvo);
  if (!local && !/^https:\/\/[^/\s]+$/.test(alvo)) return null;
  return { fila, alvo, segredo };
}

const ativas = () => configuracao() !== null;

/** Para o aviso do arranque: alguma das três está preenchida mas a configuração não fecha? Devolve o que falta. */
function configuracaoIncompleta() {
  const temAlguma = ['CLOUD_TASKS_QUEUE', 'URL_DO_SERVICO', 'INTERNO_SEGREDO'].some((k) => limpo(process.env[k]));
  if (!temAlguma || configuracao()) return null;
  const faltam = ['CLOUD_TASKS_QUEUE', 'URL_DO_SERVICO', 'INTERNO_SEGREDO'].filter((k) => !limpo(process.env[k]));
  return faltam.length ? `faltam ${faltam.join(', ')}` : 'CLOUD_TASKS_QUEUE (projects/…/locations/…/queues/…) ou URL_DO_SERVICO (https://…) malformadas';
}

// ── Quem é a conta de serviço (o e-mail que o token OIDC carrega) ─────────────

let emailEmCache = null;

/** Env `CLOUD_TASKS_SA_EMAIL` se existir; senão a conta do próprio Cloud Run, perguntada ao servidor de metadados. */
async function emailDaConta() {
  const env = limpo(process.env.CLOUD_TASKS_SA_EMAIL);
  if (env) return env;
  if (emailEmCache) return emailEmCache;
  const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email', {
    headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.timeout(2000),
  });
  if (!r.ok) throw new Error(`metadados ${r.status}`);
  emailEmCache = limpo(await r.text());
  return emailEmCache;
}

// ── Enfileirar ───────────────────────────────────────────────────────────────

let clienteTarefas = null;

function cliente() {
  if (!clienteTarefas) {
    // Só aqui (e só com as variáveis ligadas): o dev, o local e os testes nunca carregam o SDK do Google.
    // eslint-disable-next-line global-require
    const { CloudTasksClient } = require('@google-cloud/tasks');
    clienteTarefas = new CloudTasksClient();
  }
  return clienteTarefas;
}

/**
 * Cria a tarefa que vai bater em POST /api/interno/pintar/:jobId. O nome é `pintura-<jobId>`: um
 * segundo enfileiramento do mesmo job não cria outra tarefa (ALREADY_EXISTS conta como sucesso).
 * O corpo leva o que só o pedido original sabia (IP e origem, para o log de abuso); quem pinta, o
 * uniforme e o direito a tarefa lê da tabela e do banco, não do corpo.
 * Lança se o Cloud Tasks recusar (permissão, API desligada, rede) — quem chama cai na fila em memória.
 */
async function enfileirar({ jobId, ip = null, origem = null }) {
  const cfg = configuracao();
  if (!cfg) throw new Error('Cloud Tasks não configurado.');
  if (!UUID.test(String(jobId))) throw new Error('jobId inválido.');
  const nome = `${cfg.fila}/tasks/pintura-${jobId}`;
  const tarefa = {
    name: nome,
    dispatchDeadline: { seconds: PRAZO_DA_TAREFA_S },
    httpRequest: {
      httpMethod: 'POST',
      url: `${cfg.alvo}/api/interno/pintar/${jobId}`,
      headers: { 'Content-Type': 'application/json', [CABECALHO]: cfg.segredo },
      body: Buffer.from(JSON.stringify({ jobId, ip, origem })),
      oidcToken: { serviceAccountEmail: await emailDaConta(), audience: cfg.alvo },
    },
  };
  try {
    await cliente().createTask({ parent: cfg.fila, task: tarefa });
  } catch (e) {
    if (e?.code !== ALREADY_EXISTS) throw e;
  }
  return nome;
}

// ── Conferir quem bate ───────────────────────────────────────────────────────

/** Comparação em tempo constante (o hash iguala os tamanhos, que o timingSafeEqual exige). */
function segredoConfere(recebido) {
  const esperado = limpo(process.env.INTERNO_SEGREDO);
  if (!esperado || typeof recebido !== 'string' || !recebido) return false;
  const h = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(recebido), h(esperado));
}

const verificadorGoogle = async (token, audience) => {
  // eslint-disable-next-line global-require
  const { OAuth2Client } = require('google-auth-library');
  const ticket = await new OAuth2Client().verifyIdToken({ idToken: token, audience });
  return ticket.getPayload();
};
let verificador = verificadorGoogle;

const tokenDoPedido = (req) => {
  const h = String(req.headers?.authorization || '');
  return /^Bearer /i.test(h) ? h.slice(7).trim() : '';
};

const recusar = (motivo) => {
  console.warn(`[interno] 401 em /api/interno/pintar: ${motivo}`);
  return new HttpError(401, 'Não autorizado.');
};

/**
 * O pedido veio do Cloud Tasks? O segredo (x-futty-interno) é OBRIGATÓRIO sempre. Com o Cloud Tasks
 * configurado, o token OIDC também é obrigatório e tem de ser da conta de serviço do próprio Cloud Run,
 * com a audiência = URL_DO_SERVICO; fora disso (local, testes) um token, se vier, também é conferido.
 * Qualquer falha: 401 sem dizer qual (o motivo vai só para o log).
 */
async function autorizar(req) {
  if (!segredoConfere(req.get(CABECALHO))) throw recusar('segredo ausente ou errado');
  const token = tokenDoPedido(req);
  const cfg = configuracao();
  if (!token) {
    if (cfg) throw recusar('token OIDC ausente');
    return;
  }
  if (!cfg) throw recusar('token OIDC sem URL_DO_SERVICO para conferir a audiência');
  let dados;
  try {
    dados = await verificador(token, cfg.alvo);
  } catch {
    // Motivo fixo, nunca a mensagem do Google: ela cita trechos do token.
    throw recusar('token OIDC inválido (assinatura, validade ou audiência)');
  }
  if (!dados || dados.email_verified === false || dados.email !== await emailDaConta()) {
    throw recusar('token OIDC de outra conta de serviço');
  }
}

// ── Só para os testes ────────────────────────────────────────────────────────

const _definirCliente = (c) => { clienteTarefas = c; };
const _definirVerificador = (f) => { verificador = f; };
const _zerar = () => { clienteTarefas = null; emailEmCache = null; verificador = verificadorGoogle; };

module.exports = {
  CABECALHO,
  PRAZO_DA_TAREFA_S,
  ativas,
  configuracao,
  configuracaoIncompleta,
  enfileirar,
  autorizar,
  segredoConfere,
  _definirCliente,
  _definirVerificador,
  _zerar,
};
