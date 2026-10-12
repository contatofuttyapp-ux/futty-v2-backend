// Futty v2.0 — SEGURANÇA · quem pode o quê nas rotas das rodadas 30I–30M (campeonatos, "Quem ganhou o jogo?" com a trava de +5 min, o post
// do campeão na Resenha e o card do Início). O app de verdade (tests/_appFalsa.js) sobre banco, Storage e Auth de mentira — nada de
// banco real, nada de rede.
//
// Cinco pessoas, dois times:
//   admA  · admin do time A          memA  · membro comum do time A
//   admB  · admin do time B          memB  · membro comum do time B
//   fora  · conta sem time nenhum
// Regra provada: só o admin do PRÓPRIO time lança, cria, corrige ou apaga; o time A nunca lê nem escreve no B (IDOR) — com o slug de um
// e o id do outro, o id no corpo, ou o id com "../" no endereço — e o que é negado não grava nada.
//
// Uso: node --test tests/seguranca-rotas-novas.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { subirApp, usuario } = require('./_appFalsa');

let app;
before(async () => { app = await subirApp(); });
after(() => app.fechar());

const HORA = 3600 * 1000;
const iso = (deslocamentoMs) => new Date(Date.now() + deslocamentoMs).toISOString();
const uuid = (prefixo, n) => `${prefixo}${String(n).padStart(8 - prefixo.length, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`; // 8 hex certos, como um uuid v4

/** Um sorteio de 3 times (um jogador por time, ids de mentira) — o suficiente para os três formatos de campeonato. */
const sorteioDe = (donos) => ({
  seed: 1, num_times: 3, reservas: [],
  times: donos.map((u, i) => ({ nome: `Time ${i + 1}`, jogadores: [{ user_id: u.id, nome: u.nome_jogador, avatar_url: null, rating: 3 }] })),
});

let rodada = 0;
/** O mundo de um teste: ids novos a cada vez (os caches do motor — sessão, Início — guardam por time e por pessoa). */
function mundo() {
  rodada += 1;
  const n = rodada;
  const p = {
    admA: usuario(uuid('a1', n), 'Ana'), memA: usuario(uuid('a2', n), 'Alice'), memA2: usuario(uuid('a3', n), 'Amanda'),
    admB: usuario(uuid('b1', n), 'Bruno'), memB: usuario(uuid('b2', n), 'Beto'), fora: usuario(uuid('f1', n), 'Fernando'),
  };
  const A = { id: uuid('11', n), slug: `domingueira-${n}`, nome: 'Domingueira FC' };
  const B = { id: uuid('22', n), slug: `rivais-${n}`, nome: 'Rivais FC' };
  const sorteioA = sorteioDe([p.admA, p.memA, p.memA2]);
  const sorteioB = sorteioDe([p.admB, p.memB, p.fora]);
  const jogo = (id, time, extra) => ({ id, team_id: time.id, local: `Quadra ${time.nome}`, status: 'agendado', cancelado: false, sorteio_realizado: true, ...extra });
  const g = {
    A_passado: uuid('a9', n), A_futuro: uuid('a8', n), B_passado: uuid('b9', n),
  };
  const tabelas = {
    teams: [
      { id: A.id, nome: A.nome, slug: A.slug, cor: 'verde', criado_por: p.admA.id, modo_visibilidade: 'privado' },
      { id: B.id, nome: B.nome, slug: B.slug, cor: 'roxo', criado_por: p.admB.id, modo_visibilidade: 'privado' },
    ],
    team_members: [
      { team_id: A.id, user_id: p.admA.id, role: 'admin', ativo: true }, { team_id: A.id, user_id: p.memA.id, role: 'member', ativo: true }, { team_id: A.id, user_id: p.memA2.id, role: 'member', ativo: true },
      { team_id: B.id, user_id: p.admB.id, role: 'admin', ativo: true }, { team_id: B.id, user_id: p.memB.id, role: 'member', ativo: true },
    ],
    games: [
      jogo(g.A_passado, A, { data: iso(-3 * HORA), times_resultado: sorteioA, num_times: 3 }),
      jogo(g.A_futuro, A, { data: iso(72 * HORA), times_resultado: sorteioA, num_times: 3 }),
      jogo(g.B_passado, B, { data: iso(-3 * HORA), times_resultado: sorteioB, num_times: 3 }),
    ],
  };
  app.reiniciar({ tabelas, usuarios: Object.values(p) });
  app.criarBucketsDoProjeto();
  const tok = Object.fromEntries(Object.entries(p).map(([k, u]) => [k, app.token(u.id)]));
  return { p, A, B, g, tok };
}

