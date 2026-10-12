// Futty v2.0 — SEGURANÇA · PENTEST DE ESCRITA, parte 2: as REGRAS que cada achado da varredura fixou, uma a uma.
//
// A varredura genérica (tests/seguranca-escrita.test.js) ataca todas as rotas com entrada maliciosa e prova "nunca 5xx com detalhe,
// nunca texto gigante guardado". Aqui estão as regras de negócio por trás de cada conserto — o placar de 999, o gol de quem é de outro
// time, a foto que não é sua, o avatar que destrancava o que é pago — e as portas que têm segredo próprio (webhook, upload, geração).
//
// O app de verdade (tests/_appFalsa.js) sobre banco, Storage e Auth de mentira. Nada de banco real, nada de rede.
//
// Uso: node --test tests/seguranca-escrita-regras.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { subirApp, SEGREDO_DO_WEBHOOK, URL_DO_BANCO } = require('./_appFalsa');
const { criarMundo, fotografiaDe, iso, HORA, sorteioDe } = require('./_mundoDeSeguranca');

let app;
before(async () => { app = await subirApp(); });
after(() => app.fechar());

const CASA = 'Deu ruim do nosso lado. Tente de novo em instantes.';
const longo = (n) => 'A'.repeat(n);
const arquivoNoStorage = (bucket, caminho) => app.storage.buckets.get(bucket)?.arquivos.has(caminho);
const gravarNoStorage = (bucket, caminho, corpo = 'x', tipo = 'image/png') => app.storage.buckets.get(bucket).arquivos.set(caminho, { corpo: Buffer.from(corpo), tipo, em: iso(-HORA) });
const urlCrua = (bucket, caminho) => `${URL_DO_BANCO}/storage/v1/object/public/${bucket}/${caminho}`;
const png = (w = 64, h = 64) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 130, b: 140 } } }).png().toBuffer();
const formularioComArquivo = (campo, buffer, tipo, nome = 'arquivo') => { const f = new FormData(); f.append(campo, new Blob([buffer], { type: tipo }), nome); return f; };

// ─── O corpo ilegível é erro de cliente ───────────────────────────────────────────────────────────────────────────────────────

test('corpo ilegível: JSON quebrado → 400 e corpo de mais de 2 MB → 413, com a frase da casa (nunca o texto do parser, nunca 500)', async () => {
  const m = criarMundo(app);
  const quebrado = await app.pedir('PATCH', '/api/me', { token: m.tok.memA, bruto: '{"nome":' });
  assert.equal(quebrado.status, 400, quebrado.texto);
  assert.equal(quebrado.json.error, 'Não deu para ler o que foi enviado. Confira e tente de novo.');
  assert.doesNotMatch(quebrado.texto, /Unexpected|JSON|position|token/i, 'a frase do parser cita o que foi digitado');
  const grande = await app.pedir('PATCH', '/api/me', { token: m.tok.memA, bruto: `{"nome":"${longo(2300000)}"}` });
  assert.equal(grande.status, 413, grande.texto);
  assert.equal(grande.json.error, 'O pedido é grande demais.');
  // o erro de verdade do servidor continua sendo 500 com a frase da casa
  const { corpoDoErro, statusDoErro } = require('../middleware/erros');
  assert.equal(statusDoErro(new TypeError('x')), 500);
  assert.equal(corpoDoErro(new TypeError('x')).error, CASA);
});

// ─── Jogo: data, local, jogadores por time ───────────────────────────────────────────────────────────────────────────────────────

test('novo jogo: data que não existe, local gigante ou que não é texto e jogadores por time absurdos → 400, e nada é gravado', async () => {
  const m = criarMundo(app);
  const base = { team_slug: m.A.slug, data: iso(48 * HORA), jogadores_por_time: 5, local: 'Quadra Vila Nova' };
  const jogos = () => app.tabelas.games.length;
  const antes = jogos();
  const ruins = [
    ['data inventada', { data: 'amanhã às oito' }, /Data inválida/],
    ['data objeto', { data: { a: 1 } }, /Data inválida/],
    ['local gigante', { local: longo(121) }, /Local: máximo 120/],
    ['local objeto', { local: { a: 1 } }, /Local: escreva um texto/],
    ['31 por time', { jogadores_por_time: 31 }, /Jogadores por time/],
    ['0 por time', { jogadores_por_time: 0 }, /jogadores por time/i],
  ];
  for (const [nome, troca, frase] of ruins) {
    const r = await app.pedir('POST', '/api/games', { token: m.tok.admA, corpo: { ...base, ...troca } });
    assert.equal(r.status, 400, `${nome} · ${r.texto}`);
    assert.match(r.json.error, frase, nome);
  }
  assert.equal(jogos(), antes, 'nenhum jogo foi criado');
  const certo = await app.pedir('POST', '/api/games', { token: m.tok.admA, corpo: { ...base, local: `  ${longo(120)}  ` } });
  assert.equal(certo.status, 201, certo.texto);
  assert.equal(certo.json.game.local.length, 120, 'o local de 120 passa, aparado');
  // editar o jogo: o mesmo teto
  const editar = await app.pedir('PATCH', `/api/games/${m.ids.jogoAbertoA}`, { token: m.tok.admA, corpo: { location: longo(121) } });
  assert.equal(editar.status, 400, editar.texto);
  const editarObjeto = await app.pedir('PATCH', `/api/games/${m.ids.jogoAbertoA}`, { token: m.tok.admA, corpo: { location: { a: 1 } } });
  assert.equal(editarObjeto.status, 400);
  assert.equal((await app.pedir('PATCH', `/api/games/${m.ids.jogoAbertoA}`, { token: m.tok.admA, corpo: { players_per_team: 99 } })).status, 400);
});

// ─── Times à mão: o que entra em times_resultado ─────────────────────────────────────────────────────────────────────────────────

