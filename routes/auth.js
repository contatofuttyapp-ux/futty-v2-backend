// Futty v2.0 — Rotas de autenticação / utilizador.
// (O login/registo é feito no frontend via Supabase Auth; aqui expomos o perfil.)
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const fal = require('@fal-ai/serverless-client');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, ensureUserRow, getUserById } = require('../utils/db');
const { golosDoJogador } = require('../utils/agregados');
const { notaParaExibir } = require('../utils/helpers');
const { filtroNSFW } = require('../utils/nsfwFilter');
const { sha256Hex, verificarTeto, verificarFreeze, registrarGeracao } = require('../utils/antiAbusoIA');

// fal.ai — credenciais via FAL_KEY (.env).
fal.config({ credentials: process.env.FAL_KEY });

const router = express.Router();

// Upload do avatar: ficheiro em memória, só imagens, máximo 5MB.
const MAX_AVATAR = 5 * 1024 * 1024;
const AVATAR_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const uploadAvatarMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR },
  fileFilter: (req, file, cb) => {
    if (AVATAR_MIME[file.mimetype]) cb(null, true);
    else cb(new HttpError(400, 'Só são aceites imagens JPEG, PNG ou WebP.'));
  },
}).single('avatar');

// Wrapper que corre o multer e converte os erros dele em HttpError(400).
function receberAvatar(req, res, next) {
  uploadAvatarMw(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'A imagem excede o limite de 5MB.' : 'Falha no upload da imagem.';
      return next(new HttpError(400, msg));
    }
    return next(err); // HttpError do fileFilter ou outro
  });
}

// Cores de uniforme válidas (igual ao CHECK da migração 013).
const CORES_UNIFORME = ['verde', 'azul', 'vermelho', 'preto', 'amarelo', 'cinzento'];
// Preferências da figurinha (igual aos CHECKs da migração 018).
const CORES_FRAME = ['dourado', 'verde', 'roxo', 'branco'];
const FUNDOS_FIGURINHA = ['estadio', 'gradiente', 'aura', 'preto', 'golden', 'royal'];
// Fundos PREMIUM (gated no plano) — planos permitidos por fundo, no molde dos kits
// (White/Elite Gold). GOLDEN, AURA e ÉPICO ('gradiente', chave interna) — todos
// pro/elite. Super-admin passa sempre.
//
// LEI DA REGRA JUSTA (sem punição retroativa): o gate só corre AQUI, no PATCH que
// TROCA fundo_figurinha — nunca em leitura (GET /api/me) nem no render. Quem já
// tinha Aura/Épico equipado antes deste gate MANTÉM (a coluna já gravada nunca é
// revalidada até o próprio utilizador mexer nela). Só ao tentar EQUIPAR de novo
// (depois de trocar pra outro fundo) é que o plano passa a ser exigido — ninguém
// perde o que já tinha, mas ninguém re-adquire de graça. Ver Figurinha.jsx
// `escolherFundo` (o `if (k === fundo) return` early-return é o que preserva isto:
// reabrir a mesma página nunca reenvia o PATCH do fundo já equipado).
const FUNDOS_PREMIUM = { golden: ['pro', 'elite'], aura: ['pro', 'elite'], gradiente: ['pro', 'elite'], royal: ['pro', 'elite'] };
// Limites de gerações de avatar IA por plano.
const LIMITES_IA = { free: 3, pro: 50, elite: 100 };
// Colunas de perfil devolvidas ao frontend.
const PERFIL_COLS =
  'id, nome, email, avatar_url, foto_url, nome_jogador, cor_preferida, telefone, avatar_ia_creditos, cor_frame, fundo_figurinha, plan, avatar_ia_mes, avatar_ia_reset, is_super_admin, birthdate, kit_ativo';

// Maioridade (18+) calculada em runtime: adulto se nasceu até à data de hoje
// menos 18 anos. (Não dá para usar coluna gerada STORED — ver migração 034.)
function calcIsAdult(birthdate) {
  if (!birthdate) return false;
  const hoje = new Date();
  const limite = new Date(Date.UTC(hoje.getUTCFullYear() - 18, hoje.getUTCMonth(), hoje.getUTCDate()));
  return new Date(birthdate) <= limite;
}

/**
 * GET /api/me — devolve o utilizador autenticado + stats agregadas.
 * Garante também a linha em public.users (caso o trigger não tenha corrido).
 */
