// CONFERIR O KIT (bancada do prompt, 17-set) — não gasta nada, não chama a fal.
//
// A tabela do relatório pede "kits errados por variante". Julgar isso na folha
// de contacto é impossível: o emblema do peito tem 20 px lá. Este script corta
// a FAIXA DO PEITO de cada figurinha (onde vivem os cinco itens do checklist:
// base, painel diagonal, gola em V, punhos e emblema) e monta uma tira por foto,
// já com o número da variante — a chave cega é para o dono, a conferência
// técnica do kit é minha.
//
//   node scripts/_bench/conferir-kit.js            todas as fotos
//   node scripts/_bench/conferir-kit.js Renato     só uma
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SAIDA = path.join(__dirname, 'saida-prompt');
const filtro = process.argv[2];

(async () => {
  const pastas = fs.readdirSync(SAIDA)
    .filter((d) => fs.statSync(path.join(SAIDA, d)).isDirectory())
    .filter((d) => !filtro || d.toLowerCase().includes(filtro.toLowerCase()));

  for (const pasta of pastas) {
    const dir = path.join(SAIDA, pasta);
    const pngs = fs.readdirSync(dir).filter((f) => /^\d+\.png$/.test(f)).sort();
    if (!pngs.length) continue;

    const CW = 420, CH = 380, PAD = 10, TOPO = 30;
    const partes = [];
    for (const [i, f] of pngs.entries()) {
      const buf = fs.readFileSync(path.join(dir, f));
      const m = await sharp(buf).metadata();
      // A faixa do peito: dos ombros à cintura (28%-72% da altura da figurinha).
      const recorte = await sharp(buf)
        .extract({ left: 0, top: Math.round(m.height * 0.28), width: m.width, height: Math.round(m.height * 0.44) })
        .resize({ width: CW, height: CH, fit: 'inside' })
        .png().toBuffer();
      partes.push({ input: recorte, left: PAD + i * (CW + PAD), top: TOPO });
    }
    const W = PAD + pngs.length * (CW + PAD), H = TOPO + CH + PAD;
    const fundo = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="${W}" height="${H}" fill="#0d0d12"/>
      ${pngs.map((f, i) => `<text x="${PAD + i * (CW + PAD) + 6}" y="22" fill="#d4a017" font-family="Arial" font-size="20" font-weight="bold">variante ${path.parse(f).name}</text>`).join('')}
    </svg>`);
    const destino = path.join(dir, 'kit-peito.png');
    await sharp(await sharp(fundo).png().toBuffer()).composite(partes).png().toFile(destino);
    console.log(destino);
  }
})();
