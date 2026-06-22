// Futty v2.0 — Rotas de autenticação / utilizador.
// (O login/registo é feito no frontend via Supabase Auth; aqui expomos o perfil.)
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const fal = require('@fal-ai/serverless-client');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, ensureUserRow, getUserById } = require('../utils/db');
const { notaParaExibir } = require('../utils/helpers');

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
const FUNDOS_FIGURINHA = ['estadio', 'gradiente', 'preto'];
// Limites de gerações de avatar IA por plano.
const LIMITES_IA = { free: 3, pro: 50, elite: 100 };
// Colunas de perfil devolvidas ao frontend.
const PERFIL_COLS =
  'id, nome, email, avatar_url, foto_url, nome_jogador, cor_preferida, telefone, avatar_ia_creditos, cor_frame, fundo_figurinha, plan, avatar_ia_mes, avatar_ia_reset, is_super_admin, birthdate';

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

    // Stats agregadas (todas as equipas):
    // jogos = presenças confirmadas; gols = soma; nota = média dos votos recebidos.
    const { count: jogos } = await supabase
      .from('game_players')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('confirmado', true);

    const { data: tmRows } = await supabase.from('team_members').select('gols').eq('user_id', userId);
    const gols = (tmRows || []).reduce((sum, r) => sum + (r.gols || 0), 0);

    // Nota exibida (1-10 com boost) — mín. 3 votos, como no ranking.
    const { data: voteRows } = await supabase.from('votes').select('nota').eq('para_user_id', userId);
    const totalVotos = voteRows ? voteRows.length : 0;
    const mediaInterna = totalVotos ? voteRows.reduce((sum, v) => sum + Number(v.nota), 0) / totalVotos : null;
    const nota = totalVotos >= 3 ? notaParaExibir(mediaInterna) : null;

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
      },
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
      if (v && v.length > 30) throw new HttpError(400, 'Nome de jogador: máximo 30 caracteres.');
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
      patch.fundo_figurinha = v;
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
 * POST /api/me/avatar — upload da foto de perfil (multipart, campo "avatar").
 * Vai para o Supabase Storage (bucket "avatars", path public/{userId}.{ext},
 * sobrescreve) e guarda o URL público em users.avatar_url.
 */
router.post(
  '/api/me/avatar',
  requireAuth,
  receberAvatar,
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

    // 3. UPDATE na tabela users (foto_url = original permanente; avatar_url = o que o app mostra).
    console.log('[avatar] UPDATE users:', { userId });
    const { error: updErr } = await supabase.from('users').update({ foto_url: avatarUrl, avatar_url: avatarUrl }).eq('id', userId);
    if (updErr) {
      console.error('[avatar] erro no UPDATE:', updErr.message);
      throw new HttpError(500, updErr.message);
    }

    console.log('[avatar] concluído:', { userId });
    res.json({ avatar_url: avatarUrl });
  })
);

// Prompt detalhado para a edição da foto real → cromo Panini estilo Futty.
const PROMPT_FUTTY = `
The second image shows the exact jersey and shorts the player must wear. Match the kit design precisely — same colors, same chevron shape, same F badge position.

You are creating a professional illustrated soccer player sticker.
I will upload ONE photo of a real person.
Study the photo carefully before generating anything.

STYLE REFERENCE:
- Premium Panini sticker collection art style
- FIFA Ultimate Team card illustration quality
- Semi-realistic digital painting
- NOT photographic, NOT hyperrealistic, NOT anime
- Clean confident brushwork with visible fabric texture
- Rich deep color rendering
- Warm skin tone rendering with soft natural shadows
- Sharp facial details with softer body rendering
- Professional sports trading card illustration quality

LIGHTING:
- Soft and even front-facing lighting
- No harsh shadows on the face
- Slight warm light from slightly above front
- Clean vibrant color rendering throughout
- Face should be the brightest and sharpest element

PRIORITY ORDER:
1st — Face accuracy (person must be recognizable)
2nd — Correct uniform
3rd — Correct pose
4th — Sticker style and background

SECTION 1 — ANALYZE THE PHOTO FIRST:
Before generating, carefully study and note:
- Face shape, features, skin tone, eye color
- Hair style, color, length and texture
- Facial hair (exact style)
- Body type and build
- Visible tattoos
- Any accessories (cap, glasses, jewelry)
- The person's energy and personality

SECTION 2 — FACE AND IDENTITY:
CRITICAL — The person must be immediately recognizable.
Preserve ALL of these faithfully:
- Face shape and proportions
- Eye shape, color and expression
- Nose and lip shape
- Skin tone (exact match)
- Hair style, color and texture
- Facial hair (exact style)
- All distinctive facial features

BODY BUILD:
- Add exactly 15% more muscle — subtle and natural
- Slightly broader shoulders, arms more defined
- Must still look like the same person
- NOT a bodybuilder — subtle athletic improvement only

SECTION 3 — UNIFORM:
Plain white jersey, completely blank.
No logos, no stripes, no patterns.
Pure white fabric only.
This is intentional — the jersey will be
replaced in post-processing.

SECTION 4 — TATTOOS:
If visible in photo: include naturally on exposed skin
If not in photo: do NOT add any

SECTION 5 — ACCESSORIES:
Include cap, glasses, chains ONLY if clearly visible in photo
NEVER invent accessories not in photo

SECTION 6 — POSE (AUTO-SELECT ONE):
Analyze personality from photo and choose:
POSE 1 — Arms crossed: calm, confident people
POSE 2 — Clenched fist: intense, competitive people
POSE 3 — Finger pointing up: expressive, proud people
POSE 5 — Goal celebration: joyful, high energy people
POSE 6 — Thumbs up: friendly, warm people
POSE 7 — Finger gun: stylish, cool people
SELECT ONE ONLY based on personality in photo.

SECTION 7 — FRAMING:
- Portrait orientation 3:4 ratio
- Upper body only — head to waist, NO legs
- Face in upper third of frame
- Character occupies 85-90% of image height
- Never crop the head

SECTION 8 — BACKGROUND:
Pure white #FFFFFF background.
No shadows, no gradients.
The character must have a clean white outline
against the white background.
CRITICAL: Subject must be perfectly isolated —
clean edges, no motion blur, no loose strands
bleeding into background.

NEVER GENERATE:
- Photorealistic photography style
- Anime or cartoon exaggeration
- Any sport other than soccer
- American football helmet or equipment
- Full body showing legs
- Dark or colored background
- Multiple characters
- Weapons

IMPORTANT:
The uploaded image is a real photograph.
Transform it completely into Panini illustration style.
Upper body only — head to waist, NO legs.
Plain white background.
Futty kit: dark vertical stripes with gold.
`;

