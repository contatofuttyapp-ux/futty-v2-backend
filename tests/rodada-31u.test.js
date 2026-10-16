// Futty v2.0 — Rodada 31U: o convite à prova de falhas, "Contas sem time", presença só depois do jogo e o cadastro a partir de 13 anos.
//
// (1) Convite pendente: a página do convite (navegador do celular) avisa o motor; quem se cadastra no app, na mesma rede e plataforma, nas
//     2 h seguintes, recebe o convite de volta e entra no time. A rede é o HMAC do IP (IPv6 pelo /64) — o IP nunca vai para o banco.
// (2) Gabinete → "Contas sem time": a lista e o "Pôr no time…", só para o super-admin.
// (3) Presença: confirmar num jogo que ainda não aconteceu não conta no ranking, na vitrine nem nas estatísticas do admin; passa a contar
//     depois do horário do jogo.
// (4) Idade: 13 anos entra, 12 não (o motor apaga a conta em curso e responde 403 MENOR_DE_IDADE).
//
// O motor de verdade (tests/_appFalsa.js) sobre banco falso. Uso: node --test tests/rodada-31u.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { subirApp, usuario } = require('./_appFalsa');
const { uuid } = require('./_mundoDeSeguranca');

let app;
let cp;
before(async () => {
  app = await subirApp();
  cp = require('../utils/convitePendente');
});
after(() => app.fechar());

const HORA = 3600 * 1000;
const DIA = 24 * HORA;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
let rodada = 0;

// ─── (1) A rede ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a rede: IPv4 inteiro; IPv6 pelo /64 (o resto do endereço muda e a rede é a mesma); IPv4 dentro de IPv6 é IPv4; lixo não é rede', () => {
  assert.equal(cp.redeDoIp('189.40.12.7'), 'v4:189.40.12.7');
  assert.equal(cp.redeDoIp('::ffff:189.40.12.7'), 'v4:189.40.12.7');
  assert.equal(cp.redeDoIp('2804:14c:5b91:8a3f:1d2:3e4f:5a6b:7c8d'), 'v6:2804:014c:5b91:8a3f::/64');
  assert.equal(cp.redeDoIp('2804:14c:5b91:8a3f::9'), 'v6:2804:014c:5b91:8a3f::/64');
  assert.equal(cp.hashDaRede('2804:14c:5b91:8a3f:1d2:3e4f:5a6b:7c8d'), cp.hashDaRede('2804:14c:5b91:8a3f:aaaa:bbbb:cccc:dddd'), 'mesmo /64');
  assert.notEqual(cp.hashDaRede('2804:14c:5b91:8a3f::1'), cp.hashDaRede('2804:14c:5b91:8a40::1'), 'outro /64');
  assert.notEqual(cp.hashDaRede('189.40.12.7'), cp.hashDaRede('189.40.12.8'));
  assert.match(cp.hashDaRede('189.40.12.7'), /^[0-9a-f]{64}$/);
  assert.equal(cp.redeDoIp('não é ip'), null);
  assert.equal(cp.redeDoIp(undefined), null);
  assert.equal(cp.plataformaValida('iOS'), 'ios');
  assert.equal(cp.plataformaValida('web'), null);
});

/** Dois times com convite (A e B), a pessoa nova (sem time) e quem convidou. */
function mundoDoConvite() {
  rodada += 1;
  const n = 100 + rodada;
  const p = { dono: usuario(uuid('c1', n), 'Tonhão'), donoB: usuario(uuid('c2', n), 'Beto'), nova: usuario(uuid('c3', n), 'Zeca') };
  const A = { id: uuid('a1', n), slug: `domingueira-${n}`, nome: 'Domingueira FC' };
  const B = { id: uuid('b1', n), slug: `missa-${n}`, nome: 'Missa de Quinta' };
  const convA = { id: uuid('d1', n), token: uuid('e1', n), team_id: A.id, criado_por: p.dono.id, expires_at: iso(10 * DIA) };
  const convB = { id: uuid('d2', n), token: uuid('e2', n), team_id: B.id, criado_por: p.donoB.id, expires_at: iso(10 * DIA) };
  app.reiniciar({
    tabelas: {
      teams: [{ ...A, cor: 'verde', criado_por: p.dono.id }, { ...B, cor: 'azul', criado_por: p.donoB.id }],
      team_members: [{ id: uuid('f1', n), team_id: A.id, user_id: p.dono.id, role: 'admin' }, { id: uuid('f2', n), team_id: B.id, user_id: p.donoB.id, role: 'admin' }],
      convites: [convA, convB],
      convite_codigos: [{ codigo: `k7m2p9${'abcdefgh'[n % 8]}${'jkmnpqrs'[n % 8]}`, convite_id: convA.id }],
      convite_usos: [],
      convites_pendentes: [],
      games: [],
    },
    usuarios: Object.values(p),
  });
  return { p, A, B, convA, convB, codigoA: app.tabelas.convite_codigos[0].codigo };
}