const caminhosDoStorage = () => [...(app.storage.buckets.get('campeonatos')?.arquivos.keys() || [])].sort();
const fotografia = () => JSON.stringify({ t: app.tabelas, s: [...app.storage.buckets].map(([nome, b]) => [nome, b.public, [...b.arquivos.keys()].sort()]) });
const NOMES = ['Ouro', 'Roxo', 'Prata'];

/** Cria um campeonato "pontos" no time A como admA e devolve o documento. */
async function criarCampeonato(m, time = m.A, quem = 'admA', corpo = {}) {
  const r = await app.pedir('POST', `/api/equipas/${time.slug}/campeonatos`, { token: m.tok[quem], corpo: { nome: 'Copa da Domingueira', formato: 'pontos', nomes: NOMES, ...corpo } });
  assert.equal(r.status, 201, r.texto);
  return r.json.campeonato;
}

// ─── Criar: só o admin do próprio time ──────────────────────────────────────────────────────────────────────────────────────────

test('criar campeonato (à mão e pelo sorteio): só o admin do próprio time; quem é negado não grava nada', async () => {
  const m = mundo();
  const rotas = [
    ['POST', `/api/equipas/${m.A.slug}/campeonatos`, { nome: 'Copa', formato: 'pontos', nomes: NOMES }],
    ['POST', `/api/equipas/${m.A.slug}/campeonatos/de-sorteio`, { game_id: m.g.A_passado, formato: 'pontos' }],
  ];
  for (const [metodo, rota, corpo] of rotas) {
    const antes = fotografia();
    assert.equal((await app.pedir(metodo, rota, { corpo })).status, 401, `sem login · ${rota}`);
    for (const [quem, esperado] of [['fora', 403], ['memB', 403], ['admB', 403], ['memA', 403]]) {
      const r = await app.pedir(metodo, rota, { token: m.tok[quem], corpo });
      assert.equal(r.status, esperado, `${quem} · ${rota} · ${r.texto}`);
    }
    assert.equal(fotografia(), antes, `o que foi negado não gravou nada · ${rota}`);
    const certo = await app.pedir(metodo, rota, { token: m.tok.admA, corpo });
    assert.equal(certo.status, 201, `admA · ${rota} · ${certo.texto}`);
  }
  assert.equal(caminhosDoStorage().length, 2);
  assert.ok(caminhosDoStorage().every((c) => c.startsWith(`t/${m.A.id}/`)), 'os dois campeonatos moram na pasta do time A');
});

test('de-sorteio: o id do jogo no corpo é de outro time → 404, nada é criado (IDOR pelo corpo)', async () => {
  const m = mundo();
  const antes = fotografia();
  const r = await app.pedir('POST', `/api/equipas/${m.A.slug}/campeonatos/de-sorteio`, { token: m.tok.admA, corpo: { game_id: m.g.B_passado, formato: 'pontos' } });
  assert.equal(r.status, 404, r.texto);
  assert.equal(fotografia(), antes);
  // o admin do B também não consegue por cima do slug do A
  const b = await app.pedir('POST', `/api/equipas/${m.A.slug}/campeonatos/de-sorteio`, { token: m.tok.admB, corpo: { game_id: m.g.A_passado, formato: 'pontos' } });
  assert.equal(b.status, 403);
  assert.equal(fotografia(), antes);
});

test('jogos-sorteados: só o admin, e só os jogos do próprio time', async () => {
  const m = mundo();
  const rota = `/api/equipas/${m.A.slug}/campeonatos/jogos-sorteados`;
  assert.equal((await app.pedir('GET', rota)).status, 401);
  for (const quem of ['fora', 'memB', 'admB', 'memA']) assert.equal((await app.pedir('GET', rota, { token: m.tok[quem] })).status, 403, quem);
  const r = await app.pedir('GET', rota, { token: m.tok.admA });
  assert.equal(r.status, 200, r.texto);
  assert.deepEqual(r.json.jogos.map((j) => j.id).sort(), [m.g.A_passado, m.g.A_futuro].sort(), 'só os jogos sorteados do time A; o do B nunca aparece');
});

