// Futty v2.0 — RODADA 31A: "Associar jogador" — o convidado sem app de um jogo vira a conta de um membro do time.
//
// Quem jogou como convidado baixa o app depois do campeão e precisa virar campeão na hora (selo, "Você é campeão!"). O admin liga o nome do
// convidado ao membro e tudo o que tinha o nome passa a ter a conta: o sorteio do jogo (mesma posição), os gols, a presença e o elenco dos
// campeonatos que nasceram daquele sorteio. Idempotente, só admin, só membro do MESMO time, e dá para desfazer por 24 h.
//
// Uso: npm test  (ou: node --test tests/associar-jogador.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');

const TIME = '11111111-1111-1111-1111-111111111111';
const OUTRO_TIME = '22222222-2222-2222-2222-222222222222';
const JOGO = '99999999-9999-9999-9999-999999999999';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const A = 'a0000000-0000-0000-0000-00000000000a';
const B = 'b0000000-0000-0000-0000-00000000000b';
const BETO = 'e0000000-0000-0000-0000-0000000000e1'; // o convidado que acabou de entrar no time
const CAIO = 'e0000000-0000-0000-0000-0000000000e2'; // outro que entrou
const FORA = 'f0000000-0000-0000-0000-0000000000f1'; // de outro time
const PASSADO = '2026-01-01T20:00:00.000Z';

const usuario = (id, nome, apelido = nome) => ({ id, nome: `${nome} da Silva`, nome_jogador: apelido, email: `${nome}@futtymock.com`, avatar_url: `https://x.test/${apelido}.webp` });
const membro = (id, nome, role = 'member', time = TIME, apelido = nome) => ({ team_id: time, user_id: id, role, users: usuario(id, nome, apelido) });
const jMembro = (id, nome) => ({ user_id: id, nome, avatar_url: null, rating: 3 });
const jConvidado = (nome) => ({ user_id: null, convidado: true, nome, avatar_url: null, rating: 3 });

const sorteio = () => ({
  seed: 1,
  num_times: 2,
  times: [
    { nome: 'Time A', jogadores: [jMembro(A, 'Magrão'), jConvidado('Beto')] },
    { nome: 'Time B', jogadores: [jMembro(B, 'Zé'), jConvidado('Caio')] },
  ],
  reservas: [jConvidado('Reserva Zeca')],
});

// Um Storage em memória, no lugar do bucket "campeonatos".
function storageFalso() {
  const arquivos = new Map();
  return {
    from: () => ({
      upload: async (caminho, corpo) => { arquivos.set(caminho, Buffer.from(corpo).toString('utf8')); return { error: null }; },
      download: async (caminho) => (arquivos.has(caminho) ? { data: { text: async () => arquivos.get(caminho) }, error: null } : { data: null, error: { message: 'not found' } }),
      list: async (prefixo) => ({ data: [...arquivos.keys()].filter((k) => k.startsWith(`${prefixo}/`)).map((k) => ({ name: k.slice(prefixo.length + 1) })) }),
      remove: async (caminhos) => { caminhos.forEach((c) => arquivos.delete(c)); return { error: null }; },
    }),
  };
}

