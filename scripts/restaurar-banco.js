// Futty v2.0 — Restaura tabelas de um backup (scripts/backup-banco.js) de volta ao
// Supabase (Manutenção 26-set, item B.5). A lógica de ordem/lotes vive em
// utils/restauro.js (testada sem rede em tests/restaurar-banco.test.js); este
// script só lê os .json da pasta e fala com o Supabase de verdade.
//
// Uso (na pasta backend):
//   node scripts/restaurar-banco.js --pasta 2026-09-23 --tabela users        (simulação)
//   node scripts/restaurar-banco.js --pasta 2026-09-23 --tabela users --gravar
//   node scripts/restaurar-banco.js --pasta 2026-09-23 --tudo               (simulação)
//   node scripts/restaurar-banco.js --pasta 2026-09-23 --tudo --gravar
//
// Padrão é SIMULAÇÃO: só imprime quantas linhas e em que ordem restauraria. NUNCA
// rodar com --gravar sem o Pedro pedir por escrito — upsert em lote sobrescreve
// linha existente com a mesma chave.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { supabase } = require('../utils/db');
const { ORDEM_TABELAS, ordemRestauro, restaurarTabela } = require('../utils/restauro');

const PASTA_BACKUPS = 'C:\\Users\\phfer\\Desktop\\FUT\\BACKUPS';

const args = process.argv.slice(2);
const GRAVAR = args.includes('--gravar');
const TUDO = args.includes('--tudo');
const iPasta = args.indexOf('--pasta');
const PASTA = iPasta >= 0 ? args[iPasta + 1] : null;
const iTabela = args.indexOf('--tabela');
const TABELA = iTabela >= 0 ? args[iTabela + 1] : null;

async function main() {
  if (!PASTA) {
    console.error('Uso: node scripts/restaurar-banco.js --pasta AAAA-MM-DD (--tabela nome | --tudo) [--gravar]');
    process.exit(1);
  }
  if (!TUDO && !TABELA) {
    console.error('Precisa de --tabela <nome> ou --tudo.');
    process.exit(1);
  }

  const pastaBackup = path.join(PASTA_BACKUPS, PASTA);
  if (!fs.existsSync(pastaBackup)) {
    console.error(`Pasta não existe: ${pastaBackup}`);
    process.exit(1);
  }

  const pedidas = TUDO ? ORDEM_TABELAS : [TABELA];
  const ordem = ordemRestauro(pedidas);
  if (!ordem.length) {
    console.error(`Tabela desconhecida (fora de ORDEM_TABELAS em utils/restauro.js): ${TABELA}`);
    process.exit(1);
  }

  console.log(`[restaurar] pasta: ${pastaBackup}`);
  console.log(`[restaurar] modo: ${GRAVAR ? 'GRAVANDO NO SUPABASE' : 'SIMULAÇÃO (nada é gravado)'}`);
  console.log(`[restaurar] ordem: ${ordem.join(' -> ')}`);
  console.log('');

  for (const nome of ordem) {
    const arquivo = path.join(pastaBackup, `${nome}.json`);
    if (!fs.existsSync(arquivo)) {
      console.log(`[restaurar] ${nome}: sem arquivo no backup, pulando.`);
      // eslint-disable-next-line no-continue
      continue;
    }
    const linhas = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    // eslint-disable-next-line no-await-in-loop
    const r = await restaurarTabela(supabase, nome, linhas, { gravar: GRAVAR });
    console.log(`[restaurar] ${nome}: ${r.linhas} linha(s) em ${r.lotes} lote(s)${r.gravado ? ' — GRAVADO' : ' (simulação)'}`);
  }

  console.log('');
  console.log('[restaurar] concluído.');
}

main().catch((e) => {
  console.error('[restaurar] ERRO — parado:', e.message);
  process.exit(1);
});
