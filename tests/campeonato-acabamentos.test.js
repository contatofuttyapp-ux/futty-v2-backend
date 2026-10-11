// Futty v2.0 — RODADA 30L, parte 2 (motor): os acabamentos do campeonato.
//   · pênaltis: a final e o mata-mata não aceitam empate "seco" — o placar fica como foi digitado e o vencedor dos pênaltis decide;
//   · a final pode ser corrigida DEPOIS do campeão (os jogos de antes, não);
//   · o nome do campeonato criado pelo sorteio é do admin, e a data do jogo vira `origem_data` (subtítulo);
//   · o Início do time todo: o campeonato em andamento (fase, X de N jogos, os 2 primeiros) e o campeão por 7 dias;
//   · a Resenha: UM post do campeão por campeonato (corrigir a final atualiza o mesmo), sem migração (linha de `feed_posts`).
//
// Uso: npm test  (ou: node --test tests/campeonato-acabamentos.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregar, subir } = require('./_rotas');
const store = require('../utils/campeonatoStore');

// ─── Pênaltis (puro) ─────────────────────────────────────────────────────────────────────────────────────────────────────

function campeonato(nomes, formato) {
  return store.montar('time-1', 'dono-1', { nome: 'Copa', formato, nomes });
}
const idDe = (camp, nome) => camp.times.find((t) => t.nome === nome).id;
const jogarGrupo = (camp, x, y, gx, gy) => {
  const X = idDe(camp, x); const Y = idDe(camp, y);
  const c = camp.confrontos.find((k) => k.fase !== 'final' && ((k.time_a_id === X && k.time_b_id === Y) || (k.time_a_id === Y && k.time_b_id === X)));
  return store.aplicarResultado(camp, c.id, c.time_a_id === X ? gx : gy, c.time_a_id === X ? gy : gx);
};
function comFinal() {
  const camp = campeonato(['Ouro', 'Roxo', 'Prata'], 'pontos_final');
  jogarGrupo(camp, 'Ouro', 'Roxo', 1, 0);
  jogarGrupo(camp, 'Ouro', 'Prata', 1, 0);
  jogarGrupo(camp, 'Roxo', 'Prata', 1, 0);
  return camp; // final: Ouro × Roxo
}
const final = (camp) => camp.confrontos.find((c) => c.fase === 'final');

test('final empatada + vencedor dos pênaltis: o placar fica como digitado e o vencedor leva o título', () => {
  const camp = comFinal();
  const roxo = idDe(camp, 'Roxo');
  store.aplicarResultado(camp, final(camp).id, 2, 2, [], roxo);
  assert.deepEqual([final(camp).placar_a, final(camp).placar_b], [2, 2], 'o placar não vira 3 × 2: fica 2 × 2');
  assert.equal(final(camp).penaltis_vencedor_id, roxo);
  assert.equal(final(camp).vencedor_id, roxo);
  assert.equal(camp.campeao_time_id, roxo);
  assert.equal(camp.estado, 'terminado');
  assert.deepEqual(store.podio(camp).map((p) => [p.pos, p.time.nome]), [[1, 'Roxo'], [2, 'Ouro'], [3, 'Prata']], 'pódio e selos usam o vencedor dos pênaltis');
});

test('os pênaltis só valem em empate: com placar decidido o vencedor do placar manda e o pedido de pênaltis é ignorado', () => {
  const camp = comFinal();
  store.aplicarResultado(camp, final(camp).id, 3, 1, [], idDe(camp, 'Roxo'));
  assert.equal(final(camp).penaltis_vencedor_id, null);
  assert.equal(camp.campeao_time_id, final(camp).time_a_id === idDe(camp, 'Ouro') ? idDe(camp, 'Ouro') : idDe(camp, 'Roxo'));
});

test('empate na fase de grupos continua valendo ponto (sem pênaltis)', () => {
  const camp = campeonato(['Ouro', 'Roxo', 'Prata'], 'pontos_final');
  jogarGrupo(camp, 'Ouro', 'Roxo', 2, 2);
  const c = camp.confrontos.find((k) => k.jogado);
  assert.equal(c.penaltis_vencedor_id, null);
  assert.equal(c.vencedor_id, null);
});