test('times à mão: nome com teto, avatar só se for foto nossa, campo extra grande some, formato torto é 400 — nos dois caminhos (montar e ajustar)', async () => {
  const m = criarMundo(app);
  const jogador = { user_id: null, convidado: true, nome: 'Zeca', avatar_url: 'https://fora.test/pixel.png', lixo: { a: { b: 1 } }, grande: longo(5000), rating: 3, goleiro: false };
  const montar = (extra = {}) => ({ times: [{ nome: 'Ouro', jogadores: [{ ...jogador }], ...extra }, { nome: 'Roxo', jogadores: [{ nome: 'Beto', convidado: true }] }] });

  const ok = await app.pedir('POST', `/api/games/${m.ids.jogoAbertoA}/times-manuais`, { token: m.tok.admA, corpo: montar() });
  assert.equal(ok.status, 200, ok.texto);
  const guardado = app.tabelas.games.find((g) => g.id === m.ids.jogoAbertoA).times_resultado.times[0].jogadores[0];
  assert.equal(guardado.avatar_url, null, 'a foto de fora do Storage nosso vira "sem foto"');
  assert.equal(guardado.lixo, undefined, 'objeto dentro de objeto não entra');
  assert.equal(guardado.grande, undefined, 'campo de texto grande não entra');
  assert.equal(guardado.rating, 3, 'o campo de verdade (número) continua');
  assert.equal(guardado.convidado, true);

  // a foto NOSSA continua: a crua do bucket avatars
  const fotoNossa = urlCrua('avatars', `public/${m.p.memA.id}-123.jpg`);
  const comFoto = montar();
  comFoto.times[0].jogadores[0].avatar_url = fotoNossa;
  assert.equal((await app.pedir('POST', `/api/games/${m.ids.jogoAbertoA}/times-manuais`, { token: m.tok.admA, corpo: comFoto })).status, 200);
  assert.equal(app.tabelas.games.find((g) => g.id === m.ids.jogoAbertoA).times_resultado.times[0].jogadores[0].avatar_url, fotoNossa);

  const ruins = [
    ['nome de time gigante', montar({ nome: longo(41) })],
    ['nome de jogador gigante', { times: [{ nome: 'A', jogadores: [{ nome: longo(61), convidado: true }] }, { nome: 'B', jogadores: [{ nome: 'x', convidado: true }] }] }],
    ['jogador que não é objeto', { times: [{ nome: 'A', jogadores: ['Zeca'] }] }],
    ['user_id que não é id', { times: [{ nome: 'A', jogadores: [{ user_id: '../x', nome: 'Zeca' }] }] }],
    ['jogador sem nome nem conta', { times: [{ nome: 'A', jogadores: [{}] }] }],
    ['9 times', { times: Array.from({ length: 9 }, (_, i) => ({ nome: `T${i}`, jogadores: [{ nome: `J${i}`, convidado: true }] })) }],
    ['31 jogadores no time', { times: [{ nome: 'A', jogadores: Array.from({ length: 31 }, (_, i) => ({ nome: `J${i}`, convidado: true })) }] }],
    ['times que não é lista', { times: 'oi' }],
  ];
  for (const [nome, corpo] of ruins) {
    const r = await app.pedir('POST', `/api/games/${m.ids.jogoAbertoA}/times-manuais`, { token: m.tok.admA, corpo });
    assert.equal(r.status, 400, `montar · ${nome} · ${r.texto}`);
  }
  // ajustar depois do sorteio: as mesmas regras
  const ajustar = (times, reservas) => app.pedir('PATCH', `/api/games/${m.ids.jogoPassadoA}/times`, { token: m.tok.admA, corpo: { times_resultado: { times, reservas } } });
  const doJogo = app.tabelas.games.find((g) => g.id === m.ids.jogoPassadoA).times_resultado.times;
  const bom = await ajustar(doJogo.map((t) => ({ ...t })), []);
  assert.equal(bom.status, 200, bom.texto);
  const nomeGrande = doJogo.map((t) => ({ ...t, nome: longo(41) }));
  assert.equal((await ajustar(nomeGrande, [])).status, 400);
  const reservaGigante = await ajustar(doJogo.map((t) => ({ ...t })), [{ nome: longo(61), convidado: true }]);
  assert.equal(reservaGigante.status, 400, reservaGigante.texto);
  const reservaLixo = await ajustar(doJogo.map((t) => ({ ...t })), 'oi');
  assert.equal(reservaLixo.status, 400, reservaLixo.texto);
});

test('sortear: nome de convidado é cortado em 40 letras e objeto no lugar de nome é ignorado', async () => {
  const m = criarMundo(app);
  const r = await app.pedir('POST', `/api/games/${m.ids.jogoAbertoA}/sortear`, { token: m.tok.admA, corpo: { jogadoresPorTime: 3, convidados: [longo(300), { a: 1 }, 'Beto', 'Caio', 'Dani', 'Edu', 'Fábio'] } });
  assert.equal(r.status, 200, r.texto);
  const nomes = r.json.game.times_resultado.times.flatMap((t) => t.jogadores).map((j) => j.nome);
  assert.ok(nomes.every((n) => n.length <= 40), `um nome passou de 40: ${nomes.map((n) => n.length)}`);
  assert.ok(!nomes.includes('[object Object]'));
});

// ─── Placar, gols e quem pode marcar ─────────────────────────────────────────────────────────────────────────────────────────────

test('resultado do jogo: placar de 0 a 99 (999, negativo, decimal e texto são 400) e gol só de gente do time', async () => {
  const m = criarMundo(app);
  // Placar só existe com 2 times (com 3 ou 4 é rodízio: só o campeão): este jogo passa a ter dois.
  const doJogo = app.tabelas.games.find((g) => g.id === m.ids.jogoPassadoA);
  doJogo.times_resultado = sorteioDe([m.p.admA, m.p.memA]);
  doJogo.num_times = 2;
  const rota = `/api/games/${m.ids.jogoPassadoA}/resultado`;
  const pedir = (corpo) => app.pedir('PATCH', rota, { token: m.tok.admA, corpo });
  for (const [nome, corpo] of [
    ['999', { placar_a: 999, placar_b: 0 }], ['100', { placar_a: 100, placar_b: 1 }], ['negativo', { placar_a: -1, placar_b: 0 }],
    ['decimal', { placar_a: 2.5, placar_b: 1 }], ['texto', { placar_a: 'abc', placar_b: 1 }], ['notação científica', { placar_a: 1e308, placar_b: 0 }],
  ]) {
    const r = await pedir(corpo);
    assert.equal(r.status, 400, `${nome} · ${r.texto}`);
    assert.equal(app.tabelas.games.find((g) => g.id === m.ids.jogoPassadoA).placar_a ?? null, null, `${nome} · nada gravado`);
  }
  assert.equal((await pedir({ placar_a: 99, placar_b: 98 })).status, 200, 'o limite (99) passa');
  assert.equal(app.tabelas.games.find((g) => g.id === m.ids.jogoPassadoA).placar_a, 99);

  // gols: o gol de 100 é erro de digitação; o negativo vale 0 (como sempre); quem marca é do time
  const gols = (lista) => pedir({ gols: lista });
  assert.equal((await gols([{ user_id: m.p.memA.id, gols: 100 }])).status, 400);
  const negativo = await gols([{ user_id: m.p.memA.id, gols: -3 }]);
  assert.equal(negativo.status, 200, negativo.texto);
  assert.ok(app.tabelas.gols_jogadores.every((g) => g.gols === 0), 'gol negativo vira 0');
  const dePessoaDeOutroTime = await gols([{ user_id: m.p.memB.id, gols: 2 }]);
  assert.equal(dePessoaDeOutroTime.status, 400, dePessoaDeOutroTime.texto);
  assert.match(dePessoaDeOutroTime.json.error, /não é do time/);
  assert.ok(!app.tabelas.gols_jogadores.some((g) => g.user_id === m.p.memB.id), 'nenhum gol foi gravado para quem é de outro time');
  const idDeLixo = await gols([{ user_id: '../x', gols: 1 }]);
  assert.equal(idDeLixo.status, 400);
  const convidadoGigante = await gols([{ convidado_nome: longo(61), gols: 1 }]);
  assert.equal(convidadoGigante.status, 400, convidadoGigante.texto);
  assert.equal((await gols([{ user_id: m.p.memA.id, gols: 2 }, { convidado_nome: 'Zeca', gols: 1 }])).status, 200, 'quem é do time marca, e o convidado pelo nome');
  // e o nome de quem é de outro time nunca aparece na tela do jogo
  const tela = await app.pedir('GET', `/api/games/${m.ids.jogoPassadoA}`, { token: m.tok.admA });
  assert.ok(!tela.texto.includes(m.p.memB.nome), 'o nome de uma pessoa de outro time não aparece');
});

