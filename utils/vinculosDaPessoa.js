// Futty v2.0 — Os times da pessoa (os vínculos com papel, o time embutido e onde ela só organiza), guardados 60 s por instância.
//
// É a PRIMEIRA ida ao banco do Início e da Resenha, e todo o resto espera por ela (os jogos dependem dos times; a presença, dos
// jogos). Os times de alguém mudam quando ele entra, sai, é promovido, ou o time muda de nome/escudo — coisa de vez em quando, não de
// segundo em segundo. Guardar a leitura tira uma onda inteira da fila das duas telas que mais se abrem.
//
// A regra que deixa isto seguro: QUALQUER escrita em `team_members` ou `teams` feita por este motor (entrar por convite, aprovar
// pedido, sair, remover, mudar papel, editar o time, excluir conta…) esvazia o cache inteiro na hora — antes e depois de a escrita
// voltar, para nenhuma leitura que viajava no meio se guardar velha. O gancho fica no cliente do Supabase (o mesmo objeto que todas
// as rotas usam), então nenhuma rota precisa lembrar de avisar. O que escapa é a escrita feita por OUTRA instância do Cloud Run: essa
// aparece aqui passados 60 s, no pedido seguinte (e quem é removido de um time continua barrado na hora — as rotas do time conferem
// o vínculo no banco).
//
// Vencidos os 60 s, a leitura conhecida ainda sai na hora (uma vez, por até 30 min) enquanto a nova é buscada por trás (utils/cacheQuente.js).
const { supabase } = require('./db');
const { criarCache } = require('./cacheQuente');

const TTL_MS = 60_000;
const VELHO_ATE_MS = 30 * 60_000;
const TABELAS_QUE_MUDAM_OS_VINCULOS = new Set(['team_members', 'teams']);

const cache = criarCache({
  nome: 'vinculos',
  ttlMs: TTL_MS,
  max: 5000,
  servirVelhoSe: (valor) => Date.now() - valor.lidoEm < VELHO_ATE_MS,
});

/** Embrulha o resultado de uma escrita (thenable do PostgREST): avisa quando ela voltar. */
function depoisDaEscrita(builder, avisar) {
  if (!builder || typeof builder !== 'object') return builder;
  const then0 = typeof builder.then === 'function' ? builder.then.bind(builder) : null;
  if (then0) {
    builder.then = (ok, falha) => then0((v) => { avisar(); return ok ? ok(v) : v; }, (e) => { avisar(); if (falha) return falha(e); throw e; });
  }
  // O banco falso dos testes executa no maybeSingle/single (o de verdade devolve o próprio builder, e o then acima cobre).
  for (const nome of ['maybeSingle', 'single']) {
    const f0 = builder[nome];
    if (typeof f0 !== 'function') continue;
    builder[nome] = (...a) => {
      const r = f0.apply(builder, a);
      return r && typeof r.then === 'function' && r !== builder ? Promise.resolve(r).finally(avisar) : r;
    };
  }
  return builder;
}

/** Liga o aviso de escrita no cliente do Supabase. Idempotente (um embrulho por cliente). */
function vigiarEscritas(cliente) {
  if (!cliente || typeof cliente.from !== 'function' || cliente.__vigiaVinculos) return;
  cliente.__vigiaVinculos = true;
  const from0 = cliente.from.bind(cliente);
  cliente.from = (tabela) => {
    const qb = from0(tabela);
    if (!TABELAS_QUE_MUDAM_OS_VINCULOS.has(tabela)) return qb;
    for (const metodo of ['insert', 'update', 'upsert', 'delete']) {
      const m0 = qb[metodo];
      if (typeof m0 !== 'function') continue;
      qb[metodo] = (...a) => {
        cache.limpar();
        return depoisDaEscrita(m0.apply(qb, a), () => cache.limpar());
      };
    }
    return qb;
  };
}

vigiarEscritas(supabase);

/**
 * Os vínculos da pessoa, do cache ou de `ler()` (quem lê é services/inicio.js#obterVinculosDaPessoa). `ler` devolve
 * { vinculos, soOrganiza }; um erro de leitura não fica guardado (o próximo pedido tenta de novo).
 */
function vinculosDaPessoa(userId, ler) {
  return cache.obter(userId, async () => ({ ...(await ler()), lidoEm: Date.now() }));
}

module.exports = { vinculosDaPessoa, vigiarEscritas, esquecerVinculos: () => cache.limpar(), TTL_MS };