// Kit Futty (referência) no Supabase Storage — usado na composição final (ETAPA 3).
const KIT_URL =
  'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/avatars/Kits/kit1-dark-gold.png';

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
    const perfil = await getUserById(userId, 'foto_url, plan, avatar_ia_mes, avatar_ia_reset, is_super_admin');
    if (!perfil?.foto_url) throw new HttpError(400, 'Adiciona uma foto primeiro.');

    // Quota por plano (com reset mensal). free: 3, pro: 50, elite: 100.
    const plano = perfil.plan || 'free';
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
            ? 'Limite de gerações atingido. Faz upgrade para Pro para continuar.'
            : 'Limite de gerações deste mês atingido.';
        throw new HttpError(403, msg);
      }
    }

    // Edição da foto real → cromo Panini Futty via gpt-image-1.5/edit.
    console.log('[avatar-ai] a chamar fal com:', {
      modelo: 'fal-ai/gpt-image-1.5/edit',
      image_url: perfil.foto_url,
      prompt_length: PROMPT_FUTTY.length,
      quality: 'low',
    });

    let result;
    try {
      result = await fal.subscribe('fal-ai/gpt-image-1.5/edit', {
        input: {
          prompt: PROMPT_FUTTY,
          image_urls: [perfil.foto_url], // só a foto do jogador (kit aplicado na ETAPA 3)
          quality: 'low',
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
      throw err;
    }

    const urlGerada = result?.images?.[0]?.url;
    if (!urlGerada) throw new HttpError(502, 'A IA não devolveu imagem.');
    console.log('[avatar-ai] etapa 1 - GPT Image OK');

    // ETAPA 2 — remoção de fundo (birefnet) → jogador recortado (PNG transparente).
    const removeBgResult = await fal.subscribe('fal-ai/birefnet', {
      input: {
        image_url: urlGerada,
        model: 'General Use (Light)',
      },
    });
    const urlRecortada = removeBgResult?.image?.url;
    if (!urlRecortada) throw new HttpError(502, 'Falha na remoção de fundo.');
    console.log('[avatar-ai] etapa 2 - remove bg OK');

    // ETAPA 3 — composição do jogador recortado sobre o kit (sharp).
    const kitBuffer = await fetch(KIT_URL).then((r) => r.arrayBuffer());
    const jogadorBuffer = await fetch(urlRecortada).then((r) => r.arrayBuffer());

    const kitMeta = await sharp(Buffer.from(kitBuffer)).metadata();
    const kitH = kitMeta.height;

    // Jogador a 90% da altura do kit, mantendo proporção.
    const jogadorRedim = await sharp(Buffer.from(jogadorBuffer))
      .resize({ height: Math.round(kitH * 0.9), fit: 'inside' })
      .toBuffer();

    // Kit em baixo, jogador centrado horizontalmente e a começar do topo (gravity north).
    const imagemFinal = await sharp(Buffer.from(kitBuffer))
      .composite([{ input: jogadorRedim, gravity: 'north' }])
      .png()
      .toBuffer();
    console.log('[avatar-ai] etapa 3 - composição OK');

    await ensureUserRow(req.user);
    const caminho = `public/${userId}-ai.png`;
    const { error: upErr } = await supabase.storage.from('avatars').upload(caminho, imagemFinal, {
      contentType: 'image/png',
      upsert: true,
      cacheControl: '3600',
    });
    if (upErr) throw new HttpError(500, upErr.message);

    const { data: pub } = supabase.storage.from('avatars').getPublicUrl(caminho);
    const avatarUrl = `${pub.publicUrl}?v=${Date.now()}`;

    // Persiste o novo avatar + incrementa a quota (e grava o reset se mudou).
    // Super-admin: só actualiza o avatar, sem mexer na quota.
    const dadosUpdate = { avatar_url: avatarUrl };
    if (!perfil.is_super_admin) {
      dadosUpdate.avatar_ia_mes = usados + 1;
      dadosUpdate.avatar_ia_reset = resetData;
    }
    const { error: updErr } = await supabase.from('users').update(dadosUpdate).eq('id', userId);
    if (updErr) throw new HttpError(500, updErr.message);

    res.json({ avatar_url: avatarUrl });
  })
);

module.exports = router;
