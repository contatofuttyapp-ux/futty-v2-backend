// Futty v2.0 — Derivados da mídia (Rodada 27, 25-set): o LRU em memória dos derivados WebP
// do proxy de imagem e a receita que os gera, num módulo só, para o PROXY (routes/media.js)
// e o UPLOAD DA FOTO (routes/auth.js) partilharem um cache.
//
// Por que isto existe. O proxy gera cada tamanho da foto na PRIMEIRA vez que alguém o pede
// (baixa o original do Storage, redimensiona, guarda no LRU). Depois de "Trocar foto" o primeiro
// pedido de cada tamanho era da própria pessoa, olhando a tela, e pagava tudo isso: ida ao
// Storage + sharp. Agora quem grava a foto já tem os bytes na mão e deixa os derivados que as
// telas vão pedir prontos (aquecerDerivados), sem baixar nada.
//
// Os derivados NÃO são gravados no Storage de propósito: um WebP de rosto que sobrevivesse à
// conta apagada seria um órfão com PII (LGPD). O LRU em memória morre com o processo.
//
// Vive só neste processo (nada distribuído): cada instância do Cloud Run tem o seu LRU. O
// aquecimento vale para a instância que recebeu o upload; nas outras o proxy gera na hora, como
// sempre gerou. Só a chave (bucket, caminho, versão, largura, quadrado) decide se é o mesmo derivado.
const crypto = require('node:crypto');
const sharp = require('sharp');
const { parseUrlPublico } = require('./storage');

const DEGRAUS = [128, 256, 512, 1024];
const LARGURA_MAX_SEM_W = 1600;
const TIPOS_REDIMENSIONAVEIS = new Set(['image/jpeg', 'image/png', 'image/webp']);

// LRU: 300 entradas ou 40 MB, o que bater primeiro. Map em JS preserva a ordem
// de inserção, por isso a chave mais antiga é sempre a primeira de keys().
const LRU_MAX_ENTRADAS = 300;
const LRU_MAX_BYTES = 40 * 1024 * 1024;
const cache = new Map();
let cacheBytes = 0;

function cacheLer(chave) {
  const item = cache.get(chave);
  if (!item) return null;
  // Reinsere no fim: passa a ser a mais recente.
  cache.delete(chave);
  cache.set(chave, item);
  return item;
}

function cacheGravar(chave, item) {
  if (cache.has(chave)) cacheBytes -= cache.get(chave).buf.length;
  cache.set(chave, item);
  cacheBytes += item.buf.length;
  while (cache.size > LRU_MAX_ENTRADAS || cacheBytes > LRU_MAX_BYTES) {
    const maisAntiga = cache.keys().next().value;
    if (maisAntiga === undefined) break;
    cacheBytes -= cache.get(maisAntiga).buf.length;
    cache.delete(maisAntiga);
  }
}

/** Só para os testes: esvazia o LRU e as gerações em curso. */
function limparCache() {
  cache.clear();
  cacheBytes = 0;
  emVoo.clear();
}

/** w pedido → o degrau mais próximo; sem w (ou lixo) → null (tamanho original). */
function normalizarLargura(bruto) {
  if (bruto === undefined || bruto === null || bruto === '') return null;
  const n = Number(bruto);
  if (!Number.isFinite(n) || n <= 0) return null;
  return DEGRAUS.reduce((melhor, d) => (Math.abs(d - n) < Math.abs(melhor - n) ? d : melhor), DEGRAUS[0]);
}

/** A chave do derivado: o `v` entra nela, conteúdo novo nunca é servido a partir de um derivado velho. */
function chaveDoDerivado({ bucket, path, v, largura, quadrado }) {
  return crypto
    .createHash('sha1')
    .update(`${bucket}:${path}:${v || ''}:${largura || 'orig'}:${quadrado ? 'sq' : 'livre'}`)
    .digest('hex');
}

