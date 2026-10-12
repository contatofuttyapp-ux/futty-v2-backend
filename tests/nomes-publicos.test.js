// Futty v2.0 — Rodada 30N (4): onde o nome aparece SEM login — a página pública do sorteio, a do campeonato, o convite — sai o APELIDO
// (o nome de jogador do app), nunca o nome completo. Quem ainda não tem apelido aparece só pelo primeiro nome.
//
// O app de verdade (tests/_appFalsa.js) sobre banco falso. Os usuários do mundo de segurança se chamam "Ana da Silva" (nome) e "Ana"
// (apelido): qualquer "da Silva" na resposta pública é vazamento do nome completo.
//
// Uso: node --test tests/nomes-publicos.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { subirApp, usuario } = require('./_appFalsa');
const { criarMundo, uuid } = require('./_mundoDeSeguranca');
const { nomePublico, mapaDeNomesPublicos, comNomesPublicos } = require('../utils/nomePublico');

let app;
before(async () => { app = await subirApp(); });
after(() => app.fechar());

// ─── a regra, pura ────────────────────────────────────────────────────────────
test('nomePublico: apelido; sem apelido o primeiro nome; sem nada "Jogador" — nunca o nome completo nem o e-mail', () => {
  assert.equal(nomePublico({ nome: 'Ana da Silva', nome_jogador: 'Aninha' }), 'Aninha');
  assert.equal(nomePublico({ nome: 'Ana da Silva', nome_jogador: '  Aninha  ' }), 'Aninha');
  assert.equal(nomePublico({ nome: 'Ana da Silva', nome_jogador: null }), 'Ana');
  assert.equal(nomePublico({ nome: 'Ana da Silva', nome_jogador: '   ' }), 'Ana');
  assert.equal(nomePublico({ nome: '  Roberto   Carlos Pereira ' }), 'Roberto');
  assert.equal(nomePublico({ nome: null, nome_jogador: null, email: 'x@y.com' }), 'Jogador');
  assert.equal(nomePublico(null), 'Jogador');
  assert.equal(nomePublico(undefined), 'Jogador');
  assert.equal(nomePublico({}), 'Jogador');
});

test('comNomesPublicos: troca só quem tem conta e está no mapa (times, reservas e o original do ajuste); convidado e conta apagada ficam; não altera o recebido', () => {
  const tr = {
    times: [{ nome: 'Time A', jogadores: [{ user_id: 'u1', nome: 'Ana da Silva' }, { user_id: null, convidado: true, nome: 'Beto Convidado Sobrenome' }] }],
    reservas: [{ user_id: 'u2', nome: 'Carlos Souza' }, { user_id: 'apagada', nome: 'Antiga Pessoa' }],
    registro: { original: { times: [{ nome: 'Time A', jogadores: [{ user_id: 'u1', nome: 'Ana da Silva' }] }], reservas: [] } },
  };
  const copia = JSON.stringify(tr);
  const novo = comNomesPublicos(tr, new Map([['u1', 'Aninha'], ['u2', 'Carlos']]));
  assert.equal(novo.times[0].jogadores[0].nome, 'Aninha');
  assert.equal(novo.times[0].jogadores[1].nome, 'Beto Convidado Sobrenome', 'convidado sem app: o nome que o admin digitou');
  assert.equal(novo.reservas[0].nome, 'Carlos');
  assert.equal(novo.reservas[1].nome, 'Antiga Pessoa', 'conta apagada: fica o do snapshot');
  assert.equal(novo.registro.original.times[0].jogadores[0].nome, 'Aninha', 'o sorteio de antes do ajuste também');
  assert.equal(JSON.stringify(tr), copia, 'o objeto recebido não foi alterado');
  assert.equal(comNomesPublicos(tr, new Map()), tr, 'mapa vazio: devolve o mesmo');
  assert.equal(comNomesPublicos(null, new Map([['u1', 'x']])), null);
  assert.deepEqual([...mapaDeNomesPublicos([{ id: 'a', nome: 'Z Y', nome_jogador: 'Zé' }, { id: 'b', nome: 'Maria Lima' }, null])], [['a', 'Zé'], ['b', 'Maria']]);
});