function cenario(extra = {}, opcoes = {}) {
  const t = carregar({
    teams: [{ id: TIME, nome: 'Várzea FC', slug: 'varzea-fc' }, { id: OUTRO_TIME, nome: 'Outro FC', slug: 'outro-fc' }],
    users: [usuario(DONO, 'Chavo'), usuario(A, 'Magrão'), usuario(B, 'Zé'), usuario(BETO, 'Roberto', 'Betão'), usuario(CAIO, 'Caio'), usuario(FORA, 'Fora')],
    team_members: [
      membro(DONO, 'Chavo', 'admin'), membro(A, 'Magrão'), membro(B, 'Zé'), membro(BETO, 'Roberto', 'member', TIME, 'Betão'), membro(CAIO, 'Caio'),
      membro(FORA, 'Fora', 'member', OUTRO_TIME),
    ],
    games: [{ id: JOGO, team_id: TIME, data: PASSADO, jogadores_por_time: 2, status: 'agendado', sorteio_realizado: true, times_resultado: sorteio(), ...(extra.jogo || {}) }],
    game_players: [
      { id: 'gp1', game_id: JOGO, user_id: A, confirmado: true }, { id: 'gp2', game_id: JOGO, user_id: B, confirmado: true },
      ...(extra.game_players || []),
    ],
    gols_jogadores: extra.gols || [],
    feed_posts: extra.feed_posts || [],
  }, ['routes/games', 'routes/campeonatos', 'utils/campeonatoStore', 'utils/agregados'], opcoes);
  t.cliente.storage = storageFalso();
  return t;
}

const rota = `/api/games/${JOGO}/associar-jogador`;
const jogadoresDe = (tr) => [...tr.times.flatMap((t) => t.jogadores), ...tr.reservas];
const linhaDoJogo = (tabelas) => tabelas.games.find((g) => g.id === JOGO);

// O jogo já tem resultado: Time A ganhou de 3 a 1, com gols de Magrão (1), do convidado Beto (2) e do convidado Caio (1).
const comResultado = () => cenario({
  jogo: { resultado_nivel: 3, campeao_time_index: 0, time_vencedor: 'A', placar_a: 3, placar_b: 1 },
  gols: [
    { id: 'g1', game_id: JOGO, user_id: A, convidado_nome: null, time: 'A', gols: 1 },
    { id: 'g2', game_id: JOGO, user_id: null, convidado_nome: 'Beto', time: 'A', gols: 2 },
    { id: 'g3', game_id: JOGO, user_id: null, convidado_nome: 'Caio', time: 'B', gols: 1 },
  ],
});

test('associar em jogo com gols: a vaga, os gols e a presença passam a ser do membro; ranking e vitória dele aparecem', async (t) => {
  const { carregados, tabelas } = comResultado();
  const pedir = subir([carregados['routes/games']], t);

  const r = await pedir('POST', rota, { convidado_nome: 'Beto', user_id: BETO }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ja_associado, false);
  assert.equal(r.json.gols, 1);

  // a vaga: mesmo time, mesma posição, agora com a conta (apelido) e sem a marca de convidado
  const tr = linhaDoJogo(tabelas).times_resultado;
  assert.deepEqual(tr.times[0].jogadores.map((j) => [j.user_id, j.nome, !!j.convidado]), [[A, 'Magrão', false], [BETO, 'Betão', false]]);
  assert.equal(tr.times[0].jogadores[1].avatar_url, 'https://x.test/Betão.webp');
  assert.deepEqual(tr.times[1].jogadores.map((j) => j.nome), ['Zé', 'Caio'], 'o outro convidado fica como estava');

  // os gols: a linha do Beto ganhou o user_id e perdeu o nome de convidado; as outras não mexeram
  const g2 = tabelas.gols_jogadores.find((g) => g.id === 'g2');
  assert.equal(g2.user_id, BETO);
  assert.equal(g2.convidado_nome, null);
  assert.equal(g2.gols, 2);
  assert.equal(tabelas.gols_jogadores.find((g) => g.id === 'g3').convidado_nome, 'Caio');
  assert.equal(tabelas.gols_jogadores.length, 3);

  // a presença: um registro confirmado, o mesmo que a lista de presença e o ranking usam
  const presencas = tabelas.game_players.filter((p) => p.user_id === BETO);
  assert.equal(presencas.length, 1);
  assert.equal(presencas[0].confirmado, true);

  // o registro diz quem fez e o que havia antes (para o Desfazer); o jogo NÃO ganha "ajuste" de times
  assert.equal(tr.registro.associacoes.length, 1);
  assert.equal(tr.registro.associacoes[0].convidado.nome, 'Beto');
  assert.equal(tr.registro.associacoes[0].presenca_antes, null);
  assert.equal((tr.registro.ajustes || []).length, 0);

  // o ranking recalcula do que já existe: gols e vitória do membro (o time A foi o campeão)
  const { agregadosDaEquipa } = carregados['utils/agregados'];
  const ag = await agregadosDaEquipa(TIME);
  assert.equal(ag.golsMap[BETO], 2);
  assert.equal(ag.vitoriasMap[BETO], 1);
  assert.equal(ag.derrotasMap[BETO], undefined);

  // a tela do jogo já mostra o membro nos times e no gol
  const jogo = await pedir('GET', `/api/games/${JOGO}`, null, DONO);
  assert.equal(jogo.status, 200, JSON.stringify(jogo.json));
  assert.equal(jogo.json.gols.find((g) => g.user_id === BETO).gols, 2);
  assert.equal(jogo.json.game.times_resultado.times[0].jogadores[1].user_id, BETO);
});

