// Futty v2.0 — RODADA 29B (bloco 2, A): POST /api/me/avatar/ai em segundo plano + GET /api/figurinha/job/:id.
//
// A rota de verdade (routes/auth.js + routes/figurinhaJob.js + a fila de utils/geracaoJobs.js + o direito de
// utils/direitoBrilhante.js) por cima de um Supabase falso em memória, com a FAL SIMULADA (utils/geracaoFigurinha.js
// é trocado por uma função controlada pelo teste: nenhuma chamada de rede, custo zero) e um Storage falso. O que prova:
//   1. o POST com `assincrono` devolve NA HORA `{ jobId, estimativaSegundos }`, sem esperar a fal; o toque duplo acompanha
//      a mesma pintura e a fal é chamada UMA vez;
//   2. o GET mostra estado/etapa/progresso (nunca 1 antes da imagem); no fim traz a figurinha, e o direito foi debitado
//      UMA vez, só depois de ela existir;
//   3. o push "Sua figurinha ficou pronta" sai quando a pessoa NÃO está olhando o card — e não sai quando está;
//   4. falhou (fal fora do ar; cabeça cortada nas duas tentativas): erro em linguagem de gente, o direito INTACTO,
//      `figurinha_status = falhou`, nada de imagem, nada de push;
//   5. o app que já está nas lojas (não manda `assincrono`) recebe a figurinha na resposta, como sempre recebeu;
//   6. as validações continuam síncronas (sem direito → 403, sem criar job); slot reaproveitado responde na hora;
//   7. só o dono enxerga o job.
//
// Uso: npm test  (ou: node --test tests/geracao-rota.test.js)
const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { carregar, subir, injetar } = require('./_rotas');

const USUARIO = '11111111-1111-1111-1111-111111111111';
const OUTRO = '22222222-2222-2222-2222-222222222222';
const SUPABASE = 'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const adiada = () => { let resolver; const promessa = new Promise((res) => { resolver = res; }); return { promessa, resolver }; };
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