test('mata-mata: o empate numa semifinal também pede os pênaltis, e o vencedor avança', () => {
  const camp = campeonato(['A', 'B', 'C', 'D'], 'mata');
  const semi = camp.confrontos.find((c) => c.ronda === 1 && c.ordem === 0);
  assert.throws(() => store.aplicarResultado(camp, semi.id, 0, 0), /Empatou: diga quem venceu nos pênaltis/);
  store.aplicarResultado(camp, semi.id, 0, 0, [], semi.time_b_id);
  assert.equal(semi.vencedor_id, semi.time_b_id);
  const decisao = camp.confrontos.find((c) => c.ronda === 2);
  assert.equal(decisao.time_a_id, semi.time_b_id, 'quem ganhou nos pênaltis foi para a final');
});

// ─── Corrigir a final depois do campeão ──────────────────────────────────────────────────────────────────────────────────────

test('depois do campeão só a FINAL pode ser corrigida: o campeão muda, os selos de 30 dias não renovam, os jogos de antes seguem travados', () => {
  const camp = comFinal();
  store.aplicarResultado(camp, final(camp).id, 2, 1); // quem é "A" da final vence
  const campeaoAntes = camp.campeao_time_id;
  const terminadoEm = camp.terminado_em;
  assert.equal(campeaoAntes, final(camp).time_a_id);
  store.aplicarResultado(camp, final(camp).id, 0, 3); // era engano: o outro venceu
  assert.equal(camp.campeao_time_id, final(camp).time_b_id);
  assert.equal(camp.estado, 'terminado');
  assert.equal(camp.terminado_em, terminadoEm);
  const grupo = camp.confrontos.find((c) => c.fase === 'grupos');
  assert.throws(() => store.aplicarResultado(camp, grupo.id, 5, 0), (e) => e.message === store.MSG_FINAL_JOGADA);
});

test('a final corrigida de um empate para um placar (e vice-versa) limpa ou grava o vencedor dos pênaltis', () => {
  const camp = comFinal();
  store.aplicarResultado(camp, final(camp).id, 1, 1, [], final(camp).time_a_id);
  assert.equal(final(camp).penaltis_vencedor_id, final(camp).time_a_id);
  store.aplicarResultado(camp, final(camp).id, 1, 2);
  assert.equal(final(camp).penaltis_vencedor_id, null);
  assert.equal(camp.campeao_time_id, final(camp).time_b_id);
});

// ─── O Início do time todo (puro) ────────────────────────────────────────────────────────────────────────────────────────────

const DIA = 86400000;
const jog = (id, nome) => ({ user_id: id, nome, avatar_url: null });
function quatroTimes(formato = 'pontos_final') {
  return store.montar('time-1', 'dono-1', {
    nome: 'Campeonato Domingueira FC', formato, nomes: ['Time Ouro', 'Time Roxo', 'Time Prata', 'Time Bronze'],
    plantel: [[jog('u1', 'Rafael')], [jog('u2', 'Bruno')], [jog('u3', 'Carlos')], [jog('u4', 'Diego')]],
  });
}

test('Início: campeonato recém-criado — fase de grupos, 0 de 6 jogos, sem "os 2 primeiros" (a tabela zerada não tem primeiro)', () => {
  const r = store.resumoParaInicio(quatroTimes(), 'u1');
  assert.equal(r.fase, 'Fase de grupos');
  assert.deepEqual([r.jogos_lancados, r.jogos_total], [0, 6]);
  assert.deepEqual(r.primeiros, []);
  assert.equal(r.final, null);
  assert.equal(r.campeao, null);
  assert.equal(r.voce_e_campeao, false);
});

test('Início: em andamento mostra "X de 6 jogos" e os 2 primeiros; com a final definida, a final', () => {
  const camp = quatroTimes();
  jogarGrupo(camp, 'Time Ouro', 'Time Bronze', 3, 1);
  jogarGrupo(camp, 'Time Roxo', 'Time Prata', 1, 1);
  jogarGrupo(camp, 'Time Ouro', 'Time Prata', 2, 0);
  let r = store.resumoParaInicio(camp, 'u1');
  assert.deepEqual([r.fase, r.jogos_lancados, r.jogos_total], ['Fase de grupos', 3, 6]);
  assert.deepEqual(r.primeiros.map((p) => [p.nome, p.PTS]), [['Time Ouro', 6], ['Time Roxo', 1]]);
  jogarGrupo(camp, 'Time Bronze', 'Time Roxo', 0, 2);
  jogarGrupo(camp, 'Time Ouro', 'Time Roxo', 1, 2);
  jogarGrupo(camp, 'Time Prata', 'Time Bronze', 2, 1);
  r = store.resumoParaInicio(camp, 'u1');
  assert.equal(r.fase, 'Final');
  assert.deepEqual([r.jogos_lancados, r.jogos_total], [6, 6]);
  assert.deepEqual([r.final.a.nome, r.final.b.nome].sort(), ['Time Ouro', 'Time Roxo']);
});

