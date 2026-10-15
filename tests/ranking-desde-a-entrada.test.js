// Futty v2.0 — Rodada 31Q: o Ranking leva todo membro que joga desde o dia em que ele entra no time (decisão do dono) — sem mínimo de jogos.
// Quem ainda não jogou entra com os números zerados, no fim da lista (entre eles, pelo nome), e já pode receber nota. Quem só organiza,
// quem o admin escondeu e quem está inativo continuam fora. O selo "RANKING 1º/2º/3º" é de quem chegou lá jogando.
//
// O motor de verdade (tests/_appFalsa.js) sobre banco falso.
// Uso: node --test tests/ranking-desde-a-entrada.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { subirApp, usuario } = require('./_appFalsa');
const { uuid } = require('./_mundoDeSeguranca');

let app;
before(async () => { app = await subirApp(); });
after(() => app.fechar());

const HORA = 3600 * 1000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
let rodada = 0;

/** Um time com: o dono que só organiza, o Craque (3 jogos), o Meia (1 jogo), dois recém-chegados sem jogo (Zeca e Abel), um escondido e um inativo. */
function mundo() {
  rodada += 1;
  const n = 900 + rodada;
  const p = {
    dono: usuario(uuid('a1', n), 'Dono'), craque: usuario(uuid('a2', n), 'Craque'), meia: usuario(uuid('a3', n), 'Meia'),
    zeca: usuario(uuid('a4', n), 'Zeca'), abel: usuario(uuid('a5', n), 'Abel'),
    oculto: usuario(uuid('a6', n), 'Oculto'), inativo: usuario(uuid('a7', n), 'Inativo'),
  };
  const T = { id: uuid('11', n), slug: `ranking-entrada-${n}`, nome: 'Entrada FC' };
  const membro = (k, i, extra = {}) => ({ id: uuid(`f${i}`, n), team_id: T.id, user_id: p[k].id, role: 'member', ativo: true, pode_postar: false, categoria: 'linha', ...extra });
  const jogos = [1, 2, 3].map((i) => ({ id: uuid(`9${i}`, n), team_id: T.id, local: 'Quadra', status: 'terminado', cancelado: false, data: iso(-i * 24 * HORA) }));
  const presencas = [
    ...jogos.map((g) => ({ game_id: g.id, user_id: p.craque.id, confirmado: true })),
    { game_id: jogos[0].id, user_id: p.meia.id, confirmado: true },
    { game_id: jogos[0].id, user_id: p.oculto.id, confirmado: true },
    { game_id: jogos[0].id, user_id: p.inativo.id, confirmado: true },
  ];
  app.reiniciar({
    tabelas: {
      teams: [{ id: T.id, nome: T.nome, slug: T.slug, cor: 'verde', criado_por: p.dono.id, modo_visibilidade: 'privado', publica: false }],
      team_members: [
        membro('dono', 1, { role: 'admin', joga: false, pode_postar: true }),
        membro('craque', 2), membro('meia', 3), membro('zeca', 4), membro('abel', 5),
        membro('oculto', 6, { visivel_ranking: false }), membro('inativo', 7, { ativo: false }),
      ],
      games: jogos,
      game_players: presencas,
      votes: [],
    },
    usuarios: Object.values(p),
  });
  return { p, T };
}

const ranking = async (m, quem) => {
  const r = await app.pedir('GET', `/api/teams/${m.T.slug}/ranking`, { token: app.token(m.p[quem].id) });
  assert.equal(r.status, 200, r.texto);
  return r.json.ranking;
};
const votar = (m, de, para, nota) => app.pedir('POST', `/api/teams/${m.T.slug}/votar`, { token: app.token(m.p[de].id), corpo: { para_user_id: m.p[para].id, nota } });

