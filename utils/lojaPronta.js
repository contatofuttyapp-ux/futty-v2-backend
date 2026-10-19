// Futty v2.0 — Quando a loja abre para uma pessoa: para todo mundo com PAGAMENTOS_ATIVOS === 'true', ou para quem está numa plataforma ligada
// (PAGAMENTOS_PLATAFORMAS).
//
// PAGAMENTOS_PLATAFORMAS é uma lista de plataformas separadas por vírgula ('ios' | 'android' | 'web'), ex.: "android,ios". Serve para ligar
// as vendas onde a loja já aprovou os produtos sem ligar onde não aprovou. A plataforma vem do cabeçalho X-Futty-Plataforma que o app manda;
// é só para decidir a VITRINE — quem mente o cabeçalho vê a loja, mas não compra nada: o crédito sai só do webhook do RevenueCat.
// Cabeçalho ausente ou desconhecido = não liga por plataforma.
//
// Sem a variável (não definida), valem as duas lojas: android e ios — as compras estão ligadas nas duas, e um deploy que perdesse a
// variável não pode fechar a loja de quem está no app. Definida e vazia = nenhuma plataforma (a forma de fechar de propósito).
//
// Puro (sem banco, sem rede), para testar no Node.

const PLATAFORMAS = ['ios', 'android', 'web'];
const PLATAFORMAS_SEM_A_VARIAVEL = 'android,ios';

/** O conjunto de plataformas ligadas (minúsculas, só as conhecidas), lido de `env.PAGAMENTOS_PLATAFORMAS` (android e ios se ela não existe). */
function plataformasLigadas(env = process.env) {
  const valor = env.PAGAMENTOS_PLATAFORMAS === undefined ? PLATAFORMAS_SEM_A_VARIAVEL : env.PAGAMENTOS_PLATAFORMAS;
  return new Set(
    String(valor || '')
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

/** `loja_pronta` de quem fez o pedido: a loja aberta para todos, ou a plataforma dele está ligada. */
function lojaPronta(env = process.env, plataforma = null) {
  if (env.PAGAMENTOS_ATIVOS === 'true') return true;
  return typeof plataforma === 'string' && plataformasLigadas(env).has(plataforma.trim().toLowerCase());
}

/** O mesmo, a partir do pedido (cabeçalho X-Futty-Plataforma). */
function lojaProntaDoPedido(req, env = process.env) {
  return lojaPronta(env, plataformaDoPedido(req));
}

/** A linha que o motor escreve no log ao subir — o que a loja vai fazer, para conferir nos logs do Cloud Run depois de um deploy. */
function linhaDaLoja(env = process.env) {
  const plataformas = [...plataformasLigadas(env)].join(',') || 'nenhuma';
  const origem = env.PAGAMENTOS_PLATAFORMAS === undefined ? ' (padrão, sem a variável)' : '';
  return `[Futty] loja: plataformas=${plataformas}${origem}, ativos=${env.PAGAMENTOS_ATIVOS === 'true' ? 'true' : 'false'}`;
}

module.exports = { plataformasLigadas, plataformaDoPedido, lojaPronta, lojaProntaDoPedido, linhaDaLoja };