// ─── Ler: só quem é do time ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('ler campeonatos: a lista e o detalhe só para quem é do time; o outro time recebe 403/404', async () => {
  const m = mundo();
  const camp = await criarCampeonato(m);
  const lista = `/api/equipas/${m.A.slug}/campeonatos`;
  const detalhe = `${lista}/${camp.id}`;
  for (const rota of [lista, detalhe]) {
    assert.equal((await app.pedir('GET', rota)).status, 401, `sem login · ${rota}`);
    for (const quem of ['fora', 'memB', 'admB']) assert.equal((await app.pedir('GET', rota, { token: m.tok[quem] })).status, 403, `${quem} · ${rota}`);
    for (const quem of ['memA', 'admA']) assert.equal((await app.pedir('GET', rota, { token: m.tok[quem] })).status, 200, `${quem} · ${rota}`);
  }
  // o slug do B com o id do campeonato do A: 404 (o campeonato não existe na pasta do B)
  const cruzado = await app.pedir('GET', `/api/equipas/${m.B.slug}/campeonatos/${camp.id}`, { token: m.tok.admB });
  assert.equal(cruzado.status, 404);
  // e o id com "../" para sair da pasta do próprio time não chega ao documento do A
  const traversal = await app.pedir('GET', `/api/equipas/${m.B.slug}/campeonatos/${encodeURIComponent(`../${m.A.id}/${camp.id}`)}`, { token: m.tok.admB });
  assert.equal(traversal.status, 404, 'o id com ../ não sai da pasta do time');
  assert.ok(!traversal.texto.includes(camp.nome));
});

test('a página pública do campeonato: sem login, mas só com o slug E o id certos', async () => {
  const m = mundo();
  const camp = await criarCampeonato(m);
  assert.equal((await app.pedir('GET', `/api/p/campeonato/${m.A.slug}/${camp.id}`)).status, 200);
  assert.equal((await app.pedir('GET', `/api/p/campeonato/${m.B.slug}/${camp.id}`)).status, 404, 'o slug de outro time não abre o campeonato do A');
  assert.equal((await app.pedir('GET', `/api/p/campeonato/${m.A.slug}/${uuid('99', 1)}`)).status, 404);
  const traversal = await app.pedir('GET', `/api/p/campeonato/${m.B.slug}/${encodeURIComponent(`../${m.A.id}/${camp.id}`)}`);
  assert.equal(traversal.status, 404, 'nem com ../ no id');
});

// ─── Lançar placar, desempate, terminar, apagar ─────────────────────────────────────────────────────────────────────────────────

