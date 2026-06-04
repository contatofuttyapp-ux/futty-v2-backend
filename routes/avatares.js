// Futty v2.0 — Lista de avatares genéricos (para o ruído da slot machine).
const express = require('express');
const fs = require('fs');
const path = require('path');
const { asyncHandler } = require('../utils/http');

const router = express.Router();

// Fallback caso a pasta não exista (19 ficheiros conhecidos, inclui os novos).
const HARDCODED = [
  'Astronauta.png', 'ET.png', 'Gladiador.png', 'Jacaré.png',
  'Leão.png', 'Lesma.png', 'Ninja.png', 'Onça.png',
  'Peixe boi.png', 'Petisco.png', 'Preguiça.png',
  'Robot Junk.png', 'Robot New.png', 'Tatu.png',
  'Tigre.png', 'Tucano.png',
  'bola.png', 'carta_fut.png', 'chuteira.png',
];

// Lê os ficheiros de imagem de uma pasta (ou null se não existir).
function lerPasta(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return null;
  }
}

/**
 * GET /api/avatares/genericos/disponiveis — nomes dos avatares genéricos.
 * Tenta backend/public/avatares/genericos, depois frontend/public/..., senão
 * devolve a lista hardcoded.
 */
router.get(
  '/api/avatares/genericos/disponiveis',
  asyncHandler(async (req, res) => {
    const candidatos = [
      path.join(__dirname, '..', 'public', 'avatares', 'genericos'),
      path.join(__dirname, '..', '..', 'frontend', 'public', 'avatares', 'genericos'),
    ];
    for (const dir of candidatos) {
      const items = lerPasta(dir);
      if (items && items.length) return res.json({ items });
    }
    res.json({ items: HARDCODED });
  })
);

module.exports = router;
