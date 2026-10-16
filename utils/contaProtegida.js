// Futty v2.0 — Contas que o Gabinete (e a limpeza das contas de teste) NÃO apaga. A exclusão em si é sempre a de utils/apagarUsuario.js;
// aqui só a lista de quem fica, com o motivo que o dono lê.
//
// Para tirar uma proteção, o dono pede e muda-se AQUI (um lugar só, lido pela rota do Gabinete e pelo script de limpeza):
//   · TIMES_PROTEGIDOS — membros destes times não saem pelo Gabinete (time de verdade, gente de verdade);
//   · DEMO_DAS_LOJAS_PROTEGIDA — as contas @futtymock.com da demo que a Apple e o Google usam para revisar o app;
//   · REVISORES_DAS_LOJAS — as contas que os próprios revisores criaram ("John Apple").
// As contas do dono e os super-admins nunca saem por aqui (quem quer sair da própria conta usa "Excluir minha conta" no Perfil).

const EMAILS_DO_DONO = ['contatofuttyapp@gmail.com', 'phferreiraborgesbackup@gmail.com'];
const TIMES_PROTEGIDOS = [{ slug: 'missa-de-quinta-ogqq6', nome: 'Missa de Quinta' }];
// Enquanto a revisão do 1.0.4 nas lojas não passar.
const DEMO_DAS_LOJAS_PROTEGIDA = true;
const REVISORES_DAS_LOJAS = ['john apple'];

const MOTIVO = {
  propria: 'Esta é a sua conta: não sai pelo Gabinete.',
  dono: 'Conta do dono: não sai pelo Gabinete.',
  super: 'Conta de super-admin: não sai pelo Gabinete.',
  demo: 'Conta da demo das lojas: fica até a revisão do 1.0.4 passar.',
  revisor: 'Conta de revisor da Apple: fica até a revisão do 1.0.4 passar.',
  time: (nome) => `Membro do ${nome}: o time está protegido.`,
};

const minusculo = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Por que esta conta NÃO pode ser excluída — ou null se pode.
 * @param {object} p
 * @param {{ id: string, email?: string, nome?: string, nome_jogador?: string, is_super_admin?: boolean }} p.conta
 * @param {string} [p.quemPede]  id de quem está excluindo (o dono no Gabinete; vazio no script)
 * @param {string[]} [p.slugsDosTimes]  os times de que a conta é membro
 * @returns {string|null}
 */
function motivoParaNaoExcluir({ conta, quemPede = null, slugsDosTimes = [] }) {
  if (!conta?.id) return null;
  if (quemPede && conta.id === quemPede) return MOTIVO.propria;
  const email = minusculo(conta.email);
  if (EMAILS_DO_DONO.includes(email)) return MOTIVO.dono;
  if (conta.is_super_admin) return MOTIVO.super;
  if (DEMO_DAS_LOJAS_PROTEGIDA && email.endsWith('@futtymock.com')) return MOTIVO.demo;
  if ([conta.nome, conta.nome_jogador].some((n) => REVISORES_DAS_LOJAS.includes(minusculo(n)))) return MOTIVO.revisor;
  const time = TIMES_PROTEGIDOS.find((t) => slugsDosTimes.includes(t.slug));
  if (time) return MOTIVO.time(time.nome);
  return null;
}

/** "phferreiraborgesbackup+teste1@gmail.com" → "phf…@gmail.com": o log guarda quem saiu sem guardar o e-mail de quem pediu para sair. */
function emailMascarado(email) {
  const [nome, dominio] = String(email || '').split('@');
  if (!dominio) return '';
  return `${nome.slice(0, 3)}…@${dominio}`;
}

module.exports = { motivoParaNaoExcluir, emailMascarado, EMAILS_DO_DONO, TIMES_PROTEGIDOS, DEMO_DAS_LOJAS_PROTEGIDA, REVISORES_DAS_LOJAS };
