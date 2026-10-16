// Futty v2.0 — Rodada 31T: PRESENÇA DE FUNDADOR e o jogo antigo que só tem a foto do campeão.
//
// (1) O time guarda uma data de corte (teams.presenca_fundador_ate): todo membro que joga — inclusive quem entrou ontem ou entra daqui a um
// mês — conta como presente em todo jogo do time até esse dia (no relógio do time), inclusive. Conta no ranking, na vitrine, nas estatísticas
// do admin e no "N jogos" do Início, sem nascer linha nenhuma em game_players. Depois do corte, a presença é a de sempre.
// (2) O jogo antigo que só tem a foto do campeão entra na Resenha (cartão do jogo, sem autor) e não dá vitória a ninguém.
//
// O motor de verdade (tests/_appFalsa.js) sobre banco falso.
// Uso: node --test tests/presenca-de-fundador.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { subirApp, usuario } = require('./_appFalsa');
const { uuid } = require('./_mundoDeSeguranca');

// O módulo do motor só pode ser carregado DEPOIS de o ambiente falso nascer (subirApp): sem isso ele lê o .env de verdade.
let app;
let corteDaLinha; let diaDoJogo; let jogosDeFundador; let comPresencaDeFundador; let presencasPorPessoa;
before(async () => {
  app = await subirApp();
  ({ corteDaLinha, diaDoJogo, jogosDeFundador, comPresencaDeFundador, presencasPorPessoa } = require('../utils/presencaDeFundador'));
});
after(() => app.fechar());

const HORA = 3600 * 1000;
const DIA = 24 * HORA;
const LISBOA = 'Europe/Lisbon';
const iso = (ms) => new Date(Date.now() + ms).toISOString();
let rodada = 0;

// ─── A regra pura ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('o dia do jogo é o do relógio do time: 23:30 em Lisboa ainda é o dia do corte, 00:30 já é o seguinte', () => {
  // 18-out-2026 em Lisboa é horário de verão (UTC+1).
  assert.equal(diaDoJogo('2026-10-18T22:30:00Z', LISBOA), '2026-10-18');
  assert.equal(diaDoJogo('2026-10-18T23:30:00Z', LISBOA), '2026-10-19');
  const corte = corteDaLinha({ presenca_fundador_ate: '2026-10-18', fuso: LISBOA });
  const agora = Date.parse('2026-11-30T12:00:00Z');
  const jogos = [
    { id: 'antes', data: '2026-06-04T20:00:00Z' },
    { id: 'ultimo-minuto', data: '2026-10-18T22:30:00Z' },
    { id: 'dia-seguinte', data: '2026-10-18T23:30:00Z' },
    { id: 'cancelado', data: '2026-07-02T20:00:00Z', cancelado: true },
    { id: 'status-cancelado', data: '2026-07-09T20:00:00Z', status: 'cancelado' },
    { id: 'sem-data', data: null },
  ];
  assert.deepEqual(jogosDeFundador(jogos, corte, agora), ['antes', 'ultimo-minuto']);
});

test('jogo do dia do corte que ainda não começou não conta (só depois do horário dele)', () => {
  const corte = corteDaLinha({ presenca_fundador_ate: '2026-10-18', fuso: LISBOA });
  const jogo = [{ id: 'domingo', data: '2026-10-18T09:00:00Z' }];
  assert.deepEqual(jogosDeFundador(jogo, corte, Date.parse('2026-10-18T08:59:00Z')), []);
  assert.deepEqual(jogosDeFundador(jogo, corte, Date.parse('2026-10-18T09:00:00Z')), ['domingo']);
});

test('sem data de corte (ou data inválida) não há regra; fuso inválido cai no padrão', () => {
  assert.equal(corteDaLinha({ presenca_fundador_ate: null }), null);
  assert.equal(corteDaLinha({ presenca_fundador_ate: 'amanhã' }), null);
  assert.equal(corteDaLinha(null), null);
  assert.deepEqual(corteDaLinha({ presenca_fundador_ate: '2026-10-18', fuso: 'Lua/Base' }), { ate: '2026-10-18', fuso: 'America/Sao_Paulo' });
  assert.deepEqual(jogosDeFundador([{ id: 'x', data: '2026-01-01T00:00:00Z' }], null), []);
});