test('idempotente: repetir o mesmo pedido não muda nada, não duplica a presença e diz que já estava feito', async (t) => {
  const { carregados, tabelas } = comResultado();
  const pedir = subir([carregados['routes/games']], t);
  assert.equal((await pedir('POST', rota, { convidado_nome: 'Beto', user_id: BETO }, DONO)).status, 200);
  const depois1 = JSON.stringify(tabelas);

  const de_novo = await pedir('POST', rota, { convidado_nome: 'Beto', user_id: BETO }, DONO);
  assert.equal(de_novo.status, 200, JSON.stringify(de_novo.json));
  assert.equal(de_novo.json.ja_associado, true);
  assert.equal(JSON.stringify(tabelas), depois1, 'nenhuma linha mudou');
  assert.equal(tabelas.game_players.filter((p) => p.user_id === BETO).length, 1);
});

test('um pedido que caiu no meio termina o serviço na repetição (os gols e a presença já tinham mudado, o sorteio não)', async (t) => {
  const { carregados, tabelas } = comResultado();
  // simula a queda: os gols já foram para a conta e a presença também, mas o jogo ainda guarda o convidado
  const g2 = tabelas.gols_jogadores.find((g) => g.id === 'g2');
  g2.user_id = BETO;
  g2.convidado_nome = null;
  tabelas.game_players.push({ id: 'gpb', game_id: JOGO, user_id: BETO, confirmado: true });
  const pedir = subir([carregados['routes/games']], t);

  const r = await pedir('POST', rota, { convidado_nome: 'Beto', user_id: BETO }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ja_associado, false);
  assert.equal(linhaDoJogo(tabelas).times_resultado.times[0].jogadores[1].user_id, BETO);
  assert.equal(tabelas.game_players.filter((p) => p.user_id === BETO).length, 1);
  assert.equal(tabelas.gols_jogadores.length, 3);
});

test('o membro que já tem a própria linha de gols neste jogo não recebe a do convidado (a conta só tem uma por jogo)', async (t) => {
  const { carregados, tabelas } = comResultado();
  tabelas.gols_jogadores.push({ id: 'g9', game_id: JOGO, user_id: BETO, convidado_nome: null, time: 'B', gols: 1 });
  const pedir = subir([carregados['routes/games']], t);
  const antes = JSON.stringify(tabelas);
  const r = await pedir('POST', rota, { convidado_nome: 'Beto', user_id: BETO }, DONO);
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.match(r.json.error, /já tem gols/);
  assert.equal(JSON.stringify(tabelas), antes);
});

