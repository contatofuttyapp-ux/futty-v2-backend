// Futty v2.0 — SEGURANÇA · a MATRIZ de quem pode o quê, em TODAS as rotas que escrevem (e nas que leem dados de time).
//
// O app de verdade (tests/_appFalsa.js) sobre banco, Storage e Auth de mentira, com dois times (A e B) e seis pessoas
// (tests/_mundoDeSeguranca.js). Cada linha da tabela abaixo é uma rota, a classe de quem pode usá-la e o corpo certo:
//   · admin ........ só o admin do PRÓPRIO time;
//   · membro ....... qualquer membro do próprio time (o admin também);
//   · autorOuAdmin . o autor do post/comentário, ou o admin do time dele;
//   · proprio ...... qualquer conta logada, sobre os próprios dados;
//   · super ........ só o super-admin.
// Para cada linha: sem login → 401; quem não pode → 403 ou 404 e NADA gravado (o estado inteiro — tabelas e arquivos — fica idêntico);
// quem pode → nem 401 nem 403, e nunca um 5xx que não seja a frase da casa.
//
// O teste do INVENTÁRIO no fim varre o app Express e falha se existir uma rota que escreve e não esteja na tabela (nem na lista das
// públicas de propósito): uma rota nova não entra sem decisão de quem pode usá-la.
//
// Uso: node --test tests/seguranca-matriz.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_appFalsa');
const { criarMundo, fotografiaDe, iso, HORA } = require('./_mundoDeSeguranca');

let app;
before(async () => { app = await subirApp(); });
after(() => app.fechar());

const FRASE_DA_CASA = 'Deu ruim do nosso lado. Tente de novo em instantes.';

const { LINHAS, PUBLICAS_DE_PROPOSITO, POR_TOKEN, NO_TESTE_DAS_ROTAS_NOVAS, CLASSES, desenho } = require('./_linhasDeRotas');


function semDetalheTecnico(r, contexto) {
  if (r.status >= 500) {
    if (r.status === 500) assert.equal(r.json?.error, FRASE_DA_CASA, `5xx com texto que não é o da casa · ${contexto} · ${r.texto}`);
    assert.doesNotMatch(r.texto, /supabase|postgres|PGRST|violates|duplicate key|stack|node_modules|\bat .*\.js/i, `detalhe técnico na resposta · ${contexto}`);
  }
}

for (const linha of LINHAS) {
  test(`matriz · ${desenho(linha)} · ${linha.classe}`, async () => {
    const m = criarMundo(app);
    m.p.super = { id: `5${m.p.admA.id.slice(1)}`, nome: 'Dono', nome_jogador: 'Dono', email: 'dono@futtymock.com' };
    app.tabelas.users.push({ ...m.p.super, is_super_admin: true });
    m.tok.super = app.abrirSessao(m.p.super);
    // a denúncia que as rotas de decisão precisam encontrar (guardada no Storage, como no app)
    if (/denuncias\/.*decidir/.test(linha.rota(m))) {
      const caso = { id: m.ids.denA, team_id: m.A.id, target_type: 'post', target_id: m.ids.postA, reporter_id: m.p.memA.id, categoria: 'spam', estado: 'fila', prioritaria: false, criado_em: iso(-HORA), eventos: [] };
      await app.storage.buckets.get('denuncias').arquivos.set(`casos/${m.A.id}/${m.ids.denA}.json`, { corpo: Buffer.from(JSON.stringify(caso)), tipo: 'application/json', em: iso(-HORA) });
    }
    const caminho = linha.rota(m);
    const corpo = linha.corpo ? linha.corpo(m) : undefined;
    const pedir = (quem) => app.pedir(linha.metodo, caminho, { token: quem ? m.tok[quem] : null, corpo });
    const ctx = (quem) => `${quem || 'sem login'} · ${linha.metodo} ${caminho}`;

    // 1. sem login: 401
    const anonimo = await pedir(null);
    assert.equal(anonimo.status, 401, `${ctx(null)} · ${anonimo.texto}`);
    if (linha.soSemLogin) return;

    // 2. quem não pode: 403/404, e o mundo fica idêntico
    for (const quem of CLASSES[linha.classe].negados) {
      const antes = fotografiaDe(app);
      const r = await pedir(quem);
      assert.ok((linha.negacoes || [403, 404]).includes(r.status), `${ctx(quem)} devia ser negado (403/404) e deu ${r.status} · ${r.texto}`);
      semDetalheTecnico(r, ctx(quem));
      assert.equal(fotografiaDe(app), antes, `${ctx(quem)} foi negado mas gravou algo`);
    }

    // 3. quem pode: passa da autorização (nem 401 nem 403) e nunca devolve detalhe técnico
    for (const quem of linha.permitidos || CLASSES[linha.classe].permitidos) {
      const r = await pedir(quem);
      // 403 por REGRA DE NEGÓCIO (o time é privado, por exemplo) é diferente de 403 por falta de permissão: a linha avisa.
      assert.ok(r.status !== 401 && (linha.regraDeNegocio403 || r.status !== 403), `${ctx(quem)} devia passar da autorização e deu ${r.status} · ${r.texto}`);
      semDetalheTecnico(r, ctx(quem));
    }
  });
}

