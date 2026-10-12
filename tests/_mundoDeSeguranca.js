// Futty v2.0 — o "mundo" dos testes de segurança: dois times, cinco pessoas e o que as rotas precisam encontrar (jogos, posts, comentários,
// convites, pedidos de entrada). Sobre a bancada de tests/_appFalsa.js; cada chamada a `criarMundo` troca os dados e usa ids novos
// (os caches do motor — sessão, Início — guardam por time e por pessoa).
//
//   admA  · admin do time A         memA  · membro comum do time A (autor do post e do comentário do A)
//   memA2 · outro membro comum do A admB  · admin do time B
//   memB  · membro comum do time B  fora  · conta sem time nenhum
//   lixo  · conta descartável (para as rotas que acabam com a conta ou com o vínculo)
const { usuario } = require('./_appFalsa');

const HORA = 3600 * 1000;
const iso = (deslocamentoMs) => new Date(Date.now() + deslocamentoMs).toISOString();
const uuid = (prefixo, n) => `${prefixo}${String(n).padStart(8 - prefixo.length, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`; // 8 hex certos, como um uuid v4

/** Um sorteio de 3 times (um jogador por time) — o suficiente para os três formatos de campeonato. */
const sorteioDe = (donos) => ({
  seed: 1, num_times: donos.length, reservas: [],
  times: donos.map((u, i) => ({ nome: `Time ${i + 1}`, jogadores: [{ user_id: u.id, nome: u.nome_jogador, avatar_url: null, rating: 3 }] })),
});

let rodada = 0;

/**
 * @param {ReturnType<typeof import('./_appFalsa').subirApp> extends Promise<infer T> ? T : never} app
 * @param {{ postadorEmA?: boolean }} [opcoes]
 */
