// Futty v2.0 — A régua de idade do cadastro (Rodada 28, bloco C; LGPD art. 14).
//
// O Futty é para maiores de 13 anos. A conta não nasce abaixo disso: o app pergunta a data no cadastro
// (e-mail) e no onboarding (Google/Apple, que não trazem a data), e o motor confere de novo — ver
// PATCH /api/me e POST /api/me/onboarding-completo. Contas que já existiam não são tocadas.

const IDADE_MINIMA = 13;

/** "AAAA-MM-DD" válida, no passado e depois de 1900 → a própria string; qualquer outra coisa → null. */
function dataDeNascimentoValida(valor) {
  const v = valor == null ? '' : String(valor).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return null; // 2026-02-30 não existe
  if (d > new Date() || d.getUTCFullYear() < 1900) return null;
  return v;
}

/** Anos completos em `hoje` (UTC) de quem nasceu em `nascimento` ("AAAA-MM-DD"). */
function idadeEm(nascimento, hoje = new Date()) {
  const [a, m, d] = String(nascimento).slice(0, 10).split('-').map(Number);
  let anos = hoje.getUTCFullYear() - a;
  const mes = hoje.getUTCMonth() + 1;
  if (mes < m || (mes === m && hoje.getUTCDate() < d)) anos -= 1;
  return anos;
}

/** true se quem nasceu nessa data ainda não tem 13 anos. Data inválida não decide nada (false). */
function menorQueIdadeMinima(nascimento, hoje = new Date()) {
  const v = dataDeNascimentoValida(nascimento);
  return v != null && idadeEm(v, hoje) < IDADE_MINIMA;
}

const MSG_MENOR = 'O Futty é para maiores de 13 anos.';

module.exports = { IDADE_MINIMA, MSG_MENOR, dataDeNascimentoValida, idadeEm, menorQueIdadeMinima };
