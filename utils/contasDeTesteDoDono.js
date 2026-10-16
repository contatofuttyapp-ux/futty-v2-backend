// Futty v2.0 — Quais são as contas de teste do dono, para scripts/limpar-usuarios-teste.js --do-dono. Função pura (sem banco), testada à parte.
//
// O dono testa o cadastro com apelidos do próprio Gmail ("phferreiraborgesbackup+teste7@gmail.com" chega na mesma caixa). Essas saem. A conta
// pessoal dele (sem o "+") e as de utils/contaProtegida.js (Chavo, super-admins, demo das lojas, revisores da Apple, membros da Missa) nunca.
// As contas SEM NOME (nem nome, nem apelido) recentes aparecem à parte, "para conferir": podem ser testes do dono por Google/Apple, mas também
// gente de verdade que parou no meio do cadastro — só saem se o dono der o e-mail de cada uma (--incluir).
const { motivoParaNaoExcluir } = require('./contaProtegida');

const APELIDO_DO_GMAIL_DO_DONO = /^phferreiraborgesbackup\+[^@\s]+@gmail\.com$/i;
// As "(sem nome)" que o dono viu no banco eram de 29/09 a 16/10.
const SEM_NOME_DESDE = '2026-09-28T00:00:00Z';

const minusculo = (s) => String(s ?? '').trim().toLowerCase();
const semNome = (c) => !String(c.nome ?? '').trim() && !String(c.nome_jogador ?? '').trim();

/**
 * @param {{ id: string, email?: string, nome?: string, nome_jogador?: string, is_super_admin?: boolean, created_at?: string }[]} contas
 * @param {{ slugsPorConta?: Map<string, string[]>, incluir?: string[] }} [o]  incluir = e-mails que o dono conferiu e mandou tirar
 * @returns {{ saem: object[], paraConferir: object[], ficam: { conta: object, motivo: string }[], incluirSemConta: string[] }}
 */
function separarContasDeTeste(contas, { slugsPorConta = new Map(), incluir = [] } = {}) {
  const pedidos = new Set(incluir.map(minusculo).filter(Boolean));
  const saem = [];
  const paraConferir = [];
  const ficam = [];
  const vistos = new Set();
  for (const c of contas || []) {
    const email = minusculo(c.email);
    const candidata = APELIDO_DO_GMAIL_DO_DONO.test(email) || pedidos.has(email);
    if (pedidos.has(email)) vistos.add(email);
    const motivo = motivoParaNaoExcluir({ conta: c, slugsDosTimes: slugsPorConta.get(c.id) || [] });
    if (candidata) {
      if (motivo) ficam.push({ conta: c, motivo }); else saem.push(c);
    } else if (!motivo && semNome(c) && String(c.created_at || '') >= SEM_NOME_DESDE) {
      paraConferir.push(c);
    }
  }
  const porData = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''));
  return {
    saem: saem.sort(porData),
    paraConferir: paraConferir.sort(porData),
    ficam,
    incluirSemConta: [...pedidos].filter((e) => !vistos.has(e)),
  };
}

module.exports = { separarContasDeTeste, APELIDO_DO_GMAIL_DO_DONO, SEM_NOME_DESDE };
