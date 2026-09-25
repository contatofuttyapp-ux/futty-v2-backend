// Futty v2.0 — Quais arquivos do bucket `avatars` já não servem a ninguém (Rodada 28, bloco G).
//
// Puro: quem lista o bucket e lê o banco é scripts/limpar-orfaos.js; aqui só se decide. A limpeza da
// foto antiga roda DEPOIS da resposta (Rodada 27) e o Cloud Run sem "CPU sempre alocada" pode deixar
// esse trabalho pela metade — daí as sobras. Regras, todas do lado seguro:
//   · órfão = nenhuma linha do banco aponta para ele (fotos, originais, figurinhas, slots, histórico,
//     pacote do time, logo do time — ver REFERENCIAS em scripts/limpar-orfaos.js);
//   · nada com menos de 1 dia (pode ser um upload ou uma faxina ainda em curso);
//   · tmp/ é temporário por natureza (as passadas da geração): passou de 1 hora, é sobra;
//   · objeto sem data não é tocado — melhor sobrar do que apagar o que não se sabe de quando é.

const UM_DIA_MS = 24 * 60 * 60 * 1000;
const UMA_HORA_MS = 60 * 60 * 1000;

/**
 * @param {{ caminho: string, criadoEm?: string, tamanho?: number }[]} objetos   tudo o que há no bucket
 * @param {Iterable<string>} referenciados   caminhos dentro do bucket que o banco conhece
 * @returns os objetos órfãos, na ordem em que vieram
 */
function acharOrfaos(objetos, referenciados, { agora = Date.now() } = {}) {
  const conhecidos = new Set(referenciados);
  return (objetos || []).filter((o) => {
    if (!o?.caminho || o.caminho.endsWith('.emptyFolderPlaceholder')) return false;
    if (conhecidos.has(o.caminho)) return false;
    const quando = Date.parse(o.criadoEm || '');
    if (!Number.isFinite(quando)) return false;
    const idadeMinima = o.caminho.startsWith('tmp/') ? UMA_HORA_MS : UM_DIA_MS;
    return agora - quando >= idadeMinima;
  });
}

/** Órfãos agrupados por pasta de 1º nível, com a soma de bytes — o resumo que o dono lê. */
function resumirPorPasta(orfaos) {
  const porPasta = {};
  for (const o of orfaos) {
    const pasta = o.caminho.includes('/') ? o.caminho.split('/')[0] : '(raiz)';
    const p = porPasta[pasta] || (porPasta[pasta] = { pasta, arquivos: 0, bytes: 0 });
    p.arquivos += 1;
    p.bytes += Number(o.tamanho) || 0;
  }
  return Object.values(porPasta).sort((a, b) => b.bytes - a.bytes);
}

module.exports = { acharOrfaos, resumirPorPasta, UM_DIA_MS, UMA_HORA_MS };