router.get(
  '/api/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    await ensureUserRow(req.user);
    const perfil = await getUserById(userId, PERFIL_COLS);

    // Consentimento de rosto público (Opção B). Leitura DEFENSIVA e separada: se a
    // coluna ainda não existir (DDL 040 por correr), não parte o /api/me — default TRUE.
    let mostrarRostoPublico = true;
    try {
      const cons = await getUserById(userId, 'mostrar_rosto_publico');
      if (cons && typeof cons.mostrar_rosto_publico === 'boolean') mostrarRostoPublico = cons.mostrar_rosto_publico;
    } catch { mostrarRostoPublico = true; }

    // Stats agregadas (todas as equipas):
    // jogos = presenças confirmadas; gols = soma; nota = média dos votos recebidos.
    const { count: jogos } = await supabase
      .from('game_players')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('confirmado', true);

    // RANKING VIVO: os golos vêm da FONTE (gols_jogadores), não da coluna legado de
    // team_members — bate com o número do ranking para o mesmo jogador (uma só verdade).
    const gols = await golosDoJogador(userId);

    // Nota exibida (1-10 com boost) — mín. 3 votos, como no ranking.
    const { data: voteRows } = await supabase.from('votes').select('nota').eq('para_user_id', userId);
    const totalVotos = voteRows ? voteRows.length : 0;
    const mediaInterna = totalVotos ? voteRows.reduce((sum, v) => sum + Number(v.nota), 0) / totalVotos : null;
    const nota = totalVotos >= 3 ? notaParaExibir(mediaInterna) : null;

    // Slots de kit já gerados por este utilizador (array de kit_id).
    const { data: slotRows } = await supabase.from('user_avatar_slots').select('kit_id').eq('user_id', userId);
    const slots = (slotRows || []).map((r) => r.kit_id);

    res.json({
      user: {
        id: userId,
        email: req.user.email,
        nome: perfil?.nome || null,
        avatar_url: perfil?.avatar_url || null,
        foto_url: perfil?.foto_url || null,
        nome_jogador: perfil?.nome_jogador || null,
        cor_preferida: perfil?.cor_preferida || null,
        telefone: perfil?.telefone || null,
        avatar_ia_creditos: perfil?.avatar_ia_creditos ?? 3,
        cor_frame: perfil?.cor_frame || 'dourado',
        fundo_figurinha: perfil?.fundo_figurinha || 'estadio',
        plan: perfil?.plan || 'free',
        avatar_ia_mes: perfil?.avatar_ia_mes ?? 0,
        avatar_ia_reset: perfil?.avatar_ia_reset || null,
        is_super_admin: perfil?.is_super_admin || false,
        birthdate: perfil?.birthdate || null,
        is_adult: calcIsAdult(perfil?.birthdate),
        mostrar_rosto_publico: mostrarRostoPublico,
        kit_ativo: perfil?.kit_ativo || 'dark-gold',
        // P1-1 — flag do onboarding dia-1 no user_metadata do Auth (sem DDL).
        // FALSE → qualquer entrada autenticada reencaminha 1x para /onboarding
        // (resistente ao caminho de entrada: confirmação de email noutro
        // dispositivo, login fresco, deep-link). Contas antigas foram semeadas
        // TRUE pelo script backfill-onboarding.js.
        onboarding_completo: req.user.user_metadata?.onboarding_completo === true,
        // Tour de boas-vindas (E8): o "já vi" vive no user (Auth metadata, sem DDL) —
        // assim não reaparece noutro dispositivo nem quando o localStorage é limpo.
        tour_inicio_visto: req.user.user_metadata?.tour_inicio_visto === true,
      },
      slots,
      stats: { nota, jogos: jogos || 0, gols },
    });
  })
);

/**
 * PATCH /api/me — atualiza o perfil do utilizador (só os campos enviados).
 * Body (todos opcionais): nome, nome_jogador, cor_preferida, avatar_url, telefone.
 */
router.patch(
  '/api/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const patch = {};

    if ('nome' in b) {
      const v = b.nome == null ? null : String(b.nome).trim();
      if (v && v.length > 60) throw new HttpError(400, 'Nome: máximo 60 caracteres.');
      patch.nome = v || null;
    }
    if ('nome_jogador' in b) {
      const v = b.nome_jogador == null ? null : String(b.nome_jogador).trim();
      if (v && v.length > 18) throw new HttpError(400, 'Nome de jogador: máximo 18 caracteres.');
      patch.nome_jogador = v || null;
    }
    if ('cor_preferida' in b) {
      const v = b.cor_preferida == null || b.cor_preferida === '' ? null : String(b.cor_preferida);
      if (v && !CORES_UNIFORME.includes(v)) throw new HttpError(400, 'Cor de uniforme inválida.');
      patch.cor_preferida = v;
    }
    if ('avatar_url' in b) {
      const v = b.avatar_url == null ? null : String(b.avatar_url).trim();
      if (v && v.length > 500) throw new HttpError(400, 'avatar_url: máximo 500 caracteres.');
      patch.avatar_url = v || null;
    }
    // telefone removido: já não é guardado pelo perfil.
    if ('cor_frame' in b) {
      const v = String(b.cor_frame);
      if (!CORES_FRAME.includes(v)) throw new HttpError(400, 'Cor de frame inválida.');
      patch.cor_frame = v;
    }
    if ('fundo_figurinha' in b) {
      const v = String(b.fundo_figurinha);
      if (!FUNDOS_FIGURINHA.includes(v)) throw new HttpError(400, 'Fundo de figurinha inválido.');
      // GATE PREMIUM (servidor é a fonte da verdade — sem truque de frontend): um fundo
      // premium só entra se o plano o permitir (ou super-admin).
      if (FUNDOS_PREMIUM[v]) {
        const perfil = await getUserById(req.user.id, 'plan, is_super_admin');
        const plano = perfil?.plan || 'free';
        if (!perfil?.is_super_admin && !FUNDOS_PREMIUM[v].includes(plano)) {
          throw new HttpError(403, 'Este fundo exige um plano superior.');
        }
      }
      patch.fundo_figurinha = v;
    }
    // Consentimento de rosto público (Opção B): toggle no Perfil → Privacidade.
    if ('mostrar_rosto_publico' in b) {
      patch.mostrar_rosto_publico = b.mostrar_rosto_publico === true;
    }
    // Data de nascimento (pedido único do Início a quem não a tem). SET-ONCE: se já
    // existir, não deixa mudar (evita a passagem trivial menor→adulto).
    if ('birthdate' in b) {
      const v = b.birthdate == null || b.birthdate === '' ? null : String(b.birthdate).slice(0, 10);
      if (v) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, 'Data de nascimento inválida.');
        const d = new Date(`${v}T00:00:00Z`);
        if (Number.isNaN(d.getTime()) || d > new Date() || d.getUTCFullYear() < 1900) {
          throw new HttpError(400, 'Data de nascimento inválida.');
        }
        const atual = await getUserById(req.user.id, 'birthdate');
        if (atual && atual.birthdate) throw new HttpError(400, 'A data de nascimento já está definida.');
        patch.birthdate = v;
      }
    }

    if (!Object.keys(patch).length) throw new HttpError(400, 'Nada para atualizar.');

    await ensureUserRow(req.user);
    const { data: updated, error } = await supabase
      .from('users')
      .update(patch)
      .eq('id', req.user.id)
      .select(PERFIL_COLS)
      .single();
    if (error) throw new HttpError(500, error.message);

    res.json({ user: updated });
  })
);

