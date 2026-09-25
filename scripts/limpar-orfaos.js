#!/usr/bin/env node
// Futty v2.0 — Arquivos órfãos do bucket `avatars` (Rodada 28, bloco G).
//
// Lista (por padrão só LISTA — nada é apagado) os arquivos do bucket `avatars` que nenhuma linha do
// banco usa: fotos e originais substituídas cuja faxina não terminou (a limpeza roda depois da resposta,
// e o Cloud Run sem "CPU sempre alocada" pode deixá-la pela metade), temporários da geração (tmp/),
// logos antigos. A regra de quem é órfão vive em utils/orfaos.js (nada com menos de 1 dia; tmp/ depois
// de 1 hora; sem data, não mexe).
//
// ⚠️ Fala com o Supabase DE VERDADE (o do .env). Rodar só quando o Pedro pedir.
//
// Uso (na pasta backend):
//   node scripts/limpar-orfaos.js                    lista (dry-run), por pasta, com os 20 maiores
//   node scripts/limpar-orfaos.js --pasta tmp        só uma pasta (public, tmp, logos…)
//   node scripts/limpar-orfaos.js --apagar           apaga os órfãos listados (em lotes de 100)
require('dotenv').config({ quiet: true });
const { supabase } = require('../utils/db');
const { caminhoDeUrl } = require('../utils/storage');
const { acharOrfaos, resumirPorPasta } = require('../utils/orfaos');

const BUCKET = 'avatars';
const LOTE = 100;
const PAGINA = 1000;

// Toda coluna que guarda um arquivo do bucket `avatars`. Uma tabela que falte (migração por correr)
// é pulada com aviso — o que ela guardaria NÃO fica sem referência por isso: o script aborta antes
// de apagar se alguma leitura falhar (ver main).
const REFERENCIAS = [
  { tabela: 'users', colunas: ['avatar_url', 'foto_url', 'foto_original_url'] },
  { tabela: 'user_avatar_slots', colunas: ['avatar_url'] },
  { tabela: 'user_avatar_historico', colunas: ['avatar_url'] },
  { tabela: 'brilhantes_time', colunas: ['avatar_url'] },
  { tabela: 'teams', colunas: ['logo_url'] },
];

const args = process.argv.slice(2);
const APAGAR = args.includes('--apagar');
const iPasta = args.indexOf('--pasta');
const SO_PASTA = iPasta >= 0 ? args[iPasta + 1] : null;

const kb = (b) => `${(b / 1024).toFixed(0)} KB`;
const mb = (b) => `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

/** Tudo o que há no bucket (a listagem do Storage não é recursiva: desce pastas, até 3 níveis). */
async function listarBucket(pasta = '', nivel = 0, acc = []) {
  for (let offset = 0; ; offset += PAGINA) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase.storage.from(BUCKET).list(pasta, { limit: PAGINA, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`listar ${pasta || '(raiz)'}: ${error.message}`);
    for (const item of data || []) {
      const caminho = pasta ? `${pasta}/${item.name}` : item.name;
      if (item.id == null) {
        // pasta
        // eslint-disable-next-line no-await-in-loop
        if (nivel < 3) await listarBucket(caminho, nivel + 1, acc);
      } else {
        acc.push({ caminho, criadoEm: item.created_at || item.updated_at || null, tamanho: item.metadata?.size || 0 });
      }
    }
    if ((data || []).length < PAGINA) break;
  }
  return acc;
}

/** Os caminhos que o banco conhece (URL crua do Storage ou do proxy /api/media → caminho no bucket). */
async function caminhosReferenciados() {
  const conhecidos = new Set();
  const faltas = [];
  for (const { tabela, colunas } of REFERENCIAS) {
    for (let de = 0; ; de += PAGINA) {
      // eslint-disable-next-line no-await-in-loop
      const { data, error } = await supabase.from(tabela).select(colunas.join(', ')).range(de, de + PAGINA - 1);
      if (error) {
        faltas.push(`${tabela}: ${error.message}`);
        break;
      }
      for (const linha of data || []) {
        for (const c of colunas) {
          const caminho = caminhoDeUrl(linha[c], BUCKET);
          if (caminho) conhecidos.add(caminho);
        }
      }
      if ((data || []).length < PAGINA) break;
    }
  }
  return { conhecidos, faltas };
}

async function main() {
  console.log(`Bucket ${BUCKET}${SO_PASTA ? ` · pasta ${SO_PASTA}` : ''} — ${APAGAR ? 'APAGAR' : 'só listar (dry-run)'}`);
  const [objetos, { conhecidos, faltas }] = await Promise.all([listarBucket(SO_PASTA || ''), caminhosReferenciados()]);
  if (faltas.length) {
    // Uma tabela que não se conseguiu ler pode ser justamente a que referencia o arquivo: com
    // falta, lista-se para ver, mas não se apaga nada.
    console.log(`\nAVISO: não deu para ler ${faltas.length} tabela(s) de referência:\n  ${faltas.join('\n  ')}`);
  }
  const orfaos = acharOrfaos(objetos, conhecidos);
  const total = orfaos.reduce((s, o) => s + (Number(o.tamanho) || 0), 0);
  console.log(`\n${objetos.length} arquivo(s) no bucket; ${conhecidos.size} caminho(s) usados pelo banco.`);
  console.log(`Órfãos: ${orfaos.length} (${mb(total)}) — sem referência, mais velhos que 1 dia (tmp/: 1 hora).`);
  for (const p of resumirPorPasta(orfaos)) console.log(`  ${p.pasta}: ${p.arquivos} (${mb(p.bytes)})`);
  const maiores = [...orfaos].sort((a, b) => (b.tamanho || 0) - (a.tamanho || 0)).slice(0, 20);
  if (maiores.length) {
    console.log('\nOs maiores:');
    for (const o of maiores) console.log(`  ${o.caminho} · ${kb(o.tamanho || 0)} · ${String(o.criadoEm || '').slice(0, 10)}`);
  }

  if (!APAGAR) {
    if (orfaos.length) console.log('\nNada foi apagado. Para apagar: node scripts/limpar-orfaos.js --apagar');
    return;
  }
  if (faltas.length) {
    console.log('\nNADA APAGADO: há tabela de referência que não se conseguiu ler (ver aviso acima).');
    process.exitCode = 1;
    return;
  }
  let apagados = 0;
  for (let i = 0; i < orfaos.length; i += LOTE) {
    const lote = orfaos.slice(i, i + LOTE).map((o) => o.caminho);
    // eslint-disable-next-line no-await-in-loop
    const { error } = await supabase.storage.from(BUCKET).remove(lote);
    if (error) {
      console.log(`Lote ${i / LOTE + 1} falhou: ${error.message}`);
      process.exitCode = 1;
      continue;
    }
    apagados += lote.length;
  }
  console.log(`\nApagados: ${apagados} de ${orfaos.length}.`);
}

main().catch((e) => {
  console.error('Erro:', e.message);
  process.exit(1);
});