test('Início: o campeão aparece por 7 dias e "Você é campeão!" só para quem é do time campeão', () => {
  const camp = quatroTimes();
  // o mais forte vence todos por 2 × 1: Ouro > Roxo > Prata > Bronze
  [['Time Ouro', 'Time Roxo'], ['Time Ouro', 'Time Prata'], ['Time Ouro', 'Time Bronze'], ['Time Roxo', 'Time Prata'], ['Time Roxo', 'Time Bronze'], ['Time Prata', 'Time Bronze']]
    .forEach(([x, y]) => jogarGrupo(camp, x, y, 2, 1));
  store.aplicarResultado(camp, final(camp).id, 1, 0);
  const campeaoId = camp.campeao_time_id;
  const campeao = camp.times.find((t) => t.id === campeaoId);
  const dono = campeao.jogadores[0].user_id;
  const outro = camp.times.find((t) => t.id !== campeaoId).jogadores[0].user_id;
  const campeaoDoTime = store.resumoParaInicio(camp, dono);
  assert.equal(campeaoDoTime.fase, 'Terminado');
  assert.equal(campeaoDoTime.campeao.nome, campeao.nome);
  assert.equal(campeaoDoTime.voce_e_campeao, true);
  assert.equal(store.resumoParaInicio(camp, outro).voce_e_campeao, false);
  const termino = Date.parse(camp.terminado_em);
  assert.ok(store.resumoDoInicio([camp], dono, termino + 6 * DIA), 'no 6º dia ainda aparece');
  assert.equal(store.resumoDoInicio([camp], dono, termino + 8 * DIA), null, 'passada a semana, sai do Início');
});

test('Início: o que está em andamento tem preferência sobre o campeão da semana; sem nada, o card some', () => {
  const velho = quatroTimes();
  velho.estado = 'terminado'; velho.terminado_em = new Date().toISOString(); velho.campeao_time_id = velho.times[0].id;
  const novo = quatroTimes();
  novo.criado_em = new Date(Date.now() + 1000).toISOString();
  assert.equal(store.resumoDoInicio([velho, novo], 'u1').estado, 'em_curso');
  assert.equal(store.resumoDoInicio([velho], 'u1').estado, 'terminado');
  assert.equal(store.resumoDoInicio([], 'u1'), null);
});

test('Início: pontos corridos e mata-mata dizem a fase deles ("Pontos corridos", "Semifinais", "Final")', () => {
  assert.equal(store.resumoParaInicio(quatroTimes('pontos'), 'u1').fase, 'Pontos corridos');
  const mata = quatroTimes('mata');
  assert.deepEqual([store.resumoParaInicio(mata, 'u1').fase, store.resumoParaInicio(mata, 'u1').jogos_total], ['Semifinais', 3]);
  mata.confrontos.filter((c) => c.ronda === 1).forEach((c) => store.aplicarResultado(mata, c.id, 1, 0));
  assert.equal(store.resumoParaInicio(mata, 'u1').fase, 'Final');
});

// ─── As rotas: o nome, o post do campeão e o Início ───────────────────────────────────────────────────────────────────────────

const TIME = '11111111-1111-1111-1111-111111111111';
const JOGO = '99999999-9999-9999-9999-999999999999';
const DONO = 'd0000000-0000-0000-0000-000000000001';
const JOGADORES = ['a', 'b', 'c', 'd'].map((x) => `${x}0000000-0000-0000-0000-00000000000${x === 'a' ? 1 : x === 'b' ? 2 : x === 'c' ? 3 : 4}`);
const NOMES_J = ['Rafael', 'Bruno', 'Carlos', 'Diego'];
const usuario = (id, nome, avatar = null) => ({ id, nome: `${nome} da Silva`, nome_jogador: nome, email: `${nome}@futtymock.com`, avatar_url: avatar });
const membro = (id, nome, role = 'member') => ({ team_id: TIME, user_id: id, role, users: usuario(id, nome), teams: { id: TIME, nome: 'Domingueira FC', slug: 'domingueira-fc', cidade: null, fuso: 'America/Sao_Paulo' } });

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

