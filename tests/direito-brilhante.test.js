// Futty v2.0 — Quem pode gerar uma Figurinha Brilhante (SPEC-FIGURINHA-3 §5).
//
// Desde 22-set cada geração custa US$0,112 REAIS e só sai com direito. Este é o
// portão do dinheiro: se ele deixar passar quem não pagou, a casa paga. Por
// isso os quatro casos ficam travados aqui.
//
// SEM REDE, de propósito. Os outros testes do motor falam com o Supabase de
// verdade, mas este tem de correr ANTES da migração 054 estar aplicada (é o
// Pedro que a aplica, no SQL Editor) — e o caso mais importante é justamente
// "a coluna ainda não existe". Um cliente falso, injetado no cache de módulos
// do Node antes de carregar o utils, dá os quatro casos de forma determinista.
//
// Uso: npm test  (ou: node --test tests/direito-brilhante.test.js)
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ─── Cliente falso do Supabase ───────────────────────────────────────────────
// Imita só o que utils/direitoBrilhante.js usa: from().select().eq()…
// maybeSingle() e o encadeamento "await" direto (listas e count). `respostas`
// é uma função (tabela, estado) -> { data, error, count }.
function fakeSupabase(respostas) {
  const chamadas = [];
  const builder = (tabela) => {
    const estado = { tabela, filtros: {}, count: false };
    const resolver = () => {
      chamadas.push({ tabela, filtros: { ...estado.filtros }, count: estado.count });
      return respostas(tabela, estado);
    };
    const api = {
      select(_cols, opts) { if (opts?.count) estado.count = true; return api; },
      eq(col, val) { estado.filtros[col] = val; return api; },
      is(col, val) { estado.filtros[col] = val; return api; },
      update(patch) { estado.patch = patch; return api; },
      upsert(linha) { estado.linha = linha; return api; },
      maybeSingle: async () => resolver(),
      // `await query` sem maybeSingle: é assim que as listas e o count são lidos.
      then(ok, falha) { return Promise.resolve().then(resolver).then(ok, falha); },
    };
    return api;
  };
  return { cliente: { from: builder }, chamadas };
}

/** Carrega utils/direitoBrilhante.js com o Supabase falso por baixo. */
function carregarCom(respostas) {
  const caminhoDb = require.resolve('../utils/db');
  const caminhoAlvo = require.resolve('../utils/direitoBrilhante');
  const { cliente, chamadas } = fakeSupabase(respostas);
  const dbAntigo = require.cache[caminhoDb];
  require.cache[caminhoDb] = {
    id: caminhoDb, filename: caminhoDb, loaded: true, exports: { supabase: cliente },
    path: path.dirname(caminhoDb), children: [], paths: [],
  };
  delete require.cache[caminhoAlvo];
  // eslint-disable-next-line global-require
  const mod = require('../utils/direitoBrilhante');
  delete require.cache[caminhoAlvo];
  if (dbAntigo) require.cache[caminhoDb] = dbAntigo; else delete require.cache[caminhoDb];
  return { mod, chamadas };
}

const TIME = '11111111-1111-1111-1111-111111111111';
const PESSOA = '22222222-2222-2222-2222-222222222222';
const semErro = (data, extra = {}) => ({ data, error: null, ...extra });

// ─── 1. CRÉDITO ──────────────────────────────────────────────────────────────
test('com crédito e sem time ativo → fonte "credito", uniforme à escolha', async () => {
  const { mod } = carregarCom((tabela) => {
    if (tabela === 'users') return semErro({ brilhante_creditos: 2 });
    if (tabela === 'team_members') return semErro([]); // não é membro de time ativo
    return semErro(null);
  });
  const d = await mod.temDireito(PESSOA);
  assert.equal(d.fonte, 'credito');
  assert.equal(d.creditos, 2);
  assert.equal(d.kitId, null, 'quem tem crédito escolhe o uniforme — a rota não impõe nenhum');
  assert.equal(d.teamId, null);
});

// ─── 2. TIME ─────────────────────────────────────────────────────────────────
test('membro de time com pacote ativo e sem a sua ainda → fonte "time", uniforme do time', async () => {
  const { mod } = carregarCom((tabela, estado) => {
    if (tabela === 'users') return semErro({ brilhante_creditos: 0 });
    if (tabela === 'team_members') {
      return semErro([{ team_id: TIME, teams: { id: TIME, brilhante_ativo: true, brilhante_kit: 'dark-purple', brilhante_limite: 25 } }]);
    }
    if (tabela === 'brilhantes_time') {
      return estado.count ? semErro(null, { count: 7 }) : semErro(null); // 7 geradas, esta pessoa ainda não
    }
    return semErro(null);
  });
  const d = await mod.temDireito(PESSOA);
  assert.equal(d.fonte, 'time');
  assert.equal(d.teamId, TIME);
  assert.equal(d.kitId, 'dark-purple', 'no pacote o uniforme é o que o dono fixou');
});

test('o time manda à frente do crédito — o direito do time é grátis e tem tecto', async () => {
  const { mod } = carregarCom((tabela, estado) => {
    if (tabela === 'users') return semErro({ brilhante_creditos: 2 });
    if (tabela === 'team_members') {
      return semErro([{ team_id: TIME, teams: { id: TIME, brilhante_ativo: true, brilhante_kit: 'dark-gold', brilhante_limite: 25 } }]);
    }
    if (tabela === 'brilhantes_time') return estado.count ? semErro(null, { count: 0 }) : semErro(null);
    return semErro(null);
  });
  const d = await mod.temDireito(PESSOA);
  assert.equal(d.fonte, 'time');
  assert.equal(d.opcoes.length, 2, 'o crédito continua na mesa — a rota usa-o se a pessoa pedir outro uniforme');
  assert.equal(d.opcoes[1].fonte, 'credito');
});

