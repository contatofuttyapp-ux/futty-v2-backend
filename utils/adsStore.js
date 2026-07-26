// Futty v2.0 — Medição de publicidade: impressões/cliques agregados por DIA em JSON
// (Storage privado, padrão da casa). Zero cookies, zero scripts externos. As CAMPANHAS
// vivem no gabineteStore (operacao.json); aqui só vivem as CONTAGENS.
const { supabase } = require('./db');

const BUCKET = 'denuncias';
const CAMINHO = '_gabinete/ads-metrics.json';

async function ler() {
  try {
    const { data } = await supabase.storage.from(BUCKET).download(CAMINHO);
    if (!data) return {};
    return JSON.parse(await data.text());
  } catch { return {}; }
}
async function gravar(m) {
  await supabase.storage.from(BUCKET).upload(CAMINHO, Buffer.from(JSON.stringify(m)), { contentType: 'application/json', upsert: true });
}

/** Regista um evento (tipo 'imp' | 'cli') numa campanha, no dia de hoje. */
async function registar(id, tipo) {
  if (!id) return;
  const m = await ler();
  const dia = new Date().toISOString().slice(0, 10);
  m[id] = m[id] || { dias: {} };
  m[id].dias[dia] = m[id].dias[dia] || { imp: 0, cli: 0 };
  if (tipo === 'cli') m[id].dias[dia].cli += 1; else m[id].dias[dia].imp += 1;
  await gravar(m);
}

/** Totais (imp/cli) de uma campanha a partir do mapa de métricas já lido. */
function totais(m, id) {
  const dias = (m[id] && m[id].dias) || {};
  let imp = 0; let cli = 0;
  for (const k of Object.keys(dias)) { imp += dias[k].imp || 0; cli += dias[k].cli || 0; }
  return { imp, cli };
}

/** Série dos últimos N dias (para a tendência da secção Publicidade). */
function serie(m, id, nDias = 8) {
  const dias = (m[id] && m[id].dias) || {};
  const out = [];
  for (let i = nDias - 1; i >= 0; i -= 1) {
    const k = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push((dias[k] && dias[k].imp) || 0);
  }
  return out;
}

module.exports = { ler, registar, totais, serie };