// ─── a página pública do sorteio ──────────────────────────────────────────────
/** O jogo passado do time A com o sorteio como o motor o gravava ANTES da regra (nome completo de quem não tinha apelido) e os gols lançados. */
function sorteioAntigoComGols(m) {
  const semApelido = usuario(uuid('a4', m.n), 'Roberto', { nome: 'Roberto Carlos Pereira', nome_jogador: null });
  app.tabelas.users.push({ ...semApelido });
  const snap = {
    seed: 1, num_times: 2, reservas: [{ user_id: semApelido.id, nome: 'Roberto Carlos Pereira', avatar_url: null, rating: 3 }],
    times: [
      { nome: 'Time 1', jogadores: [{ user_id: m.p.admA.id, nome: 'Ana da Silva', avatar_url: null, rating: 3 }, { user_id: null, convidado: true, nome: 'Zeca Convidado', avatar_url: null, rating: 3 }] },
      { nome: 'Time 2', jogadores: [{ user_id: m.p.memA.id, nome: 'Alice da Silva', avatar_url: null, rating: 3 }] },
    ],
    registro: { origem: 'sorteio', por: { id: m.p.admA.id, nome: 'Ana da Silva' }, em: new Date().toISOString(), ajustes: [{ por: { id: semApelido.id, nome: 'Roberto Carlos Pereira' }, em: new Date().toISOString() }], sorteio_numero: 1, sorteios: 1 },
  };
  const jogo = app.tabelas.games.find((g) => g.id === m.ids.jogoPassadoA);
  Object.assign(jogo, { times_resultado: snap, resultado_nivel: 3, time_vencedor: 'A', placar_a: 2, placar_b: 0 });
  app.tabelas.gols_jogadores = [
    { game_id: jogo.id, user_id: m.p.admA.id, time: 'A', gols: 2 },
    { game_id: jogo.id, user_id: semApelido.id, time: 'A', gols: 0 },
  ];
  return { jogo, semApelido };
}

test('GET /api/p/:gameId: os times, as reservas, o registro e os gols saem com o APELIDO — "da Silva" e "Pereira" nunca aparecem', async () => {
  const m = criarMundo(app);
  const { jogo, semApelido } = sorteioAntigoComGols(m);
  const r = await app.pedir('GET', `/api/p/${jogo.id}`);
  assert.equal(r.status, 200, r.texto);
  const nomes = r.json.times_resultado.times.map((t) => t.jogadores.map((j) => j.nome));
  assert.deepEqual(nomes, [['Ana', 'Zeca Convidado'], ['Alice']], 'quem tem apelido sai com ele; o convidado sem app mantém o que o admin digitou');
  assert.equal(r.json.times_resultado.reservas[0].nome, 'Roberto', 'sem apelido: só o primeiro nome');
  assert.deepEqual(r.json.times_resultado.registro.por, { nome: 'Ana' });
  assert.deepEqual(r.json.times_resultado.registro.ajustes[0].por, { nome: 'Roberto' });
  assert.deepEqual(r.json.resultado.gols.map((g) => g.nome).sort(), ['Ana', 'Roberto'], 'quem fez gol: o apelido');
  assert.doesNotMatch(r.texto, /da Silva|Carlos Pereira/, 'nome completo vazou na página pública');
  assert.ok(!r.texto.includes(semApelido.email), 'e-mail nunca');
});

test('GET /api/p/:gameId: quando a pessoa troca o apelido, a página pública mostra o de agora, não o do sorteio', async () => {
  const m = criarMundo(app);
  const { jogo } = sorteioAntigoComGols(m);
  app.tabelas.users.find((u) => u.id === m.p.memA.id).nome_jogador = 'Lili';
  const r = await app.pedir('GET', `/api/p/${jogo.id}`);
  assert.equal(r.json.times_resultado.times[1].jogadores[0].nome, 'Lili');
});

test('a tela do jogo (logado) leva o mesmo nome público no resultado que vira cartão 9:16 — e o resto do app não muda', async () => {
  const m = criarMundo(app);
  const { jogo, semApelido } = sorteioAntigoComGols(m);
  app.tabelas.team_members.push({ id: uuid('f8', m.n), team_id: m.A.id, user_id: semApelido.id, role: 'member', ativo: true, pode_postar: false });
  app.tabelas.game_players.push({ game_id: jogo.id, user_id: semApelido.id, confirmado: true, goleiro: false });
  const r = await app.pedir('GET', `/api/games/${jogo.id}`, { token: m.tok.admA });
  assert.equal(r.status, 200, r.texto);
  const tr = r.json.game.times_resultado;
  assert.deepEqual(tr.times.map((t) => t.jogadores.map((j) => j.nome)), [['Ana', 'Zeca Convidado'], ['Alice']]);
  assert.equal(tr.reservas[0].nome, 'Roberto', 'a reserva sem apelido: o primeiro nome');
  // O cartão 9:16 desenha times e reservas; o registro ("sorteado por…") é só da tela e não vai para a imagem.
  assert.ok(!JSON.stringify({ times: tr.times, reservas: tr.reservas }).includes('da Silva'), 'o cartão sai do app para o WhatsApp: sem nome completo');
});

