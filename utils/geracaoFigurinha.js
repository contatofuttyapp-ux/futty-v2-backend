// ═══════════════════════════════════════════════════════════════════════════════
// A RECEITA DA FIGURINHA BRILHANTE — num sítio só. Duas, na verdade:
//
//   'v6'            (PADRÃO desde 22-set, SPEC-FIGURINHA-3) — UMA chamada ao
//                   gpt-image-1.5/edit em low com `input_fidelity: high`, foto
//                   quadrada + imagem do kit, saída 1024×1536, birefnet no fim.
//                   US$0,112. É a que o dono avaliou em 4,1/5 na bancada cega
//                   de 17-set, a melhor de todas as testadas. A Brilhante é
//                   PAGA — quem paga leva a melhor, não a mais barata.
//   'duas-passadas' US$0,05, descrita em detalhe abaixo. Continua inteira e
//                   disponível por `FIGURINHA_RECEITA=duas-passadas`: se um dia
//                   o custo apertar, a troca é uma variável de ambiente.
//
// O QUE SEGUE descreve a receita das duas passadas (18/22-set).
//
// Porque duas: nenhum motor sozinho dava as duas coisas que a figurinha precisa.
// O gpt-image-2.5 acerta a CARA mas entrega um retoque de foto; o gpt-image-1.5
// pinta como a casa quer mas, sozinho e em fidelidade alta, custava US$0,112.
// Postos em série — o 2.5 faz o retrato, o 1.5 só repinta — sai US$0,05.
//
//   passada 1   openai/gpt-image-2.5/flare/edit · low · foto quadrada + kit
//               → a cara. US$0,025.
//   entre elas  birefnet + composição sobre #8a8a8a: a passada 2 tem de receber
//               o jogador num fundo CHAPADO. O prompt da passada 1 pede cinza,
//               mas modelo nenhum promete fundo sem sombra — e uma sombra no
//               fundo vira mancha pintada na passada 2.
//   passada 2   fal-ai/gpt-image-1.5/edit · low · input_fidelity LOW · 1 imagem
//               → o acabamento. Fidelidade BAIXA de propósito: são 135 tokens de
//               imagem em vez de 3.050, e a imagem que entra já é a resposta
//               certa — não há nada para "ler com atenção". US$0,020.
//   birefnet    o recorte final que a composição do app usa. US$0,002.
//
// O QUE ESTA BANCADA REPROVOU (não reabrir sem motivo, ver CLAUDE.md):
// encolher as imagens de entrada (a fal tokeniza num tamanho canónico — o preço
// não muda), repintar com flux-2 klein (troca a pessoa), difusão direto da foto
// (cartoon) e kit só por texto (perde o emblema em 7 de 7).
//
// Esta função é a fonte ÚNICA: `routes/auth.js` e a bancada
// `scripts/_bench/testar-economia.js` chamam-na, ninguém copia a receita.
// ═══════════════════════════════════════════════════════════════════════════════
const sharp = require('sharp');
const { chamarFal, emDolares } = require('./falFila');
const { montarPrompt, promptRepintura } = require('../prompts/figurinha');

