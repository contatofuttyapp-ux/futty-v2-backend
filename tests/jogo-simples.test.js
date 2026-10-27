// Futty v2.0 — Rodada 32H, o jogo simples, no app de verdade sobre banco de mentira (tests/_appFalsa.js):
//   · criar o jogo já CHAMA (o elenco, ou só os escolhidos) e avisa — o aviso fica registrado (jogo_avisos) e sai pelo Web Push;
//   · chamar mais gente depois, e quem entra no time, recebem a chamada na hora; mudar data/hora/local avisa quem foi chamado;
//   · a hora do sorteio: 1 h antes por padrão, anda junto quando o jogo muda (se era a de padrão), e a lista fecha nela — ou quando o
//     admin sorteia antes; "abrir" e "fechar" presença não mudam mais nada;
//   · "Vou / Não vou" vale na hora para o elenco do sorteio (game_players); quem não foi chamado não responde;
//   · sem a migração 089 nada cai; o link atual do convite com a validade; e "presença" deixou de ser pendência do admin.
//
// Uso: npm test  (ou: node --test tests/jogo-simples.test.js)
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { subirApp, usuario } = require('./_appFalsa');

let app;
const pushes = [];
before(async () => {
  app = await subirApp();
  require('../routes/push').enviarNotificacao = async (ids, payload, opcoes) => { pushes.push({ ids: [...ids].sort(), ...payload, categoria: opcoes?.categoria }); };
});
after(() => app.fechar());

const HORA = 3600 * 1000;
const em = (ms) => new Date(Date.now() + ms).toISOString();
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = { admin: usuario(uuid(1), 'Chavo'), ana: usuario(uuid(2), 'Ana'), beto: usuario(uuid(3), 'Beto'), caio: usuario(uuid(4), 'Caio'), org: usuario(uuid(5), 'Zé') };
const TIME = { id: uuid(100), slug: 'missa', nome: 'Missa de Quinta', fuso: 'America/Sao_Paulo', criado_por: P.admin.id, created_at: '2026-01-01T00:00:00Z' };
const membro = (n, user, role = 'member', joga = true) => ({ id: uuid(200 + n), team_id: TIME.id, user_id: user.id, role, joga, created_at: '2026-01-02T00:00:00Z' });
const espera = (ms = 20) => new Promise((ok) => setTimeout(ok, ms));
const pedir = (quem, metodo, rota, corpo) => app.pedir(metodo, rota, { token: app.token(P[quem].id), corpo });

beforeEach(() => {
  pushes.length = 0;
  require('../utils/colunasDaChamada').esquecerFalta();
  app.reiniciar({
    tabelas: {
      teams: [TIME],
      team_members: [membro(1, P.admin, 'admin'), membro(2, P.ana), membro(3, P.beto), membro(4, P.org, 'member', false)],
      games: [], game_players: [], rsvp_respostas: [], rsvp_espera: [], jogo_avisos: [], convites: [], convite_usos: [],
    },
    usuarios: Object.values(P),
  });
});

const criar = (corpo = {}) => pedir('admin', 'POST', '/api/games', { team_slug: 'missa', data: em(48 * HORA), local: 'Arena', ...corpo });

test('criar o jogo já chama o elenco (quem só organiza fica fora) e avisa — registrado e pelo Web Push, nunca para quem criou', async () => {
  const r = await criar();
  assert.equal(r.status, 201, r.texto);
  const g = r.json.game;
  assert.equal(new Date(g.data).getTime() - new Date(g.sorteio_em).getTime(), HORA, 'sorteio 1 h antes do jogo');
  await espera();
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].ids, [P.ana.id, P.beto.id].sort());
  assert.equal(pushes[0].title, '⚽ Jogo marcado: Missa de Quinta');
  assert.match(pushes[0].body, /Arena\. Você vai\? Responda no app\./);
  assert.equal(pushes[0].categoria, 'jogos');
  const aviso = app.tabelas.jogo_avisos.at(-1);
  assert.equal(aviso.tipo, 'criado');
  assert.deepEqual([...aviso.destinatarios].sort(), [P.ana.id, P.beto.id].sort());
  assert.ok(aviso.web_enviado_em, 'o registro sabe que o Web Push saiu');
  // sem ninguém abrir nada, o "Você vai?" já vale
  const vou = await pedir('ana', 'POST', `/api/jogos/${g.id}/rsvp/responder`, { status: 'confirmado' });
  assert.equal(vou.status, 200, vou.texto);
  assert.equal(app.tabelas.game_players.find((x) => x.user_id === P.ana.id)?.confirmado, true, 'o "Vou" já está no elenco do sorteio');
  assert.equal((await pedir('org', 'POST', `/api/jogos/${g.id}/rsvp/responder`, { status: 'confirmado' })).status, 403, 'quem só organiza não responde');
});