/**
 * A receita: os bytes do original → o derivado ({ buf, tipo }). GIF (animado) e o que não for
 * imagem conhecida passam intactos: converter um GIF para WebP estático mataria a animação.
 * `quadrado` corta o quadrado do TOPO (RODADA 19: o recorte 2:3 já garante o rosto no terço de
 * cima; a 'attention' falhava em fotos de corpo inteiro, escolhendo o pulso em vez do rosto).
 */
async function gerarDerivado(original, tipoOriginal, { largura, quadrado }) {
  if (!TIPOS_REDIMENSIONAVEIS.has(tipoOriginal)) return { buf: original, tipo: tipoOriginal };
  const alvoLargura = largura || LARGURA_MAX_SEM_W;
  const medida = quadrado
    ? { width: alvoLargura, height: alvoLargura, fit: 'cover', position: 'top', withoutEnlargement: true }
    : { width: alvoLargura, withoutEnlargement: true };
  const buf = await sharp(original)
    .rotate() // respeita o EXIF antes de redimensionar
    .resize(medida)
    .webp({ quality: alvoLargura <= 256 ? 82 : 88, alphaQuality: 90, effort: 4 })
    .toBuffer();
  return { buf, tipo: 'image/webp' };
}

// Gerações em curso, por chave: dois pedidos do mesmo derivado (o do aquecimento e o da tela,
// ou duas telas) esperam a MESMA promessa em vez de baixar e redimensionar duas vezes.
const emVoo = new Map();

/**
 * O derivado da chave: do cache, de uma geração já em curso, ou gerado agora por `produzir`
 * (que devolve { buf, tipo } ou lança). `origem` diz de onde veio: 'cache' | 'voo' | 'gerado'.
 */
async function obterDerivado(chave, produzir) {
  const guardado = cacheLer(chave);
  if (guardado) return { ...guardado, origem: 'cache' };
  const emCurso = emVoo.get(chave);
  if (emCurso) return { ...(await emCurso), origem: 'voo' };
  const promessa = (async () => {
    const item = await produzir();
    cacheGravar(chave, item);
    return item;
  })();
  emVoo.set(chave, promessa);
  try {
    return { ...(await promessa), origem: 'gerado' };
  } finally {
    if (emVoo.get(chave) === promessa) emVoo.delete(chave);
  }
}

// Os tamanhos que as telas pedem da foto da PRÓPRIA pessoa (frontend, urlImagem): o card da
// Figurinha e o cromo do Início em 512; as miniaturas de lista (Ranking, Presença, Resenha) em
// 128 quadrado; o avatar do Perfil e o pré-aquecimento em 128; os avatares médios em 256.
// A ordem é a da urgência: quem abre a tela primeiro pede o 512.
const TAMANHOS_DA_FOTO = [
  { largura: 512, quadrado: false },
  { largura: 128, quadrado: true },
  { largura: 128, quadrado: false },
  { largura: 256, quadrado: false },
];

/**
 * Deixa no LRU os derivados da foto que acaba de ser gravada, a partir dos bytes que o motor já
 * tem (nada de baixar do Storage). `url` é o URL público COM o `?v=` que o upload gravou: é dele
 * que o token do proxy tira a versão, e a chave tem de bater com a do pedido. Não lança: é
 * adiantamento, nunca uma dependência. Devolve quantos derivados ficaram prontos.
 */
async function aquecerDerivados({ url, buffer, tipo }) {
  const alvo = parseUrlPublico(url);
  if (!alvo || !buffer) return 0;
  let prontos = 0;
  for (const t of TAMANHOS_DA_FOTO) {
    const chave = chaveDoDerivado({ ...alvo, ...t });
    try {
      await obterDerivado(chave, () => gerarDerivado(buffer, tipo, t));
      prontos += 1;
    } catch (e) {
      console.warn('[media] aquecer derivado falhou (o proxy gera na hora):', { largura: t.largura, quadrado: t.quadrado, erro: e.message });
    }
  }
  return prontos;
}

module.exports = {
  DEGRAUS,
  TAMANHOS_DA_FOTO,
  normalizarLargura,
  chaveDoDerivado,
  gerarDerivado,
  obterDerivado,
  aquecerDerivados,
  cacheLer,
  limparCache,
};
