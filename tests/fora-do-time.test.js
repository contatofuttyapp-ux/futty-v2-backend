// Futty v2.0 — Quem não é do time e abre o jogo, o ranking ou o elenco dele: 403 com a frase verdadeira e o código FORA_DO_TIME.
//
// O motor sempre recusou certo (403), mas cada rota dizia de um jeito ("Não é membro…", "Você não é membro…") e sem código; o Ranking
// mostrava "Sem conexão. Verifique a internet" (prova da 31Y, conta demo na Missa de Quinta). Agora é uma frase só, com o código que a
// tela usa para escolher o aviso certo.
//
// Uso: npm test  (ou: node --test tests/fora-do-time.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { carregar, subir } = require('./_rotas');
const { MSG_FORA_DO_TIME, CODIGO_FORA_DO_TIME, foraDoTime } = require('../utils/http');

const TIME = '11111111-1111-1111-1111-111111111111';
const JOGO = '99999999-9999-9999-9999-999999999999';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const FORA = 'f0000000-0000-0000-0000-0000000000f1';

const usuario = (id, nome) => ({ id, nome: `${nome} da Silva`, nome_jogador: nome, avatar_url: null, email: `${nome}@futtymock.com` });

function cenario() {
  return carregar({
    teams: [{ id: TIME, nome: 'Missa de Quinta', slug: 'missa-de-quinta', cor: 'verde' }],
    users: [usuario(DONO, 'Organizador'), usuario(FORA, 'Demo')],
    team_members: [{ team_id: TIME, user_id: DONO, role: 'admin', users: usuario(DONO, 'Organizador') }],
    games: [{ id: JOGO, team_id: TIME, data: '2026-10-22T23:00:00.000Z', jogadores_por_time: 5, status: 'agendado' }],
    game_players: [],
  }, ['routes/games', 'routes/teams', 'routes/ranking']);
}

test('foraDoTime(): 403, a frase da casa e o código', () => {
  const e = foraDoTime();
  assert.equal(e.status, 403);
  assert.equal(e.message, 'Você não faz parte deste time.');
  assert.equal(e.code, 'FORA_DO_TIME');
  assert.equal(MSG_FORA_DO_TIME, e.message);
  assert.equal(CODIGO_FORA_DO_TIME, e.code);
});

test('jogo, lista de jogos, elenco e ranking de time alheio: 403 FORA_DO_TIME com a frase (nunca cara de falha de rede)', async (t) => {
  const { carregados } = cenario();
  const pedir = subir([carregados['routes/games'], carregados['routes/teams'], carregados['routes/ranking']], t);
  for (const rota of [`/api/games/${JOGO}`, '/api/teams/missa-de-quinta/games', '/api/teams/missa-de-quinta', '/api/teams/missa-de-quinta/ranking']) {
    const r = await pedir('GET', rota, null, FORA);
    assert.equal(r.status, 403, `${rota}: ${JSON.stringify(r.json)}`);
    assert.deepEqual(r.json, { error: MSG_FORA_DO_TIME, code: CODIGO_FORA_DO_TIME }, rota);
  }
  // quem é do time continua entrando
  assert.equal((await pedir('GET', `/api/games/${JOGO}`, null, DONO)).status, 200);
});

test('nenhuma rota recusa o não-membro com frase própria: todo 403 de "membro deste time" passa por foraDoTime()', () => {
  const pastas = ['routes', 'utils', 'middleware'].map((p) => path.join(__dirname, '..', p));
  const achados = [];
  for (const pasta of pastas) {
    for (const nome of fs.readdirSync(pasta).filter((n) => n.endsWith('.js'))) {
      const texto = fs.readFileSync(path.join(pasta, nome), 'utf8');
      texto.split(/\r?\n/).forEach((linha, i) => {
        if (/HttpError\(403,\s*'[^']*(membro deste time|parte deste time)/i.test(linha)) achados.push(`${nome}:${i + 1} ${linha.trim()}`);
      });
    }
  }
  assert.deepEqual(achados, []);
});
