// Futty v2.0 — Prazo para promessas que podem ficar penduradas (Rodada 8B, 15-set).
//
// O Storage do Supabase, numa rede ruim ou instável, pode simplesmente nunca
// responder — nem sucesso nem erro, só silêncio. Um try/catch não ajuda nesse
// caso: a promessa não REJEITA, fica pendurada, e quem está à espera (o
// /api/inicio, por exemplo) trava com ela. `seguro()` (routes/inicio.js) já
// devolve null para qualquer parte que FALHE — mas uma promessa pendurada não
// é uma falha, é o próprio pedido nunca terminar.
//
// comPrazo() faz a promessa competir contra um relógio: se não resolver nem
// rejeitar a tempo, a promessa devolvida REJEITA com um erro claro. A ida real
// continua a correr ao fundo (sem AbortController não há como cancelá-la de
// verdade), mas ninguém mais espera por ela — e, para o Node não se queixar de
// uma rejeição sem dono se ela chegar tarde, fica sempre alguém a apanhá-la.
//
// @param {Promise} promessa - já em curso (chamar a função ANTES de passar aqui).
// @param {number} [ms] - prazo em milissegundos.
// @param {string} [rotulo] - aparece na mensagem de erro (qual ida era).
function comPrazo(promessa, ms = 3000, rotulo = 'Storage') {
  Promise.resolve(promessa).catch(() => {}); // nunca deixa a rejeição tardia sem dono
  let temporizador;
  const prazo = new Promise((_resolve, reject) => {
    temporizador = setTimeout(() => reject(new Error(`${rotulo}: sem resposta em ${ms}ms.`)), ms);
  });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(temporizador));
}

module.exports = { comPrazo };
