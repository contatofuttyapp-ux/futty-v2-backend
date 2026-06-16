// Futty v2.0 — Rotas de autenticação / utilizador.
// (O login/registo é feito no frontend via Supabase Auth; aqui expomos o perfil.)
const express = require('express');
const multer = require('multer');
const fal = require('@fal-ai/serverless-client');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, ensureUserRow, getUserById } = require('../utils/db');
const { notaParaExibir } = require('../utils/helpers');

// fal.ai — credenciais via FAL_KEY (.env).
fal.config({ credentials: process.env.FAL_KEY });

const router = express.Router();

// Corre uma promise com timeout (geração de IA pode demorar).
function comTimeout(promise, ms, msg) {
  let t;
  const limite = new Promise((_, rej) => {
    t = setTimeout(() => rej(new HttpError(504, msg)), ms);
  });
  return Promise.race([promise, limite]).finally(() => clearTimeout(t));
}

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
  'id, nome, email, avatar_url, foto_url, nome_jogador, cor_preferida, telefone, avatar_ia_creditos, cor_frame, fundo_figurinha, plan, avatar_ia_mes, avatar_ia_reset';

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
    if ('telefone' in b) {
      const v = b.telefone == null ? null : String(b.telefone).trim();
      if (v && v.length > 20) throw new HttpError(400, 'Telefone: máximo 20 caracteres.');
      patch.telefone = v || null;
    }
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
    await ensureUserRow(req.user);

    const caminho = `public/${userId}.${ext}`;
    const { error: upErr } = await supabase.storage.from('avatars').upload(caminho, file.buffer, {
      contentType: file.mimetype,
      upsert: true,
      cacheControl: '3600',
    });
    if (upErr) throw new HttpError(500, upErr.message);

    const { data: pub } = supabase.storage.from('avatars').getPublicUrl(caminho);
    // ?v= força o browser a recarregar (o path é fixo porque sobrescreve).
    const avatarUrl = `${pub.publicUrl}?v=${Date.now()}`;

    // foto_url = foto original permanente; avatar_url = o que o app mostra.
    const { error: updErr } = await supabase.from('users').update({ foto_url: avatarUrl, avatar_url: avatarUrl }).eq('id', userId);
    if (updErr) throw new HttpError(500, updErr.message);

    res.json({ avatar_url: avatarUrl });
  })
);

/**
 * POST /api/me/avatar/ai — gera um avatar estilo cromo a partir da foto atual,
 * via fal.ai, e guarda em avatars/public/{userId}-ai.png (separado da foto real).
 * Por agora todos usam FLUX schnell (free).
 */
router.post(
  '/api/me/avatar/ai',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!process.env.FAL_KEY) throw new HttpError(500, 'Geração de IA indisponível (FAL_KEY não configurada).');

    const userId = req.user.id;
    const perfil = await getUserById(userId, 'foto_url, plan, avatar_ia_mes, avatar_ia_reset');
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
    if (usados >= limite) {
      const msg =
        plano === 'free'
          ? 'Limite de gerações atingido. Faz upgrade para Pro para continuar.'
          : 'Limite de gerações deste mês atingido.';
      throw new HttpError(403, msg);
    }

    // Modelo conforme o plano. Por agora, todos em FLUX schnell.
    const MODELO = 'fal-ai/flux/schnell';
    // TODO Pro/Elite (quando os planos existirem): 'fal-ai/openai/gpt-image-1'.

    const resultado = await comTimeout(
      fal.subscribe(MODELO, {
        input: {
          image_url: perfil.foto_url, // a IA usa sempre a foto real como fonte
          prompt:
            'Panini football sticker card portrait, semi-realistic illustration style, vibrant colors, clean gradient background, athletic football pose, sharp details, card art style',
          image_size: 'portrait_4_3',
          num_inference_steps: 4,
          num_images: 1,
        },
      }),
      60000,
      'A geração demorou demasiado. Tenta novamente.'
    );

    const urlGerada = resultado?.images?.[0]?.url;
    if (!urlGerada) throw new HttpError(502, 'A IA não devolveu imagem.');

    // Descarrega a imagem gerada e envia para o Storage.
    const resp = await fetch(urlGerada);
    if (!resp.ok) throw new HttpError(502, 'Falha ao obter a imagem gerada.');
    const buffer = Buffer.from(await resp.arrayBuffer());

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
    const { error: updErr } = await supabase
      .from('users')
      .update({ avatar_url: avatarUrl, avatar_ia_mes: usados + 1, avatar_ia_reset: resetData })
      .eq('id', userId);
    if (updErr) throw new HttpError(500, updErr.message);

    res.json({ avatar_url: avatarUrl });
  })
);

module.exports = router;