test('resultado da Resenha: artilheiro, destaque e rodada só de gente do time; gols de 0 a 99; o que já estava gravado segue valendo', async () => {
  const m = criarMundo(app);
  const rota = `/api/feed/games/${m.ids.jogoPassadoA}/resultado`;
  const pedir = (corpo) => app.pedir('PATCH', rota, { token: m.tok.admA, corpo });
  for (const campo of ['artilheiro_user_id', 'destaque_user_id', 'rodada_user_id']) {
    const r = await pedir({ [campo]: m.p.memB.id });
    assert.equal(r.status, 400, `${campo} · ${r.texto}`);
    assert.doesNotMatch(r.texto, new RegExp(m.p.memB.nome_jogador), 'o nome de quem é de outro time não vaza');
    assert.equal((await pedir({ [campo]: '../x' })).status, 400, `${campo} com lixo`);
  }
  assert.equal((await pedir({ artilheiro_gols: 100 })).status, 400);
  assert.equal((await pedir({ artilheiro_gols: -1 })).status, 400);
  assert.equal((await pedir({ artilheiro_gols: 'abc' })).status, 400);
  const certo = await pedir({ artilheiro_user_id: m.p.memA.id, artilheiro_gols: 3, destaque_user_id: m.p.memA2.id, destaque_titulo: 'Craque' });
  assert.equal(certo.status, 200, certo.texto);
  assert.equal(certo.json.game.artilheiro_nome, 'Alice');
  // quem saiu do time depois do jogo não trava a edição do resultado: o id que já estava gravado passa
  app.tabelas.team_members = app.tabelas.team_members.filter((t) => t.user_id !== m.p.memA.id);
  const reenviado = await pedir({ artilheiro_user_id: m.p.memA.id, destaque_titulo: 'Outro título' });
  assert.equal(reenviado.status, 200, reenviado.texto);
});

// ─── Campeonato: nomes, plantel, placar ──────────────────────────────────────────────────────────────────────────────────────────

test('campeonato à mão: nomes com teto, plantel só de gente do time, foto só se for nossa, placar de 0 a 99', async () => {
  const m = criarMundo(app);
  const criar = (corpo) => app.pedir('POST', `/api/equipas/${m.A.slug}/campeonatos`, { token: m.tok.admA, corpo });
  const nomes = ['Ouro', 'Roxo', 'Prata'];
  for (const [nome, corpo, frase] of [
    ['time de 41', { nome: 'Copa', formato: 'pontos', nomes: ['Ouro', longo(41), 'Prata'] }, /Nome do time: máximo 40/],
    ['time que é objeto', { nome: 'Copa', formato: 'pontos', nomes: ['Ouro', { a: 1 }, 'Prata'] }, /Nome do time: escreva um texto/],
    ['nome que é objeto', { nome: { a: 1 }, formato: 'pontos', nomes }, /escreva um texto/],
    ['jogador de outro time no plantel', { nome: 'Copa', formato: 'pontos', nomes, plantel: [[{ user_id: m.p.memB.id, nome: 'Beto' }]] }, /não é do time/],
    ['jogador com id de lixo', { nome: 'Copa', formato: 'pontos', nomes, plantel: [[{ user_id: '../x', nome: 'x' }]] }, /não é do time/],
    ['jogador que é texto', { nome: 'Copa', formato: 'pontos', nomes, plantel: [['Zeca']] }, /formato que não dá para ler/],
  ]) {
    const r = await criar(corpo);
    assert.equal(r.status, 400, `${nome} · ${r.texto}`);
    assert.match(r.json.error, frase, nome);
  }
  const antes = [...(app.storage.buckets.get('campeonatos')?.arquivos.keys() || [])].length;
  assert.equal(antes, 0, 'nenhum campeonato foi criado pelos pedidos ruins');
  // o nome do campeonato acima de 60 sempre foi cortado, não recusado
  const cortado = await criar({ nome: longo(300000), formato: 'pontos', nomes });
  assert.equal(cortado.status, 201, cortado.texto);
  assert.equal(cortado.json.campeonato.nome.length, 60);
  await app.pedir('DELETE', `/api/equipas/${m.A.slug}/campeonatos/${cortado.json.campeonato.id}`, { token: m.tok.admA });

  // o certo: nome de membro comprido é cortado em 40 (como sempre), foto de fora vira "sem foto", a nossa fica
  const fotoNossa = urlCrua('avatars', `public/${m.p.memA.id}-9.jpg`);
  const ok = await criar({ nome: 'Copa', formato: 'pontos', nomes, plantel: [[
    { user_id: m.p.memA.id, nome: longo(70), avatar_url: 'https://fora.test/pixel.png' },
    { nome: 'Zeca', convidado: true, avatar_url: fotoNossa },
  ]] });
  assert.equal(ok.status, 201, ok.texto);
  // (a resposta passa pelo proxy de mídia e vem com o endereço reescrito; o que o motor guardou está no documento do Storage)
  const guardadoNoStorage = JSON.parse([...app.storage.buckets.get('campeonatos').arquivos.values()][0].corpo.toString('utf8'));
  const [a, b] = guardadoNoStorage.times[0].jogadores;
  assert.equal(a.nome.length, 40);
  assert.equal(a.avatar_url, null);
  assert.equal(b.avatar_url, fotoNossa);

  // o placar
  const camp = ok.json.campeonato;
  const rota = `/api/equipas/${m.A.slug}/campeonatos/${camp.id}/confrontos/${camp.confrontos[0].id}/resultado`;
  for (const [nome, corpo] of [['999', { placar_a: 999, placar_b: 0 }], ['negativo', { placar_a: -1, placar_b: 0 }], ['decimal', { placar_a: 2.5, placar_b: 0 }], ['texto', { placar_a: 'abc', placar_b: 0 }], ['sem placar', {}], ['100', { placar_a: 0, placar_b: 100 }]]) {
    const r = await app.pedir('POST', rota, { token: m.tok.admA, corpo });
    assert.equal(r.status, 400, `${nome} · ${r.texto}`);
    assert.match(r.json.error, /Placar inválido/);
  }
  const doc = JSON.parse(app.storage.buckets.get('campeonatos').arquivos.get(`t/${m.A.id}/${camp.id}.json`).corpo.toString('utf8'));
  assert.ok(doc.confrontos.every((c) => !c.jogado), 'nenhum placar ruim foi gravado');
  assert.equal((await app.pedir('POST', rota, { token: m.tok.admA, corpo: { placar_a: '3', placar_b: 99 } })).status, 200, 'texto de dígitos e o limite de 99 passam');
});

test('campeonato pelo sorteio: game_id de lixo é 404 e o nome tem o mesmo teto', async () => {
  const m = criarMundo(app);
  const rota = `/api/equipas/${m.A.slug}/campeonatos/de-sorteio`;
  for (const game_id of ['../x', 'não é id', { a: 1 }, 123]) {
    const r = await app.pedir('POST', rota, { token: m.tok.admA, corpo: { game_id, formato: 'pontos' } });
    assert.ok([400, 404].includes(r.status), `${JSON.stringify(game_id)} · ${r.status} ${r.texto}`);
  }
  const grande = await app.pedir('POST', rota, { token: m.tok.admA, corpo: { game_id: m.ids.jogoPassadoA, formato: 'pontos', nome: longo(300000) } });
  assert.equal(grande.status, 201, grande.texto);
  assert.equal(grande.json.campeonato.nome.length, 60, 'o nome sempre foi cortado em 60');
  const objeto = await app.pedir('POST', rota, { token: m.tok.admA, corpo: { game_id: m.ids.jogoPassadoA, formato: 'pontos', nome: { a: 1 } } });
  assert.equal(objeto.status, 400, objeto.texto);
});