// ─── Os ids do time B nas mãos do admin do time A (IDOR pelo endereço e pelo corpo) ──────────────────────────────────────────────

const idsDoB = (m) => [m.B.id, m.ids.jogoPassadoB, m.ids.jogoAbertoB, m.ids.postB, m.ids.comB, m.ids.conviteB, m.ids.pedidoB, m.p.admB.id, m.p.memB.id, m.tokenDoConviteB];
/** Tudo o que menciona o time B — linhas de todas as tabelas e arquivos de todos os buckets —, para provar que nada dele mudou. */
function fotografiaDoB(m) {
  const marcas = idsDoB(m);
  const linhas = [];
  for (const [tabela, rows] of Object.entries(app.tabelas)) for (const r of rows) { const s = JSON.stringify(r); if (marcas.some((id) => s.includes(id))) linhas.push(`${tabela} ${s}`); }
  const arquivos = [];
  for (const [nome, b] of app.storage.buckets) for (const [c, a] of b.arquivos) if (marcas.some((id) => c.includes(id) || a.corpo.toString().includes(id))) arquivos.push(`${nome} ${c} ${a.corpo.toString('base64')}`);
  return JSON.stringify([linhas.sort(), arquivos.sort()]);
}

const CRUZADAS = [
  ['PATCH', (m) => `/api/games/${m.ids.jogoAbertoB}`, () => ({ location: 'invadido' })],
  ['DELETE', (m) => `/api/games/${m.ids.jogoAbertoB}`],
  ['POST', (m) => `/api/games/${m.ids.jogoAbertoB}/cancelar`, () => ({ motivo: 'invadido' })],
  ['PATCH', (m) => `/api/games/${m.ids.jogoAbertoB}/capacidade`, () => ({ max_jogadores: 3 })],
  ['POST', (m) => `/api/games/${m.ids.jogoPassadoB}/jogador`, (m) => ({ user_id: m.p.memB.id, goleiro: true })],
  ['POST', (m) => `/api/games/${m.ids.jogoAbertoB}/presencas`, (m) => ({ jogadores: [{ user_id: m.p.memB.id }] })],
  ['POST', (m) => `/api/games/${m.ids.jogoAbertoB}/times-manuais`, (m) => ({ times: [{ nome: 'X', jogadores: [{ nome: 'Zeca', convidado: true }] }, { nome: 'Y', jogadores: [{ nome: 'Beto', convidado: true }] }] })],
  ['POST', (m) => `/api/games/${m.ids.jogoAbertoB}/sortear`, () => ({ convidados: ['a', 'b', 'c', 'd', 'e', 'f'] })],
  ['PATCH', (m) => `/api/games/${m.ids.jogoPassadoB}/times`, (m) => ({ times_resultado: { times: [{ nome: 'X', jogadores: [{ user_id: m.p.admB.id, nome: 'Bruno' }] }, { nome: 'Y', jogadores: [{ user_id: m.p.memB.id, nome: 'Beto' }] }], reservas: [] } })],
  ['PATCH', (m) => `/api/games/${m.ids.jogoPassadoB}/resultado`, () => ({ campeao_time_index: 0 })],
  ['PATCH', (m) => `/api/feed/games/${m.ids.jogoPassadoB}/resultado`, () => ({ campeao_time_index: 0 })],
  ['POST', (m) => `/api/games/${m.ids.jogoPassadoB}/confirmar`, () => ({ confirmado: true })],
  ['POST', (m) => `/api/games/${m.ids.jogoPassadoB}/link-curto`, () => ({})],
  ['POST', (m) => `/api/jogos/${m.ids.jogoAbertoB}/rsvp/abrir`, () => ({ prazo: iso(24 * HORA) })],
  ['POST', (m) => `/api/jogos/${m.ids.jogoAbertoB}/rsvp/fechar`, () => ({})],
  ['POST', (m) => `/api/jogos/${m.ids.jogoAbertoB}/rsvp/responder`, () => ({ status: 'confirmado' })],
  ['DELETE', (m) => `/api/feed/posts/${m.ids.postB}`],
  ['DELETE', (m) => `/api/feed/comentarios/${m.ids.comB}`],
  ['POST', () => '/api/feed/reacoes', (m) => ({ target_type: 'post', target_id: m.ids.postB, emoji: '❤️' })],
  ['POST', () => '/api/feed/comentarios', (m) => ({ parent_type: 'post', parent_id: m.ids.postB, body: 'invasão' })],
  ['POST', () => '/api/feed/denuncias', (m) => ({ target_type: 'post', target_id: m.ids.postB, motivo: 'spam' })],
  ['POST', () => '/api/feed/posts', (m) => ({ team_id: m.B.id, body: 'invasão' })],
  ['PATCH', (m) => `/api/teams/${m.A.slug}/pedidos/${m.ids.pedidoB}`, () => ({ status: 'approved' })],
  ['DELETE', (m) => `/api/teams/${m.A.slug}/convites/${m.ids.conviteB}`],
  ['PATCH', (m) => `/api/teams/${m.A.slug}/membros/${m.p.memB.id}/ativo`, () => ({ ativo: false })],
  ['PATCH', (m) => `/api/teams/${m.A.slug}/membros/${m.p.memB.id}`, () => ({ role: 'admin' })],
  ['DELETE', (m) => `/api/teams/${m.A.slug}/membros/${m.p.memB.id}`],
  ['DELETE', (m) => `/api/teams/${m.A.slug}/votos/${m.p.memB.id}`],
  ['POST', (m) => `/api/teams/${m.A.slug}/votar`, (m) => ({ para_user_id: m.p.memB.id, nota: 1 })],
  ['PATCH', (m) => `/api/equipas/${m.A.slug}/membros/posicao`, (m) => ({ user_id: m.p.memB.id, goleiro: true })],
  ['POST', (m) => `/api/push/equipas/${m.A.slug}/membros/${m.p.memB.id}/mensagem`, () => ({ titulo: 'oi', mensagem: 'invasão' })],
  ['PATCH', (m) => `/api/teams/${m.B.slug}`, () => ({ nome: 'Dominado' })],
  ['PUT', (m) => `/api/teams/${m.B.slug}/brilhante-kit`, () => ({ kitId: 'dark-gold' })],
  ['DELETE', (m) => `/api/teams/${m.B.slug}/logo`],
  ['POST', (m) => `/api/teams/${m.B.slug}/convite`, () => ({})],
  ['POST', (m) => `/api/teams/${m.B.slug}/votar`, (m) => ({ para_user_id: m.p.memB.id, nota: 1 })],
  ['POST', (m) => `/api/teams/${m.B.slug}/pedir-revotacao`, () => ({ zerar: true })],
  ['DELETE', (m) => `/api/teams/${m.B.slug}/votos`],
  ['POST', (m) => `/api/teams/${m.B.slug}/jogos/recorrentes`, () => ({ dia_semana: 1, hora: '20:00', semanas: 4 })],
  ['POST', (m) => `/api/equipas/${m.B.slug}/campeonato`, () => ({ nome: 'Invasão' })],
  ['POST', (m) => `/api/equipas/${m.B.slug}/campeonatos`, () => ({ nome: 'Invasão', formato: 'pontos', nomes: ['a', 'b'] })],
];

