// Futty v2.0 — O WAF da Cloudflare na frente do Supabase recusou a consulta por causa do TEXTO que a
// pessoa digitou (ex.: `a;cat /etc/passwd;` na busca do Radar de peladas).
//
// O PostgREST responde sempre em JSON e com `code` (42703, PGRST205…). Uma recusa do WAF não: volta uma
// página HTML (ou um 403) que o cliente do Supabase embrulha como `{ message: <a página> }`, sem `code`.
// É isso que separa "o banco recusou o que a pessoa digitou" de "o banco quebrou": no primeiro, a busca
// vale como "nenhum time"; no segundo, segue sendo erro do servidor.

/**
 * @param {{ message?: string, code?: string } | null} error o `error` da resposta do Supabase
 * @param {number} [status] o `status` da mesma resposta, quando a rota o guardou
 */
function recusaDoWaf(error, status) {
  if (!error || error.code) return false;
  const texto = String(error.message ?? '').trimStart();
  return /^<(!doctype|html)/i.test(texto) || status === 403;
}

module.exports = { recusaDoWaf };
