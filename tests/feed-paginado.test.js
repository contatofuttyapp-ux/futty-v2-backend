// Futty v2.0 — RODADA 29B (bloco 2, B — "conta pesada"): a Resenha (GET /api/feed) em PÁGINAS.
//
// O feed mandava, de uma vez, até 60 jogos + 60 posts — cada um com comentários, reações e mídias (50 KB de JSON com 25 itens, e
// o app ainda baixava as imagens deles em segundo plano). Agora o app novo pede `?limite=20` e, para ver mais antigos,
// `?antes=<created_at do último>`. SEM banco e SEM rede (Supabase falso). O que isto prova:
//   1. a 1ª página traz os 20 mais recentes dos dois tipos JUNTOS, em ordem, e o cursor `proximo` da seguinte;
//   2. a seguinte começa exatamente onde a anterior parou — sem repetir e sem pular — até `proximo: null`;
//   3. só a página paga comentários, reações e mídias (o trabalho que pesava);
//   4. sem `limite` (os apps já publicados) a resposta é a de sempre, sem `proximo`;
//   5. o bloqueio entre jogadores segue valendo, e `limite` e `antes` malucos não quebram nada.
//
// Uso: npm test  (ou: node --test tests/feed-paginado.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');

const EU = '11111111-1111-1111-1111-111111111111';
const AUTOR = '22222222-2222-2222-2222-222222222222';
const CHATO = '33333333-3333-3333-3333-333333333333';
const TIME = '0000aaaa-0000-0000-0000-00000000000a';
const MIN = 60000;
const base = Date.parse('2026-09-30T12:00:00Z');
const quando = (minAtras) => new Date(base - minAtras * MIN).toISOString();

/** `posts` posts (um a cada 10 min) e `jogos` jogos com campeão (um a cada 25 min), do mais novo para o mais velho. */
function tabelas({ posts = 25, jogos = 10, extra = {} } = {}) {
  return {
    users: [{ id: EU, nome: 'Eu' }, { id: AUTOR, nome: 'Autor', nome_jogador: 'Autor' }, { id: CHATO, nome: 'Chato' }],
    team_members: [{ team_id: TIME, user_id: EU, role: 'member', teams: { id: TIME, nome: 'Várzea FC', slug: 'varzea-fc' } }],
    feed_posts: Array.from({ length: posts }, (_, i) => ({
      id: `post-${i}`, team_id: TIME, author_id: i === 3 ? CHATO : AUTOR, body: `Post ${i}`, tipo: 'post', created_at: quando(10 * i + 1),
    })),
    games: Array.from({ length: jogos }, (_, i) => ({
      id: `jogo-${i}`, team_id: TIME, data: quando(25 * i), local: 'Quadra', campeao_time_index: 0, times_resultado: null, created_at: quando(25 * i + 2),
    })),
    feed_post_media: Array.from({ length: posts }, (_, i) => ({ post_id: `post-${i}`, url: `https://x/${i}.webp`, media_type: 'image', position: 0 })),
    comentarios: [], reacoes: [], user_blocks: [],
    ...extra,
  };
}

function cenario(t, tabs) {
  const { carregados, cliente } = carregar(tabs, ['routes/feed']);
  const consultas = [];
  const from0 = cliente.from.bind(cliente);
  cliente.from = (tabela) => { consultas.push(tabela); return from0(tabela); };
  const pedir = subir([carregados['routes/feed']], t);
  return { pedir, consultas };
}

const chaves = (items) => items.map((i) => `${i.kind}:${i.id}`);

test('a 1ª página traz os 20 mais recentes de jogos e posts JUNTOS, em ordem, com o cursor da seguinte', async (t) => {
  const { pedir } = cenario(t, tabelas());
  const r = await pedir('GET', '/api/feed?limite=20', null, EU);
  assert.equal(r.status, 200);
  assert.equal(r.json.items.length, 20);
  const datas = r.json.items.map((i) => new Date(i.created_at).getTime());
  assert.deepEqual(datas, [...datas].sort((a, b) => b - a), 'mais recente primeiro');
  assert.ok(r.json.items.some((i) => i.kind === 'jogo') && r.json.items.some((i) => i.kind === 'post'), 'os dois tipos misturados');
  assert.equal(r.json.proximo, r.json.items[19].created_at, 'o cursor é o created_at do último da página');
  // O post bloqueado (post-3, do CHATO) só some se houver bloqueio: aqui ninguém bloqueou ninguém.
  assert.ok(chaves(r.json.items).includes('post:post-3'));
});

