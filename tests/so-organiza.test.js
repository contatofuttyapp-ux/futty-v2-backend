// Futty v2.0 — RODADA 29B (E): "SÓ ORGANIZO" — quem administra o time mas não joga (`team_members.joga = false`).
//
// As quatro regras do dono, provadas SEM banco e SEM rede (Supabase falso em memória, tests/_rotas.js):
//   1. RSVP     — não entra na lista de presença (nem responde, nem aparece como pendente/confirmado, nem vira elenco);
//   2. SORTEIO  — o sorteio só recebe quem joga;
//   3. RANKING  — não aparece no ranking;
//   4. PACOTE   — não conta no pacote do time (nem usa as gerações, nem ocupa uma das 25 vagas).
// Mais a leitura fail-safe de `joga` (sem a migração 067 ninguém só organiza e nada quebra).
//
// Uso: npm test  (ou: node --test tests/so-organiza.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarSupabaseFalso } = require('./_supabaseFalso');
const { carregar, subir } = require('./_rotas');

const TIME = '11111111-1111-1111-1111-111111111111';
const JOGO = '99999999-9999-9999-9999-999999999999';
const DONO = 'd0000000-0000-0000-0000-000000000001'; // admin que SÓ ORGANIZA
const ORG2 = 'd0000000-0000-0000-0000-000000000002'; // membro que só organiza
const A = 'a0000000-0000-0000-0000-00000000000a';
const B = 'b0000000-0000-0000-0000-00000000000b';
const C = 'c0000000-0000-0000-0000-00000000000c';
const D = 'e0000000-0000-0000-0000-00000000000d';

const usuario = (id, nome) => ({ id, nome, nome_jogador: nome, avatar_url: null, email: `${nome}@futtymock.com` });
const membro = (id, nome, extra = {}) => ({ team_id: TIME, user_id: id, role: 'member', users: usuario(id, nome), ...extra });
const FUTURO = new Date(Date.now() + 86400000).toISOString();

// ─── a leitura de `joga` ──────────────────────────────────────────────────────
test('leitura: os ids (de um time, de vários) e o "esta pessoa só organiza?"', async () => {
  const { criarSoOrganiza } = require('../utils/soOrganiza');
  const { cliente } = criarSupabaseFalso({
    team_members: [
      { team_id: TIME, user_id: DONO, role: 'admin', joga: false },
      { team_id: TIME, user_id: A, role: 'member', joga: true },
      { team_id: TIME, user_id: B, role: 'member' }, // linha antiga: sem a coluna = joga
      { team_id: 'outro', user_id: DONO, role: 'admin', joga: false },
      { team_id: 'outro', user_id: C, role: 'member', joga: false },
    ],
  });
  const s = criarSoOrganiza({ supabase: cliente });
  assert.deepEqual([...(await s.idsQueSoOrganizam(TIME))], [DONO]);
  assert.equal(await s.soOrganiza(TIME, DONO), true);
  assert.equal(await s.soOrganiza(TIME, A), false);
  assert.equal(await s.soOrganiza(TIME, B), false, 'sem a coluna na linha = joga');
  assert.deepEqual([...(await s.timesEmQueSoOrganiza(DONO))].sort(), [TIME, 'outro'].sort());
  const porTime = await s.organizadoresPorTime([TIME, 'outro']);
  assert.deepEqual([...porTime.get(TIME)], [DONO]);
  assert.deepEqual([...porTime.get('outro')].sort(), [DONO, C].sort());
  assert.equal((await s.organizadoresPorTime([])).size, 0);
});

test('leitura: sem a migração 067 (a coluna não existe) ninguém só organiza — e nada quebra', async () => {
  const { criarSoOrganiza } = require('../utils/soOrganiza');
  const falhar = (tabela) => (tabela === 'team_members' ? { message: 'column team_members.joga does not exist' } : null);
  const { cliente } = criarSupabaseFalso({ team_members: [{ team_id: TIME, user_id: DONO, role: 'admin' }] }, { falhar });
  const avisos = [];
  const aviso = console.warn;
  console.warn = (...a) => avisos.push(a.join(' '));
  try {
    const s = criarSoOrganiza({ supabase: cliente });
    assert.equal((await s.idsQueSoOrganizam(TIME)).size, 0);
    assert.equal(await s.soOrganiza(TIME, DONO), false);
    assert.equal((await s.timesEmQueSoOrganiza(DONO)).size, 0);
    assert.equal((await s.organizadoresPorTime([TIME])).size, 0);
  } finally {
    console.warn = aviso;
  }
  assert.equal(avisos.length, 1, 'avisa UMA vez no log, não a cada leitura');
  assert.match(avisos[0], /migração 067/);
});

