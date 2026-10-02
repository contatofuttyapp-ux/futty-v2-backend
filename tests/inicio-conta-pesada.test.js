// Futty v2.0 — RODADA 29B (bloco 2, B — "conta pesada"): o GET /api/inicio da conta com 2 times e anos de histórico.
//
// Medido antes de mexer (scripts/_bench/medir-conta-pesada.js, conta super-admin em 2 times × conta de 1 time): o /api/inicio
// custava o MESMO nas duas (~990 ms de motor, 31 consultas) — o que pesava era a FILA de 4 idas seguidas ao banco, e o que CRESCE
// com a conta é a lista de jogos (todo jogo que o time já teve, com a presença de cada um). Este arquivo trava as três correções,
// SEM banco e SEM rede (Supabase falso em memória, com a latência de cada consulta simulada):
//   1. a lista de jogos é limitada ao que a tela usa — os que vão acontecer + os 3 últimos de cada time — e a tela vê EXATAMENTE
//      o mesmo que via com o histórico inteiro (a equivalência é provada para cada filtro de time e para "todos");
//   2. quem é membro de quê é lido UMA vez (eram 11 consultas de team_members, cada parte com a sua);
//   3. a fila caiu de 4 idas para 3: com 80 ms por consulta, a conta de 2 times responde em menos de 4 idas.
//
// Uso: npm test  (ou: node --test tests/inicio-conta-pesada.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir, injetar } = require('./_rotas');

