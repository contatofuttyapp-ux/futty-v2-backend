// Futty v2.0 — As ligações com o Supabase ficam abertas entre uma tela e outra.
//
// O fetch do Node (undici) fecha a ligação ociosa depois de 4 s, a menos que o servidor diga outra coisa no cabeçalho
// `Keep-Alive: timeout=…` — e o Supabase (atrás da Cloudflare) não diz. Na prática: a pessoa abre o Início, olha 5 s, toca na
// Resenha, e o motor já jogou fora todas as ligações; as ~10 consultas em paralelo da tela nova abrem ~10 ligações novas
// (DNS + TCP + TLS cada uma) antes da primeira linha voltar. "Depois de carregado roda rápido" era isto: dentro dos 4 s as
// ligações ainda estavam lá.
//
// Aqui o cliente do Supabase usa um agente próprio que segura a ligação ociosa por 30 s (bem abaixo do que a Cloudflare aguenta do
// outro lado, que fecha muito depois). Só o Supabase: o resto do motor (fal, RevenueCat, push) segue com o padrão.
//
// O agente é o MESMO undici que vem dentro do Node (a classe do despachante global), não um pacote à parte: versão diferente da do
// fetch embutido não conversa com ele. Ele só existe depois do primeiro fetch do processo; até lá (o primeiro pedido) vai o padrão.
const SIMBOLO_DO_DESPACHANTE = Symbol.for('undici.globalDispatcher.1');
const OCIOSA_MS = 30_000;
const VIDA_MAXIMA_MS = 10 * 60_000;

let agente = null;

function agenteQuente() {
  if (agente) return agente;
  const Agente = globalThis[SIMBOLO_DO_DESPACHANTE]?.constructor;
  if (typeof Agente !== 'function' || Agente.name !== 'Agent') return null;
  try {
    agente = new Agente({ keepAliveTimeout: OCIOSA_MS, keepAliveMaxTimeout: VIDA_MAXIMA_MS });
  } catch {
    agente = null;
  }
  return agente;
}

/** O fetch que o cliente do Supabase usa (utils/db.js): o de sempre, com a ligação que fica aberta. */
function fetchComLigacaoQuente(entrada, opcoes = {}) {
  const a = agenteQuente();
  return globalThis.fetch(entrada, a ? { ...opcoes, dispatcher: a } : opcoes);
}

module.exports = { fetchComLigacaoQuente, OCIOSA_MS };
