// Futty v2.0 — RODADA 29B (bloco 2-A2): a pintura da figurinha por PEDIDO (Cloud Tasks), não por CPU ociosa.
//
// A rota de verdade (routes/auth.js + utils/geracaoJobs.js + utils/tarefasPintura.js) por cima de um Supabase falso, com a FAL
// SIMULADA (nenhuma chamada de rede, custo zero) e o CLIENTE do Cloud Tasks SIMULADO (grava o que seria enfileirado). O que prova:
//   1. a configuração só liga com as três variáveis, bem formadas; o segredo é conferido em tempo constante;
//   2. POST /api/me/avatar/ai com o Cloud Tasks ligado só REGISTRA e ENFILEIRA (tarefa com nome por job, URL do serviço,
//      segredo, token OIDC, prazo) — a fal não é chamada ali, e o toque duplo não cria outra tarefa;
//   3. POST /api/interno/pintar/:jobId: 401 sem o segredo ou sem o token OIDC válido (e nada pinta); com os dois pinta DENTRO do
//      pedido, debita UMA vez e responde 200; idempotente (job já terminado → 200 sem repintar); 409 se outro processo pinta
//      com batimento fresco; retoma o job de um processo morto (batimento velho); 404 para job que não existe;
//   4. falha de pintura (cabeça cortada) é DESFECHO — 200, sem repetir (repetir pagaria a fal à toa) e sem cobrar;
//   5. o Cloud Tasks recusar o enfileiramento, ou faltar a tabela: cai na fila em memória; se a tarefa existir mesmo com o
//      erro, só pinta quem pegar o job (nunca duas pinturas);
//   6. o app já publicado (sem `assincrono`) segue pintando dentro do próprio pedido;
//   7. SIGTERM: a pintura a pedido da tarefa volta à fila (não vira 'falhou') — a repetição do Cloud Tasks a retoma; e uma
//      pintura parada só é dada por interrompida passados os 5 min das repetições.
//
// Uso: npm test  (ou: node --test tests/pintura-tarefas.test.js)
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { carregar, subir, injetar } = require('./_rotas');
const tarefas = require('../utils/tarefasPintura');

const USUARIO = '11111111-1111-1111-1111-111111111111';
const SUPABASE = 'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public';
const FILA = 'projects/futty-495914/locations/southamerica-east1/queues/futty-pintura';
const ALVO = 'https://futty-api-685039278359.southamerica-east1.run.app';
const SEGREDO = 'segredo-de-teste-com-mais-de-trinta-e-dois-caracteres';
const CONTA = 'futty-run@futty-495914.iam.gserviceaccount.com';
const TOKEN_BOM = 'token-oidc-bom';
const JOB_INEXISTENTE = '99999999-9999-9999-9999-999999999999';

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const adiada = () => { let resolver; const promessa = new Promise((res) => { resolver = res; }); return { promessa, resolver }; };
const atras = (segundos) => new Date(Date.now() - segundos * 1000).toISOString();
async function ate(condicao, ms = 4000) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    // eslint-disable-next-line no-await-in-loop
    if (await condicao()) return true;
    // eslint-disable-next-line no-await-in-loop
    await esperar(10);
  }
  return false;
}

async function recorteBom() {
  const w = 400; const h = 600; const buf = Buffer.alloc(w * h * 4, 0);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const dx = (x - w / 2) / 150; const dy = (y - h / 2) / 260;
    if (dx * dx + dy * dy <= 1) { const i = (y * w + x) * 4; buf[i] = 200; buf[i + 1] = 150; buf[i + 2] = 60; buf[i + 3] = 255; }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}