test('um sorteio NOVO já grava o apelido (ou o primeiro nome) no resultado, nunca o nome completo', async () => {
  const m = criarMundo(app);
  const jogo = m.ids.jogoAbertoA;
  app.tabelas.games.find((g) => g.id === jogo).jogadores_por_time = 2; // 4 confirmados = 2 times de 2
  const semApelido = usuario(uuid('a5', m.n), 'Marcos', { nome: 'Marcos Antônio Lima', nome_jogador: null });
  app.tabelas.users.push({ ...semApelido });
  app.tabelas.team_members.push({ id: uuid('f9', m.n), team_id: m.A.id, user_id: semApelido.id, role: 'member', ativo: true, pode_postar: false });
  app.tabelas.game_players.push(
    { game_id: jogo, user_id: m.p.admA.id, confirmado: true, goleiro: false },
    { game_id: jogo, user_id: m.p.memA.id, confirmado: true, goleiro: false },
    { game_id: jogo, user_id: m.p.memA2.id, confirmado: true, goleiro: false },
    { game_id: jogo, user_id: semApelido.id, confirmado: true, goleiro: false },
  );
  const r = await app.pedir('POST', `/api/games/${jogo}/sortear`, { token: m.tok.admA, corpo: { num_times: 2 } });
  assert.equal(r.status, 200, r.texto);
  const gravado = app.tabelas.games.find((g) => g.id === jogo).times_resultado;
  const todos = [...gravado.times.flatMap((t) => t.jogadores), ...(gravado.reservas || [])].map((j) => j.nome).sort();
  assert.deepEqual(todos, ['Alice', 'Amanda', 'Ana', 'Marcos'], JSON.stringify(todos));
  assert.ok(!JSON.stringify(gravado).includes('da Silva'));
  assert.ok(!JSON.stringify(gravado).includes('Antônio Lima'));
});

// ─── a página pública do campeonato ───────────────────────────────────────────
test('GET /api/p/campeonato/:slug/:id: o plantel (e o do campeão) leva o apelido; convidado sem app fica como o admin digitou', async () => {
  const m = criarMundo(app);
  const semApelido = usuario(uuid('a6', m.n), 'Renato', { nome: 'Renato Augusto Souza', nome_jogador: null });
  app.tabelas.users.push({ ...semApelido });
  app.tabelas.team_members.push({ id: uuid('f7', m.n), team_id: m.A.id, user_id: semApelido.id, role: 'member', ativo: true, pode_postar: false });
  const plantel = [
    [{ user_id: m.p.admA.id, nome: 'Ana da Silva', avatar_url: null, convidado: false }, { user_id: null, nome: 'Zeca Convidado', avatar_url: null, convidado: true }],
    [{ user_id: m.p.memA.id, nome: 'Alice da Silva', avatar_url: null, convidado: false }, { user_id: semApelido.id, nome: 'Renato Augusto Souza', avatar_url: null, convidado: false }],
  ];
  const criar = await app.pedir('POST', `/api/equipas/${m.A.slug}/campeonatos`, { token: m.tok.admA, corpo: { nome: 'Copa Teste', formato: 'pontos', usar_sorteio: false, nomes: ['Time Um', 'Time Dois'], plantel } });
  assert.equal(criar.status, 201, criar.texto);
  const id = criar.json.campeonato.id;
  const privado = await app.pedir('GET', `/api/equipas/${m.A.slug}/campeonatos/${id}`, { token: m.tok.admA });
  assert.equal(privado.status, 200, privado.texto);
  const publico = await app.pedir('GET', `/api/p/campeonato/${m.A.slug}/${id}`);
  assert.equal(publico.status, 200, publico.texto);
  const nomes = publico.json.campeonato.times.map((t) => t.jogadores.map((j) => j.nome));
  assert.deepEqual(nomes, [['Ana', 'Zeca Convidado'], ['Alice', 'Renato']]);
  assert.doesNotMatch(publico.texto, /da Silva|Augusto Souza/, 'nome completo vazou na página pública do campeonato');
});

// ─── o convite público ────────────────────────────────────────────────────────
test('GET /api/convite/:token: quem convida aparece pelo apelido; sem apelido, o primeiro nome', async () => {
  const m = criarMundo(app);
  const comApelido = await app.pedir('GET', `/api/convite/${m.tokenDoConviteA}`);
  assert.equal(comApelido.status, 200, comApelido.texto);
  assert.equal(comApelido.json.convidadoPor, 'Ana');
  assert.doesNotMatch(comApelido.texto, /da Silva/);
  app.tabelas.users.find((u) => u.id === m.p.admA.id).nome_jogador = null;
  const semApelido = await app.pedir('GET', `/api/convite/${m.tokenDoConviteA}`);
  assert.equal(semApelido.json.convidadoPor, 'Ana', 'sem apelido: o primeiro nome ("Ana da Silva" → "Ana")');
  assert.doesNotMatch(semApelido.texto, /da Silva/);
});