/**
 * POST /api/me/onboarding-completo — marca o onboarding dia-1 como concluído
 * (P1-1). Grava no user_metadata do Auth via admin API — o próximo /api/me já
 * devolve onboarding_completo:true e a gate do frontend deixa de reencaminhar.
 */
router.post(
  '/api/me/onboarding-completo',
  requireAuth,
  asyncHandler(async (req, res) => {
    const meta = { ...(req.user.user_metadata || {}), onboarding_completo: true };
    const { error } = await supabase.auth.admin.updateUserById(req.user.id, { user_metadata: meta });
    if (error) throw new HttpError(500, error.message);
    res.json({ onboarding_completo: true });
  })
);

/**
 * POST /api/me/tour-visto — marca o tour de boas-vindas como VISTO no user (E8).
 * Guarda no user_metadata do Auth (sem DDL); o próximo /api/me devolve
 * tour_inicio_visto:true e o tour não volta a aparecer (em qualquer dispositivo).
 */
router.post(
  '/api/me/tour-visto',
  requireAuth,
  asyncHandler(async (req, res) => {
    const meta = { ...(req.user.user_metadata || {}), tour_inicio_visto: true };
    const { error } = await supabase.auth.admin.updateUserById(req.user.id, { user_metadata: meta });
    if (error) throw new HttpError(500, error.message);
    res.json({ tour_inicio_visto: true });
  })
);

/**
 * POST /api/me/avatar — upload da foto de perfil (multipart, campo "avatar").
 * Vai para o Supabase Storage (bucket "avatars", path public/{userId}.{ext},
 * sobrescreve) e guarda o URL público em users.avatar_url.
 */
router.post(
  '/api/me/avatar',
  requireAuth,
  receberAvatar,
  filtroNSFW, // Tijolo 1: bloqueia imagem explícita antes de guardar (avatar + onboarding)
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, 'Nenhuma imagem enviada (campo "avatar").');
    const ext = AVATAR_MIME[file.mimetype];
    if (!ext) throw new HttpError(400, 'Formato de imagem não suportado.');

    const userId = req.user.id;
    // 1. Ficheiro recebido (multer).
    console.log('[avatar] ficheiro recebido:', { userId, mimetype: file.mimetype, ext, size: file.size });

    await ensureUserRow(req.user);

    const caminho = `public/${userId}.${ext}`;
    // 2. Upload para o Supabase Storage (bucket "avatars").
    console.log('[avatar] upload p/ Storage:', { bucket: 'avatars', caminho });
    const { error: upErr } = await supabase.storage.from('avatars').upload(caminho, file.buffer, {
      contentType: file.mimetype,
      upsert: true,
      cacheControl: '3600',
    });
    if (upErr) {
      console.error('[avatar] erro no upload:', upErr.message);
      throw new HttpError(500, upErr.message);
    }

    const { data: pub } = supabase.storage.from('avatars').getPublicUrl(caminho);
    // ?v= força o browser a recarregar (o path é fixo porque sobrescreve).
    const avatarUrl = `${pub.publicUrl}?v=${Date.now()}`;
    // URL público — deve usar o domínio do Supabase, não localhost.
    console.log('[avatar] URL público:', avatarUrl);

    // 3. UPDATE na tabela users. foto_url = a nova foto (fonte da geração IA).
    //    avatar_url (o que o card mostra) SÓ é sobrescrito se ainda NÃO houver avatar
    //    IA; se já houver (avatar_url ≠ foto_url actual), preserva-se → o card continua
    //    a mostrar o avatar antigo até o utilizador gerar de novo (nunca a foto crua).
    const atual = await getUserById(userId, 'foto_url, avatar_url');
    const temAvatarIA = !!atual?.avatar_url && atual.avatar_url !== atual.foto_url;
    const novoAvatarUrl = temAvatarIA ? atual.avatar_url : avatarUrl;
    console.log('[avatar] UPDATE users:', { userId, temAvatarIA });
    const { error: updErr } = await supabase.from('users').update({ foto_url: avatarUrl, avatar_url: novoAvatarUrl }).eq('id', userId);
    if (updErr) {
      console.error('[avatar] erro no UPDATE:', updErr.message);
      throw new HttpError(500, updErr.message);
    }

    // Hash da foto (pacote anti-abuso, 11-ago) — matéria-prima do sinal de farm
    // de contas. Best-effort e SEPARADO do update principal: se a coluna ainda
    // não existir (migração 048 por correr), nunca pode derrubar o upload.
    try {
      await supabase.from('users').update({ foto_hash: sha256Hex(file.buffer) }).eq('id', userId);
    } catch (e) {
      console.error('[avatar] foto_hash não gravado (migração 048 por correr?):', e.message);
    }

    console.log('[avatar] concluído:', { userId, preservouAvatarIA: temAvatarIA });
    res.json({ foto_url: avatarUrl, avatar_url: novoAvatarUrl });
  })
);

