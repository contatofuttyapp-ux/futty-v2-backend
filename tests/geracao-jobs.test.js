// Futty v2.0 — RODADA 29B (bloco 2, A): a fila da pintura em segundo plano (utils/geracaoJobs.js).
//
// SEM banco e SEM rede: o Supabase falso em memória entra por baixo (tests/_rotas.js) e o "trabalho" da pintura é uma
// função que o teste controla. O que isto prova:
//   1. a estimativa é a MEDIANA da duração das últimas 50 pinturas prontas (45 s sem histórico; nunca fora de 10–240 s);
//   2. a barra avança pelo tempo estimado até 90% e segura ali — só 'pronta' chega a 1;
//   3. a fila: uma por vez por pessoa, estados e etapas na ordem, `duracao_ms` gravada, erro em linguagem de gente
//      (a mensagem de uma HttpError sai como é; erro de fal/rede NUNCA vaza para a pessoa);
//   4. só o dono enxerga a pintura; pintura de processo morto (sem batimento) vira 'falhou' e ninguém é cobrado;
//   5. sem a tabela (migração 069 por aplicar) a fila continua funcionando em memória.
//
// Uso: npm test  (ou: node --test tests/geracao-jobs.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar } = require('./_rotas');
const { HttpError } = require('../utils/http');

const USUARIO = '11111111-1111-1111-1111-111111111111';
const OUTRO = '22222222-2222-2222-2222-222222222222';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const atras = (segundos) => new Date(Date.now() - segundos * 1000).toISOString();

/** O módulo recém-carregado por cima de um Supabase falso (com a tabela, ou sem ela se `semTabela`). */
function novo(tabelas = {}, { semTabela = false } = {}) {
  const opcoes = semTabela
    ? { falhar: (tabela) => (tabela === 'geracoes_jobs' ? { code: '42P01', message: 'relation "public.geracoes_jobs" does not exist' } : null) }
    : {};
  const { carregados, tabelas: vivas } = carregar({ geracoes_jobs: [], ...tabelas }, ['utils/geracaoJobs'], opcoes);
  const g = carregados['utils/geracaoJobs'];
  g._zerar();
  return { g, vivas };
}

/** Uma promessa que o teste resolve/rejeita quando quiser: o "trabalho" da pintura. */
function adiada() {
  let resolver;
  let rejeitar;
  const promessa = new Promise((res, rej) => { resolver = res; rejeitar = rej; });
  return { promessa, resolver, rejeitar };
}

// ── 1 e 2: as contas ─────────────────────────────────────────────────────────

test('mediana: sem histórico 45 s; ímpar, par, lixo ignorado e cercada em 10–240 s', () => {
  const { g } = novo();
  assert.equal(g.medianaSegundos([]), 45);
  assert.equal(g.medianaSegundos(null), 45);
  assert.equal(g.medianaSegundos([30000, 50000, 40000]), 40);
  assert.equal(g.medianaSegundos([20000, 40000]), 30);
  assert.equal(g.medianaSegundos([null, 0, -5, 'x', 60000]), 60, 'só conta duração positiva e numérica');
  assert.equal(g.medianaSegundos([1000]), 10, 'piso de 10 s');
  assert.equal(g.medianaSegundos([900000]), 240, 'teto de 240 s');
  // A mediana não se deixa puxar por uma pintura com retry (90 s) no meio de pinturas de 40 s.
  assert.equal(g.medianaSegundos([40000, 41000, 39000, 90000, 42000]), 41);
});

test('progresso: avança pelo tempo estimado até 90% e segura; só "pronta" vale 1; "falhou" não tem barra', () => {
  const { g } = novo();
  const p = (estado, decorridoMs, estimativaSegundos = 40) => g.progressoDaPintura({ estado, decorridoMs, estimativaSegundos });
  assert.equal(p('em_andamento', 0), 0);
  assert.equal(p('em_andamento', 20000), 0.45, 'metade do tempo estimado = 45%');
  assert.equal(p('em_andamento', 40000), 0.9, 'no tempo estimado = 90%');
  assert.equal(p('em_andamento', 400000), 0.9, 'passou do tempo: segura em 90%, nunca 100%');
  assert.equal(p('na_fila', 5000) < 0.9, true);
  assert.equal(p('pronta', 1), 1);
  assert.equal(p('falhou', 50000), 0);
  assert.equal(g.progressoDaPintura({ estado: 'em_andamento', decorridoMs: 22500 }), 0.45, 'sem estimativa usa os 45 s de sempre');
  assert.equal(g.TETO_PROGRESSO, 0.9);
});

