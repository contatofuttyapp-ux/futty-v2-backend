// Futty v2.0 — Rotas de autenticação / utilizador.
// (O login/registo é feito no frontend via Supabase Auth; aqui expomos o perfil.)
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { requireAuth, invalidarSessaoDoPedido } = require('../middleware/auth');
const { marcarFase } = require('../middleware/tempo');
const { excluirContaLimiter } = require('../middleware/limiters');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, ensureUserRow, getUserById } = require('../utils/db');
const { obterMe, marcarFigurinhaStatus } = require('../services/inicio');
const { filtroNSFW } = require('../utils/nsfwFilter');
const { olheiroEntrada } = require('../utils/olheiroEntrada');
const { sha256Hex, verificarTeto, verificarFreeze, registrarGeracao } = require('../utils/antiAbusoIA');
const { apagarUsuario } = require('../utils/apagarUsuario');
// A figurinha, em três módulos próprios (17-set, variante 6 da bancada):
//   prompts/figurinha.js       o texto que vai à IA (a bancada importa o MESMO)
//   utils/entradaFigurinha.js  a foto que vai com ele (faixa + corte quadrado)
//   utils/falFila.js           a chamada, e o custo REAL vindo dos headers da fal
const { montarPrompt } = require('../prompts/figurinha');
const { preprocessarQuadrado, preprocessarRetrato } = require('../utils/entradaFigurinha');
const { chamarFal } = require('../utils/falFila');
const {
  gerarFigurinha, RECEITA, V6_ENDPOINT, FIDELIDADE_V6,
  PASSADA1_ENDPOINT, PASSADA2_ENDPOINT, QUALIDADE, FIDELIDADE_PASSADA2, TAMANHO_1_5,
} = require('../utils/geracaoFigurinha');
// Quem pode gerar uma Brilhante (SPEC-FIGURINHA-3, §5). Desde 22-set toda
// geração nasce paga: crédito comprado/presenteado ou pacote do time.
const { temDireito, debitar, ehMigracaoEmFalta } = require('../utils/direitoBrilhante');

// fal.ai — a chave vem do ambiente (FAL_KEY) e é lida dentro de utils/falFila.js,
// que é quem fala com a fal desde 17-set (o SDK escondia os headers de custo).

const router = express.Router();

// Upload do avatar: ficheiro em memória, só imagens, máximo 5MB.
const MAX_AVATAR = 5 * 1024 * 1024;
const AVATAR_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const uploadAvatarMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR },
  fileFilter: (req, file, cb) => {
    if (AVATAR_MIME[file.mimetype]) cb(null, true);
    else cb(new HttpError(400, 'Só são aceitas imagens JPEG, PNG ou WebP.'));
  },
}).single('avatar');

// Wrapper que corre o multer, auto-orienta pelo EXIF e converte os erros dele
// em HttpError(400).
function receberAvatar(req, res, next) {
  uploadAvatarMw(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        const msg = err.code === 'LIMIT_FILE_SIZE' ? 'A imagem excede o limite de 5MB.' : 'Falha no upload da imagem.';
        return next(new HttpError(400, msg));
      }
      return next(err); // HttpError do fileFilter ou outro
    }
    // EXIF (build 9, achado real: selfie do iPhone girada 180°). .rotate() sem
    // argumentos lê a tag Orientation, reescreve os pixels já em pé e apaga a
    // tag — ninguém depois (NSFW, Olheiro, Storage, IA) precisa de voltar a
    // interpretar orientação. O frontend já normaliza antes de subir
    // (utils/normalizarFoto.js) — isto é o cinto e suspensório: cobre
    // qualquer caminho que não passe por lá (API directa, cliente antigo).
    // ANTES de qualquer outra operação: primeira coisa a tocar no buffer.
    if (req.file) {
      try {
        req.file.buffer = await sharp(req.file.buffer).rotate().toBuffer();
      } catch {
        return next(new HttpError(400, 'Não foi possível ler essa imagem.'));
      }
    }
    next();
  });
}

// Cores de uniforme válidas (igual ao CHECK da migração 013).
const CORES_UNIFORME = ['verde', 'azul', 'vermelho', 'preto', 'amarelo', 'cinzento'];
// Preferências da figurinha (igual aos CHECKs da migração 018).
const CORES_FRAME = ['dourado', 'verde', 'roxo', 'branco'];
const FUNDOS_FIGURINHA = ['estadio', 'gradiente', 'aura', 'preto', 'golden', 'royal'];
// Avatar genérico escolhido (migração 044) — masc m1-m3, fem f1-f3. NULL = rodízio.
const AVATARES_GENERICOS = ['m1', 'm2', 'm3', 'f1', 'f2', 'f3'];
// Fundos PREMIUM: GOLDEN, AURA e ROYAL. ÉPICO ('gradiente', chave interna) é
// GRÁTIS (15-set, decisão do dono) — fora desta lista de propósito.
//
// LEI DA REGRA JUSTA (sem punição retroativa): o gate só corre AQUI, no PATCH
// que TROCA fundo_figurinha — nunca em leitura (GET /api/me) nem no render.
// Quem já tinha Aura equipado antes deste gate MANTÉM (a coluna já gravada
// nunca é revalidada até o próprio utilizador mexer nela). Só ao tentar
// EQUIPAR de novo (depois de trocar pra outro fundo) é que o direito volta a
// ser exigido — ninguém perde o que já tinha, mas ninguém re-adquire de graça.
// Ver Figurinha.jsx `escolherFundo` (o `if (k === fundo) return` early-return
// é o que preserva isto: reabrir a mesma página nunca reenvia o PATCH do
// fundo já equipado).
//
// 22-set (SPEC-FIGURINHA-3): estes 3 fundos vêm com a BRILHANTE, não com um
// plano — o gate virou DIREITO (ter avatar_url ≠ foto_url), super-admin
// sempre passa. Lista de ids, já não um mapa de planos.
const FUNDOS_PREMIUM = ['golden', 'aura', 'royal'];
// MORTO desde 22-set (SPEC-FIGURINHA-3): quem manda na geração é o DIREITO
// (utils/direitoBrilhante.js), não o plano. Nada lê esta tabela — nem esta rota,
// nem o Gabinete. Fica só como registo do modelo antigo (grátis 2 / Pro 10 /
// Elite 20 por mês) até a limpeza que também apaga users.avatar_ia_mes/_reset e
// tira `plan` das telas. Não voltar a ligar sem decisão do dono.
// eslint-disable-next-line no-unused-vars
const LIMITES_IA_APOSENTADO = { free: 2, pro: 10, elite: 20 };
// Colunas de perfil devolvidas ao frontend.
// mostrar_rosto_publico (migração 040) e avatar_generico (migração 044) confirmadas
// presentes em produção (10-set) — juntas aqui em vez de 2 consultas extra por /api/me.
const PERFIL_COLS =
  'id, nome, email, avatar_url, foto_url, nome_jogador, cor_preferida, telefone, avatar_ia_creditos, cor_frame, fundo_figurinha, plan, avatar_ia_mes, avatar_ia_reset, is_super_admin, birthdate, kit_ativo, mostrar_rosto_publico, avatar_generico';