const avisar = (token, plataforma) => app.pedir('POST', `/api/convite/${token}/pendente`, { corpo: { plataforma } });
const perguntar = (m, quem = 'nova', plataforma = 'ios') => app.pedir('GET', `/api/convite-pendente?plataforma=${plataforma}`, { token: app.token(m.p[quem].id) });

test('o site avisa (sem conta, 204), o motor guarda só o hash da rede; o app pergunta na mesma rede e plataforma e recebe o convite; aceitar põe no time', async () => {
  const m = mundoDoConvite();
  const r = await avisar(`domingueira-fc-${m.codigoA}`, 'ios');
  assert.equal(r.status, 204);
  assert.equal(app.tabelas.convites_pendentes.length, 1);
  const linha = app.tabelas.convites_pendentes[0];
  assert.equal(linha.convite_id, m.convA.id);
  assert.equal(linha.plataforma, 'ios');
  assert.match(linha.rede, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(linha).includes('127.0.0.1'), 'o IP não vai para o banco');

  const q = await perguntar(m);
  assert.equal(q.status, 200, q.texto);
  assert.equal(q.json.convites.length, 1);
  const [c] = q.json.convites;
  assert.equal(c.token, m.codigoA, 'o código curto volta (o app aceita com ele)');
  assert.deepEqual({ nome: c.team.nome, slug: c.team.slug }, { nome: 'Domingueira FC', slug: m.A.slug });
  assert.equal(c.convidadoPor, 'Tonhão', 'o apelido de quem convidou, nunca o nome completo');

  const aceite = await app.pedir('POST', `/api/convite/${c.token}/aceitar`, { token: app.token(m.p.nova.id) });
  assert.equal(aceite.status, 201, aceite.texto);
  assert.ok(app.tabelas.team_members.some((x) => x.team_id === m.A.id && x.user_id === m.p.nova.id), 'entrou em team_members');
  const depois = await perguntar(m);
  assert.deepEqual(depois.json.convites, [], 'já é do time: o convite não volta');
});

test('outra plataforma, outra rede, mais de 2 h, convite vencido ou sem plataforma: nada volta', async () => {
  const m = mundoDoConvite();
  await avisar(m.convA.token, 'android');
  assert.deepEqual((await perguntar(m, 'nova', 'ios')).json.convites, [], 'aberto no Android, cadastro no iPhone');
  assert.equal((await perguntar(m, 'nova', 'android')).json.convites.length, 1);

  app.tabelas.convites_pendentes[0].rede = cp.hashDaRede('189.40.12.7');
  assert.deepEqual((await perguntar(m, 'nova', 'android')).json.convites, [], 'outra rede');

  app.tabelas.convites_pendentes.length = 0;
  await avisar(m.convA.token, 'android');
  app.tabelas.convites_pendentes[0].criado_em = iso(-2 * HORA - 60000);
  assert.deepEqual((await perguntar(m, 'nova', 'android')).json.convites, [], 'mais de 2 h');
  assert.equal(app.tabelas.convites_pendentes.length, 0, 'a linha vencida é apagada');

  m.convA.expires_at = iso(-DIA);
  app.tabelas.convites.find((c) => c.id === m.convA.id).expires_at = iso(-DIA);
  await avisar(m.convA.token, 'android');
  assert.equal(app.tabelas.convites_pendentes.length, 0, 'convite vencido não é guardado');

  assert.equal((await avisar(m.convB.token, 'web')).status, 204);
  assert.equal((await avisar('nao-existe', 'ios')).status, 204, 'convite que não existe: 204 do mesmo jeito (não revela nada)');
  assert.equal(app.tabelas.convites_pendentes.length, 0);
  assert.equal((await app.pedir('GET', '/api/convite-pendente?plataforma=ios')).status, 401, 'perguntar exige conta');
});

