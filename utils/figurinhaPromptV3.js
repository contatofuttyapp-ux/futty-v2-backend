// FIGURINHA v3 — TEMPLATE FIXO no código: o Olheiro (olheiroFigurinha.js) só
// preenche lacunas (preserve/pose/vibe); tudo o resto — kit, enquadramento
// anti-corte, proibição de outline branco, fundo do pipeline, estilo — é FIXO
// e igual para todos. Se o Olheiro falhar por qualquer razão, cai no
// PROMPT_V2_1_FALLBACK (o prompt genérico já calibrado na vaga v2), para a
// geração NUNCA quebrar.
//
// NÃO usado pela rota de produção ainda — só entra em auth.js depois de
// "figurinha v3 aprovada".

const NOMES_POSE = {
  arms_crossed: 'Arms firmly crossed over the chest',
  clenched_fist: 'One clenched fist raised at chest height, competitive energy',
  signature_gesture_finger_guns: 'Finger guns gesture pointed toward the camera',
  signature_gesture_shaka: 'Shaka sign (hang loose hand gesture) held at chest height',
};

function blocoPreserve(p) {
  return `FACE AND IDENTITY — CRITICAL (tailored to this specific photo):
- Hair: ${p.hair}
- Facial hair: ${p.facial_hair}
- Accessories: ${p.accessories}
- Face shape: ${p.face_shape}
- Skin tone: ${p.skin_tone}
- Apparent age: ${p.apparent_age_range}
- Apparent gender: ${p.apparent_gender} — NEVER shift gender presentation
- Build: ${p.build}
The person must be immediately recognizable in the result. Flatter without altering:
render at their best (healthy skin, rested eyes, sharp grooming) — but do NOT change
any feature, reshape the body, or alter gender presentation. Same person, best day.`;
}

function blocoPose(pose) {
  if (pose.chosen_pose === 'preserve_original') {
    return `POSE — PRESERVE FROM PHOTO — CRITICAL:
The original photo already shows a clear gesture/pose: ${pose.gesture_description}.
Reproduce this same gesture faithfully — do not replace it with a different pose.
Reason: ${pose.reason}
Render hands and fingers carefully and anatomically correct for this gesture.`;
  }
  const chave = pose.chosen_pose === 'signature_gesture'
    ? `signature_gesture_${pose.signature_variant === 'shaka' ? 'shaka' : 'finger_guns'}`
    : pose.chosen_pose;
  const descricao = NOMES_POSE[chave] || NOMES_POSE.arms_crossed;
  return `POSE — SELECTED:
${descricao}.
Reason: ${pose.reason}
This is the ONLY pose to render — nothing else. If hands/fingers are visible in the
pose, render them anatomically correct.`;
}

function blocoVibe(vibeWords) {
  const lista = (vibeWords || []).join(', ') || 'confident smirk, charismatic';
  return `EXPRESSION — CRITICAL:
Facial expression must read as: ${lista} — always from the confident-smirk/charisma
family. NEVER angry, NEVER intense, NEVER an aggressive scowl. A composed,
self-assured half-smile.`;
}

