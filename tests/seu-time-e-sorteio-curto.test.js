// Futty v2.0 — RODADA 29I, bloco 3: o card "Seu time" do Início (item 1), o link curto do sorteio (item 74) e o "Pedir para
// votar de novo" que zera as notas (Ajustes → AÇÕES DEFINITIVAS). Sem banco e sem rede. O que se prova:
//   · as pendências de um time (utils/pendenciasAdmin.js): pedidos, próximo jogo sem presença aberta (só nos próximos 7 dias),
//     último jogo sem resultado, denúncias — e "nenhuma" quando está tudo em dia;
//   · GET /api/inicio leva `seu_time` só para quem administra (um por time de admin), com as pendências certas;
//   · /s/<código>: o código nasce na primeira vez e é o MESMO depois; só membro cria; GET /api/s/<código> leva ao jogo; código
//     inexistente ou sem a migração 078 = 404 (e o link-curto devolve null: o app manda o link longo);
//   · pedir-revotacao com { zerar: true } apaga as notas do time (só as dele); sem `zerar`, só o pedido, como era.
//
// Uso: npm test  (ou: node --test tests/seu-time-e-sorteio-curto.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir, injetar } = require('./_rotas');
const { pendenciasDoTime } = require('../utils/pendenciasAdmin');

const T1 = '0000aaaa-0000-0000-0000-00000000000a';
const T2 = '0000bbbb-0000-0000-0000-00000000000b';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const ZECA = 'a0000000-0000-0000-0000-00000000000a';
const FORA = 'f0000000-0000-0000-0000-00000000000f';
const DIA = 86400000;
const AGORA = Date.parse('2026-10-03T15:00:00Z');
const em = (dias, base = Date.now()) => new Date(base + dias * DIA).toISOString();

test('pendências de um time: cada uma na sua linha, e total 0 quando está tudo em dia', () => {
  const jogos = [
    { id: 'passado-1', data: em(-10, AGORA), resultado_nivel: 2 },
    { id: 'passado-2', data: em(-3, AGORA), resultado_nivel: 0 },
    { id: 'cancelado', data: em(-1, AGORA), cancelado: true },
    { id: 'proximo', data: em(2, AGORA), rsvp_aberto: false },
  ];
  const p = pendenciasDoTime({ pedidos: 2, jogos, denuncias: 1 }, AGORA);
  assert.deepEqual(p, {
    pedidos: 2, denuncias: 1, total: 5,
    presenca: { game_id: 'proximo', data: em(2, AGORA) },
    resultado: { game_id: 'passado-2', data: em(-3, AGORA) },
  });
  const emDia = pendenciasDoTime({ jogos: [{ id: 'a', data: em(-3, AGORA), resultado_nivel: 1 }, { id: 'b', data: em(2, AGORA), rsvp_aberto: true }] }, AGORA);
  assert.equal(emDia.total, 0);
  assert.equal(pendenciasDoTime({}, AGORA).total, 0, 'time sem jogo nenhum: nada pendente');
});

test('presença: o jogo daqui a 3 semanas não é pendência; a presença já encerrada também não', () => {
  assert.equal(pendenciasDoTime({ jogos: [{ id: 'longe', data: em(21, AGORA) }] }, AGORA).presenca, null);
  assert.equal(pendenciasDoTime({ jogos: [{ id: 'x', data: em(1, AGORA), rsvp_fechado: true }] }, AGORA).presenca, null);
  assert.equal(pendenciasDoTime({ jogos: [{ id: 'x', data: em(1, AGORA), status: 'cancelado' }] }, AGORA).presenca, null);
});

