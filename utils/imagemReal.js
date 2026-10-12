// Futty v2.0 — Confirma que um upload é uma imagem de verdade, do formato que a lista do upload aceita
// (SEGURANCA-REVISAO-10SET.md secção 3; pentest ZAP B1). O Content-Type que o cliente declara é só texto: o
// sharp descobre o formato pelos BYTES. Sem esta conferência, um SVG com Content-Type image/png passava pelo
// filtro do multer e chegava à librsvg, o leitor de SVG do sharp (CVE do pentest), na primeira leitura.
//
// Três travas, nesta ordem:
//   1. SVG nunca chega à librsvg: o loader é bloqueado no sharp (nenhuma parte do motor lê SVG) e um olhar nos
//      primeiros bytes já reconhece texto de marcação (XML/SVG/HTML) para dar a mensagem certa;
//   2. o formato real (sharp(buf).metadata().format) tem de estar na lista do upload — avatar JPEG/PNG/WebP,
//      escudo JPEG/PNG/WebP, Resenha JPEG/PNG/GIF/WebP; TIFF, HEIF/AVIF e o resto levam 400;
//   3. (só o escudo, abaixo) o arquivo precisa decodificar como imagem;
//   4. o tamanho em PIXELS cabe no teto (LIMITE_PIXELS): um PNG minúsculo em bytes pode declarar dezenas de milhares de pixels de lado e
//      estourar a memória do motor ao decodificar. O cabeçalho diz as dimensões sem decodificar nada, então a conferência é barata.
// O vídeo (MP4 da Resenha, dormente na v1) tem a mesma ideia: a assinatura do arquivo (a caixa "ftyp" do contêiner) diz se é vídeo.
// O que não decodifica de jeito nenhum (arquivo corrompido) NÃO é decidido aqui: segue para o passo seguinte de
// cada upload, que já tem a mensagem dele. Aqui só se barra o que é, de fato, um formato que não aceitamos.
const sharp = require('sharp');
const { HttpError } = require('./http');

// Nada no motor lê SVG (as figurinhas e os escudos são desenhados no app). Bloqueado, o sharp responde
// "unsupported image format" a qualquer SVG, qualquer que seja o Content-Type que ele traga.
sharp.block({ operation: ['VipsForeignLoadSvg'] });

const MSG_FORMATO = 'Esse arquivo não é uma imagem aceita.';
const MSG_VIDEO = 'Esse arquivo não é um vídeo aceito.';
const MSG_PIXELS = 'Essa imagem é grande demais em pixels. Use uma foto comum do celular.';

// Foto de celular de 48 a 50 megapixels cabe com folga (8192 × 8192 = 67 MP); passando disso, só imagem fabricada para estourar a memória.
// O sharp tem um teto padrão de 268 MP, que ainda deixaria uma decodificação de ~1 GB pelo caminho: este é o teto da casa.
const LIMITE_PIXELS = 8192 * 8192;
/** O Content-Type de imagem → o nome do formato no sharp. */
const FORMATO_DO_MIME = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

// Marcação (XML, SVG, HTML) logo no começo, com ou sem BOM e espaço na frente (o \s do JS já cobre o BOM):
// nenhum JPEG/PNG/WebP/GIF começa assim.
const COMECA_COM_MARCACAO = /^\s*<(\?xml|svg|!doctype|!--|html)/i;
function pareceMarcacao(buffer) {
  return COMECA_COM_MARCACAO.test(buffer.subarray(0, 512).toString('utf8'));
}

/** O formato REAL do arquivo ('jpeg', 'png', 'webp', 'gif'…, 'marcacao' para XML/SVG/HTML) ou null se nada o lê. */
async function formatoReal(buffer) {
  if (!buffer || !buffer.length) return null;
  if (pareceMarcacao(buffer)) return 'marcacao';
  try {
    // Só o cabeçalho: sem o teto padrão do sharp (268 MP), que faria uma imagem enorme parecer "ilegível" e escapar da conferência de
    // pixels abaixo. Quem barra imagem grande é exigirPixelsDentroDoTeto.
    return (await sharp(buffer, { limitInputPixels: false }).metadata()).format || null;
  } catch {
    return null;
  }
}

/**
 * Lança HttpError(400) se a imagem declara mais pixels que o teto. Lê só o cabeçalho (nada é decodificado), por isso o próprio
 * teto padrão do sharp é desligado nesta leitura: quem decide aqui é LIMITE_PIXELS. Arquivo que nada lê passa (a decodificação
 * seguinte de cada upload responde).
 */
async function exigirPixelsDentroDoTeto(buffer) {
  if (!buffer || !buffer.length) return;
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: false }).metadata();
  } catch {
    return;
  }
  if ((meta.width || 0) * (meta.height || 0) > LIMITE_PIXELS) {
    console.warn('[imagem-real] rejeitada: pixels demais', { largura: meta.width, altura: meta.height });
    throw new HttpError(400, MSG_PIXELS);
  }
}