// ─── Time novo ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('time novo: nome de 1 a 60 letras e texto de verdade (objeto, número e vazio são 400); o nome de 300 mil letras não vai ao banco', async () => {
  const m = criarMundo(app);
  const antes = app.tabelas.teams.length;
  for (const nome of [longo(61), longo(300000), { a: 1 }, ['a'], 12345, '   ', '']) {
    const r = await app.pedir('POST', '/api/teams', { token: m.tok.fora, corpo: { nome } });
    assert.equal(r.status, 400, `${JSON.stringify(nome).slice(0, 40)} · ${r.status} ${r.texto.slice(0, 120)}`);
  }
  assert.equal(app.tabelas.teams.length, antes, 'nenhum time foi criado');
  const r = await app.pedir('POST', '/api/teams', { token: m.tok.fora, corpo: { nome: longo(60) } });
  assert.equal(r.status, 201, r.texto);
  assert.equal(r.json.team.nome.length, 60);
});

// ─── PATCH /api/me: o avatar nunca vem do corpo ──────────────────────────────────────────────────────────────────────────────────

test('o avatar não vem do corpo do perfil: um endereço de "figurinha" não destranca os fundos pagos, e limpar continua valendo', async () => {
  const m = criarMundo(app);
  const falsa = urlCrua('avatars', 'public/x-ai-dark-gold-1.png'); // o NOME parece o de uma figurinha nossa (public/<id>-ai-<kit>-<carimbo>)
  const r = await app.pedir('PATCH', '/api/me', { token: m.tok.memA, corpo: { nome: 'Alice', avatar_url: falsa } });
  assert.equal(r.status, 200, r.texto);
  const eu = () => app.tabelas.users.find((u) => u.id === m.p.memA.id);
  assert.ok(!eu().avatar_url, 'o avatar_url do corpo foi ignorado');
  const fundo = await app.pedir('PATCH', '/api/me', { token: m.tok.memA, corpo: { fundo_figurinha: 'aura' } });
  assert.equal(fundo.status, 403, 'sem figurinha de verdade, o fundo pago continua trancado');
  assert.equal(fundo.json.code, 'SEM_BRILHANTE');
  // limpar o avatar vale
  eu().avatar_url = urlCrua('avatars', `public/${m.p.memA.id}-5.jpg`);
  assert.equal((await app.pedir('PATCH', '/api/me', { token: m.tok.memA, corpo: { avatar_url: null } })).status, 200);
  assert.equal(eu().avatar_url, null);
});

test('apagar a conta não apaga o arquivo de outra pessoa, mesmo que a conta tenha tentado apontar o avatar para ele', async () => {
  const m = criarMundo(app);
  const dela = `public/${m.p.memA.id}-ai-dark-gold-111.png`;
  gravarNoStorage('avatars', dela, 'foto-da-alice');
  // o endereço da foto da Alice, como qualquer colega de time o vê no proxy: a forma crua e a do proxy assinado
  const { assinarToken } = require('../utils/mediaToken');
  for (const forma of [urlCrua('avatars', dela), `https://${new URL(app.base).host}/api/media/${assinarToken('avatars', dela)}`]) {
    await app.pedir('PATCH', '/api/me', { token: m.tok.lixo, corpo: { avatar_url: forma } });
    assert.ok(!app.tabelas.users.find((u) => u.id === m.p.lixo.id).avatar_url, 'o endereço não ficou na conta');
  }
  const apagou = await app.pedir('DELETE', '/api/me', { token: m.tok.lixo, corpo: { confirmacao: 'EXCLUIR' } });
  assert.ok(apagou.status < 500, apagou.texto);
  assert.ok(arquivoNoStorage('avatars', dela), 'a foto da Alice continua no Storage');
});

// ─── Resenha: mídia só do próprio autor ──────────────────────────────────────────────────────────────────────────────────────────

test('a mídia de um post é do próprio autor, do bucket da Resenha: foto de outra pessoa, de outro bucket e de fora são 400 — e apagar o post não apaga a foto alheia', async () => {
  const m = criarMundo(app, { postadorEmA: true });
  const { assinarToken } = require('../utils/mediaToken');
  const hospedeDoProxy = `https://${new URL(app.base).host}`; // o proxy é do host do próprio motor
  const arquivoDaAlice = `${m.p.memA.id}-aaaa.webp`;
  gravarNoStorage('resenha', arquivoDaAlice, 'foto-da-alice', 'image/webp');
  gravarNoStorage('resenha', `${m.p.admA.id}-meu.webp`, 'foto-da-ana', 'image/webp');
  gravarNoStorage('avatars', 'public/alheia.png', 'avatar');
  const postar = (url, quem = 'admA') => app.pedir('POST', '/api/feed/posts', {
    token: m.tok[quem], corpo: { team_id: m.A.id, body: 'oi', media: [{ url, media_type: 'image' }] },
  });
  const ruins = {
    'foto da Alice (crua)': urlCrua('resenha', arquivoDaAlice),
    'foto da Alice (pelo proxy assinado, que qualquer colega vê no feed)': `${hospedeDoProxy}/api/media/${assinarToken('resenha', arquivoDaAlice)}`,
    'outro bucket (avatars)': urlCrua('avatars', 'public/alheia.png'),
    'avatar pelo proxy': `${hospedeDoProxy}/api/media/${assinarToken('avatars', 'public/alheia.png')}`,
    'token forjado': `${hospedeDoProxy}/api/media/eyJiIjoicmVzZW5oYSIsInAiOiJ4In0.assinatura-falsa`,
    'host de fora': 'https://fora.test/storage/v1/object/public/resenha/' + `${m.p.admA.id}-meu.webp`,
    'http puro': urlCrua('resenha', `${m.p.admA.id}-meu.webp`).replace('https:', 'http:'),
    'javascript:': 'javascript:alert(1)',
    'caminho com subpasta': urlCrua('resenha', `x/${m.p.admA.id}-meu.webp`),
    'prefixo parecido': urlCrua('resenha', `${m.p.admA.id.slice(0, 20)}-meu.webp`),
  };
  for (const [nome, url] of Object.entries(ruins)) {
    const r = await postar(url);
    assert.equal(r.status, 400, `${nome} · ${r.status} ${r.texto}`);
  }
  assert.equal(app.tabelas.feed_post_media?.length ?? 0, 0, 'nenhuma mídia ruim foi gravada');
  // a do próprio autor: crua e pelo proxy assinado
  const crua = await postar(urlCrua('resenha', `${m.p.admA.id}-meu.webp`));
  assert.equal(crua.status, 201, crua.texto);
  const proxy = await postar(`${hospedeDoProxy}/api/media/${assinarToken('resenha', `${m.p.admA.id}-meu.webp`)}?w=512`);
  assert.equal(proxy.status, 201, proxy.texto);
  // apagar o post dela não mexe na foto da Alice (que ela nunca conseguiu anexar)
  for (const p of app.tabelas.feed_posts.filter((x) => x.author_id === m.p.admA.id)) {
    assert.equal((await app.pedir('DELETE', `/api/feed/posts/${p.id}`, { token: m.tok.admA })).status, 200);
  }
  assert.ok(arquivoNoStorage('resenha', arquivoDaAlice), 'a foto da Alice continua no Storage');
});

