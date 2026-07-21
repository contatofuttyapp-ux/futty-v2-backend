// Tijolo 1C — assina URLs de média na fronteira da API.
// Buckets 'avatars'/'resenha' são privados; os URLs guardados são públicos e
// morreriam. Este middleware embrulha res.json e, ANTES de enviar:
//   - rotas autenticadas → assina os URLs (validade curta) → o frontend renderiza
//     sem qualquer alteração (urlAsset devolve URLs http tal-qual);
//   - rotas PÚBLICAS de partilha (/api/p/...) → despublica (→ silhueta no cliente).
// Fail-open: qualquer erro envia o payload original.
const { proxificarPayload, despublicarPayload } = require('../utils/storage');

// Tijolo 2: as rotas autenticadas passam a emitir URLs do PROXY de imagem
// (`/api/media/:token`), estáveis 7 dias → sem expiração à vista no DOM, bucket
// privado. O proxy é que assina a Supabase (vida curta) a cada pedido. As páginas
// públicas /api/p/ continuam a despublicar (→ silhueta). Fail-open.
function baseDoBackend(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function mediaUrls(req, res, next) {
  if (!req.path || !req.path.startsWith('/api')) return next();
  const publico = req.path.startsWith('/api/p/'); // páginas de partilha sem sessão
  const enviar = res.json.bind(res);
  res.json = (body) => {
    try {
      if (publico) despublicarPayload(body);
      else proxificarPayload(body, baseDoBackend(req));
    } catch (e) {
      console.error('[media] middleware fail-open:', e.message);
    }
    return enviar(body);
  };
  next();
}

module.exports = { mediaUrls };