test('somar a presença de fundador não duplica quem já confirmou, e conta jogos diferentes por pessoa', () => {
  const linhas = [
    { game_id: 'g1', user_id: 'ana', confirmado: true },
    { game_id: 'g9', user_id: 'ana', confirmado: true }, // depois do corte
    { game_id: 'g2', user_id: 'bia', confirmado: false }, // disse "não vou" num jogo de fundador
  ];
  const todas = comPresencaDeFundador(linhas, ['g1', 'g2'], ['ana', 'bia', 'caio']);
  assert.deepEqual(presencasPorPessoa(todas), { ana: 3, bia: 2, caio: 2 });
  assert.equal(todas.filter((l) => l.fundador).length, 5, 'ana em g2; bia em g1 e g2; caio em g1 e g2');
  assert.equal(linhas.length, 3, 'não altera o recebido');
  assert.equal(comPresencaDeFundador(linhas, [], ['ana']), linhas);
});

// ─── No motor: ranking, vitrine, estatísticas do admin, Início e Resenha ──────────────────────────────────────────────────────

/**
 * Um time de Lisboa com corte no dia de anteontem: 3 jogos até o corte (um deles cancelado), 2 depois. O Craque confirmou só o 1º jogo depois do
 * corte; o Zeca e o Novato nunca confirmaram nada (o Novato acabou de entrar); o dono só organiza. Um jogo antigo tem só a foto do campeão.
 */
function mundo({ corte = true } = {}) {
  rodada += 1;
  const n = 700 + rodada;
  const p = {
    dono: usuario(uuid('a1', n), 'Dono'), craque: usuario(uuid('a2', n), 'Craque'),
    zeca: usuario(uuid('a3', n), 'Zeca'), novato: usuario(uuid('a4', n), 'Novato'),
  };
  const dataDoCorte = diaDoJogo(iso(-2 * DIA), LISBOA);
  const T = { id: uuid('11', n), slug: `fundador-${n}`, nome: 'Missa FC' };
  const membro = (k, i, extra = {}) => ({ id: uuid(`f${i}`, n), team_id: T.id, user_id: p[k].id, role: 'member', ativo: true, pode_postar: false, categoria: 'linha', ...extra });
  const jogo = (i, msAteAgora, extra = {}) => ({ id: uuid(`9${i}`, n), team_id: T.id, local: 'Urban Soccer', status: 'agendado', cancelado: false, data: iso(msAteAgora), created_at: iso(msAteAgora), ...extra });
  const g = {
    foto: jogo(1, -30 * DIA, { campeao_foto_url: 'https://x.test/resenha/campeao-antigo.webp' }), // só a foto
    velho: jogo(2, -10 * DIA),
    cancelado: jogo(3, -5 * DIA, { cancelado: true, status: 'cancelado' }),
    depois: jogo(4, -1 * DIA + HORA), // depois do corte (ontem)
    futuro: jogo(5, 5 * DIA),
  };
  app.reiniciar({
    tabelas: {
      teams: [{ id: T.id, nome: T.nome, slug: T.slug, cor: 'verde', criado_por: p.dono.id, modo_visibilidade: 'privado', publica: false, fuso: LISBOA, presenca_fundador_ate: corte ? dataDoCorte : null }],
      team_members: [
        membro('dono', 1, { role: 'admin', joga: false, pode_postar: true }),
        membro('craque', 2), membro('zeca', 3), membro('novato', 4, { created_at: new Date().toISOString() }),
      ],
      games: Object.values(g),
      game_players: [{ game_id: g.depois.id, user_id: p.craque.id, confirmado: true }, { game_id: g.velho.id, user_id: p.craque.id, confirmado: true }],
      votes: [],
      feed_posts: [],
    },
    usuarios: Object.values(p),
  });
  return { p, T, g };
}

