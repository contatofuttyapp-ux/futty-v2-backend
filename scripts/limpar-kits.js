// Futty v2.0 — Inventário e limpeza do bucket PÚBLICO `kits` (os kits da figurinha, os avatares genéricos, as silhuetas das contas fictícias).
//
// Cada objeto do bucket cai numa de quatro classes:
//   · APP     — o nome (ou a pasta dele, ex. `silhuetas/`) aparece no código do app: telas (src/, public/) ou motor (fora de scripts/_bench).
//   · BANCO   — alguma linha do banco aponta para ele (avatar, foto, foto original, histórico de avatar, slot, logo de time, fotos do jogo).
//   · BANCADA — só uma bancada (backend/scripts/_bench, frontend/scripts/_bench) cita o nome.
//   · SOBRA   — ninguém cita: arquivo temporário de bancada que não foi apagado, ou asset aposentado.
// Só SOBRA é apagada. BANCADA só com --com-bancada. APP e BANCO nunca. Nada com menos de 1 dia (ou sem data) é apagado: pode ser o
// temporário de uma bancada que ainda está rodando.
// Se uma tabela do banco não puder ser lida, o script PARA sem apagar nada (sem saber quem usa, nada é sobra).
//
// ⚠️ Fala com o Supabase DE VERDADE (o do .env). Rodar só quando o Pedro pedir; a simulação primeiro.
//
// Uso (de backend/, com o .env do motor):
//   node scripts/limpar-kits.js                          → SIMULAÇÃO: a tabela das quatro classes. Não altera nada.
//   node scripts/limpar-kits.js --apagar --confirmo      → apaga as SOBRAS. As duas flags juntas.
//   node scripts/limpar-kits.js --apagar --confirmo --com-bancada   → apaga também as de BANCADA.
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BUCKET = 'kits';
const args = process.argv.slice(2);
const tem = (f) => args.includes(`--${f}`);
const APAGAR = tem('apagar') && tem('confirmo');
const COM_BANCADA = tem('com-bancada');
const UM_DIA_MS = 24 * 3600 * 1000;

/** Os arquivos de texto versionados de um repositório, como um texto só por grupo (app × bancada). */
function textoDoRepo(raiz) {
  const app = [];
  const bancada = [];
  let lista = [];
  try { lista = execFileSync('git', ['-C', raiz, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return null; }
  for (const f of lista) {
    if (!/\.(js|jsx|mjs|cjs|css|html|json|md)$/.test(f) || f.includes('node_modules/') || /(^|\/)HISTORICO\.md$/.test(f) || f === 'package-lock.json') continue;
    let s;
    try { s = fs.readFileSync(path.join(raiz, f), 'utf8'); } catch { continue; }
    (f.includes('scripts/_bench/') ? bancada : app).push(s);
  }
  return { app: app.join('\n'), bancada: bancada.join('\n') };
}

async function listarRecursivo(supabase, prefixo = '') {
  const objetos = [];
  let offset = 0;
  const LIMITE = 1000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase.storage.from(BUCKET).list(prefixo, { limit: LIMITE, offset });
    if (error) throw new Error(`${BUCKET}/${prefixo}: ${error.message}`);
    for (const item of data || []) {
      const caminho = prefixo ? `${prefixo}/${item.name}` : item.name;
      // eslint-disable-next-line no-await-in-loop
      if (item.id === null) objetos.push(...(await listarRecursivo(supabase, caminho)));
      else objetos.push({ caminho, bytes: item.metadata?.size ?? null, criado: item.created_at || null });
    }
    if (!data || data.length < LIMITE) break;
    offset += LIMITE;
  }
  return objetos;
}

/** Todas as URLs do banco que apontam para o bucket (as colunas que guardam imagem). */
async function referenciasDoBanco(supabase) {
  const COLUNAS = [
    ['users', 'avatar_url'], ['users', 'foto_url'], ['users', 'foto_original_url'], ['user_avatar_historico', 'avatar_url'], ['user_avatar_slots', 'avatar_url'],
    ['teams', 'logo_url'], ['games', 'campeao_foto_url'], ['games', 'rodada_foto_url'],
  ];
  const urls = [];
  for (const [tabela, coluna] of COLUNAS) {
    let de = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { data, error } = await supabase.from(tabela).select(coluna).like(coluna, `%/object/public/${BUCKET}/%`).range(de, de + 999);
      if (error) throw new Error(`não deu para ler ${tabela}.${coluna} (${error.message}) — nada foi apagado`);
      urls.push(...(data || []).map((l) => l[coluna]));
      if (!data || data.length < 1000) break;
      de += 1000;
    }
  }
  return urls;
}

