// Futty v2.0 — Auto-orientar a foto pelo EXIF, SÓ quando há o que corrigir (Rodada 27, 25-set).
//
// O recorte e a original que o app manda saem de um canvas (utils/normalizarFoto.js e o CropModal,
// no frontend): já em pé e sem EXIF. Recodificar isso a cada upload custava CPU (a original de
// celular, 3024×4032, ~175 ms), qualidade (JPEG de novo, a 80) e mais nada. Uma foto que traga EXIF
// (orientação, GPS, modelo do aparelho...) continua passando pelo .rotate().toBuffer(), que gira os
// pixels já em pé e DESCARTA o EXIF — a privacidade de antes fica igual.
const sharp = require('sharp');

/**
 * @param {Buffer} buffer a imagem como chegou
 * @returns {Promise<Buffer>} o MESMO buffer (nada a corrigir) ou uma cópia em pé e sem EXIF
 * @throws se a imagem não decodifica (quem chama transforma em 400)
 */
async function orientarSePreciso(buffer) {
  const meta = await sharp(buffer).metadata();
  const precisaGirar = meta.orientation != null && meta.orientation !== 1;
  if (!meta.exif && !precisaGirar) return buffer;
  return sharp(buffer).rotate().toBuffer();
}

module.exports = { orientarSePreciso };