test('só o admin do time associa (membro comum e gente de fora levam 403, e nada muda)', async (t) => {
  const { carregados, tabelas } = comResultado();
  const pedir = subir([carregados['routes/games']], t);
  const antes = JSON.stringify(tabelas);
  for (const quem of [A, BETO, FORA]) {
    const r = await pedir('POST', rota, { convidado_nome: 'Beto', user_id: BETO }, quem);
    assert.equal(r.status, 403, quem);
  }
  assert.equal((await pedir('GET', rota, null, A)).status, 403);
  assert.equal((await pedir('POST', `${rota}/desfazer`, { user_id: BETO }, A)).status, 403);
  assert.equal(JSON.stringify(tabelas), antes);
});

test('membro de outro time: 403 e nada muda', async (t) => {
  const { carregados, tabelas } = comResultado();
  const pedir = subir([carregados['routes/games']], t);
  const antes = JSON.stringify(tabelas);
  const r = await pedir('POST', rota, { convidado_nome: 'Beto', user_id: FORA }, DONO);
  assert.equal(r.status, 403);
  assert.match(r.json.error, /não é do time/);
  assert.equal(JSON.stringify(tabelas), antes);
});

test('o mesmo membro não ocupa duas vagas no jogo (400), nem quem já tem gols nele', async (t) => {
  const { carregados, tabelas } = comResultado();
  const pedir = subir([carregados['routes/games']], t);
  // Magrão já joga: não dá para ele ocupar a vaga do Beto
  const dupla = await pedir('POST', rota, { convidado_nome: 'Beto', user_id: A }, DONO);
  assert.equal(dupla.status, 400, JSON.stringify(dupla.json));
  assert.match(dupla.json.error, /duas vagas/);

  // dois convidados para o MESMO membro: o 1º entra, o 2º é recusado
  assert.equal((await pedir('POST', rota, { convidado_nome: 'Beto', user_id: BETO }, DONO)).status, 200);
  const segunda = await pedir('POST', rota, { convidado_nome: 'Caio', user_id: BETO }, DONO);
  assert.equal(segunda.status, 400, JSON.stringify(segunda.json));
  assert.match(segunda.json.error, /duas vagas/);
  assert.equal(tabelas.gols_jogadores.find((g) => g.id === 'g3').convidado_nome, 'Caio', 'o Caio continua convidado');
});

test('não dá para associar quem já tem conta, nem um convidado que não está no jogo', async (t) => {
  const { carregados } = comResultado();
  const pedir = subir([carregados['routes/games']], t);
  const comConta = await pedir('POST', rota, { convidado_nome: 'Zé', user_id: BETO }, DONO);
  assert.equal(comConta.status, 400, JSON.stringify(comConta.json));
  assert.match(comConta.json.error, /já tem conta/);
  const ninguem = await pedir('POST', rota, { convidado_nome: 'Fulano', user_id: BETO }, DONO);
  assert.equal(ninguem.status, 404);
  assert.equal((await pedir('POST', rota, { convidado_nome: '', user_id: BETO }, DONO)).status, 400);
  assert.equal((await pedir('POST', rota, { convidado_nome: 'Beto', user_id: 'não-é-uuid' }, DONO)).status, 400);
  assert.equal((await pedir('POST', rota, { convidado_nome: { x: 1 }, user_id: BETO }, DONO)).status, 400);
});

test('quem já tinha confirmado presença não ganha uma segunda linha; quem estava como "não vou" passa a confirmado', async (t) => {
  const { carregados, tabelas } = cenario({ game_players: [{ id: 'gpb', game_id: JOGO, user_id: BETO, confirmado: false }] });
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('POST', rota, { convidado_nome: 'Beto', user_id: BETO }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const linhas = tabelas.game_players.filter((p) => p.user_id === BETO);
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].confirmado, true);
  assert.equal(linhaDoJogo(tabelas).times_resultado.registro.associacoes[0].presenca_antes, false);
});