test('lançar placar / desempate / terminar / apagar: só o admin do próprio time, sem gravar nada para os outros', async () => {
  const m = mundo();
  const camp = await criarCampeonato(m);
  const base = `/api/equipas/${m.A.slug}/campeonatos/${camp.id}`;
  const confronto = camp.confrontos[0].id;
  const acoes = [
    ['POST', `${base}/confrontos/${confronto}/resultado`, { placar_a: 2, placar_b: 1 }],
    ['POST', `${base}/desempate`, { time_id: camp.times[0].id }],
    ['POST', `${base}/terminar`, {}],
    ['DELETE', base, undefined],
  ];
  for (const [metodo, rota, corpo] of acoes) {
    const antes = fotografia();
    assert.equal((await app.pedir(metodo, rota, { corpo })).status, 401, `sem login · ${metodo} ${rota}`);
    for (const quem of ['fora', 'memB', 'admB', 'memA']) {
      const r = await app.pedir(metodo, rota, { token: m.tok[quem], corpo });
      assert.equal(r.status, 403, `${quem} · ${metodo} ${rota} · ${r.texto}`);
    }
    assert.equal(fotografia(), antes, `negado não grava · ${metodo} ${rota}`);
  }
  // o admin do B, no PRÓPRIO slug, com o id do campeonato do A: não existe lá (404) e o do A segue intacto
  const antes = fotografia();
  for (const [metodo, rota, corpo] of [
    ['POST', `/api/equipas/${m.B.slug}/campeonatos/${camp.id}/confrontos/${confronto}/resultado`, { placar_a: 9, placar_b: 0 }],
    ['POST', `/api/equipas/${m.B.slug}/campeonatos/${camp.id}/terminar`, {}],
    ['POST', `/api/equipas/${m.B.slug}/campeonatos/${camp.id}/desempate`, { time_id: camp.times[0].id }],
    ['DELETE', `/api/equipas/${m.B.slug}/campeonatos/${camp.id}`, undefined],
    ['DELETE', `/api/equipas/${m.B.slug}/campeonatos/${encodeURIComponent(`../${m.A.id}/${camp.id}`)}`, undefined],
    ['POST', `/api/equipas/${m.B.slug}/campeonatos/${encodeURIComponent(`../${m.A.id}/${camp.id}`)}/terminar`, {}],
  ]) {
    const r = await app.pedir(metodo, rota, { token: m.tok.admB, corpo });
    // apagar é idempotente (apagar o que não existe na pasta do B responde ok); o que importa é que o documento do A siga de pé
    assert.ok((metodo === 'DELETE' ? [200, 403, 404] : [403, 404]).includes(r.status), `admB com o id do A · ${metodo} ${rota} · ${r.status} ${r.texto}`);
  }
  assert.equal(fotografia(), antes, 'o campeonato do A segue exatamente como estava');
  const saiuDaPasta = app.storage.operacoes.filter((o) => o.caminho.includes('..'));
  assert.deepEqual(saiuDaPasta, [], 'o motor nunca pede ao Storage um caminho com ../ (o id da URL não sai da pasta do time)');
  // o admin do A faz tudo: lança, termina, apaga
  const lancou = await app.pedir('POST', `${base}/confrontos/${confronto}/resultado`, { token: m.tok.admA, corpo: { placar_a: 2, placar_b: 1 } });
  assert.equal(lancou.status, 200, lancou.texto);
  const terminou = await app.pedir('POST', `${base}/terminar`, { token: m.tok.admA, corpo: {} });
  assert.equal(terminou.status, 200, terminou.texto);
  assert.equal(terminou.json.campeonato.estado, 'terminado');
  const apagou = await app.pedir('DELETE', base, { token: m.tok.admA });
  assert.equal(apagou.status, 200, apagou.texto);
  assert.deepEqual(caminhosDoStorage(), []);
});

// ─── "Quem ganhou o jogo?" e a trava de +5 minutos ─────────────────────────────────────────────────────────────────────────────

test('resultado do jogo: só o admin do time do jogo, e só 5 minutos depois do início (jogo histórico não tem trava)', async () => {
  const m = mundo();
  const rotas = [
    ['PATCH', (id) => `/api/games/${id}/resultado`, { campeao_time_index: 0 }],
    ['PATCH', (id) => `/api/feed/games/${id}/resultado`, { campeao_time_index: 0 }],
  ];
  for (const [metodo, rota, corpo] of rotas) {
    const doA = rota(m.g.A_passado);
    assert.equal((await app.pedir(metodo, doA, { corpo })).status, 401);
    const antes = fotografia();
    for (const quem of ['fora', 'memB', 'admB', 'memA']) {
      const r = await app.pedir(metodo, doA, { token: m.tok[quem], corpo });
      assert.equal(r.status, 403, `${quem} · ${doA} · ${r.texto}`);
    }
    // o admin do A com o id do jogo do B: não é membro de lá
    const cruzado = await app.pedir(metodo, rota(m.g.B_passado), { token: m.tok.admA, corpo });
    assert.equal(cruzado.status, 403, `admA no jogo do B · ${cruzado.texto}`);
    assert.equal(fotografia(), antes, 'negado não grava');
    // a trava: o jogo do A que ainda não começou
    const cedo = await app.pedir(metodo, rota(m.g.A_futuro), { token: m.tok.admA, corpo });
    assert.equal(cedo.status, 400, cedo.texto);
    assert.match(cedo.json.error, /abre 5 minutos depois do início/);
    assert.equal(app.tabelas.games.find((g) => g.id === m.g.A_futuro).campeao_time_index, undefined, 'nada gravado antes da hora');
  }
  const certo = await app.pedir('PATCH', `/api/games/${m.g.A_passado}/resultado`, { token: m.tok.admA, corpo: { campeao_time_index: 1 } });
  assert.equal(certo.status, 200, certo.texto);
  assert.equal(app.tabelas.games.find((g) => g.id === m.g.A_passado).campeao_time_index, 1);
});