async function recorteCortado() {
  const w = 400; const h = 600; const buf = Buffer.alloc(w * h * 4, 0);
  for (let y = 0; y < 400; y += 1) for (let x = 100; x < 300; x += 1) { const i = (y * w + x) * 4; buf[i] = 200; buf[i + 1] = 150; buf[i + 2] = 60; buf[i + 3] = 255; }
  return sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

let foto; let bom; let cortado;
before(async () => {
  foto = await sharp({ create: { width: 600, height: 800, channels: 3, background: { r: 90, g: 120, b: 160 } } }).jpeg().toBuffer();
  bom = await recorteBom();
  cortado = await recorteCortado();
});

const VARIAVEIS = ['CLOUD_TASKS_QUEUE', 'URL_DO_SERVICO', 'INTERNO_SEGREDO', 'CLOUD_TASKS_SA_EMAIL', 'FAL_KEY', 'NODE_ENV'];
const guardadas = Object.fromEntries(VARIAVEIS.map((k) => [k, process.env[k]]));
function restaurarAmbiente() {
  for (const k of VARIAVEIS) { if (guardadas[k] === undefined) delete process.env[k]; else process.env[k] = guardadas[k]; }
  tarefas._zerar();
}
after(restaurarAmbiente);

/** Liga (ou não) o Cloud Tasks neste teste, com o cliente simulado e o verificador de token simulado. */
function ambiente(t, { tarefasLigadas = true } = {}) {
  for (const k of ['CLOUD_TASKS_QUEUE', 'URL_DO_SERVICO', 'INTERNO_SEGREDO', 'CLOUD_TASKS_SA_EMAIL']) delete process.env[k];
  process.env.FAL_KEY = 'teste-sem-rede';
  tarefas._zerar();
  const nuvem = { criadas: [], recusar: null, aoCriar: null };
  if (tarefasLigadas) {
    Object.assign(process.env, { CLOUD_TASKS_QUEUE: FILA, URL_DO_SERVICO: ALVO, INTERNO_SEGREDO: SEGREDO, CLOUD_TASKS_SA_EMAIL: CONTA });
    tarefas._definirCliente({
      createTask: async (pedido) => {
        if (nuvem.aoCriar) await nuvem.aoCriar(pedido);
        if (nuvem.recusar) throw nuvem.recusar;
        nuvem.criadas.push(pedido);
        return [{ name: pedido.task.name }];
      },
    });
    tarefas._definirVerificador(async (token, audience) => {
      if (token !== TOKEN_BOM || audience !== ALVO) throw new Error('token rejeitado');
      return { email: CONTA, email_verified: true };
    });
  }
  t.after(() => { tarefas._zerar(); for (const k of ['CLOUD_TASKS_QUEUE', 'URL_DO_SERVICO', 'INTERNO_SEGREDO', 'CLOUD_TASKS_SA_EMAIL']) delete process.env[k]; });
  return nuvem;
}

/** O mundo de um teste: rota de verdade, banco falso, fal simulada. `fal.portao` segura a pintura até o teste soltar. */
function mundo(t, { creditos = 2, opcoesBanco = {}, tarefasLigadas = true } = {}) {
  const nuvem = ambiente(t, { tarefasLigadas });
  const fal = { portao: null, chamadas: 0, recortes: [], erro: null };
  const falso = {
    gerarFigurinha: async () => {
      fal.chamadas += 1;
      if (fal.portao) await fal.portao.promessa;
      if (fal.erro) throw fal.erro;
      const recorteBuffer = fal.recortes[Math.min(fal.chamadas - 1, fal.recortes.length - 1)] || bom;
      return { recorteBuffer, custo: { usd: 0.112, chamadas: 2, semHeader: 0, parcelas: { v6: { usd: 0.11 } } }, tempos: {}, receita: 'v6' };
    },
    RECEITA: 'v6', V6_ENDPOINT: 'x', FIDELIDADE_V6: 'high', PASSADA1_ENDPOINT: 'x', PASSADA2_ENDPOINT: 'x', QUALIDADE: 'low', FIDELIDADE_PASSADA2: 'low', TAMANHO_1_5: '1024x1536',
  };
  const antiAbuso = {
    sha256Hex: (b) => crypto.createHash('sha256').update(b).digest('hex'),
    verificarTeto: async () => ({ bloqueado: false }),
    verificarFreeze: async () => ({ congelado: false }),
    registrarGeracao: async () => {},
  };
  const restaurar = [injetar('utils/geracaoFigurinha', falso), injetar('utils/antiAbusoIA', antiAbuso)];
  const { carregados, cliente, tabelas, notificacoes } = carregar({
    users: [{
      id: USUARIO, email: 'pintor@futtymock.com', foto_url: `${SUPABASE}/avatars/public/${USUARIO}-111.jpg`, foto_hash: antiAbuso.sha256Hex(foto),
      is_super_admin: false, created_at: '2026-01-01T00:00:00Z', brilhante_creditos: creditos, avatar_url: `${SUPABASE}/avatars/public/${USUARIO}-111.jpg`,
    }],
    user_avatar_slots: [],
    geracoes_jobs: [],
  }, ['routes/auth', 'routes/figurinhaJob', 'utils/geracaoJobs'], opcoesBanco);
  for (const r of restaurar.reverse()) r();
  cliente.storage = {
    from: () => ({
      upload: async () => ({ error: null }),
      createSignedUrl: async (caminho) => ({ data: { signedUrl: `https://assinada.exemplo/${caminho}` }, error: null }),
      download: async () => ({ data: new Blob([foto]), error: null }),
      remove: async () => ({ error: null }),
      getPublicUrl: (caminho) => ({ data: { publicUrl: `${SUPABASE}/avatars/${caminho}` } }),
    }),
  };
  carregados['utils/geracaoJobs']._zerar();
  const pedir = subir([carregados['routes/auth'], carregados['routes/figurinhaJob']], t);
  const usuario = () => tabelas.users.find((u) => u.id === USUARIO);
  return { fal, nuvem, pedir, tabelas, notificacoes, usuario, jobs: carregados['utils/geracaoJobs'] };
}

const gerar = (m, corpo = {}) => m.pedir('POST', '/api/me/avatar/ai', { kit: 'dark-gold', ...corpo }, USUARIO);
const consultar = (m, id) => m.pedir('GET', `/api/figurinha/job/${id}`, null, USUARIO);
const credenciais = { 'x-futty-interno': SEGREDO, authorization: `Bearer ${TOKEN_BOM}` };
const pintar = (m, id, cabecalhos = credenciais) => m.pedir('POST', `/api/interno/pintar/${id}`, { jobId: id, ip: '203.0.113.7', origem: null }, null, cabecalhos);
const linha = (m, id) => m.tabelas.geracoes_jobs.find((l) => l.id === id);

// ── 1: a configuração ────────────────────────────────────────────────────────

test('a configuração só liga com as TRÊS variáveis, bem formadas', (t) => {
  ambiente(t, { tarefasLigadas: false });
  assert.equal(tarefas.ativas(), false);
  assert.equal(tarefas.configuracaoIncompleta(), null, 'nada preenchido: sem aviso, é o dev/local');

  process.env.CLOUD_TASKS_QUEUE = FILA;
  assert.equal(tarefas.ativas(), false);
  assert.match(tarefas.configuracaoIncompleta(), /faltam URL_DO_SERVICO, INTERNO_SEGREDO/);

  process.env.URL_DO_SERVICO = `${ALVO}/`;
  process.env.INTERNO_SEGREDO = SEGREDO;
  assert.equal(tarefas.ativas(), true);
  assert.equal(tarefas.configuracao().alvo, ALVO, 'a barra do fim sai');
  assert.equal(tarefas.configuracaoIncompleta(), null);

  process.env.CLOUD_TASKS_QUEUE = 'futty-pintura';
  assert.equal(tarefas.ativas(), false, 'a fila tem de ser projects/…/locations/…/queues/…');
  assert.match(tarefas.configuracaoIncompleta(), /malformadas/);

  process.env.CLOUD_TASKS_QUEUE = FILA;
  process.env.URL_DO_SERVICO = 'http://futty.exemplo';
  assert.equal(tarefas.ativas(), false, 'só https (http só em localhost, fora de produção)');
  process.env.URL_DO_SERVICO = 'http://localhost:3001';
  process.env.NODE_ENV = 'development';
  assert.equal(tarefas.ativas(), true);
  process.env.NODE_ENV = 'production';
  assert.equal(tarefas.ativas(), false, 'em produção nem localhost');
});

test('o segredo é conferido por igualdade exata (e sem segredo configurado nada passa)', (t) => {
  ambiente(t);
  assert.equal(tarefas.segredoConfere(SEGREDO), true);
  assert.equal(tarefas.segredoConfere(`${SEGREDO}x`), false);
  assert.equal(tarefas.segredoConfere(SEGREDO.slice(0, -1)), false);
  assert.equal(tarefas.segredoConfere(''), false);
  assert.equal(tarefas.segredoConfere(undefined), false);
  delete process.env.INTERNO_SEGREDO;
  assert.equal(tarefas.segredoConfere(''), false, 'sem segredo configurado, o cabeçalho vazio não passa');
  assert.equal(tarefas.segredoConfere('qualquer'), false);
});

// ── 2: enfileirar ────────────────────────────────────────────────────────────

test('POST com o Cloud Tasks ligado: registra e ENFILEIRA — a fal não é chamada ali, e o toque duplo não cria outra tarefa', async (t) => {
  const m = mundo(t);
  const r = await gerar(m, { assincrono: true });
  assert.equal(r.status, 202);
  assert.match(r.json.jobId, /^[0-9a-f-]{36}$/);
  assert.equal(r.json.estimativaSegundos, 45);

  assert.equal(m.nuvem.criadas.length, 1);
  const { parent, task } = m.nuvem.criadas[0];
  assert.equal(parent, FILA);
  assert.equal(task.name, `${FILA}/tasks/pintura-${r.json.jobId}`, 'um nome por job: enfileirar duas vezes não duplica');
  assert.equal(task.httpRequest.httpMethod, 'POST');
  assert.equal(task.httpRequest.url, `${ALVO}/api/interno/pintar/${r.json.jobId}`);
  assert.equal(task.httpRequest.headers['x-futty-interno'], SEGREDO);
  assert.deepEqual(task.httpRequest.oidcToken, { serviceAccountEmail: CONTA, audience: ALVO });
  assert.equal(task.dispatchDeadline.seconds, tarefas.PRAZO_DA_TAREFA_S);
  const corpo = JSON.parse(Buffer.from(task.httpRequest.body).toString());
  assert.equal(corpo.jobId, r.json.jobId);
  assert.ok(corpo.ip, 'o IP do pedido original vai junto (log de abuso)');

  await esperar(50);
  assert.equal(m.fal.chamadas, 0, 'quem pinta é o pedido da tarefa, não este processo');
  assert.equal(linha(m, r.json.jobId).estado, 'na_fila');
  assert.equal(m.usuario().brilhante_creditos, 2, 'nada debitado antes de pintar');
  assert.equal(m.usuario().figurinha_status, 'gerando');

  const visto = await consultar(m, r.json.jobId);
  assert.equal(visto.status, 200, 'a consulta lê a linha da tabela');
  assert.equal(visto.json.estado, 'na_fila');

  const toqueDuplo = await gerar(m, { assincrono: true });
  assert.equal(toqueDuplo.status, 202);
  assert.equal(toqueDuplo.json.jobId, r.json.jobId);
  assert.equal(toqueDuplo.json.jaEmAndamento, true);
  assert.equal(m.nuvem.criadas.length, 1, 'uma pintura, uma tarefa');
});

test('ALREADY_EXISTS do Cloud Tasks conta como sucesso (a tarefa deste job já estava lá)', async (t) => {
  const m = mundo(t);
  m.nuvem.recusar = Object.assign(new Error('6 ALREADY_EXISTS: task exists'), { code: 6 });
  const r = await gerar(m, { assincrono: true });
  assert.equal(r.status, 202);
  await esperar(50);
  assert.equal(m.fal.chamadas, 0, 'não cai na memória: a tarefa existe');
});

// ── 3: o pedido da tarefa ────────────────────────────────────────────────────

test('o pedido da tarefa pinta DENTRO do pedido, debita UMA vez e a consulta mostra a figurinha; repetido, não repinta', async (t) => {
  const m = mundo(t);
  const r = await gerar(m, { assincrono: true });
  const id = r.json.jobId;

  const feito = await pintar(m, id);
  assert.equal(feito.status, 200);
  assert.deepEqual(feito.json, { jobId: id, estado: 'pronta', repintou: true });
  assert.equal(m.fal.chamadas, 1);
  assert.equal(m.usuario().brilhante_creditos, 1, 'um crédito, uma vez');
  assert.equal(m.usuario().figurinha_status, 'pronta');
  assert.match(m.usuario().avatar_url, /-ai-dark-gold-\d+\.png/);
  assert.equal(m.usuario().kit_ativo, 'dark-gold');
  assert.equal(m.tabelas.user_avatar_slots.length, 1);
  const l = linha(m, id);
  assert.equal(l.estado, 'pronta');
  assert.ok(l.duracao_ms >= 0 && l.terminado_em && l.avatar_url);
  assert.equal(m.notificacoes.length, 1, 'push "Sua figurinha ficou pronta"');
  assert.equal(m.notificacoes[0].payload.body, 'Sua figurinha ficou pronta');

  const visto = await consultar(m, id);
  assert.equal(visto.json.estado, 'pronta');
  assert.equal(visto.json.progresso, 1);
  assert.match(visto.json.avatar_url, /-ai-dark-gold-\d+\.png/);
  assert.equal(visto.json.figurinha_ativa, true);

  // A tarefa chega de novo (duplicada, ou repetida depois de uma resposta perdida): nada de repintar nem cobrar.
  const outra = await pintar(m, id);
  assert.equal(outra.status, 200);
  assert.deepEqual(outra.json, { jobId: id, estado: 'pronta', repintou: false });
  assert.equal(m.fal.chamadas, 1);
  assert.equal(m.usuario().brilhante_creditos, 1);
  assert.equal(m.notificacoes.length, 1);
});

test('sem o segredo, ou sem o token OIDC válido: 401 e NADA pinta', async (t) => {
  const m = mundo(t);
  const r = await gerar(m, { assincrono: true });
  const id = r.json.jobId;
  const casos = {
    'sem nenhum dos dois': {},
    'só o token': { authorization: `Bearer ${TOKEN_BOM}` },
    'segredo errado': { 'x-futty-interno': 'outro-segredo', authorization: `Bearer ${TOKEN_BOM}` },
    'só o segredo (com o Cloud Tasks ligado o token é obrigatório)': { 'x-futty-interno': SEGREDO },
    'token que não é do Google': { 'x-futty-interno': SEGREDO, authorization: 'Bearer lixo' },
    'token de outra audiência': { 'x-futty-interno': SEGREDO, authorization: 'Bearer token-de-outro-servico' },
  };
  for (const [nome, cabecalhos] of Object.entries(casos)) {
    // eslint-disable-next-line no-await-in-loop
    const resp = await pintar(m, id, cabecalhos);
    assert.equal(resp.status, 401, nome);
    assert.equal(resp.json.error, 'Não autorizado.', `${nome}: a resposta não diz qual dos dois faltou`);
  }
  assert.equal(m.fal.chamadas, 0);
  assert.equal(linha(m, id).estado, 'na_fila', 'o job ficou intocado');
  assert.equal(m.usuario().brilhante_creditos, 2);

  // O token de OUTRA conta de serviço (assinado pelo Google, mas não é a do Cloud Run) também não passa.
  tarefas._definirVerificador(async () => ({ email: 'intruso@outro-projeto.iam.gserviceaccount.com', email_verified: true }));
  assert.equal((await pintar(m, id)).status, 401);
  assert.equal(m.fal.chamadas, 0);
});

test('sem o Cloud Tasks ligado (local/dev): o segredo basta, mas ele é obrigatório — e sem INTERNO_SEGREDO o endpoint nunca abre', async (t) => {
  const m = mundo(t, { tarefasLigadas: false });
  const r = await gerar(m, { assincrono: true });
  assert.equal(r.status, 202);
  assert.equal(await ate(() => linha(m, r.json.jobId)?.estado === 'pronta'), true, 'sem Cloud Tasks pinta em memória, como sempre');
  assert.equal(m.fal.chamadas, 1);

  // Sem nada configurado, nem um cabeçalho adivinhado abre a porta.
  assert.equal((await pintar(m, r.json.jobId, { 'x-futty-interno': '' })).status, 401);
  assert.equal((await pintar(m, r.json.jobId, { 'x-futty-interno': SEGREDO })).status, 401);
  // Com o segredo (e sem o resto da configuração), local: passa e o job pronto não é repintado.
  process.env.INTERNO_SEGREDO = SEGREDO;
  const resp = await pintar(m, r.json.jobId, { 'x-futty-interno': SEGREDO });
  assert.equal(resp.status, 200);
  assert.equal(resp.json.repintou, false);
  // E um token que não dá para conferir (sem URL_DO_SERVICO) é recusado.
  assert.equal((await pintar(m, r.json.jobId, { 'x-futty-interno': SEGREDO, authorization: 'Bearer qualquer' })).status, 401);
  assert.equal(m.fal.chamadas, 1);
});

test('outro processo pinta com batimento fresco: 409 (o Cloud Tasks tenta depois) e a fal não é chamada', async (t) => {
  const m = mundo(t);
  const r = await gerar(m, { assincrono: true });
  Object.assign(linha(m, r.json.jobId), { estado: 'em_andamento', etapa: 'pintando', atualizado_em: atras(10) });
  const resp = await pintar(m, r.json.jobId);
  assert.equal(resp.status, 409);
  assert.equal(m.fal.chamadas, 0);
  assert.equal(linha(m, r.json.jobId).estado, 'em_andamento', 'o job do outro processo não foi tocado');
});

test('processo morto no meio: o batimento velho (> 40 s) deixa a repetição retomar e pintar; um de 20 s ainda é do outro processo', async (t) => {
  const m = mundo(t);
  const r = await gerar(m, { assincrono: true });
  const id = r.json.jobId;
  Object.assign(linha(m, id), { estado: 'em_andamento', etapa: 'acabamento', iniciado_em: atras(70), atualizado_em: atras(20) });
  assert.equal((await pintar(m, id)).status, 409, 'há 20 s alguém ainda batia');
  assert.equal(m.fal.chamadas, 0);

  Object.assign(linha(m, id), { atualizado_em: atras(50) });
  const resp = await pintar(m, id);
  assert.equal(resp.status, 200);
  assert.deepEqual(resp.json, { jobId: id, estado: 'pronta', repintou: true });
  assert.equal(m.fal.chamadas, 1);
  assert.equal(m.usuario().brilhante_creditos, 1, 'o processo morto nunca debitou (só debita depois da figurinha): cobra uma vez');
});

test('duas tarefas ao mesmo tempo: só uma pinta (o UPDATE condicional é a trava) e a outra recebe 409', async (t) => {
  const m = mundo(t);
  m.fal.portao = adiada();
  const r = await gerar(m, { assincrono: true });
  const primeira = pintar(m, r.json.jobId);
  assert.equal(await ate(() => m.fal.chamadas === 1), true);
  const segunda = await pintar(m, r.json.jobId);
  assert.equal(segunda.status, 409);
  m.fal.portao.resolver();
  assert.equal((await primeira).json.estado, 'pronta');
  assert.equal(m.fal.chamadas, 1);
  assert.equal(m.usuario().brilhante_creditos, 1);
});

test('job inexistente ou id malformado: 404; job já "falhou": 200 sem repintar', async (t) => {
  const m = mundo(t);
  assert.equal((await pintar(m, JOB_INEXISTENTE)).status, 404);
  assert.equal((await pintar(m, 'nao-e-um-uuid')).status, 404);
  m.tabelas.geracoes_jobs.push({ id: '55555555-5555-5555-5555-555555555555', user_id: USUARIO, estado: 'falhou', etapa: 'preparando', kit_id: 'dark-gold', criado_em: atras(60), atualizado_em: atras(30) });
  const resp = await pintar(m, '55555555-5555-5555-5555-555555555555');
  assert.deepEqual(resp.json, { jobId: '55555555-5555-5555-5555-555555555555', estado: 'falhou', repintou: false });
  assert.equal(m.fal.chamadas, 0);
});

// ── 4: falha de pintura é desfecho ───────────────────────────────────────────

test('cabeça cortada nas duas tentativas: o pedido da tarefa responde 200 (não repete), pede outra foto e NÃO cobra', async (t) => {
  const m = mundo(t);
  m.fal.recortes = [cortado, cortado];
  const r = await gerar(m, { assincrono: true });
  const resp = await pintar(m, r.json.jobId);
  assert.equal(resp.status, 200, 'se fosse 5xx o Cloud Tasks repetiria e a fal seria paga de novo à toa');
  assert.equal(resp.json.estado, 'falhou');
  assert.equal(m.fal.chamadas, 2, 'a 1ª reprovada refaz UMA vez, como sempre');
  const visto = await consultar(m, r.json.jobId);
  assert.equal(visto.json.estado, 'falhou');
  assert.equal(visto.json.code, 'FOTO_RECUSADA');
  assert.match(visto.json.erro, /Escolha outra: de frente, com a cabeça e os ombros/);
  assert.equal(m.usuario().brilhante_creditos, 2);
  assert.equal(m.usuario().figurinha_status, 'falhou');
  assert.equal(m.tabelas.user_avatar_slots.length, 0);
  assert.equal(m.notificacoes.length, 0);
  assert.equal(m.tabelas.fotos_recusadas.length, 1, 'a foto ficou recusada');
  // E a tarefa repetida não tenta de novo.
  assert.equal((await pintar(m, r.json.jobId)).json.repintou, false);
  assert.equal(m.fal.chamadas, 2);
});

test('o direito sumiu entre o POST e a tarefa: 200 "falhou" com a mensagem de sempre, sem chamar a fal', async (t) => {
  const m = mundo(t);
  const r = await gerar(m, { assincrono: true });
  m.usuario().brilhante_creditos = 0;
  const resp = await pintar(m, r.json.jobId);
  assert.equal(resp.status, 200);
  assert.equal(resp.json.estado, 'falhou');
  assert.equal(m.fal.chamadas, 0);
  assert.equal((await consultar(m, r.json.jobId)).json.code, 'SEM_DIREITO');
});

test('a foto foi recusada entre o POST e a tarefa (segunda barreira, dentro da pintura): 200 "falhou" FOTO_RECUSADA, sem chamar a fal, sem débito', async (t) => {
  const m = mundo(t);
  const r = await gerar(m, { assincrono: true }); // enfileirada com a foto ainda aceita
  m.tabelas.fotos_recusadas = [{ user_id: USUARIO, foto_hash: m.usuario().foto_hash }];
  const resp = await pintar(m, r.json.jobId);
  assert.equal(resp.status, 200);
  assert.equal(resp.json.estado, 'falhou');
  assert.equal(m.fal.chamadas, 0, 'a fal não é chamada para uma foto recusada');
  const visto = await consultar(m, r.json.jobId);
  assert.equal(visto.json.code, 'FOTO_RECUSADA');
  assert.equal(m.usuario().brilhante_creditos, 2, 'nada debitado');
});

// ── 5: o Cloud Tasks não aceita / sem a tabela ───────────────────────────────

test('o Cloud Tasks recusa o enfileiramento (permissão, API desligada): cai na fila em memória e a pessoa recebe a figurinha', async (t) => {
  const m = mundo(t);
  m.nuvem.recusar = Object.assign(new Error('7 PERMISSION_DENIED'), { code: 7 });
  const r = await gerar(m, { assincrono: true });
  assert.equal(r.status, 202);
  assert.equal(await ate(() => linha(m, r.json.jobId)?.estado === 'pronta'), true);
  assert.equal(m.fal.chamadas, 1);
  assert.equal(m.nuvem.criadas.length, 0);
  assert.equal(m.usuario().brilhante_creditos, 1);
});

test('o Cloud Tasks deu erro mas a tarefa existe: só pinta quem pegar o job — nunca duas pinturas', async (t) => {
  const m = mundo(t);
  // A tarefa saiu do outro lado (já pegou o job) e a resposta do createTask é que estourou o prazo.
  m.nuvem.aoCriar = async (pedido) => {
    const id = pedido.task.name.split('pintura-')[1];
    Object.assign(linha(m, id), { estado: 'em_andamento', atualizado_em: new Date().toISOString() });
    throw Object.assign(new Error('4 DEADLINE_EXCEEDED'), { code: 4 });
  };
  const r = await gerar(m, { assincrono: true });
  assert.equal(r.status, 202);
  await esperar(80);
  assert.equal(m.fal.chamadas, 0, 'este processo não pinta: o job já é de quem pegou');
});

test('sem a tabela (069 por aplicar) o Cloud Tasks nem é tentado: a fila em memória pinta', async (t) => {
  const m = mundo(t, { opcoesBanco: { falhar: (tabela) => (tabela === 'geracoes_jobs' ? { code: '42P01', message: 'relation "public.geracoes_jobs" does not exist' } : null) } });
  const r = await gerar(m, { assincrono: true });
  assert.equal(r.status, 202);
  assert.equal(await ate(async () => (await consultar(m, r.json.jobId)).json.estado === 'pronta'), true);
  assert.equal(m.nuvem.criadas.length, 0, 'a tarefa precisa da linha do job para existir');
  assert.equal(m.fal.chamadas, 1);
  assert.equal(m.usuario().brilhante_creditos, 1);
});

// ── 6: o app já publicado ────────────────────────────────────────────────────

test('app já publicado (sem `assincrono`) com o Cloud Tasks ligado: pinta no próprio pedido, sem tarefa', async (t) => {
  const m = mundo(t);
  const r = await gerar(m);
  assert.equal(r.status, 200);
  assert.match(r.json.avatar_url, /-ai-dark-gold-\d+\.png/);
  assert.equal(r.json.reutilizado, false);
  assert.equal('jobId' in r.json, false);
  assert.equal(m.nuvem.criadas.length, 0, 'o pedido do app antigo já segura a CPU: não precisa de tarefa');
  assert.equal(m.usuario().brilhante_creditos, 1);
});

// ── 7: desligamento e prazo ──────────────────────────────────────────────────

test('SIGTERM com pintura a pedido da tarefa: volta à fila (não vira "falhou") para a repetição do Cloud Tasks; se acabar, o desfecho real vale', async (t) => {
  const m = mundo(t);
  m.fal.portao = adiada();
  const r = await gerar(m, { assincrono: true });
  const id = r.json.jobId;
  const andando = pintar(m, id);
  assert.equal(await ate(() => m.fal.chamadas === 1), true);
  assert.equal(linha(m, id).estado, 'em_andamento');

  const marcados = [];
  assert.equal(await m.jobs.interromperTodas({ aoMarcar: (u) => marcados.push(u) }), 1);
  assert.equal(linha(m, id).estado, 'na_fila', 'sem batimento a esperar: a repetição retoma já');
  assert.deepEqual(marcados, [], 'não marca falha: quem consulta continua vendo a pintura andar');
  assert.equal(m.usuario().figurinha_status, 'gerando');
  assert.equal((await consultar(m, id)).json.estado === 'falhou', false);

  m.fal.portao.resolver(); // deu tempo de acabar antes de o processo sair
  assert.equal((await andando).json.estado, 'pronta');
  assert.equal(linha(m, id).estado, 'pronta');
  assert.equal(m.usuario().brilhante_creditos, 1);
});

test('pintura parada com o Cloud Tasks ligado só é dada por interrompida passados os 5 min das repetições', async (t) => {
  const m = mundo(t);
  const base = { user_id: USUARIO, estado: 'em_andamento', etapa: 'pintando', kit_id: 'dark-gold', estimativa_s: 40, criado_em: atras(700), iniciado_em: atras(690) };
  m.tabelas.geracoes_jobs.push(
    { ...base, id: '66666666-6666-6666-6666-666666666661', atualizado_em: atras(120) },
    { ...base, id: '66666666-6666-6666-6666-666666666662', atualizado_em: atras(400) },
  );
  const espera = await consultar(m, '66666666-6666-6666-6666-666666666661');
  assert.equal(espera.json.estado, 'em_andamento', 'há 2 min sem batimento: a repetição ainda pode vir');
  const perdida = await consultar(m, '66666666-6666-6666-6666-666666666662');
  assert.equal(perdida.json.estado, 'falhou');
  assert.equal(perdida.json.code, m.jobs.CODIGO_INTERROMPIDA);
  assert.equal(linha(m, '66666666-6666-6666-6666-666666666662').estado, 'falhou');
  assert.equal(m.usuario().figurinha_status, 'falhou', 'a pessoa volta a poder pedir outra');
});