// Os endpoints e os parâmetros que definem a receita. Todos com override por
// ambiente: trocar de motor ou de qualidade não devia precisar de deploy —
// mas também não devia acontecer sem uma bancada a dizer que vale a pena.
const PASSADA1_ENDPOINT = process.env.FAL_PASSADA1_ENDPOINT || 'openai/gpt-image-2.5/flare/edit';
const PASSADA2_ENDPOINT = process.env.FAL_PASSADA2_ENDPOINT || 'fal-ai/gpt-image-1.5/edit';
const BIREFNET_ENDPOINT = process.env.FAL_BIREFNET_ENDPOINT || 'fal-ai/birefnet';
const QUALIDADE = process.env.FAL_QUALITY || 'low';
// A RECEITA (SPEC-FIGURINHA-3, 22-set): a Brilhante é paga, por isso leva a
// MELHOR — a V6, que o dono avaliou em 4,1/5 contra as duas passadas. As duas
// passadas ficam disponíveis por env (`FIGURINHA_RECEITA=duas-passadas`):
// custam US$0,05 contra US$0,112 e servem se um dia o custo apertar.
const RECEITA = process.env.FIGURINHA_RECEITA === 'duas-passadas' ? 'duas-passadas' : 'v6';
// A V6 é o mesmo motor da passada 2, com a fidelidade ALTA e as duas imagens
// (foto quadrada + kit) numa chamada só — é daí que vem a semelhança.
const V6_ENDPOINT = process.env.FAL_V6_ENDPOINT || 'fal-ai/gpt-image-1.5/edit';
const FIDELIDADE_V6 = process.env.FAL_INPUT_FIDELITY || 'high';
// Fidelidade da imagem de entrada da PASSADA 2. Baixa é a receita aprovada e é
// onde está a economia; alta aqui devolveria o custo da V6 sem melhorar nada.
const FIDELIDADE_PASSADA2 = process.env.FAL_INPUT_FIDELITY_PASSADA2 || 'low';
// A saída fica em retrato: é o que dá altura para cabeça + busto sem cortar a
// coroa (receita de 30-jul; em quadrado o achatamento ia a 0,72). Os dois
// motores querem o tamanho em formatos DIFERENTES e trocá-los dá 422: o
// gpt-image-1.5 só aceita o enum em string, o 2.5 aceita {width,height}.
const TAMANHO_2_5 = { width: 1024, height: 1536 };
const TAMANHO_1_5 = '1024x1536';
const CINZA_FUNDO = { r: 0x8a, g: 0x8a, b: 0x8a };

const baixar = async (url) => Buffer.from(await (await fetch(url)).arrayBuffer());

/**
 * Gera uma figurinha pelas duas passadas.
 *
 * @param {object} opcoes
 * @param {string} opcoes.fotoUrl   URL da foto já quadrada (utils/entradaFigurinha.js)
 * @param {string} opcoes.kitUrl    URL do asset do kit
 * @param {string} opcoes.kitId     id do kit, para montar o prompt da passada 1
 * @param {(caminho: string, buffer: Buffer, tipo: string) => Promise<string>} opcoes.publicar
 *        sobe um buffer e devolve um URL que a fal consiga buscar. A fal só lê
 *        URLs públicos; quem chama decide onde põe (bucket da app, bucket da
 *        bancada) e trata de apagar depois.
 * @param {string} [opcoes.etiqueta] prefixo dos ficheiros temporários
 *
 * @returns {Promise<{ recorteBuffer: Buffer, custo: object, tempos: object, urls: object }>}
 *   `recorteBuffer` é o PNG recortado (com alpha), pronto para o auditor de
 *   coroa e para a composição. `custo.usd` é a soma REAL de todas as chamadas.
 */