test('jogo histórico não chama nem avisa ninguém', async () => {
  const r = await criar({ data: em(-48 * HORA), historico: true });
  assert.equal(r.status, 201, r.texto);
  await espera();
  assert.equal(pushes.length, 0);
});

test('só os escolhidos: os outros não respondem e não são pendentes; chamar depois → a pessoa recebe a chamada na hora', async () => {
  const g = (await criar({ chamados: [P.ana.id] })).json.game;
  await espera();
  assert.deepEqual(pushes[0].ids, [P.ana.id]);
  const nao = await pedir('beto', 'POST', `/api/jogos/${g.id}/rsvp/responder`, { status: 'confirmado' });
  assert.equal(nao.status, 403);
  assert.equal(nao.json.code, 'NAO_CHAMADO');
  const lista = (await pedir('admin', 'GET', `/api/jogos/${g.id}/rsvp`)).json;
  assert.deepEqual(lista.pendentes.map((u) => u.id), [P.ana.id]);
  assert.equal((await pedir('beto', 'GET', `/api/jogos/${g.id}/rsvp`)).json.chamado, false);
  // chamar mais gente: só o admin; quem só organiza e quem não é do time não entram
  assert.equal((await pedir('ana', 'POST', `/api/games/${g.id}/chamar`, { user_ids: [P.beto.id] })).status, 403);
  pushes.length = 0;
  const c = await pedir('admin', 'POST', `/api/games/${g.id}/chamar`, { user_ids: [P.beto.id, P.org.id, uuid(999)] });
  assert.equal(c.status, 200, c.texto);
  assert.deepEqual(c.json.novos, [P.beto.id]);
  await espera();
  assert.equal(pushes[0].title, '⚽ Você foi chamado para o jogo do Missa de Quinta');
  assert.deepEqual(pushes[0].ids, [P.beto.id]);
  assert.equal((await pedir('beto', 'POST', `/api/jogos/${g.id}/rsvp/responder`, { status: 'recusado' })).status, 200);
  // escolher todo mundo que joga = o elenco inteiro (quem entrar depois também)
  const todos = (await criar({ chamados: [P.ana.id, P.beto.id, P.admin.id] })).json.game;
  assert.equal(app.tabelas.games.find((x) => x.id === todos.id).chamados, undefined);
  assert.equal((await pedir('admin', 'POST', `/api/games/${todos.id}/chamar`, { user_ids: [P.ana.id] })).json.code, 'ELENCO_INTEIRO');
});

test('quem entra no time é chamado para os jogos do elenco inteiro (e avisado); jogo com escolhidos não muda', async () => {
  const inteiro = (await criar()).json.game;
  const escolhidos = (await criar({ chamados: [P.ana.id], data: em(72 * HORA) })).json.game;
  await espera();
  pushes.length = 0;
  const conv = await pedir('admin', 'POST', '/api/teams/missa/convite', {});
  assert.equal(conv.status, 201, conv.texto);
  const entra = await pedir('caio', 'POST', `/api/convite/${conv.json.token}/aceitar`, {});
  assert.equal(entra.status, 201, entra.texto);
  await espera(40);
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].ids, [P.caio.id]);
  assert.equal(pushes[0].url, `/time/missa/jogo/${inteiro.id}`);
  assert.equal((await pedir('caio', 'POST', `/api/jogos/${inteiro.id}/rsvp/responder`, { status: 'confirmado' })).status, 200);
  assert.equal((await pedir('caio', 'POST', `/api/jogos/${escolhidos.id}/rsvp/responder`, { status: 'confirmado' })).json.code, 'NAO_CHAMADO');
});