const pedir = async (m, quem, rota) => {
  const r = await app.pedir('GET', rota, { token: app.token(m.p[quem].id) });
  assert.equal(r.status, 200, `${rota}: ${r.texto}`);
  return r.json;
};
const presencaNoRanking = async (m) => Object.fromEntries((await pedir(m, 'zeca', `/api/teams/${m.T.slug}/ranking`)).ranking.map((x) => [x.nome_jogador, x.presenca]));

test('ranking: todo membro que joga ganha os jogos até o corte (sem o cancelado), quem acabou de entrar também; o confirmado não duplica', async () => {
  const m = mundo();
  // foto + velho = 2 jogos de fundador. Craque: os 2 (o "velho" ele também confirmou: não duplica) + o de ontem = 3.
  assert.deepEqual(await presencaNoRanking(m), { Craque: 3, Novato: 2, Zeca: 2 });
  assert.equal(app.tabelas.game_players.length, 2, 'nenhuma linha nova em game_players');
});

test('sem data de corte o ranking é o de sempre (só a presença confirmada)', async () => {
  const m = mundo({ corte: false });
  assert.deepEqual(await presencaNoRanking(m), { Craque: 2, Novato: 0, Zeca: 0 });
});

test('vitrine do jogador: "jogos" e o histórico contam os jogos de fundador, igual ao ranking', async () => {
  const m = mundo();
  const v = await pedir(m, 'zeca', `/api/teams/${m.T.slug}/jogador/${m.p.novato.id}`);
  assert.equal(v.conquistas.jogos_total, 2);
  assert.deepEqual(new Set(v.historico.map((h) => h.game_id)), new Set([m.g.foto.id, m.g.velho.id]));
  assert.equal(v.conquistas.vitorias_total, 0, 'a foto do campeão não dá vitória a ninguém');
});

test('estatísticas do admin e o "N jogos" do Início batem com o ranking; quem só organiza não ganha presença', async () => {
  const m = mundo();
  const { membros } = await pedir(m, 'dono', `/api/teams/${m.T.slug}/membros`);
  const porNome = Object.fromEntries(membros.map((x) => [x.nome_jogador, x]));
  assert.equal(porNome.Novato.presencas, 2);
  assert.equal(porNome.Craque.presencas, 3);
  assert.equal(porNome.Dono.presencas, 0);
  assert.equal(porNome.Novato.presencas_recentes.filter((x) => x.presente).length, 2, 'as últimas 5 também marcam presente');
  const eu = await pedir(m, 'novato', '/api/me');
  assert.equal(eu.stats.jogos, 2);
  const inicio = await pedir(m, 'novato', '/api/inicio');
  assert.equal(inicio.me.stats.jogos, 2, 'o Início (com os vínculos já lidos) diz o mesmo que o /api/me');
  const dono = await pedir(m, 'dono', '/api/me');
  assert.equal(dono.stats.jogos, 0);
});

test('Resenha: o jogo antigo que só tem a foto do campeão aparece como cartão do jogo, sem autor e sem campeão; o jogo sem nada não aparece', async () => {
  const m = mundo();
  const { items } = await pedir(m, 'zeca', `/api/feed?team_id=${m.T.id}`);
  const jogos = items.filter((i) => i.kind === 'jogo');
  assert.deepEqual(jogos.map((i) => i.id), [m.g.foto.id]);
  const [cartao] = jogos;
  assert.ok(cartao.campeao_foto_url, 'a foto vai no cartão');
  assert.equal(cartao.campeao_time_index ?? null, null);
  assert.equal(cartao.author_id, undefined, 'cartão de jogo não tem autor');
  const ranking = (await pedir(m, 'zeca', `/api/teams/${m.T.slug}/ranking`)).ranking;
  assert.ok(ranking.every((x) => x.vitorias === 0 && x.derrotas === 0 && x.empates === 0), 'ninguém ganhou nem perdeu por causa da foto');
});

test('sem a migração 083 (coluna ausente) a regra fica desligada e o ranking segue de pé', async () => {
  const m = mundo();
  for (const t of app.tabelas.teams) delete t.presenca_fundador_ate;
  assert.deepEqual(await presencaNoRanking(m), { Craque: 2, Novato: 0, Zeca: 0 });
});