(async () => {
  const conhecidas = ['apagar', 'confirmo', 'com-bancada'];
  const desconhecidas = args.filter((a) => !conhecidas.some((c) => a === `--${c}`));
  if (desconhecidas.length) throw new Error(`opção desconhecida: ${desconhecidas.join(' ')}`);
  if (tem('apagar') !== tem('confirmo')) throw new Error('para apagar são as duas flags juntas: --apagar --confirmo');
  const { supabase } = require('../utils/db'); // eslint-disable-line global-require

  const motor = textoDoRepo(path.resolve(__dirname, '..'));
  const telas = textoDoRepo(path.resolve(__dirname, '..', '..', 'frontend'));
  if (!motor || !telas) throw new Error('não achei os dois repositórios (backend e frontend lado a lado) — nada foi apagado');
  const codigoDoApp = `${motor.app}\n${telas.app}`;
  const codigoDeBancada = `${motor.bancada}\n${telas.bancada}`;

  const objetos = await listarRecursivo(supabase);
  const doBanco = await referenciasDoBanco(supabase);
  const classe = (o) => {
    const pasta = o.caminho.includes('/') ? `${o.caminho.slice(0, o.caminho.lastIndexOf('/'))}/` : null;
    if (codigoDoApp.includes(o.caminho) || (pasta && codigoDoApp.includes(pasta))) return 'APP';
    if (doBanco.some((u) => decodeURIComponent(String(u).split('?')[0]).endsWith(`/${BUCKET}/${o.caminho}`))) return 'BANCO';
    if (codigoDeBancada.includes(o.caminho) || codigoDeBancada.includes(path.posix.basename(o.caminho))) return 'BANCADA';
    return 'SOBRA';
  };
  const porClasse = { APP: [], BANCO: [], BANCADA: [], SOBRA: [] };
  for (const o of objetos) porClasse[classe(o)].push(o);
  const kb = (n) => (n == null ? '?' : `${Math.round(n / 1024)} KB`);
  for (const [nome, lista] of Object.entries(porClasse)) {
    const total = lista.reduce((s, o) => s + (o.bytes || 0), 0);
    console.log(`\n${nome} · ${lista.length} arquivo(s) · ${kb(total)}`);
    for (const o of lista.sort((a, b) => a.caminho.localeCompare(b.caminho))) console.log(`   ${o.caminho}  (${kb(o.bytes)}${o.criado ? `, ${o.criado.slice(0, 10)}` : ''})`);
  }

  const velho = (o) => o.criado && Date.now() - new Date(o.criado).getTime() > UM_DIA_MS;
  const apagar = [...porClasse.SOBRA, ...(COM_BANCADA ? porClasse.BANCADA : [])].filter(velho).map((o) => o.caminho);
  if (!APAGAR) {
    console.log(`\nSIMULAÇÃO: ${apagar.length} arquivo(s) sairiam${COM_BANCADA ? ' (com os de bancada)' : ''}. Para apagar: --apagar --confirmo`);
    return;
  }
  for (let i = 0; i < apagar.length; i += 100) {
    // eslint-disable-next-line no-await-in-loop
    const { error } = await supabase.storage.from(BUCKET).remove(apagar.slice(i, i + 100));
    if (error) throw new Error(`falhou ao apagar: ${error.message}`);
  }
  console.log(`\nApagados: ${apagar.length} arquivo(s) do bucket ${BUCKET}.`);
})().catch((e) => { console.error(`[limpar-kits] ${e.message}`); process.exit(1); });