test('upload da Resenha: o arquivo leva o id de quem subiu, o nome nunca vem do cliente e só imagem de verdade entra', async () => {
  const m = criarMundo(app);
  const subir = (form) => app.pedir('POST', '/api/feed/upload', { token: m.tok.memA, form });
  const ok = await subir(formularioComArquivo('file', await png(), 'image/png', '../../etc/passwd.png'));
  assert.equal(ok.status, 201, ok.texto);
  const chaves = [...app.storage.buckets.get('resenha').arquivos.keys()];
  assert.equal(chaves.length, 1);
  assert.match(chaves[0], new RegExp(`^${m.p.memA.id}-[0-9a-f-]{36}\\.webp$`), 'o nome é <id de quem subiu>-<uuid>.webp, sem o nome do cliente');
  assert.ok(!chaves[0].includes('..') && !chaves[0].includes('etc'));
  // o que não é imagem de verdade
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>';
  for (const [nome, corpo, tipo] of [['SVG com script como image/png', svg, 'image/png'], ['SVG como image/jpeg', svg, 'image/jpeg'], ['HTML como image/png', '<html><script>alert(1)</script></html>', 'image/png'], ['arquivo vazio', '', 'image/png'], ['texto como image/gif', 'GIF89a nada', 'image/gif']]) {
    const r = await subir(formularioComArquivo('file', Buffer.from(corpo), tipo));
    assert.equal(r.status, 400, `${nome} · ${r.status} ${r.texto}`);
  }
  const outroCampo = await subir(formularioComArquivo('outro', await png(), 'image/png'));
  assert.equal(outroCampo.status, 400, outroCampo.texto);
  const grande = await subir(formularioComArquivo('file', Buffer.alloc(13 * 1024 * 1024, 1), 'image/png'));
  assert.equal(grande.status, 413, grande.texto);
  assert.equal([...app.storage.buckets.get('resenha').arquivos.keys()].length, 1, 'só a imagem de verdade ficou');
});

test('upload da Resenha: 60 por hora por pessoa — o 61º é 429, e a conta ao lado não é afetada', async () => {
  const m = criarMundo(app);
  const pequena = await png(16, 16);
  const enviar = (quem) => app.pedir('POST', '/api/feed/upload', { token: m.tok[quem], form: formularioComArquivo('file', pequena, 'image/png') });
  let ultimo;
  for (let i = 0; i < 60; i += 1) {
    ultimo = await enviar('memA');
    if (ultimo.status !== 201) break;
  }
  assert.equal(ultimo.status, 201, `o 60º devia passar: ${ultimo.status} ${ultimo.texto}`);
  const estourou = await enviar('memA');
  assert.equal(estourou.status, 429, estourou.texto);
  assert.match(estourou.json.error, /Muitas fotos enviadas/);
  assert.equal((await enviar('admA')).status, 201, 'o balde é por pessoa');
});

test('logo do time: quem não é admin leva 403 ANTES de a imagem ser lida; SVG disfarçado é 400; o certo vai para o bucket privado', async () => {
  const m = criarMundo(app);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
  const enviar = (quem, buffer, tipo, slug = m.A.slug) => app.pedir('POST', `/api/teams/${slug}/logo`, { token: m.tok[quem], form: formularioComArquivo('logo', buffer, tipo, 'logo.png') });
  // quem não é admin: 403 mesmo mandando um SVG (que, se a imagem fosse lida antes, daria 400)
  for (const quem of ['memA', 'fora', 'memB', 'admB']) {
    const r = await enviar(quem, svg, 'image/png');
    assert.equal(r.status, 403, `${quem} · ${r.status} ${r.texto}`);
  }
  assert.equal((await enviar('admA', svg, 'image/png')).status, 400, 'SVG disfarçado de PNG');
  assert.equal((await enviar('admA', Buffer.from('<html></html>'), 'image/jpeg')).status, 400);
  assert.equal((await enviar('admA', Buffer.from('not an image at all'), 'image/png')).status, 400);
  assert.equal((await enviar('admA', await png(64, 64), 'image/gif')).status, 400, 'gif não é formato de logo');
  const ok = await enviar('admA', await png(64, 64), 'image/png');
  assert.equal(ok.status, 200, ok.texto);
  assert.ok(arquivoNoStorage('avatars', `logos/${m.A.id}.png`), 'o logo vai para o bucket avatars (privado)');
  assert.equal(app.storage.buckets.get('avatars').public, false);
  assert.equal((await enviar('admA', await png(64, 64), 'image/png', 'time-que-nao-existe')).status, 404);
});

test('foto de perfil: SVG disfarçado e arquivo que não decodifica são 400; nada vai para o bucket', async () => {
  const m = criarMundo(app);
  const enviar = (buffer, tipo, campo = 'avatar') => app.pedir('POST', '/api/me/avatar', { token: m.tok.memA, form: formularioComArquivo(campo, buffer, tipo, 'foto.png') });
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const antes = [...app.storage.buckets.get('avatars').arquivos.keys()].length;
  for (const [nome, buffer, tipo] of [['SVG como PNG', svg, 'image/png'], ['HTML como JPEG', Buffer.from('<html>x</html>'), 'image/jpeg'], ['texto como PNG', Buffer.from('nada'), 'image/png'], ['vazio', Buffer.alloc(0), 'image/png'], ['tipo fora da lista', svg, 'image/svg+xml']]) {
    const r = await enviar(buffer, tipo);
    assert.ok([400, 415].includes(r.status), `${nome} · ${r.status} ${r.texto.slice(0, 120)}`);
  }
  assert.equal((await enviar(await png(64, 64), 'image/png', 'outro-campo')).status, 400);
  assert.equal([...app.storage.buckets.get('avatars').arquivos.keys()].length, antes, 'nada foi guardado');
});

test('comentário: o texto precisa ser texto e o anexo tem as mesmas regras da mídia do post', async () => {
  const m = criarMundo(app);
  const comentar = (corpo, quem = 'memA') => app.pedir('POST', '/api/feed/comentarios', { token: m.tok[quem], corpo: { parent_type: 'post', parent_id: m.ids.postA, ...corpo } });
  assert.equal((await comentar({ body: { a: 1 } })).status, 400);
  assert.equal((await comentar({ body: ['a'] })).status, 400);
  assert.equal((await comentar({ body: longo(501) })).status, 400);
  const pixel = await comentar({ body: 'oi', anexos: [{ url: 'https://fora.test/pixel.gif', media_type: 'gif' }] });
  assert.equal(pixel.status, 400, 'a imagem de um endereço de fora virava <img> para o time inteiro (pixel de rastreio)');
  const alheia = await comentar({ body: 'oi', anexos: [{ url: urlCrua('resenha', `${m.p.admA.id}-x.webp`), media_type: 'image' }] });
  assert.equal(alheia.status, 400, 'foto de outra pessoa');
  const propria = await comentar({ body: 'oi', anexos: [{ url: urlCrua('resenha', `${m.p.memA.id}-x.webp`), media_type: 'image' }] });
  assert.equal(propria.status, 201, propria.texto);
  assert.equal((await comentar({ body: 'só texto' })).status, 201);
  // quem é de fora continua levando 403, antes de qualquer outra conversa
  assert.equal((await comentar({ body: 'oi', anexos: [{ url: 'https://fora.test/x.gif' }] }, 'fora')).status, 403);
});