test('quem entrou e não jogou aparece no ranking, com os números zerados e no fim (entre eles, pelo nome); quem só organiza, escondido e inativo ficam fora', async () => {
  const m = mundo();
  const r = await ranking(m, 'zeca');
  assert.deepEqual(r.map((x) => x.nome_jogador), ['Craque', 'Meia', 'Abel', 'Zeca']);
  assert.deepEqual(r.map((x) => x.posicao), [1, 2, 3, 4]);
  for (const nome of ['Abel', 'Zeca']) {
    const x = r.find((y) => y.nome_jogador === nome);
    assert.equal(x.presenca, 0);
    assert.deepEqual([x.vitorias, x.empates, x.derrotas, x.gols, x.artilharia, x.destaques], [0, 0, 0, 0, 0, 0]);
    assert.ok(Number.isFinite(x.score), `score finito (sem divisão por zero): ${x.score}`);
    assert.equal(x.nota, null, 'sem votos, sem nota');
  }
  assert.equal(r.find((x) => x.nome_jogador === 'Zeca').sou_eu, true);
  for (const fora of ['Dono', 'Oculto', 'Inativo']) assert.ok(!r.some((x) => x.nome_jogador === fora), `${fora} não aparece`);
  // Todo mundo vê a mesma lista (o dono que só organiza também abre o Ranking).
  assert.deepEqual((await ranking(m, 'dono')).map((x) => x.nome_jogador), ['Craque', 'Meia', 'Abel', 'Zeca']);
});

test('time só com gente nova (ninguém jogou): todos aparecem, pelo nome', async () => {
  const m = mundo();
  app.tabelas.game_players.length = 0;
  const r = await ranking(m, 'dono');
  assert.deepEqual(r.map((x) => x.nome_jogador), ['Abel', 'Craque', 'Meia', 'Zeca']);
  assert.ok(r.every((x) => x.presenca === 0 && Number.isFinite(x.score) && x.score === 0));
});

test('o recém-chegado recebe nota de qualquer membro (até de quem só organiza) e dá nota a quem joga; a si mesmo, nunca', async () => {
  const m = mundo();
  for (const de of ['craque', 'meia', 'dono']) {
    const v = await votar(m, de, 'zeca', 5);
    assert.equal(v.status, 200, `${de} → Zeca: ${v.texto}`);
  }
  const v = await votar(m, 'zeca', 'craque', 4);
  assert.equal(v.status, 200, v.texto);
  assert.equal((await votar(m, 'zeca', 'zeca', 5)).status, 400, 'nota em si mesmo continua proibida');

  const r = await ranking(m, 'craque');
  const zeca = r.find((x) => x.nome_jogador === 'Zeca');
  assert.equal(zeca.total_votos, 3);
  assert.equal(zeca.nota, 10, 'com 3 votos (MIN_VOTOS) a nota aparece');
  assert.equal(zeca.minha_nota, 5, 'e o Craque vê a nota que deu');
  // A nota não põe quem não jogou à frente de quem jogou; entre os que não jogaram ela conta (Zeca, com nota, passa o Abel, sem).
  assert.deepEqual(r.map((x) => x.nome_jogador), ['Craque', 'Meia', 'Zeca', 'Abel']);
});

test('o perfil do recém-chegado abre para os companheiros (antes dava "Jogador não encontrado")', async () => {
  const m = mundo();
  const r = await app.pedir('GET', `/api/teams/${m.T.slug}/jogador/${m.p.zeca.id}`, { token: app.token(m.p.craque.id) });
  assert.equal(r.status, 200, r.texto);
});

test('selo RANKING: o 1º que jogou ganha; quem não jogou não ganha pódio mesmo caindo no 3º lugar', async () => {
  const m = mundo();
  const selos = async (quem) => {
    const s = await app.pedir('GET', '/api/me/selos', { token: app.token(m.p[quem].id) });
    assert.equal(s.status, 200, s.texto);
    return (s.json.selos || []).filter((x) => x.fonte === 'ranking');
  };
  assert.equal((await ranking(m, 'abel')).find((x) => x.nome_jogador === 'Abel').posicao, 3);
  assert.deepEqual(await selos('abel'), [], 'Abel está em 3º sem ter jogado: sem selo');
  assert.deepEqual((await selos('craque')).map((x) => x.tier), ['ouro']);
});