test('as páginas se encadeiam sem repetir e sem pular, até acabar (proximo: null)', async (t) => {
  const { pedir } = cenario(t, tabelas());
  const vistos = [];
  let cursor = null;
  let paginas = 0;
  do {
    const rota = `/api/feed?limite=20${cursor ? `&antes=${encodeURIComponent(cursor)}` : ''}`;
    const r = await pedir('GET', rota, null, EU);
    assert.equal(r.status, 200);
    vistos.push(...chaves(r.json.items));
    cursor = r.json.proximo;
    paginas += 1;
  } while (cursor && paginas < 10);
  assert.equal(paginas, 2, '25 posts + 10 jogos = 35 itens = 20 + 15');
  assert.equal(vistos.length, 35);
  assert.equal(new Set(vistos).size, 35, 'nenhum repetido');
  // E é exatamente a lista que o app antigo recebia de uma vez, na mesma ordem.
  const { pedir: pedirTudo } = cenario(t, tabelas());
  const tudo = await pedirTudo('GET', '/api/feed', null, EU);
  assert.deepEqual(vistos, chaves(tudo.json.items));
});

test('só a página paga comentários, reações e mídias (as consultas pesadas olham 20 itens, não 35)', async (t) => {
  const { pedir } = cenario(t, tabelas({
    extra: { reacoes: [{ target_type: 'post', target_id: 'post-0', user_id: AUTOR, emoji: '🔥' }, { target_type: 'post', target_id: 'post-24', user_id: AUTOR, emoji: '👏' }] },
  }));
  const r = await pedir('GET', '/api/feed?limite=20', null, EU);
  const postsDaPagina = r.json.items.filter((i) => i.kind === 'post');
  assert.ok(postsDaPagina.every((p) => p.media.length === 1), 'a mídia vem para os posts da página');
  const p0 = r.json.items.find((i) => i.id === 'post-0');
  assert.deepEqual(p0.contagem_reacoes, { '🔥': 1 });
  assert.equal(r.json.items.find((i) => i.id === 'post-24'), undefined, 'o post mais antigo (reação incluída) fica para outra página');
});

test('sem `limite` (os apps já publicados) a resposta é a de sempre: tudo de uma vez, sem `proximo`', async (t) => {
  const { pedir } = cenario(t, tabelas());
  const r = await pedir('GET', '/api/feed', null, EU);
  assert.equal(r.json.items.length, 35);
  assert.equal('proximo' in r.json, false);
});

test('uma página que cabe tudo não tem próxima; limite e cursor malucos não quebram', async (t) => {
  const { pedir } = cenario(t, tabelas({ posts: 4, jogos: 2 }));
  const cabe = await pedir('GET', '/api/feed?limite=20', null, EU);
  assert.equal(cabe.json.items.length, 6);
  assert.equal(cabe.json.proximo, null);
  const maluco = await pedir('GET', '/api/feed?limite=abc&antes=ontem-de-manha', null, EU);
  assert.equal(maluco.status, 200);
  assert.equal(maluco.json.items.length, 6, 'limite inválido vira a página padrão; cursor inválido é ignorado');
  const gigante = await pedir('GET', '/api/feed?limite=100000', null, EU);
  assert.equal(gigante.status, 200);
  const zero = await pedir('GET', '/api/feed?limite=0', null, EU);
  assert.equal(zero.status, 200, 'limite 0 vira a página padrão');
  assert.equal(zero.json.items.length, 6);
});

test('o bloqueio entre jogadores continua valendo na página (e não ocupa vaga dela)', async (t) => {
  const { pedir } = cenario(t, tabelas({ extra: { user_blocks: [{ blocker_id: EU, blocked_id: CHATO }] } }));
  const r = await pedir('GET', '/api/feed?limite=20', null, EU);
  assert.equal(r.status, 200);
  assert.equal(chaves(r.json.items).includes('post:post-3'), false, 'o post de quem eu bloqueei não aparece');
  assert.equal(r.json.items.length, 20, 'e a página continua cheia (a 21ª e a 22ª entram no lugar)');
});

test('sem time nenhum: lista vazia, sem erro', async (t) => {
  const { pedir } = cenario(t, tabelas({ extra: { team_members: [] } }));
  const r = await pedir('GET', '/api/feed?limite=20', null, EU);
  assert.deepEqual(r.json, { items: [] });
});
