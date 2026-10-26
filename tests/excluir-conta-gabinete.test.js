// Futty v2.0 — "Excluir conta" pelo Gabinete (DELETE /api/super/users/:id): o mesmo resultado de a própria pessoa usar "Excluir minha
// conta" (DELETE /api/me), porque as duas rotas chamam a MESMA utils/apagarUsuario.js. Provado lado a lado, no app de verdade sobre banco,
// Storage e Auth de mentira (tests/_appFalsa.js): o mesmo mundo, uma vez por cada porta, e o que sobra tem de ser igual — times passados
// adiante (sucessão), time em que ela era a única apagado com o escudo, fotos e mídia da Resenha fora do Storage, a conta fora do Auth.
// E as recusas: a conta do próprio dono, as contas do dono, outro super-admin, a do revisor das lojas (demo-loja@futtymock.com), os
// revisores da Apple e os membros da Missa de Quinta. Recusado = nada muda. As outras @futtymock.com são contas de teste e saem.
//
// Uso: npm test  (ou: node --test tests/excluir-conta-gabinete.test.js)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { subirApp, usuario } = require('./_appFalsa');

let app;
before(async () => { app = await subirApp(); });
after(() => app.fechar());

const BANCO = 'https://projeto-falso.supabase.test/storage/v1/object/public';
let rodada = 0;
const uuid = (prefixo, n) => `${prefixo}${String(n).padStart(8 - prefixo.length, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** O mesmo mundo, com ids novos a cada chamada (os caches do motor guardam por pessoa e por time). */
function mundo() {
  rodada += 1;
  const n = rodada;
  const p = {
    dono: usuario(uuid('a0', n), 'Chavo', { email: 'contatofuttyapp@gmail.com' }),
    alvo: usuario(uuid('a1', n), 'Teste Um', { email: `phferreiraborgesbackup+teste${n}@gmail.com` }),
    bia: usuario(uuid('a2', n), 'Bia', { email: `bia${n}@exemplo.test` }),
    caio: usuario(uuid('a3', n), 'Caio', { email: `caio${n}@exemplo.test` }),
    pessoal: usuario(uuid('a4', n), 'Pedro Borges', { email: 'phferreiraborgesbackup@gmail.com' }),
    demo: usuario(uuid('a5', n), 'Bruninho', { email: 'demo-loja@futtymock.com' }),
    testeX: usuario(uuid('a9', n), 'Teste X', { email: `teste-x-${n}@futtymock.com` }),
    apple: usuario(uuid('a6', n), 'John Apple', { nome: 'John Apple', nome_jogador: '', email: `revisor${n}@privaterelay.appleid.com` }),
    missa: usuario(uuid('a7', n), 'Wesley', { email: `wesley${n}@exemplo.test` }),
    outroSuper: usuario(uuid('a8', n), 'Outro Super', { email: `super${n}@exemplo.test` }),
  };
  const T = {
    // o alvo criou e é admin; a Bia entrou antes do Caio → a Bia herda
    passa: { id: uuid('b1', n), slug: `pelada-${n}`, nome: 'Pelada do Alvo', criado_por: p.alvo.id, logo_url: null },
    // o alvo é o único membro → o time sai, com o escudo
    sozinho: { id: uuid('b2', n), slug: `solo-${n}`, nome: 'Time Solo', criado_por: p.alvo.id, logo_url: `${BANCO}/avatars/escudos/${n}-solo.webp` },
    // o alvo é só membro → nada muda no time
    deOutro: { id: uuid('b3', n), slug: `outro-${n}`, nome: 'Time da Bia', criado_por: p.bia.id, logo_url: null },
    missa: { id: uuid('b4', n), slug: 'missa-de-quinta-ogqq6', nome: 'Missa de Quinta', criado_por: p.dono.id, logo_url: null },
  };
  const m = (team, user, role, dias) => ({ id: `${team.id}-${user.id}`, team_id: team.id, user_id: user.id, role, created_at: new Date(Date.now() - dias * 86400000).toISOString() });
  const fotoDoAlvo = `public/${p.alvo.id}-1700000000.jpg`;
  const tabelas = {
    teams: Object.values(T),
    team_members: [
      m(T.passa, p.alvo, 'admin', 30), m(T.passa, p.bia, 'member', 20), m(T.passa, p.caio, 'member', 10),
      m(T.sozinho, p.alvo, 'admin', 30),
      m(T.deOutro, p.bia, 'admin', 30), m(T.deOutro, p.alvo, 'member', 5),
      m(T.missa, p.dono, 'admin', 60), m(T.missa, p.missa, 'member', 50),
    ],
    feed_posts: [{ id: uuid('c1', n), team_id: T.deOutro.id, author_id: p.alvo.id, tipo: 'post', body: 'gol!' }],
    feed_post_media: [{ id: uuid('c2', n), post_id: uuid('c1', n), url: `${BANCO}/resenha/${T.deOutro.id}/${p.alvo.id}-video.mp4` }],
    comentarios: [], comentario_anexos: [], champion_photos: [], geracao_ia_log: [{ id: uuid('c3', n), user_id: p.alvo.id }],
  };
  const usuarios = Object.values(p).map((u) => (u === p.alvo ? { ...u, avatar_url: `${BANCO}/avatars/${fotoDoAlvo}` } : u));
  app.reiniciar({ tabelas, usuarios, superAdmins: [p.dono.id, p.outroSuper.id] });
  app.criarBucketsDoProjeto();
  const pôr = (bucket, caminho) => app.storage.buckets.get(bucket).arquivos.set(caminho, { corpo: Buffer.from('x'), tipo: 'image/jpeg', em: new Date().toISOString() });
  pôr('avatars', fotoDoAlvo);
  pôr('avatars', `escudos/${n}-solo.webp`);
  pôr('avatars', `public/${p.bia.id}-1.jpg`); // de outra pessoa: fica
  pôr('resenha', `${T.deOutro.id}/${p.alvo.id}-video.mp4`);
  return { p, T, n };
}

/** O que sobrou, com os ids trocados por nomes (os dois mundos têm ids diferentes). */
function retrato({ p, T }) {
  const nomes = new Map([...Object.entries(p).map(([k, u]) => [u.id, k]), ...Object.entries(T).map(([k, t]) => [t.id, `time:${k}`])]);
  const troca = (s) => { let x = String(s); for (const [id, nome] of nomes) x = x.split(id).join(nome); return x.replace(/-\d+(?=[-.\/])/g, ''); };
  const times = app.tabelas.teams.map((t) => `${troca(t.id)} criado_por=${troca(t.criado_por)}`).sort();
  const membros = app.tabelas.team_members.map((v) => `${troca(v.team_id)} ${troca(v.user_id)} ${v.role}`).sort();
  const arquivos = [];
  for (const [bucket, b] of app.storage.buckets) for (const c of b.arquivos.keys()) if (!c.startsWith('_plataforma/')) arquivos.push(troca(`${bucket}/${c}`));
  return {
    times, membros, arquivos: arquivos.sort(),
    auth: app.chamadasAdmin.filter((c) => c[0] === 'deleteUser').map((c) => troca(c[1])),
    geracao_ia_log: (app.tabelas.geracao_ia_log || []).length,
  };
}

test('excluir pelo Gabinete = a pessoa excluir a própria conta (times com sucessão, Storage limpo, Auth apagado)', async () => {
  // 1) a própria pessoa, em "Excluir minha conta"
  const a = mundo();
  const r1 = await app.pedir('DELETE', '/api/me', { token: app.token(a.p.alvo.id), corpo: { confirmacao: 'EXCLUIR' } });
  assert.equal(r1.status, 200, r1.texto);
  const pelaPessoa = retrato(a);

  // 2) o dono, no Gabinete
  const b = mundo();
  const r2 = await app.pedir('DELETE', `/api/super/users/${b.p.alvo.id}`, { token: app.token(b.p.dono.id), corpo: { confirmar: 'EXCLUIR' } });
  assert.equal(r2.status, 200, r2.texto);
  const peloGabinete = retrato(b);

  assert.deepEqual(peloGabinete, pelaPessoa);
  // e o que isso quer dizer, por extenso:
  assert.ok(pelaPessoa.times.includes('time:passa criado_por=bia'), 'a Bia (a mais antiga) herdou o time');
  assert.ok(pelaPessoa.membros.includes('time:passa bia admin'), 'e virou admin');
  assert.ok(!pelaPessoa.times.some((t) => t.startsWith('time:sozinho')), 'o time em que o alvo era o único saiu');
  assert.ok(pelaPessoa.times.includes('time:deOutro criado_por=bia'), 'o time da Bia continua dela');
  assert.deepEqual(pelaPessoa.arquivos, ['avatars/public/bia.jpg'], `só a foto da Bia fica no Storage: ${pelaPessoa.arquivos}`);
  assert.deepEqual(pelaPessoa.auth, ['alvo'], 'a conta saiu do Auth');
  assert.equal(pelaPessoa.geracao_ia_log, 0);

  // a resposta diz o que aconteceu, e fica no log de ações (sem o e-mail inteiro)
  assert.equal(r2.json.ok, true);
  assert.deepEqual(r2.json.times_apagados, [b.T.sozinho.slug]);
  assert.deepEqual(r2.json.times_passados_adiante, [b.T.passa.slug]);
  assert.equal(r2.json.no_log, true);
  const log = await app.pedir('GET', '/api/super/acoes', { token: app.token(b.p.dono.id) });
  assert.equal(log.status, 200, log.texto);
  const [ultima] = log.json.acoes;
  assert.equal(ultima.acao, 'excluir_conta');
  assert.equal(ultima.alvo.id, b.p.alvo.id);
  assert.equal(ultima.alvo.apelido, 'Teste Um');
  assert.equal(ultima.alvo.email, 'phf…@gmail.com');
  assert.equal(ultima.por.id, b.p.dono.id);
  assert.deepEqual(ultima.detalhe, { times_apagados: 1, times_passados_adiante: 1, fotos_removidas: r2.json.fotos_removidas });
});

test('recusas: a própria conta, as do dono, outro super-admin, o revisor das lojas, o revisor da Apple, membro da Missa — e nada muda', async () => {
  const w = mundo();
  const antes = JSON.stringify(retrato(w));
  const casos = [
    ['dono', /sua conta/],
    ['pessoal', /Conta do dono/],
    ['outroSuper', /super-admin/],
    ['demo', /revisor das lojas/],
    ['apple', /revisor da Apple/],
    ['missa', /Membro do Missa de Quinta/],
  ];
  for (const [quem, frase] of casos) {
    const r = await app.pedir('DELETE', `/api/super/users/${w.p[quem].id}`, { token: app.token(w.p.dono.id), corpo: { confirmar: 'EXCLUIR' } });
    assert.equal(r.status, 403, `${quem}: ${r.texto}`);
    assert.equal(r.json.code, 'CONTA_PROTEGIDA', quem);
    assert.match(r.json.error, frase, quem);
  }
  assert.equal(JSON.stringify(retrato(w)), antes, 'nenhuma recusa mexeu em nada');

  // a lista do Gabinete já diz quem não pode sair (o botão "Excluir" só aparece para quem pode)
  const lista = await app.pedir('GET', '/api/super/users?page=1&limit=50', { token: app.token(w.p.dono.id) });
  const porId = new Map(lista.json.users.map((u) => [u.id, u]));
  for (const [quem] of casos) assert.ok(porId.get(w.p[quem].id).protegida, `${quem} aparece protegido`);
  for (const quem of ['alvo', 'bia', 'caio', 'testeX']) assert.equal(porId.get(w.p[quem].id).protegida, null, `${quem} pode sair`);
});

test('uma conta de teste @futtymock.com que não é a do revisor das lojas sai pelo Gabinete', async () => {
  const w = mundo();
  const r = await app.pedir('DELETE', `/api/super/users/${w.p.testeX.id}`, { token: app.token(w.p.dono.id), corpo: { confirmar: 'EXCLUIR' } });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.ok, true);
  assert.deepEqual(retrato(w).auth, ['testeX'], 'a conta saiu do Auth');
  const { json } = await app.pedir('GET', '/api/super/acoes', { token: app.token(w.p.dono.id) });
  assert.equal(json.acoes[0].acao, 'excluir_conta');
  assert.equal(json.acoes[0].alvo.email, 'tes…@futtymock.com');
});

test('sem a confirmação "EXCLUIR" nada sai; conta que não existe = 404; quem não é super-admin = 403', async () => {
  const w = mundo();
  const antes = JSON.stringify(retrato(w));
  for (const corpo of [undefined, {}, { confirmar: 'sim' }, { confirmacao: 'EXCLUIR' }]) {
    const r = await app.pedir('DELETE', `/api/super/users/${w.p.alvo.id}`, { token: app.token(w.p.dono.id), corpo });
    assert.equal(r.status, 400, `${JSON.stringify(corpo)}: ${r.texto}`);
  }
  assert.equal((await app.pedir('DELETE', `/api/super/users/${uuid('ff', 999)}`, { token: app.token(w.p.dono.id), corpo: { confirmar: 'EXCLUIR' } })).status, 404);
  assert.equal((await app.pedir('DELETE', '/api/super/users/nao-e-um-id', { token: app.token(w.p.dono.id), corpo: { confirmar: 'EXCLUIR' } })).status, 404);
  assert.equal((await app.pedir('DELETE', `/api/super/users/${w.p.alvo.id}`, { token: app.token(w.p.bia.id), corpo: { confirmar: 'EXCLUIR' } })).status, 403);
  assert.equal(JSON.stringify(retrato(w)), antes);
});

test('suspender e reativar também entram no log de ações', async () => {
  const w = mundo();
  const tk = app.token(w.p.dono.id);
  assert.equal((await app.pedir('PATCH', `/api/super/users/${w.p.caio.id}/suspender`, { token: tk, corpo: { suspenso: true } })).status, 200);
  assert.equal((await app.pedir('PATCH', `/api/super/users/${w.p.caio.id}/suspender`, { token: tk, corpo: { suspenso: false } })).status, 200);
  const { json } = await app.pedir('GET', '/api/super/acoes', { token: tk });
  assert.deepEqual(json.acoes.slice(0, 2).map((a) => [a.acao, a.alvo.apelido]), [['reativar_conta', 'Caio'], ['suspender_conta', 'Caio']]);
});