test('post: o texto precisa ser texto e o team_id precisa ser um id', async () => {
  const m = criarMundo(app, { postadorEmA: true });
  const postar = (corpo) => app.pedir('POST', '/api/feed/posts', { token: m.tok.admA, corpo });
  assert.equal((await postar({ team_id: m.A.id, body: { a: 1 } })).status, 400);
  assert.equal((await postar({ team_id: '../x', body: 'oi' })).status, 400);
  assert.equal((await postar({ team_id: { a: 1 }, body: 'oi' })).status, 400);
  assert.equal((await postar({ team_id: m.A.id, body: longo(2001) })).status, 400);
  assert.equal((await postar({ team_id: m.A.id, body: longo(2000) })).status, 201);
});

// ─── Denúncias ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('denúncia: o comentário de um JOGO de outro time não se denuncia de fora; a descrição precisa ser texto; o id da URL não sai da pasta', async () => {
  const m = criarMundo(app);
  const idDoComentario = '0c0c0c0c-0000-4000-8000-000000000001';
  app.tabelas.comentarios.push({ id: idDoComentario, parent_type: 'game', parent_id: m.ids.jogoPassadoA, author_id: m.p.memA.id, body: 'Joguei mal', created_at: iso(-HORA), deleted_at: null });
  const denunciar = (quem, extra = {}) => app.pedir('POST', '/api/denuncias', { token: m.tok[quem], corpo: { target_type: 'comentario', target_id: idDoComentario, categoria: 'spam', ...extra } });
  for (const quem of ['fora', 'memB', 'admB']) {
    const antes = fotografiaDe(app);
    const r = await denunciar(quem);
    assert.equal(r.status, 403, `${quem} denunciou o comentário de um jogo de outro time · ${r.texto}`);
    assert.equal(fotografiaDe(app), antes, `${quem} · nada gravado (nem cota, nem caso)`);
  }
  assert.equal((await denunciar('memA2')).status, 200, 'quem é do time denuncia');
  assert.equal((await denunciar('memA2', { descricao: 12345 })).status, 400);
  assert.equal((await denunciar('memA2', { descricao: { a: 1 } })).status, 400);
  assert.equal((await denunciar('memA2', { target_id: '../x' })).status, 404);
  // decidir: o id da URL é um uuid
  const antes = app.storage.operacoes.length;
  const traversal = await app.pedir('POST', `/api/denuncias/${encodeURIComponent(`../${m.B.id}/x`)}/decidir`, { token: m.tok.admA, corpo: { slug: m.A.slug, acao: 'remover' } });
  assert.equal(traversal.status, 404, traversal.texto);
  assert.ok(!app.storage.operacoes.slice(antes).some((o) => o.caminho.includes('..')), 'nenhum caminho com ../ chegou ao Storage');
});

// ─── Medição de anúncios ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('anúncios: só campanha que existe é contada — ids inventados não enchem o arquivo de métricas', async () => {
  const m = criarMundo(app);
  const gabineteStore = require('../utils/gabineteStore');
  const adsStore = require('../utils/adsStore');
  gravarNoStorage('denuncias', '_gabinete/operacao.json', JSON.stringify({ campanhas: [{ id: 'camp-real', nome: 'Real', estado: 'ativa' }] }), 'application/json');
  gabineteStore.invalidar();
  const inventados = Array.from({ length: 40 }, (_, i) => ({ id: `inventado-${i}`, tipo: 'imp' }));
  const um = await app.pedir('POST', '/api/ads/evento', { corpo: { id: 'inventado-x', tipo: 'imp' } });
  assert.equal(um.status, 200, 'a resposta é a mesma de sempre (a rota não serve para descobrir campanhas)');
  assert.equal((await app.pedir('POST', '/api/ads/evento', { corpo: { id: longo(300000), tipo: 'cli' } })).status, 200);
  assert.equal((await app.pedir('POST', '/api/ads/evento', { corpo: { id: { a: 1 }, tipo: 'imp' } })).status, 200);
  const lote = await app.pedir('POST', '/api/ads/eventos', { corpo: { eventos: [...inventados, { id: 'camp-real', tipo: 'imp' }, { id: 'camp-real', tipo: 'cli' }] } });
  assert.equal(lote.status, 200, lote.texto);
  await app.pedir('POST', '/api/ads/evento', { corpo: { id: 'camp-real', tipo: 'imp' } });
  await adsStore.descarregar();
  const metricas = JSON.parse(app.storage.buckets.get('denuncias').arquivos.get('_gabinete/ads-metrics.json').corpo.toString('utf8'));
  assert.deepEqual(Object.keys(metricas), ['camp-real'], 'só a campanha real entrou na métrica');
  const dia = Object.values(metricas['camp-real'].dias)[0];
  assert.deepEqual(dia, { imp: 2, cli: 1 });
  void m;
});

// ─── Bloqueios e push ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('bloquear alguém: o id precisa ser um id; subscrição de push: tamanhos de verdade e só serviço conhecido', async () => {
  const m = criarMundo(app);
  for (const id of [longo(5000), '../x', 'abc', { a: 1 }, 123]) {
    const r = await app.pedir('POST', '/api/blocks', { token: m.tok.memA, corpo: { blocked_id: id } });
    assert.equal(r.status, 400, `${JSON.stringify(id).slice(0, 30)} · ${r.texto.slice(0, 100)}`);
  }
  assert.equal((await app.pedir('DELETE', `/api/blocks/${encodeURIComponent('../x')}`, { token: m.tok.memA })).status, 400);
  assert.equal((await app.pedir('POST', '/api/blocks', { token: m.tok.memA, corpo: { blocked_id: m.p.memA2.id } })).status, 200);
  const sub = (extra = {}) => app.pedir('POST', '/api/push/subscribe', { token: m.tok.memA, corpo: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p'.repeat(88), auth: 'a'.repeat(22) }, ...extra } });
  assert.equal((await sub()).status, 200);
  assert.equal((await sub({ keys: { p256dh: longo(300), auth: 'a' } })).status, 400);
  assert.equal((await sub({ keys: { p256dh: 'p', auth: longo(300) } })).status, 400);
  assert.equal((await sub({ keys: { p256dh: { a: 1 }, auth: 'a' } })).status, 400);
  assert.equal((await sub({ endpoint: `https://fcm.googleapis.com/${longo(2000)}` })).status, 400);
  assert.equal((await sub({ endpoint: 'https://fora.test/push' })).status, 400, 'só serviço de push conhecido');
  assert.equal((await app.pedir('DELETE', '/api/push/subscribe', { token: m.tok.memA, corpo: { endpoint: { a: 1 } } })).status, 400);
  assert.ok(app.tabelas.push_subscriptions.every((s) => s.p256dh.length <= 200));
});

// ─── Notas ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('voto: a nota é de 0,5 a 5 em passos de 0,5 — negativo, zero, 6, decimal torto e texto são 400; só em quem é do time; nunca em si mesmo', async () => {
  const m = criarMundo(app);
  const votar = (corpo, quem = 'memA') => app.pedir('POST', `/api/teams/${m.A.slug}/votar`, { token: m.tok[quem], corpo });
  for (const nota of [-1, 0, 5.5, 6, 0.3, 'abc', null, 1e308, 999]) assert.equal((await votar({ para_user_id: m.p.memA2.id, nota })).status, 400, `nota ${nota}`);
  assert.equal((await votar({ para_user_id: m.p.memA.id, nota: 4 })).status, 400, 'em si mesmo');
  assert.equal((await votar({ para_user_id: m.p.memB.id, nota: 4 })).status, 400, 'em quem é de outro time');
  assert.equal((await votar({ para_user_id: m.p.memA2.id, nota: 0.5 })).status, 200);
  assert.equal((await votar({ para_user_id: m.p.memA2.id, nota: 5 })).status, 200);
  assert.equal(app.tabelas.votes.length, 1, 'o voto novo atualiza o antigo (um por votante/votado/time)');
});

