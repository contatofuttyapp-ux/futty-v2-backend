// Tijolo 1C — assina URLs de média na fronteira da API.
// Buckets 'avatars'/'resenha' são privados; os URLs guardados são públicos e
// morreriam. Este middleware embrulha res.json e, ANTES de enviar:
//   - rotas autenticadas → assina os URLs (validade curta) → o frontend renderiza
//     sem qualquer alteração (urlAsset devolve URLs http tal-qual);
//   - rotas PÚBLICAS de partilha (/api/p/...) → despublica (→ silhueta no cliente).
// Fail-open: qualquer erro envia o payload original.
const { assinarPayload, despublicarPayload } = require('../utils/storage');

// Validade dos URLs assinados nas rotas autenticadas. Curta por segurança; o
// contrapeso é que um avatar deixado no DOM > este tempo sem refetch expira
// (fix robusto sem expiração = endpoint-proxy de imagem, candidato ao tijolo 2).
const TTL_SEGUNDOS = 3600; // 1h

function mediaUrls(req, res, next) {
  if (!req.path || !req.path.startsWith('/api')) return next();
  const publico = req.path.startsWith('/api/p/'); // páginas de partilha sem sessão
  const enviar = res.json.bind(res);
  res.json = (body) => {
    const trabalho = publico
      ? Promise.resolve(despublicarPayload(body))
      : assinarPayload(body, TTL_SEGUNDOS);
    Promise.resolve(trabalho)
      .then((b) => enviar(b))
      .catch((e) => { console.error('[media] middleware fail-open:', e.message); enviar(body); });
    return res;
  };
  next();
}

module.exports = { mediaUrls, TTL_SEGUNDOS };