function cenario(modulos = ['routes/campeonatos']) {
  const times = JOGADORES.map((id, i) => ({ nome: `Time ${String.fromCharCode(65 + i)}`, jogadores: [{ user_id: id, nome: NOMES_J[i], avatar_url: null, rating: 3 }] }));
  const t = carregar({
    teams: [{ id: TIME, nome: 'Domingueira FC', slug: 'domingueira-fc' }],
    users: [usuario(DONO, 'Pedro'), ...JOGADORES.map((id, i) => usuario(id, NOMES_J[i], `https://x/avatar-${i}.png`))],
    team_members: [membro(DONO, 'Pedro', 'admin'), ...JOGADORES.map((id, i) => membro(id, NOMES_J[i]))],
    games: [{ id: JOGO, team_id: TIME, data: new Date(Date.now() + 3 * DIA).toISOString(), status: 'agendado', sorteio_realizado: true, times_resultado: { seed: 1, num_times: 4, times, reservas: [] } }],
    feed_posts: [],
  }, modulos);
  t.cliente.storage = storageFalso();
  return t;
}
const base = '/api/equipas/domingueira-fc/campeonatos';

/** Cria pelo sorteio do jogo e lança os 6 jogos (o Time Ouro vence tudo; Prata × Bronze empata 0×0). Devolve o campeonato com a final definida. */
async function ateAFinal(pedir, formato = 'pontos_final', nome) {
  const criado = await pedir('POST', `${base}/de-sorteio`, { game_id: JOGO, formato, ...(nome ? { nome } : {}) }, DONO);
  assert.equal(criado.status, 201);
  let camp = criado.json.campeonato;
  const nomeDe = (id) => camp.times.find((x) => x.id === id).nome;
  const forca = { 'Time Ouro': 4, 'Time Roxo': 3, 'Time Prata': 2, 'Time Bronze': 2 };
  let r;
  for (const g of camp.confrontos.filter((c) => c.fase !== 'final')) {
    const fa = forca[nomeDe(g.time_a_id)]; const fb = forca[nomeDe(g.time_b_id)];
    const [a, b] = fa > fb ? [1, 0] : fa < fb ? [0, 1] : [0, 0];
    r = await pedir('POST', `${base}/${camp.id}/confrontos/${g.id}/resultado`, { placar_a: a, placar_b: b }, DONO);
    assert.equal(r.status, 200);
  }
  return r.json.campeonato;
}
const nomesDosTimes = ['Time Ouro', 'Time Roxo', 'Time Prata', 'Time Bronze'];
void nomesDosTimes;

test('nome do campeonato pelo sorteio: o do admin (já vem "Campeonato <time>") e a data do jogo vai para origem_data', async (t) => {
  const { carregados } = cenario();
  const pedir = subir([carregados['routes/campeonatos']], t);
  const padrao = await pedir('POST', `${base}/de-sorteio`, { game_id: JOGO, formato: 'pontos' }, DONO);
  assert.equal(padrao.json.campeonato.nome, 'Campeonato Domingueira FC', 'sem nome, o padrão — sem a data');
  assert.ok(padrao.json.campeonato.origem_data, 'a data do jogo ficou guardada para o subtítulo');
  const meu = await pedir('POST', `${base}/de-sorteio`, { game_id: JOGO, formato: 'mata', nome: '  Copa da Resenha  ' }, DONO);
  assert.equal(meu.json.campeonato.nome, 'Copa da Resenha');
  const longo = await pedir('POST', `${base}/de-sorteio`, { game_id: JOGO, formato: 'mata', nome: 'x'.repeat(100) }, DONO);
  assert.equal(longo.json.campeonato.nome.length, 60);
});

