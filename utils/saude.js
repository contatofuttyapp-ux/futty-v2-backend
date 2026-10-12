// Futty v2.0 — GET /health: o "estou vivo" público, fora de /api.
//
// É uma URL pública do Cloud Run, então qualquer um pode chamá-la em rajada. Por isso:
//   · a ligação ao banco é conferida no máximo UMA vez a cada 30 s (e quem chega com a conferência em
//     curso espera a mesma, nunca abre uma segunda): 100 chamadas seguidas tocam o banco uma vez;
//   · a conferência é um count 'planned' (estimativa do planner, não varre a tabela);
//   · o texto de erro do banco fica no log do motor e NUNCA vai na resposta.
// Quem confere o motor de fora (checagem de uptime, Freaky) continua usando /api/health, que nem toca o banco.
// A resposta é enxuta de propósito: só `status`. Uptime, nome do serviço, hora do servidor e o estado "do Supabase" dizem a quem
// olha de fora há quanto tempo o motor subiu (quando entrou uma revisão nova) e de que banco ele depende — detalhe interno, que só o
// próprio sistema precisa. Ninguém de dentro lê esse corpo (o app, a telemetria e as bancadas usam /api/health). `ok` = o motor
// responde e o banco também; `degradado` = o motor responde e o banco não (sempre HTTP 200, como antes).
const TTL_DO_BANCO_MS = 30 * 1000;

/**
 * @param {{ supabase: object, agora?: () => number, ttlMs?: number }} opcoes `agora` e `ttlMs` existem para o teste.
 * @returns {import('express').RequestHandler}
 */
function criarSaude({ supabase, agora = Date.now, ttlMs = TTL_DO_BANCO_MS }) {
  let guardado = null; // { em, estado } — a última conferência
  let emCurso = null; // a conferência que está rodando agora, se houver

  async function conferirBanco() {
    try {
      const { error } = await supabase.from('users').select('id', { count: 'planned', head: true });
      if (error) console.error('[Futty] /health: o banco respondeu erro:', String(error.message).slice(0, 300));
      return error ? 'error' : 'connected';
    } catch (err) {
      console.error('[Futty] /health: o banco não respondeu:', String(err?.message).slice(0, 300));
      return 'error';
    }
  }

  function estadoDoBanco() {
    if (guardado && agora() - guardado.em < ttlMs) return Promise.resolve(guardado.estado);
    if (!emCurso) {
      emCurso = conferirBanco()
        .then((estado) => {
          guardado = { em: agora(), estado };
          return estado;
        })
        .finally(() => { emCurso = null; });
    }
    return emCurso;
  }

  return async (req, res, next) => {
    try {
      res.json({ status: (await estadoDoBanco()) === 'connected' ? 'ok' : 'degradado' });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { criarSaude, TTL_DO_BANCO_MS };
