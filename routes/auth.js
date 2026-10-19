// Futty v2.0 — Rotas de autenticação / usuário.
// (O login/registo é feito no frontend via Supabase Auth; aqui expomos o perfil.)
const express = require('express');
const { requireAuth, invalidarSessaoDoPedido } = require('../middleware/auth');
const { marcarFase } = require('../middleware/tempo');
const { excluirContaLimiter } = require('../middleware/limiters');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, ensureUserRow, getUserById } = require('../utils/db');
const { obterMe } = require('../services/inicio');
const { avatarEhFigurinhaNossa } = require('../utils/figurinhaRegra');
const { apagarUsuario } = require('../utils/apagarUsuario');
const { dataDeNascimentoValida, menorQueIdadeMinima, MSG_MENOR } = require('../utils/idade');
const { KITS_IA } = require('../utils/kitsIa');
const { arquivarFigurinhaAntiga, TETO_HISTORICO_FIGURINHAS } = require('../services/fotoDoAvatar');

const router = express.Router();

// Cores de uniforme válidas (igual ao CHECK da migração 013).
const CORES_UNIFORME = ['verde', 'azul', 'vermelho', 'preto', 'amarelo', 'cinzento'];
// Preferências da figurinha (igual aos CHECKs da migração 018).
const CORES_FRAME = ['dourado', 'verde', 'roxo', 'branco'];
const FUNDOS_FIGURINHA = ['estadio', 'gradiente', 'aura', 'preto', 'golden', 'royal'];
// Avatar genérico escolhido (migração 044) — masc m1-m3, fem f1-f3. NULL = rodízio.
const AVATARES_GENERICOS = ['m1', 'm2', 'm3', 'f1', 'f2', 'f3'];
// Fundos PREMIUM: GOLDEN, AURA e ROYAL. ÉPICO ('gradiente', chave interna) é
// GRÁTIS (decisão do dono) — fora desta lista de propósito.
//
// LEI DA REGRA JUSTA (sem punição retroativa): o gate só corre AQUI, no PATCH
// que TROCA fundo_figurinha — nunca em leitura (GET /api/me) nem no render.
// Quem já tinha Aura equipado antes deste gate MANTÉM (a coluna já gravada
// nunca é revalidada até o próprio usuário mexer nela). Só ao tentar
// EQUIPAR de novo (depois de trocar pra outro fundo) é que o direito volta a
// ser exigido — ninguém perde o que já tinha, mas ninguém re-adquire de graça.
// Ver Figurinha.jsx `escolherFundo` (o `if (k === fundo) return` early-return
// é o que preserva isto: reabrir a mesma página nunca reenvia o PATCH do
// fundo já equipado).
//
// (SPEC-FIGURINHA-3) Estes 3 fundos vêm com a BRILHANTE, não com um
// plano — o gate é DIREITO (ter avatar_url ≠ foto_url), super-admin
// sempre passa. Lista de ids, não um mapa de planos.
const FUNDOS_PREMIUM = ['golden', 'aura', 'royal'];
// MORTO desde 22-set (SPEC-FIGURINHA-3): quem manda na geração é o DIREITO
// (utils/direitoBrilhante.js), não o plano. Nada lê esta tabela — nem esta rota,
// nem o Gabinete. Fica só como registro do modelo antigo (grátis 2 / Pro 10 /
// Elite 20 por mês) até a limpeza que também apaga users.avatar_ia_mes/_reset e
// tira `plan` das telas. Não voltar a ligar sem decisão do dono.
// eslint-disable-next-line no-unused-vars
const LIMITES_IA_APOSENTADO = { free: 2, pro: 10, elite: 20 };
// Colunas de perfil devolvidas ao frontend.
// mostrar_rosto_publico (migração 040) e avatar_generico (migração 044) —
// juntas aqui em vez de 2 consultas extra por /api/me.
const PERFIL_COLS =
  'id, nome, email, avatar_url, foto_url, nome_jogador, cor_preferida, telefone, avatar_ia_creditos, cor_frame, fundo_figurinha, plan, avatar_ia_mes, avatar_ia_reset, is_super_admin, birthdate, kit_ativo, mostrar_rosto_publico, avatar_generico';

// O Futty é para quem tem 13 anos ou mais (IDADE_MINIMA, utils/idade.js). "Cadastro em curso" = o
// onboarding dia-1 ainda não foi concluído: é aí que a data chega (e-mail: no formulário; Google/Apple:
// no passo "Quando você nasceu?"). Contas que já existiam (onboarding concluído) o motor não apaga:
// com data abaixo da idade mínima, o app mostra a tela com "Excluir minha conta".
function cadastroEmCurso(user) {
  return user?.user_metadata?.onboarding_completo !== true;
}

// Abaixo da idade mínima no cadastro: a conta que o Google/Apple (ou um cadastro forçado) acabou de criar não
// fica — apaga-se tudo o que ela tiver (em geral nada além da linha e, talvez, uma foto) e a sessão
// deixa de valer na hora.
async function recusarMenor(req) {
  console.log('[cadastro] abaixo da idade mínima no cadastro: conta apagada', { userId: req.user.id });
  await apagarUsuario(req.user.id);
  invalidarSessaoDoPedido(req);
  throw new HttpError(403, MSG_MENOR, 'MENOR_DE_IDADE');
}