// ─── 1. RSVP ──────────────────────────────────────────────────────────────────
function cenarioRsvp(t) {
  const { carregados, tabelas } = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc' }],
    team_members: [
      membro(DONO, 'Tonhão', { role: 'admin', joga: false }),
      membro(A, 'Magrão'),
      membro(B, 'Canhotinha'),
      membro(ORG2, 'Fiscal', { joga: false }),
    ],
    games: [{ id: JOGO, team_id: TIME, data: FUTURO, rsvp_aberto: true, rsvp_fechado: false, rsvp_prazo: FUTURO, max_jogadores: null }],
    rsvp_respostas: [],
    rsvp_espera: [],
    game_players: [],
  }, ['routes/rsvp', 'routes/games']);
  const pedir = subir([carregados['routes/rsvp'], carregados['routes/games']], t);
  return { pedir, tabelas };
}

test('RSVP: quem só organiza NÃO responde presença (403 com o motivo) e nada é gravado', async (t) => {
  const { pedir, tabelas } = cenarioRsvp(t);
  const r = await pedir('POST', `/api/jogos/${JOGO}/rsvp/responder`, { status: 'confirmado' }, ORG2);
  assert.equal(r.status, 403);
  assert.match(r.json.error, /só organiza este time/);
  assert.match(r.json.error, /lista de presença/);
  assert.equal((tabelas.rsvp_respostas || []).length, 0, 'nenhuma resposta gravada');
});

test('RSVP: quem joga responde normalmente', async (t) => {
  const { pedir, tabelas } = cenarioRsvp(t);
  const r = await pedir('POST', `/api/jogos/${JOGO}/rsvp/responder`, { status: 'confirmado' }, A);
  assert.equal(r.status, 200);
  assert.deepEqual(tabelas.rsvp_respostas.map((x) => [x.user_id, x.status]), [[A, 'confirmado']]);
});

test('RSVP: a lista de presença não tem quem só organiza (nem como pendente) e diz `eu_jogo`', async (t) => {
  const { pedir, tabelas } = cenarioRsvp(t);
  tabelas.rsvp_respostas.push({ game_id: JOGO, user_id: A, status: 'confirmado' }, { game_id: JOGO, user_id: B, status: 'recusado' });
  const vistaDoJogador = (await pedir('GET', `/api/jogos/${JOGO}/rsvp`, null, A)).json;
  assert.deepEqual(vistaDoJogador.confirmados.map((u) => u.id), [A]);
  assert.deepEqual(vistaDoJogador.recusados.map((u) => u.id), [B]);
  assert.deepEqual(vistaDoJogador.pendentes.map((u) => u.id), [], 'o dono e o fiscal só organizam: não são pendentes');
  assert.equal(vistaDoJogador.eu_jogo, true);
  const vistaDoDono = (await pedir('GET', `/api/jogos/${JOGO}/rsvp`, null, DONO)).json;
  assert.equal(vistaDoDono.eu_jogo, false, 'o app esconde o "Vou / Não vou" de quem só organiza');
});

test('RSVP: ao fechar, o elenco só recebe quem joga (mesmo que o organizador tivesse respondido antes de mudar de papel)', async (t) => {
  const { pedir, tabelas } = cenarioRsvp(t);
  tabelas.rsvp_respostas.push(
    { game_id: JOGO, user_id: A, status: 'confirmado' },
    { game_id: JOGO, user_id: ORG2, status: 'confirmado' }, // respondeu quando ainda jogava
  );
  const r = await pedir('POST', `/api/jogos/${JOGO}/rsvp/fechar`, {}, DONO);
  assert.equal(r.status, 200);
  assert.deepEqual(tabelas.game_players.map((x) => x.user_id), [A]);
});

