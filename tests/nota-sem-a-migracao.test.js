// Futty v2.0 — O motor novo num banco SEM a migração 086 (a coluna votes.nota10 não existe): tudo continua certo, só com a nota lida e
// gravada na coluna antiga (estrelas), convertida. A migração é rodada à mão e pode vir depois do publica do motor.
//
//   · o Ranking lê a coluna antiga × 2;
//   · o voto de 0 a 10 é gravado na coluna antiga ÷ 2 (7 → 3,5);
//   · o 0 não cabe lá (o CHECK antigo começa em 0,5): 503 com a frase da casa, nada de erro do banco na tela;
//   · rodada a migração, o motor passa a ler e gravar a coluna nova.
//
// Uso: node --test tests/nota-sem-a-migracao.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');

const TIME = '31111111-1111-1111-1111-111111111111';
const ADM = 'd1000000-0000-0000-0000-000000000001';
const ANA = 'd1000000-0000-0000-0000-000000000002';
const BETO = 'd1000000-0000-0000-0000-000000000003';
const CAIO = 'd1000000-0000-0000-0000-000000000004';
const NOVA = { 'x-futty-nota': '10' };

const usuario = (id, nome) => ({ id, nome, nome_jogador: nome, avatar_url: null, email: `${nome}@futtymock.com` });
const membro = (id, nome, role = 'member') => ({ team_id: TIME, user_id: id, role, ativo: true, categoria: 'linha', users: usuario(id, nome) });

// O banco sem a 086: ler ou gravar `nota10` dá "coluna não existe"; gravar nota abaixo de 0,5 dá o CHECK antigo.
const semA086 = (tabela, op, e) => {
  if (tabela !== 'votes') return null;
  if (/nota10/.test(e.cols || '')) return { code: '42703', message: 'column votes.nota10 does not exist' };
  if (op === 'upsert' && (e.linhas || []).some((l) => 'nota10' in l)) return { code: 'PGRST204', message: "Could not find the 'nota10' column of 'votes' in the schema cache" };
  if (op === 'upsert' && (e.linhas || []).some((l) => Number(l.nota) < 0.5)) return { code: '23514', message: 'new row for relation "votes" violates check constraint "votes_nota_check"' };
  return null;
};

function cenario(opcoes) {
  return carregar({
    teams: [{ id: TIME, nome: 'Velho FC', slug: 'velho-fc' }],
    users: [usuario(ADM, 'Chavo'), usuario(ANA, 'Ana'), usuario(BETO, 'Beto'), usuario(CAIO, 'Caio')],
    team_members: [membro(ADM, 'Chavo', 'admin'), membro(ANA, 'Ana'), membro(BETO, 'Beto'), membro(CAIO, 'Caio')],
    games: [],
    game_players: [],
    votes: [
      { id: 'v1', de_user_id: ADM, para_user_id: ANA, team_id: TIME, nota: 4 },
      { id: 'v2', de_user_id: BETO, para_user_id: ANA, team_id: TIME, nota: 4.5 },
      { id: 'v3', de_user_id: CAIO, para_user_id: ANA, team_id: TIME, nota: 3.5 },
    ],
  }, ['routes/ranking'], opcoes);
}

test('sem a migração: o Ranking lê as estrelas × 2 e o voto novo vai para a coluna antiga ÷ 2', async (t) => {
  const { carregados, tabelas } = cenario({ falhar: semA086 });
  const pedir = subir([carregados['routes/ranking']], t);
  const r = await pedir('GET', '/api/teams/velho-fc/ranking', null, BETO, NOVA);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const ana = r.json.ranking.find((x) => x.user_id === ANA);
  assert.equal(ana.nota, 8, '(8 + 9 + 7) / 3 = 8');
  assert.equal(ana.minha_nota, 9, 'o Beto deu 4,5 estrelas = 9');

  const v = await pedir('POST', '/api/teams/velho-fc/votar', { para_user_id: ANA, nota: 7 }, BETO, NOVA);
  assert.equal(v.status, 200, JSON.stringify(v.json));
  assert.equal(v.json.voto.nota, 7);
  const guardado = tabelas.votes.find((x) => x.de_user_id === BETO);
  assert.equal(guardado.nota, 3.5, '7 ÷ 2 na coluna antiga');
  assert.equal('nota10' in guardado, false);
});

test('sem a migração: o voto 0 não cabe na coluna antiga — 503 com a frase da casa, e o voto que havia continua', async (t) => {
  const { carregados, tabelas } = cenario({ falhar: semA086 });
  const pedir = subir([carregados['routes/ranking']], t);
  const r = await pedir('POST', '/api/teams/velho-fc/votar', { para_user_id: ANA, nota: 0 }, CAIO, NOVA);
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'A nota 0 ainda não pode ser salva. Tente de novo em alguns minutos.');
  assert.equal(tabelas.votes.find((x) => x.de_user_id === CAIO).nota, 3.5);
});

test('com a migração rodada, o motor lê e grava a coluna nova (e a antiga fica com o gatilho do banco)', async (t) => {
  const { carregados, tabelas } = cenario({});
  for (const v of tabelas.votes) v.nota10 = Math.round(v.nota * 2); // o que a 086 faz com os votos antigos
  const pedir = subir([carregados['routes/ranking']], t);
  const v = await pedir('POST', '/api/teams/velho-fc/votar', { para_user_id: ANA, nota: 0 }, CAIO, NOVA);
  assert.equal(v.status, 200, JSON.stringify(v.json));
  assert.equal(tabelas.votes.find((x) => x.de_user_id === CAIO).nota10, 0);
  const r = await pedir('GET', '/api/teams/velho-fc/ranking', null, BETO, NOVA);
  assert.equal(r.json.ranking.find((x) => x.user_id === ANA).nota, 5.7, '(8 + 9 + 0) / 3 = 5,67 → 5,7');
});
