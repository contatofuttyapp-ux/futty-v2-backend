// Futty v2.0 — A porta de entrada do que a pessoa digita: texto com teto, número em faixa, uuid. Pura (sem banco, sem rede).
//
// Por que existe: o corpo do pedido é JSON de qualquer jeito (até 2 MB) e o app só manda texto curto. Sem teto, um `nome` de 300 mil
// caracteres ia inteiro para o banco e para o payload de todo o time; e um objeto onde se esperava texto estourava um `.trim()` em 500.
// Aqui o erro de quem digitou vira 400 com a frase da casa (VOZ-FUTTY: o que houve e o que fazer), nunca 500.
const { HttpError } = require('./http');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** É um uuid de verdade? (id de linha do banco). */
const ehUuid = (valor) => typeof valor === 'string' && UUID.test(valor);

/**
 * Texto curto do corpo: precisa ser texto (ou ausente), é aparado e não passa de `max`.
 * Ausente (undefined/null) e vazio viram '' — quem chama decide se vazio é erro.
 * @param {unknown} valor
 * @param {number} max
 * @param {string} rotulo  como a tela chama o campo ("Nome", "Local"): entra na frase do erro
 */
function textoCurto(valor, max, rotulo) {
  if (valor === undefined || valor === null) return '';
  if (typeof valor !== 'string') throw new HttpError(400, `${rotulo}: escreva um texto.`);
  const limpo = valor.trim();
  if (limpo.length > max) throw new HttpError(400, `${rotulo}: máximo ${max} caracteres.`);
  return limpo;
}

/**
 * Inteiro em faixa. Ausente/vazio devolve `padrao` (null se não houver); texto numérico ("3") vale; o resto é 400.
 */
function inteiroEmFaixa(valor, { min = 0, max, rotulo, padrao = null }) {
  if (valor === undefined || valor === null || valor === '') return padrao;
  const n = typeof valor === 'number' ? valor : typeof valor === 'string' && /^\s*-?\d+\s*$/.test(valor) ? Number(valor) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${rotulo}: use um número inteiro de ${min} a ${max}.`);
  return n;
}

module.exports = { textoCurto, inteiroEmFaixa, ehUuid, UUID };