test('mudar data/hora/local avisa quem foi chamado; o sorteio "1 h antes" anda junto; o escolhido fica; só a hora do sorteio não avisa', async () => {
  const g = (await criar()).json.game;
  await espera();
  pushes.length = 0;
  const amanha = new Date(Date.now() + 72 * HORA);
  const dia = amanha.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const r = await pedir('admin', 'PATCH', `/api/games/${g.id}`, { date: dia, time: '21:30', location: 'Society Madalena' });
  assert.equal(r.status, 200, r.texto);
  assert.equal(new Date(r.json.game.data).getTime() - new Date(r.json.game.sorteio_em).getTime(), HORA, 'o sorteio veio junto (1 h antes)');
  await espera();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, '📅 O jogo do Missa de Quinta mudou');
  assert.match(pushes[0].body, /^Agora: .* · 21:30 · Society Madalena\.$/);
  assert.deepEqual(pushes[0].ids, [P.ana.id, P.beto.id].sort());
  assert.equal(app.tabelas.jogo_avisos.at(-1).tipo, 'mudou');
  // sorteio escolhido pelo admin: fica quando o jogo muda (se ainda cabe antes dele)
  pushes.length = 0;
  const s = await pedir('admin', 'PATCH', `/api/games/${g.id}`, { sorteio_date: dia, sorteio_time: '18:00' });
  assert.equal(s.status, 200, s.texto);
  await espera();
  assert.equal(pushes.length, 0, 'mudar só a hora do sorteio não avisa');
  const s2 = await pedir('admin', 'PATCH', `/api/games/${g.id}`, { time: '22:00' });
  assert.equal(new Date(s2.json.game.sorteio_em).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }), '18:00');
  assert.equal((await pedir('admin', 'PATCH', `/api/games/${g.id}`, { sorteio_date: dia, sorteio_time: '23:00' })).status, 400, 'sorteio depois do jogo');
});

test('a lista fecha na hora do sorteio, ou quando o admin sorteia antes; "abrir"/"fechar" presença não mudam nada', async () => {
  const g = (await criar({ sorteio_em: em(30 * 60 * 1000) })).json.game;
  assert.equal((await pedir('ana', 'POST', `/api/jogos/${g.id}/rsvp/responder`, { status: 'confirmado' })).status, 200);
  // o relógio passa da hora do sorteio
  app.tabelas.games.find((x) => x.id === g.id).sorteio_em = em(-60 * 1000);
  const fechada = await pedir('beto', 'POST', `/api/jogos/${g.id}/rsvp/responder`, { status: 'confirmado' });
  assert.equal(fechada.status, 409);
  assert.equal(fechada.json.code, 'LISTA_FECHADA');
  const lista = (await pedir('beto', 'GET', `/api/jogos/${g.id}/rsvp`)).json;
  assert.equal(lista.lista_aberta, false);
  assert.equal(lista.confirmados.length, 1);
  // sortear antes: outro jogo, sorteio daqui a 1 dia, o admin sorteia agora → fecha
  const h = (await criar({ data: em(96 * HORA) })).json.game;
  for (const k of ['ana', 'beto']) await pedir(k, 'POST', `/api/jogos/${h.id}/rsvp/responder`, { status: 'confirmado' });
  app.tabelas.games.find((x) => x.id === h.id).sorteio_realizado = true;
  assert.equal((await pedir('ana', 'POST', `/api/jogos/${h.id}/rsvp/responder`, { status: 'recusado' })).json.code, 'LISTA_FECHADA');
  // abrir/fechar: 200, nada muda
  const antes = JSON.stringify(app.tabelas.games.find((x) => x.id === g.id));
  assert.equal((await pedir('admin', 'POST', `/api/jogos/${g.id}/rsvp/abrir`, { prazo: em(HORA) })).status, 200);
  assert.equal((await pedir('admin', 'POST', `/api/jogos/${g.id}/rsvp/fechar`, {})).status, 200);
  assert.equal(JSON.stringify(app.tabelas.games.find((x) => x.id === g.id)), antes);
});