test('rota: final empatada com o vencedor dos pênaltis; sem ele, 400', async (t) => {
  const { carregados } = cenario();
  const pedir = subir([carregados['routes/campeonatos']], t);
  const camp = await ateAFinal(pedir);
  const fin = camp.confrontos.find((c) => c.fase === 'final');
  const sem = await pedir('POST', `${base}/${camp.id}/confrontos/${fin.id}/resultado`, { placar_a: 2, placar_b: 2 }, DONO);
  assert.equal(sem.status, 400);
  assert.match(sem.json.error, /Empatou: diga quem venceu nos pênaltis/);
  const com = await pedir('POST', `${base}/${camp.id}/confrontos/${fin.id}/resultado`, { placar_a: 2, placar_b: 2, penaltis_vencedor_id: fin.time_b_id }, DONO);
  assert.equal(com.status, 200);
  const f = com.json.campeonato.confrontos.find((c) => c.fase === 'final');
  assert.deepEqual([f.placar_a, f.placar_b, f.penaltis_vencedor_id], [2, 2, fin.time_b_id]);
  assert.equal(com.json.campeonato.campeao.id, fin.time_b_id);
});

test('rota: terminar o campeonato cria UM post do campeão; corrigir a final atualiza o mesmo post', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/campeonatos']], t);
  const camp = await ateAFinal(pedir, 'pontos_final', 'Copa da Resenha');
  assert.equal(tabelas.feed_posts.length, 0, 'sem final jogada, sem post');
  const fin = camp.confrontos.find((c) => c.fase === 'final');
  const nome = (id) => camp.times.find((x) => x.id === id).nome;
  const ok = await pedir('POST', `${base}/${camp.id}/confrontos/${fin.id}/resultado`, { placar_a: 2, placar_b: 2, penaltis_vencedor_id: fin.time_a_id }, DONO);
  assert.equal(ok.status, 200);
  assert.equal(tabelas.feed_posts.length, 1);
  const post = tabelas.feed_posts[0];
  assert.equal(post.team_id, TIME);
  assert.equal(post.tipo, 'post', 'o CHECK da coluna só aceita post, anuncio, jogo e voto: sem migração');
  assert.equal(post.author_id, DONO);
  assert.equal(post.body, `🏆 ${nome(fin.time_a_id)} é campeão · Copa da Resenha`);
  assert.equal(post.conteudo.tipo, 'campeao_campeonato');
  assert.equal(post.conteudo.campeonato_id, camp.id);
  assert.equal(post.conteudo.campeao.nome, nome(fin.time_a_id));
  assert.equal(post.conteudo.campeao.jogadores.length, 1);
  assert.deepEqual(post.conteudo.podio.map((p) => p.pos), [1, 2, 3, 3]);
  assert.deepEqual(post.conteudo.final, { a: { nome: nome(fin.time_a_id), gols: 2 }, b: { nome: nome(fin.time_b_id), gols: 2 }, penaltis: nome(fin.time_a_id) });
  const postId = post.id;

  // Corrigir a final (era o outro time nos pênaltis): o MESMO post é atualizado.
  const corrigida = await pedir('POST', `${base}/${camp.id}/confrontos/${fin.id}/resultado`, { placar_a: 2, placar_b: 2, penaltis_vencedor_id: fin.time_b_id }, DONO);
  assert.equal(corrigida.status, 200);
  assert.equal(corrigida.json.campeonato.campeao.id, fin.time_b_id);
  assert.equal(tabelas.feed_posts.length, 1, 'continua um post só');
  assert.equal(tabelas.feed_posts[0].id, postId);
  assert.equal(tabelas.feed_posts[0].conteudo.campeao.nome, nome(fin.time_b_id));
  assert.equal(tabelas.feed_posts[0].conteudo.final.penaltis, nome(fin.time_b_id));
  assert.equal((await pedir('GET', `${base}/${camp.id}`, null, DONO)).json.campeonato.post_id, postId, 'o campeonato guarda o id do post');

  // Os jogos da fase de grupos continuam travados depois do campeão.
  const grupo = camp.confrontos.find((c) => c.fase === 'grupos');
  assert.equal((await pedir('POST', `${base}/${camp.id}/confrontos/${grupo.id}/resultado`, { placar_a: 4, placar_b: 0 }, DONO)).status, 409);
  assert.equal(tabelas.feed_posts.length, 1);
});

