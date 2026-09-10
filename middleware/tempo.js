// Futty v2.0 — Middleware de tempo por rota (diagnóstico de lentidão, roteiro
// 10-set, achados 3/23). Só loga em dev: em produção não queremos ruído nem o
// custo do hrtime em cada pedido.
function tempoPorRota(req, res, next) {
  if (process.env.NODE_ENV === 'production') return next();
  const inicio = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    if (ms > 500) console.log(`[tempo] ${req.method} ${req.originalUrl} ${Math.round(ms)}ms`);
  });
  next();
}

module.exports = { tempoPorRota };