/**
 * GET /api/me — devolve o utilizador autenticado + stats agregadas.
 * Garante também a linha em public.users (caso o trigger não tenha corrido).
 * Lógica em services/inicio.js#obterMe — a MESMA função que GET /api/inicio usa,
 * para o JSON nunca divergir entre as duas rotas.
 */
router.get(
  '/api/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    marcarFase(res, 'auth');
    const me = await obterMe(req.user);
    marcarFase(res, 'perfil');
    res.json(me);
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
      // GATE (servidor é a fonte da verdade — sem truque de frontend). 22-set,
      // SPEC-FIGURINHA-3 §4/§9: os 3 fundos de cima deixaram de ser por PLANO e
      // passaram a vir COM a Brilhante. Os planos saíram das telas e um membro
      // do pacote via o Aura trancado no card que o time tinha acabado de
      // pagar. Quem não tem Brilhante não tem sequer seletor de fundo — este
      // gate é a defesa em profundidade para um pedido montado à mão.
      if (FUNDOS_PREMIUM.includes(v)) {
        const perfil = await getUserById(req.user.id, 'avatar_url, foto_url, is_super_admin');
        const temBrilhante = !!perfil?.avatar_url && perfil.avatar_url !== perfil.foto_url;
        if (!perfil?.is_super_admin && !temBrilhante) {
          throw new HttpError(403, 'Os 6 fundos vêm com a figurinha.', 'SEM_BRILHANTE');
        }
      }
      patch.fundo_figurinha = v;
    }
    // Consentimento de rosto público (Opção B): toggle no Perfil → Privacidade.
    if ('mostrar_rosto_publico' in b) {
      patch.mostrar_rosto_publico = b.mostrar_rosto_publico === true;
    }
    // Avatar genérico escolhido a dedo (migração 044). O app não pergunta sexo — a
    // pessoa escolhe entre os 6 no seletor; null limpa a escolha e volta ao rodízio.
    if ('avatar_generico' in b) {
      const v = b.avatar_generico == null || b.avatar_generico === '' ? null : String(b.avatar_generico);
      if (v && !AVATARES_GENERICOS.includes(v)) throw new HttpError(400, 'Avatar genérico inválido.');
      patch.avatar_generico = v;
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

    // avatar_generico não vive em PERFIL_COLS (mesma razão do mostrar_rosto_publico:
    // coluna nova, leitura defensiva) — devolve o valor que acabou de gravar.
    const userOut = 'avatar_generico' in patch ? { ...updated, avatar_generico: patch.avatar_generico } : updated;
    res.json({ user: userOut });
  })
);

/**
 * DELETE /api/me — exclui a conta por completo (LGPD / exigência das lojas).
 * Exige confirmação explícita no corpo: { confirmacao: 'EXCLUIR' }. A ordem de
 * deleção (times, Storage, logs, conta) vive em utils/apagarUsuario.js — a
 * MESMA lógica usada por scripts/limpar-usuarios-teste.js, para nunca haver
 * duas versões dela a divergir com o tempo.
 */
router.delete(
  '/api/me',
  requireAuth,
  excluirContaLimiter,
  asyncHandler(async (req, res) => {
    if (req.body?.confirmacao !== 'EXCLUIR') {
      throw new HttpError(400, 'Confirmação obrigatória: envie { confirmacao: "EXCLUIR" }.');
    }
    await apagarUsuario(req.user.id);
    // Sem isto, o token desta sessão continuava "válido" (cache de 60s em
    // middleware/auth.js) mesmo com a conta já excluída no Supabase.
    invalidarSessaoDoPedido(req);
    res.json({ ok: true });
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
    // Sem isto, o req.user cacheado (middleware/auth.js, TTL 60s) continuava a
    // devolver onboarding_completo:false ao GET /api/me seguinte — o
    // OnboardingGate do frontend mandava de volta para /onboarding em loop
    // (achado 14-set: só aparecia em quem pulava a foto, porque esse caminho é
    // rápido demais para os 60s do cache expirarem sozinhos).
    invalidarSessaoDoPedido(req);
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
    // Mesmo motivo do onboarding-completo acima: sem invalidar, o GET /api/me
    // seguinte podia devolver tour_inicio_visto:false do cache por até 60s.
    invalidarSessaoDoPedido(req);
    res.json({ tour_inicio_visto: true });
  })
);

/**
 * POST /api/me/avatar — upload da foto de perfil (multipart, campo "avatar").
 * Vai para o Supabase Storage (bucket "avatars", caminho
 * `public/{userId}-{carimbo}.{ext}`) e guarda o URL em users.foto_url — e o
 * sha256 dos bytes em users.foto_hash, no MESMO update. Cada foto é um objeto
 * NOVO; a anterior é apagada depois de o banco estar gravado.
 */
