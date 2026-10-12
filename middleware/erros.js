// Futty v2.0 — Tratador central de erros (o último middleware do server.js).
//
// Regra: o texto de um erro do SERVIDOR nunca chega ao cliente. Quase todas as rotas fazem
// `throw new HttpError(500, error.message)` com a mensagem crua do banco, e ela pode trazer nome de
// tabela/coluna, SQL, o IP de saída do motor ou uma página inteira do WAF. Em vez de trocar uma a uma,
// o tratador decide pelo status: 5xx responde sempre a frase da casa (VOZ-FUTTY.md §6, o que houve e o
// que fazer) com um código curto; o texto real vai para o log, e o Sentry já o recebeu do próprio erro
// (Sentry.setupExpressErrorHandler roda antes deste).
//
// Exceção de propósito: 502/503/504 são "indisponível agora" com frase escrita por nós (IA fora do ar,
// teto do dia, opção que ainda não existe, sessão sem confirmar…) e o app mostra essa frase e escolhe a
// tela pelo `code`. O banco nunca é repassado nesses status — tests/erro-do-servidor.test.js varre o
// código e falha se alguém passar a mensagem de uma variável para um 502/503/504.
const { HttpError } = require('../utils/http');

const MENSAGEM_ERRO_INTERNO = 'Deu ruim do nosso lado. Tente de novo em instantes.';
const CODIGO_ERRO_INTERNO = 'ERRO_INTERNO';
// Erro 4xx lançado sem texto: a frase de sempre.
const MENSAGEM_SEM_TEXTO = 'Algo deu errado. Tente de novo em instantes.';
const STATUS_COM_FRASE_PROPRIA = new Set([502, 503, 504]);
// Uma página de WAF inteira tem milhares de caracteres: no log basta o começo.
const TETO_DO_TEXTO_NO_LOG = 500;

// O corpo do pedido que não dá para ler (JSON torto, grande demais, charset que o parser não conhece) chega do body-parser como um erro
// comum com `status` 4xx e `expose: true`. É erro de quem pediu, não do servidor: sai 4xx, e a frase é nossa — a do parser cita o que
// foi digitado ("Unexpected token } in JSON at position 5").
const FRASES_DO_PEDIDO = {
  400: 'Não deu para ler o que foi enviado. Confira e tente de novo.',
  413: 'O pedido é grande demais.',
  415: 'Esse formato de pedido não é aceito.',
};
function statusDoPedidoIlegivel(err) {
  const s = Number(err?.status ?? err?.statusCode);
  // `expose`: o body-parser e o http-errors marcam assim o erro de quem pediu. O roteador do Express não marca o endereço com
  // percentual quebrado ("%E0%A4%A"): é um URIError com status 400.
  const doCliente = err?.expose === true || err instanceof URIError;
  return doCliente && Number.isInteger(s) && s >= 400 && s < 500 ? s : null;
}

/** Status que o erro leva ao cliente: o do HttpError, o 4xx do parser de corpo, ou 500 para qualquer outra coisa que tenha estourado. */
function statusDoErro(err) {
  if (err instanceof HttpError) return err.status;
  return statusDoPedidoIlegivel(err) || 500;
}

/** O corpo JSON da resposta: o texto de quem escreveu a rota (4xx e 502/503/504) ou a frase da casa (o resto do 5xx). */
function corpoDoErro(err, status = statusDoErro(err)) {
  if (status >= 500 && !STATUS_COM_FRASE_PROPRIA.has(status)) {
    return { error: MENSAGEM_ERRO_INTERNO, code: CODIGO_ERRO_INTERNO };
  }
  if (!(err instanceof HttpError) && status < 500) return { error: FRASES_DO_PEDIDO[status] || FRASES_DO_PEDIDO[400] };
  const corpo = { error: err.message || MENSAGEM_SEM_TEXTO };
  if (err instanceof HttpError && err.code) corpo.code = err.code;
  return corpo;
}

// eslint-disable-next-line no-unused-vars
function tratadorDeErros(err, req, res, next) {
  if (res.headersSent) return next(err); // a resposta já saiu pela metade: quem fecha a conexão é o Express
  const status = statusDoErro(err);
  if (status >= 500) {
    // A rota (o desenho, `/api/teams/:slug`), nunca o endereço pedido: o caminho real pode levar token (/api/media/:token).
    const onde = `${req.method} ${req.route?.path ?? '(sem rota)'}`;
    const texto = String(err?.message ?? err).slice(0, TETO_DO_TEXTO_NO_LOG);
    console.error(`[Futty] Erro ${status} em ${onde}:`, texto);
  }
  res.status(status).json(corpoDoErro(err, status));
}

module.exports = { tratadorDeErros, corpoDoErro, statusDoErro, MENSAGEM_ERRO_INTERNO, CODIGO_ERRO_INTERNO, STATUS_COM_FRASE_PROPRIA };
