// Futty v2.0 — "Sessão conhecida" do middleware/auth.js (hotfix 25, 25-set), sem rede.
//
// Os limiters gerais da /api só tiram um pedido do balde por IP quando a sessão dele
// já foi validada pelo motor. Um Authorization qualquer não basta: senão dava para
// escapar do teto por IP mandando um header falso (e cada token falso custaria uma
// ida ao Supabase Auth). Aqui se prova o teste `sessaoConhecida` e o ciclo inteiro:
// o 1º pedido de uma sessão conta no IP; depois de validada, ela passa ao balde dela.
//
// Mesmo padrão do sessao-cache.test.js: o supabase.auth.getUser é trocado por um falso
// e o relógio (Date) é controlado pelo teste onde o tempo importa.
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { criarLimitesDaApi } = require('../middleware/limiters');

const AGORA = Date.UTC(2026, 8, 25, 12, 0, 0);
const caminhoDb = require.resolve('../utils/db');

function authFalso() {
  const f = {
    chamadas: 0,
    valido: (token) => token.startsWith('valido'),
    async getUser(token) {
      f.chamadas += 1;
      if (f.valido(token)) return { data: { user: { id: 'u1', user_metadata: {} } }, error: null };
      return { data: { user: null }, error: { name: 'AuthApiError', message: 'invalid JWT', status: 401 } };
    },
  };
  return f;
}

function carregarAuth(auth) {
  require.cache[caminhoDb] = { id: caminhoDb, filename: caminhoDb, loaded: true, exports: { supabase: { auth } } };
  for (const m of ['../middleware/auth', '../utils/plataformaStore']) delete require.cache[require.resolve(m)];
  return require('../middleware/auth');
}

/** JWT só com o que o motor lê (exp); a assinatura quem confere é o Supabase. */
function jwt(prefixo, venceEmS, agoraMs) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${prefixo}.${b64({ sub: 'u1', exp: Math.floor(agoraMs / 1000) + venceEmS })}.${b64({ alg: 'HS256' })}`;
}

/** Roda `fn` com o relógio parado em AGORA (só Date; timers de verdade seguem). */
async function comRelogio(fn) {
  mock.timers.enable({ apis: ['Date'], now: AGORA });
  try {
    return await fn();
  } finally {
    mock.timers.reset();
  }
}

test('token que o motor nunca viu NÃO é sessão conhecida', () => {
  const { sessaoConhecida } = carregarAuth(authFalso());
  assert.equal(sessaoConhecida('nunca-visto'), false);
  assert.equal(sessaoConhecida(jwt('valido-mas-novo', 3600, Date.now())), false, 'validade só existe depois de o motor validar');
});

test('depois de validado pelo motor, o token vira sessão conhecida', async () => {
  await comRelogio(async () => {
    const { getUserCacheado, sessaoConhecida } = carregarAuth(authFalso());
    const tk = jwt('valido-a', 3600, AGORA);
    assert.equal(sessaoConhecida(tk), false);
    assert.equal((await getUserCacheado(tk)).id, 'u1');
    assert.equal(sessaoConhecida(tk), true);
  });
});

test('token inválido nunca vira sessão conhecida, por mais que insista', async () => {
  await comRelogio(async () => {
    const auth = authFalso();
    const { getUserCacheado, sessaoConhecida } = carregarAuth(auth);
    const falso = jwt('falso', 3600, AGORA);
    for (let i = 0; i < 3; i += 1) assert.equal(await getUserCacheado(falso), null);
    assert.equal(sessaoConhecida(falso), false, 'um token que o Supabase recusou não pode sair do balde por IP');
  });
});

test('passados os 60 s do cache a sessão segue conhecida (a renovação corre por trás); vencido o token, deixa de ser', async () => {
  await comRelogio(async () => {
    const { getUserCacheado, sessaoConhecida } = carregarAuth(authFalso());
    const tk = jwt('valido-b', 3600, AGORA); // vence em 1 h
    await getUserCacheado(tk);
    mock.timers.tick(61_000);
    assert.equal(sessaoConhecida(tk), true, 'a sessão que falou há pouco continua conhecida depois do TTL de 60 s');
    mock.timers.tick(3600_000);
    assert.equal(sessaoConhecida(tk), false, 'token vencido não é sessão de ninguém');
  });
});

test('logout/exclusão esquece a sessão: invalidarSessaoDoPedido a tira do conjunto', async () => {
  await comRelogio(async () => {
    const { getUserCacheado, sessaoConhecida, invalidarSessaoDoPedido } = carregarAuth(authFalso());
    const tk = jwt('valido-c', 3600, AGORA);
    await getUserCacheado(tk);
    assert.equal(sessaoConhecida(tk), true);
    invalidarSessaoDoPedido({ headers: { authorization: `Bearer ${tk}` }, user: { id: 'u1' } });
    assert.equal(sessaoConhecida(tk), false);
  });
});

test('bearerToken lê o MESMO token que é a chave do cache de sessão', () => {
  const { bearerToken } = carregarAuth(authFalso());
  assert.equal(bearerToken({ headers: { authorization: 'Bearer abc.def.ghi' } }), 'abc.def.ghi');
  assert.equal(bearerToken({ headers: { authorization: 'Basic abc' } }), null);
  assert.equal(bearerToken({ headers: {} }), null);
});

test('o ciclo: o 1º pedido da sessão conta no IP; validada, ela passa ao balde dela e o IP fica livre', async () => {
  const auth = authFalso();
  const { bearerToken, sessaoConhecida, getUserCacheado } = carregarAuth(auth);
  const LIM = { janelaMs: 60_000, apiPorIp: 3, apiPorSessao: 2, avatar: 2, midia: 3 };
  const app = express();
  app.set('trust proxy', 1);
  app.use('/api', ...criarLimitesDaApi({ tokenDoPedido: bearerToken, sessaoConhecida, limites: LIM }));
  // Como o requireAuth: valida o token do pedido (é isso que faz a sessão ficar conhecida).
  app.get('/api/ping', async (req, res) => {
    const token = bearerToken(req);
    if (token) await getUserCacheado(token);
    res.json({ ok: true });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const status = async (headers) => {
      const res = await fetch(`${base}/api/ping`, { headers: { 'cf-connecting-ip': '198.51.100.50', ...headers } });
      await res.arrayBuffer();
      return res.status;
    };
    const sessao = { authorization: `Bearer ${jwt('valido-ciclo', 3600, Date.now())}` };
    // 1º: sessão ainda desconhecida → balde por IP (1 de 3). O handler a valida.
    assert.equal(await status(sessao), 200);
    // 2º e 3º: já conhecida → balde da sessão (2 de 2), sem gastar o IP.
    assert.equal(await status(sessao), 200);
    assert.equal(await status(sessao), 200);
    assert.equal(await status(sessao), 429, 'o balde da sessão (2) tem de esgotar no 4º pedido');
    // O IP gastou 1 dos 3: sobram 2 pedidos anônimos, e o 3º é barrado.
    assert.equal(await status({}), 200);
    assert.equal(await status({}), 200);
    assert.equal(await status({}), 429, 'o balde por IP tem de ter gastado só o 1º pedido da sessão');
    assert.equal(auth.chamadas, 1, 'o motor validou a sessão uma vez só (o cache serviu o resto)');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