router.post(
  '/api/me/avatar',
  requireAuth,
  receberAvatar,
  filtroNSFW, // Tijolo 1: bloqueia imagem explícita antes de guardar (avatar + onboarding)
  olheiroEntrada, // 11-ago: barra foto sem futuro (pequena/corrompida/preta/estourada) antes de guardar
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, 'Nenhuma imagem enviada (campo "avatar").');
    const ext = AVATAR_MIME[file.mimetype];
    if (!ext) throw new HttpError(400, 'Formato de imagem não suportado.');

    const userId = req.user.id;
    // 1. Ficheiro recebido (multer).
    console.log('[avatar] ficheiro recebido:', { userId, mimetype: file.mimetype, ext, size: file.size });

    await ensureUserRow(req.user);

    // Nome POR VERSÃO (22-set): cada foto é um objeto novo. Ver a nota em
    // `caminhoFotoNovo` — caminho que muda de conteúdo é caminho que alguém,
    // algures, serve desactualizado.
    const caminho = caminhoFotoNovo(userId, ext);
    // 2. Upload para o Supabase Storage (bucket "avatars"). Sem upsert: o
    // carimbo de tempo já torna o nome único, e se por absurdo colidisse, o
    // certo é falhar aqui em vez de escrever por cima do objeto de outra
    // chamada — que é precisamente o hábito que esta rodada veio tirar.
    console.log('[avatar] upload p/ Storage:', { bucket: 'avatars', caminho });
    const { error: upErr } = await supabase.storage.from('avatars').upload(caminho, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
      cacheControl: '3600',
    });
    if (upErr) {
      console.error('[avatar] erro no upload:', upErr.message);
      throw new HttpError(500, upErr.message);
    }

    const { data: pub } = supabase.storage.from('avatars').getPublicUrl(caminho);
    // O ?v= já não é o que garante a actualização (o caminho é novo a cada
    // foto), mas fica: é o que distingue versões no proxy de mídia, que usa o
    // `v` na chave de cache dos derivados.
    const avatarUrl = `${pub.publicUrl}?v=${Date.now()}`;
    // URL público — deve usar o domínio do Supabase, não localhost.
    console.log('[avatar] URL público:', avatarUrl);

    // 3. UPDATE na tabela users. foto_url = a nova foto (fonte da geração IA).
    //    avatar_url (o que o card mostra): no modo 'foto' (Rodada 18,
    //    users.card_modo, migração 056) segue sempre a foto nova, mesmo
    //    havendo figurinha — é a escolha explícita da pessoa. Nos demais
    //    casos (modo 'figurinha' ou ainda sem escolha) SÓ é sobrescrito se
    //    ainda NÃO houver avatar IA; se já houver (avatar_url ≠ foto_url
    //    actual), preserva-se → o card continua a mostrar o avatar antigo até
    //    o utilizador gerar de novo (nunca a foto crua) — comportamento de
    //    sempre, mantido como fail-safe se a 056 ainda não tiver corrido.
    let atual = await getUserById(userId, 'foto_url, avatar_url, card_modo');
    if (!atual) {
      // Sem a 056, `card_modo` não existe e o select acima falha inteiro
      // (o PostgREST recusa a query toda por uma coluna desconhecida) — cai
      // aqui sem ela. `ensureUserRow` já rodou: se ainda vier vazio, é
      // mesmo a coluna que falta, não a linha.
      atual = await getUserById(userId, 'foto_url, avatar_url');
    }
    const temAvatarIA = !!atual?.avatar_url && atual.avatar_url !== atual.foto_url;
    const modoFoto = atual?.card_modo === 'foto';
    const novoAvatarUrl = modoFoto ? avatarUrl : (temAvatarIA ? atual.avatar_url : avatarUrl);
    console.log('[avatar] UPDATE users:', { userId, temAvatarIA, modoFoto });

    // O HASH VAI NO MESMO UPDATE que o URL (22-set). Antes era gravado a
    // seguir, num update próprio, e isso abria uma janela de milissegundos em
    // que `foto_url` já era a foto NOVA e `foto_hash` ainda era o da ANTIGA.
    // Quem pedisse figurinha dentro dessa janela caía no reuso de slot — que
    // compara o fingerprint do slot com o `foto_hash` — e recebia a figurinha
    // velha de volta. Uma linha só fecha a janela: ou grava tudo, ou nada.
    const patchFoto = { foto_url: avatarUrl, avatar_url: novoAvatarUrl, foto_hash: sha256Hex(file.buffer) };
    let { error: updErr } = await supabase.from('users').update(patchFoto).eq('id', userId);
    if (updErr && /foto_hash/i.test(updErr.message || '')) {
      // Migração 048 por correr: grava o resto, avisa, e segue. O anti-abuso
      // perde um sinal; o upload não pode cair por causa disso.
      console.error('[avatar] foto_hash não existe nesta base (migração 048 por correr?) — gravo sem ele');
      delete patchFoto.foto_hash;
      ({ error: updErr } = await supabase.from('users').update(patchFoto).eq('id', userId));
    }
    if (updErr) {
      console.error('[avatar] erro no UPDATE:', updErr.message);
      throw new HttpError(500, updErr.message);
    }

    // A foto anterior deixou de ser referenciada por `users.foto_url` — sai do
    // bucket. Só DEPOIS do update: se apagasse antes e o update falhasse, o
    // utilizador ficava sem foto nenhuma. Não se apaga quando o caminho é o
    // mesmo (conta antiga, nome fixo) nem quando o avatar_url ainda aponta
    // para ela (quem nunca gerou figurinha vê a própria foto no card).
    const caminhoAntigo = caminhoNoBucket(atual?.foto_url, 'avatars');
    const aindaEmUso = caminhoAntigo === caminho || caminhoAntigo === caminhoNoBucket(novoAvatarUrl, 'avatars');
    if (caminhoAntigo && !aindaEmUso) await apagarAntigo(caminhoAntigo, 'foto substituída');

    // A FIGURINHA COMUM FICA PRONTA AQUI (SPEC-FIGURINHA-3 §3): ela é a foto na
    // moldura — assim que há foto, não há nada a esperar. O 'gerando' passa a
    // existir só para a Brilhante. Sem isto, quem trocasse a foto logo depois
    // de uma Brilhante falhada ficava preso no "não deu certo" do Início.
    // Best-effort (coluna da migração 051): nunca derruba o upload.
    marcarFigurinhaStatus(userId, 'pronta');

    console.log('[avatar] concluído:', { userId, preservouAvatarIA: temAvatarIA && !modoFoto, modoFoto });
    res.json({ foto_url: avatarUrl, avatar_url: novoAvatarUrl });
  })
);

// O PROMPT DA FIGURINHA vive em prompts/figurinha.js (fonte única, 17-set).
// Aqui ficou só a chamada: montarPrompt(kitId). O prompt antigo (PROMPT_BASE
// de 5.375 caracteres + kitPrompt em cinco pontos + kitChecklist) foi REPROVADO
// na bancada de 49 figurinhas — 1,6/5 contra 4,1/5 do que está agora lá. Não
// voltar a escrever prompt dentro desta rota: a bancada importa do mesmo módulo,
// e é isso que garante que o que se mede é o que está no ar.
// Kit Futty (referência) no Supabase Storage — usado na composição final (ETAPA 3).
// Assets dos kits em bucket PÚBLICO próprio ('kits') — são assets do app, não PII.
// (Antes viviam em avatars/Kits/; o tijolo 1C privatizou avatars e partia o fal +
// as thumbnails. Movidos para 'kits' público, que a privatização não toca.)
const KIT_URL =
  'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/kits/kit1-dark-gold.png';
const KIT2_URL =
  'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/kits/kit2-dark-purple.png';

