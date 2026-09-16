// Futty v2.0 — Rodada 12B: campanha de PRÉVIA para o slot IAB 320×100 da
// página do sorteio, para o Pedro ver o tamanho/proporção reais na tela antes
// de qualquer acordo comercial (ver Rodada 12A no frontend, que já criou o
// slot). Gera uma imagem-placeholder (fundo vermelho sólido, "PUBLICIDADE
// 320×100" em branco — propositalmente chamativa, ninguém confunde com um
// anúncio real), sobe para o Storage e liga a campanha só na página 'sorteio'.
//
// Idempotente: id fixo (CAMPANHA_ID) — rodar de novo ATUALIZA a mesma
// campanha (nova imagem, mesmos dados) em vez de duplicar.
//
// Uso: node scripts/criar-campanha-previa-sorteio.js
//
// Para DESLIGAR depois (o Pedro, pelo Gabinete → Anúncios):
//   - apagar a campanha "Prévia do slot do sorteio" da lista, OU
//   - desligar o toggle da página 'sorteio' (some daqui e de qualquer outra
//     campanha futura ligada a essa página), OU
//   - mudar o estado da campanha para algo diferente de 'ativa'.
require('dotenv').config({ quiet: true });
const sharp = require('sharp');
const { supabase } = require('../utils/db');
const gabineteStore = require('../utils/gabineteStore');
const { obterAd } = require('../services/inicio');

const CAMPANHA_ID = 'previa-sorteio-320x100'; // fixo de propósito (ver idempotência acima)
// O bucket "avatars" (o único que a rota de upload de fotos usa) está com
// `public: false` no Supabase real — quem serve as fotos ao vivo é o proxy
// assinado (/api/media/:token, utils/mediaToken.js), nunca getPublicUrl()
// direto. Anúncios não passam por esse proxy (o AdCard usa <img src=imagem_url>
// direto), então precisam de um bucket público de verdade. "ads" é novo, criado
// aqui de forma idempotente (mesmo padrão do ensureAvatarsBucket em utils/db.js).
const BUCKET = 'ads';
const CAMINHO_IMAGEM = 'previa-sorteio-320x100.webp';
const LARGURA = 640; // 2× o slot (320×100), mesmo critério do "App leve" do frontend
const ALTURA = 200;

/** Garante o bucket público "ads" no Storage (idempotente, mesmo padrão de ensureAvatarsBucket). */
async function ensureAdsBucket() {
  const { data: existente } = await supabase.storage.getBucket(BUCKET);
  if (existente) {
    if (existente.public !== true) throw new Error(`bucket "${BUCKET}" existe mas NÃO é público — corrija manualmente no Supabase (Storage → ${BUCKET} → Edit bucket → Public).`);
    return;
  }
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: '2MB',
    allowedMimeTypes: ['image/webp', 'image/jpeg', 'image/png'],
  });
  if (error && !/exist/i.test(error.message)) throw new Error(`criar bucket "${BUCKET}": ${error.message}`);
}

function svgPlaca() {
  return `<svg width="${LARGURA}" height="${ALTURA}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${LARGURA}" height="${ALTURA}" fill="#e02020"/>
  <text x="${LARGURA / 2}" y="${ALTURA / 2}" font-family="Arial, Helvetica, sans-serif" font-size="52" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="central">PUBLICIDADE 320&#215;100</text>
</svg>`;
}

async function gerarESubirImagem() {
  await ensureAdsBucket();

  const buffer = await sharp(Buffer.from(svgPlaca()))
    .flatten({ background: '#e02020' }) // sem canal alpha — é um retângulo sólido
    .webp({ quality: 90 })
    .toBuffer();

  const { error } = await supabase.storage.from(BUCKET).upload(CAMINHO_IMAGEM, buffer, {
    contentType: 'image/webp',
    upsert: true,
    cacheControl: '3600',
  });
  if (error) throw new Error(`upload no Storage (${BUCKET}/${CAMINHO_IMAGEM}): ${error.message}`);

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(CAMINHO_IMAGEM);
  return { url: `${pub.publicUrl}?v=${Date.now()}`, bytes: buffer.length };
}