// Prompt do cromo — receita L2P (bancada 30-jul, achatamento 0,00-0,07 em 6/6 fotos,
// $0,015/fig). Retrato 1024×1536 em vez de quadrado: dá altura para cabeça + busto sem
// cortar a coroa (o quadrado forçava achatamento 0,66-0,96 mesmo com ordem de folga no
// prompt). A secção KIT é injectada por kit ({{KIT}}) — resto é comum a todos os kits.
// Fonte: scripts/_bench/prompts-low.js (variante L2P = função L2 + ENQ_RETRATO + fundo cinza).
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
- Premium Panini / trading-card painting, painterly but CLEAN
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

// Kit Futty (referência) no Supabase Storage — usado na composição final (ETAPA 3).
// Assets dos kits em bucket PÚBLICO próprio ('kits') — são assets do app, não PII.
// (Antes viviam em avatars/Kits/; o tijolo 1C privatizou avatars e partia o fal +
// as thumbnails. Movidos para 'kits' público, que a privatização não toca.)
const KIT_URL =
  'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/kits/kit1-dark-gold.png';
const KIT2_URL =
  'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/kits/kit2-dark-purple.png';

// Secção KIT do prompt, por kit. O texto do dark-gold é o original (não mexer);
// os restantes derivam dele só trocando as cores.
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

// Catálogo de kits gerávies. `ativo:false` → 400 (ainda sem asset próprio no Storage).
// `planos` restringe por plano (super-admin é isento). Espelha os 4 ids do frontend.
const KITS_IA = {
  'dark-gold': {
    ativo: true,
    url: KIT_URL,
    planos: ['free', 'pro', 'elite'],
    kitPrompt: kitPrompt('Dark Gold', 'deep black #0d0d12', 'metallic gold #d4a017'),
  },
  'dark-purple': {
    ativo: true, // KIT 2 oficial (gerado do dark-gold; roxo #8b5cf6). Livre por agora.
    url: KIT2_URL,
    planos: ['free', 'pro', 'elite'],
    kitPrompt: kitPrompt('Dark Purple', 'deep black #0d0d12', 'vivid purple #8b5cf6'),
  },
  'white-gold': {
    ativo: false,
    url: null, // Kits/kit3-white-gold.png
    planos: ['free', 'pro', 'elite'],
    kitPrompt: kitPrompt('White Gold', 'off-white #f8f5f0', 'metallic gold #d4a017'),
  },
  'elite-gold': {
    ativo: false,
    url: null, // Kits/kit4-elite-gold.png
    planos: ['pro', 'elite'], // kit pago
    kitPrompt: kitPrompt('Elite Gold', 'metallic gold #d4a017', 'deep black #0d0d12', '\nNOTE: this kit is INVERTED — gold is the base, black is the accent.\n'),
  },
};

// Injecta a secção KIT do catálogo no prompt base.
function promptFutty(kitId) {
  return PROMPT_BASE.replace('{{KIT}}', KITS_IA[kitId].kitPrompt);
}

// O bucket "avatars" é PRIVADO (Tijolo 1C) — um users.foto_url guardado como URL
// "público" do Storage já não é descarregável por ninguém de fora (nem a própria fal.ai,
// que busca a imagem do lado dela). Estas duas funções extraem o CAMINHO desse URL
// legado e emitem um URL ASSINADO de vida curta, o único que a fal consegue mesmo buscar.
function caminhoNoBucket(urlPublico, bucket) {
  if (!urlPublico) return null;
  const marcador = `/object/public/${bucket}/`;
  const i = urlPublico.indexOf(marcador);
  if (i === -1) return null;
  return urlPublico.slice(i + marcador.length).split('?')[0];
}
async function assinarUrlAvatars(caminho, ttlSeg = 600) {
  const { data, error } = await supabase.storage.from('avatars').createSignedUrl(caminho, ttlSeg);
  if (error) throw new Error(`Falha ao assinar URL do avatar: ${error.message}`);
  return data.signedUrl;
}