// Catálogo de kits geráveis. `ativo:false` → 400 (ainda sem asset próprio no
// Storage). Espelha os 5 ids do frontend. `acento` é a cor de destaque do kit
// (usada no cartaz e na composição do app). A frase do kit para a IA NÃO vive
// aqui: está em prompts/figurinha.js, uma por kit.
//
// 22-set (SPEC-FIGURINHA-3): o campo `planos` (Free/Pro/Elite) saiu — quem
// pode GERAR um kit novo é o DIREITO (utils/direitoBrilhante.js), não plano
// nenhum; quem já gerou um kit pode sempre voltar a vesti-lo (PUT /api/me/kit,
// sem gate nenhum). Nenhum kit é mais "grátis" ou "pago" em si — o que é pago
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
    ativo: true, // asset escolhido pelo dono (31-jul): white-gold-c1 → kit3
    url: 'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/kits/kit3-white-gold.png',
    acento: 'metallic gold #d4a017',
  },
  'elite-gold': {
    ativo: true, // asset escolhido pelo dono (31-jul): elite-gold-c1 → kit4
    url: 'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/kits/kit4-elite-gold.png',
    acento: 'deep black #0d0d12', // kit invertido — o acento aqui é o preto, não o ouro
  },
  'royal-purple': {
    ativo: true, // 5º kit do lançamento (31-jul): royal-purple-c3 → kit5. Par do Elite Gold.
    url: 'https://ynzmjcvqdljffgbeqglh.supabase.co/storage/v1/object/public/kits/kit5-royal-purple.png',
    acento: 'deep black #0d0d12', // invertido — roxo é a base, preto é o acento
  },
};

// O prompt vem inteiro do módulo — esta rota não monta texto nenhum.
const promptFutty = (kitId) => montarPrompt(kitId);

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

// ── Nomes de ficheiro POR VERSÃO (22-set) ────────────────────────────────────
//
// Antes, a foto ia sempre para `public/<userId>.<ext>` e a figurinha para
// `public/<userId>-ai-<kit>.png`, com upsert por cima. Um caminho que muda de
// conteúdo é um convite a cache velho: navegador, WebView, CDN e qualquer
// proxy pelo caminho podem servir a versão anterior, e não há como pedir para
// esquecerem. Com o carimbo de tempo no nome, cada versão é um OBJETO NOVO —
// URL diferente, cache sem nada a dizer.
//
// Quem já tem ficheiro no nome antigo fica como está até trocar de foto: a
// LEITURA sai sempre de `users.foto_url` / `avatar_url`, que guardam o caminho
// completo, e por isso aceita os dois padrões sem saber a diferença.
const caminhoFotoNovo = (userId, ext) => `public/${userId}-${Date.now()}.${ext}`;
const caminhoFigurinhaNova = (userId, kitId) => `public/${userId}-ai-${kitId}-${Date.now()}.png`;

/**
 * Apaga um objeto do bucket `avatars` que deixou de ser usado.
 * Best-effort de propósito: falhar a limpeza nunca pode derrubar um upload ou
 * uma geração que já correram bem — o pior caso é um ficheiro órfão, e isso
 * conta-se no log em vez de se atirar para cima do utilizador.
 */
async function apagarAntigo(caminho, motivo) {
  if (!caminho) return;
  try {
    const { error } = await supabase.storage.from('avatars').remove([caminho]);
    if (error) throw new Error(error.message);
    console.log('[avatar] versão anterior apagada', { caminho, motivo });
  } catch (e) {
    console.warn('[avatar] não consegui apagar a versão anterior (fica órfã):', { caminho, motivo, erro: e.message });
  }
}

/**
 * Baixa a foto e confirma que é a que a tabela diz ser a atual.
 *
 * Existe por causa do relato de 22-set (foto nova, figurinha da foto antiga).
 * A causa nunca se reproduziu em bancada — o download autenticado devolveu
 * sempre a versão certa —, mas a verificação é barata e o que ela evita é caro:
 * uma figurinha da foto errada com o dinheiro já gasto. Se o hash não bater,
 * tenta de novo (pode ser propagação), e ao fim de três tentativas recusa sem
 * chamar a fal e sem contar quota.
 */
