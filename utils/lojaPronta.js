// Futty v2.0 — Quando a loja abre para uma pessoa: para todo mundo com PAGAMENTOS_ATIVOS === 'true', ou só para os testadores.
//
// PAGAMENTOS_TESTERS é uma lista de e-mails separados por vírgula. Serve para a Apple e a Play testarem a compra (e para o time) sem abrir a loja
// ao público. Sem a variável, ninguém é testador. O e-mail que vale é o da conta AUTENTICADA (`req.user`, que o Supabase devolve a partir do token
// verificado), nunca algo que o app mande no corpo ou nos cabeçalhos. E só vale e-mail confirmado: sem isso, quem cadastrasse o e-mail de um testador
// antes dele veria a loja. Puro (sem banco, sem rede), para testar no Node.

/** O conjunto de e-mails dos testadores (minúsculos, sem espaços), lido de `env.PAGAMENTOS_TESTERS`. */
function emailsDosTestadores(env = process.env) {
  return new Set(
    String(env.PAGAMENTOS_TESTERS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Esta conta autenticada é de um testador? */
function ehTestador(user, env = process.env) {
  const email = typeof user?.email === 'string' ? user.email.trim().toLowerCase() : '';
  if (!email || !user?.email_confirmed_at) return false;
  return emailsDosTestadores(env).has(email);
}

/** `loja_pronta` de quem fez o pedido: a loja aberta para todos, ou esta conta é de testador. */
function lojaPronta(user, env = process.env) {
  return env.PAGAMENTOS_ATIVOS === 'true' || ehTestador(user, env);
}

module.exports = { emailsDosTestadores, ehTestador, lojaPronta };