// Template fixo — recebe os 3 blocos do Olheiro + a secção de kit já pronta
// (mesma kitPrompt() do catálogo KITS_IA em routes/auth.js).
function montarTemplateFixo({ kitPrompt, preserveBloco, poseBloco, vibeBloco }) {
  return `
You are creating a professional illustrated soccer player sticker card.
You will receive TWO images:
- Image 1: photo of a real person (the player)
- Image 2: the exact soccer kit the player must wear

PRIORITY ORDER:
1st — Face accuracy: person must be immediately recognizable
2nd — Kit accuracy: reproduce Image 2 exactly as described below
3rd — Framing: nothing cropped, ever
4th — Pose and expression as specified below

STYLE:
- Semi-realistic, high-detail cartoon illustration style
- FIFA Ultimate Team / trading-card premium sticker card quality
- Clean brushwork, rich deep color rendering, visible fabric texture
- NO white sticker die-cut outline around the character — the illustration sits
  directly on the background, no border stroke of any kind

${preserveBloco}

BODY:
- Athletic presence comes from POSTURE, not from changing the body
- Keep the person's real build — do NOT add muscle mass, do NOT broaden shoulders

${kitPrompt}

TATTOOS:
- If visible in Image 1: include naturally on skin
- If not visible in Image 1: do NOT invent any

ACCESSORIES:
- Include ONLY what is clearly visible in Image 1 (see identity block above)
- NEVER invent caps, glasses or jewelry not present in photo

${poseBloco}

${vibeBloco}

FRAMING — NOTHING CROPPED — CRITICAL:
- Portrait 3:4 ratio
- Bust-up: head to waist, NO legs visible
- The ENTIRE head, BOTH shoulders and BOTH arms — including elbows and hands when
  the pose shows them — are fully inside the frame with clear margin on all sides
- Nothing touches the image borders
- Face in the upper third, balanced headroom above the complete head
- Character occupies 55-62% of image height maximum
- If in doubt, make the character SMALLER and add more empty space — cropping the
  head or an arm is the single worst possible error

CRITICAL — HEAD COMPLETION:
If Image 1 crops any part of the head or hair, you MUST reconstruct the complete
head and hairstyle naturally and plausibly, matching the visible hair.
NEVER reproduce a cropped, flattened or truncated head.

BACKGROUND — CRITICAL:
- SOLID dark background ONLY: #050810
- Absolutely NO stadium, NO crowd, NO field, NO grass, NO lights
- NO environmental elements of any kind
- Pure flat dark color behind the player

NEVER GENERATE:
- Photorealistic photography style
- Full body showing legs
- Any pose other than the one specified above
- Cropped arms, cropped elbows or cropped head
- Added muscle mass or altered body shape
- A white sticker outline / die-cut border around the character
- Colored or busy background (stadium, grass, crowd, arena)
- Multiple people in the image
- White or blank jersey
- Any kit different from the one described above
`;
}