/** Uma "figurinha" recortada: elipse opaca no meio de um PNG transparente (a cabeça tem cúpula, nada toca a borda). */
async function recorteBom() {
  const w = 400; const h = 600; const buf = Buffer.alloc(w * h * 4, 0);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const dx = (x - w / 2) / 150; const dy = (y - h / 2) / 260;
    if (dx * dx + dy * dy <= 1) { const i = (y * w + x) * 4; buf[i] = 200; buf[i + 1] = 150; buf[i + 2] = 60; buf[i + 3] = 255; }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/** A cabeça COLADA no topo: um bloco opaco de 200 px de largura tocando a borda de cima. */
async function recorteCortado() {
  const w = 400; const h = 600; const buf = Buffer.alloc(w * h * 4, 0);
  for (let y = 0; y < 400; y += 1) for (let x = 100; x < 300; x += 1) { const i = (y * w + x) * 4; buf[i] = 200; buf[i + 1] = 150; buf[i + 2] = 60; buf[i + 3] = 255; }
  return sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

let foto; let outraFoto; let bom; let cortado;
before(async () => {
  foto = await sharp({ create: { width: 600, height: 800, channels: 3, background: { r: 90, g: 120, b: 160 } } }).jpeg().toBuffer();
  outraFoto = await sharp({ create: { width: 600, height: 800, channels: 3, background: { r: 200, g: 60, b: 40 } } }).jpeg().toBuffer();
  bom = await recorteBom();
  cortado = await recorteCortado();
});

/**
 * Monta o mundo de um teste. `fal` é o controle da fal simulada: `portao` (a pintura só termina quando o teste solta),
 * `chamadas`, `recortes` (o que cada chamada devolve), `erro` (a fal fora do ar) e `erroNaChamada` (só a fal da n-ésima
 * chamada cai — o retry que morre por outro motivo). `trocarFoto` põe outros bytes no bucket e o foto_hash da conta.
 */
function mundo(t, { creditos = 2, slot = null, hashDaFoto = null } = {}) {
  process.env.FAL_KEY = 'teste-sem-rede';
  const fal = { portao: null, chamadas: 0, recortes: [], erro: null, erroNaChamada: null };
  const falso = {
    gerarFigurinha: async () => {
      fal.chamadas += 1;
      if (fal.portao) await fal.portao.promessa;
      if (fal.erro && (fal.erroNaChamada === null || fal.erroNaChamada === fal.chamadas)) throw fal.erro;
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

  const hash = hashDaFoto || antiAbuso.sha256Hex(foto);
  const { carregados, cliente, tabelas, notificacoes } = carregar({
    users: [{
      id: USUARIO, foto_url: `${SUPABASE}/avatars/public/${USUARIO}-111.jpg`, foto_hash: hash, is_super_admin: false,
      created_at: '2026-01-01T00:00:00Z', brilhante_creditos: creditos, avatar_url: `${SUPABASE}/avatars/public/${USUARIO}-111.jpg`,
    }],
    user_avatar_slots: slot ? [slot] : [],
    geracoes_jobs: [],
  }, ['routes/auth', 'routes/figurinhaJob', 'utils/geracaoJobs']);
  for (const r of restaurar.reverse()) r();

  // O Storage falso: sobe, assina, baixa a foto de teste, apaga e devolve o endereço público como o Supabase faz.
  // `fotoNoBucket` é a foto ATUAL: trocarFoto põe outros bytes (e o foto_hash deles na conta), como o upload de uma foto nova.
  const enviados = [];
  const fotoNoBucket = { bytes: foto };
  cliente.storage = {
    from: () => ({
      upload: async (caminho) => { enviados.push(caminho); return { error: null }; },
      createSignedUrl: async (caminho) => ({ data: { signedUrl: `https://assinada.exemplo/${caminho}` }, error: null }),
      download: async () => ({ data: new Blob([fotoNoBucket.bytes]), error: null }),
      remove: async () => ({ error: null }),
      getPublicUrl: (caminho) => ({ data: { publicUrl: `${SUPABASE}/avatars/${caminho}` } }),
    }),
  };
  carregados['utils/geracaoJobs']._zerar();
  const pedir = subir([carregados['routes/auth'], carregados['routes/figurinhaJob']], t);
  const usuario = () => tabelas.users.find((u) => u.id === USUARIO);
  const trocarFoto = (bytes) => {
    fotoNoBucket.bytes = bytes;
    usuario().foto_hash = crypto.createHash('sha256').update(bytes).digest('hex');
  };
  return { fal, pedir, tabelas, notificacoes, enviados, usuario, trocarFoto, jobs: carregados['utils/geracaoJobs'] };
}

const gerar = (m, corpo = {}, quem = USUARIO) => m.pedir('POST', '/api/me/avatar/ai', { kit: 'dark-gold', ...corpo }, quem);
const consultar = (m, id, quem = USUARIO) => m.pedir('GET', `/api/figurinha/job/${id}`, null, quem);

test('assíncrono: o POST responde na hora, o toque duplo acompanha a mesma pintura e a fal é chamada uma vez', async (t) => {
  const m = mundo(t);
  m.fal.portao = adiada();
  const t0 = Date.now();
  const r1 = await gerar(m, { assincrono: true });
  assert.equal(r1.status, 202);
  assert.ok(Date.now() - t0 < 2000, 'respondeu sem esperar a pintura');
  assert.match(r1.json.jobId, /^[0-9a-f-]{36}$/);
  assert.equal(r1.json.estimativaSegundos, 45);
  assert.equal('avatar_url' in r1.json, false);

  assert.equal(await ate(() => m.fal.chamadas === 1), true, 'a pintura começou em segundo plano');
  const r2 = await gerar(m, { assincrono: true });
  assert.equal(r2.status, 202);
  assert.equal(r2.json.jobId, r1.json.jobId, 'o segundo toque acompanha a mesma pintura');
  assert.equal(r2.json.jaEmAndamento, true);
  assert.equal(m.fal.chamadas, 1, 'nunca duas gerações ao mesmo tempo');

  const andamento = await consultar(m, r1.json.jobId);
  assert.equal(andamento.status, 200);
  assert.equal(andamento.json.estado, 'em_andamento');
  assert.equal(andamento.json.etapa, 'pintando');
  assert.ok(andamento.json.progresso >= 0 && andamento.json.progresso <= 0.9, `progresso ${andamento.json.progresso}`);
  assert.equal(andamento.json.avatar_url, null);
  assert.equal(m.usuario().brilhante_creditos, 2, 'nada debitado enquanto pinta');
  assert.equal(m.usuario().figurinha_status, 'gerando');

  m.fal.portao.resolver();
  assert.equal(await ate(async () => (await consultar(m, r1.json.jobId)).json.estado === 'pronta'), true);
});

test('pronta: traz a figurinha, o direito é debitado UMA vez e a linha do job guarda a duração', async (t) => {
  const m = mundo(t);
  const r = await gerar(m, { assincrono: true });
  assert.equal(r.status, 202);
  assert.equal(await ate(async () => (await consultar(m, r.json.jobId)).json.estado === 'pronta'), true);
  const { json } = await consultar(m, r.json.jobId);
  assert.equal(json.etapa, 'pronta');
  assert.equal(json.progresso, 1);
  assert.match(json.avatar_url, /-ai-dark-gold-\d+\.png\?v=\d+$/);
  assert.equal(json.kit, 'dark-gold');
  assert.equal(json.figurinha_ativa, true);

  assert.equal(m.usuario().avatar_url.includes('-ai-dark-gold-'), true, 'o usuário já veste a figurinha');
  assert.equal(m.usuario().kit_ativo, 'dark-gold');
  assert.equal(m.usuario().figurinha_status, 'pronta');
  assert.equal(m.usuario().brilhante_creditos, 1, 'um crédito, uma vez');
  assert.equal(m.tabelas.user_avatar_slots.length, 1, 'o slot do uniforme ficou guardado (trocar de volta é grátis)');
  assert.equal(m.fal.chamadas, 1);
  const linha = m.tabelas.geracoes_jobs[0];
  assert.equal(linha.estado, 'pronta');
  assert.ok(linha.duracao_ms >= 0 && linha.terminado_em && linha.avatar_url);
});

test('push "Sua figurinha ficou pronta": sai se a pessoa NÃO está olhando o card; não sai se acabou de consultar', async (t) => {
  // (a) ninguém consulta: 10 s de relógio simulado entre o POST e o fim → vai o push.
  const a = mundo(t);
  let agora = Date.now();
  t.mock.method(Date, 'now', () => agora);
  a.fal.portao = adiada();
  const ra = await gerar(a, { assincrono: true });
  assert.equal(await ate(() => a.fal.chamadas === 1), true);
  agora += 10000;
  a.fal.portao.resolver();
  assert.equal(await ate(() => a.tabelas.geracoes_jobs[0]?.estado === 'pronta'), true);
  assert.equal(await ate(() => a.notificacoes.length === 1), true, 'o push saiu');
  assert.deepEqual(a.notificacoes[0].ids, [USUARIO]);
  assert.equal(a.notificacoes[0].payload.body, 'Sua figurinha ficou pronta');
  assert.equal(a.notificacoes[0].payload.url, '/figurinha');
  assert.ok(ra.json.jobId);

  // (b) a pessoa consulta um instante antes do fim → está vendo o card, o push ficaria repetido.
  const b = mundo(t);
  b.fal.portao = adiada();
  const rb = await gerar(b, { assincrono: true });
  assert.equal(await ate(() => b.fal.chamadas === 1), true);
  await consultar(b, rb.json.jobId);
  b.fal.portao.resolver();
  assert.equal(await ate(() => b.tabelas.geracoes_jobs[0]?.estado === 'pronta'), true);
  await esperar(50);
  assert.equal(b.notificacoes.length, 0, 'quem está olhando não recebe push');
});

test('falhou (fal fora do ar): erro em linguagem de gente, direito intacto, status "falhou", sem imagem e sem push', async (t) => {
  const m = mundo(t);
  m.fal.erro = new Error('fal 500 ao submeter: https://x.supabase.co/segredo?token=abc');
  const r = await gerar(m, { assincrono: true });
  assert.equal(r.status, 202);
  assert.equal(await ate(async () => (await consultar(m, r.json.jobId)).json.estado === 'falhou'), true);
  const { json } = await consultar(m, r.json.jobId);
  assert.equal(json.erro, 'Não deu desta vez. Tente de novo.');
  assert.doesNotMatch(JSON.stringify(json), /segredo|token=abc|fal 500/);
  assert.equal(json.avatar_url, null);
  assert.equal(m.usuario().brilhante_creditos, 2, 'NADA cobrado');
  assert.equal(m.usuario().figurinha_status, 'falhou');
  assert.equal(m.usuario().avatar_url.includes('-ai-'), false, 'o avatar não mudou');
  assert.equal(m.tabelas.user_avatar_slots.length, 0);
  assert.equal(m.notificacoes.length, 0, 'sem push de falha');
  // E a vez da pessoa é liberada: pode tentar de novo.
  m.fal.erro = null;
  const de_novo = await gerar(m, { assincrono: true });
  assert.notEqual(de_novo.json.jobId, r.json.jobId);
});

const MSG_RECUSADA = /^Essa foto não deu certo\. Escolha outra: de frente, com a cabeça inteira aparecendo e sem nada cortando o topo\.$/;

test('cabeça cortada nas duas tentativas: a FOTO fica recusada (FOTO_RECUSADA), a fal roda 2x e NÃO cobra', async (t) => {
  const m = mundo(t);
  m.fal.recortes = [cortado, cortado];
  const r = await gerar(m, { assincrono: true });
  assert.equal(await ate(async () => (await consultar(m, r.json.jobId)).json.estado === 'falhou'), true);
  const { json } = await consultar(m, r.json.jobId);
  assert.equal(json.code, 'FOTO_RECUSADA');
  assert.equal(json.status, 422);
  assert.match(json.erro, MSG_RECUSADA);
  assert.equal(m.fal.chamadas, 2, 'a 1ª reprovada refaz UMA vez, como sempre');
  assert.equal(m.usuario().brilhante_creditos, 2, 'cabeça cortada nunca sai e não cobra');
  assert.equal(m.tabelas.user_avatar_slots.length, 0);
  const [recusada] = m.tabelas.fotos_recusadas;
  assert.equal(m.tabelas.fotos_recusadas.length, 1, 'a foto ficou marcada');
  assert.equal(recusada.foto_hash, m.usuario().foto_hash, 'marcada pela identidade da foto (o hash), não pelo nome do arquivo');
  assert.equal(recusada.user_id, USUARIO);
});

test('a mesma foto recusada: o pedido seguinte é barrado ANTES da fal — sem job, sem débito, sem custo', async (t) => {
  const m = mundo(t);
  m.fal.recortes = [cortado, cortado];
  const r = await gerar(m, { assincrono: true });
  assert.equal(await ate(async () => (await consultar(m, r.json.jobId)).json.estado === 'falhou'), true);
  const jobsAntes = m.tabelas.geracoes_jobs.length;

  const sincrono = await gerar(m); // o app que ainda espera a figurinha na resposta
  assert.equal(sincrono.status, 422);
  assert.equal(sincrono.json.code, 'FOTO_RECUSADA');
  assert.match(sincrono.json.error, MSG_RECUSADA);
  const assincrono = await gerar(m, { assincrono: true }); // o app novo
  assert.equal(assincrono.status, 422);
  assert.equal(assincrono.json.code, 'FOTO_RECUSADA');
  assert.equal('jobId' in assincrono.json, false, 'nem job nasce');

  // Mesmo bytes com OUTRO nome de arquivo: a identidade é a foto, não o nome — continua barrada.
  m.usuario().foto_url = m.usuario().foto_url.replace(/-111\.jpg$/, '-222.jpg');
  const outroNome = await gerar(m, { assincrono: true });
  assert.equal(outroNome.json.code, 'FOTO_RECUSADA');

  assert.equal(m.fal.chamadas, 2, 'a fal não foi chamada de novo');
  assert.equal(m.usuario().brilhante_creditos, 2, 'nada debitado');
  assert.equal(m.tabelas.geracoes_jobs.length, jobsAntes, 'nenhuma linha de job nova');
  assert.equal(m.usuario().figurinha_status, 'falhou', 'o status não virou "gerando"');
});

test('foto nova (outros bytes, outro hash): libera e passa — cobra uma vez', async (t) => {
  const m = mundo(t);
  m.fal.recortes = [cortado, cortado];
  const r = await gerar(m, { assincrono: true });
  assert.equal(await ate(async () => (await consultar(m, r.json.jobId)).json.estado === 'falhou'), true);

  m.trocarFoto(outraFoto);
  m.fal.recortes = [];
  const de_novo = await gerar(m, { assincrono: true });
  assert.equal(de_novo.status, 202);
  assert.equal(await ate(async () => (await consultar(m, de_novo.json.jobId)).json.estado === 'pronta'), true);
  assert.equal(m.fal.chamadas, 3, 'a fal volta a ser chamada para a foto nova');
  assert.equal(m.usuario().brilhante_creditos, 1, 'um crédito, uma vez');
});

test('a mesma foto recusada noutra conta também é barrada: a identidade é a FOTO, não a conta', async (t) => {
  const m = mundo(t);
  // A recusa foi gravada numa conta de outra pessoa (a linha que a migração 080 guarda); esta conta manda a mesma foto.
  m.tabelas.fotos_recusadas = [{ foto_hash: m.usuario().foto_hash, user_id: OUTRO, criado_em: new Date().toISOString() }];
  const r = await gerar(m, { assincrono: true });
  assert.equal(r.status, 422);
  assert.equal(r.json.code, 'FOTO_RECUSADA');
  assert.equal(m.fal.chamadas, 0, 'a fal não é chamada');
  assert.equal(m.usuario().brilhante_creditos, 2, 'nada debitado');
});

test('uma cabeça cortada e a 2ª tentativa caída por outro motivo: a foto NÃO fica recusada, e o pedido seguinte passa', async (t) => {
  const m = mundo(t);
  m.fal.recortes = [cortado];
  m.fal.erro = new Error('fal 500 ao submeter');
  m.fal.erroNaChamada = 2;
  const r = await gerar(m, { assincrono: true });
  assert.equal(await ate(async () => (await consultar(m, r.json.jobId)).json.estado === 'falhou'), true);
  const { json } = await consultar(m, r.json.jobId);
  assert.equal(json.code, 'FIGURINHA_DEFEITUOSA', 'só UMA tentativa viu a cabeça cortada: não é a regra das duas');
  assert.equal((m.tabelas.fotos_recusadas || []).length, 0, 'nada marcado');
  assert.equal(m.usuario().brilhante_creditos, 2);

  m.fal.erro = null;
  m.fal.recortes = [];
  const de_novo = await gerar(m, { assincrono: true });
  assert.equal(await ate(async () => (await consultar(m, de_novo.json.jobId)).json.estado === 'pronta'), true);
  assert.equal(m.usuario().brilhante_creditos, 1);
});

test('a 1ª reprovada e a 2ª boa: entrega (o retry continua igual), cobra uma vez e NÃO recusa a foto', async (t) => {
  const m = mundo(t);
  m.fal.recortes = [cortado, bom];
  const r = await gerar(m, { assincrono: true });
  assert.equal(await ate(async () => (await consultar(m, r.json.jobId)).json.estado === 'pronta'), true);
  assert.equal(m.fal.chamadas, 2);
  assert.equal(m.usuario().brilhante_creditos, 1);
  assert.equal((m.tabelas.fotos_recusadas || []).length, 0);
});

test('app já publicado (sem `assincrono`): o pedido espera a MESMA pintura e recebe a figurinha na resposta', async (t) => {
  const m = mundo(t);
  const r = await gerar(m);
  assert.equal(r.status, 200);
  assert.match(r.json.avatar_url, /-ai-dark-gold-\d+\.png/);
  assert.equal(r.json.kit, 'dark-gold');
  assert.equal(r.json.reutilizado, false);
  assert.equal(r.json.figurinha_ativa, true);
  assert.equal('jobId' in r.json, false);
  assert.equal(m.usuario().brilhante_creditos, 1);
  assert.equal(m.notificacoes.length, 0, 'quem espera a resposta não precisa de push');
});

test('app já publicado + erro: o mesmo status (422) e o código da foto recusada, com a mensagem nova', async (t) => {
  const m = mundo(t);
  m.fal.recortes = [cortado, cortado];
  const r = await gerar(m);
  assert.equal(r.status, 422);
  assert.equal(r.json.code, 'FOTO_RECUSADA');
  assert.match(r.json.error, MSG_RECUSADA);
  assert.equal(m.usuario().brilhante_creditos, 2);
});

test('app já publicado com uma pintura em curso: aviso claro (409), não uma segunda geração', async (t) => {
  const m = mundo(t);
  m.fal.portao = adiada();
  const novo = await gerar(m, { assincrono: true });
  assert.equal(novo.status, 202);
  assert.equal(await ate(() => m.fal.chamadas === 1), true);
  const velho = await gerar(m);
  assert.equal(velho.status, 409);
  assert.match(velho.json.error, /já está sendo criada/);
  assert.equal(m.fal.chamadas, 1);
  m.fal.portao.resolver();
  assert.equal(await ate(async () => (await consultar(m, novo.json.jobId)).json.estado === 'pronta'), true);
});

test('as validações seguem síncronas: sem direito → 403 na hora, sem job e sem chamar a fal', async (t) => {
  const m = mundo(t, { creditos: 0 });
  const r = await gerar(m, { assincrono: true });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /pacote do time ou da Minha Figurinha/);
  assert.equal(m.fal.chamadas, 0);
  assert.equal(m.tabelas.geracoes_jobs.length, 0);
});

test('uniforme já pintado da mesma foto: responde na hora com a figurinha guardada (sem job, sem fal, sem custo)', async (t) => {
  const hash = crypto.createHash('sha256').update('foto-de-teste').digest('hex');
  const guardada = `${SUPABASE}/avatars/public/${USUARIO}-ai-dark-gold-1.png`;
  const m = mundo(t, { hashDaFoto: hash, slot: { user_id: USUARIO, kit_id: 'dark-gold', avatar_url: guardada, foto_fingerprint: hash } });
  const r = await gerar(m, { assincrono: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.reutilizado, true);
  assert.equal(r.json.do_slot, true);
  assert.equal(r.json.avatar_url, guardada);
  assert.equal(m.fal.chamadas, 0);
  assert.equal(m.tabelas.geracoes_jobs.length, 0);
  assert.equal(m.usuario().brilhante_creditos, 2);
});

test('só o dono enxerga o job; id inventado, de outra pessoa ou sem sessão não entregam nada', async (t) => {
  const m = mundo(t);
  m.fal.portao = adiada();
  const r = await gerar(m, { assincrono: true });
  assert.equal((await consultar(m, r.json.jobId, OUTRO)).status, 404, 'outra pessoa não vê');
  assert.equal((await consultar(m, 'nao-e-um-uuid')).status, 404);
  assert.equal((await consultar(m, '99999999-9999-9999-9999-999999999999')).status, 404);
  assert.equal((await m.pedir('GET', `/api/figurinha/job/${r.json.jobId}`, null, null)).status, 401);
  assert.equal((await consultar(m, r.json.jobId)).status, 200);
  m.fal.portao.resolver();
  assert.equal(await ate(() => m.tabelas.geracoes_jobs[0]?.estado === 'pronta'), true);
});

after(() => { delete process.env.FAL_KEY; });