function mundoInicio(t, tabelasExtra = {}) {
  const restaurar = [
    injetar('utils/gabineteStore', { ler: async () => ({ ads_ativo: false }) }),
    injetar('utils/denunciaStore', {
      aoGravar: () => {},
      listarEquipa: async (teamId) => (teamId === T1 ? [{ estado: 'fila' }, { estado: 'resolvida' }, { estado: 'escalada' }] : []),
    }),
  ];
  const VARZEA = { id: T1, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde', created_at: '2026-01-01T00:00:00Z' };
  const MISSA = { id: T2, nome: 'Missa de Quinta', slug: 'missa', cor: 'azul', created_at: '2026-02-01T00:00:00Z' };
  const { carregados } = carregar({
    users: [{ id: DONO, nome: 'Tonhão' }, { id: ZECA, nome: 'Zeca' }],
    teams: [VARZEA, MISSA],
    // Os vínculos já com o time embutido, como o PostgREST devolve (o mesmo jeito de tests/inicio-conta-pesada.test.js).
    team_members: [
      { team_id: T1, user_id: DONO, role: 'admin', created_at: '2026-01-01T00:00:00Z', teams: VARZEA },
      { team_id: T2, user_id: DONO, role: 'member', created_at: '2026-02-01T00:00:00Z', teams: MISSA },
      { team_id: T1, user_id: ZECA, role: 'member', created_at: '2026-01-02T00:00:00Z', teams: VARZEA },
    ],
    team_join_requests: [{ team_id: T1, user_id: FORA, status: 'pending' }],
    games: [
      { id: 'g-passado', team_id: T1, data: em(-2), status: 'agendado', resultado_nivel: 0 },
      { id: 'g-proximo', team_id: T1, data: em(3), status: 'agendado', rsvp_aberto: false },
    ],
    ...tabelasExtra,
  }, ['routes/inicio']);
  for (const r of restaurar.reverse()) r();
  return subir([carregados['routes/inicio']], t);
}

test('GET /api/inicio: `seu_time` só com os times em que a pessoa é admin, e as pendências deles', async (t) => {
  const pedir = mundoInicio(t);
  const dono = (await pedir('GET', '/api/inicio', null, DONO)).json;
  assert.equal(dono.seu_time.length, 1, 'na Missa ele é só membro');
  const [varzea] = dono.seu_time;
  assert.equal(varzea.slug, 'varzea-fc');
  assert.equal(varzea.pendencias.pedidos, 1);
  assert.equal(varzea.pendencias.denuncias, 2, 'fila + escalada; a resolvida não conta');
  assert.equal(varzea.pendencias.presenca?.game_id, 'g-proximo');
  assert.equal(varzea.pendencias.resultado?.game_id, 'g-passado');
  assert.equal(varzea.pendencias.total, 5);
  const zeca = (await pedir('GET', '/api/inicio', null, ZECA)).json;
  assert.deepEqual(zeca.seu_time, [], 'quem não administra não recebe o card');
});

function mundoSorteio(t, { falhar = null } = {}) {
  const { carregados, tabelas } = carregar({
    teams: [{ id: T1, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde' }],
    users: [{ id: DONO, nome: 'Tonhão' }],
    team_members: [{ team_id: T1, user_id: DONO, role: 'admin' }, { team_id: T1, user_id: ZECA, role: 'member' }],
    games: [{ id: 'g1', team_id: T1, data: em(-1), status: 'finished', sorteio_realizado: true }],
  }, ['routes/games'], { falhar, unicos: { sorteio_codigos: [['codigo'], ['game_id']] } });
  return { pedir: subir([carregados['routes/games']], t), tabelas };
}

test('link curto do sorteio: nasce na 1ª vez, é o mesmo depois, e /api/s/<código> leva ao jogo', async (t) => {
  const { pedir, tabelas } = mundoSorteio(t);
  const a = await pedir('POST', '/api/games/g1/link-curto', null, ZECA);
  assert.equal(a.status, 200);
  assert.match(a.json.codigo, /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
  const b = await pedir('POST', '/api/games/g1/link-curto', null, DONO);
  assert.equal(b.json.codigo, a.json.codigo, 'um código por jogo');
  assert.equal(tabelas.sorteio_codigos.length, 1);
  const s = await pedir('GET', `/api/s/${a.json.codigo.toUpperCase()}`);
  assert.equal(s.status, 200, 'sem login, e em qualquer caixa');
  assert.deepEqual(s.json, { slug: 'varzea-fc', gameId: 'g1' });
  assert.equal((await pedir('GET', '/api/s/zzzzzzzz')).status, 404);
  assert.equal((await pedir('GET', '/api/s/nao-e-codigo!')).status, 404);
  assert.equal((await pedir('POST', '/api/games/g1/link-curto', null, FORA)).status, 403, 'só quem é do time cria');
});

test('sem a migração 078: link-curto devolve null (o app manda o link longo) e /api/s/ = 404', async (t) => {
  const aviso = console.warn; console.warn = () => {}; t.after(() => { console.warn = aviso; });
  const semTabela = (tabela) => (tabela === 'sorteio_codigos' ? { code: '42P01', message: 'relation "public.sorteio_codigos" does not exist' } : null);
  const { pedir } = mundoSorteio(t, { falhar: semTabela });
  const r = await pedir('POST', '/api/games/g1/link-curto', null, DONO);
  assert.equal(r.status, 200);
  assert.equal(r.json.codigo, null);
  assert.equal((await pedir('GET', '/api/s/abcdefgh')).status, 404);
});

test('"Pedir para votar de novo" com zerar: apaga as notas do time (só as dele); sem zerar, só o pedido', async (t) => {
  const votos = [
    { de_user_id: DONO, para_user_id: ZECA, team_id: T1, nota: 8 },
    { de_user_id: ZECA, para_user_id: DONO, team_id: T1, nota: 7 },
    { de_user_id: DONO, para_user_id: ZECA, team_id: T2, nota: 9 },
  ];
  const { carregados, tabelas } = carregar({
    teams: [{ id: T1, nome: 'Várzea FC', slug: 'varzea-fc', cor: 'verde' }, { id: T2, nome: 'Missa', slug: 'missa', cor: 'azul' }],
    team_members: [{ team_id: T1, user_id: DONO, role: 'admin' }, { team_id: T1, user_id: ZECA, role: 'member' }],
    votes: votos,
  }, ['routes/ranking']);
  const pedir = subir([carregados['routes/ranking']], t);
  assert.equal((await pedir('POST', '/api/teams/varzea-fc/pedir-revotacao', {}, DONO)).status, 200);
  assert.equal(tabelas.votes.length, 3, 'sem zerar, as notas ficam');
  assert.equal((await pedir('POST', '/api/teams/varzea-fc/pedir-revotacao', { zerar: true }, ZECA)).status, 403);
  assert.equal((await pedir('POST', '/api/teams/varzea-fc/pedir-revotacao', { zerar: true }, DONO)).status, 200);
  assert.deepEqual(tabelas.votes.map((v) => v.team_id), [T2], 'as do Várzea saíram; as da Missa ficaram');
  assert.ok(tabelas.teams[0].revotar_pedido_em, 'e o pedido foi marcado');
});