test('o convidado que está na reserva também vira o membro, no mesmo lugar', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('POST', rota, { convidado_nome: 'reserva zeca', user_id: CAIO }, DONO); // maiúsculas e espaços não importam
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const tr = linhaDoJogo(tabelas).times_resultado;
  assert.deepEqual(tr.reservas.map((j) => [j.user_id, j.nome]), [[CAIO, 'Caio']]);
  assert.equal(jogadoresDe(tr).filter((j) => j.convidado).length, 2, 'os outros dois convidados seguem convidados');
});

test('a lista: convidados do jogo e membros com o motivo de quem não pode ser escolhido', async (t) => {
  const { carregados } = comResultado();
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('GET', rota, null, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.convidados.map((c) => [c.nome, c.time, c.reserva]), [['Beto', 0, false], ['Caio', 1, false], ['Reserva Zeca', null, true]]);
  const porId = Object.fromEntries(r.json.membros.map((m) => [m.user_id, m]));
  assert.equal(porId[A].disponivel, false);
  assert.equal(porId[A].motivo, 'Já está neste jogo');
  assert.equal(porId[BETO].disponivel, true);
  assert.equal(porId[BETO].nome, 'Betão', 'o apelido, nunca o nome completo');
  assert.equal(porId[BETO].avatar_url, 'https://x.test/Betão.webp');
  assert.equal(porId[FORA], undefined, 'gente de outro time não aparece');
  assert.ok(!JSON.stringify(r.json).includes('@futtymock.com'), 'nenhum e-mail na resposta');
  // os disponíveis vêm primeiro
  const ordem = r.json.membros.map((m) => m.disponivel);
  assert.deepEqual(ordem, [...ordem].sort((a, b) => Number(b) - Number(a)));
});