test('IDOR · o admin do time A com os ids e o slug do time B: nenhum pedido passa e nada do time B muda', async () => {
  const m = criarMundo(app);
  const antes = fotografiaDoB(m);
  const passaram = [];
  for (const [metodo, rota, corpo] of CRUZADAS) {
    const r = await app.pedir(metodo, rota(m), { token: m.tok.admA, corpo: corpo ? corpo(m) : undefined });
    semDetalheTecnico(r, `${metodo} ${rota(m)}`);
    if (r.status < 400) passaram.push(`${metodo} ${rota(m)} → ${r.status}`);
    assert.ok(r.status < 500 || r.status === 503, `${metodo} ${rota(m)} → ${r.status} ${r.texto}`);
  }
  assert.equal(fotografiaDoB(m), antes, `algo do time B mudou. Pedidos que passaram (2xx/3xx): ${passaram.join(' · ') || 'nenhum'}`);
  // o que passou (2xx) tem de ser só no-op idempotente: nada de B mudou (acima) e a lista cabe aqui para o relatório
  assert.ok(passaram.length <= 6, `muitos pedidos cruzados com 2xx — confira: ${passaram.join(' · ')}`);
});

// ─── O inventário: nenhuma rota que escreve fica fora da tabela ─────────────────────────────────────────────────────────────────

