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
    const estado = { tabela, filtros: {}, count: false, cols: '' };
    const resolver = () => {
      chamadas.push({ tabela, filtros: { ...estado.filtros }, count: estado.count, cols: estado.cols });
      return respostas(tabela, estado);
    };
    const api = {
      select(cols, opts) { estado.cols = cols || ''; if (opts?.count) estado.count = true; return api; },
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

// ─── 2B. PACOTE COM SALDO (RODADAS 21/22, migração 059) ──────────────────────
// O pacote passou a dar 5 gerações por jogador (era 1): `geracoes` conta
// quantas essa pessoa já usou NESTE time, e o direito só acaba quando bate no
// `teams.brilhante_por_jogador`.
test('pacote com 4 de 5 gerações usadas → ainda tem direito, restantes=1', async () => {
  const { mod } = carregarCom((tabela, estado) => {
    if (tabela === 'users') return semErro({ brilhante_creditos: 0 });
    if (tabela === 'team_members') {
      return semErro([{ team_id: TIME, teams: { id: TIME, brilhante_ativo: true, brilhante_kit: 'dark-gold', brilhante_limite: 25, brilhante_por_jogador: 5 } }]);
    }
    if (tabela === 'brilhantes_time') {
      return estado.count ? semErro(null, { count: 5 }) : semErro({ user_id: PESSOA, geracoes: 4 });
    }
    return semErro(null);
  });
  const d = await mod.temDireito(PESSOA);
  assert.equal(d.fonte, 'time');
  assert.equal(d.restantes, 1, 'usou 4 de 5 — resta 1');
});

test('pacote com as 5 gerações usadas → sem direito (a 6ª é recusada)', async () => {
  const { mod } = carregarCom((tabela, estado) => {
    if (tabela === 'users') return semErro({ brilhante_creditos: 0 });
    if (tabela === 'team_members') {
      return semErro([{ team_id: TIME, teams: { id: TIME, brilhante_ativo: true, brilhante_kit: 'dark-gold', brilhante_limite: 25, brilhante_por_jogador: 5 } }]);
    }
    if (tabela === 'brilhantes_time') {
      return estado.count ? semErro(null, { count: 5 }) : semErro({ user_id: PESSOA, geracoes: 5 });
    }
    return semErro(null);
  });
  const d = await mod.temDireito(PESSOA);
  assert.equal(d.fonte, null, 'as 5 gerações do pacote já foram usadas — nada de uma 6ª');
  assert.equal(d.restantes, 0);
});

test('refazer (2ª a 5ª geração) não esbarra no tecto de 25 JOGADORES — só um jogador novo esbarra', async () => {
  // Time já tem 25 jogadores (tecto batido), mas a pessoa já é UM DELES (só
  // usou 1 das 5) — refazer não é "mais um jogador", é a mesma vaga de novo.
  const { mod } = carregarCom((tabela, estado) => {
    if (tabela === 'users') return semErro({ brilhante_creditos: 0 });
    if (tabela === 'team_members') {
      return semErro([{ team_id: TIME, teams: { id: TIME, brilhante_ativo: true, brilhante_kit: 'dark-gold', brilhante_limite: 25, brilhante_por_jogador: 5 } }]);
    }
    if (tabela === 'brilhantes_time') {
      return estado.count ? semErro(null, { count: 25 }) : semErro({ user_id: PESSOA, geracoes: 1 });
    }
    return semErro(null);
  });
  const d = await mod.temDireito(PESSOA);
  assert.equal(d.fonte, 'time', 'time cheio não pode travar quem já está dentro dele');
  assert.equal(d.restantes, 4);
});

test('migração 059 (coluna geracoes) ainda não rodou → comportamento antigo: 1 linha = já usou a única que se sabia dar', async () => {
  const { mod } = carregarCom((tabela, estado) => {
    if (tabela === 'users') return semErro({ brilhante_creditos: 0 });
    if (tabela === 'team_members') {
      // brilhante_por_jogador também ausente (mesma migração) — 1 é o fail-safe.
      return semErro([{ team_id: TIME, teams: { id: TIME, brilhante_ativo: true, brilhante_kit: 'dark-gold', brilhante_limite: 25 } }]);
    }
    if (tabela === 'brilhantes_time') {
      if (estado.count) return semErro(null, { count: 5 });
      // A 1ª tentativa (select user_id, geracoes) falha — coluna ausente; o
      // fallback (select user_id) tem de achar a linha na mesma.
      if (String(estado.cols).includes('geracoes')) {
        return { data: null, error: { message: 'column brilhantes_time.geracoes does not exist' } };
      }
      return semErro({ user_id: PESSOA });
    }
    return semErro(null);
  });
  const d = await mod.temDireito(PESSOA);
  assert.equal(d.fonte, null, 'sem a 059, uma linha existente ainda esgota o direito — nunca dá 3 de graça por engano');
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
test('debitar("time") na 1ª vez grava geracoes=1 (uniforme novo debita 1)', async () => {
  let gravado = null;
  const { mod } = carregarCom((tabela, estado) => {
    if (tabela === 'brilhantes_time') {
      // A leitura prévia (geracoesNoTime) não acha linha nenhuma — 1ª geração.
      if (estado.count) return semErro(null, { count: 0 });
      if (estado.linha) { gravado = estado.linha; return semErro(null); } // o upsert
      return semErro(null); // a leitura prévia
    }
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
  assert.equal(gravado.geracoes, 1, 'RODADA 21 — uniforme novo debita 1 geração');
});

test('debitar("time") na 2ª vez SOMA — geracoes 1 → 2, nunca substitui', async () => {
  let gravado = null;
  const { mod } = carregarCom((tabela, estado) => {
    if (tabela === 'brilhantes_time') {
      if (estado.linha) { gravado = estado.linha; return semErro(null); } // o upsert
      return semErro({ user_id: PESSOA, geracoes: 1, custo_cents: 11 }); // a leitura prévia: já usou 1
    }
    return semErro(null);
  });
  await mod.debitar({ fonte: 'time', teamId: TIME }, { userId: PESSOA, kitId: 'dark-gold', avatarUrl: 'https://x/y2.png', custoCents: 12.4 });
  assert.equal(gravado.geracoes, 2, 'refazer soma sobre o que já tinha, não reseta para 1');
  // RODADA 28 (achado da Rodada 22): o custo também SOMA — antes ficava só o da última geração.
  assert.equal(gravado.custo_cents, 23, `11 + 12 cêntimos devia dar 23, deu ${gravado.custo_cents}`);
});

test('somarCusto: soma o que se sabe; sem custo nenhum fica null (o Gabinete conta à parte)', async () => {
  const { mod } = carregarCom(() => semErro(null));
  assert.equal(mod.somarCusto(null, null), null);
  assert.equal(mod.somarCusto(null, 11.2), 11);
  assert.equal(mod.somarCusto(11, null), 11, 'geração sem header da fal não apaga o que já estava somado');
  assert.equal(mod.somarCusto(11, 12.4), 23);
});

test('debitar("time") sem a migração 059 (coluna geracoes ausente) NÃO tenta escrevê-la', async () => {
  let gravado = null;
  const { mod } = carregarCom((tabela, estado) => {
    if (tabela === 'brilhantes_time') {
      if (estado.linha) { gravado = estado.linha; return semErro(null); } // o upsert
      // 1ª leitura (select user_id, geracoes) falha — coluna ausente; o
      // fallback (select user_id, sem geracoes) tem de continuar a funcionar.
      if (String(estado.cols).includes('geracoes')) {
        return { data: null, error: { message: 'column brilhantes_time.geracoes does not exist' } };
      }
      return semErro({ user_id: PESSOA });
    }
    return semErro(null);
  });
  const ok = await mod.debitar({ fonte: 'time', teamId: TIME }, { userId: PESSOA, kitId: 'dark-gold', avatarUrl: 'https://x/y3.png', custoCents: 11 });
  assert.equal(ok, true, 'sem a 059 o débito continua funcionando (comportamento antigo)');
  assert.equal('geracoes' in gravado, false, 'escrever uma coluna que não existe rebentaria o upsert inteiro');
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

// ─── Presente do criador (RODADA 21: 1 → 3) ──────────────────────────────────
test('presentearCriador dá 3 créditos (era 1) a quem cria o 1º time', async () => {
  let patch = null;
  const { mod } = carregarCom((tabela, estado) => {
    if (tabela === 'users' && estado.patch) { patch = estado.patch; return semErro(null); }
    if (tabela === 'users') return semErro({ brilhante_creditos: 0, presente_criador_em: null });
    return semErro(null);
  });
  const deu = await mod.presentearCriador(PESSOA);
  assert.equal(deu, true);
  assert.equal(patch.brilhante_creditos, 3, 'RODADA 21 — o presente subiu de 1 para 3');
  assert.equal(mod.PRESENTE_CRIADOR_CREDITOS, 3);
});

test('presentearCriador não dá 2 vezes — quem já recebeu não ganha de novo', async () => {
  const { mod } = carregarCom((tabela) => {
    if (tabela === 'users') return semErro({ brilhante_creditos: 3, presente_criador_em: '2026-09-24T00:00:00.000Z' });
    return semErro(null);
  });
  const deu = await mod.presentearCriador(PESSOA);
  assert.equal(deu, false, 'presente_criador_em já preenchido — é uma vez na vida');
});