test('a lista dos membros que não dá para ler é erro, nunca "ninguém do time" (a janela mostrava vazio como se fosse verdade)', async (t) => {
  // Só a leitura dos membros COM o apelido falha (a do papel do admin passa): é ela que enche a lista.
  const falhar = (tabela, op, e) => (tabela === 'team_members' && op === 'select' && /users\s*\(/.test(e.cols || '') ? { message: 'falha de leitura' } : null);
  const { carregados } = cenario({}, { falhar });
  const pedir = subir([carregados['routes/games']], t);
  const r = await pedir('GET', rota, null, DONO);
  assert.equal(r.status, 500, JSON.stringify(r.json));
  assert.equal(r.json.membros, undefined);
});

test('a página pública do jogo não leva as associações (ids de conta e o que havia antes são do admin)', async (t) => {
  const { carregados } = comResultado();
  const pedir = subir([carregados['routes/games']], t);
  assert.equal((await pedir('POST', rota, { convidado_nome: 'Beto', user_id: BETO }, DONO)).status, 200);
  const pub = await pedir('GET', `/api/p/${JOGO}`);
  assert.equal(pub.status, 200, JSON.stringify(pub.json));
  assert.equal(pub.json.times_resultado.registro.associacoes, undefined);
  assert.ok(!JSON.stringify(pub.json).includes('presenca_antes'));
  assert.equal(pub.json.times_resultado.times[0].jogadores[1].nome, 'Betão');
});

// ─── O campeonato que nasceu daquele sorteio ─────────────────────────────────────────────────────────────────────────────

test('jogo que virou campeonato: o selo de campeão vai para o membro, na hora, com o post da Resenha atualizado', async (t) => {
  const { carregados, tabelas } = cenario({ feed_posts: [] });
  const store = carregados['utils/campeonatoStore'];
  const pedir = subir([carregados['routes/games'], carregados['routes/campeonatos']], t);

  // o campeonato do sorteio: o elenco é copiado dele (o Beto entra como convidado) e o Time A é campeão
  const times = sorteio().times;
  const plantel = times.map((tm) => tm.jogadores.map((j) => ({ user_id: j.user_id, nome: j.nome, avatar_url: null, convidado: !!j.convidado })));
  const camp = await store.criar(TIME, DONO, {
    nome: 'Copa da Várzea', formato: 'pontos', nomes: ['Ouro', 'Roxo'], plantel,
    origem: { game_id: JOGO, assinatura: store.assinaturaDosTimes(times), data: PASSADO },
  });
  store.aplicarResultado(camp, camp.confrontos[0].id, 2, 0);
  await store.guardar(camp);
  assert.equal(camp.estado, 'terminado');
  const ouro = camp.times.find((x) => x.nome === 'Ouro');
  assert.equal(camp.campeao_time_id, ouro.id);

  // antes: o Beto não tem selo nenhum (e a resposta fica em cache — a associação precisa derrubá-lo)
  const antes = await pedir('GET', '/api/me/selos', null, BETO);
  assert.equal(antes.status, 200, JSON.stringify(antes.json));
  assert.deepEqual(antes.json.selos.filter((s) => s.fonte === 'campeonato'), []);

  const r = await pedir('POST', rota, { convidado_nome: 'Beto', user_id: BETO }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.campeonatos, 1);

  // depois: CAMPEÃO, no mesmo instante
  const depois = await pedir('GET', '/api/me/selos', null, BETO);
  assert.deepEqual(depois.json.selos.filter((s) => s.fonte === 'campeonato').map((s) => [s.label, s.sub]), [['CAMPEÃO', 'Copa da Várzea']]);

  // o documento do campeonato: o elenco do Ouro tem o membro (apelido), e continua reconhecido como vindo deste sorteio
  const gravado = await store.obter(TIME, camp.id);
  const jogadoresDoOuro = gravado.times.find((x) => x.id === ouro.id).jogadores;
  assert.deepEqual(jogadoresDoOuro.map((j) => [j.user_id, j.nome, j.convidado]), [[A, 'Magrão', false], [BETO, 'Betão', false]]);
  assert.equal(gravado.origem_assinatura, store.assinaturaDosTimes(linhaDoJogo(tabelas).times_resultado.times));
  const lista = await store.listar(TIME);
  assert.equal(store.jogosElegiveisParaCampeonato([{ ...linhaDoJogo(tabelas), data: new Date().toISOString() }], lista).length, 0, 'o jogo não é oferecido de novo como campeonato');

  // a Resenha: o post do campeão passa a falar do Betão
  const posts = tabelas.feed_posts;
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].conteudo.campeao.jogadores.map((j) => [j.user_id, j.nome, j.convidado]), [[A, 'Magrão', false], [BETO, 'Betão', false]]);
  assert.equal(gravado.post_id, posts[0].id);
});

