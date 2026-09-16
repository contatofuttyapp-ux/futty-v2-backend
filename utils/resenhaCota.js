// Futty v2.0 — Cota de mídia da Resenha por time (Rodada 15, 16-set).
//
// 500 MB por time: uma foto de celular sem compressão pesa 3-5 MB; 100 GB do
// plano dariam só ~25 mil fotos. Depende da migração 053 (coluna
// feed_post_media.bytes + as funções feed_bytes_por_time/
// feed_bytes_por_todos_times). SEM ela aplicada, tudo aqui falha ABERTO —
// devolve null/{} em vez de lançar, e regista um aviso; quem chama trata
// null como "não sei, não bloqueio". O Pedro aplica a migração quando puder;
// até lá o upload/post funciona exatamente como antes.
const { supabase } = require('./db');
const { caminhoDeUrl } = require('./storage');

const STORAGE_BUCKET = 'resenha';

// Override só para teste (FEED_COTA_BYTES_POR_TIME): função, não constante
// congelada — cada chamada lê o env de novo, para um teste poder simular um
// limite baixo sem afetar os outros testes do mesmo processo.
function cotaBytesPorTime() {
  const override = Number(process.env.FEED_COTA_BYTES_POR_TIME);
  return Number.isFinite(override) && override > 0 ? override : 500 * 1024 * 1024;
}

/** Bytes já usados por UM time. null = não sei (migração 053 ausente ou erro). */
async function bytesUsadosPeloTime(teamId) {
  try {
    const { data, error } = await supabase.rpc('feed_bytes_por_time', { p_team_id: teamId });
    if (error) throw new Error(error.message);
    return Number(data) || 0;
  } catch (e) {
    console.warn('[resenhaCota] bytesUsadosPeloTime indisponível (migração 053 aplicada?):', e.message);
    return null;
  }
}

/**
 * Bytes usados por TODOS os times, de uma vez — team_id -> bytes. {} em
 * falha (Gabinete mostra "—" em vez de travar a tela por causa disto).
 */
async function bytesUsadosPorTodosOsTimes() {
  try {
    const { data, error } = await supabase.rpc('feed_bytes_por_todos_times');
    if (error) throw new Error(error.message);
    const mapa = {};
    for (const row of data || []) mapa[row.team_id] = Number(row.bytes) || 0;
    return mapa;
  } catch (e) {
    console.warn('[resenhaCota] bytesUsadosPorTodosOsTimes indisponível (migração 053 aplicada?):', e.message);
    return {};
  }
}

/**
 * Tamanho REAL (bytes) de um objeto no bucket `resenha`, a partir da sua URL
 * pública — nunca do que o cliente diz que é (impediria fingir um arquivo
 * pequeno para furar a cota). null se a URL não for deste bucket ou o objeto
 * não for encontrado.
 */
async function tamanhoNoStorage(url) {
  const caminho = caminhoDeUrl(url, STORAGE_BUCKET); // decodifica a URL do proxy também — ver utils/storage.js
  if (!caminho) return null;
  try {
    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).list('', { search: caminho, limit: 1 });
    if (error || !data?.length) return null;
    return data[0]?.metadata?.size ?? null;
  } catch (e) {
    console.warn('[resenhaCota] tamanhoNoStorage falhou:', e.message);
    return null;
  }
}

module.exports = { cotaBytesPorTime, bytesUsadosPeloTime, bytesUsadosPorTodosOsTimes, tamanhoNoStorage };
