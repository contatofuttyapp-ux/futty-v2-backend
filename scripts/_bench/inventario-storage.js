// Futty v2.0 — LIMPEZA TOTAL (23-set): inventário dos 3 buckets ANTES da
// limpeza — nome e tamanho de cada objeto, recursivo (list() do Supabase
// Storage não é recursivo por si só, e cada bucket tem uma estrutura de
// pastas diferente: avatars = Kits/public/tmp, resenha = plano, denuncias =
// _diagnostico/_gabinete/_plataforma/casos/reporters).
//
// Uso único, não é ferramenta permanente — roda a partir de backend/:
//   node scripts/_bench/inventario-storage.js > caminho/inventario-storage.json
require('dotenv').config();
const { supabase } = require('../../utils/db');

const BUCKETS = ['avatars', 'resenha', 'denuncias'];
const LIMITE = 1000;

/** Lista um bucket inteiro, recursivamente. Pastas (id === null) descem; ficheiros entram no total. */
async function listarRecursivo(bucket, prefixo = '') {
  const objetos = [];
  let offset = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase.storage.from(bucket).list(prefixo, { limit: LIMITE, offset });
    if (error) throw new Error(`${bucket}/${prefixo}: ${error.message}`);
    for (const item of data || []) {
      const caminho = prefixo ? `${prefixo}/${item.name}` : item.name;
      if (item.id === null) {
        // eslint-disable-next-line no-await-in-loop
        const filhos = await listarRecursivo(bucket, caminho);
        objetos.push(...filhos);
      } else {
        objetos.push({ caminho, tamanho: item.metadata?.size ?? null, atualizado_em: item.updated_at || null });
      }
    }
    if (!data || data.length < LIMITE) break;
    offset += LIMITE;
  }
  return objetos;
}

async function main() {
  const inventario = { geradoEm: new Date().toISOString(), buckets: {} };
  for (const bucket of BUCKETS) {
    const objetos = await listarRecursivo(bucket);
    const tamanhoTotal = objetos.reduce((soma, o) => soma + (o.tamanho || 0), 0);
    inventario.buckets[bucket] = { total: objetos.length, tamanhoTotalBytes: tamanhoTotal, objetos };
    console.error(`[inventario] ${bucket}: ${objetos.length} objeto(s), ${tamanhoTotal} bytes`);
  }
  console.log(JSON.stringify(inventario, null, 2));
}

main().catch((e) => {
  console.error(`[inventario] ERRO: ${e.message}`);
  process.exit(1);
});