test('dois times abertos na mesma rede: os dois voltam (o app mostra a escolha), o mais recente primeiro; o mesmo link de novo não duplica', async () => {
  const m = mundoDoConvite();
  await avisar(m.convA.token, 'ios');
  await avisar(m.convA.token, 'ios');
  assert.equal(app.tabelas.convites_pendentes.length, 1, 'o mesmo convite na mesma rede é uma linha só');
  app.tabelas.convites_pendentes[0].criado_em = iso(-10 * 60000);
  await avisar(m.convB.token, 'ios');
  const { convites } = (await perguntar(m)).json;
  assert.deepEqual(convites.map((c) => c.team.nome), ['Missa de Quinta', 'Domingueira FC']);
  assert.equal(convites[1].token, m.codigoA);
  assert.equal(convites[0].token, m.convB.token, 'sem código curto, o token longo');
});

test('a plataforma também vale pelo cabeçalho do app (X-Futty-Plataforma)', async () => {
  const m = mundoDoConvite();
  await avisar(m.convA.token, 'android');
  const r = await app.pedir('GET', '/api/convite-pendente', { token: app.token(m.p.nova.id), cabecalhos: { 'x-futty-plataforma': 'android' } });
  assert.equal(r.json.convites.length, 1);
});

test('sem a migração 084 (tabela ausente) o aviso e a pergunta falham em silêncio: 204 e lista vazia', async () => {
  const m = mundoDoConvite();
  delete app.tabelas.convites_pendentes;
  const falhar = app.cliente.from.bind(app.cliente);
  app.cliente.from = (t) => {
    if (t !== 'convites_pendentes') return falhar(t);
    const erro = { data: null, error: { code: '42P01', message: 'relation "convites_pendentes" does not exist' } };
    const q = new Proxy({}, { get: (_o, k) => (k === 'then' ? (res) => res(erro) : () => q) });
    return q;
  };
  try {
    assert.equal((await avisar(m.convA.token, 'ios')).status, 204);
    const r = await perguntar(m);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.convites, []);
  } finally {
    app.cliente.from = falhar;
  }
});

// ─── (2) Contas sem time ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('Gabinete "Contas sem time": só o super-admin vê; lista quem não tem time; "Pôr no time" grava em team_members; time ou conta inválidos não gravam', async () => {
  rodada += 1;
  const n = 300 + rodada;
  const p = { super: usuario(uuid('s1', n), 'Pedro'), membro: usuario(uuid('s2', n), 'Tonhão'), sozinho: usuario(uuid('s3', n), 'Perdido', { created_at: iso(-HORA) }) };
  const T = { id: uuid('t1', n), slug: `varzea-${n}`, nome: 'Várzea FC' };
  app.reiniciar({
    tabelas: {
      teams: [{ ...T, cor: 'verde', criado_por: p.membro.id }],
      team_members: [{ id: uuid('m1', n), team_id: T.id, user_id: p.membro.id, role: 'admin' }, { id: uuid('m2', n), team_id: T.id, user_id: p.super.id, role: 'member' }],
    },
    usuarios: Object.values(p),
    superAdmins: [p.super.id],
  });
  assert.equal((await app.pedir('GET', '/api/super/contas-sem-time', { token: app.token(p.membro.id) })).status, 403);
  const lista = await app.pedir('GET', '/api/super/contas-sem-time', { token: app.token(p.super.id) });
  assert.equal(lista.status, 200, lista.texto);
  assert.deepEqual(lista.json.contas.map((c) => c.nome_jogador), ['Perdido']);
  assert.ok(lista.json.contas[0].email, 'o e-mail vai junto (é o que o dono reconhece)');
  assert.deepEqual(lista.json.times.map((t) => t.nome), ['Várzea FC']);

  const negado = await app.pedir('POST', `/api/super/contas-sem-time/${p.sozinho.id}/time`, { token: app.token(p.membro.id), corpo: { team_id: T.id } });
  assert.equal(negado.status, 403);
  const r = await app.pedir('POST', `/api/super/contas-sem-time/${p.sozinho.id}/time`, { token: app.token(p.super.id), corpo: { team_id: T.id } });
  assert.equal(r.status, 201, r.texto);
  assert.ok(app.tabelas.team_members.some((x) => x.team_id === T.id && x.user_id === p.sozinho.id && x.role === 'member'));
  assert.deepEqual((await app.pedir('GET', '/api/super/contas-sem-time', { token: app.token(p.super.id) })).json.contas, []);

  const vinculos = app.tabelas.team_members.length;
  const semTime = await app.pedir('POST', `/api/super/contas-sem-time/${p.sozinho.id}/time`, { token: app.token(p.super.id), corpo: {} });
  assert.equal(semTime.status, 400, 'sem time escolhido');
  const timeFantasma = await app.pedir('POST', `/api/super/contas-sem-time/${p.sozinho.id}/time`, { token: app.token(p.super.id), corpo: { team_id: uuid('98', n) } });
  assert.equal(timeFantasma.status, 404, 'time que não existe');
  const contaFantasma = await app.pedir('POST', `/api/super/contas-sem-time/${uuid('99', n)}/time`, { token: app.token(p.super.id), corpo: { team_id: T.id } });
  assert.equal(contaFantasma.status, 404, 'conta que não existe');
  assert.equal(app.tabelas.team_members.length, vinculos, 'nada gravado');
});