function criarMundo(app, opcoes = {}) {
  rodada += 1;
  const n = rodada;
  const p = {
    admA: usuario(uuid('a1', n), 'Ana'), memA: usuario(uuid('a2', n), 'Alice'), memA2: usuario(uuid('a3', n), 'Amanda'),
    admB: usuario(uuid('b1', n), 'Bruno'), memB: usuario(uuid('b2', n), 'Beto'), fora: usuario(uuid('f1', n), 'Fernando'),
    lixo: usuario(uuid('d1', n), 'Descartavel'),
  };
  const A = { id: uuid('11', n), slug: `domingueira-${n}`, nome: 'Domingueira FC' };
  const B = { id: uuid('22', n), slug: `rivais-${n}`, nome: 'Rivais FC' };
  const ids = {
    jogoPassadoA: uuid('a9', n), jogoFuturoA: uuid('a8', n), jogoAbertoA: uuid('a7', n), jogoPassadoB: uuid('b9', n), jogoAbertoB: uuid('b7', n),
    postA: uuid('c1', n), postB: uuid('c2', n), comA: uuid('d2', n), comB: uuid('d3', n),
    conviteA: uuid('e1', n), conviteB: uuid('e2', n), pedidoA: uuid('e3', n), pedidoB: uuid('e4', n), denA: uuid('e5', n),
  };
  const tokenDoConviteA = `conv-a-${n}`;
  const tokenDoConviteB = `conv-b-${n}`;
  const sorteioA = sorteioDe([p.admA, p.memA, p.memA2]);
  const sorteioB = sorteioDe([p.admB, p.memB, p.fora]);
  const jogo = (id, time, extra) => ({ id, team_id: time.id, local: `Quadra ${time.nome}`, status: 'agendado', cancelado: false, ...extra });
  const tabelas = {
    teams: [
      { id: A.id, nome: A.nome, slug: A.slug, cor: 'verde', criado_por: p.admA.id, modo_visibilidade: 'privado', publica: false },
      { id: B.id, nome: B.nome, slug: B.slug, cor: 'roxo', criado_por: p.admB.id, modo_visibilidade: 'privado', publica: false },
    ],
    team_members: [
      { id: uuid('f2', n), team_id: A.id, user_id: p.admA.id, role: 'admin', ativo: true, pode_postar: true },
      { id: uuid('f3', n), team_id: A.id, user_id: p.memA.id, role: 'member', ativo: true, pode_postar: !!opcoes.postadorEmA },
      { id: uuid('f4', n), team_id: A.id, user_id: p.memA2.id, role: 'member', ativo: true, pode_postar: false },
      { id: uuid('f5', n), team_id: B.id, user_id: p.admB.id, role: 'admin', ativo: true, pode_postar: true },
      { id: uuid('f6', n), team_id: B.id, user_id: p.memB.id, role: 'member', ativo: true, pode_postar: false },
    ],
    games: [
      jogo(ids.jogoPassadoA, A, { data: iso(-3 * HORA), sorteio_realizado: true, times_resultado: sorteioA, num_times: 3, jogadores_por_time: 1 }),
      jogo(ids.jogoFuturoA, A, { data: iso(72 * HORA), sorteio_realizado: true, times_resultado: sorteioA, num_times: 3, jogadores_por_time: 1 }),
      jogo(ids.jogoAbertoA, A, { data: iso(96 * HORA), sorteio_realizado: false, times_resultado: null, jogadores_por_time: 5 }),
      jogo(ids.jogoPassadoB, B, { data: iso(-3 * HORA), sorteio_realizado: true, times_resultado: sorteioB, num_times: 3, jogadores_por_time: 1 }),
      jogo(ids.jogoAbertoB, B, { data: iso(96 * HORA), sorteio_realizado: false, times_resultado: null, jogadores_por_time: 5 }),
    ],
    game_players: [
      { game_id: ids.jogoPassadoA, user_id: p.admA.id, confirmado: true, goleiro: false },
      { game_id: ids.jogoPassadoA, user_id: p.memA.id, confirmado: true, goleiro: false },
      { game_id: ids.jogoPassadoA, user_id: p.memA2.id, confirmado: true, goleiro: false },
      { game_id: ids.jogoPassadoB, user_id: p.admB.id, confirmado: true, goleiro: false },
      { game_id: ids.jogoPassadoB, user_id: p.memB.id, confirmado: true, goleiro: false },
    ],
    feed_posts: [
      { id: ids.postA, team_id: A.id, author_id: p.memA.id, body: 'Post da Alice', tipo: 'post', created_at: iso(-HORA) },
      { id: ids.postB, team_id: B.id, author_id: p.memB.id, body: 'Post do Beto', tipo: 'post', created_at: iso(-HORA) },
    ],
    comentarios: [
      { id: ids.comA, parent_type: 'post', parent_id: ids.postA, author_id: p.memA.id, body: 'Oi, time A', created_at: iso(-HORA), deleted_at: null },
      { id: ids.comB, parent_type: 'post', parent_id: ids.postB, author_id: p.memB.id, body: 'Oi, time B', created_at: iso(-HORA), deleted_at: null },
    ],
    convites: [
      { id: ids.conviteA, team_id: A.id, token: tokenDoConviteA, criado_por: p.admA.id, expires_at: iso(24 * HORA), created_at: iso(-HORA) },
      { id: ids.conviteB, team_id: B.id, token: tokenDoConviteB, criado_por: p.admB.id, expires_at: iso(24 * HORA), created_at: iso(-HORA) },
    ],
    denuncias: [
      { id: ids.denA, target_type: 'post', target_id: ids.postA, reporter_id: p.memA.id, motivo: 'spam', resolvida: false, created_at: iso(-HORA) },
    ],
    team_join_requests: [
      { id: ids.pedidoA, team_id: A.id, user_id: p.fora.id, status: 'pending', created_at: iso(-HORA) },
      { id: ids.pedidoB, team_id: B.id, user_id: p.lixo.id, status: 'pending', created_at: iso(-HORA) },
    ],
  };
  app.reiniciar({ tabelas, usuarios: Object.values(p) });
  app.criarBucketsDoProjeto();
  const tok = Object.fromEntries(Object.entries(p).map(([k, u]) => [k, app.token(u.id)]));
  return { n, p, A, B, ids, tok, tokenDoConviteA, tokenDoConviteB, sorteioA, sorteioB };
}

/** O estado inteiro do mundo (tabelas + todos os arquivos de todos os buckets): "o que foi negado não gravou nada". */
// (uma tabela vazia vale o mesmo que uma tabela que nunca existiu: o banco de mentira cria a chave só de ler.)
const fotografiaDe = (app) => JSON.stringify({ t: Object.fromEntries(Object.entries(app.tabelas).filter(([, linhas]) => linhas.length)), s: [...app.storage.buckets].map(([nome, b]) => [nome, b.public, [...b.arquivos].map(([c, a]) => [c, a.corpo.toString('base64')]).sort()]) });

module.exports = { criarMundo, fotografiaDe, HORA, iso, uuid, sorteioDe };
