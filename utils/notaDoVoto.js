// Futty v2.0 — A nota do voto, numa régua só: de 0 a 10, inteiro (decisão do dono). Todo o motor lê e grava a nota por aqui.
//
// No banco a nota vive em `votes.nota10` (migração 086). A coluna antiga `nota` (estrelas, 0,5 a 5) fica espelhada por um gatilho
// (÷ 2 / × 2), para o motor antigo continuar certo durante o publica. Este módulo cobre o outro lado: banco SEM a 086 (a migração é
// rodada à mão). Aí a coluna nova não existe e a nota é lida e gravada na antiga, convertida — o motor funciona antes e depois da migração,
// em qualquer ordem. Só o voto 0 não cabe na coluna antiga (o CHECK de lá começa em 0,5): esse espera a migração.
//
// O app também tem duas idades: as telas antigas (o app da loja antes de baixar as telas novas pelo Capgo) mandam e esperam ESTRELAS.
// As telas novas avisam com o cabeçalho `X-Futty-Nota: 10`; sem ele o voto que chega é em estrelas e a nota que o próprio votante
// deu volta em estrelas — assim o "Alterar" do app antigo abre com as estrelas certas.
const { supabase } = require('./db');

const COLUNA = 'nota10';
const COLUNA_ANTIGA = 'nota';
// Sem a coluna nova, confere de novo a cada minuto: a migração pode ser rodada com o motor no ar.
const RECONFERIR_MS = 60 * 1000;

let temColunaNova = null;
let conferidoEm = 0;

/** A coluna que guarda a nota neste banco: 'nota10' (com a migração 086) ou 'nota' (sem ela). */
async function colunaDaNota() {
  if (temColunaNova === true) return COLUNA;
  if (temColunaNova === false && Date.now() - conferidoEm < RECONFERIR_MS) return COLUNA_ANTIGA;
  const { error } = await supabase.from('votes').select(COLUNA).limit(1);
  conferidoEm = Date.now();
  if (!error) temColunaNova = true;
  else if (error.code === '42703' || error.code === 'PGRST204') temColunaNova = false;
  // Outro erro (rede, banco fora): a coluna antiga é sempre certa (o gatilho a mantém), então lê por ela e confere na próxima.
  else return COLUNA_ANTIGA;
  return temColunaNova ? COLUNA : COLUNA_ANTIGA;
}

/** A nota de 0 a 10 de uma linha de `votes`, venha ela da coluna nova ou da antiga (estrelas × 2). */
function notaDoVoto(v) {
  if (v?.nota10 != null && Number.isFinite(Number(v.nota10))) return Number(v.nota10);
  if (v?.nota != null && Number.isFinite(Number(v.nota))) return Math.round(Number(v.nota) * 2);
  return null;
}

/** Os campos a gravar para uma nota de 0 a 10, na coluna que este banco tem. */
async function camposDaNota(nota10) {
  return (await colunaDaNota()) === COLUNA ? { nota10 } : { nota: nota10 / 2 };
}

/** Nota válida na régua nova: inteiro de 0 a 10. */
function notaValida(n) {
  return Number.isInteger(n) && n >= 0 && n <= 10;
}

/** Nota válida em estrelas (o app antigo): de 0,5 a 5, de 0,5 em 0,5. */
function estrelasValidas(n) {
  return Number.isFinite(n) && n >= 0.5 && n <= 5 && Number.isInteger(n * 2);
}

/** O pedido veio das telas novas (régua de 10)? */
function pedidoNaReguaDe10(req) {
  return String(req.get?.('x-futty-nota') || '').trim() === '10';
}

/**
 * A nota que chegou no corpo do voto, já na régua de 0 a 10, ou null se não vale.
 * Telas novas mandam 0 a 10 (inteiro); as antigas, estrelas (vira × 2).
 */
function notaDoPedido(req, valor) {
  const n = valor === null || valor === '' || typeof valor === 'boolean' ? NaN : Number(valor);
  if (pedidoNaReguaDe10(req)) return notaValida(n) ? n : null;
  return estrelasValidas(n) ? n * 2 : null;
}

/** A nota que o próprio votante deu, como o app dele a entende (estrelas para as telas antigas). */
function notaParaOPedido(req, nota10) {
  if (nota10 == null) return null;
  return pedidoNaReguaDe10(req) ? nota10 : nota10 / 2;
}

/** Média das notas (0 a 10) com uma casa; null sem notas. É a nota que aparece na tela. */
function mediaDasNotas(soma, quantas) {
  if (!quantas) return null;
  return Math.round((soma / quantas) * 10) / 10;
}

/** Só para os testes: esquece o que foi conferido do banco. */
function _esquecerColuna() {
  temColunaNova = null;
  conferidoEm = 0;
}

module.exports = {
  colunaDaNota,
  notaDoVoto,
  camposDaNota,
  notaValida,
  notaDoPedido,
  notaParaOPedido,
  pedidoNaReguaDe10,
  mediaDasNotas,
  _esquecerColuna,
};