/**
 * GET /api/me — devolve o usuário autenticado + stats agregadas.
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
 * PATCH /api/me — atualiza o perfil do usuário (só os campos enviados).
 * Body (todos opcionais): nome, nome_jogador, cor_preferida, fundo_figurinha, avatar_generico, birthdate… (avatar_url só aceita null, para limpar).
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
    // O avatar nunca vem do corpo: quem o grava é o upload da foto, a geração da figurinha e a escolha no histórico (cada um com um arquivo
    // NOSSO e DA PRÓPRIA pessoa). Um endereço qualquer aqui destrancava os fundos pagos (basta o nome parecer uma figurinha), mandava a
    // exclusão da conta apagar o arquivo de outra pessoa e deixava o "Ajustar enquadramento" mexer na miniatura dela. Só limpar vale.
    if ('avatar_url' in b && (b.avatar_url === null || b.avatar_url === '')) patch.avatar_url = null;
    // telefone removido: já não é guardado pelo perfil.
    if ('cor_frame' in b) {
      const v = String(b.cor_frame);
      if (!CORES_FRAME.includes(v)) throw new HttpError(400, 'Cor de frame inválida.');
      patch.cor_frame = v;
    }
    if ('fundo_figurinha' in b) {
      const v = String(b.fundo_figurinha);
      if (!FUNDOS_FIGURINHA.includes(v)) throw new HttpError(400, 'Fundo de figurinha inválido.');
      // GATE (servidor é a fonte da verdade — sem truque de frontend). SPEC-FIGURINHA-3
      // §4/§9: os 3 fundos de cima vêm COM a Brilhante, não por PLANO (os planos saíram
      // das telas: um membro do pacote não pode ver o Aura trancado no card que o time
      // tinha acabado de pagar). Quem não tem Brilhante não tem sequer seletor de fundo
      // — este gate é a defesa em profundidade para um pedido montado à mão.
      if (FUNDOS_PREMIUM.includes(v)) {
        // O avatar ser uma figurinha NOSSA (utils/figurinhaRegra.js), não "≠ foto_url":
        // a foto do Google, que o trigger 001 copiava, não abre os fundos pagos.
        const perfil = await getUserById(req.user.id, 'avatar_url, is_super_admin');
        const temBrilhante = avatarEhFigurinhaNossa(perfil?.avatar_url);
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
    // Data de nascimento (pedido único do Início a quem não a tem; e o passo
    // "Quando você nasceu?" do onboarding de quem entrou com Google/Apple). SET-ONCE: se já
    // existir, não deixa mudar (evita a passagem trivial menor→adulto).
    if ('birthdate' in b) {
      const bruto = b.birthdate == null || b.birthdate === '' ? null : String(b.birthdate).slice(0, 10);
      if (bruto) {
        const v = dataDeNascimentoValida(bruto);
        if (!v) throw new HttpError(400, 'Data de nascimento inválida.');
        const atual = await getUserById(req.user.id, 'birthdate');
        if (atual && atual.birthdate) throw new HttpError(400, 'A data de nascimento já está definida.', 'NASCIMENTO_JA_DEFINIDO');
        // No cadastro, abaixo da idade mínima não fica com conta.
        if (cadastroEmCurso(req.user) && menorQueIdadeMinima(v)) await recusarMenor(req);
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
    // A data do cadastro por e-mail (metadata → users.birthdate) ou a do
    // passo do onboarding. Abaixo da idade mínima: a conta não fica. Sem data nenhuma a conclusão passa — o
    // app da loja que ainda não tem o passo (iOS 33, Android 15) não pode ficar preso aqui; o app
    // novo não deixa concluir sem ela. Quando só houver builds novos nas lojas, exigir aqui.
    const perfilIdade = await getUserById(req.user.id, 'birthdate');
    const nascimento = perfilIdade?.birthdate || req.user.user_metadata?.birthdate || null;
    if (cadastroEmCurso(req.user) && menorQueIdadeMinima(nascimento)) await recusarMenor(req);

    const meta = { ...(req.user.user_metadata || {}), onboarding_completo: true };
    const { error } = await supabase.auth.admin.updateUserById(req.user.id, { user_metadata: meta });
    if (error) throw new HttpError(500, error.message);
    // Sem isto, o req.user cacheado (middleware/auth.js, TTL 60s) continuava a
    // devolver onboarding_completo:false ao GET /api/me seguinte — o
    // OnboardingGate do frontend mandava de volta para /onboarding em loop
    // (só aparecia em quem pulava a foto, porque esse caminho é
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

// As rotas da foto e da figurinha (POST /api/me/avatar em diante) vivem em routes/avatar.js, montadas AQUI para a ordem das
// rotas não mudar.
router.use(require('./avatar'));

// O catálogo de kits (utils/kitsIa.js; routes/avatar.js valida `ativo` antes de gerar).
// O Gabinete precisa da mesma lista para o dono escolher o uniforme do pacote
// do time — pendurado no router como o enviarNotificacao de routes/push.js,
// para não haver uma segunda lista a envelhecer sozinha.
router.KITS_IA = KITS_IA;
// Testável sem chamar a fal (custaria dinheiro de verdade): os
// testes de user_avatar_historico chamam arquivarFigurinhaAntiga() direto.
router.arquivarFigurinhaAntiga = arquivarFigurinhaAntiga;
router.TETO_HISTORICO_FIGURINHAS = TETO_HISTORICO_FIGURINHAS;

module.exports = router;
