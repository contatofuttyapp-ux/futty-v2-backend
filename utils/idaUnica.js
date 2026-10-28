// Futty v2.0 — Uma rota quente numa ida só ao banco: a função do Postgres (migração 090) que faz, lá dentro, as leituras que o motor
// fazia uma a uma.
//
// Medido em produção: cada consulta ao Supabase custa ~32 ms dentro dele + ~30 ms de ida e volta, e o dobro quando várias chegam juntas.
// O Início fazia ~28 consultas em ondas (~1 s). A função devolve as MESMAS linhas que essas consultas devolviam, num JSON só; quem monta
// a resposta continua sendo o motor, com as regras de sempre.
//
// A função pode ainda não existir (o motor sobe antes de o dono rodar a 090) ou falhar: aí a rota segue pelo caminho antigo, igual a
// antes, e o log ganha UMA linha de aviso. A ausência fica lembrada por 1 minuto, para não pagar uma ida perdida a cada pedido; depois
// da migração, o motor passa a usar a função sozinho.
const LEMBRAR_FALTA_MS = 60 * 1000;
// A versão do formato que o motor entende. Uma função de outra versão (mais nova ou mais velha) cai no caminho antigo.
const VERSAO = 1;

/** O PostgREST diz que a função não existe (PGRST202) ou o Postgres (42883)? */
const funcaoAusente = (erro) => /PGRST202|42883/.test(String(erro?.code || '')) || /could not find the function|does not exist/i.test(String(erro?.message || ''));

/**
 * @param {string} nome a função do banco
 * @param {{ cliente: object, agora?: () => number, log?: { warn: Function, error: Function } }} o `cliente` = o supabase de quem chama
 *   (o de utils/db que a rota já guardou no require — assim os testes que trocam o banco por um falso trocam este também)
 */
function criarIdaUnica(nome, { cliente, agora = Date.now, log = console }) {
  let faltaAte = 0;
  let avisou = false;

  /** Chama a função; devolve o JSON dela, ou null (caminho antigo). Nunca lança. */
  async function chamar(args) {
    if (agora() < faltaAte) return null;
    try {
      if (typeof cliente?.rpc !== 'function') throw Object.assign(new Error('cliente sem rpc'), { code: 'PGRST202' });
      const { data, error } = await cliente.rpc(nome, args);
      if (error) throw error;
      if (!data || data.versao !== VERSAO) throw Object.assign(new Error(`a função ${nome} respondeu fora do formato ${VERSAO}`), { code: 'FORMATO' });
      avisou = false;
      return data;
    } catch (e) {
      if (funcaoAusente(e)) {
        faltaAte = agora() + LEMBRAR_FALTA_MS;
        if (!avisou) log.warn(`[ida-unica] a função ${nome} não existe no banco (migração 090) — a rota segue pelo caminho antigo.`);
        avisou = true;
      } else {
        log.error(`[ida-unica] ${nome} falhou — a rota segue pelo caminho antigo:`, String(e?.message || e).slice(0, 200));
      }
      return null;
    }
  }

  return { chamar, esquecer: () => { faltaAte = 0; avisou = false; } };
}

module.exports = { criarIdaUnica, funcaoAusente, VERSAO, LEMBRAR_FALTA_MS };
