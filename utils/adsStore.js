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

// VELOCIDADE 6A (15-set): registar() era um read-modify-write do JSON inteiro a
// CADA impressão — 2 idas ao Storage por anúncio visto, com o POST /api/ads/evento
// à espera das duas. Agora o evento só toca num contador em memória e o POST
// responde na hora; o ficheiro é escrito de 30 em 30 segundos (e no SIGTERM).
//
// O que se perde: até 30 s de contagens se o processo morrer de morte súbita.
// São números de publicidade agregados por dia, não dinheiro nem conteúdo — o
// preço certo a pagar por tirar duas idas ao Storage do caminho do utilizador.
const FLUSH_MS = 30000;
const pendentes = new Map(); // `${id}|${dia}` -> { imp, cli }
let temporizador = null;

/** Regista um evento (tipo 'imp' | 'cli') numa campanha, no dia de hoje. */
function registar(id, tipo) {
  if (!id) return;
  const dia = new Date().toISOString().slice(0, 10);
  const chave = `${id}|${dia}`;
  const acc = pendentes.get(chave) || { imp: 0, cli: 0 };
  if (tipo === 'cli') acc.cli += 1; else acc.imp += 1;
  pendentes.set(chave, acc);

  if (!temporizador) {
    temporizador = setTimeout(() => { temporizador = null; descarregar().catch(() => {}); }, FLUSH_MS);
    // Não segura o processo vivo só por causa de contadores de publicidade.
    if (temporizador.unref) temporizador.unref();
  }
}

/** Soma o que está pendente ao ficheiro e grava. Idempotente com 0 pendentes. */
async function descarregar() {
  if (!pendentes.size) return;
  // Tira já da fila: um evento que chegue a meio desta gravação entra no próximo
  // flush, em vez de ser contado duas vezes ou perdido.
  const lote = [...pendentes.entries()];
  pendentes.clear();
  try {
    const m = await ler();
    for (const [chave, acc] of lote) {
      const sep = chave.lastIndexOf('|');
      const id = chave.slice(0, sep);
      const dia = chave.slice(sep + 1);
      m[id] = m[id] || { dias: {} };
      m[id].dias[dia] = m[id].dias[dia] || { imp: 0, cli: 0 };
      m[id].dias[dia].imp += acc.imp;
      m[id].dias[dia].cli += acc.cli;
    }
    await gravar(m);
  } catch (e) {
    // Devolve à fila para tentar no próximo flush (não perde a contagem).
    for (const [chave, acc] of lote) {
      const atual = pendentes.get(chave) || { imp: 0, cli: 0 };
      pendentes.set(chave, { imp: atual.imp + acc.imp, cli: atual.cli + acc.cli });
    }
    console.error('[ads] flush falhou, fica para o próximo:', e.message);
  }
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

module.exports = { ler, registar, descarregar, totais, serie };
