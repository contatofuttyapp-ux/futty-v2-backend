// Futty v2.0 — O recorte da MINIATURA do avatar — as contas puras.
//
// A miniatura redonda (Início, ranking, sorteio…) mostra uma JANELA QUADRADA da foto (ou da
// figurinha), que é 2:3. O recorte escolhido pela pessoa diz onde fica essa janela:
//   x, y    o CENTRO da janela, em fração da imagem (0–1)
//   escala  o zoom: 1 = a janela tem a largura da imagem (o maior quadrado que cabe); 3 = um terço dela
//
// Estas funções são a ÚNICA definição da janela. O app tem uma cópia idêntica
// (frontend/src/lib/enquadroAvatar.js) e os dois lados são provados contra os mesmos casos
// (tests/recorte-avatar.test.js ↔ scripts/unidade/enquadro-recorte.test.mjs): o que a pessoa
// vê ao arrastar a miniatura no editor é, ao pixel, o que o proxy de imagem entrega depois.

const ESCALA_MAX = 3;

const arredonda3 = (n) => Math.round(n * 1000) / 1000;
const entre = (n, min, max) => Math.min(max, Math.max(min, n));

/**
 * Valida e normaliza um recorte vindo de fora (corpo da rota, parâmetro de URL, JSON do banco).
 * Devolve { x, y, escala } (3 casas) ou null se não for um recorte utilizável. Nunca lança.
 */
function validarRecorte(bruto) {
  if (!bruto || typeof bruto !== 'object') return null;
  const x = Number(bruto.x);
  const y = Number(bruto.y);
  const escala = Number(bruto.escala);
  if (![x, y, escala].every(Number.isFinite)) return null;
  if (escala < 1 || escala > ESCALA_MAX) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: arredonda3(x), y: arredonda3(y), escala: arredonda3(escala) };
}

/**
 * A janela quadrada, em pixels da imagem de `largura` × `altura`. O centro é puxado para dentro
 * quando a janela passaria da borda (nunca sai faixa vazia). Inteiros: é o que o sharp recebe.
 */
function janelaDoRecorte(largura, altura, recorte) {
  const r = validarRecorte(recorte);
  if (!r || !(largura > 0) || !(altura > 0)) return null;
  const lado = Math.max(1, Math.min(Math.round(Math.min(largura, altura) / r.escala), largura, altura));
  const left = Math.round(entre(r.x * largura - lado / 2, 0, largura - lado));
  const top = Math.round(entre(r.y * altura - lado / 2, 0, altura - lado));
  return { left, top, lado };
}

/** "0.500,0.310,1.200" — a forma do recorte na URL do proxy (`?rc=`). */
function paraParametro(recorte) {
  const r = validarRecorte(recorte);
  return r ? [r.x, r.y, r.escala].map((n) => n.toFixed(3)).join(',') : null;
}

/** O inverso de paraParametro. Lixo → null. */
function deParametro(texto) {
  if (typeof texto !== 'string' || texto.length > 40) return null;
  const partes = texto.split(',');
  if (partes.length !== 3) return null;
  const [x, y, escala] = partes.map((p) => (p.trim() === '' ? NaN : Number(p)));
  return validarRecorte({ x, y, escala });
}

module.exports = { ESCALA_MAX, validarRecorte, janelaDoRecorte, paraParametro, deParametro };