/**
 * Lança HttpError(400) se os bytes são de um formato FORA da lista (`mimetypesAceitos`, os mesmos tipos que o
 * upload declara aceitar). Arquivo que nada lê (null) passa: a decodificação seguinte de cada upload responde.
 * @param {Buffer} buffer
 * @param {string[]} mimetypesAceitos ex.: ['image/jpeg', 'image/png', 'image/webp']
 */
async function exigirFormatoReal(buffer, mimetypesAceitos) {
  // Os pixels primeiro: a conferência é só do cabeçalho e vale para qualquer formato que o sharp leia.
  await exigirPixelsDentroDoTeto(buffer);
  const formato = await formatoReal(buffer);
  if (formato === null) return;
  const aceitos = new Set(mimetypesAceitos.map((m) => FORMATO_DO_MIME[m]).filter(Boolean));
  if (!aceitos.has(formato)) {
    console.warn('[imagem-real] rejeitada: o formato real não está na lista do upload', { formato });
    throw new HttpError(400, MSG_FORMATO);
  }
}

// Marcas principais (major brand) da caixa "ftyp" de um MP4. QuickTime ('qt  '), HEIC/AVIF, áudio (M4A) e o resto não entram: o upload
// é "video/mp4".
const MARCAS_DE_MP4 = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'mp71', 'avc1', 'dash', 'M4V ', 'M4VH', 'M4VP', 'MSNV', 'mmp4', 'f4v ']);

/**
 * Os bytes são de um MP4 de verdade? Todo MP4 abre com a caixa "ftyp": 4 bytes de tamanho, "ftyp" e a marca principal. Só os primeiros
 * bytes são lidos; um arquivo de texto, uma imagem ou um executável com Content-Type video/mp4 não passam.
 * @param {Buffer} buffer
 */
function ehMp4Real(buffer) {
  if (!buffer || buffer.length < 16) return false;
  const tamanho = buffer.readUInt32BE(0);
  if (buffer.toString('latin1', 4, 8) !== 'ftyp') return false;
  if (tamanho < 16 || tamanho > 4096 || tamanho > buffer.length) return false;
  return MARCAS_DE_MP4.has(buffer.toString('latin1', 8, 12));
}

/**
 * Middleware Express — corre DEPOIS do multer e ANTES de qualquer coisa que use o arquivo. Quando o tipo declarado é de vídeo, os bytes
 * têm de ser de um MP4; senão 400 com a frase da casa. Imagem e o resto seguem como sempre (quem confere imagem é exigirImagemReal).
 */
function exigirVideoReal(req, res, next) {
  const file = req.file;
  if (!file || !file.buffer || !String(file.mimetype || '').startsWith('video/')) return next();
  if (!ehMp4Real(file.buffer)) {
    console.warn('[video-real] rejeitado: os bytes não são de um MP4', { declarado: file.mimetype });
    return next(new HttpError(400, MSG_VIDEO));
  }
  return next();
}

/**
 * Middleware Express — corre DEPOIS do multer e ANTES de qualquer coisa que leia a imagem (NSFW, olheiro, sharp).
 * Confere req.file quando o tipo declarado é de imagem; vídeo e tipo fora da lista seguem como sempre (quem
 * responde por eles é o próprio upload).
 */
function exigirImagemReal(mimetypesAceitos) {
  return async (req, res, next) => {
    const file = req.file;
    if (!file || !file.buffer || !FORMATO_DO_MIME[file.mimetype]) return next();
    try {
      await exigirFormatoReal(file.buffer, mimetypesAceitos);
      return next();
    } catch (e) {
      return next(e);
    }
  };
}

const IMAGENS = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Middleware Express do escudo — corre DEPOIS do multer. Rejeita 400 se o ficheiro for de um formato fora da lista
 * ou não decodificar como imagem estática (ficheiro corrompido ou disfarçado). */
async function verificarImagemReal(req, res, next) {
  const file = req.file;
  if (!file || !file.buffer) return next();
  if (!IMAGENS.has(file.mimetype)) return next();
  try {
    await exigirFormatoReal(file.buffer, [...IMAGENS]);
  } catch (e) {
    return next(e);
  }
  try {
    await sharp(file.buffer).metadata();
    return next();
  } catch (e) {
    console.warn('[imagem-real] rejeitada: não decodifica', { user: req.user?.id, erro: e.message });
    return next(new HttpError(400, 'Arquivo inválido. Não é uma imagem.'));
  }
}

module.exports = {
  verificarImagemReal, exigirImagemReal, exigirFormatoReal, exigirPixelsDentroDoTeto, exigirVideoReal, ehMp4Real, formatoReal,
  MSG_FORMATO, MSG_VIDEO, MSG_PIXELS, LIMITE_PIXELS, FORMATO_DO_MIME,
};