test('resultado do jogo: um jogo que começou há 4 minutos ainda não abre; há 6 minutos abre', async () => {
  const m = mundo();
  const jogoA = app.tabelas.games.find((g) => g.id === m.g.A_passado);
  jogoA.data = iso(-4 * 60 * 1000);
  const cedo = await app.pedir('PATCH', `/api/games/${m.g.A_passado}/resultado`, { token: m.tok.admA, corpo: { campeao_time_index: 0 } });
  assert.equal(cedo.status, 400, cedo.texto);
  jogoA.data = iso(-6 * 60 * 1000);
  const tarde = await app.pedir('PATCH', `/api/games/${m.g.A_passado}/resultado`, { token: m.tok.admA, corpo: { campeao_time_index: 0 } });
  assert.equal(tarde.status, 200, tarde.texto);
});

// ─── O post do campeão na Resenha ──────────────────────────────────────────────────────────────────────────────────────────────

test('o post do campeão: só o time vê; só o autor ou o admin apaga; reagir e comentar só do time', async () => {
  const m = mundo();
  const camp = await criarCampeonato(m);
  const base = `/api/equipas/${m.A.slug}/campeonatos/${camp.id}`;
  const fim = await app.pedir('POST', `${base}/terminar`, { token: m.tok.admA, corpo: {} });
  assert.equal(fim.status, 200, fim.texto);
  const post = app.tabelas.feed_posts.find((p) => p.conteudo?.tipo === 'campeao_campeonato');
  assert.ok(post, 'o campeonato terminado criou o post do campeão');
  assert.equal(post.team_id, m.A.id);

  const viu = async (quem) => (await app.pedir('GET', '/api/feed', { token: m.tok[quem] })).json.items.map((i) => i.id);
  assert.ok((await viu('memA')).includes(post.id), 'o membro do time A vê');
  assert.ok((await viu('admA')).includes(post.id));
  assert.ok(!(await viu('memB')).includes(post.id), 'o outro time não vê');
  assert.ok(!(await viu('admB')).includes(post.id));
  assert.deepEqual(await viu('fora'), []);
  assert.equal((await app.pedir('GET', '/api/feed')).status, 401);
  const forcado = await app.pedir('GET', `/api/feed?team_id=${m.A.id}`, { token: m.tok.admB });
  assert.equal(forcado.status, 403, 'pedir o feed do time A com o team_id na mão');

  // reagir e comentar: só do time A
  const reacao = { target_type: 'post', target_id: post.id, emoji: '👍' };
  for (const quem of ['fora', 'memB', 'admB']) assert.equal((await app.pedir('POST', '/api/feed/reacoes', { token: m.tok[quem], corpo: reacao })).status, 403, `reagir · ${quem}`);
  assert.equal((await app.pedir('POST', '/api/feed/reacoes', { token: m.tok.memA, corpo: reacao })).status, 200);
  const coment = { parent_type: 'post', parent_id: post.id, body: 'Parabéns!' };
  for (const quem of ['fora', 'memB', 'admB']) assert.equal((await app.pedir('POST', '/api/feed/comentarios', { token: m.tok[quem], corpo: coment })).status, 403, `comentar · ${quem}`);
  assert.equal((await app.pedir('POST', '/api/feed/comentarios', { token: m.tok.memA, corpo: coment })).status, 201);
  for (const quem of ['fora', 'memB', 'admB']) assert.equal((await app.pedir('GET', `/api/feed/comentarios/post/${post.id}`, { token: m.tok[quem] })).status, 403, `ler comentários · ${quem}`);

  // apagar: quem não é autor nem admin do time, não
  for (const quem of ['fora', 'memB', 'admB', 'memA']) assert.equal((await app.pedir('DELETE', `/api/feed/posts/${post.id}`, { token: m.tok[quem] })).status, 403, `apagar · ${quem}`);
  assert.ok(app.tabelas.feed_posts.some((p) => p.id === post.id), 'o post continua lá');
  assert.equal((await app.pedir('DELETE', `/api/feed/posts/${post.id}`, { token: m.tok.admA })).status, 200);
  assert.ok(!app.tabelas.feed_posts.some((p) => p.id === post.id));
});