test('presença: "confirmar" de quem só organiza → 403; desmarcar continua valendo; a checklist do admin ignora quem só organiza', async (t) => {
  const { pedir, tabelas } = cenarioRsvp(t);
  const nega = await pedir('POST', `/api/games/${JOGO}/confirmar`, { confirmado: true }, ORG2);
  assert.equal(nega.status, 403);
  assert.match(nega.json.error, /só organiza/);
  const desmarca = await pedir('POST', `/api/games/${JOGO}/confirmar`, { confirmado: false }, ORG2);
  assert.equal(desmarca.status, 200, 'sair da lista nunca é bloqueado');
  const ok = await pedir('POST', `/api/games/${JOGO}/confirmar`, { confirmado: true }, A);
  assert.equal(ok.status, 200);
  const lista = await pedir('POST', `/api/games/${JOGO}/presencas`, { jogadores: [{ user_id: B }, { user_id: ORG2 }, { user_id: DONO }] }, DONO);
  assert.equal(lista.status, 200);
  const confirmados = tabelas.game_players.filter((g) => g.confirmado).map((g) => g.user_id);
  assert.deepEqual(confirmados, [B], 'só quem joga fica na checklist do admin');
});

// ─── 2. SORTEIO ───────────────────────────────────────────────────────────────
test('SORTEIO: só entra quem joga — quem só organiza fica fora dos times e das reservas', async (t) => {
  const linhaDoElenco = (id, nome) => ({ game_id: JOGO, user_id: id, confirmado: true, goleiro: false, cabeca_chave: false, users: usuario(id, nome) });
  const { carregados } = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc' }],
    team_members: [membro(DONO, 'Tonhão', { role: 'admin', joga: false }), membro(A, 'Magrão'), membro(B, 'Canhotinha'), membro(C, 'Zé'), membro(D, 'Pedrinho'), membro(ORG2, 'Fiscal', { joga: false })],
    games: [{ id: JOGO, team_id: TIME, data: FUTURO, jogadores_por_time: 2, status: 'agendado' }],
    game_players: [linhaDoElenco(A, 'Magrão'), linhaDoElenco(B, 'Canhotinha'), linhaDoElenco(C, 'Zé'), linhaDoElenco(D, 'Pedrinho'), linhaDoElenco(ORG2, 'Fiscal'), linhaDoElenco(DONO, 'Tonhão')],
  }, ['routes/games']);
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('POST', `/api/games/${JOGO}/sortear`, {}, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const res = r.json.game.times_resultado;
  assert.equal(res.total_jogadores, 4, 'são 4 jogadores, não 6 confirmados');
  const sorteados = [...res.times.flatMap((x) => x.jogadores), ...res.reservas].map((j) => j.user_id).sort();
  assert.deepEqual(sorteados, [A, B, C, D].sort());
  assert.ok(!sorteados.includes(ORG2) && !sorteados.includes(DONO));
});

// ─── 3. RANKING ───────────────────────────────────────────────────────────────
test('RANKING: quem só organiza não aparece', async () => {
  const jogos = ['j1', 'j2', 'j3'].map((id) => ({ id, team_id: TIME, data: '2026-09-01T20:00:00Z', status: 'terminado' }));
  const presencas = jogos.flatMap((g) => [A, B, ORG2, DONO].map((u) => ({ game_id: g.id, user_id: u, confirmado: true })));
  const { carregados } = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc' }],
    team_members: [membro(DONO, 'Tonhão', { role: 'admin', joga: false }), membro(A, 'Magrão'), membro(B, 'Canhotinha'), membro(ORG2, 'Fiscal', { joga: false })],
    votes: [],
    games: jogos,
    game_players: presencas,
    gols_jogadores: [],
  }, ['routes/ranking']);
  const ranking = await carregados['routes/ranking'].buildRanking(TIME, A);
  assert.deepEqual(ranking.map((r) => r.user_id).sort(), [A, B].sort());
});