// FALLBACK — o prompt v2.1 genérico (aprovado na vaga v2, ~$0.25 de calibração)
// para quando o Olheiro falha por qualquer razão. {{KIT}} é injetado por quem chama.
const PROMPT_V2_1_FALLBACK = `
You are creating a professional illustrated soccer player sticker card.
You will receive TWO images:
- Image 1: photo of a real person (the player)
- Image 2: the exact soccer kit the player must wear

PRIORITY ORDER:
1st — Face accuracy: person must be immediately recognizable
2nd — Kit accuracy: reproduce Image 2 exactly as described below
3rd — Framing: nothing cropped, ever
4th — Attitude and illustration style

STYLE:
- Premium trading-card sticker illustration style
- FIFA Ultimate Team card quality
- Semi-realistic digital painting
- NOT photographic, NOT anime, NOT cartoon
- Clean brushwork with visible fabric texture
- Rich deep color rendering

FACE AND IDENTITY — CRITICAL:
Study Image 1 carefully. Preserve exactly:
- Face shape, proportions and all features
- APPARENT GENDER AND AGE exactly as in the photo — NEVER masculinize a woman,
  NEVER feminize a man, never make anyone look younger or older
- Eye shape, color and expression
- Nose and lip shape
- Skin tone (exact match)
- Hair style, color, LENGTH and texture — long hair stays long, curly stays curly
- Facial hair (exact style if present; NEVER add facial hair to someone without it)
- Glasses if worn in the photo (same frame shape)
- All distinctive facial features
The person must be immediately recognizable in the result.

FLATTER WITHOUT CHANGING — applies equally to everyone:
Render the person at their absolute best: healthy glowing skin, rested and alive
eyes, sharp grooming — as if a professional sports photographer lit them on their
best day. Do NOT change any feature, do NOT slim or reshape the body, do NOT
alter gender presentation. Same person, photographed at their peak.

BODY:
- Athletic presence comes from POSTURE, not from changing the body
- Keep the person's real build — do NOT add muscle mass, do NOT broaden shoulders

{{KIT}}

TATTOOS:
- If visible in Image 1: include naturally on skin
- If not visible in Image 1: do NOT invent any

ACCESSORIES:
- Include ONLY what is clearly visible in Image 1
- NEVER invent caps, glasses or jewelry not present in photo

ATTITUDE — GAME FACE — CRITICAL:
This is an INTIMIDATING athlete portrait, like a championship poster:
- Firm grounded posture, chest open, shoulders squared to the camera
- Chin slightly lowered
- Serious, confident stare straight into the camera lens
- Intense and composed — a competitor about to walk onto the pitch
- NO smiling celebration, NO joyful gestures, NO raised arms — ever

POSE — SELECT ONE (all closed and frontal, arms always close to the body):
- Bust portrait, arms relaxed by the sides
- Arms firmly crossed over the chest
- Hands on hips
Select ONE only. NO pose extends the arms upward or outward from the body.

FRAMING — NOTHING CROPPED — CRITICAL:
- Portrait 3:4 ratio
- Bust-up: head to waist, NO legs visible
- The ENTIRE head, BOTH shoulders and BOTH arms — including elbows and hands when
  the pose shows them — are fully inside the frame with clear margin on all sides
- Nothing touches the image borders
- Face in the upper third, balanced headroom above the complete head
- Character occupies 55-62% of image height maximum
- If in doubt, make the character SMALLER and add more empty space — cropping the
  head or an arm is the single worst possible error

CRITICAL — HEAD COMPLETION:
If Image 1 crops any part of the head or hair, you MUST reconstruct the complete
head and hairstyle naturally and plausibly, matching the visible hair.
NEVER reproduce a cropped, flattened or truncated head.

BACKGROUND — CRITICAL:
- SOLID dark background ONLY: #050810
- Absolutely NO stadium, NO crowd, NO field, NO grass, NO lights
- NO environmental elements of any kind
- Pure flat dark color behind the player

NEVER GENERATE:
- Photorealistic photography style
- Anime or cartoon style
- Full body showing legs
- Raised arms, pointing fingers, thumbs up, finger guns or any celebration gesture
- Cropped arms, cropped elbows or cropped head
- Added muscle mass or altered body shape
- Colored or busy background (stadium, grass, crowd, arena)
- Multiple people in the image
- White or blank jersey
- Any kit different from the one described above
`;

/**
 * Monta o prompt final para uma foto: se `analiseOlheiro` existir, usa o
 * TEMPLATE FIXO v3 (personalizado); se for null (Olheiro falhou/sem chave),
 * cai no PROMPT_V2_1_FALLBACK genérico. NUNCA lança — sempre devolve um prompt.
 * @param {string} kitPromptTexto — a secção KIT já resolvida (kitPrompt() do catálogo)
 * @param {object|null} analiseOlheiro — o retorno de olhar(), ou null
 */
function montarPromptV3(kitPromptTexto, analiseOlheiro) {
  if (!analiseOlheiro) {
    return { prompt: PROMPT_V2_1_FALLBACK.replace('{{KIT}}', kitPromptTexto), fonte: 'fallback-v2.1' };
  }
  const prompt = montarTemplateFixo({
    kitPrompt: kitPromptTexto,
    preserveBloco: blocoPreserve(analiseOlheiro.preserve),
    poseBloco: blocoPose(analiseOlheiro.pose),
    vibeBloco: blocoVibe(analiseOlheiro.vibe_words),
  });
  return { prompt, fonte: 'olheiro' };
}

module.exports = { montarPromptV3, PROMPT_V2_1_FALLBACK, blocoPreserve, blocoPose, blocoVibe };