// ── 1: a estimativa lida da tabela ───────────────────────────────────────────

test('estimativa = mediana das ÚLTIMAS 50 prontas (as antigas, as falhas e as sem duração não entram)', async () => {
  const linhas = [];
  // 10 pinturas antigas de 100 s e 50 recentes de 20 s: só as 50 recentes contam.
  for (let i = 0; i < 10; i += 1) linhas.push({ id: `v${i}`, user_id: USUARIO, estado: 'pronta', duracao_ms: 100000, terminado_em: atras(10000 + i) });
  for (let i = 0; i < 50; i += 1) linhas.push({ id: `n${i}`, user_id: USUARIO, estado: 'pronta', duracao_ms: 20000, terminado_em: atras(100 + i) });
  linhas.push({ id: 'f1', user_id: USUARIO, estado: 'falhou', duracao_ms: 200000, terminado_em: atras(5) });
  linhas.push({ id: 'z1', user_id: USUARIO, estado: 'pronta', duracao_ms: null, terminado_em: atras(4) });
  const { g } = novo({ geracoes_jobs: linhas });
  assert.equal(await g.estimativaSegundos(), 20);
});

test('estimativa sem histórico nenhum = 45 s', async () => {
  const { g } = novo();
  assert.equal(await g.estimativaSegundos(), 45);
});

// ── 3: a fila e o ciclo do job ───────────────────────────────────────────────

test('uma por vez por pessoa: o segundo toque recebe a pintura do primeiro; terminada a 1ª, abre outra', async () => {
  const { g } = novo();
  const a = g.reservar({ userId: USUARIO, kitId: 'dark-gold' });
  assert.equal(a.jaEmAndamento, false);
  await g.registrar(a.job);
  const espera = adiada();
  g.iniciar(a.job, () => espera.promessa);

  const b = g.reservar({ userId: USUARIO, kitId: 'dark-purple' });
  assert.equal(b.jaEmAndamento, true);
  assert.equal(b.job.id, a.job.id, 'o toque duplo acompanha a mesma pintura');
  assert.deepEqual(await g.emCursoDoUsuario(USUARIO), { id: a.job.id, estimativaSegundos: 45 });

  // Outra pessoa pinta ao mesmo tempo, sem fila atrás da primeira.
  assert.equal(g.reservar({ userId: OUTRO, kitId: 'dark-gold' }).jaEmAndamento, false);

  espera.resolver({ avatar_url: 'https://x/a.png', kit: 'dark-gold', figurinha_ativa: true });
  await a.job.promessa;
  assert.equal(await g.emCursoDoUsuario(USUARIO), null);
  assert.equal(g.reservar({ userId: USUARIO, kitId: 'dark-gold' }).jaEmAndamento, false, 'acabou: a pessoa pode pintar de novo');
});

