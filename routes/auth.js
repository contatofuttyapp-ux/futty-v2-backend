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

    console.log('[avatar] concluído:', { userId, preservouAvatarIA: temAvatarIA });
    res.json({ foto_url: avatarUrl, avatar_url: novoAvatarUrl });
  })
);

// Prompt detalhado para a edição da foto real → cromo Panini estilo Futty.
const PROMPT_FUTTY = `
You are creating a professional illustrated soccer player sticker card.
You will receive TWO images:
- Image 1: photo of a real person (the player)
- Image 2: the exact soccer kit the player must wear

PRIORITY ORDER:
1st — Face accuracy: person must be immediately recognizable
2nd — Kit accuracy: reproduce Image 2 exactly as described below
3rd — Pose selection
4th — Illustration style

STYLE:
- Premium Panini sticker illustration style
- FIFA Ultimate Team card quality
- Semi-realistic digital painting
- NOT photographic, NOT anime, NOT cartoon
- Clean brushwork with visible fabric texture
- Rich deep color rendering

FACE AND IDENTITY — CRITICAL:
Study Image 1 carefully. Preserve exactly:
- Face shape, proportions and all features
- Eye shape, color and expression
- Nose and lip shape
- Skin tone (exact match)
- Hair style, color and texture
- Facial hair (exact style if present)
- All distinctive facial features
The person must be immediately recognizable in the result.

BODY:
- Add 15% more muscle — subtle and natural
- Slightly broader shoulders, more defined arms
- Must still look like the same person
- NOT a bodybuilder — subtle athletic improvement only

KIT — CRITICAL — REPRODUCE IMAGE 2 EXACTLY:
The kit in Image 2 is the Futty Dark Gold jersey. Reproduce it precisely:

JERSEY:
- Base color: deep black #0d0d12
- Large diagonal panel in metallic gold #d4a017
  running from upper-left shoulder down to lower-right hem
- V-neck collar: black with thin gold piping along the edge
- Short sleeves: black with thin gold trim at cuffs
- Badge: single Futty monogram (two mirrored F letters forming
  one unified symbol) in metallic gold on upper-left chest

SHORTS:
- Base color: deep black #0d0d12
- Diagonal gold stripe #d4a017 on left side
- Thin gold trim at waistband and leg openings

CRITICAL KIT RULES:
- Do NOT change any color, shape or design element
- Do NOT substitute or invent a different kit
- Do NOT add extra logos or badges
- Image 2 is the ground truth — follow it exactly
- Always use this kit — NEVER generate a white or blank jersey

TATTOOS:
- If visible in Image 1: include naturally on skin
- If not visible in Image 1: do NOT invent any

ACCESSORIES:
- Include ONLY what is clearly visible in Image 1
- NEVER invent caps, glasses or jewelry not present in photo

POSE — AUTO-SELECT ONE based on personality visible in Image 1:
- Arms crossed: calm, confident person
- Clenched fist: intense, competitive person
- Finger pointing up: expressive, proud person
- Arms wide celebration: joyful, high energy person
- Thumbs up: friendly, warm person
- Finger gun: stylish, cool person
Select ONE only. Do not mix poses.

FRAMING:
- Portrait 3:4 ratio
- Upper body only — head to waist, NO legs visible
- Face positioned in upper third of frame
- Character occupies 55-62% of image height maximum — leave generous empty space above the head, this is critical
- If in doubt about framing, make the character SMALLER and add MORE empty space above the head — cropping the head is the single worst possible error
- Clear empty space above head and below waist
- Never crop the head
- Player must appear smaller, not filling the entire frame

BACKGROUND — CRITICAL:
- SOLID dark background ONLY: #050810
- Absolutely NO stadium, NO crowd, NO field, NO grass, NO lights
- NO environmental elements of any kind
- NO green, NO arena, NO bokeh
- Pure flat dark color behind the player
- This is the most important rule after face accuracy

NEVER GENERATE:
- Photorealistic photography style
- Anime or cartoon style
- Full body showing legs
- Colored or busy background (stadium, grass, crowd, arena)
- Multiple people in the image
- White or blank jersey
- Any kit different from the Futty Dark Gold described above
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

    // ETAPA 0 — pré-processar a foto de entrada: estende o topo ~18% com a cor de
    // continuação da faixa superior. A IA ancora ao enquadramento do input; dar-lhe
    // espaço acima da cabeça faz com que deixe de cortar a coroa na saída (CASO B).
    // Usa upload Supabase (URL pública garantida) em vez de data URI, para não
    // arriscar uma geração paga num formato de input não confirmado no schema do fal.
    let inputUrl = perfil.foto_url;
    try {
      const fotoBuf = Buffer.from(await (await fetch(perfil.foto_url)).arrayBuffer());
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
      const { data: pubPad } = supabase.storage.from('avatars').getPublicUrl(caminhoPad);
      inputUrl = `${pubPad.publicUrl}?v=${Date.now()}`;
      console.log('[avatar-ai] etapa 0 - input pré-processado (top pad 18%)', { padTop, cor: { r, g, b } });
    } catch (e) {
      console.error('[avatar-ai] etapa 0 falhou, usa foto original:', e.message);
      inputUrl = perfil.foto_url;
    }

    // Edição do input pré-processado → cromo Panini Futty via gpt-image-1.5/edit.
    console.log('[avatar-ai] a chamar fal com:', {
      modelo: 'fal-ai/gpt-image-1.5/edit',
      image_url: inputUrl,
      prompt_length: PROMPT_FUTTY.length,
      quality: 'medium',
    });

    // ETAPA 1+2 (retriáveis) — geração + remoção de fundo → buffer recortado.
    const gerarERecortar = async () => {
      let result;
      try {
        result = await fal.subscribe('fal-ai/gpt-image-1.5/edit', {
          input: {
            prompt: PROMPT_FUTTY,
            image_urls: [inputUrl, KIT_URL], // input pré-processado + kit de referência
            quality: 'medium', // decisão do teste A3 (~$0.03-0.04/imagem)
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

    // REDE DE DETECÇÃO — coroa colada ao topo: linhas y=0..2 com muitos pixels
    // opacos (alpha > 200) = cabeça cortada. Limiar: > 15% da largura.
    const coroaNoTopo = async (buf) => {
      const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const { width: w, height: h, channels: c } = info;
      let maxCount = 0;
      for (let y = 0; y <= 2 && y < h; y++) {
        let cnt = 0;
        for (let x = 0; x < w; x++) if (data[(y * w + x) * c + 3] > 200) cnt++;
        if (cnt > maxCount) maxCount = cnt;
      }
      return { cortada: maxCount > w * 0.15, maxCount, limiar: Math.round(w * 0.15), largura: w };
    };

    let gen = await gerarERecortar();
    let det = await coroaNoTopo(gen.recorteBuffer);
    console.log('[avatar-ai] detecção coroa no topo:', det);
    if (det.cortada) {
      console.log('[avatar-ai] retry: coroa no topo');
      try {
        const gen2 = await gerarERecortar();
        const det2 = await coroaNoTopo(gen2.recorteBuffer);
        console.log('[avatar-ai] detecção coroa no topo (pós-retry):', det2);
        gen = gen2;
        det = det2;
        if (det2.cortada) console.log('[avatar-ai] AVISO: coroa no topo após retry');
      } catch (e) {
        console.error('[avatar-ai] retry falhou, mantém 1ª geração:', e.message);
      }
    }
    const { recorteBuffer } = gen;

    // ETAPA 3 — redimensiona o PNG recortado (sharp). A troca de cor do kit é feita no frontend.
    const buffer = await sharp(recorteBuffer)
      .trim({ threshold: 10 })
      // Rede de segurança: garante 40px de margem transparente acima de QUALQUER
      // conteúdo, mesmo que a IA cole a cabeça à borda do PNG.
      .extend({ top: 40, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .resize({ height: 640, width: 512, fit: 'inside' })
      .png()
      .toBuffer();
    console.log('[avatar-ai] etapa 3 - resize OK');

    await ensureUserRow(req.user);
    const caminho = `public/${userId}-ai.png`;
    const { error: upErr } = await supabase.storage.from('avatars').upload(caminho, buffer, {
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