const DONO = '11111111-1111-1111-1111-111111111111';
const T1 = '0000aaaa-0000-0000-0000-00000000000a';
const T2 = '0000bbbb-0000-0000-0000-00000000000b';
const TIME1 = { id: T1, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde', criado_por: DONO, created_at: '2026-01-01T00:00:00Z' };
const TIME2 = { id: T2, nome: 'Missa de Quinta', slug: 'missa', cor: 'azul', criado_por: DONO, created_at: '2025-06-01T00:00:00Z' };
const DIA = 86400000;
const iso = (dias) => new Date(Date.now() + dias * DIA).toISOString();

/** Um time com `passados` jogos encerrados (o mais recente há 7 dias), 2 cancelados entre os recentes e `futuros` por vir. */
function jogosDe(time, prefixo, { passados, futuros, cancelados = [] }) {
  const timeId = time.id;
  const jogos = [];
  for (let i = 0; i < passados; i += 1) {
    jogos.push({
      id: `${prefixo}-p${i}`, team_id: timeId, teams: time, data: iso(-7 * (i + 1)), local: `Campo ${i}`, status: 'terminado', cancelado: cancelados.includes(i),
      sorteio_realizado: true, game_players: [{ user_id: DONO, confirmado: true }, { user_id: `x${i}`, confirmado: true }],
    });
  }
  for (let i = 0; i < futuros; i += 1) {
    jogos.push({
      id: `${prefixo}-f${i}`, team_id: timeId, teams: time, data: iso(2 + 3 * i), local: `Quadra ${i}`, status: 'agendado', cancelado: false,
      sorteio_realizado: false, rsvp_aberto: true, game_players: [{ user_id: DONO, confirmado: i === 0 }],
    });
  }
  return jogos;
}

function tabelasPesadas() {
  return {
    users: [{ id: DONO, nome: 'Chavo', nome_jogador: 'Chavo', email: 'chavo@futtymock.com', is_super_admin: true, brilhante_creditos: 0 }],
    teams: [TIME1, TIME2],
    // Os vínculos já com o time embutido, como o PostgREST devolve. O mais antigo (Missa) é o time principal.
    team_members: [
      { team_id: T2, user_id: DONO, role: 'admin', ausente_proximo: false, created_at: '2025-06-01T00:00:00Z', teams: TIME2 },
      { team_id: T1, user_id: DONO, role: 'admin', ausente_proximo: false, created_at: '2026-01-01T00:00:00Z', teams: TIME1 },
    ],
    // Missa: 30 jogos de histórico (os 2 mais recentes cancelados) e 1 por vir; Várzea: 9 de histórico e 2 por vir.
    games: [
      ...jogosDe(TIME2, 'missa', { passados: 30, futuros: 1, cancelados: [0, 1] }),
      ...jogosDe(TIME1, 'varzea', { passados: 9, futuros: 2 }),
    ],
    rsvp_respostas: [], rsvp_espera: [], votes: [], team_join_requests: [],
  };
}

/** Embrulha o Supabase falso: registra cada consulta (tabela, colunas, início) e, se pedido, atrasa cada uma. */
function observar(cliente, atrasoMs = 0) {
  const obs = { consultas: [], t0: Date.now() };
  const from0 = cliente.from.bind(cliente);
  const esperar = () => (atrasoMs ? new Promise((r) => setTimeout(r, atrasoMs)) : Promise.resolve());
  cliente.from = (tabela) => {
    const b = from0(tabela);
    const registro = { tabela, colunas: null, inicio: Date.now() - obs.t0 };
    obs.consultas.push(registro);
    const select0 = b.select.bind(b);
    b.select = (cols, opts) => { registro.colunas = cols; return select0(cols, opts); };
    const then0 = b.then.bind(b);
    b.then = (ok, falha) => esperar().then(() => then0(ok, falha));
    for (const nome of ['maybeSingle', 'single']) {
      const f0 = b[nome];
      b[nome] = async () => { await esperar(); return f0(); };
    }
    return b;
  };
  return obs;
}

function mundo(t, { atrasoMs = 0, tabelas = tabelasPesadas() } = {}) {
  const restaurar = [
    injetar('utils/gabineteStore', { ler: async () => ({ ads_ativo: false }) }),
    injetar('utils/denunciaStore', { aoGravar: () => {}, listarEquipa: async () => [] }),
  ];
  const { carregados, cliente, tabelas: vivas } = carregar(tabelas, ['routes/inicio', 'services/inicio']);
  for (const r of restaurar.reverse()) r();
  const obs = observar(cliente, atrasoMs);
  const pedir = subir([carregados['routes/inicio']], t);
  return { pedir, obs, servico: carregados['services/inicio'], tabelas: vivas };
}

/** O que a TELA faz com a lista (pages/Inicio.jsx): próximos = não encerrados; últimos = os 3 mais recentes encerrados, não cancelados. */
function comoATelaVe(games, selectedTeam = 'all') {
  const filtrados = games.filter((g) => selectedTeam === 'all' || g.team_id === selectedTeam);
  return {
    proximos: filtrados.filter((g) => g.status !== 'finished').map((g) => g.id),
    ultimos: filtrados.filter((g) => g.status === 'finished' && !g.cancelado).slice(-3).reverse().map((g) => g.id),
  };
}

test('a lista de jogos do Início traz os que vão acontecer + os 3 últimos de cada time — não o histórico inteiro', async (t) => {
  const { pedir } = mundo(t);
  const r = await pedir('GET', '/api/inicio', null, DONO);
  assert.equal(r.status, 200);
  const jogos = r.json.convites.games;
  const encerrados = jogos.filter((g) => g.status === 'finished');
  assert.equal(jogos.filter((g) => g.status !== 'finished').length, 3, 'os 3 jogos por vir (1 do Missa, 2 do Várzea) estão todos');
  assert.equal(encerrados.length, 6, 'só 3 encerrados por time: 30 + 9 jogos de histórico viraram 6');
  assert.equal(encerrados.filter((g) => g.team_id === T2).length, 3);
  assert.equal(encerrados.filter((g) => g.team_id === T1).length, 3);
  assert.ok(encerrados.every((g) => !g.cancelado), 'cancelado nunca aparece na tela e não ocupa vaga dos 3');
  // Os do Missa são os mais recentes DEPOIS dos dois cancelados (p0 e p1): p2, p3, p4.
  assert.deepEqual(encerrados.filter((g) => g.team_id === T2).map((g) => g.id).sort(), ['missa-p2', 'missa-p3', 'missa-p4']);
  assert.deepEqual(encerrados.filter((g) => g.team_id === T1).map((g) => g.id).sort(), ['varzea-p0', 'varzea-p1', 'varzea-p2']);
  // A ordem é a de sempre (data ascendente): a tela pega "o próximo" e "os últimos" por ela.
  const datas = jogos.map((g) => new Date(g.date).getTime());
  assert.deepEqual(datas, [...datas].sort((a, b) => a - b));
});

test('a tela vê EXATAMENTE o mesmo que via com o histórico inteiro (todos os times e cada time)', async (t) => {
  const { pedir, servico } = mundo(t);
  const completo = (await servico.obterConvites(DONO)).games; // a rota antiga: tudo
  const limitado = (await pedir('GET', '/api/inicio', null, DONO)).json.convites.games;
  assert.ok(completo.length > limitado.length + 30, `o histórico completo tem ${completo.length} jogos; o do Início, ${limitado.length}`);
  for (const filtro of ['all', T1, T2]) {
    assert.deepEqual(comoATelaVe(limitado, filtro), comoATelaVe(completo, filtro), `filtro ${filtro === 'all' ? 'todos' : filtro}`);
  }
  // Os campos de cada jogo que sobrou são os mesmos de antes (contagem de confirmados, minha resposta, `eu_jogo`…).
  const porId = new Map(completo.map((g) => [g.id, g]));
  for (const g of limitado) assert.deepEqual(g, porId.get(g.id), g.id);
});

test('a rota antiga de convites (/api/games/my-invites) segue completa, sem limite', async (t) => {
  const { servico } = mundo(t);
  const { games } = await servico.obterConvites(DONO);
  assert.equal(games.length, 30 + 1 + 9 + 2);
});

test('quem é membro de quê é lido UMA vez no /api/inicio (eram 11 consultas de team_members)', async (t) => {
  const { pedir, obs } = mundo(t);
  const r = await pedir('GET', '/api/inicio', null, DONO);
  assert.equal(r.status, 200);
  const deVinculos = obs.consultas.filter((c) => c.tabela === 'team_members' && /revotar_pedido_em/.test(c.colunas || '') && /ausente_proximo/.test(c.colunas || ''));
  assert.equal(deVinculos.length, 1, 'uma só consulta de vínculos, com as colunas de todas as partes');
  const antigas = obs.consultas.filter((c) => c.tabela === 'team_members' && [
    'team_id, ausente_proximo, teams ( id, nome, slug )', // convites
    'team_id, teams ( id, slug, nome, revotar_pedido_em )', // votações pendentes
  ].includes(c.colunas));
  assert.equal(antigas.length, 0, 'convites e votações não fazem a sua própria consulta de vínculos');
  assert.ok(obs.consultas.filter((c) => c.tabela === 'team_members').length <= 7, `team_members: ${obs.consultas.filter((c) => c.tabela === 'team_members').length} consultas`);
});

test('o payload do Início é o mesmo de sempre: times (com papel e pacote), principal, RSVP do próximo jogo, sem campo novo', async (t) => {
  const { pedir } = mundo(t);
  const r = (await pedir('GET', '/api/inicio', null, DONO)).json;
  assert.deepEqual(r.teams.teams.map((x) => x.slug), ['missa', 'varzea-fc'], 'o principal é o vínculo mais antigo');
  const missa = r.teams.teams[0];
  assert.equal(missa.role, 'admin');
  assert.equal(missa.joga, true);
  assert.equal('revotar_pedido_em' in missa, false, 'a coluna do select compartilhado não vaza para a resposta');
  assert.equal('ausente_proximo' in missa, false);
  assert.equal(missa.pedidos_pendentes, 0, 'o contador do chip de quem administra segue lá');
  assert.ok(r.votacao_status && typeof r.votacao_status.total === 'number');
  assert.equal(r.campeonato.campeonato, null);
  // O próximo jogo é o mais próximo entre os times (Várzea em 2 dias): o RSVP é o dele.
  assert.ok(r.rsvp, 'o RSVP do próximo jogo veio');
  assert.equal(r.rsvp.rsvp_aberto, true);
});

/**
 * Quantas IDAS EM FILA fez o motor: agrupa as consultas em ondas pelo instante em que COMEÇARAM. Uma onda nova só nasce quando a
 * anterior terminou (a consulta de baixo depende da de cima), ou seja, ≥ ATRASO depois do começo dela; dentro de uma onda as
 * consultas começam juntas. Rodada 29H: o teste media o TEMPO de parede (< 4 × 100 ms) e reprovava com a máquina carregada (os
 * timers do Windows atrasam, 3 idas passavam de 400 ms sem nenhuma regressão). Contar as ondas pelos instantes de começo não
 * depende da pressa da máquina — só da ordem em que o código pergunta.
 */
function idasEmFila(consultas, atraso) {
  const folga = atraso * 0.75; // uma onda nova começa ≥ atraso depois; 0,75 absorve o jitter dos timers sem juntar duas ondas
  let ondas = 0;
  let comecoDaOnda = -Infinity;
  for (const c of [...consultas].sort((a, b) => a.inicio - b.inicio)) {
    if (c.inicio - comecoDaOnda >= folga) { ondas += 1; comecoDaOnda = c.inicio; }
  }
  return ondas;
}

test('a fila de idas ao banco caiu de 4 para 3: com 100 ms por consulta a conta de 2 times faz no máximo 3 idas em fila', async (t) => {
  const ATRASO = 100;
  const { pedir, obs } = mundo(t, { atrasoMs: ATRASO });
  const t0 = Date.now();
  const r = await pedir('GET', '/api/inicio', null, DONO);
  const ms = Date.now() - t0;
  assert.equal(r.status, 200);
  const idas = idasEmFila(obs.consultas, ATRASO);
  assert.ok(idas <= 3, `${idas} idas em fila — eram 4 antes da Rodada 29B; consultas: ${obs.consultas.map((c) => `${c.tabela}@${c.inicio}`).join(' ')}`);
  // O relógio fica só como rede de segurança larga (o teste não pode reprovar por pressa da máquina): 6 idas inteiras de folga.
  assert.ok(ms < 6 * ATRASO, `${ms} ms com ${ATRASO} ms por ida`);
  // O RSVP do próximo jogo sai numa ida só: suas consultas começam juntas, logo depois da lista de jogos.
  const rsvp = obs.consultas.filter((c) => c.tabela === 'rsvp_respostas' || c.tabela === 'rsvp_espera');
  assert.equal(rsvp.length, 2);
  assert.ok(Math.abs(rsvp[0].inicio - rsvp[1].inicio) < ATRASO / 2, 'respostas e fila do RSVP saem juntas');
});

test('RSVP com o time já conhecido: uma ida só; se o jogo for de outro time, refaz pelo caminho de sempre', async (t) => {
  const { servico } = mundo(t);
  const certo = await servico.obterRsvp('varzea-f0', DONO, { teamId: T1 });
  const semDica = await servico.obterRsvp('varzea-f0', DONO);
  assert.deepEqual(certo, semDica, 'com ou sem o time conhecido, a mesma resposta');
  const errado = await servico.obterRsvp('varzea-f0', DONO, { teamId: T2 });
  assert.deepEqual(errado, semDica, 'a dica errada não muda o resultado');
  await assert.rejects(() => servico.obterRsvp('nao-existe', DONO, { teamId: T1 }), /Jogo não encontrado/);
});

test('conta de 1 time e sem nenhum: a lista continua certa (sem jogos, sem time)', async (t) => {
  const sem = mundo(t, { tabelas: { ...tabelasPesadas(), team_members: [], games: [] } });
  const r = (await sem.pedir('GET', '/api/inicio', null, DONO)).json;
  assert.deepEqual(r.teams.teams, []);
  assert.deepEqual(r.convites.games, []);
  assert.equal(r.rsvp, null);
  assert.equal(r.votacao_status, null);
});