test('capacidade, prazo e recorrentes: números absurdos são 400', async () => {
  const m = criarMundo(app);
  const cap = (max_jogadores) => app.pedir('PATCH', `/api/games/${m.ids.jogoAbertoA}/capacidade`, { token: m.tok.admA, corpo: { max_jogadores } });
  for (const v of [-1, 0.5, 'abc', { a: 1 }, [1]]) assert.equal((await cap(v)).status, 400, JSON.stringify(v));
  assert.equal((await cap(12)).status, 200);
  const prazo = (p) => app.pedir('POST', `/api/jogos/${m.ids.jogoAbertoA}/rsvp/abrir`, { token: m.tok.admA, corpo: { prazo: p } });
  for (const p of ['ontem', iso(-HORA), { a: 1 }, null]) assert.equal((await prazo(p)).status, 400, JSON.stringify(p));
  const rec = (corpo) => app.pedir('POST', `/api/teams/${m.A.slug}/jogos/recorrentes`, { token: m.tok.admA, corpo });
  for (const corpo of [{ dia_semana: 7, hora: '20:00', semanas: 4 }, { dia_semana: -1, hora: '20:00', semanas: 4 }, { dia_semana: 1, hora: '25:00', semanas: 4 }, { dia_semana: 1, hora: '20:00', semanas: 1000 }, { dia_semana: 1, hora: { a: 1 }, semanas: 4 }]) {
    assert.equal((await rec(corpo)).status, 400, JSON.stringify(corpo));
  }
});

// ─── O filtro .or() do Explorar ──────────────────────────────────────────────────────────────────────────────────────────────────

/** As condições de um filtro .or() do PostgREST, do jeito que ele as lê: vírgula só separa fora de aspas e fora de parênteses; dentro das aspas, \ escapa. */
function condicoesDoFiltro(expressao) {
  const condicoes = [];
  let atual = '';
  let aspas = false;
  let fundo = 0;
  for (let i = 0; i < expressao.length; i += 1) {
    const c = expressao[i];
    if (aspas && c === '\\') { atual += c + (expressao[i + 1] ?? ''); i += 1; continue; }
    if (c === '"') aspas = !aspas;
    else if (!aspas && c === '(') fundo += 1;
    else if (!aspas && c === ')') fundo -= 1;
    if (c === ',' && !aspas && fundo === 0) { condicoes.push(atual); atual = ''; continue; }
    atual += c;
  }
  condicoes.push(atual);
  return condicoes;
}