test('ciclo de sucesso: na_fila → em_andamento (etapas) → pronta, com duração gravada e a imagem só no fim', async () => {
  const { g, vivas } = novo();
  const { job } = g.reservar({ userId: USUARIO, kitId: 'dark-gold' });
  await g.registrar(job);
  assert.equal(vivas.geracoes_jobs.length, 1, 'a linha nasce no registro');
  assert.equal(vivas.geracoes_jobs[0].estado, 'na_fila');
  assert.equal(vivas.geracoes_jobs[0].estimativa_s, 45);
  assert.equal((await g.ler(job.id, USUARIO)).estado, 'na_fila');

  const passo1 = adiada();
  const passo2 = adiada();
  const avisou = [];
  g.iniciar(job, async ({ etapa }) => {
    await passo1.promessa;
    await etapa('pintando');
    await passo2.promessa;
    await etapa('acabamento');
    await esperar(5);
    return { avatar_url: 'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/avatars/public/u-ai-dark-gold-1.png', kit: 'dark-gold', figurinha_ativa: true };
  }, { aoTerminar: (j) => avisou.push(j.estado) });

  await esperar(5);
  let v = await g.ler(job.id, USUARIO);
  assert.equal(v.estado, 'em_andamento');
  assert.equal(v.etapa, 'preparando');
  assert.equal(v.avatar_url, null, 'sem imagem não há avatar_url');
  assert.ok(v.progresso < 0.9 && v.progresso >= 0);
  assert.equal('kit' in v, false);

  passo1.resolver();
  await esperar(5);
  v = await g.ler(job.id, USUARIO);
  assert.equal(v.etapa, 'pintando');
  assert.notEqual(v.progresso, 1, 'nunca 100% antes de existir a imagem');

  passo2.resolver();
  await job.promessa;
  v = await g.ler(job.id, USUARIO);
  assert.equal(v.estado, 'pronta');
  assert.equal(v.etapa, 'pronta');
  assert.equal(v.progresso, 1);
  assert.match(v.avatar_url, /-ai-dark-gold-1\.png$/);
  assert.equal(v.kit, 'dark-gold');
  assert.equal(v.figurinha_ativa, true);

  const linha = vivas.geracoes_jobs[0];
  assert.equal(linha.estado, 'pronta');
  assert.equal(linha.etapa, 'pronta');
  assert.match(linha.avatar_url, /-ai-dark-gold-1\.png$/);
  assert.ok(linha.duracao_ms > 0, 'duracao_ms gravada');
  assert.ok(linha.terminado_em);
  assert.deepEqual(avisou, ['pronta'], 'aoTerminar roda uma vez, depois do desfecho gravado');
});

test('a duração de cada pintura alimenta a estimativa da seguinte (relógio simulado: 30, 40 e 50 s → 40 s)', async (t) => {
  const { g, vivas } = novo();
  let agora = Date.now();
  t.mock.method(Date, 'now', () => agora);
  for (const segundos of [30, 40, 50]) {
    const { job } = g.reservar({ userId: USUARIO, kitId: 'dark-gold' });
    await g.registrar(job);
    await g.iniciar(job, async () => { agora += segundos * 1000; return { avatar_url: 'https://x/a.png' }; });
    agora += 1000;
  }
  assert.deepEqual(vivas.geracoes_jobs.map((l) => l.duracao_ms), [30000, 40000, 50000]);
  assert.equal(await g.estimativaSegundos(), 40);
});

test('falha com HttpError: a mensagem e o código chegam à pessoa como são; nada de "pronta" nem imagem', async () => {
  const { g, vivas } = novo();
  const { job } = g.reservar({ userId: USUARIO, kitId: 'dark-gold' });
  await g.registrar(job);
  await g.iniciar(job, async () => {
    throw new HttpError(422, 'Não conseguimos gerar uma figurinha à altura com esta foto. Tente outra: de frente e bem iluminada.', 'FIGURINHA_DEFEITUOSA');
  });
  const v = await g.ler(job.id, USUARIO);
  assert.equal(v.estado, 'falhou');
  assert.equal(v.code, 'FIGURINHA_DEFEITUOSA');
  assert.equal(v.status, 422);
  assert.match(v.erro, /figurinha à altura/);
  assert.equal(v.avatar_url, null);
  assert.equal(v.progresso, 0);
  assert.equal(job.erroOriginal instanceof HttpError, true, 'o pedido antigo relança o erro de sempre');
  assert.equal(vivas.geracoes_jobs[0].estado, 'falhou');
  assert.equal(vivas.geracoes_jobs[0].erro_codigo, 'FIGURINHA_DEFEITUOSA');
  assert.equal(await g.emCursoDoUsuario(USUARIO), null, 'falhou: a vez da pessoa é liberada');
});

