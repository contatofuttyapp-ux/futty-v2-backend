// Futty v2.0 — Guarda para testes que ESCREVEM no Supabase real (Manutenção 26-set, item D.11).
// O banco (futty-v2) é ÚNICO e partilhado entre dev e produção — rodar estes testes sem pedir
// crava contas/times/jogos descartáveis lá. Corre só quando alguém pede de propósito:
// FUTTY_TESTES_COM_BANCO=1, nunca no CI (que não tem as chaves e não deve gravar lixo no banco
// de verdade). npm test continua verde sem a flag — estes testes aparecem como "skip".
const COM_BANCO = process.env.FUTTY_TESTES_COM_BANCO === '1' && !process.env.CI;
const MOTIVO_SKIP = 'precisa de FUTTY_TESTES_COM_BANCO=1 (fora do CI) — escreve no Supabase real (banco único, partilhado com produção)';

module.exports = { COM_BANCO, MOTIVO_SKIP };