test('"Não vou" tira do elenco na hora; lotação: o 2º "Vou" vai para a espera e entra quando o 1º desiste', async () => {
  const g = (await criar()).json.game;
  await pedir('admin', 'PATCH', `/api/games/${g.id}/capacidade`, { max_jogadores: 1 });
  assert.equal((await pedir('ana', 'POST', `/api/jogos/${g.id}/rsvp/responder`, { status: 'confirmado' })).json.status, 'confirmado');
  const fila = await pedir('beto', 'POST', `/api/jogos/${g.id}/rsvp/responder`, { status: 'confirmado' });
  assert.deepEqual([fila.json.espera, fila.json.posicao], [true, 1]);
  assert.equal(app.tabelas.game_players.find((x) => x.user_id === P.beto.id)?.confirmado, false, 'na espera não está no elenco');
  await pedir('ana', 'POST', `/api/jogos/${g.id}/rsvp/responder`, { status: 'recusado' });
  const elenco = app.tabelas.game_players.filter((x) => x.confirmado).map((x) => x.user_id);
  assert.deepEqual(elenco, [P.beto.id], 'a Ana saiu e o Beto entrou da espera');
  // o /confirmar antigo passa pela mesma porta (e marcar só o goleiro vale mesmo com a lista fechada)
  app.tabelas.games.find((x) => x.id === g.id).sorteio_realizado = true;
  assert.equal((await pedir('beto', 'POST', `/api/games/${g.id}/confirmar`, { confirmado: false })).status, 409);
  assert.equal((await pedir('beto', 'POST', `/api/games/${g.id}/confirmar`, { confirmado: true, goleiro: true })).status, 200);
});

test('o detalhe do jogo e o Início levam a hora do sorteio, a lista aberta, se fui chamado e a minha vez na espera', async () => {
  const g = (await criar({ chamados: [P.ana.id] })).json.game;
  const det = (await pedir('ana', 'GET', `/api/games/${g.id}`)).json;
  assert.equal(det.game.sorteio_em, g.sorteio_em);
  assert.equal(det.game.lista_aberta, true);
  assert.equal(det.chamado, true);
  assert.equal('chamados' in det.game, false, 'a lista de chamados é coisa do admin');
  assert.deepEqual((await pedir('admin', 'GET', `/api/games/${g.id}`)).json.game.chamados, [P.ana.id]);
  const inicio = (await pedir('beto', 'GET', '/api/inicio')).json;
  const noInicio = (inicio.games || inicio.convites?.games || []).find((x) => x.id === g.id);
  assert.ok(noInicio, JSON.stringify(Object.keys(inicio)));
  assert.equal(noInicio.chamado, false);
  assert.equal(noInicio.lista_aberta, true);
  assert.equal(noInicio.sorteio_em, g.sorteio_em);
  assert.equal(noInicio.espera_posicao, null);
});

test('sem a migração 089: criar, ler e responder funcionam (sorteio 1 h antes, elenco inteiro); escolher quem chamar diz 503', async () => {
  app.falhar((tabela, _op, e) => {
    const linhas = JSON.stringify(e.linhas || e.patch || '');
    if ((tabela === 'games' && (/sorteio_em|chamados/.test(e.cols || '') || /sorteio_em|chamados/.test(linhas))) || tabela === 'jogo_avisos') {
      return { message: `column "sorteio_em" of relation "${tabela}" does not exist` };
    }
    return null;
  });
  const r = await criar();
  assert.equal(r.status, 201, r.texto);
  assert.equal(new Date(r.json.game.data).getTime() - new Date(r.json.game.sorteio_em).getTime(), HORA);
  assert.equal((await pedir('ana', 'POST', `/api/jogos/${r.json.game.id}/rsvp/responder`, { status: 'confirmado' })).status, 200);
  assert.equal((await pedir('ana', 'GET', '/api/inicio')).status, 200);
  await espera();
  assert.equal(pushes.length, 1, 'o aviso sai mesmo sem a tabela de registro');
  const c = await criar({ chamados: [P.ana.id] });
  assert.equal(c.status, 503);
  assert.equal(c.json.code, 'CHAMADA_INDISPONIVEL');
});