test('falha que NÃO é HttpError (fal, rede, banco): a pessoa lê a frase genérica, nunca o texto interno', async () => {
  const { g } = novo();
  const { job } = g.reservar({ userId: USUARIO, kitId: 'dark-gold' });
  await g.registrar(job);
  await g.iniciar(job, async () => { throw new Error('fal 500 ao submeter: https://segredo.supabase.co/x?token=abc'); });
  const v = await g.ler(job.id, USUARIO);
  assert.equal(v.estado, 'falhou');
  assert.equal(v.erro, 'Não deu desta vez. Tente de novo.');
  assert.equal(v.code, null);
  assert.equal(v.status, 500);
  assert.doesNotMatch(JSON.stringify(v), /segredo|token=abc|fal 500/);
});

test('um aoTerminar que quebra não derruba o job', async () => {
  const { g } = novo();
  const { job } = g.reservar({ userId: USUARIO, kitId: 'dark-gold' });
  await g.registrar(job);
  await g.iniciar(job, async () => ({ avatar_url: 'https://x/a.png' }), { aoTerminar: () => { throw new Error('push caiu'); } });
  assert.equal((await g.ler(job.id, USUARIO)).estado, 'pronta');
});

// ── 4: dono, processo morto e desligamento ───────────────────────────────────

test('só o dono enxerga a pintura (outro usuário e id que não existe: nada)', async () => {
  const { g } = novo();
  const { job } = g.reservar({ userId: USUARIO, kitId: 'dark-gold' });
  await g.registrar(job);
  assert.equal((await g.ler(job.id, USUARIO)).estado, 'na_fila');
  assert.equal(await g.ler(job.id, OUTRO), null);
  assert.equal(await g.ler('99999999-9999-9999-9999-999999999999', USUARIO), null);
});

test('consulta vinda de OUTRA instância: lê a tabela; sem batimento há mais de 60 s = processo morto → falhou, sem cobrar', async () => {
  const { g, vivas } = novo({
    geracoes_jobs: [
      { id: 'vivo', user_id: USUARIO, estado: 'em_andamento', etapa: 'pintando', kit_id: 'dark-gold', estimativa_s: 40, criado_em: atras(30), iniciado_em: atras(28), atualizado_em: atras(5) },
      { id: 'morto', user_id: USUARIO, estado: 'em_andamento', etapa: 'pintando', kit_id: 'dark-gold', estimativa_s: 40, criado_em: atras(300), iniciado_em: atras(298), atualizado_em: atras(120) },
    ],
  });
  const marcados = [];
  const vivo = await g.ler('vivo', USUARIO, { aoInterromper: (id) => marcados.push(id) });
  assert.equal(vivo.estado, 'em_andamento');
  assert.equal(vivo.etapa, 'pintando');
  assert.ok(vivo.progresso > 0 && vivo.progresso <= 0.9);
  assert.equal(marcados.length, 0);

  const morto = await g.ler('morto', USUARIO, { aoInterromper: (id) => marcados.push(id) });
  assert.equal(morto.estado, 'falhou');
  assert.equal(morto.code, g.CODIGO_INTERROMPIDA);
  assert.match(morto.erro, /interrompida.*Nada foi cobrado/);
  assert.deepEqual(marcados, [USUARIO], 'o usuário deixa de aparecer como "gerando" no Início');
  assert.equal(vivas.geracoes_jobs.find((l) => l.id === 'morto').estado, 'falhou');
  assert.equal(vivas.geracoes_jobs.find((l) => l.id === 'vivo').estado, 'em_andamento', 'a de batimento fresco não é tocada');
});

test('"já há uma pintura em curso" também olha a tabela (outra instância), mas só com batimento fresco', async () => {
  const { g } = novo({
    geracoes_jobs: [
      { id: 'de-outra-instancia', user_id: USUARIO, estado: 'em_andamento', etapa: 'pintando', estimativa_s: 38, criado_em: atras(20), atualizado_em: atras(4) },
      { id: 'velha', user_id: OUTRO, estado: 'em_andamento', etapa: 'pintando', estimativa_s: 38, criado_em: atras(400), atualizado_em: atras(300) },
    ],
  });
  assert.deepEqual(await g.emCursoDoUsuario(USUARIO), { id: 'de-outra-instancia', estimativaSegundos: 38 });
  assert.equal(await g.emCursoDoUsuario(OUTRO), null, 'sem batimento há 5 min não trava ninguém');
});

