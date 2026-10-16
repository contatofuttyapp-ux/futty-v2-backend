// Futty v2.0 — As réguas de idade.
//
// IDADE_MINIMA é a do CADASTRO: o Futty é para quem tem 13 anos ou mais. A conta não nasce abaixo disso: o app pergunta a data no
// cadastro (e-mail) e no onboarding (Google/Apple, que não trazem a data), e o motor confere de novo — ver PATCH /api/me e
// POST /api/me/onboarding-completo. Conta que já existia com data abaixo da mínima não é apagada pelo motor: o app mostra a tela com
// "Excluir minha conta".
//
// MAIORIDADE é outra régua, a das proteções de quem ainda não tem 18: o rosto nas páginas públicas (utils/rostoPublico.js) e a
// publicidade 18+ (services/inicio.js) só valem para quem tem 18 anos confirmados pela data — sem data, nunca.
//
// Os números moram SÓ aqui (e no espelho frontend/src/utils/idade.js).

const IDADE_MINIMA = 13;
const MAIORIDADE = 18;

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

/** true se quem nasceu nessa data ainda não tem IDADE_MINIMA anos. Data inválida não decide nada (false). */
function menorQueIdadeMinima(nascimento, hoje = new Date()) {
  const v = dataDeNascimentoValida(nascimento);
  return v != null && idadeEm(v, hoje) < IDADE_MINIMA;
}

/** true se a data é válida e a pessoa já tem MAIORIDADE anos. Sem data ou data inválida → false (fail-closed). */
function temMaioridade(nascimento, hoje = new Date()) {
  const v = dataDeNascimentoValida(nascimento);
  return v != null && idadeEm(v, hoje) >= MAIORIDADE;
}

const MSG_MENOR = 'O Futty é para quem tem 13 anos ou mais.';

module.exports = { IDADE_MINIMA, MAIORIDADE, MSG_MENOR, dataDeNascimentoValida, idadeEm, menorQueIdadeMinima, temMaioridade };
