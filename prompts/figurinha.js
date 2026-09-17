// ═══════════════════════════════════════════════════════════════════════════════
// O PROMPT DA FIGURINHA — fonte única (17-set, variante 6 da bancada).
//
// Este ficheiro é o prompt. `routes/auth.js` e a bancada
// (`scripts/_bench/testar-prompt.js`) importam daqui — nunca copiam.
//
// DE ONDE VEIO: bancada de 49 figurinhas (7 fotos × 7 variantes,
// `scripts/_bench/testar-prompt.js`), avaliada às cegas pelo dono a 17-set:
//   P1, o prompt antigo (5.375 caracteres, PRIORITY ORDER + STYLE de pincelada
//        larga + checklist de kit em cinco pontos) ................. 1,6/5
//   P2, este ("FACE FIRST", kit em uma frase) ..................... 4,0/5
//   P3, P2 com o bloco STYLE antigo de volta ...................... 3,3/5
//   P2 + input_fidelity high + entrada quadrada (a escolhida) ..... 4,1/5
// O prompt é a alavanca principal: mesmo modelo, mesma qualidade, mesma conta —
// 1,6 → 4,1 só trocando o texto. O bloco STYLE antigo ("broad brush", "hair as
// masses", "skin smooth") está REPROVADO: era ele que apagava o rosto (P3 caiu
// 0,7 ponto face a P2 sem mudar mais nada).
//
// O que NÃO mudar sem outra bancada:
//   • a ordem dos blocos (FACE FIRST vem primeiro de propósito);
//   • o kit numa frase só — a versão em cinco pontos com checklist do prompt
//     antigo errou o emblema em 4 das 7 fotos, esta versão em 0;
//   • "flat mid-grey #8a8a8a" no fundo, que é o que o birefnet recorta.
// ═══════════════════════════════════════════════════════════════════════════════

// A regra dos óculos vive numa LINHA PRÓPRIA, no início do FACE FIRST. Na
// bancada ela estava entre parênteses no fim do parágrafo e três figurinhas do
// Gui saíram com os óculos escuros na cara — a versão entre parênteses perde-se
// no meio do texto.
const REGRA_OCULOS = 'SUNGLASSES: if Image 1 shows sunglasses, remove them and paint natural open eyes that fit this face — never keep dark lenses.';

/**
 * O kit em UMA frase, por kit. Mesma estrutura para todos (foi a que a bancada
 * validou no dark-gold): base, painel diagonal, vivo do decote em V, friso nos
 * DOIS punhos, emblema pequeno no peito esquerdo. Só as cores mudam.
 * Os dois kits invertidos levam a nota no fim — sem ela o modelo tende a voltar
 * ao preto, que é o que vê nos outros quatro.
 */
const frase = (base, acento, invertido = '') =>
  `${base} jersey with a large ${acento} diagonal panel from the upper-left shoulder to the lower-right hem, `
  + `${acento} V-neck piping, thin ${acento} trim at both cuffs, one small solid ${acento} emblem on the upper-left chest${invertido}`;

const KITS_CURTOS = {
  'dark-gold': frase('black', 'gold'),
  'dark-purple': frase('black', 'vivid purple'),
  'white-gold': frase('off-white', 'metallic gold'),
  'elite-gold': frase('metallic gold', 'deep black', ' — note: this kit is INVERTED, gold is the base colour and black is the accent'),
  'royal-purple': frase('vivid purple', 'deep black', ' — note: this kit is INVERTED, purple is the base colour and black is the accent'),
};

// A conferência final, também numa frase. Os cinco itens são os mesmos da frase
// acima, pela mesma ordem.
const KIT_CHECK = 'Check before finishing: base colour, diagonal panel, V-neck piping, BOTH cuff trims, chest emblem — all as in Image 2.';

const MOLDE = `Sticker-card illustration of the REAL person in Image 1, wearing the kit in Image 2.

FACE FIRST — this is a portrait of one specific person and a friend must recognize him instantly. ${REGRA_OCULOS} Keep EXACTLY as in Image 1: head angle and expression, face shape, hairline and hairstyle, eyebrows, eye shape and spacing, nose, mouth, ears, skin tone, facial hair, clear prescription glasses (those stay). Do not idealize, slim, age or "improve" the face. If Image 1 is blurry, resolve it into the same face, sharper — never a different face.

RENDERING: polished digital illustration for a premium football sticker — realistic facial rendering with a clean, painterly finish: smooth gradients, crisp edges, strong warm key light from upper-left, cool rim light on head and shoulders, deep contrast. Not a photo filter, not anime, not cartoon.

POSE: frontal bust, shoulders square to the camera, arms relaxed at the sides or lightly crossed — keep the head as in Image 1. Body neutral and athletic; the person stays unmistakably himself.

KIT — reproduce Image 2 exactly: {{KIT_CURTO}}. No other logos, no text. {{KIT_CHECK}}

FRAMING: portrait 2:3; bust from full head to mid-chest; the top 20% of the canvas stays empty above a complete, rounded crown; keep clear margins left and right; both arms complete, never touching the edges. Background: flat mid-grey #8a8a8a, nothing else (removed later).`;

/**
 * O prompt pronto para um kit do catálogo (`KITS_IA` em routes/auth.js).
 * Lança se o kit não tiver frase própria — melhor falhar aqui, de graça, do que
 * mandar à fal um prompt com "undefined" no meio e pagar por ele.
 */
function montarPrompt(kitId) {
  const curto = KITS_CURTOS[kitId];
  if (!curto) throw new Error(`Sem frase de kit para "${kitId}" em prompts/figurinha.js`);
  return MOLDE.replace('{{KIT_CURTO}}', curto).replace('{{KIT_CHECK}}', KIT_CHECK);
}

module.exports = { montarPrompt, KITS_CURTOS, KIT_CHECK, REGRA_OCULOS };
