// Futty v2.0 — Backup semanal do bucket `avatars` (Manutenção 26-set, item B.4:
// o backup-banco.js cobria só as tabelas; o Storage — fotos, figurinhas, logos —
// nunca entrava. Se o bucket sumir, o banco continua íntegro mas toda foto some).
//
// Copia TODO arquivo do bucket `avatars` (menos `tmp/`, que é lixo de geração em
// curso, nunca vale a pena guardar) para
//   C:\Users\phfer\Desktop\FUT\BACKUPS\<AAAA-MM-DD>\storage\avatars\<mesmo caminho>
// com um inventario.json (caminho, tamanho, updated_at) ao lado.
//
// Incremental: se o arquivo já existe no backup COMPLETO anterior com o mesmo
// tamanho e updated_at, copia-se local (do backup de ontem) em vez de baixar de
// novo do Supabase — é o mesmo arquivo, poupa banda e tempo. "Backup completo
// anterior" = a pasta de data mais recente, antes de hoje, que já tem
// storage\avatars\inventario.json (backups de antes desta rodada não têm).
//
// Chamado pelo mesmo BACKUP-FUTTY.bat, depois de backup-banco.js. Uso:
//   node backend/scripts/backup-storage.js
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { supabase } = require('../utils/db');

const BUCKET = 'avatars';
const PAGINA = 1000;
const PASTA_BACKUPS = 'C:\\Users\\phfer\\Desktop\\FUT\\BACKUPS';

function hojeISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Tudo o que há no bucket, fora de tmp/ (a listagem do Storage não é recursiva:
 * desce pastas, até 3 níveis — igual a scripts/limpar-orfaos.js). */
async function listarBucket(pasta = '', nivel = 0, acc = []) {
  for (let offset = 0; ; offset += PAGINA) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase.storage.from(BUCKET).list(pasta, { limit: PAGINA, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`listar ${pasta || '(raiz)'}: ${error.message}`);
    for (const item of data || []) {
      const caminho = pasta ? `${pasta}/${item.name}` : item.name;
      if (caminho === 'tmp' || caminho.startsWith('tmp/')) continue; // temporário de geração — nunca vale backup
      if (item.id == null) {
        // pasta
        // eslint-disable-next-line no-await-in-loop
        if (nivel < 3) await listarBucket(caminho, nivel + 1, acc);
      } else {
        acc.push({ caminho, tamanho: item.metadata?.size || 0, updated_at: item.updated_at || null });
      }
    }
    if ((data || []).length < PAGINA) break;
  }
  return acc;
}

/** A pasta de backup completo mais recente ANTES de hoje que já tem
 * storage\avatars\inventario.json — ou null se esta for a primeira vez. */
function pastaAnteriorComInventario(pastaHoje) {
  if (!fs.existsSync(PASTA_BACKUPS)) return null;
  const candidatas = fs.readdirSync(PASTA_BACKUPS)
    .filter((nome) => /^\d{4}-\d{2}-\d{2}$/.test(nome) && nome < pastaHoje)
    .sort()
    .reverse();
  for (const nome of candidatas) {
    const inv = path.join(PASTA_BACKUPS, nome, 'storage', 'avatars', 'inventario.json');
    if (fs.existsSync(inv)) return path.join(PASTA_BACKUPS, nome, 'storage', 'avatars');
  }
  return null;
}

function carregarInventarioAnterior(pastaAnterior) {
  if (!pastaAnterior) return new Map();
  const linhas = JSON.parse(fs.readFileSync(path.join(pastaAnterior, 'inventario.json'), 'utf8'));
  return new Map(linhas.map((l) => [l.caminho, l]));
}

async function main() {
  const hoje = hojeISO();
  const pastaDestino = path.join(PASTA_BACKUPS, hoje, 'storage', 'avatars');
  fs.mkdirSync(pastaDestino, { recursive: true });

  console.log(`[backup-storage] bucket: ${BUCKET} · destino: ${pastaDestino}`);
  const objetos = await listarBucket('');

  const pastaAnterior = pastaAnteriorComInventario(hoje);
  const anteriorMap = carregarInventarioAnterior(pastaAnterior);
  console.log(pastaAnterior
    ? `[backup-storage] comparando com o backup anterior: ${pastaAnterior}`
    : '[backup-storage] sem backup de Storage anterior — baixando tudo.');

  let copiados = 0;
  let baixados = 0;
  const falhas = [];
  const inventario = [];

  for (const obj of objetos) {
    const destino = path.join(pastaDestino, ...obj.caminho.split('/'));
    fs.mkdirSync(path.dirname(destino), { recursive: true });

    const anterior = anteriorMap.get(obj.caminho);
    const reaproveita = anterior && anterior.tamanho === obj.tamanho && anterior.updated_at === obj.updated_at;

    try {
      if (reaproveita) {
        const origem = path.join(pastaAnterior, ...obj.caminho.split('/'));
        // eslint-disable-next-line no-await-in-loop
        fs.copyFileSync(origem, destino);
        copiados += 1;
      } else {
        // eslint-disable-next-line no-await-in-loop
        const { data, error } = await supabase.storage.from(BUCKET).download(obj.caminho);
        if (error) throw new Error(error.message);
        // eslint-disable-next-line no-await-in-loop
        const buffer = Buffer.from(await data.arrayBuffer());
        fs.writeFileSync(destino, buffer);
        baixados += 1;
      }
      inventario.push(obj);
    } catch (e) {
      console.error(`[backup-storage] ${obj.caminho}: FALHOU — ${e.message}`);
      falhas.push(obj.caminho);
    }
  }

  fs.writeFileSync(path.join(pastaDestino, 'inventario.json'), JSON.stringify(inventario, null, 2), 'utf8');

  const totalMb = (inventario.reduce((s, o) => s + (o.tamanho || 0), 0) / 1024 / 1024).toFixed(2);
  console.log('');
  console.log(`[backup-storage] concluído: ${inventario.length}/${objetos.length} arquivo(s), ${totalMb} MB — ${baixados} baixado(s), ${copiados} reaproveitado(s) do backup anterior.`);
  if (falhas.length) {
    console.log(`[backup-storage] falharam: ${falhas.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('[backup-storage] ERRO:', e.message);
  process.exit(1);
});
