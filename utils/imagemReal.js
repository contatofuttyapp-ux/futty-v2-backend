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
//   3. (só o escudo, abaixo) o arquivo precisa decodificar como imagem.
// O que não decodifica de jeito nenhum (arquivo corrompido) NÃO é decidido aqui: segue para o passo seguinte de
// cada upload, que já tem a mensagem dele. Aqui só se barra o que é, de fato, um formato que não aceitamos.
const sharp = require('sharp');
const { HttpError } = require('./http');

// Nada no motor lê SVG (as figurinhas e os escudos são desenhados no app). Bloqueado, o sharp responde
// "unsupported image format" a qualquer SVG, qualquer que seja o Content-Type que ele traga.
sharp.block({ operation: ['VipsForeignLoadSvg'] });

const MSG_FORMATO = 'Esse arquivo não é uma imagem aceita.';
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
    return (await sharp(buffer).metadata()).format || null;
  } catch {
    return null;
  }
}

/**
 * Lança HttpError(400) se os bytes são de um formato FORA da lista (`mimetypesAceitos`, os mesmos tipos que o
 * upload declara aceitar). Arquivo que nada lê (null) passa: a decodificação seguinte de cada upload responde.
 * @param {Buffer} buffer
 * @param {string[]} mimetypesAceitos ex.: ['image/jpeg', 'image/png', 'image/webp']
 */
async function exigirFormatoReal(buffer, mimetypesAceitos) {
  const formato = await formatoReal(buffer);
  if (formato === null) return;
  const aceitos = new Set(mimetypesAceitos.map((m) => FORMATO_DO_MIME[m]).filter(Boolean));
  if (!aceitos.has(formato)) {
    console.warn('[imagem-real] rejeitada: o formato real não está na lista do upload', { formato });
    throw new HttpError(400, MSG_FORMATO);
  }
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

module.exports = { verificarImagemReal, exigirImagemReal, exigirFormatoReal, formatoReal, MSG_FORMATO, FORMATO_DO_MIME };