async function baixarFotoConferida(caminho, hashEsperado) {
  let ultimoHash = null;
  for (let tentativa = 1; tentativa <= 3; tentativa += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { data: blob, error } = await supabase.storage.from('avatars').download(caminho);
    if (error) throw new Error(error.message);
    // eslint-disable-next-line no-await-in-loop
    const buf = Buffer.from(await blob.arrayBuffer());
    ultimoHash = sha256Hex(buf);
    const confere = !hashEsperado || ultimoHash === hashEsperado;
    console.log('[avatar-ai] etapa 0 - foto baixada', {
      caminho,
      tentativa,
      sha256: ultimoHash.slice(0, 12),
      esperado: (hashEsperado || '(sem hash gravado)').slice(0, 12),
      confere,
    });
    if (confere) return buf;
    if (tentativa < 3) {
      console.warn('[avatar-ai] a foto baixada não é a atual — espero 2 s e tento de novo');
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.error('[avatar-ai] RECUSADO: a foto baixada continua diferente da atual', {
    caminho, baixado: ultimoHash?.slice(0, 12), esperado: hashEsperado?.slice(0, 12),
  });
  throw new HttpError(
    409,
    'Sua foto ainda está sendo preparada — tente de novo em instantes',
    'FOTO_DESATUALIZADA',
  );
}

/**
 * POST /api/me/avatar/ai — gera a Figurinha BRILHANTE a partir da foto atual
 * (receita V6 por omissão, ver utils/geracaoFigurinha.js) e guarda em
 * avatars/public/{userId}-ai-{kit}-{carimbo}.png, separada da foto real.
 *
 * SPEC-FIGURINHA-3 (22-set): toda geração nasce PAGA. Sem direito (crédito ou
 * pacote do time) → 403 SEM_DIREITO. `LIMITES_IA` por plano e
 * `users.avatar_ia_mes` deixaram de mandar aqui — a figurinha grátis é a
 * COMUM (a foto na moldura), que não passa por esta rota nem custa nada.
 */
router.post(
  '/api/me/avatar/ai',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!process.env.FAL_KEY) throw new HttpError(500, 'Geração de IA indisponível (FAL_KEY não configurada).');

    const userId = req.user.id;
    const perfil = await getUserById(userId, 'foto_url, foto_hash, is_super_admin, created_at');
    if (!perfil?.foto_url) throw new HttpError(400, 'Adicione uma foto primeiro.');

    // Origem: só para log. O 'cadastro' do Onboarding DEIXOU DE EXISTIR
    // (SPEC-FIGURINHA-3 §3: o cadastro não gera nada) — se ainda chegar aqui,
    // vindo de um app antigo que não atualizou, cai no gate do direito como
    // qualquer outro e recebe 403 SEM_DIREITO. Fica registado para o Gabinete
    // ver quantos clientes velhos ainda tentam.
    const origem = req.body?.origem === 'cadastro' ? 'cadastro' : null;

    // --- DIREITO (§5): crédito comprado/presenteado, ou pacote do time. Só se
    // LÊ aqui (é o que decide o uniforme por omissão); o 403 vem depois do
    // slot-reuse, para quem já gerou poder voltar a vestir o que é seu mesmo
    // com o direito já gasto. ---
    const direito = await temDireito(userId);

    // --- KIT: quem tem crédito escolhe entre os 5; no pacote do time o
    // uniforme é o que o dono fixou, e um kit diferente do time só sai se a
    // pessoa TAMBÉM tiver crédito (aí é o crédito que paga). ---
    const kitPedido = String(req.body?.kit || direito.kitId || 'dark-gold');
    const kit = KITS_IA[kitPedido];
    if (!kit) throw new HttpError(400, 'Kit inexistente.');
    if (!kit.ativo) throw new HttpError(400, 'Kit ainda não disponível.');

    let direitoUsado = direito;
    let kitId = kitPedido;
    if (direito.fonte === 'time' && kitPedido !== direito.kitId) {
      const comCredito = direito.opcoes.find((o) => o.fonte === 'credito');
      if (comCredito) direitoUsado = { ...comCredito, creditos: direito.creditos, opcoes: direito.opcoes };
      else kitId = direito.kitId; // sem crédito, vale o uniforme do time
    }
    console.log('[avatar-ai] direito', { userId, fonte: direitoUsado.fonte, teamId: direitoUsado.teamId, kitId, creditos: direito.creditos });

    // --- IDEMPOTÊNCIA: se já existe slot deste kit E foi gerado da MESMA foto
    // atual, veste-o e NÃO gera nem gasta quota. (build 9, achado real: uma
    // foto NOVA não invalidava o slot — o motor servia o avatar da foto
    // ANTIGA como se fosse da nova. foto_fingerprint = foto_hash, migração 052,
    // guardada no slot no momento da geração; se alguma das duas faltar
    // (slot antigo, antes desta coluna, ou foto_hash ainda não gravado),
    // NÃO reutiliza — gera de novo é o lado seguro do erro.)
    const { data: slot } = await supabase
      .from('user_avatar_slots')
      .select('avatar_url, foto_fingerprint')
      .eq('user_id', userId)
      .eq('kit_id', kitId)
      .maybeSingle();
    const slotValeParaFotoAtual = !!slot?.avatar_url && !!slot?.foto_fingerprint && !!perfil.foto_hash && slot.foto_fingerprint === perfil.foto_hash;
    if (slotValeParaFotoAtual) {
      await ensureUserRow(req.user);
      const { error: vestirErr } = await supabase
        .from('users')
        .update({ avatar_url: slot.avatar_url, kit_ativo: kitId })
        .eq('id', userId);
      if (vestirErr) throw new HttpError(500, vestirErr.message);
      // Separado do update acima de propósito: figurinha_status vive numa coluna
      // nova (migração 051) e nunca pode derrubar o essencial (avatar_url/kit_ativo)
      // se ainda não tiver sido migrada.
      marcarFigurinhaStatus(userId, 'pronta');
      invalidarSessaoDoPedido(req); // RODADA 17 — nota completa no 'gerando' logo abaixo.
      console.log('[avatar-ai] slot reutilizado (sem geração, sem direito gasto):', { userId, kitId });
      return res.json({ avatar_url: slot.avatar_url, kit: kitId, do_slot: true, reutilizado: true });
    }

    // Daqui para baixo vai custar dinheiro de verdade: sem direito, para aqui.
    // (SPEC-FIGURINHA-3 §5. A mensagem é digna e diz o caminho — a pessoa não
    // fez nada de errado, só ainda não tem a figurinha.)
    if (!direitoUsado.fonte) {
      throw new HttpError(
        403,
        'Sua figurinha vem do pacote do time ou da Minha Figurinha. Peça a ativação na aba Figurinhas.',
        'SEM_DIREITO',
      );
    }

    // Figurinha automática (12-set): marca 'gerando' AQUI — depois de kit/plano/
    // slot-reuse/quota (validações de uso normal do endpoint, não específicas do
    // cadastro), mas ANTES do e-mail-gate. Motivo: no fluxo do Onboarding (fire-
    // and-forget logo após o upload), o e-mail-gate é o erro mais provável de
    // todos — quase toda conta nova via email+senha ainda não confirmou o e-mail
    // nesse instante — e o polling do Início precisa ver 'falhou' nesse caso, ou
    // fica preso mostrando "criando..." para sempre. Try/catch amplo a partir
    // daqui (não só ao redor da geração): qualquer gate reprovado também conta.
    await marcarFigurinhaStatus(userId, 'gerando');
    // RODADA 17 — invalida o cache de sessão (60s, middleware/auth.js) nas 4
    // marcações de figurinha_status (aqui e as 'pronta'/'falhou' mais abaixo).
    // Investigado antes de adicionar: HOJE isto não muda nada sozinho — esse
    // cache guarda o USER do Supabase Auth (id/email/user_metadata), nunca as
    // colunas de `users`, e obterMe() lê figurinha_status com uma query
    // própria e SEMPRE fresca (obterPerfilResiliente), sem cache nenhum por
    // cima. GET /api/me e /api/inicio já respondem "na hora" sem esta linha.
    // Fica mesmo assim por pedido explícito e por ser grátis: mesmo padrão já
    // usado para onboarding-completo/tour-visto (linhas ~237-278), e barato
    // o suficiente para não pesar a decisão — se um dia figurinha_status
    // entrar em req.user (ex.: um JWT custom claim), esta chamada já está no
    // sítio certo em vez de ser mais uma coisa a lembrar depois.
    invalidarSessaoDoPedido(req);

    try {
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
          throw new HttpError(503, 'Estamos com procura recorde. Tente de novo mais tarde.', 'TETO_DIARIO_ATINGIDO');
        }
      }
      // 3. AUTO-FREEZE — regra de ferro, só contas <48h (usuários reais não sentem).
      const freeze = await verificarFreeze(perfil.created_at);
      if (freeze.congelado) {
        throw new HttpError(503, 'Estamos com procura recorde. Tente de novo mais tarde.', 'TETO_DIARIO_ATINGIDO');
      }

    // ETAPA 0 — a foto que vai à IA (17-set, variante 6 da bancada): faixa de
    // 18% no topo + corte QUADRADO 1024×1024 com a cabeça a 12% do topo.
    // A receita vive em utils/entradaFigurinha.js e a bancada usa a MESMA.
    // Porquê quadrado: ganhou em 6 das 7 fotos (4,1/5 contra 4,0 do retrato) e
    // custa menos — a fal cobra os tokens da imagem de ENTRADA, e o quadrado
    // baixou a chamada de US$0,132 para US$0,112. A SAÍDA continua 1024×1536.
    // Upload no Supabase (URL assinado) em vez de data URI: é o formato de input
    // confirmado no schema do fal — não se arrisca uma geração paga noutro.
    // Tudo o que é temporário nesta geração (o pad e a imagem entre passadas)
    // fica aqui para ser apagado no fim — com nomes por versão, ninguém os
    // sobrescreve, portanto é a limpeza que tem de os levar.
    const temporarios = [];
    const caminhoFoto = caminhoNoBucket(perfil.foto_url, 'avatars');
    let inputUrl = caminhoFoto ? await assinarUrlAvatars(caminhoFoto) : perfil.foto_url;
    let formaEntrada = 'foto-crua';
    try {
      if (!caminhoFoto) throw new Error('foto_url não é um caminho do bucket avatars.');
      // download() autenticado (SDK) em vez de fetch(url pública) — o bucket é
      // PRIVADO (Tijolo 1C), um fetch simples do URL "público" devolve 400.
      // TRAVA ANTES DE GASTAR (22-set). A foto que se baixou tem de ser a que a
      // tabela diz ser a atual — senão a figurinha sairia da foto errada e o
      // dinheiro já estaria gasto quando alguém percebesse. Três tentativas com
      // 2 s de intervalo: se for atraso de propagação, passa; se for outra
      // coisa, ninguém paga por ela.
      //
      // Só corre quando há `foto_hash` gravado: contas antigas (antes da
      // migração 048) não têm, e barrá-las seria inventar um defeito.
      const fotoBuf = await baixarFotoConferida(caminhoFoto, perfil.foto_hash);
      // O quadrado é a receita de produção; se ele falhar (foto estranha, sharp a
      // recusar o corte), cai-se no retrato com faixa — NUNCA na foto crua, que
      // é o que fazia a IA comer a coroa da cabeça.
      let entradaBuf;
      try {
        entradaBuf = await preprocessarQuadrado(fotoBuf);
        formaEntrada = 'quadrada-1024';
      } catch (eq) {
        console.error('[avatar-ai] corte quadrado falhou, uso o retrato com faixa:', eq.message);
        entradaBuf = await preprocessarRetrato(fotoBuf);
        formaEntrada = 'retrato-faixa';
      }
      // Nome por versão também aqui: esta é a imagem que a fal vai BUSCAR por
      // URL. Um caminho reutilizado é a única peça do caminho que um cache
      // externo poderia servir velha — e a fal está do outro lado do mundo.
      const caminhoPad = `tmp/${userId}-${Date.now()}-pad.jpg`;
      temporarios.push(caminhoPad);
      const { error: padErr } = await supabase.storage.from('avatars').upload(caminhoPad, entradaBuf, {
        contentType: 'image/jpeg',
        upsert: true,
        cacheControl: '3600',
      });
      if (padErr) throw new Error(padErr.message);
      inputUrl = await assinarUrlAvatars(caminhoPad);
      console.log('[avatar-ai] etapa 0 - entrada pronta', { forma: formaEntrada, bytes: entradaBuf.length });
    } catch (e) {
      // A trava do hash (FOTO_DESATUALIZADA) é uma RECUSA, não uma falha de
      // preparação: tem de subir inteira até ao cliente. Cair para a foto crua
      // aqui seria gerar exactamente a figurinha errada que ela existe para
      // impedir — e cobrar por ela.
      if (e instanceof HttpError) throw e;
      console.error('[avatar-ai] etapa 0 falhou, usa foto original (assinada):', e.message);
    }
    // A RECEITA vive em utils/geracaoFigurinha.js — endpoints, qualidades e
    // fidelidade são constantes de lá, com override por ambiente. Esta rota
    // não decide mais nada sobre COMO se gera: só trata da foto, do kit, da
    // rede de segurança e do dinheiro.
    console.log('[avatar-ai] a chamar fal com:', {
      receita: RECEITA,
      ...(RECEITA === 'v6'
        ? { endpoint: V6_ENDPOINT, input_fidelity: FIDELIDADE_V6 }
        : { passada1: PASSADA1_ENDPOINT, passada2: PASSADA2_ENDPOINT, input_fidelity_passada2: FIDELIDADE_PASSADA2 }),
      kit: kitId,
      origem,
      fonte_do_direito: direitoUsado.fonte,
      prompt_length: promptFutty(kitId).length,
      quality: QUALIDADE,
      image_size: TAMANHO_1_5,
      entrada: formaEntrada,
    });

    // O DINHEIRO desta geração, somado de TODAS as tentativas: um retry por
    // cabeça cortada são DUAS passadas novas, e isso é dinheiro que tem de
    // aparecer no contador do dia. `parcelas` guarda quanto custou cada etapa,
    // para o log dizer de onde veio o total.
    const conta = { usd: 0, chamadas: 0, semHeader: 0, parcelas: {} };

    // A fal só lê URLs públicos. A imagem do meio (o jogador sobre o cinza,
    // entre as duas passadas) vai para o bucket privado `avatars` com URL
    // ASSINADO de vida curta — nunca para um bucket público, porque é a cara
    // do utilizador. É apagada no fim, dê no que der.
    const publicar = async (nomeFicheiro, buffer, tipo) => {
      const caminho = `tmp/${userId}-${Date.now()}-${nomeFicheiro}`;
      const { error } = await supabase.storage.from('avatars').upload(caminho, buffer, {
        contentType: tipo, upsert: true, cacheControl: '3600',
      });
      if (error) throw new Error(`upload do passo intermédio: ${error.message}`);
      temporarios.push(caminho);
      return assinarUrlAvatars(caminho);
    };

    // ETAPA 1+2 (retriáveis) — as duas passadas + birefnet → buffer recortado.
    const gerarERecortar = async () => {
      let saida;
      try {
        saida = await gerarFigurinha({
          fotoUrl: inputUrl,
          kitUrl: kit.url,
          kitId,
          publicar,
          etiqueta: 'fig',
        });
      } catch (err) {
        // SEGURANCA-REVISAO-10SET.md secção 3 (10-set): era logada a resposta
        // inteira do fal (body/response, que pode incluir o inputUrl assinado
        // enviado no pedido) — fica só o código de erro e a mensagem curta.
        console.error('[avatar-ai] erro fal:', { status: err.status, message: err.message });
        // fal não conseguiu DESCARREGAR/DECODIFICAR a foto de entrada (ficheiro
        // corrompido ou inacessível) — causa acionável (fotografia, não instabilidade
        // do serviço). Código próprio para o frontend distinguir sem depender do texto.
        let corpo = err.body;
        if (typeof corpo === 'string') { try { corpo = JSON.parse(corpo); } catch { corpo = null; } }
        // Bug corrigido (14-set): em 401/403 a fal devolve `detail` como STRING
        // ("Forbidden"), não array — .some() nessa string derrubava com
        // TypeError e escondia a causa real. Só chama .some() se for array.
        if (Array.isArray(corpo?.detail) && corpo.detail.some((d) => d.type === 'file_download_error')) {
          throw new HttpError(422, 'Sua foto não pôde ser processada. Tente enviar uma foto nova.', 'FOTO_INVALIDA');
        }
        // Chave inválida, conta sem permissão ou sem crédito na fal — falha do
        // MOTOR, não da foto do utilizador (não sugerir "tente outra foto").
        // ALERTA no log: precisa de ação humana (chave/plano fal), não é
        // instabilidade passageira.
        if ([401, 403, 402].includes(err.status)) {
          console.error('[avatar-ai] ALERTA: fal recusou', { status: err.status });
          throw new HttpError(503, 'A geração de figurinha está indisponível agora. Tente de novo mais tarde.', 'IA_INDISPONIVEL');
        }
        throw err;
      }

      // O custo desta tentativa entra na conta da geração (o retry soma por cima).
      conta.usd += saida.custo.usd;
      conta.chamadas += saida.custo.chamadas;
      conta.semHeader += saida.custo.semHeader;
      for (const [nome, p] of Object.entries(saida.custo.parcelas)) {
        conta.parcelas[nome] = (conta.parcelas[nome] || 0) + (p.usd || 0);
      }
      console.log(`[avatar-ai] ${saida.receita || RECEITA} OK`, {
        segundos: saida.tempos,
        custo_usd: Number(saida.custo.usd.toFixed(4)),
      });
      return { recorteBuffer: saida.recorteBuffer };
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
      throw new HttpError(422, 'Não conseguimos gerar uma figurinha à altura com esta foto. Tente outra: de frente e bem iluminada.', 'FIGURINHA_DEFEITUOSA');
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
    // Um ficheiro POR KIT E POR VERSÃO → os slots não se sobrepõem entre si, e
    // a figurinha nova não escreve por cima da velha (22-set). Sem upsert: o
    // carimbo de tempo torna colisão impossível, e se algum dia houvesse, o
    // certo é rebentar aqui em vez de apagar o trabalho de outra chamada.
    const caminho = caminhoFigurinhaNova(userId, kitId);
    const { error: upErr } = await supabase.storage.from('avatars').upload(caminho, buffer, {
      contentType: 'image/png',
      upsert: false,
      cacheControl: '3600',
    });
    if (upErr) throw new HttpError(500, upErr.message);

    const { data: pub } = supabase.storage.from('avatars').getPublicUrl(caminho);
    const avatarUrl = `${pub.publicUrl}?v=${Date.now()}`;

    // Guarda o SLOT deste kit (upsert por (user_id, kit_id)) → a próxima vez que o
    // utilizador pedir este kit COM A MESMA FOTO é servido do slot, sem gerar
    // nem gastar quota. foto_fingerprint = foto_hash atual (migração 052) —
    // é o que a checagem de reuso acima compara na próxima chamada.
    const { error: slotErr } = await supabase
      .from('user_avatar_slots')
      .upsert({ user_id: userId, kit_id: kitId, avatar_url: avatarUrl, foto_fingerprint: perfil.foto_hash || null }, { onConflict: 'user_id,kit_id' });
    if (slotErr) throw new HttpError(500, slotErr.message);

    // Persiste o novo avatar + kit vestido. A quota mensal por plano
    // (avatar_ia_mes/reset) saiu daqui na SPEC-FIGURINHA-3: quem manda agora é
    // o direito, e ele é debitado mais abaixo — depois de a figurinha existir.
    const dadosUpdate = { avatar_url: avatarUrl, kit_ativo: kitId };
    const { error: updErr } = await supabase.from('users').update(dadosUpdate).eq('id', userId);
    if (updErr) throw new HttpError(500, updErr.message);
    // Separado do update acima de propósito (ver nota no slot-reuse, mais acima).
    marcarFigurinhaStatus(userId, 'pronta');
    invalidarSessaoDoPedido(req); // RODADA 17 — nota completa no 'gerando', mais acima.

    // A figurinha anterior DESTE kit já não é apontada por ninguém (o slot e o
    // users.avatar_url acabaram de mudar) — sai do bucket. Só agora, depois de
    // os dois updates terem passado: se apagasse antes e o update falhasse, o
    // utilizador ficava com um avatar_url a apontar para o nada.
    const figurinhaAntiga = caminhoNoBucket(slot?.avatar_url, 'avatars');
    if (figurinhaAntiga && figurinhaAntiga !== caminho) {
      await apagarAntigo(figurinhaAntiga, `figurinha ${kitId} regerada`);
    }

    // Pacote anti-abuso (11-ago): soma o gasto do dia, guarda o log de IP e
    // dispara alertas/auto-freeze se algum sinal bater. Fire-and-forget (nunca
    // derruba a resposta — a figurinha já foi entregue ao utilizador).
    // 17-set: vai o custo REAL em cêntimos, somado de todas as chamadas desta
    // geração (retry incluído). `null` só quando a fal não mandou header nenhum
    // — nesse caso quem decide o valor é o antiAbusoIA, não este sítio.
    const custoCents = conta.semHeader === conta.chamadas ? null : conta.usd * 100;
    console.log('[avatar-ai] custo da geração', {
      chamadas: conta.chamadas,
      sem_header: conta.semHeader,
      custo_usd: Number(conta.usd.toFixed(4)),
      // De onde veio o total: se um dia a conta disparar, é aqui que se vê qual
      // das quatro chamadas mudou de preço.
      parcelas: Object.fromEntries(Object.entries(conta.parcelas).map(([k, v]) => [k, Number(v.toFixed(4))])),
    });
    registrarGeracao({ userId, ip: req.ip, custoCents }).catch(() => {});

    // DEBITA O DIREITO — só AGORA, com a figurinha gravada e entregue
    // (SPEC-FIGURINHA-3 §5). Uma geração que falhou a meio (fal fora do ar,
    // coroa cortada nas duas tentativas, foto desatualizada) nunca chega
    // aqui, e por isso nunca custa o crédito de ninguém. `await` de propósito:
    // a resposta só sai depois de o débito estar decidido, senão um toque
    // rápido em "Gerar" duas vezes gastaria um direito e cobraria dois.
    await debitar(direitoUsado, { userId, kitId, avatarUrl, custoCents });

    // A imagem do meio (o jogador sobre o cinza, entre as duas passadas) é a
    // cara do utilizador num ficheiro temporário: sai daqui assim que a
    // figurinha está entregue. Fire-and-forget — falhar a limpeza não pode
    // derrubar a resposta, e o pior caso é um ficheiro a mais no tmp/.
    if (temporarios.length) {
      supabase.storage.from('avatars').remove(temporarios)
        .catch((e) => console.error('[avatar-ai] limpeza do tmp falhou:', e.message));
    }

    res.json({ avatar_url: avatarUrl, kit: kitId, do_slot: false, reutilizado: false });
    } catch (err) {
      // Qualquer falha a partir do e-mail-gate (inclusive) até aqui → 'falhou',
      // para o polling do Início parar de mostrar "criando..." e oferecer nova
      // foto. Ver nota no início do try: o e-mail-gate é o caso mais provável
      // no fluxo do cadastro.
      await marcarFigurinhaStatus(userId, 'falhou');
      invalidarSessaoDoPedido(req); // RODADA 17 — nota completa no 'gerando', mais acima.
      throw err;
    }
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

    // ACHADO DA VARREDURA (22-set): esta rota só veste o que JÁ existe num slot
    // — nunca gera nada, nunca custa direito. O gate de `plan` que havia aqui
    // era do modelo Free/Pro/Elite (aposentado na SPEC-FIGURINHA-3) e, como
    // ninguém mais tem `plan` diferente de 'free', barrava QUALQUER kit que não
    // fosse o dark-gold para todo mundo — mesmo para quem já tinha aquela
    // Brilhante gerada e só queria voltar a vesti-la. O direito de gerar já foi
    // gasto quando o slot nasceu; vestir de novo é livre, sempre.
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

/**
 * PUT /api/me/avatar/modo { modo: 'foto' | 'figurinha' } — Rodada 18: quem
 * tem figurinha (IA) escolhe o que o card mostra. 'foto' põe avatar_url =
 * foto_url (a figurinha continua no slot, nada é apagado); 'figurinha' repõe
 * o slot do kit ativo (ou outro já gerado, se o ativo não tiver um). Só quem
 * tem pelo menos um slot pode escolher 'figurinha'. A escolha fica em
 * users.card_modo (migração 056, fail-safe) para sobreviver à próxima troca
 * de foto — ver o `modoFoto` em POST /api/me/avatar, acima.
 */
router.put(
  '/api/me/avatar/modo',
  requireAuth,
  asyncHandler(async (req, res) => {
    const modo = req.body?.modo;
    if (modo !== 'foto' && modo !== 'figurinha') {
      throw new HttpError(400, 'modo precisa ser "foto" ou "figurinha".', 'MODO_INVALIDO');
    }

    const userId = req.user.id;
    const perfil = await getUserById(userId, 'foto_url, avatar_url, kit_ativo');
    if (!perfil?.foto_url) throw new HttpError(400, 'Adicione uma foto primeiro.');

    let novoAvatarUrl;
    if (modo === 'foto') {
      novoAvatarUrl = perfil.foto_url;
    } else {
      // O slot do kit ativo primeiro; se não houver (kit_ativo nulo, ou sem
      // slot gravado para ele), qualquer outro slot já gerado.
      // user_avatar_slots não tem carimbo de tempo (tabela sem migração
      // commitada — nota na 052), então "o mais recente" aqui é best-effort:
      // sem um kit ativo com slot, pegamos QUALQUER slot da pessoa, não
      // necessariamente o último gerado.
      let slotUrl = null;
      if (perfil.kit_ativo) {
        const { data: slotAtivo, error: erroSlot } = await supabase
          .from('user_avatar_slots')
          .select('avatar_url')
          .eq('user_id', userId)
          .eq('kit_id', perfil.kit_ativo)
          .maybeSingle();
        if (erroSlot) throw new HttpError(500, erroSlot.message);
        slotUrl = slotAtivo?.avatar_url || null;
      }
      if (!slotUrl) {
        const { data: outroSlot, error: erroOutro } = await supabase
          .from('user_avatar_slots')
          .select('avatar_url')
          .eq('user_id', userId)
          .limit(1)
          .maybeSingle();
        if (erroOutro) throw new HttpError(500, erroOutro.message);
        slotUrl = outroSlot?.avatar_url || null;
      }
      if (!slotUrl) throw new HttpError(400, 'Você ainda não tem uma figurinha gerada.', 'SEM_SLOT');
      novoAvatarUrl = slotUrl;
    }

    await ensureUserRow(req.user);
    const { error: erroAvatar } = await supabase.from('users').update({ avatar_url: novoAvatarUrl }).eq('id', userId);
    if (erroAvatar) throw new HttpError(500, erroAvatar.message);

    // card_modo é best-effort (migração 056): a troca do card já valeu acima
    // mesmo que isto falhe — só a persistência para a PRÓXIMA foto se perde
    // (POST /api/me/avatar cai no comportamento antigo sem ela).
    try {
      const { error: erroModo } = await supabase.from('users').update({ card_modo: modo }).eq('id', userId);
      if (erroModo) throw new Error(erroModo.message);
    } catch (e) {
      if (!ehMigracaoEmFalta(e.message)) throw e;
      console.warn('[avatar/modo] card_modo indisponível (migração 056 aplicada?):', e.message);
    }

    invalidarSessaoDoPedido(req);
    res.json({ avatar_url: novoAvatarUrl, modo });
  })
);

// O catálogo de kits é daqui (é esta rota que valida `ativo` antes de gerar).
// O Gabinete precisa da mesma lista para o dono escolher o uniforme do pacote
// do time — pendurado no router como o enviarNotificacao de routes/push.js,
// para não haver uma segunda lista a envelhecer sozinha.
router.KITS_IA = KITS_IA;

module.exports = router;
