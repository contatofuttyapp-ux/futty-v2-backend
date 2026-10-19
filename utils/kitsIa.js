// Futty v2.0 — O catálogo de kits da figurinha (os uniformes que a IA veste). Puro: só dados.

// Kit Futty (referência) no Supabase Storage — usado na composição final (ETAPA 3).
// Assets dos kits em bucket PÚBLICO próprio ('kits') — são assets do app, não PII.
// (Em 'avatars', que é privado, partiriam o fal + as thumbnails; no 'kits' público
// a privatização não toca.)
const KIT_URL =
  'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/kits/kit1-dark-gold.png';
const KIT2_URL =
  'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/kits/kit2-dark-purple.png';

// Catálogo de kits geráveis. `ativo:false` → 400 (ainda sem asset próprio no
// Storage). Espelha os 5 ids do frontend. `acento` é a cor de destaque do kit
// (usada no cartaz e na composição do app). A frase do kit para a IA NÃO vive
// aqui: está em prompts/figurinha.js, uma por kit.
//
// (SPEC-FIGURINHA-3) Não há campo `planos` (Free/Pro/Elite): quem
// pode GERAR um kit novo é o DIREITO (utils/direitoBrilhante.js), não plano
// nenhum; quem já gerou um kit pode sempre voltar a vesti-lo (PUT /api/me/kit,
// sem gate nenhum). Nenhum kit é "grátis" ou "pago" em si — o que é pago
// é a Brilhante inteira.
const KITS_IA = {
  'dark-gold': {
    ativo: true,
    url: KIT_URL,
    acento: 'metallic gold #d4a017',
  },
  'dark-purple': {
    ativo: true, // KIT 2 oficial (gerado do dark-gold; roxo #8b5cf6).
    url: KIT2_URL,
    acento: 'vivid purple #8b5cf6',
  },
  'white-gold': {
    ativo: true, // asset escolhido pelo dono: white-gold-c1 → kit3
    url: 'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/kits/kit3-white-gold.png',
    acento: 'metallic gold #d4a017',
  },
  'elite-gold': {
    ativo: true, // asset escolhido pelo dono: elite-gold-c1 → kit4
    url: 'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/kits/kit4-elite-gold.png',
    acento: 'deep black #0d0d12', // kit invertido — o acento aqui é o preto, não o ouro
  },
  'royal-purple': {
    ativo: true, // 5º kit do lançamento: royal-purple-c3 → kit5. Par do Elite Gold.
    url: 'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/kits/kit5-royal-purple.png',
    acento: 'deep black #0d0d12', // invertido — roxo é a base, preto é o acento
  },
};

module.exports = { KIT_URL, KIT2_URL, KITS_IA };
