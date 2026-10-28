// Futty v2.0 — GET /api/saude/banco (routes/saudeBanco.js) no app DE VERDADE sobre o banco de mentira (tests/_appFalsa.js):
// sem login → 401; conta comum, admin de time e conta sem time → 403; a super recebe o JSON com todas as partes do medidor, sem
// nenhum cabeçalho ou segredo no corpo, e nada é gravado. A rede de fora está fechada: o medidor tenta resolver e abrir o TLS do host
// de mentira, a bancada recusa (fica anotado) e a resposta diz o código do erro — é a linha de base local.
//
// Uso: node --test tests/saude-banco-rota.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { subirApp, URL_DO_BANCO } = require('./_appFalsa');
const { criarMundo } = require('./_mundoDeSeguranca');

let app;
before(async () => { app = await subirApp(); });
after(() => app.fechar());

const ROTA = '/api/saude/banco';
const fotoDasTabelas = () => JSON.stringify(app.tabelas);

function super_(m) {
  m.p.super = { id: '5ab00000-0000-4000-8000-0000000000aa', nome: 'Dono', nome_jogador: 'Dono', email: 'dono@futtymock.com' };
  app.tabelas.users.push({ ...m.p.super, is_super_admin: true });
  m.tok.super = app.abrirSessao(m.p.super);
}

test('a rota tem a trava de super-admin (a mesma do Gabinete)', () => {
  const { requireSuperAdmin } = require('../middleware/auth'); // eslint-disable-line global-require
  const camadas = [];
  const andar = (stack) => {
    for (const l of stack) {
      if (l.route?.path === ROTA) camadas.push(...l.route.stack.map((c) => c.handle));
      else if (l.handle && Array.isArray(l.handle.stack)) andar(l.handle.stack);
    }
  };
  andar(app.app.router.stack);
  assert.ok(camadas.includes(requireSuperAdmin), 'GET /api/saude/banco sem requireSuperAdmin');
});

test('sem login → 401; conta comum, admin do time, admin de outro e conta sem time → 403; nada gravado', async () => {
  const m = criarMundo(app);
  const antes = fotoDasTabelas();
  assert.equal((await app.pedir('GET', ROTA)).status, 401);
  assert.equal((await app.pedir('GET', ROTA, { token: 'token-que-nao-existe' })).status, 401);
  for (const quem of ['memA', 'admA', 'admB', 'fora', 'lixo']) {
    const r = await app.pedir('GET', ROTA, { token: m.tok[quem] });
    assert.equal(r.status, 403, `${quem} → ${r.status}`);
    assert.equal(r.json?.dns, undefined, `${quem} recebeu a medição`);
  }
  assert.equal(fotoDasTabelas(), antes);
  assert.deepEqual(app.tentativasDeRede, [], 'quem é barrado não chega a medir nada');
});

test('a super recebe o JSON com as 7 partes, sem segredo nem cabeçalho sensível, e nada é gravado', async () => {
  const m = criarMundo(app);
  super_(m);
  const antes = fotoDasTabelas();
  const r = await app.pedir('GET', ROTA, { token: m.tok.super });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.cabecalhos.get('cache-control'), 'no-store');
  const j = r.json;
  for (const parte of ['dns', 'tcp_tls', 'ping_x5', 'ping_x5_paralelo', 'cabecalhos', 'despachante', 'consulta_real']) assert.ok(j[parte], `falta ${parte}`);

  // A rede de fora está fechada: DNS e TLS dão o código da bancada, nunca a mensagem.
  assert.deepEqual(j.dns, { erro: 'EREDEFECHADA' });
  assert.deepEqual(j.tcp_tls, { erro: 'EREDEFECHADA' });
  // Os pings vão ao banco de mentira (em memória): 5 tempos, todos pequenos, e nenhum pelo fetch do motor (o falso não usa fetch).
  assert.equal(j.ping_x5.ms.length, 5);
  assert.ok(j.ping_x5.ms.every((v) => typeof v === 'number' && v >= 0 && v < 1000), JSON.stringify(j.ping_x5));
  assert.deepEqual(j.ping_x5.pelo_agente_quente, [false, false, false, false, false]);
  assert.equal(j.ping_x5_paralelo.ms.length, 5);
  assert.equal(typeof j.ping_x5_paralelo.total_ms, 'number');
  assert.equal(j.despachante.estado, 'padrao');
  assert.equal(j.cabecalhos.colo, null);
  assert.equal(j.consulta_real.nome, 'brilhante (direito à figurinha)');
  assert.equal(typeof j.consulta_real.ms, 'number');

  // Nada de segredo, chave ou cabeçalho de autenticação no corpo.
  assert.doesNotMatch(r.texto, /authorization|apikey|bearer|set-cookie|cookie|chave-secreta-de-mentira|sb_secret|segredo|dono@futtymock/i);
  assert.equal(fotoDasTabelas(), antes, 'o medidor gravou algo');
  // As únicas saídas tentadas: resolver e abrir TLS com o host do banco de mentira.
  const host = new URL(URL_DO_BANCO).hostname;
  assert.deepEqual(app.tentativasDeRede, [`dns ${host}`, `tls ${host}`]);
  console.log(`# medidor no local (banco de mentira): ${r.texto}`);
});
