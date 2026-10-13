// Futty v2.0 — Quando a loja abre para uma pessoa: para todo mundo com PAGAMENTOS_ATIVOS === 'true', para quem está numa plataforma ligada
// (PAGAMENTOS_PLATAFORMAS) ou só para os testadores.
//
// PAGAMENTOS_TESTERS é uma lista de e-mails separados por vírgula. Serve para a Apple e a Play testarem a compra (e para o time) sem abrir a loja
// ao público. Sem a variável, ninguém é testador. O e-mail que vale é o da conta AUTENTICADA (`req.user`, que o Supabase devolve a partir do token
// verificado), nunca algo que o app mande no corpo ou nos cabeçalhos. E só vale e-mail confirmado: sem isso, quem cadastrasse o e-mail de um testador
// antes dele veria a loja.
//
// PAGAMENTOS_PLATAFORMAS é uma lista de plataformas separadas por vírgula ('ios' | 'android' | 'web'), ex.: "android". Serve para ligar
// as vendas onde a loja já aprovou os produtos (a Play) sem ligar onde não aprovou (a Apple). A plataforma vem do cabeçalho X-Futty-Plataforma que o
// app manda; é só para decidir a VITRINE — quem mente o cabeçalho vê a loja, mas não compra nada: o crédito sai só do webhook do RevenueCat.
// Cabeçalho ausente ou desconhecido = não liga por plataforma; sem a variável = ninguém por plataforma.
//
// Puro (sem banco, sem rede), para testar no Node.

const PLATAFORMAS = ['ios', 'android', 'web'];

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

/** O conjunto de plataformas ligadas (minúsculas, só as conhecidas), lido de `env.PAGAMENTOS_PLATAFORMAS`. */
function plataformasLigadas(env = process.env) {
  return new Set(
    String(env.PAGAMENTOS_PLATAFORMAS || '')
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter((p) => PLATAFORMAS.includes(p)),
  );
}

/** A plataforma que o pedido diz ser ('ios' | 'android' | 'web'), ou null se o cabeçalho X-Futty-Plataforma falta ou é desconhecido. */
function plataformaDoPedido(req) {
  const valor = typeof req?.get === 'function' ? req.get('x-futty-plataforma') : req?.headers?.['x-futty-plataforma'];
  const p = typeof valor === 'string' ? valor.trim().toLowerCase() : '';
  return PLATAFORMAS.includes(p) ? p : null;
}

/** `loja_pronta` de quem fez o pedido: a loja aberta para todos, ou a plataforma dele está ligada, ou esta conta é de testador. */
function lojaPronta(user, env = process.env, plataforma = null) {
  if (env.PAGAMENTOS_ATIVOS === 'true') return true;
  if (typeof plataforma === 'string' && plataformasLigadas(env).has(plataforma.trim().toLowerCase())) return true;
  return ehTestador(user, env);
}

/** O mesmo, a partir do pedido: usa `req.user` e o cabeçalho X-Futty-Plataforma. */
function lojaProntaDoPedido(req, env = process.env) {
  return lojaPronta(req?.user, env, plataformaDoPedido(req));
}

module.exports = { emailsDosTestadores, ehTestador, plataformasLigadas, plataformaDoPedido, lojaPronta, lojaProntaDoPedido };
