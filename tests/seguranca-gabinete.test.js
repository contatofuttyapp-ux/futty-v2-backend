// Futty v2.0 — SEGURANÇA · o Gabinete (/api/super/*): conta comum e admin de time recebem 403 em TODAS as rotas; só a super passa.
//
// O app de verdade (tests/_appFalsa.js) com o requireSuperAdmin REAL (o que decide é a coluna users.is_super_admin do banco de mentira).
// As rotas saem do próprio app Express, não de uma lista escrita à mão: uma rota nova sob /api/super entra aqui sozinha e uma rota
// do Gabinete sem a trava reprova o teste.
//
// Uso: node --test tests/seguranca-gabinete.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { subirApp } = require('./_appFalsa');
const { criarMundo } = require('./_mundoDeSeguranca');

let app;
before(async () => { app = await subirApp(); });
after(() => app.fechar());

const UUID_DE_EXEMPLO = '99999999-9999-4999-8999-999999999999';

function rotasDoApp() {
  const lista = [];
  const andar = (stack) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const metodo of Object.keys(layer.route.methods).filter((k) => layer.route.methods[k] && k !== '_all' && k !== 'head')) {
          lista.push({ metodo: metodo.toUpperCase(), caminho: layer.route.path, handlers: layer.route.stack.map((l) => l.handle) });
        }
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        andar(layer.handle.stack);
      }
    }
  };
  andar(app.app.router.stack);
  return lista;
}

test('toda rota sob /api/super tem a trava de super-admin (requireSuperAdmin) — e há rotas suficientes para ser verdade', () => {
  const { requireSuperAdmin } = require('../middleware/auth');
  const doGabinete = rotasDoApp().filter((r) => r.caminho.startsWith('/api/super'));
  assert.ok(doGabinete.length >= 20, `achei só ${doGabinete.length} rotas sob /api/super`);
  const semTrava = doGabinete.filter((r) => !r.handlers.includes(requireSuperAdmin)).map((r) => `${r.metodo} ${r.caminho}`);
  assert.deepEqual(semTrava, [], `rotas do Gabinete sem requireSuperAdmin: ${semTrava.join(', ')}`);
});

test('sem login → 401; conta comum, admin do próprio time e admin de outro time → 403; só a super passa — em TODAS as rotas /api/super (e no agregado de denúncias)', async () => {
  const m = criarMundo(app);
  m.p.super = { id: '5ab00000-0000-4000-8000-000000000001', nome: 'Dono', nome_jogador: 'Dono', email: 'dono@futtymock.com' };
  app.tabelas.users.push({ ...m.p.super, is_super_admin: true });
  m.tok.super = app.abrirSessao(m.p.super);

  const rotas = rotasDoApp().filter((r) => r.caminho.startsWith('/api/super') || r.caminho === '/api/denuncias/agregados');
  const fora = [];
  for (const r of rotas) {
    const caminho = r.caminho.replace(/:[A-Za-z]+/g, UUID_DE_EXEMPLO);
    const corpo = r.metodo === 'GET' ? undefined : {};
    const anonimo = await app.pedir(r.metodo, caminho, { corpo });
    if (anonimo.status !== 401) fora.push(`${r.metodo} ${caminho} sem login → ${anonimo.status}`);
    for (const quem of ['fora', 'memA', 'admA', 'admB', 'lixo']) {
      const antes = JSON.stringify([app.tabelas, [...app.storage.buckets].map(([n, b]) => [n, [...b.arquivos.keys()]])]);
      const resposta = await app.pedir(r.metodo, caminho, { token: m.tok[quem], corpo });
      if (resposta.status !== 403) fora.push(`${r.metodo} ${caminho} como ${quem} → ${resposta.status} (devia ser 403)`);
      if (/"email"|dono@futtymock/.test(resposta.texto)) fora.push(`${r.metodo} ${caminho} como ${quem} → resposta com e-mail`);
      const depois = JSON.stringify([app.tabelas, [...app.storage.buckets].map(([n, b]) => [n, [...b.arquivos.keys()]])]);
      if (depois.replace(/"[a-z_]+":\[\]/g, '') !== antes.replace(/"[a-z_]+":\[\]/g, '')) fora.push(`${r.metodo} ${caminho} como ${quem} → gravou algo`);
    }
    const dona = await app.pedir(r.metodo, caminho, { token: m.tok.super, corpo });
    if (dona.status === 401 || dona.status === 403) fora.push(`${r.metodo} ${caminho} como a super → ${dona.status} (devia passar da trava)`);
    if (dona.status === 500 && dona.json?.error !== 'Deu ruim do nosso lado. Tente de novo em instantes.') fora.push(`${r.metodo} ${caminho} como a super → 500 com texto fora da casa`);
  }
  assert.deepEqual(fora, [], `falhas na trava do Gabinete:\n${fora.join('\n')}`);
  assert.deepEqual(app.tentativasDeRede, []);
});

test('uma conta que perdeu o is_super_admin perde o Gabinete na hora; quem ganha passa', async () => {
  const m = criarMundo(app);
  const quem = m.p.memA;
  const antes = await app.pedir('GET', '/api/super/gabinete/resumo', { token: m.tok.memA });
  assert.equal(antes.status, 403);
  app.tabelas.users.find((u) => u.id === quem.id).is_super_admin = true;
  const durante = await app.pedir('GET', '/api/super/gabinete/resumo', { token: m.tok.memA });
  assert.notEqual(durante.status, 403, 'a flag do banco é a única fonte');
  app.tabelas.users.find((u) => u.id === quem.id).is_super_admin = false;
  assert.equal((await app.pedir('GET', '/api/super/gabinete/resumo', { token: m.tok.memA })).status, 403);
});

test('a flag só vem do banco: nem o corpo, nem o cabeçalho, nem a query viram super-admin', async () => {
  const m = criarMundo(app);
  const tentativas = [
    { cabecalhos: { 'x-super-admin': 'true', 'x-futty-super': '1' } },
    { cabecalhos: { 'x-teste-usuario': m.p.admA.id } },
    { corpo: { is_super_admin: true } },
  ];
  for (const t of tentativas) {
    const r = await app.pedir('POST', '/api/super/gabinete/brilhantes/creditos', { token: m.tok.memA, ...t, corpo: t.corpo || {} });
    assert.equal(r.status, 403, JSON.stringify(t));
  }
  assert.equal((await app.pedir('GET', '/api/super/users?is_super_admin=true&super=1', { token: m.tok.memA })).status, 403);
  // e quem tenta se promover pelo perfil não consegue: o PATCH /api/me ignora o que não é campo de perfil
  const promocao = await app.pedir('PATCH', '/api/me', { token: m.tok.memA, corpo: { is_super_admin: true, plan: 'elite', nome: 'Alice' } });
  assert.ok(promocao.status < 500);
  assert.notEqual(app.tabelas.users.find((u) => u.id === m.p.memA.id).is_super_admin, true, 'PATCH /api/me não promove ninguém');
  assert.equal((await app.pedir('GET', '/api/super/gabinete/resumo', { token: m.tok.memA })).status, 403);
});