test('desfazer: tudo volta ao que era (vaga, gols, presença, elenco, selo), e repetir não muda nada', async (t) => {
  const { carregados, tabelas } = comResultado();
  const store = carregados['utils/campeonatoStore'];
  const pedir = subir([carregados['routes/games'], carregados['routes/campeonatos']], t);
  const times = sorteio().times;
  const plantel = times.map((tm) => tm.jogadores.map((j) => ({ user_id: j.user_id, nome: j.nome, avatar_url: null, convidado: !!j.convidado })));
  const camp = await store.criar(TIME, DONO, { nome: 'Copa', formato: 'pontos', nomes: ['Ouro', 'Roxo'], plantel, origem: { game_id: JOGO, assinatura: store.assinaturaDosTimes(times), data: PASSADO } });
  store.aplicarResultado(camp, camp.confrontos[0].id, 2, 0);
  await store.guardar(camp);
  const trAntes = JSON.stringify(linhaDoJogo(tabelas).times_resultado);
  const golsAntes = JSON.stringify(tabelas.gols_jogadores);
  const presencasAntes = JSON.stringify(tabelas.game_players);

  assert.equal((await pedir('POST', rota, { convidado_nome: 'Beto', user_id: BETO }, DONO)).status, 200);
  const lista = await pedir('GET', rota, null, DONO);
  assert.equal(lista.json.desfaziveis.length, 1);
  assert.equal(lista.json.desfaziveis[0].convidado_nome, 'Beto');

  const r = await pedir('POST', `${rota}/desfazer`, { user_id: BETO }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ja_desfeito, false);

  const tr = linhaDoJogo(tabelas).times_resultado;
  assert.deepEqual(tr.times.map((x) => x.jogadores), JSON.parse(trAntes).times.map((x) => x.jogadores), 'os times voltaram, posição por posição');
  assert.equal(JSON.stringify(tabelas.gols_jogadores), golsAntes);
  assert.equal(JSON.stringify(tabelas.game_players), presencasAntes, 'a presença que a associação criou saiu');
  const gravado = await store.obter(TIME, camp.id);
  assert.deepEqual(gravado.times.find((x) => x.nome === 'Ouro').jogadores.map((j) => [j.user_id, j.nome, j.convidado]), [[A, 'Magrão', false], [null, 'Beto', true]]);
  const selos = await pedir('GET', '/api/me/selos', null, BETO);
  assert.deepEqual(selos.json.selos.filter((s) => s.fonte === 'campeonato'), []);
  assert.equal(tr.registro.associacoes[0].desfeita_em != null, true);
  assert.deepEqual((await pedir('GET', rota, null, DONO)).json.desfaziveis, []);

  // repetir o Desfazer não faz nada; e o convidado pode ser associado de novo (a outra pessoa)
  const de_novo = await pedir('POST', `${rota}/desfazer`, { user_id: BETO }, DONO);
  assert.equal(de_novo.status, 200);
  assert.equal(de_novo.json.ja_desfeito, true);
  assert.equal((await pedir('POST', rota, { convidado_nome: 'Beto', user_id: CAIO }, DONO)).status, 200);
});

test('desfazer só vale por 24 horas, e quem nunca foi associado leva 404', async (t) => {
  const { carregados, tabelas } = comResultado();
  const pedir = subir([carregados['routes/games']], t);
  assert.equal((await pedir('POST', rota, { convidado_nome: 'Beto', user_id: BETO }, DONO)).status, 200);
  // faz de conta que foi anteontem
  const registro = linhaDoJogo(tabelas).times_resultado.registro;
  registro.associacoes[0].em = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const velho = await pedir('POST', `${rota}/desfazer`, { user_id: BETO }, DONO);
  assert.equal(velho.status, 400, JSON.stringify(velho.json));
  assert.match(velho.json.error, /24 horas/);
  assert.equal(linhaDoJogo(tabelas).times_resultado.times[0].jogadores[1].user_id, BETO, 'nada voltou');
  assert.deepEqual((await pedir('GET', rota, null, DONO)).json.desfaziveis, []);

  assert.equal((await pedir('POST', `${rota}/desfazer`, { user_id: CAIO }, DONO)).status, 404);
});

test('depois de associar, ajustar os times à mão continua funcionando e mantém o registro das associações', async (t) => {
  const { carregados, tabelas } = comResultado();
  const pedir = subir([carregados['routes/games']], t);
  assert.equal((await pedir('POST', rota, { convidado_nome: 'Beto', user_id: BETO }, DONO)).status, 200);
  const atual = linhaDoJogo(tabelas).times_resultado;
  // o app manda de volta o que leu, com os dois jogadores trocados de time
  const times = [
    { nome: 'Time A', jogadores: [atual.times[0].jogadores[0], atual.times[1].jogadores[0]] },
    { nome: 'Time B', jogadores: [atual.times[0].jogadores[1], atual.times[1].jogadores[1]] },
  ];
  const r = await pedir('PATCH', `/api/games/${JOGO}/times`, { times_resultado: { times, reservas: atual.reservas } }, DONO);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const novo = linhaDoJogo(tabelas).times_resultado;
  assert.equal(novo.registro.associacoes.length, 1);
  assert.equal(novo.registro.ajustes.length, 1);
});