async function gerarFigurinha({ fotoUrl, kitUrl, kitId, publicar, etiqueta = 'fig', receita = RECEITA }) {
  const custo = { usd: 0, chamadas: 0, semHeader: 0, parcelas: {} };
  const tempos = {};
  const somar = (nome, endpoint, resposta) => {
    const conv = emDolares(endpoint, resposta.custo);
    custo.chamadas += 1;
    if (conv.usd != null) custo.usd += conv.usd; else custo.semHeader += 1;
    custo.parcelas[nome] = { usd: conv.usd, nota: conv.nota };
    tempos[nome] = Math.round(resposta.segundos);
  };

  // ── V6: uma chamada só, fidelidade ALTA, foto quadrada + kit ──
  // A receita que o dono escolheu em 17-set (4,1/5 na avaliação cega das 7
  // fotos) e que desde 22-set é a da Brilhante, porque a Brilhante é paga.
  if (receita === 'v6') {
    const g = await chamarFal(V6_ENDPOINT, {
      prompt: montarPrompt(kitId),
      image_urls: [fotoUrl, kitUrl],
      quality: QUALIDADE,
      image_size: TAMANHO_1_5,
      input_fidelity: FIDELIDADE_V6,
      num_images: 1,
    });
    somar('v6', V6_ENDPOINT, g);
    const urlV6 = g.dados?.images?.[0]?.url;
    if (!urlV6) throw new Error('a V6 não devolveu imagem');

    const rec = await chamarFal(BIREFNET_ENDPOINT, { image_url: urlV6, model: 'General Use (Light)' });
    somar('birefnet', BIREFNET_ENDPOINT, rec);
    const urlRec = rec.dados?.image?.url;
    if (!urlRec) throw new Error('o birefnet não devolveu imagem');

    return {
      recorteBuffer: await baixar(urlRec),
      custo,
      tempos,
      receita: 'v6',
      urls: { v6: urlV6, recorte: urlRec },
    };
  }

  // ── PASSADA 1: a cara ──
  const p1 = await chamarFal(PASSADA1_ENDPOINT, {
    prompt: montarPrompt(kitId),
    image_urls: [fotoUrl, kitUrl],
    quality: QUALIDADE,
    image_size: TAMANHO_2_5,
    num_images: 1,
    output_format: 'png',
  });
  somar('passada1', PASSADA1_ENDPOINT, p1);
  const urlP1 = p1.dados?.images?.[0]?.url;
  if (!urlP1) throw new Error('a passada 1 não devolveu imagem');

  // ── ENTRE AS PASSADAS: fundo mesmo chapado ──
  const rec1 = await chamarFal(BIREFNET_ENDPOINT, { image_url: urlP1, model: 'General Use (Light)' });
  somar('birefnet_meio', BIREFNET_ENDPOINT, rec1);
  const urlRec1 = rec1.dados?.image?.url;
  if (!urlRec1) throw new Error('o birefnet do meio não devolveu imagem');

  const trimado = await sharp(await baixar(urlRec1)).trim({ threshold: 10 }).png().toBuffer();
  // O jogador entra na passada 2 com o mesmo enquadramento que o app mostra:
  // 82% da largura, 80% da altura, assente a 94% da base. Se ele chegasse
  // colado ao topo, a passada 2 repintava a coroa contra a borda.
  const jogador = await sharp(trimado)
    .resize({
      width: Math.round(TAMANHO_2_5.width * 0.82),
      height: Math.round(TAMANHO_2_5.height * 0.80),
      fit: 'inside',
    })
    .png().toBuffer();
  const mj = await sharp(jogador).metadata();
  const paraP2 = await sharp({
    create: { width: TAMANHO_2_5.width, height: TAMANHO_2_5.height, channels: 3, background: CINZA_FUNDO },
  })
    .composite([{
      input: jogador,
      left: Math.round((TAMANHO_2_5.width - mj.width) / 2),
      top: Math.round(TAMANHO_2_5.height * 0.94) - mj.height,
    }])
    .png().toBuffer();

  const urlParaP2 = await publicar(`${etiqueta}-p1.png`, paraP2, 'image/png');

  // ── PASSADA 2: o acabamento ──
  const p2 = await chamarFal(PASSADA2_ENDPOINT, {
    prompt: promptRepintura(),
    image_urls: [urlParaP2],
    quality: QUALIDADE,
    image_size: TAMANHO_1_5,
    input_fidelity: FIDELIDADE_PASSADA2,
    num_images: 1,
  });
  somar('passada2', PASSADA2_ENDPOINT, p2);
  const urlP2 = p2.dados?.images?.[0]?.url;
  if (!urlP2) throw new Error('a passada 2 não devolveu imagem');

  // ── BIREFNET FINAL: o recorte que o app compõe ──
  const rec2 = await chamarFal(BIREFNET_ENDPOINT, { image_url: urlP2, model: 'General Use (Light)' });
  somar('birefnet_final', BIREFNET_ENDPOINT, rec2);
  const urlRec2 = rec2.dados?.image?.url;
  if (!urlRec2) throw new Error('o birefnet final não devolveu imagem');

  return {
    recorteBuffer: await baixar(urlRec2),
    custo,
    tempos,
    receita: 'duas-passadas',
    urls: { passada1: urlP1, passada2: urlP2, recorte: urlRec2 },
  };
}

module.exports = {
  gerarFigurinha,
  RECEITA,
  V6_ENDPOINT,
  FIDELIDADE_V6,
  PASSADA1_ENDPOINT,
  PASSADA2_ENDPOINT,
  BIREFNET_ENDPOINT,
  QUALIDADE,
  FIDELIDADE_PASSADA2,
  TAMANHO_1_5,
  TAMANHO_2_5,
};
