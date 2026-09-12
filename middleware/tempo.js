// Futty v2.0 — Middleware de tempo por rota (diagnóstico de lentidão, roteiro
// 10-set, achados 3/23; header Server-Timing 13-set, "Velocidade 3").
//
// O console.log continua só em dev (ruído/custo do hrtime não vale a pena em
// produção). O header Server-Timing, esse, vai em TODO pedido, produção
// incluída — é o que deixa medir de Lisboa quanto do tempo total é o MOTOR
// (São Paulo) e quanto é rede: `curl -w '...'`/DevTools separam o Server-Timing
// do round-trip total sem precisar de nenhum log do lado do servidor.
function tempoPorRota(req, res, next) {
  const inicio = process.hrtime.bigint();
  const logar = process.env.NODE_ENV !== 'production';

  // res.end é o ponto comum de saída (res.json/res.send/res.redirect chamam-no
  // por baixo) — intercetado para poder pôr o header ANTES dos headers saírem
  // (res.on('finish') já é tarde demais, os headers já foram enviados).
  const enviarOriginal = res.end;
  res.end = function interceptado(...args) {
    if (!res.headersSent) {
      const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
      res.setHeader('Server-Timing', `app;dur=${ms.toFixed(1)}`);
    }
    return enviarOriginal.apply(res, args);
  };

  if (logar) {
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
      if (ms > 500) console.log(`[tempo] ${req.method} ${req.originalUrl} ${Math.round(ms)}ms`);
    });
  }
  next();
}

module.exports = { tempoPorRota };
