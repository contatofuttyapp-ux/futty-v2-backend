// Futty v2.0 — Supabase falso EM MEMÓRIA para os testes de compras (Pagamentos P1).
//
// Diferente do falso de tests/direito-brilhante.test.js (que responde por função), este
// guarda as linhas de verdade: inserir, ler de volta, atualizar e contar batem entre si, e o
// índice único de `compras` (loja, transacao_id) dispara 23505 como no Postgres. É o que
// deixa provar a idempotência sem banco.
//
// Cobre só o que utils/compras.js, routes/compras.js e a leitura do Gabinete usam:
// from().select/insert/update/delete + eq/neq/in/is/gt/gte/lt/lte/order/limit +
// maybeSingle/single/await, e rpc('creditar_brilhante').
const crypto = require('node:crypto');

const UNICOS_PADRAO = { compras: [['loja', 'transacao_id']], convite_codigos: [['codigo'], ['convite_id']] };

// Os embeds do PostgREST que algum teste usa (`select('codigo, convites ( id, team_id )')`): tabela → { nome do embed →
// onde está a outra ponta }. Só a forma "muitos-para-um" (a linha ganha o objeto, ou null). Rodada 29H: o link curto do convite.
const RELACOES_PADRAO = { convite_codigos: { convites: { tabela: 'convites', local: 'convite_id', remota: 'id' } } };

// Coluna com caminho pontuado ("teams.brilhante_ativo", o filtro sobre um embed do PostgREST) lê dentro da linha.
const valorDe = (linha, coluna) => (coluna.includes('.') ? coluna.split('.').reduce((o, k) => o?.[k], linha) : linha[coluna]);

