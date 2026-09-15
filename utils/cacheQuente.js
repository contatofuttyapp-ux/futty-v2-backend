// Futty v2.0 — Cache em memória com dedupe de pedidos em voo e stale-while-revalidate
// (15-set, "Velocidade 7A").
//
// Primeiro relatório real do Diagnóstico (iPhone em Lisboa): no arranque frio o
// app dispara 3 pedidos em paralelo, os 3 chegam com os caches vazios e CADA UM
// pagava a mesma ida à rede — 3 × supabase.auth.getUser, 3 × download das
// suspensões. A "manada". Aqui, chamadas simultâneas com a mesma chave esperam a
// MESMA promessa: uma ida à rede só, dividida por quem chegou junto.
//
// O mesmo relatório mostrou picos isolados (inicio 783 ms, blocks 630 ms) no
// instante em que um cache de TTL curto vencia: o azarado da vez pagava o
// download inteiro. Regra agora: NENHUM pedido paga o vencimento de um cache. Se
// a entrada venceu mas existe, sai o valor velho NA HORA e a renovação corre por
// trás (uma de cada vez). Só espera quem não tem nada em cache.
//
// Vive só neste processo (nada distribuído): cada instância do Cloud Run tem o seu.

/**
 * @param {object} opcoes
 * @param {string} opcoes.nome    aparece nos logs
 * @param {number} opcoes.ttlMs   quanto tempo uma entrada vale como fresca
 * @param {number} [opcoes.max]   teto de entradas (sai a mais antiga)
 * @param {(valor) => boolean} [opcoes.guardarSe]  resultados que NÃO devem ficar
 *        em cache (ex.: sessão inválida) devolvem false — e apagam a entrada antiga
 * @param {(valor, chave) => boolean} [opcoes.servirVelhoSe]  quando uma entrada
 *        vencida ainda pode sair na hora (ex.: só se o token não venceu)
 */
function criarCache({ nome, ttlMs, max = 1000, guardarSe = () => true, servirVelhoSe = () => true }) {
  const entradas = new Map(); // chave -> { valor, em }
  const emVoo = new Map(); // chave -> promessa da ida à rede em curso

  function guardar(chave, valor) {
    entradas.delete(chave); // reinsere no fim: o Map guarda a ordem de inserção
    if (entradas.size >= max) entradas.delete(entradas.keys().next().value);
    entradas.set(chave, { valor, em: Date.now() });
  }

  function carregar(chave, buscar) {
    const promessa = new Promise((resolve) => resolve(buscar())).then(
      (valor) => {
        // Invalidaram (ou gravaram) enquanto isto viajava: o resultado já nasceu
        // velho. Quem estava esperando recebe o valor, mas ele não entra no cache.
        if (emVoo.get(chave) === promessa) {
          emVoo.delete(chave);
          if (guardarSe(valor)) guardar(chave, valor);
          else entradas.delete(chave);
        }
        return valor;
      },
      (erro) => {
        if (emVoo.get(chave) === promessa) emVoo.delete(chave);
        throw erro;
      },
    );
    emVoo.set(chave, promessa);
    return promessa;
  }

  return {
    async obter(chave, buscar) {
      const e = entradas.get(chave);
      if (e) {
        if (Date.now() - e.em < ttlMs) return e.valor;
        if (servirVelhoSe(e.valor, chave)) {
          if (!emVoo.has(chave)) {
            // Falhou a renovação: o valor velho fica, e o próximo pedido tenta de novo.
            carregar(chave, buscar).catch((erro) => console.error(`[cache ${nome}] renovação por trás falhou:`, erro.message));
          }
          return e.valor;
        }
      }
      return emVoo.get(chave) || carregar(chave, buscar);
    },
    /** Grava um valor já conhecido (quem acabou de escrever vê a própria escrita). */
    definir(chave, valor) {
      emVoo.delete(chave);
      guardar(chave, valor);
    },
    invalidar(chave) {
      emVoo.delete(chave);
      entradas.delete(chave);
    },
    /**
     * Apaga as entradas cujo valor bate com o predicado. As leituras em voo ainda
     * não têm valor para comparar, então nenhuma delas entra mais no cache.
     */
    invalidarSe(predicado) {
      emVoo.clear();
      for (const [chave, e] of entradas) {
        if (predicado(e.valor, chave)) entradas.delete(chave);
      }
    },
    limpar() {
      emVoo.clear();
      entradas.clear();
    },
  };
}

module.exports = { criarCache };