async function gravarCampanha(imagemUrl) {
  // lerRaw() (sem cache) + o objeto INTEIRO de volta no gravar(): o store
  // grava tudo o que recebe, e o que faltar no payload cai para o SEED — ler
  // pela metade apagaria custos_fixos/registros/acessos reais do dono.
  const atual = await gabineteStore.lerRaw();
  const campanhas = Array.isArray(atual.campanhas) ? atual.campanhas : [];
  const jaExiste = campanhas.some((c) => c.id === CAMPANHA_ID);

  const campanha = {
    id: CAMPANHA_ID,
    nome: 'Prévia do slot do sorteio',
    anunciante: 'Futty (prévia interna)',
    texto: 'Prévia do slot do sorteio',
    sub: 'Peça de teste 320×100 — desligar em Gabinete → Anúncios',
    cta: 'Ver',
    link: 'https://futtyapp.com.br',
    imagem_url: imagemUrl,
    estado: 'ativa',
    inicio: '',
    fim: '',
    paginas: ['sorteio'],
    cls: 'livre',
  };

  const novaLista = jaExiste
    ? campanhas.map((c) => (c.id === CAMPANHA_ID ? campanha : c))
    : [...campanhas, campanha];

  const gravado = await gabineteStore.gravar({
    ...atual,
    campanhas: novaLista,
    toggles: { ...atual.toggles, sorteio: true },
  });

  return { gravado, jaExiste };
}

// O mesmo hash de services/inicio.js (metadeDasVezes) — só para o relatório
// explicar se um teste com o Pedro (plano elite) pode dar `null` por rotação
// e não por a campanha estar mal configurada.
function metadeDasVezes(userId, hoje) {
  const s = `${userId}:${hoje}`;
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0) % 2 === 0;
}

async function confirmarComObterAd() {
  const { data: pedro } = await supabase
    .from('users')
    .select('id, nome, email, plan')
    .eq('email', 'contatofuttyapp@gmail.com')
    .maybeSingle();
  if (!pedro) {
    console.log('[criar-campanha] aviso: não achei contatofuttyapp@gmail.com para o teste de obterAd().');
    return;
  }

  const hoje = new Date().toISOString().slice(0, 10);
  const veriaPelaRotacao = pedro.plan === 'free' ? true : metadeDasVezes(pedro.id, hoje);
  const resultado = await obterAd('sorteio', pedro.id);

  console.log(`\n[criar-campanha] obterAd('sorteio', ${pedro.email} · plano ${pedro.plan}):`);
  console.log(`  ad: ${resultado.ad ? `"${resultado.ad.texto}" (id ${resultado.ad.id}, imagem ${resultado.ad.imagem_url ? 'sim' : 'não'})` : 'null'}`);
  if (!resultado.ad && pedro.plan !== 'free' && !veriaPelaRotacao) {
    console.log('  (plano pro/elite vê só metade das vezes — hoje a rotação por hash NÃO calhou para esta conta; é esperado, não é falha da campanha)');
  }

  // Também sem login (anônimo) — sempre determinístico, prova a campanha em si.
  const anonimo = await obterAd('sorteio', null);
  console.log(`[criar-campanha] obterAd('sorteio', <anônimo>): ad: ${anonimo.ad ? `"${anonimo.ad.texto}"` : 'null'}`);
}

async function main() {
  console.log('[criar-campanha] gerando imagem 640×200 WebP (placeholder vermelho)...');
  const { url, bytes } = await gerarESubirImagem();
  console.log(`[criar-campanha] imagem no Storage: ${url} (${bytes} bytes)`);

  const { jaExiste } = await gravarCampanha(url);
  console.log(`[criar-campanha] campanha "${CAMPANHA_ID}" ${jaExiste ? 'atualizada' : 'criada'} · página 'sorteio' ligada (toggles.sorteio = true).`);

  await confirmarComObterAd();

  console.log('\n[criar-campanha] para desligar: Gabinete → Anúncios → apagar "Prévia do slot do sorteio"');
  console.log('[criar-campanha] (ou desligar o toggle da página "sorteio", ou mudar o estado da campanha).');
}

main().catch((e) => {
  console.error(`[criar-campanha] ERRO: ${e.message}`);
  process.exit(1);
});