// ─── (3) Presença só depois do jogo ──────────────────────────────────────────────────────────────────────────────────────────────

function mundoDaPresenca() {
  rodada += 1;
  const n = 500 + rodada;
  const p = { dono: usuario(uuid('p1', n), 'Dono'), gabriel: usuario(uuid('p2', n), 'Gabriel'), zeca: usuario(uuid('p3', n), 'Zeca') };
  const T = { id: uuid('t2', n), slug: `presenca-${n}`, nome: 'Missa FC' };
  const membro = (k, i, extra = {}) => ({ id: uuid(`g${i}`, n), team_id: T.id, user_id: p[k].id, role: 'member', ativo: true, categoria: 'linha', ...extra });
  const jogo = (i, ms) => ({ id: uuid(`j${i}`, n), team_id: T.id, local: 'Urban Soccer', status: 'agendado', cancelado: false, data: iso(ms), created_at: iso(-20 * DIA) });
  const g = { passado: jogo(1, -7 * DIA), futuro: jogo(2, 6 * DIA), outroFuturo: jogo(3, 13 * DIA) };
  app.reiniciar({
    tabelas: {
      teams: [{ ...T, cor: 'verde', criado_por: p.dono.id, modo_visibilidade: 'privado', fuso: 'America/Sao_Paulo' }],
      team_members: [membro('dono', 1, { role: 'admin', joga: false }), membro('gabriel', 2), membro('zeca', 3)],
      games: Object.values(g),
      // O Gabriel jogou o passado e já confirmou os dois próximos (o caso real da 31T: 22/10 e 29/10 contando antes da hora).
      game_players: [
        { game_id: g.passado.id, user_id: p.gabriel.id, confirmado: true },
        { game_id: g.futuro.id, user_id: p.gabriel.id, confirmado: true },
        { game_id: g.outroFuturo.id, user_id: p.gabriel.id, confirmado: true },
        { game_id: g.futuro.id, user_id: p.zeca.id, confirmado: true },
      ],
      votes: [],
      feed_posts: [],
    },
    usuarios: Object.values(p),
  });
  return { p, T, g };
}

const ler = async (m, quem, rota) => {
  const r = await app.pedir('GET', rota, { token: app.token(m.p[quem].id) });
  assert.equal(r.status, 200, `${rota}: ${r.texto}`);
  return r.json;
};
const presencas = async (m) => Object.fromEntries((await ler(m, 'zeca', `/api/teams/${m.T.slug}/ranking`)).ranking.map((x) => [x.nome_jogador, x.presenca]));