test('inventário · toda rota que escreve está na matriz, na lista das públicas de propósito ou na lista das provadas à parte', () => {
  // normaliza os caminhos do Express (:slug, :id, :userId…) para ":p" dos dois lados
  const norm = (s) => s.replace(/:[A-Za-z]+/g, ':p');
  const normCobertas = new Set([...LINHAS.map((l) => norm(desenho(l))), ...[...PUBLICAS_DE_PROPOSITO, ...POR_TOKEN, ...NO_TESTE_DAS_ROTAS_NOVAS].map(norm)]);

  const rotas = [];
  const andar = (stack) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const metodo of Object.keys(layer.route.methods).filter((k) => layer.route.methods[k] && k !== 'get' && k !== 'head' && k !== '_all')) {
          rotas.push(`${metodo.toUpperCase()} ${layer.route.path}`);
        }
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        andar(layer.handle.stack);
      }
    }
  };
  andar(app.app.router.stack);
  // /api/push é montado com prefixo
  const comPrefixo = rotas.map((r) => (/^(POST|DELETE|PATCH|PUT) \/(subscribe|preferencias|equipas\/:slug\/(broadcast|membros))/.test(r) ? r.replace(' /', ' /api/push/') : r));
  assert.ok(comPrefixo.length >= 90, `o inventário achou só ${comPrefixo.length} rotas que escrevem`);
  const faltando = comPrefixo.filter((r) => !normCobertas.has(norm(r)));
  assert.deepEqual(faltando, [], `rotas que escrevem sem decisão de quem pode usá-las (ponha na matriz): ${faltando.join(' · ')}`);
});

test('nenhuma rota fica escondida atrás de outra (no Express a primeira que casa ganha: "/membros/:userId" na frente de "/membros/me" fazia o "sair do time" virar "remover o membro me")', () => {
  const todas = [];
  const andar = (stack) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const metodo of Object.keys(layer.route.methods).filter((k) => layer.route.methods[k] && k !== '_all')) todas.push({ metodo, caminho: layer.route.path, layer });
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        andar(layer.handle.stack);
      }
    }
  };
  andar(app.app.router.stack);
  assert.ok(todas.length > 150, `o inventário achou só ${todas.length} rotas`);
  const escondidas = [];
  for (const rota of todas) {
    // um endereço de exemplo: cada :parametro vira "x", o resto fica como está ("/membros/me" continua "/membros/me")
    const exemplo = rota.caminho.replace(/:[A-Za-z]+/g, 'x');
    const primeira = todas.find((outra) => outra.metodo === rota.metodo && outra.layer.match(exemplo));
    if (primeira && primeira.layer !== rota.layer) escondidas.push(`${rota.metodo} ${rota.caminho}  ←  ${primeira.caminho}`);
  }
  assert.deepEqual(escondidas, [], `rotas que nunca recebem um pedido, porque outra registrada antes casa primeiro:\n${escondidas.join('\n')}`);
});

test('nada disto falou com a rede', () => {
  assert.deepEqual(app.tentativasDeRede, [], `saiu pedido para a rede: ${app.tentativasDeRede.join(', ')}`);
  });