test('apagar o campeonato leva o post do campeão junto — e o admin de outro time não alcança nenhum dos dois', async () => {
  const m = mundo();
  const camp = await criarCampeonato(m);
  const base = `/api/equipas/${m.A.slug}/campeonatos/${camp.id}`;
  await app.pedir('POST', `${base}/terminar`, { token: m.tok.admA, corpo: {} });
  assert.equal(app.tabelas.feed_posts.length, 1);
  assert.equal((await app.pedir('DELETE', base, { token: m.tok.admB })).status, 403);
  assert.equal(app.tabelas.feed_posts.length, 1);
  assert.equal((await app.pedir('DELETE', base, { token: m.tok.admA })).status, 200);
  assert.equal(app.tabelas.feed_posts.length, 0, 'o post do campeão saiu junto');
});

// ─── O card do Início ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('o card do campeonato no Início: o time A vê o dele; o time B e quem não tem time nunca veem o do A', async () => {
  const m = mundo();
  const camp = await criarCampeonato(m);
  const inicio = async (quem) => (await app.pedir('GET', '/api/inicio', { token: m.tok[quem] }));
  assert.equal((await app.pedir('GET', '/api/inicio')).status, 401);
  for (const quem of ['memA', 'admA']) {
    const r = await inicio(quem);
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.campeonato_novo?.id, camp.id, `${quem} vê o card`);
    assert.equal(r.json.campeonato_novo.team_slug, m.A.slug);
  }
  for (const quem of ['memB', 'admB', 'fora']) {
    const r = await inicio(quem);
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.campeonato_novo, null, `${quem} não vê o campeonato do A`);
    assert.ok(!r.texto.includes(camp.id) && !r.texto.includes(camp.nome), `${quem}: nada do campeonato do A no payload`);
  }
  // o painel de quem administra ("Seu time") não vai para o membro comum
  assert.deepEqual((await inicio('memA')).json.seu_time, []);
  assert.ok(((await inicio('admA')).json.seu_time || []).length >= 1, 'o admin do A vê o painel do time');
  assert.ok(!(await inicio('admB')).texto.includes(m.A.slug), 'o painel do B não menciona o time A');
});

test('o card "Quem ganhou?" do Início só chega ao admin do time do jogo', async () => {
  const m = mundo();
  const adm = (await app.pedir('GET', '/api/inicio', { token: m.tok.admA })).json;
  const painelA = (adm.seu_time || []).find((t) => t.team_id === m.A.id);
  assert.ok(painelA, 'o painel do time A existe para o admin A');
  assert.equal(painelA.quem_ganhou?.game_id, m.g.A_passado, 'o jogo sorteado, sem resultado, com 5+ minutos');
  for (const quem of ['memA', 'memB', 'fora']) {
    const r = (await app.pedir('GET', '/api/inicio', { token: m.tok[quem] })).json;
    assert.deepEqual(r.seu_time, [], `${quem} não tem painel de admin`);
  }
  const doB = (await app.pedir('GET', '/api/inicio', { token: m.tok.admB })).json;
  assert.ok(!(doB.seu_time || []).some((t) => t.team_id === m.A.id), 'o admin do B nunca recebe o painel do A');
  assert.ok(!JSON.stringify(doB).includes(m.g.A_passado), 'nem o id do jogo do A');
});

// ─── Selos do campeonato ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('selos: os da própria conta; os de um jogador só para quem é do time', async () => {
  const m = mundo();
  assert.equal((await app.pedir('GET', '/api/me/selos')).status, 401);
  assert.equal((await app.pedir('GET', '/api/me/selos', { token: m.tok.fora })).status, 200);
  const rota = `/api/equipas/${m.A.slug}/jogador/${m.p.memA.id}/selos`;
  assert.equal((await app.pedir('GET', rota)).status, 401);
  for (const quem of ['fora', 'memB', 'admB']) assert.equal((await app.pedir('GET', rota, { token: m.tok[quem] })).status, 403, quem);
  assert.equal((await app.pedir('GET', rota, { token: m.tok.memA })).status, 200);
});

test('nada disto falou com a rede', () => {
  assert.deepEqual(app.tentativasDeRede, [], `saiu pedido para a rede: ${app.tentativasDeRede.join(', ')}`);
});