// ─── 3. SEM DIREITO ──────────────────────────────────────────────────────────
test('sem crédito e sem time ativo → sem direito', async () => {
  const { mod } = carregarCom((tabela) => {
    if (tabela === 'users') return semErro({ brilhante_creditos: 0 });
    if (tabela === 'team_members') return semErro([]);
    return semErro(null);
  });
  const d = await mod.temDireito(PESSOA);
  assert.equal(d.fonte, null);
  assert.equal(d.creditos, 0);
  assert.deepEqual(d.opcoes, []);
});

test('já tem a sua Brilhante nesse time → não gera outra', async () => {
  const { mod } = carregarCom((tabela, estado) => {
    if (tabela === 'users') return semErro({ brilhante_creditos: 0 });
    if (tabela === 'team_members') {
      return semErro([{ team_id: TIME, teams: { id: TIME, brilhante_ativo: true, brilhante_kit: 'dark-gold', brilhante_limite: 25 } }]);
    }
    if (tabela === 'brilhantes_time') {
      return estado.count ? semErro(null, { count: 3 }) : semErro({ user_id: PESSOA }); // já tem linha
    }
    return semErro(null);
  });
  const d = await mod.temDireito(PESSOA);
  assert.equal(d.fonte, null, 'uma Brilhante por pessoa por time (PK de brilhantes_time)');
});

test('time cheio (25 de 25) → mais ninguém entra no pacote', async () => {
  const { mod } = carregarCom((tabela, estado) => {
    if (tabela === 'users') return semErro({ brilhante_creditos: 0 });
    if (tabela === 'team_members') {
      return semErro([{ team_id: TIME, teams: { id: TIME, brilhante_ativo: true, brilhante_kit: 'dark-gold', brilhante_limite: 25 } }]);
    }
    if (tabela === 'brilhantes_time') return estado.count ? semErro(null, { count: 25 }) : semErro(null);
    return semErro(null);
  });
  const d = await mod.temDireito(PESSOA);
  assert.equal(d.fonte, null, 'o tecto de 25 é o que a casa vendeu — passar dele é dinheiro que ninguém pagou');
});

// ─── 4. MIGRAÇÃO AUSENTE (o caso que corre HOJE, antes de o Pedro aplicar) ───
test('coluna brilhante_creditos ainda não existe → ninguém tem direito (fail-safe)', async () => {
  const { mod } = carregarCom((tabela) => {
    if (tabela === 'users') {
      return { data: null, error: { message: 'column users.brilhante_creditos does not exist' } };
    }
    return semErro([]);
  });
  const d = await mod.temDireito(PESSOA);
  assert.equal(d.fonte, null, 'sem a migração 054 ninguém gera — o lado seguro do erro é não gastar dinheiro');
  assert.equal(d.creditos, 0);
});

test('tabela brilhantes_time ainda não existe → o crédito sozinho continua a valer', async () => {
  const { mod } = carregarCom((tabela) => {
    if (tabela === 'users') return semErro({ brilhante_creditos: 1 });
    if (tabela === 'team_members') {
      return { data: null, error: { message: 'relation "public.brilhantes_time" does not exist' } };
    }
    return semErro(null);
  });
  const d = await mod.temDireito(PESSOA);
  assert.equal(d.fonte, 'credito', 'a parte que funciona continua a funcionar');
  assert.equal(d.creditos, 1);
});

test('erro REAL do banco (não é migração em falta) sobe — não vira "sem direito" em silêncio', async () => {
  const { mod } = carregarCom((tabela) => {
    if (tabela === 'users') return { data: null, error: { message: 'connection terminated unexpectedly' } };
    return semErro([]);
  });
  await assert.rejects(() => mod.temDireito(PESSOA), /connection terminated/);
});

// ─── Débito: só depois de a figurinha existir ────────────────────────────────
test('debitar("time") grava a linha do pacote com o custo real', async () => {
  let gravado = null;
  const { mod } = carregarCom((tabela, estado) => {
    if (tabela === 'brilhantes_time') { gravado = estado.linha; return semErro(null); }
    return semErro(null);
  });
  const ok = await mod.debitar(
    { fonte: 'time', teamId: TIME },
    { userId: PESSOA, kitId: 'dark-gold', avatarUrl: 'https://x/y.png', custoCents: 11.2 },
  );
  assert.equal(ok, true);
  assert.equal(gravado.team_id, TIME);
  assert.equal(gravado.user_id, PESSOA);
  assert.equal(gravado.custo_cents, 11, 'o custo REAL da fal, arredondado — é o que o Gabinete vai somar');
});

test('debitar("credito") tira 1 e nunca vai a negativo', async () => {
  let patch = null;
  const { mod } = carregarCom((tabela, estado) => {
    if (tabela === 'users' && estado.patch) { patch = estado.patch; return semErro(null); }
    if (tabela === 'users') return semErro({ brilhante_creditos: 0 });
    return semErro(null);
  });
  await mod.debitar({ fonte: 'credito' }, { userId: PESSOA, kitId: 'dark-gold', custoCents: 11 });
  assert.equal(patch.brilhante_creditos, 0, 'zero menos um continua zero');
});

test('debitar que falha NÃO derruba nada — a pessoa fica com a figurinha', async () => {
  const { mod } = carregarCom(() => { throw new Error('banco fora do ar'); });
  const ok = await mod.debitar({ fonte: 'credito' }, { userId: PESSOA, kitId: 'dark-gold', custoCents: 11 });
  assert.equal(ok, false, 'devolve false e segue: cobrar sem entregar seria pior do que entregar sem cobrar');
});