test('o link ATUAL do convite: o mais recente, com a validade; vencido diz vencido; sem link, null', async () => {
  assert.deepEqual((await pedir('ana', 'GET', '/api/teams/missa/convite/atual')).json, { convite: null });
  const novo = await pedir('ana', 'POST', '/api/teams/missa/convite', {});
  const atual = (await pedir('ana', 'GET', '/api/teams/missa/convite/atual')).json.convite;
  assert.equal(atual.token, novo.json.token);
  assert.equal(atual.vencido, false);
  assert.ok(Math.abs(new Date(atual.expires_at).getTime() - (Date.now() + 30 * 24 * HORA)) < 60000, 'vale 30 dias');
  app.tabelas.convites.find((x) => x.token === novo.json.token).expires_at = em(-HORA);
  assert.equal((await pedir('ana', 'GET', '/api/teams/missa/convite/atual')).json.convite.vencido, true);
  assert.equal((await pedir('admin', 'GET', '/api/teams/outro/convite/atual')).status, 404);
});

test('a presença do jogo diz a minha resposta, quem ainda não foi chamado (o admin chama daí) e lê o "Vou" dos jogos de antes', async () => {
  const g = (await criar({ chamados: [P.ana.id] })).json.game;
  await pedir('ana', 'POST', `/api/jogos/${g.id}/rsvp/responder`, { status: 'recusado' });
  const r = (await pedir('ana', 'GET', `/api/jogos/${g.id}/rsvp`)).json;
  assert.equal(r.minha_resposta, 'recusado');
  assert.deepEqual(r.nao_chamados.map((u) => u.id), [P.admin.id, P.beto.id].sort(), 'o elenco que joga e não foi chamado (quem só organiza, nunca)');
  assert.deepEqual(r.recusados.map((u) => u.id), [P.ana.id]);
  // Jogo de antes da porta única: o "Vou" ficou só no elenco do jogo (game_players), sem linha na lista.
  const velho = (await criar()).json.game;
  app.tabelas.game_players.push({ id: uuid(900), game_id: velho.id, user_id: P.beto.id, confirmado: true, goleiro: false });
  const v = (await pedir('beto', 'GET', `/api/jogos/${velho.id}/rsvp`)).json;
  assert.equal(v.minha_resposta, 'confirmado');
  assert.deepEqual(v.confirmados.map((u) => u.id), [P.beto.id], 'conta como confirmado, como no Início e no sorteio');
  assert.deepEqual(v.nao_chamados, [], 'jogo do elenco inteiro: ninguém fora');
});

test('a lista de jogos do time leva a hora do sorteio, a lista aberta e (só para o admin) quem foi chamado; conta pelo elenco do jogo', async () => {
  const g = (await criar({ chamados: [P.ana.id] })).json.game;
  await pedir('ana', 'POST', `/api/jogos/${g.id}/rsvp/responder`, { status: 'confirmado' });
  const doAdmin = (await pedir('admin', 'GET', '/api/teams/missa/games')).json.games.find((x) => x.id === g.id);
  assert.equal(doAdmin.sorteio_em, g.sorteio_em);
  assert.equal(doAdmin.lista_aberta, true);
  assert.deepEqual(doAdmin.chamados, [P.ana.id]);
  assert.equal(doAdmin.confirmados, 1);
  const doMembro = (await pedir('beto', 'GET', '/api/teams/missa/games')).json.games.find((x) => x.id === g.id);
  assert.equal('chamados' in doMembro, false, 'quem foi chamado é coisa do admin');
});

test('o Início lê a resposta pelo elenco do jogo: "Vou" → going e a contagem sobe; "Não vou" → not_going', async () => {
  const g = (await criar()).json.game;
  await pedir('ana', 'POST', `/api/jogos/${g.id}/rsvp/responder`, { status: 'confirmado' });
  let jogo = (await pedir('ana', 'GET', '/api/inicio')).json.convites.games.find((x) => x.id === g.id);
  assert.deepEqual([jogo.user_status, jogo.confirmed_count], ['going', 1]);
  await pedir('ana', 'POST', `/api/jogos/${g.id}/rsvp/responder`, { status: 'recusado' });
  jogo = (await pedir('ana', 'GET', '/api/inicio')).json.convites.games.find((x) => x.id === g.id);
  assert.deepEqual([jogo.user_status, jogo.confirmed_count], ['not_going', 0]);
});
