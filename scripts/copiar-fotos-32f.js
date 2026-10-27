// Futty v2.0 — Rodada 32F: copia as fotos e figurinhas do "Chavo" para nomes com o id da conta NOVA, antes do FUT\DADOS-32F.sql.
//
// Por que copiar (e não só deixar as URLs como estão): a exclusão de conta (utils/apagarUsuario.js) varre o bucket `avatars`
// pelo PREFIXO do id. Se a conta antiga for excluída um dia, levaria junto a foto e a figurinha que agora são da nova.
// Com o nome no id novo, cada arquivo fica com o dono certo. Nada é apagado: os arquivos antigos ficam onde estão.
//
// Só a pasta `public/` (fotos, originais, figurinhas). A `tmp/` são temporários da pintura e ficam fora (só listados).
// O DADOS-32F.sql confere que cada cópia existe antes de trocar as URLs; sem ela, ele recusa e não muda nada.
//
// ⚠️ Fala com o Supabase DE VERDADE (o do .env). Rodar só quando o Pedro pedir; a simulação primeiro.
//
// Uso (de backend/, com o .env do motor):
//   node scripts/copiar-fotos-32f.js                       → SIMULAÇÃO: lista o que seria copiado. Não altera nada.
//   node scripts/copiar-fotos-32f.js --copiar --confirmo   → copia. As duas flags juntas. Rodar de novo pula o que já foi copiado.

const BUCKET = 'avatars';
const CONTAS = {
  antiga: { id: 'c3626394-6589-423e-ae6a-e71317366ec4', email: 'contatofuttyapp@gmail.com' },
  nova: { id: 'b8c879e2-9997-4ef7-883d-77e6a77e6000', email: 'phferreiraborgesbackup@gmail.com' },
};

/** As contas do banco têm de ser as do mapa (o .env aponta para o projeto certo). Lança se não forem. */
async function conferirContas(cliente) {
  for (const [qual, c] of Object.entries(CONTAS)) {
    const { data, error } = await cliente.from('users').select('id').eq('email', c.email).maybeSingle();
    if (error) throw new Error(`users (${qual}): ${error.message}`);
    if (data?.id !== c.id) throw new Error(`A conta ${qual} (${c.email}) não tem o id do mapa (${data?.id || 'nenhuma'}). Nada foi copiado.`);
  }
}

/** Os arquivos de uma pasta do bucket cujo nome começa por `prefixo`. */
async function listar(cliente, pasta, prefixo) {
  const { data, error } = await cliente.storage.from(BUCKET).list(pasta, { limit: 1000, search: prefixo });
  if (error) throw new Error(`${BUCKET}/${pasta}: ${error.message}`);
  return (data || []).filter((f) => f.name.startsWith(prefixo)).map((f) => `${pasta}/${f.name}`);
}

/**
 * O plano: cada arquivo `public/<antiga>…` com o destino `public/<nova>…` e se o destino já existe. A troca é só do id no
 * começo do nome — o resto (carimbo, kit, extensão) fica igual, que é o que o DADOS-32F.sql espera ao trocar as URLs.
 */
async function planejar(cliente, { antiga = CONTAS.antiga.id, nova = CONTAS.nova.id } = {}) {
  const [origem, jaNovos, temporarios] = await Promise.all([
    listar(cliente, 'public', antiga), listar(cliente, 'public', nova), listar(cliente, 'tmp', antiga),
  ]);
  const existentes = new Set(jaNovos);
  const copias = origem.map((de) => {
    const para = `public/${nova}${de.slice(`public/${antiga}`.length)}`;
    return { de, para, jaExiste: existentes.has(para) };
  });
  return { copias, temporarios };
}

/** Copia o que falta. Devolve quantas copiou. Nunca apaga nem sobrescreve. */
async function copiar(cliente, copias) {
  let feitas = 0;
  for (const c of copias) {
    if (c.jaExiste) continue;
    // eslint-disable-next-line no-await-in-loop
    const { error } = await cliente.storage.from(BUCKET).copy(c.de, c.para);
    if (error) throw new Error(`copiar ${c.de} → ${c.para}: ${error.message} (as anteriores ficaram copiadas; rodar de novo continua daqui)`);
    feitas += 1;
  }
  return feitas;
}

async function main() {
  require('dotenv').config({ quiet: true });
  const { supabase } = require('../utils/db');
  const args = process.argv.slice(2);
  const valer = args.includes('--copiar') && args.includes('--confirmo');

  await conferirContas(supabase);
  const { copias, temporarios } = await planejar(supabase);
  console.log(`[32F] bucket ${BUCKET}: ${copias.length} arquivo(s) da conta antiga em public/`);
  for (const c of copias) console.log(`  ${c.jaExiste ? 'JÁ COPIADO ' : 'copiar     '} ${c.de}\n             → ${c.para}`);
  if (temporarios.length) console.log(`[32F] ${temporarios.length} temporário(s) em tmp/ (ficam de fora): ${temporarios.join(', ')}`);
  if (!valer) {
    console.log('\n[32F] SIMULAÇÃO: nada foi copiado. Para copiar: node scripts/copiar-fotos-32f.js --copiar --confirmo');
    return;
  }
  const feitas = await copiar(supabase, copias);
  const { copias: depois } = await planejar(supabase);
  const faltam = depois.filter((c) => !c.jaExiste);
  console.log(`\n[32F] copiados agora: ${feitas} · já estavam: ${copias.length - feitas} · faltando: ${faltam.length}`);
  if (faltam.length) process.exitCode = 1;
  else console.log('[32F] Pronto. Agora o FUT\\DADOS-32F.sql no SQL Editor.');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[32F] ERRO:', e.message);
    process.exit(1);
  });
}

module.exports = { CONTAS, conferirContas, planejar, copiar };