test('rota: pontos corridos terminado pelo líder também ganha o post; apagar o campeonato apaga o post', async (t) => {
  const { carregados, tabelas } = cenario();
  const pedir = subir([carregados['routes/campeonatos']], t);
  const criado = await pedir('POST', base, { nome: 'Liga', formato: 'pontos', modo: 'manual', nomes: ['A', 'B', 'C'], plantel: [[{ user_id: JOGADORES[0], nome: 'Rafael' }], [], []] }, DONO);
  const id = criado.json.campeonato.id;
  const nomeDe = (c, tid) => c.times.find((x) => x.id === tid).nome;
  for (const g of criado.json.campeonato.confrontos.slice(0, 1)) {
    await pedir('POST', `${base}/${id}/confrontos/${g.id}/resultado`, { placar_a: 1, placar_b: 0 }, DONO);
  }
  void nomeDe;
  const fim = await pedir('POST', `${base}/${id}/terminar`, null, DONO);
  assert.equal(fim.status, 200);
  assert.equal(tabelas.feed_posts.length, 1);
  assert.equal(tabelas.feed_posts[0].conteudo.final, null, 'pontos corridos não tem final');
  const del = await pedir('DELETE', `${base}/${id}`, null, DONO);
  assert.equal(del.status, 200);
  assert.equal(tabelas.feed_posts.length, 0, 'o post sai junto com o campeonato');
});

test('rota: um erro ao gravar o post nunca desfaz o placar (a Resenha é enfeite do resultado)', async (t) => {
  const { carregados, tabelas, cliente } = cenario();
  const pedir = subir([carregados['routes/campeonatos']], t);
  const camp = await ateAFinal(pedir);
  const fin = camp.confrontos.find((c) => c.fase === 'final');
  const origem = cliente.from.bind(cliente);
  cliente.from = (tabela) => { if (tabela === 'feed_posts') throw new Error('banco fora do ar'); return origem(tabela); };
  const ok = await pedir('POST', `${base}/${camp.id}/confrontos/${fin.id}/resultado`, { placar_a: 1, placar_b: 0 }, DONO);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.campeonato.estado, 'terminado');
  assert.equal(tabelas.feed_posts.length, 0);
});

test('Início: o serviço entrega o campeonato novo do time (e some quando não há)', async (t) => {
  const { carregados, cliente } = cenario(['routes/campeonatos', 'services/inicio']);
  const pedir = subir([carregados['routes/campeonatos']], t);
  const inicio = carregados['services/inicio'];
  const principal = { id: TIME, slug: 'domingueira-fc' };
  assert.equal(await inicio.obterCampeonatoNovo(principal, JOGADORES[0]), null, 'sem campeonato, sem card');
  const camp = await ateAFinal(pedir);
  store.esquecerCacheDoInicio?.(TIME);
  const r = await inicio.obterCampeonatoNovo(principal, JOGADORES[0]);
  assert.equal(r.fase, 'Final');
  assert.equal(r.team_slug, 'domingueira-fc');
  assert.equal(r.jogos_total, 6);
  assert.equal(r.id, camp.id);
  void cliente;
});

test('Resenha: o post do campeão sai no feed com os avatares de hoje dos jogadores', async (t) => {
  const { carregados, tabelas } = cenario(['routes/campeonatos', 'routes/feed']);
  const pedir = subir([carregados['routes/campeonatos'], carregados['routes/feed']], t);
  const camp = await ateAFinal(pedir);
  const fin = camp.confrontos.find((c) => c.fase === 'final');
  await pedir('POST', `${base}/${camp.id}/confrontos/${fin.id}/resultado`, { placar_a: 3, placar_b: 1 }, DONO);
  // o avatar de quem é do time campeão mudou depois do campeonato nascer
  const donoDoTitulo = tabelas.feed_posts[0].conteudo.campeao.jogadores[0].user_id;
  tabelas.users.find((u) => u.id === donoDoTitulo).avatar_url = 'https://x/avatar-NOVO.png';
  const feed = await pedir('GET', '/api/feed', null, JOGADORES[3]);
  assert.equal(feed.status, 200);
  const post = feed.json.items.find((i) => i.kind === 'post' && i.conteudo?.tipo === 'campeao_campeonato');
  assert.ok(post, 'o post do campeão está na Resenha');
  assert.equal(post.team_name, 'Domingueira FC');
  assert.equal(post.conteudo.campeao.jogadores[0].avatar_url, 'https://x/avatar-NOVO.png');
  assert.equal(post.conteudo.final.a.gols + post.conteudo.final.b.gols, 4);
  assert.equal(post.comentarios_total, 0, 'aceita comentários e reações como os outros posts');
  assert.deepEqual(post.contagem_reacoes, {});
});