test('reinício: a varredura marca só as sem batimento e manda o usuário voltar a "falhou"', async () => {
  const { g, vivas } = novo({
    geracoes_jobs: [
      { id: 'a', user_id: USUARIO, estado: 'em_andamento', etapa: 'pintando', criado_em: atras(200), atualizado_em: atras(150) },
      { id: 'b', user_id: OUTRO, estado: 'na_fila', etapa: 'preparando', criado_em: atras(100), atualizado_em: atras(90) },
      { id: 'c', user_id: OUTRO, estado: 'em_andamento', etapa: 'pintando', criado_em: atras(20), atualizado_em: atras(3) },
      { id: 'd', user_id: OUTRO, estado: 'pronta', etapa: 'pronta', criado_em: atras(500), atualizado_em: atras(400) },
    ],
  });
  const marcados = [];
  const n = await g.varrerInterrompidas({ aoMarcar: (id) => marcados.push(id) });
  assert.equal(n, 2);
  assert.deepEqual(marcados.sort(), [OUTRO, USUARIO].sort());
  const estado = (id) => vivas.geracoes_jobs.find((l) => l.id === id).estado;
  assert.deepEqual(['a', 'b', 'c', 'd'].map(estado), ['falhou', 'falhou', 'em_andamento', 'pronta']);
  assert.equal(vivas.geracoes_jobs.find((l) => l.id === 'a').erro, g.MSG_INTERROMPIDA);
});

test('desligamento (SIGTERM): o que está pintando vira "falhou" já, e a pessoa é avisada de que nada foi cobrado', async () => {
  const { g, vivas } = novo();
  const { job } = g.reservar({ userId: USUARIO, kitId: 'dark-gold' });
  await g.registrar(job);
  const eterna = adiada();
  g.iniciar(job, () => eterna.promessa);
  await esperar(5);
  const marcados = [];
  assert.equal(await g.interromperTodas({ aoMarcar: (id) => marcados.push(id) }), 1);
  const v = await g.ler(job.id, USUARIO);
  assert.equal(v.estado, 'falhou');
  assert.equal(v.code, g.CODIGO_INTERROMPIDA);
  assert.deepEqual(marcados, [USUARIO]);
  assert.equal(vivas.geracoes_jobs[0].estado, 'falhou');
  eterna.resolver({ avatar_url: 'https://x/a.png' }); // não deixa a promessa pendurada no teste
  await job.promessa;
});

// ── 5: sem a tabela (069 por aplicar) ────────────────────────────────────────

test('sem a migração 069 a fila funciona em memória: pinta, consulta, estima — só não sobrevive a reinício', async () => {
  const { g } = novo({}, { semTabela: true });
  assert.equal(await g.estimativaSegundos(), 45, 'sem tabela nem histórico: os 45 s de sempre');
  const { job } = g.reservar({ userId: USUARIO, kitId: 'dark-gold' });
  await g.registrar(job);
  const espera = adiada();
  g.iniciar(job, async ({ etapa }) => { await etapa('pintando'); return espera.promessa; });
  await esperar(5);
  const v = await g.ler(job.id, USUARIO);
  assert.equal(v.estado, 'em_andamento');
  assert.equal(v.etapa, 'pintando');
  espera.resolver({ avatar_url: 'https://x/a.png', kit: 'dark-gold', figurinha_ativa: true });
  await job.promessa;
  assert.equal((await g.ler(job.id, USUARIO)).estado, 'pronta');
  // Outra instância (sem a memória deste processo) e sem tabela: não há de onde ler.
  assert.equal(await g.ler('33333333-3333-3333-3333-333333333333', USUARIO), null);
  assert.equal(await g.varrerInterrompidas(), 0);
});