/**
 * POST /api/me/avatar/ai — gera um avatar estilo cromo a partir da foto atual,
 * via fal.ai (gpt-image-1.5/edit), e guarda em avatars/public/{userId}-ai.png
 * (separado da foto real).
 */
router.post(
  '/api/me/avatar/ai',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!process.env.FAL_KEY) throw new HttpError(500, 'Geração de IA indisponível (FAL_KEY não configurada).');

    const userId = req.user.id;
    const perfil = await getUserById(userId, 'foto_url, plan, avatar_ia_mes, avatar_ia_reset, is_super_admin, created_at');
    if (!perfil?.foto_url) throw new HttpError(400, 'Adicione uma foto primeiro.');

    // --- KIT: validação (existe / activo / plano) ---
    const kitId = String(req.body?.kit || 'dark-gold');
    const kit = KITS_IA[kitId];
    if (!kit) throw new HttpError(400, 'Kit inexistente.');
    if (!kit.ativo) throw new HttpError(400, 'Kit ainda não disponível.');
    const plano = perfil.plan || 'free';
    if (!perfil.is_super_admin && !kit.planos.includes(plano)) {
      throw new HttpError(403, 'Este kit exige um plano superior.');
    }

    // --- IDEMPOTÊNCIA: se já existe slot deste kit, veste-o e NÃO gera nem gasta quota ---
    const { data: slot } = await supabase
      .from('user_avatar_slots')
      .select('avatar_url')
      .eq('user_id', userId)
      .eq('kit_id', kitId)
      .maybeSingle();
    if (slot?.avatar_url) {
      await ensureUserRow(req.user);
      const { error: vestirErr } = await supabase
        .from('users')
        .update({ avatar_url: slot.avatar_url, kit_ativo: kitId })
        .eq('id', userId);
      if (vestirErr) throw new HttpError(500, vestirErr.message);
      console.log('[avatar-ai] slot reutilizado (sem geração, sem quota):', { userId, kitId });
      return res.json({ avatar_url: slot.avatar_url, kit: kitId, do_slot: true });
    }

    // Quota por plano (com reset mensal). free: 3, pro: 50, elite: 100.
    const limite = LIMITES_IA[plano] ?? LIMITES_IA.free;
    const hoje = new Date();
    const hojeISO = hoje.toISOString().slice(0, 10);
    const inicioMesISO = `${hoje.getUTCFullYear()}-${String(hoje.getUTCMonth() + 1).padStart(2, '0')}-01`;
    // Se o último reset foi antes do início do mês atual → zera a contagem.
    let usados = perfil.avatar_ia_mes || 0;
    let resetData = perfil.avatar_ia_reset ? String(perfil.avatar_ia_reset) : null;
    if (!resetData || resetData < inicioMesISO) {
      usados = 0;
      resetData = hojeISO;
    }
    // Super-admin não tem limite de gerações.
    if (!perfil.is_super_admin) {
      if (usados >= limite) {
        const msg =
          plano === 'free'
            ? 'Limite de gerações atingido. Faça upgrade para Pro para continuar.'
            : 'Limite de gerações deste mês atingido.';
        throw new HttpError(403, msg);
      }
    }

    // PACOTE ANTI-ABUSO DE CUSTO (11-ago) — três gates, só a partir daqui (uma
    // geração real vai custar dinheiro; o slot-reuse acima nunca passa por aqui).
    //
    // 1. E-MAIL-GATE: contas Google confirmam e-mail no próprio login (passam
    //    direto); contas email+senha precisam ter clicado no link de confirmação.
    //    Só trava a GERAÇÃO — nunca cadastro, login ou navegação.
    const provedor = req.user.app_metadata?.provider;
    if (provedor !== 'google' && !req.user.email_confirmed_at) {
      throw new HttpError(403, 'Confirme seu e-mail para gerar (enviamos o link).', 'EMAIL_NAO_CONFIRMADO');
    }
    // 2. TETO DIÁRIO — paraquedas com alerta, nunca teto de vidro: super-admin
    //    (uso interno/testes) sempre passa; o resto pausa ao bater 100% do dia.
    if (!perfil.is_super_admin) {
      const teto = await verificarTeto();
      if (teto.bloqueado) {
        throw new HttpError(503, 'Estamos com procura recorde. Tenta de novo mais tarde.', 'TETO_DIARIO_ATINGIDO');
      }
    }
    // 3. AUTO-FREEZE — regra de ferro, só contas <48h (usuários reais não sentem).
    const freeze = await verificarFreeze(perfil.created_at);
    if (freeze.congelado) {
      throw new HttpError(503, 'Estamos com procura recorde. Tenta de novo mais tarde.', 'TETO_DIARIO_ATINGIDO');
    }

    // ETAPA 0 — pré-processar a foto de entrada: estende o topo ~18% com a cor de
    // continuação da faixa superior. A IA ancora ao enquadramento do input; dar-lhe
    // espaço acima da cabeça faz com que deixe de cortar a coroa na saída (CASO B).
    // Usa upload Supabase (URL assinado) em vez de data URI, para não arriscar uma
    // geração paga num formato de input não confirmado no schema do fal.
    const caminhoFoto = caminhoNoBucket(perfil.foto_url, 'avatars');
    let inputUrl = caminhoFoto ? await assinarUrlAvatars(caminhoFoto) : perfil.foto_url;
    try {
      if (!caminhoFoto) throw new Error('foto_url não é um caminho do bucket avatars.');
      // download() autenticado (SDK) em vez de fetch(url pública) — o bucket é
      // PRIVADO (Tijolo 1C), um fetch simples do URL "público" devolve 400.
      const { data: fotoBlob, error: dlErr } = await supabase.storage.from('avatars').download(caminhoFoto);
      if (dlErr) throw new Error(dlErr.message);
      const fotoBuf = Buffer.from(await fotoBlob.arrayBuffer());
      const meta = await sharp(fotoBuf).metadata();
      const stripH = Math.max(8, Math.round((meta.height || 0) * 0.02));
      // cor média da faixa superior (continuação natural, não uma banda artificial)
      const { data: avg } = await sharp(fotoBuf)
        .extract({ left: 0, top: 0, width: meta.width, height: stripH })
        .resize(1, 1)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const [r, g, b] = avg;
      const padTop = Math.round((meta.height || 0) * 0.18);
      const paddedBuf = await sharp(fotoBuf)
        .extend({ top: padTop, background: { r, g, b, alpha: 1 } })
        .jpeg({ quality: 90 })
        .toBuffer();
      const caminhoPad = `tmp/${userId}-pad.jpg`;
      const { error: padErr } = await supabase.storage.from('avatars').upload(caminhoPad, paddedBuf, {
        contentType: 'image/jpeg',
        upsert: true,
        cacheControl: '3600',
      });
      if (padErr) throw new Error(padErr.message);
      inputUrl = await assinarUrlAvatars(caminhoPad);
      console.log('[avatar-ai] etapa 0 - input pré-processado (top pad 18%)', { padTop, cor: { r, g, b } });
    } catch (e) {
      console.error('[avatar-ai] etapa 0 falhou, usa foto original (assinada):', e.message);
    }

    // Lei da casa: grátis = low, pago (pro/elite) = medium — a diferença de
    // qualidade é a fronteira do produto. Retrato 1024×1536 (receita L2P).
    // 31-jul (decisão do dono, revoga "grátis=low/pago=medium"): qualidade é UMA
    // só — low, para todos os planos. Nas comparações o low ganhou ~80% das vezes
    // (o prompt L2P é afinado para ele); o medium custava 3,5× por nada. O pago
    // diferencia-se por kits, fundos e créditos, não por qualidade de pintura.
    const qualidadeIA = 'low';

    // Edição do input pré-processado → cromo Panini Futty via gpt-image-1.5/edit.
    console.log('[avatar-ai] a chamar fal com:', {
      modelo: 'fal-ai/gpt-image-1.5/edit',
      image_url: inputUrl,
      kit: kitId,
      prompt_length: promptFutty(kitId).length,
      quality: qualidadeIA,
      image_size: '1024x1536',
    });

    // ETAPA 1+2 (retriáveis) — geração + remoção de fundo → buffer recortado.
    const gerarERecortar = async () => {
      let result;
      try {
        result = await fal.subscribe('fal-ai/gpt-image-1.5/edit', {
          input: {
            prompt: promptFutty(kitId), // secção KIT injectada do catálogo
            image_urls: [inputUrl, kit.url], // input pré-processado + asset do kit escolhido
            quality: qualidadeIA, // low para todos (31-jul)
            image_size: '1024x1536', // retrato — dá altura à coroa (receita L2P, 30-jul)
            num_images: 1,
          },
          logs: true,
        });
      } catch (err) {
        console.error('[avatar-ai] erro completo:', {
          message: err.message,
          status: err.status,
          body: JSON.stringify(err.body),
          response: err.response,
          stack: err.stack?.split('\n').slice(0, 3),
        });
        // fal não conseguiu DESCARREGAR/DECODIFICAR a foto de entrada (ficheiro
        // corrompido ou inacessível) — causa acionável (fotografia, não instabilidade
        // do serviço). Código próprio para o frontend distinguir sem depender do texto.
        let corpo = err.body;
        if (typeof corpo === 'string') { try { corpo = JSON.parse(corpo); } catch { corpo = null; } }
        if (corpo?.detail?.some((d) => d.type === 'file_download_error')) {
          throw new HttpError(422, 'A tua foto não pôde ser processada. Tenta enviar uma foto nova.', 'FOTO_INVALIDA');
        }
        throw err;
      }
      const urlGerada = result?.images?.[0]?.url;
      if (!urlGerada) throw new HttpError(502, 'A IA não devolveu imagem.');
      console.log('[avatar-ai] etapa 1 - GPT Image OK');
      console.log('[avatar-ai] url gerada pela IA:', urlGerada);

      // ETAPA 2 — remoção de fundo (birefnet) → jogador recortado (PNG transparente).
      const removeBgResult = await fal.subscribe('fal-ai/birefnet', {
        input: { image_url: urlGerada, model: 'General Use (Light)' },
      });
      const urlRecortada = removeBgResult?.image?.url;
      if (!urlRecortada) throw new HttpError(502, 'Falha na remoção de fundo.');
      console.log('[avatar-ai] etapa 2 - remove bg OK');
      console.log('[avatar-ai] url após remove bg:', urlRecortada);

      const respR = await fetch(urlRecortada);
      if (!respR.ok) throw new HttpError(502, 'Falha ao obter a imagem recortada.');
      return { urlGerada, urlRecortada, recorteBuffer: Buffer.from(await respR.arrayBuffer()) };
    };

    // REDE DE DETECÇÃO 1 — contacto com a borda, ANTES do trim. Topo (linhas
    // y=0..2, como antes): cabeça cortada. Laterais (colunas x=0..2 e
    // x=w-3..w-1, opacos > 15% da ALTURA): braço cortado pela borda.
    const bordaCortada = async (buf) => {
      const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const { width: w, height: h, channels: c } = info;
      const opaco = (x, y) => data[(y * w + x) * c + 3] > 200;

      let topoCount = 0;
      for (let y = 0; y <= 2 && y < h; y++) {
        let cnt = 0;
        for (let x = 0; x < w; x++) if (opaco(x, y)) cnt++;
        if (cnt > topoCount) topoCount = cnt;
      }
      const topoLimiar = Math.round(w * 0.15);

      const contarColuna = (x0) => {
        let cnt = 0;
        for (let y = 0; y < h; y++) if (opaco(x0, y)) cnt++;
        return cnt;
      };
      let esqCount = 0;
      for (let x = 0; x <= 2 && x < w; x++) esqCount = Math.max(esqCount, contarColuna(x));
      let dirCount = 0;
      for (let x = Math.max(0, w - 3); x < w; x++) dirCount = Math.max(dirCount, contarColuna(x));
      // HIERARQUIA DOS DEFEITOS (11-ago, dono): braço tocando a borda lateral NÃO
      // reprova — é linguagem de cromo (Panini/FIFA cortam braço na moldura) e era
      // a causa nº1 de retry (~31% de custo a mais). Vira AVISO no log. Rede de
      // segurança: contacto EXTREMO (>60% da altura colada) ainda reprova.
      const lateralAviso = Math.round(h * 0.15);
      const lateralExtremo = Math.round(h * 0.6);

      const topo = { cortado: topoCount > topoLimiar, count: topoCount, limiar: topoLimiar };
      const esquerda = { cortado: esqCount > lateralExtremo, aviso: esqCount > lateralAviso, count: esqCount };
      const direita = { cortado: dirCount > lateralExtremo, aviso: dirCount > lateralAviso, count: dirCount };
      if ((esquerda.aviso && !esquerda.cortado) || (direita.aviso && !direita.cortado)) {
        console.log('[avatar-ai] AVISO: braço na borda lateral, aceite como enquadramento', { esq: esqCount, dir: dirCount, h });
      }
      return { cortada: topo.cortado || esquerda.cortado || direita.cortado, topo, esquerda, direita };
    };

    // REDE DE DETECÇÃO 2 — achatamento da coroa, APÓS o trim: largura da 1ª
    // linha opaca ÷ largura máxima nas primeiras ~10% de linhas da figura.
    // > 0,5 = coroa comida. (scripts/_bench/prova-producao.js)
    const achatamentoCoroa = async (buf) => {
      const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const { width: w, height: h, channels: c } = info;
      const larg = (y) => { let n = 0; for (let x = 0; x < w; x++) if (data[(y * w + x) * c + 3] > 200) n++; return n; };
      let y0 = -1;
      for (let y = 0; y < h && y0 < 0; y++) if (larg(y) > 0) y0 = y;
      if (y0 < 0) return { razao: null, cortada: false };
      const faixa = Math.min(h, y0 + Math.max(8, Math.round(h * 0.10)));
      const primeira = larg(y0);
      let maxima = 0;
      for (let y = y0; y < faixa; y++) maxima = Math.max(maxima, larg(y));
      const razao = maxima ? primeira / maxima : 0;
      return { razao, cortada: razao > 0.5 };
    };

    // As duas verificações por geração: borda (pré-trim) + achatamento (pós-trim).
    // Guarda o buffer já trimado para reaproveitar na ETAPA 3 sem trim duplo.
    const verificarQualidade = async (recorteBuffer) => {
      const borda = await bordaCortada(recorteBuffer);
      const trimado = await sharp(recorteBuffer).trim({ threshold: 10 }).png().toBuffer();
      const achatamento = await achatamentoCoroa(trimado);
      return { ok: !borda.cortada && !achatamento.cortada, borda, achatamento, trimado };
    };

    let gen = await gerarERecortar();
    let verif = await verificarQualidade(gen.recorteBuffer);
    console.log('[avatar-ai] verificação de qualidade:', { borda: verif.borda, achatamento: verif.achatamento });
    if (!verif.ok) {
      console.log('[avatar-ai] retry: reprovada na 1ª geração', { borda: verif.borda, achatamento: verif.achatamento });
      try {
        const gen2 = await gerarERecortar();
        const verif2 = await verificarQualidade(gen2.recorteBuffer);
        console.log('[avatar-ai] verificação de qualidade (pós-retry):', { borda: verif2.borda, achatamento: verif2.achatamento });
        gen = gen2;
        verif = verif2;
      } catch (e) {
        console.error('[avatar-ai] retry falhou, mantém 1ª geração:', e.message);
      }
    }
    if (!verif.ok) {
      // Lei da casa: cabeça cortada nunca sai. Falhou nas duas rondas → não
      // entrega, não grava slot, não consome quota (o throw acontece antes
      // de qualquer um dos três, mais abaixo neste handler).
      console.error('[avatar-ai] REPROVADA após retry — não entrega:', { borda: verif.borda, achatamento: verif.achatamento });
      throw new HttpError(422, 'Não conseguimos gerar uma figurinha à altura com esta foto. Tente outra — de frente e bem iluminada.', 'FIGURINHA_DEFEITUOSA');
    }

    // ETAPA 3 — redimensiona o PNG já recortado e trimado (sharp). A troca de cor do kit é feita no frontend.
    const buffer = await sharp(verif.trimado)
      // Rede de segurança: garante 40px de margem transparente acima de QUALQUER
      // conteúdo, mesmo que a IA cole a cabeça à borda do PNG.
      .extend({ top: 40, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .resize({ height: 640, width: 512, fit: 'inside' })
      .png()
      .toBuffer();
    console.log('[avatar-ai] etapa 3 - resize OK');

    await ensureUserRow(req.user);
    // Um ficheiro POR KIT → os slots não se sobrepõem.
    const caminho = `public/${userId}-ai-${kitId}.png`;
    const { error: upErr } = await supabase.storage.from('avatars').upload(caminho, buffer, {
      contentType: 'image/png',
      upsert: true,
      cacheControl: '3600',
    });
    if (upErr) throw new HttpError(500, upErr.message);

    const { data: pub } = supabase.storage.from('avatars').getPublicUrl(caminho);
    const avatarUrl = `${pub.publicUrl}?v=${Date.now()}`;

    // Guarda o SLOT deste kit (upsert por (user_id, kit_id)) → a próxima vez que o
    // utilizador pedir este kit é servido do slot, sem gerar nem gastar quota.
    const { error: slotErr } = await supabase
      .from('user_avatar_slots')
      .upsert({ user_id: userId, kit_id: kitId, avatar_url: avatarUrl }, { onConflict: 'user_id,kit_id' });
    if (slotErr) throw new HttpError(500, slotErr.message);

    // Persiste o novo avatar + kit vestido + incrementa a quota (e grava o reset).
    // Super-admin: só actualiza o avatar/kit, sem mexer na quota.
    const dadosUpdate = { avatar_url: avatarUrl, kit_ativo: kitId };
    if (!perfil.is_super_admin) {
      dadosUpdate.avatar_ia_mes = usados + 1;
      dadosUpdate.avatar_ia_reset = resetData;
    }
    const { error: updErr } = await supabase.from('users').update(dadosUpdate).eq('id', userId);
    if (updErr) throw new HttpError(500, updErr.message);

    // Pacote anti-abuso (11-ago): soma o gasto do dia, guarda o log de IP e
    // dispara alertas/auto-freeze se algum sinal bater. Fire-and-forget (nunca
    // derruba a resposta — a figurinha já foi entregue ao utilizador).
    registrarGeracao({ userId, ip: req.ip }).catch(() => {});

    res.json({ avatar_url: avatarUrl, kit: kitId, do_slot: false });
  })
);