// `tetoLinhas` (Rodada 29Y): o PostgREST nunca devolve mais de N linhas por resposta (o Supabase corta em 1.000), com ou sem .range.
// Sem a opção, o falso devolve tudo, como antes. O teste de contagem passa 1000 para simular o teto de verdade.
function criarSupabaseFalso(inicial = {}, { unicos = UNICOS_PADRAO, semRpc = false, falhar = null, relacoes = RELACOES_PADRAO, tetoLinhas = Infinity } = {}) {
  const tabelas = {};
  for (const [nome, linhas] of Object.entries(inicial)) tabelas[nome] = linhas.map((l) => ({ ...l }));
  const linhasDe = (nome) => (tabelas[nome] ||= []);

  function builder(tabela) {
    const e = { op: 'select', filtros: [], ordem: null, limite: null, count: false, head: false, retorna: false };
    const passa = (l) => e.filtros.every((f) => f(l));

    function executar() {
      const erroForcado = falhar && falhar(tabela, e.op, e);
      if (erroForcado) return { data: null, error: erroForcado };
      const todas = linhasDe(tabela);
      if (e.op === 'insert') {
        const novas = e.linhas.map((l) => ({ id: crypto.randomUUID(), criada_em: new Date().toISOString(), ...l }));
        for (const n of novas) {
          for (const cols of unicos[tabela] || []) {
            if (todas.some((l) => cols.every((c) => l[c] === n[c]))) {
              return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint (${cols.join(',')})` } };
            }
          }
        }
        todas.push(...novas);
        return { data: e.retorna ? novas.map((l) => ({ ...l })) : null, error: null };
      }
      if (e.op === 'upsert') {
        const saida = [];
        for (const nova of e.linhas) {
          const i = todas.findIndex((l) => e.onConflict.every((c) => l[c] === nova[c]));
          if (i >= 0) {
            if (!e.ignorarDuplicadas) Object.assign(todas[i], nova);
            saida.push({ ...todas[i] });
          } else {
            const criada = { id: crypto.randomUUID(), ...nova };
            todas.push(criada);
            saida.push({ ...criada });
          }
        }
        return { data: e.retorna ? saida : null, error: null };
      }
      let alvo = todas.filter(passa);
      if (e.op === 'update') {
        for (const l of alvo) Object.assign(l, e.patch);
        return { data: e.retorna ? alvo.map((l) => ({ ...l })) : null, error: null };
      }
      if (e.op === 'delete') {
        tabelas[tabela] = todas.filter((l) => !passa(l));
        return { data: null, error: null };
      }
      if (e.ordens?.length) {
        // Vários .order() encadeados = ordem composta, como o PostgREST (order=created_at.desc,id.asc).
        alvo = [...alvo].sort((a, b) => {
          for (const { col, asc } of e.ordens) {
            const c = (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1);
            if (c) return c;
          }
          return 0;
        });
      }
      if (e.faixa) alvo = alvo.slice(e.faixa[0], e.faixa[1] + 1);
      if (e.limite != null) alvo = alvo.slice(0, e.limite);
      if (alvo.length > tetoLinhas) alvo = alvo.slice(0, tetoLinhas);
      for (const [nome, def] of Object.entries(relacoes[tabela] || {})) {
        if (new RegExp(`\\b${nome}\\s*\\(`).test(e.cols || '')) {
          alvo = alvo.map((l) => ({ ...l, [nome]: linhasDe(def.tabela).find((r) => r[def.remota] === l[def.local]) || null }));
        }
      }
      return { data: e.head ? null : alvo.map((l) => ({ ...l })), error: null, count: e.count ? alvo.length : undefined };
    }

    const umSo = (obrigatorio) => async () => {
      const r = executar();
      if (r.error) return r;
      const lista = r.data || [];
      if (lista.length > 1) return { data: null, error: { message: 'mais de uma linha' } };
      if (!lista.length && obrigatorio) return { data: null, error: { code: 'PGRST116', message: 'nenhuma linha' } };
      return { data: lista[0] || null, error: null };
    };

    const api = {
      select(cols, opts) {
        if (e.op !== 'select') e.retorna = true;
        else e.cols = String(cols ?? '');
        if (opts?.count) e.count = true;
        if (opts?.head) e.head = true;
        return api;
      },
      insert(linhas) { e.op = 'insert'; e.linhas = Array.isArray(linhas) ? linhas : [linhas]; return api; },
      update(patch) { e.op = 'update'; e.patch = patch; return api; },
      upsert(linhas, opts = {}) {
        e.op = 'upsert';
        e.linhas = Array.isArray(linhas) ? linhas : [linhas];
        e.onConflict = String(opts.onConflict || 'id').split(',').map((s) => s.trim());
        e.ignorarDuplicadas = !!opts.ignoreDuplicates;
        return api;
      },
      delete() { e.op = 'delete'; return api; },
      // `colunas`: os nomes filtrados com eq(), para um teste simular "esta coluna não existe" (falhar(tabela, op, e)).
      eq(c, v) { (e.colunas ||= []).push(c); e.filtros.push((l) => valorDe(l, c) === v); return api; },
      neq(c, v) { e.filtros.push((l) => l[c] !== v); return api; },
      in(c, vs) { e.filtros.push((l) => vs.includes(l[c])); return api; },
      is(c, v) { e.filtros.push((l) => (l[c] ?? null) === v); return api; },
      // `.or('data.gte.2026-10-01T00:00:00Z,data.is.null')`: só a forma `coluna.operador.valor` separada por vírgula.
      or(expr) {
        const operadores = {
          gte: (a, b) => a >= b, gt: (a, b) => a > b, lte: (a, b) => a <= b, lt: (a, b) => a < b,
          eq: (a, b) => String(a) === b, neq: (a, b) => String(a) !== b,
          is: (a, b) => (b === 'null' ? (a ?? null) === null : String(a) === b),
        };
        const condicoes = String(expr).split(/,(?=\w+\.(?:gte|gt|lte|lt|eq|neq|is)\.)/).map((parte) => {
          const m = parte.match(/^(\w+)\.(gte|gt|lte|lt|eq|neq|is)\.(.*)$/);
          if (!m) throw new Error(`or() do Supabase falso não entende "${parte}"`);
          return (l) => (l[m[1]] == null && m[2] !== 'is' ? false : operadores[m[2]](l[m[1]], m[3]));
        });
        e.filtros.push((l) => condicoes.some((c) => c(l)));
        return api;
      },
      // `.not('coluna', 'is', null)` e `.not('coluna', 'eq', valor)`: as duas formas que o motor usa.
      not(c, op, v) { e.filtros.push((l) => (op === 'is' ? (l[c] ?? null) !== v : l[c] !== v)); return api; },
      gt(c, v) { e.filtros.push((l) => l[c] > v); return api; },
      gte(c, v) { e.filtros.push((l) => l[c] >= v); return api; },
      lt(c, v) { e.filtros.push((l) => l[c] < v); return api; },
      lte(c, v) { e.filtros.push((l) => l[c] <= v); return api; },
      order(col, { ascending = true } = {}) { (e.ordens ||= []).push({ col, asc: ascending }); return api; },
      range(de, ate) { e.faixa = [de, ate]; return api; },
      limit(n) { e.limite = n; return api; },
      maybeSingle: umSo(false),
      single: umSo(true),
      then(ok, falha) { return Promise.resolve().then(executar).then(ok, falha); },
    };
    return api;
  }

  const cliente = { from: builder };
  if (!semRpc) {
    cliente.rpc = async (nome, args) => {
      if (nome !== 'creditar_brilhante') return { data: null, error: { code: 'PGRST202', message: `função ${nome} não existe` } };
      const u = linhasDe('users').find((l) => l.id === args.p_user);
      if (!u) return { data: null, error: null };
      u.brilhante_creditos = Math.max(0, (Number(u.brilhante_creditos) || 0) + args.p_qtd);
      return { data: u.brilhante_creditos, error: null };
    };
  }
  return { cliente, tabelas };
}

module.exports = { criarSupabaseFalso };
