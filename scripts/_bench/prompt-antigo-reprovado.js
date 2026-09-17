// ═══════════════════════════════════════════════════════════════════════════════
// O PROMPT ANTIGO — ARQUIVO MORTO (17-set). NÃO USAR EM PRODUÇÃO.
//
// Este era o prompt do avatar até 17-set: PROMPT_BASE (5.375 caracteres, com
// PRIORITY ORDER e o bloco STYLE de pincelada larga) + a secção KIT em cinco
// pontos + o checklist de cinco itens. Foi REPROVADO na bancada de 49
// figurinhas: 1,6/5 contra 4,1/5 do prompt novo (prompts/figurinha.js), e errou
// o emblema do peito em 4 das 7 fotos (o novo, em 0).
//
// Fica aqui por uma razão só: a bancada precisa dele para REPETIR a comparação
// (variantes 1, 2 e 5). Ninguém importa isto fora de scripts/_bench/.
// ═══════════════════════════════════════════════════════════════════════════════
const PROMPT_BASE = `You are illustrating a premium soccer player sticker card.
Image 1 = photo of a real person (the player). Image 2 = the exact kit he must wear.

PRIORITY ORDER: 1st face likeness · 2nd complete head with space above it ·
3rd the kit from Image 2 · 4th style.

FACE — HIGHEST PRIORITY:
Study Image 1 and preserve exactly: face shape and proportions, eye shape and
expression, nose, lips, skin tone, hair colour, beard/moustache style.
Image 1 may be blurry, noisy, dark or low resolution — read the underlying
facial STRUCTURE and redraw it cleanly and confidently. Do NOT reproduce noise,
grain or blur.
Never invent what is not visible in Image 1: no cap, no jewellery,
no tattoos unless clearly present.
SUNGLASSES RULE: if the person wears sunglasses or dark glasses in Image 1,
REMOVE them and paint natural, open eyes that match the face, age and
expression. NEVER keep sunglasses on the card. (Clear prescription glasses,
if obviously part of the person's look, may stay.)
The person must be instantly recognizable by a friend.

HEAD — NEVER CROP:
Always draw the ENTIRE head with a complete, rounded crown and generous empty
space above it. If the head is cut by the edge of Image 1, reconstruct it
plausibly from the visible hair. A flat, truncated or edge-touching top of the
head is the single worst possible error in this task.

ARMS — COMPLETE FIGURE:
- BOTH arms fully drawn and complete — shoulder, elbow, forearm and hand
- NEVER a missing, amputated, hidden or half-drawn limb
- The figure must NOT touch the LEFT, RIGHT or TOP edges of the image; keep
  clear margin on both sides (the bottom edge is the natural bust crop)
- If the pose does not fit, draw the figure SMALLER — never cut an arm

STYLE — SEMI-REALISTIC DIGITAL PAINTING, BROAD BRUSH:
- Premium sticker card / trading-card painting, painterly but CLEAN
- Broad confident brushwork; large simple shapes; crisp silhouette
- HAIR painted as masses with a clear outline — never strand by strand
- SKIN smooth, sculpted with light and shadow — no pores, no fine texture
- FABRIC as a few bold folds — NO visible weave or thread texture
- Rich deep colour, high contrast; must hold up when seen small on a phone
- NOT photographic, NOT anime, NOT cartoon

LIGHTING:
- Strong rim/edge light along the top of the head, the shoulders and the arms,
  clearly separating the figure from whatever is behind it
- Main light from the front-upper-left, warm; cool fill on the shadow side
- High contrast, deep blacks, no washed-out greys

BODY: slightly athletic — a little broader in the shoulders, defined arms.
Still unmistakably the same person. Not a bodybuilder.

POSE: pick ONE that matches the personality visible in Image 1 — arms
crossed, clenched fist, thumbs up, or pointing up. One pose only, never mixed.

{{KIT}}

{{KIT_CHECKLIST}}

FRAMING — PORTRAIT:
- Portrait 2:3 composition (taller than wide)
- Bust only: head down to mid-chest. No legs. No hands below chest level.
- The figure must occupy only the BOTTOM 80% of the image
- The TOP 20% of the image must be COMPLETELY EMPTY — no hair, no head, nothing
- Head horizontally centred; eyes at roughly 40% of the height
- The figure spans AT MOST 85% of the image width: keep a clearly visible empty
  margin on BOTH sides — elbows and arms must never come near the left/right edges
- If in doubt, draw the figure SMALLER and leave MORE empty space above the head

BACKGROUND:
- Perfectly flat, uniform MID-GREY #8a8a8a. Nothing else.
- This background is removed automatically afterwards; it exists ONLY so the
  figure's silhouette — including dark hair — separates cleanly from it.
- No scenery, no stadium, no crowd, no grass, no gradient, no vignette, no props.

NEVER: photographic realism, anime, chibi, cartoon mascot, any text or
lettering, watermark, extra logos, more than one person, white or blank kit,
legs, cropped head.`;

const kitPrompt = (nome, base, acento, extra = '') => `KIT — CRITICAL — REPRODUCE IMAGE 2 EXACTLY:
The kit in Image 2 is the Futty ${nome} jersey. Reproduce it precisely:

JERSEY:
- Base color: ${base}
- Large diagonal panel in ${acento}
  running from upper-left shoulder down to lower-right hem
- V-neck collar: ${base} with thin ${acento} piping along the edge
- Short sleeves: ${base} with thin ${acento} trim at cuffs
- Badge: ONE small, simple, SOLID emblem in ${acento} on the upper-left chest —
  a bold compact shape, not fine lettering. No text, no thin lines.

SHORTS:
- Base color: ${base}
- Diagonal ${acento} stripe on left side
- Thin ${acento} trim at waistband and leg openings
${extra}
CRITICAL KIT RULES:
- Do NOT change any color, shape or design element
- Do NOT substitute or invent a different kit
- Do NOT add extra logos or badges
- Image 2 is the ground truth — follow it exactly
- Always use this kit — NEVER generate a white or blank jersey`;

// Ronda 3 (30-jul): no low os detalhes pequenos do kit somem (o friso da manga
// foi o primeiro visto na prova de produção). Checklist explícito no fim do prompt.
const kitChecklist = (acento) => `KIT CHECKLIST — before finishing, verify ALL FIVE elements are present:
1. base colour of the jersey exactly as Image 2
2. the large diagonal panel in ${acento}
3. V-neck collar with thin ${acento} piping
4. thin ${acento} trim at BOTH sleeve cuffs — a plain black cuff with no ${acento} trim line is a kit ERROR
5. the solid ${acento} emblem on the upper-left chest
A missing cuff trim or missing piping is a kit ERROR. Image 2 is ground truth.`;

module.exports = { PROMPT_BASE, kitPrompt, kitChecklist };