test('RANKING: sem a regra os quatro apareceriam (controle: o teste enxerga a diferença)', async () => {
  const jogos = ['j1', 'j2', 'j3'].map((id) => ({ id, team_id: TIME, data: '2026-09-01T20:00:00Z', status: 'terminado' }));
  const presencas = jogos.flatMap((g) => [A, B, ORG2].map((u) => ({ game_id: g.id, user_id: u, confirmado: true })));
  const { carregados } = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc' }],
    team_members: [membro(A, 'Magrão'), membro(B, 'Canhotinha'), membro(ORG2, 'Fiscal')], // ninguém só organiza
    votes: [], games: jogos, game_players: presencas, gols_jogadores: [],
  }, ['routes/ranking']);
  const ranking = await carregados['routes/ranking'].buildRanking(TIME, A);
  assert.deepEqual(ranking.map((r) => r.user_id).sort(), [A, B, ORG2].sort());
});

// ─── 4. PACOTE ────────────────────────────────────────────────────────────────
const TIME_COM_PACOTE = (limite = 25) => ({ id: TIME, brilhante_ativo: true, brilhante_kit: 'dark-gold', brilhante_limite: limite, brilhante_por_jogador: 2 });
const minhaLinhaDoPacote = (id, extra = {}) => ({ team_id: TIME, user_id: id, role: 'member', teams: TIME_COM_PACOTE(extra.limite), ...extra.linha });

test('PACOTE: quem joga usa o pacote do time; quem só organiza NÃO (não usa as gerações)', async () => {
  const comPacote = carregar({ users: [{ id: A, brilhante_creditos: 0 }], team_members: [minhaLinhaDoPacote(A)], brilhantes_time: [] }, ['utils/direitoBrilhante']);
  const joga = await comPacote.carregados['utils/direitoBrilhante'].temDireito(A);
  assert.equal(joga.fonte, 'time');
  assert.equal(joga.restantes, 2);

  const organizador = carregar({ users: [{ id: A, brilhante_creditos: 0 }], team_members: [minhaLinhaDoPacote(A, { linha: { joga: false } })], brilhantes_time: [] }, ['utils/direitoBrilhante']);
  const naoJoga = await organizador.carregados['utils/direitoBrilhante'].temDireito(A);
  assert.equal(naoJoga.fonte, null);
  assert.equal(naoJoga.restantes, 0);
  assert.deepEqual(naoJoga.opcoes, []);
});

test('PACOTE: o crédito de Minha Figurinha continua valendo para quem só organiza (é dele, não do time)', async () => {
  const { carregados } = carregar({ users: [{ id: A, brilhante_creditos: 3 }], team_members: [minhaLinhaDoPacote(A, { linha: { joga: false } })], brilhantes_time: [] }, ['utils/direitoBrilhante']);
  const d = await carregados['utils/direitoBrilhante'].temDireito(A);
  assert.equal(d.fonte, 'credito');
  assert.equal(d.restantes, 3);
});

test('PACOTE: as 25 vagas são de JOGADORES — a linha de quem hoje só organiza não ocupa vaga', async () => {
  // limite 2; duas linhas no pacote: a do dono (que gerou quando ainda jogava, hoje só organiza) e a de outra pessoa.
  const tabelas = (donoSoOrganiza) => ({
    users: [{ id: A, brilhante_creditos: 0 }],
    team_members: [minhaLinhaDoPacote(A, { limite: 2 }), { team_id: TIME, user_id: DONO, role: 'admin', ...(donoSoOrganiza ? { joga: false } : {}) }],
    brilhantes_time: [{ team_id: TIME, user_id: DONO, kit_id: 'dark-gold', geracoes: 1 }, { team_id: TIME, user_id: B, kit_id: 'dark-gold', geracoes: 1 }],
  });
  const cheio = carregar(tabelas(false), ['utils/direitoBrilhante']);
  assert.equal((await cheio.carregados['utils/direitoBrilhante'].temDireito(A)).fonte, null, 'controle: 2 linhas de 2 vagas = cheio');
  const comFolga = carregar(tabelas(true), ['utils/direitoBrilhante']);
  const d = await comFolga.carregados['utils/direitoBrilhante'].temDireito(A);
  assert.equal(d.fonte, 'time', 'a linha do organizador não conta: sobra 1 vaga');
  assert.equal(d.teamId, TIME);
});
