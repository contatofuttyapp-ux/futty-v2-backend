// Futty v2.0 — Rodada 29I, bloco 3 (achado 102 + bancadas aprovadas pelo dono em 2-out): o escudo do time sem logo.
//
// UM controle: cor principal + segunda cor + padrão. Paleta FIXA de 12 cores nas duas pontas, 6 padrões = 864 escudos, todos
// legíveis em 84, 36 e 20 px (DESIGN/escudo-cores.html, DESIGN/escudo-padroes.html). Reprovados pelo dono e fora daqui: RGB livre,
// quadriculado, listras finas, pontinhos, gradiente. As chaves são as MESMAS do app (frontend/src/utils/escudo.js) e da regra do banco
// (migração 077). A cor principal continua em teams.cor; a chave antiga 'verde' sempre foi mostrada como roxo e segue valendo assim.
// Puro (sem banco), para testar no Node.

const PALETA = ['roxo', 'azul', 'ciano', 'gramado', 'lima', 'ouro', 'laranja', 'vermelho', 'rosa', 'vinho', 'grafite', 'preto'];
// As 4 chaves que a regra antiga do banco aceitava (001_schema): seguem gravadas nos times de hoje e valem sem a 077.
const CORES_ANTIGAS = ['verde', 'azul', 'vermelho', 'preto'];
const PADROES = ['solido', 'faixa', 'metade', 'listras', 'barra', 'aro'];

const MSG_COR_INVALIDA = 'Essa cor não está na paleta do escudo.';
const MSG_PADRAO_INVALIDO = 'Esse padrão de escudo não existe.';

/**
 * Lê o que veio do escudo no corpo de um PATCH e devolve { patch, erro }. Só entra no patch o que veio no corpo:
 *   cor            uma das 12 da paleta (ou uma das 4 antigas)
 *   escudo_cor2    uma das 12, ou null (= escudo de uma cor)
 *   escudo_padrao  um dos 6, ou null (= sólido)
 * `erro` é a frase para a tela (400).
 */
function lerEscudo(corpo = {}) {
  const patch = {};
  if ('cor' in corpo) {
    if (!PALETA.includes(corpo.cor) && !CORES_ANTIGAS.includes(corpo.cor)) return { patch: {}, erro: MSG_COR_INVALIDA };
    patch.cor = corpo.cor;
  }
  if ('escudo_cor2' in corpo) {
    const v = corpo.escudo_cor2 == null || corpo.escudo_cor2 === '' ? null : corpo.escudo_cor2;
    if (v !== null && !PALETA.includes(v)) return { patch: {}, erro: MSG_COR_INVALIDA };
    patch.escudo_cor2 = v;
  }
  if ('escudo_padrao' in corpo) {
    const v = corpo.escudo_padrao == null || corpo.escudo_padrao === '' ? null : corpo.escudo_padrao;
    if (v !== null && !PADROES.includes(v)) return { patch: {}, erro: MSG_PADRAO_INVALIDO };
    patch.escudo_padrao = v === 'solido' ? null : v; // sólido é o "sem padrão": guarda null
  }
  return { patch, erro: null };
}

/** A gravação esbarrou na falta da migração 077 (colunas novas, ou a regra antiga da cor que só aceita 4 chaves)? */
const erroDeEscudoSemMigracao = (erro) => !!erro && /escudo_cor2|escudo_padrao|teams_cor_check/i.test(erro.message || '');

/** As peças do escudo que vão nas respostas (sem a 077 elas não vêm — valem null). */
const escudoDoTime = (t) => ({ cor: t?.cor ?? null, escudo_cor2: t?.escudo_cor2 || null, escudo_padrao: t?.escudo_padrao || null });

module.exports = { PALETA, CORES_ANTIGAS, PADROES, MSG_COR_INVALIDA, MSG_PADRAO_INVALIDO, lerEscudo, erroDeEscudoSemMigracao, escudoDoTime };