test('Explorar: o texto da busca fica dentro das aspas — a barra invertida com aspas não fecha o valor e não injeta condição nova no filtro', async () => {
  const m = criarMundo(app);
  const vistos = [];
  const original = app.cliente.from;
  app.cliente.from = (tabela) => {
    const construtor = original(tabela);
    if (tabela === 'teams') construtor.or = (expressao) => { vistos.push(expressao); return construtor; };
    return construtor;
  };
  try {
    for (const q of ['x\\",id.not.is.null,y', 'a\\', '\\"', 'a",id.not.is.null,"b', 'brasil,nome.eq.x', '(a)', 'a.b,c.d', 'normal']) {
      vistos.length = 0;
      await app.pedir('GET', `/api/teams/explorar?q=${encodeURIComponent(q)}`, { token: m.tok.memA });
      assert.equal(vistos.length, 1, `q=${q}`);
      const condicoes = condicoesDoFiltro(vistos[0]);
      assert.ok(condicoes.length >= 2 && condicoes.length <= 3, `q=${q} virou ${condicoes.length} condições: ${vistos[0]}`);
      assert.match(condicoes[0], /^nome\.ilike\./);
      assert.match(condicoes[1], /^localizacao\.ilike\./);
      if (condicoes[2]) assert.match(condicoes[2], /^and\(cidade_normalizada\.eq\./);
    }
  } finally {
    app.cliente.from = original;
  }
});

// ─── O webhook de compras (RevenueCat) ───────────────────────────────────────────────────────────────────────────────────────────

test('webhook do RevenueCat: sem o segredo nada passa; com ele, o crédito entra uma vez só', async () => {
  const m = criarMundo(app);
  const evento = (extra = {}) => ({ event: { id: 'ev-1', type: 'INITIAL_PURCHASE', store: 'APP_STORE', environment: 'PRODUCTION', product_id: 'futty_minha', transaction_id: 'T-100', original_transaction_id: 'T-100', app_user_id: m.p.memA.id, currency: 'BRL', price: 9.9, ...extra } });
  const webhook = (cabecalhos, corpo) => app.pedir('POST', '/api/compras/webhook/revenuecat', { cabecalhos, corpo });
  const creditos = () => app.tabelas.users.find((u) => u.id === m.p.memA.id).brilhante_creditos ?? 0;

  for (const [nome, cab] of [['sem cabeçalho', {}], ['segredo errado', { authorization: 'Bearer errado' }], ['segredo vazio', { authorization: 'Bearer ' }], ['só o prefixo', { authorization: 'Bearer' }], ['outro esquema', { authorization: 'Basic ' + Buffer.from('x:y').toString('base64') }]]) {
    const r = await webhook(cab, evento());
    assert.equal(r.status, 401, `${nome} · ${r.texto}`);
  }
  assert.equal((await app.pedir('POST', `/api/compras/webhook/revenuecat?authorization=${SEGREDO_DO_WEBHOOK}`, { corpo: evento() })).status, 401, 'o segredo na query não vale');
  assert.equal(creditos(), 0, 'nada foi creditado sem o segredo');
  assert.equal(app.tabelas.compras?.length ?? 0, 0);

  const autorizado = { authorization: `Bearer ${SEGREDO_DO_WEBHOOK}` };
  assert.equal((await webhook(autorizado, { event: null })).status, 400);
  assert.equal((await webhook(autorizado, { sem: 'evento' })).status, 400);
  assert.equal((await webhook(autorizado, { event: { type: 'TEST' } })).json.teste, true);
  const tipoDeAssinatura = await webhook(autorizado, evento({ type: 'RENEWAL', transaction_id: 'T-200' }));
  assert.equal(tipoDeAssinatura.json.estado, 'ignorada', 'o que não vendemos fica registrado como ignorado, nunca como crédito');
  assert.equal(creditos(), 0);

  const primeira = await webhook(autorizado, evento());
  assert.equal(primeira.status, 200, primeira.texto);
  assert.equal(primeira.json.estado, 'creditada');
  const depoisDaPrimeira = creditos();
  assert.ok(depoisDaPrimeira > 0, 'a Minha Figurinha deu gerações');
  const repetida = await webhook(autorizado, evento());
  assert.equal(repetida.json.estado, 'repetida', 'o RevenueCat reenvia: o índice (loja, transação) segura o crédito em dobro');
  assert.equal(creditos(), depoisDaPrimeira, 'o crédito não dobrou');

  // quem não é usuário nosso não ganha nada e o dinheiro fica registrado
  const desconhecido = await webhook(autorizado, evento({ transaction_id: 'T-300', app_user_id: '99999999-9999-4999-8999-999999999999' }));
  assert.equal(desconhecido.json.estado, 'ignorada');
  // o corpo hostil no próprio webhook (com segredo): nunca 5xx com detalhe
  for (const hostil of [evento({ app_user_id: { a: 1 } }), evento({ product_id: longo(100000) }), evento({ product_id: '__proto__', transaction_id: 'T-400' }), evento({ store: 'constructor', transaction_id: 'T-401' }), evento({ transaction_id: { a: 1 } }), evento({ price: 'abc', currency: { a: 1 } }), evento({ aliases: 'não é lista' })]) {
    const r = await webhook(autorizado, hostil);
    assert.ok(r.status < 500 || (r.status === 500 && r.json.error), `webhook hostil · ${r.status} ${r.texto.slice(0, 120)}`);
    assert.doesNotMatch(r.texto, /supabase|postgres|stack|violates/i);
  }
  assert.equal(creditos(), depoisDaPrimeira, 'nenhum evento hostil creditou nada');
});

// ─── A geração da figurinha só com direito ───────────────────────────────────────────────────────────────────────────────────

test('gerar a figurinha: sem direito (crédito ou pacote do time) é 403 SEM_DIREITO e nada é gasto — nem a origem "cadastro" abre a porta; sem rede para a fal', async () => {
  const m = criarMundo(app);
  const eu = app.tabelas.users.find((u) => u.id === m.p.memA.id);
  eu.foto_url = urlCrua('avatars', `public/${m.p.memA.id}-1.jpg`);
  eu.foto_hash = 'abc';
  gravarNoStorage('avatars', `public/${m.p.memA.id}-1.jpg`, 'foto');
  for (const corpo of [{}, { origem: 'cadastro' }, { kit: 'dark-gold', assincrono: true }, { kit: 'qualquer-outro' }]) {
    const antes = fotografiaDe(app);
    const r = await app.pedir('POST', '/api/me/avatar/ai', { token: m.tok.memA, corpo });
    assert.ok([400, 403].includes(r.status), `${JSON.stringify(corpo)} · ${r.status} ${r.texto}`);
    if (r.status === 403) assert.equal(r.json.code, 'SEM_DIREITO');
    assert.equal(fotografiaDe(app), antes, `${JSON.stringify(corpo)} · nada foi gasto nem gravado`);
  }
  const semFoto = await app.pedir('POST', '/api/me/avatar/ai', { token: m.tok.memB, corpo: {} });
  assert.equal(semFoto.status, 400);
  assert.ok(!app.tentativasDeRede.some((t) => /fal\.|queue\.fal|fal\.run/.test(t)), 'nenhuma chamada à fal');
  assert.equal(app.tabelas.geracao_ia_log?.length ?? 0, 0);
  assert.equal(app.tabelas.gasto_ia_diario?.length ?? 0, 0);
});

test('a pintura interna (Cloud Tasks) não abre sem o segredo nem sem o token do Google', async () => {
  const m = criarMundo(app);
  const id = '0a0a0a0a-0000-4000-8000-000000000001';
  for (const cab of [{}, { 'x-futty-interno': 'errado' }, { 'x-futty-interno': SEGREDO_DO_WEBHOOK }]) {
    const r = await app.pedir('POST', `/api/interno/pintar/${id}`, { cabecalhos: cab, corpo: {} });
    assert.ok([401, 403, 404].includes(r.status), `${JSON.stringify(cab)} · ${r.status} ${r.texto}`);
  }
  assert.equal((await app.pedir('POST', `/api/interno/pintar/${id}`, { token: m.tok.admA, corpo: {} })).status === 200, false, 'estar logado não abre a porta interna');
});

// ─── Convites ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('convite: token de lixo é 404, convite vencido não vale e aceitar duas vezes não duplica o vínculo', async () => {
  const m = criarMundo(app);
  for (const token of [longo(5000), '../x', "' OR 1=1 --", '%00', 'nao-existe']) {
    const r = await app.pedir('GET', `/api/convite/${encodeURIComponent(token)}`, { token: m.tok.fora });
    assert.ok(r.status === 404 || r.status === 400 || (r.status === 200 && r.json.valido === false && r.json.team === null), `${token.slice(0, 20)} · ${r.status} ${r.texto.slice(0, 100)}`);
    const aceitar = await app.pedir('POST', `/api/convite/${encodeURIComponent(token)}/aceitar`, { token: m.tok.fora, corpo: {} });
    assert.ok([400, 404].includes(aceitar.status), `aceitar ${token.slice(0, 20)} · ${aceitar.status} ${aceitar.texto.slice(0, 100)}`);
  }
  assert.ok(!app.tabelas.team_members.some((t) => t.user_id === m.p.fora.id), 'ninguém entrou com token de lixo');
  app.tabelas.convites.find((c) => c.id === m.ids.conviteA).expires_at = iso(-HORA);
  const vencido = await app.pedir('POST', `/api/convite/${m.tokenDoConviteA}/aceitar`, { token: m.tok.fora, corpo: {} });
  assert.ok([400, 404, 410].includes(vencido.status), `vencido · ${vencido.status} ${vencido.texto}`);
  assert.ok(!app.tabelas.team_members.some((t) => t.user_id === m.p.fora.id), 'convite vencido não entra');
  app.tabelas.convites.find((c) => c.id === m.ids.conviteA).expires_at = iso(24 * HORA);
  const um = await app.pedir('POST', `/api/convite/${m.tokenDoConviteA}/aceitar`, { token: m.tok.fora, corpo: {} });
  assert.equal(um.status, 201, um.texto);
  const dois = await app.pedir('POST', `/api/convite/${m.tokenDoConviteA}/aceitar`, { token: m.tok.fora, corpo: {} });
  assert.ok(dois.status < 500, dois.texto);
  assert.equal(app.tabelas.team_members.filter((t) => t.user_id === m.p.fora.id && t.team_id === m.A.id).length, 1, 'um vínculo só');
  assert.equal(app.tabelas.team_members.find((t) => t.user_id === m.p.fora.id).role, 'member', 'entra como membro, nunca como admin');
});

// ─── Cidade e bairro: o texto vai ao geocodificador, que está fora ───────────────────────────────────────────────────────────────

test('cidade e bairro hostis: nunca 5xx, o texto é cortado e a única saída de rede é a consulta ao Nominatim', async () => {
  const m = criarMundo(app);
  for (const cidade of [longo(300000), '<script>alert(1)</script>', "'; DROP TABLE teams;--", { a: 1 }, 'a;cat /etc/passwd;', '../../x']) {
    const r = await app.pedir('POST', '/api/teams', { token: m.tok.fora, corpo: { nome: 'Time da cidade', cidade, bairro: cidade } });
    assert.ok(r.status < 500, `${JSON.stringify(cidade).slice(0, 40)} · ${r.status} ${r.texto.slice(0, 160)}`);
  }
  assert.ok(app.tabelas.teams.every((t) => String(t.cidade || '').length <= 200 && String(t.bairro || '').length <= 200), 'cidade e bairro cortados');
  const inesperadas = app.tentativasDeRede.filter((t) => !/nominatim\.openstreetmap\.org/.test(t));
  assert.deepEqual(inesperadas, []);
});

test('nada disto falou com a rede (fora o Nominatim)', () => {
  const inesperadas = app.tentativasDeRede.filter((t) => !/nominatim\.openstreetmap\.org/.test(t));
  assert.deepEqual(inesperadas, [], `saiu pedido para a rede: ${inesperadas.join(', ')}`);
});
