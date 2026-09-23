// Futty v2.0 — LIMPEZA TOTAL (23-set): varredura de órfãos pós-limpeza.
//
// apagarUsuario() já limpa o Storage de CADA usuário apagado (avatar/foto,
// slots, mídia da Resenha, varrimento por prefixo). O que sobra depois disso
// são objetos cujo DONO já não existe mas cujo CAMINHO não bate com nenhum
// prefixo de usuário conhecido (ficheiros antigos, de antes do nome-por-
// versão, ou de fluxos que nunca gravaram a URL numa linha da BD).
//
// Compara cada objeto do bucket contra as URLs REALMENTE referenciadas agora
// (users.avatar_url/foto_url, user_avatar_slots.avatar_url, teams.logo_url,
// champion_photos.url, feed_post_media.url, comentario_anexos.url) — o que
// sobra é órfão.
//
// denuncias: SÓ varre casos/<teamId>/* cujo teamId já não existe em `teams`.
// _diagnostico (relatórios por userId), _gabinete/operacao.json (campanhas de
// anúncio — têm de sobreviver), _plataforma e reporters/* ficam INTOCADOS de
// propósito: não são "donos" no sentido de apagarUsuario, e operacao.json é
// explicitamente uma das coisas que a limpeza NÃO pode tocar.
//
// Uso:
//   node scripts/_bench/varredura-orfaos.js                → dry-run (só lista)
//   node scripts/_bench/varredura-orfaos.js --apagar        → apaga de verdade
require('dotenv').config();
const { supabase } = require('../../utils/db');
const { bucketEcaminho } = require('../../utils/storage');

const APAGAR = process.argv.includes('--apagar');

async function todasAsLinhas(tabela, coluna) {
  const { data, error } = await supabase.from(tabela).select(coluna);
  if (error) throw new Error(`${tabela}: ${error.message}`);
  return data || [];
}

/** Lista um bucket inteiro, recursivamente (mesma lógica de inventario-storage.js). */
async function listarRecursivo(bucket, prefixo = '') {
  const objetos = [];
  let offset = 0;
  const LIMITE = 1000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase.storage.from(bucket).list(prefixo, { limit: LIMITE, offset });
    if (error) throw new Error(`${bucket}/${prefixo}: ${error.message}`);
    for (const item of data || []) {
      const caminho = prefixo ? `${prefixo}/${item.name}` : item.name;
      if (item.id === null) {
        // eslint-disable-next-line no-await-in-loop
        objetos.push(...(await listarRecursivo(bucket, caminho)));
      } else {
        objetos.push(caminho);
      }
    }
    if (!data || data.length < LIMITE) break;
    offset += LIMITE;
  }
  return objetos;
}

async function orfaosDeMedia() {
  // Referências vivas, dos dois buckets privados de uma vez (bucketEcaminho
  // decide o bucket certo a partir da própria URL).
  const [users, slots, teams, campeao, media, anexos] = await Promise.all([
    todasAsLinhas('users', 'avatar_url, foto_url'),
    todasAsLinhas('user_avatar_slots', 'avatar_url'),
    todasAsLinhas('teams', 'logo_url'),
    todasAsLinhas('champion_photos', 'url'),
    todasAsLinhas('feed_post_media', 'url'),
    todasAsLinhas('comentario_anexos', 'url'),
  ]);
  const vivos = { avatars: new Set(), resenha: new Set() };
  const marcar = (url) => {
    const p = bucketEcaminho(url);
    if (p) vivos[p.bucket].add(p.path);
  };
  users.forEach((u) => { marcar(u.avatar_url); marcar(u.foto_url); });
  slots.forEach((s) => marcar(s.avatar_url));
  teams.forEach((t) => marcar(t.logo_url));
  campeao.forEach((c) => marcar(c.url));
  media.forEach((m) => marcar(m.url));
  anexos.forEach((a) => marcar(a.url));

  const resultado = {};
  for (const bucket of ['avatars', 'resenha']) {
    const todos = await listarRecursivo(bucket);
    // Kits/ é asset estático da casa (uniformes-base da composição de
    // figurinha) — nunca é "dono" de ninguém, nunca entra na varredura.
    const candidatos = bucket === 'avatars' ? todos.filter((c) => !c.startsWith('Kits/')) : todos;
    const orfaos = candidatos.filter((c) => !vivos[bucket].has(c));
    resultado[bucket] = { total: todos.length, vivos: vivos[bucket].size, orfaos };
  }
  return resultado;
}

async function orfaosDeDenuncias() {
  const times = await todasAsLinhas('teams', 'id');
  const idsVivos = new Set(times.map((t) => t.id));
  const todos = await listarRecursivo('denuncias', 'casos');
  const orfaos = todos.filter((caminho) => {
    // casos/<teamId ou _sem>/<id>.json
    const partes = caminho.split('/');
    const teamId = partes[1];
    if (teamId === '_sem') return false; // sem time — fora do escopo desta varredura
    return !idsVivos.has(teamId);
  });
  return { total: todos.length, orfaos };
}

async function main() {
  console.log(`[orfaos] ${APAGAR ? 'EXECUÇÃO' : 'SIMULAÇÃO (dry-run — nada será apagado)'}\n`);

  const media = await orfaosDeMedia();
  for (const bucket of ['avatars', 'resenha']) {
    const r = media[bucket];
    console.log(`[orfaos] ${bucket}: ${r.total} objeto(s) no bucket, ${r.vivos} referência(s) viva(s), ${r.orfaos.length} órfão(s)`);
    r.orfaos.forEach((c) => console.log(`    - ${c}`));
  }

  const den = await orfaosDeDenuncias();
  console.log(`\n[orfaos] denuncias/casos: ${den.total} objeto(s), ${den.orfaos.length} órfão(s) (times que já não existem)`);
  den.orfaos.forEach((c) => console.log(`    - ${c}`));
  console.log('[orfaos] denuncias/_diagnostico, _gabinete, _plataforma, reporters e casos/_sem: FORA do escopo desta varredura, de propósito (ver cabeçalho do arquivo).');

  if (!APAGAR) {
    console.log('\n[orfaos] simulação concluída — rode com --apagar para remover de verdade.');
    return;
  }

  console.log('\n[orfaos] apagando...');
  for (const bucket of ['avatars', 'resenha']) {
    const lista = media[bucket].orfaos;
    if (!lista.length) continue;
    // eslint-disable-next-line no-await-in-loop
    const { error } = await supabase.storage.from(bucket).remove(lista);
    if (error) console.error(`[orfaos] ${bucket}: FALHOU — ${error.message}`);
    else console.log(`[orfaos] ${bucket}: ${lista.length} objeto(s) removido(s)`);
  }
  if (den.orfaos.length) {
    const { error } = await supabase.storage.from('denuncias').remove(den.orfaos);
    if (error) console.error(`[orfaos] denuncias: FALHOU — ${error.message}`);
    else console.log(`[orfaos] denuncias: ${den.orfaos.length} objeto(s) removido(s)`);
  }
}

main().catch((e) => {
  console.error(`[orfaos] ERRO: ${e.message}`);
  process.exit(1);
});