test('presença em jogo futuro não pontua: ranking, vitrine, membros do admin e estatísticas só contam o que já aconteceu', async () => {
  const m = mundoDaPresenca();
  assert.deepEqual(await presencas(m), { Gabriel: 1, Zeca: 0 });
  const ranking = (await ler(m, 'zeca', `/api/teams/${m.T.slug}/ranking`)).ranking;
  assert.equal(ranking[0].nome_jogador, 'Gabriel');

  const v = await ler(m, 'zeca', `/api/teams/${m.T.slug}/jogador/${m.p.gabriel.id}`);
  assert.equal(v.conquistas.jogos_total, 1);
  assert.deepEqual(v.historico.map((h) => h.game_id), [m.g.passado.id], 'jogo futuro não entra no histórico');

  const { membros } = await ler(m, 'dono', `/api/teams/${m.T.slug}/membros`);
  const gabriel = membros.find((x) => x.nome_jogador === 'Gabriel');
  assert.equal(gabriel.presencas, 1);
  assert.deepEqual(gabriel.presencas_recentes.map((x) => x.game_id), [m.g.passado.id], 'as últimas 5 são jogos que já começaram');

  const { stats } = await ler(m, 'dono', `/api/teams/${m.T.slug}/stats`);
  assert.equal(stats.mais_presente?.jogos, 1);
  assert.equal(stats.media_confirmacoes, 1, 'a média é dos jogos que já aconteceram');
  assert.equal(stats.proximo_jogo?.confirmados, 2, 'o próximo jogo continua mostrando quem vai');
});

test('passado o horário do jogo, a presença confirmada passa a pontuar (cancelado nunca)', async () => {
  const m = mundoDaPresenca();
  // O relógio andou: o "futuro" já começou (há 1 minuto); o outro foi cancelado depois de passar a hora.
  app.tabelas.games.find((g) => g.id === m.g.futuro.id).data = iso(-60000);
  Object.assign(app.tabelas.games.find((g) => g.id === m.g.outroFuturo.id), { data: iso(-HORA), cancelado: true, status: 'cancelado' });
  assert.deepEqual(await presencas(m), { Gabriel: 2, Zeca: 1 });
  const v = await ler(m, 'zeca', `/api/teams/${m.T.slug}/jogador/${m.p.zeca.id}`);
  assert.equal(v.conquistas.jogos_total, 1);
});

// ─── (4) Idade: 13 entra, 12 não ─────────────────────────────────────────────────────────────────────────────────────────────────

function aniversarioHoje(anos, dias = 0) {
  const h = new Date();
  let d = new Date(Date.UTC(h.getUTCFullYear() - anos, h.getUTCMonth(), h.getUTCDate()));
  if (d.getUTCMonth() !== h.getUTCMonth()) d = new Date(Date.UTC(h.getUTCFullYear() - anos, h.getUTCMonth() + 1, 0));
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

test('cadastro em curso: 13 anos hoje entra e conclui; 12 anos (faz 13 amanhã) é recusado com 403 MENOR_DE_IDADE e a conta é apagada', async () => {
  rodada += 1;
  const n = 900 + rodada;
  const p = { treze: usuario(uuid('i1', n), 'Treze'), doze: usuario(uuid('i2', n), 'Doze') };
  app.reiniciar({ tabelas: {}, usuarios: Object.values(p) });

  const ok = await app.pedir('PATCH', '/api/me', { token: app.token(p.treze.id), corpo: { birthdate: aniversarioHoje(13) } });
  assert.equal(ok.status, 200, ok.texto);
  const fim = await app.pedir('POST', '/api/me/onboarding-completo', { token: app.token(p.treze.id) });
  assert.equal(fim.status, 200, fim.texto);
  assert.ok(!app.chamadasAdmin.some(([o, id]) => o === 'deleteUser' && id === p.treze.id));

  const nao = await app.pedir('PATCH', '/api/me', { token: app.token(p.doze.id), corpo: { birthdate: aniversarioHoje(13, 1) } });
  assert.equal(nao.status, 403, nao.texto);
  assert.equal(nao.json.code, 'MENOR_DE_IDADE');
  assert.equal(nao.json.error, 'O Futty é para quem tem 13 anos ou mais.');
  assert.ok(app.chamadasAdmin.some(([o, id]) => o === 'deleteUser' && id === p.doze.id), 'a conta em curso foi apagada');
});