/**
 * PUT /api/me/kit — veste um kit JÁ GERADO (slot existente). Não gera nada.
 * 200 { avatar_url, kit } se houver slot; 409 { precisa_gerar: true, kit } se não.
 */
router.put(
  '/api/me/kit',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const kitId = String(req.body?.kit || '');
    const kit = KITS_IA[kitId];
    if (!kit) throw new HttpError(400, 'Kit inexistente.');

    const perfil = await getUserById(userId, 'plan, is_super_admin');
    const plano = perfil?.plan || 'free';
    if (!perfil?.is_super_admin && !kit.planos.includes(plano)) {
      throw new HttpError(403, 'Este kit exige um plano superior.');
    }

    const { data: slot } = await supabase
      .from('user_avatar_slots')
      .select('avatar_url')
      .eq('user_id', userId)
      .eq('kit_id', kitId)
      .maybeSingle();

    // Sem slot → o cliente tem de gerar primeiro (gasta quota). 409 ≠ erro: é um estado.
    if (!slot?.avatar_url) return res.status(409).json({ precisa_gerar: true, kit: kitId });

    await ensureUserRow(req.user);
    const { error } = await supabase
      .from('users')
      .update({ avatar_url: slot.avatar_url, kit_ativo: kitId })
      .eq('id', userId);
    if (error) throw new HttpError(500, error.message);

    res.json({ avatar_url: slot.avatar_url, kit: kitId });
  })
);

module.exports = router;
