// Futty v2.0 — Rotas da foto e da figurinha: upload e recorte da foto, gerar a figurinha (e o pedido interno do Cloud Tasks que pinta),
// vestir um kit já gerado, o modo do card, o histórico de figurinhas e o enquadramento da miniatura. Montadas por routes/auth.js.
const express = require('express');
const { requireAuth, invalidarSessaoDoPedido } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase, ensureUserRow, getUserById } = require('../utils/db');
const { marcarFigurinhaStatus } = require('../services/inicio');
const { avatarEhFigurinhaNossa, devePreservarAvatar } = require('../utils/figurinhaRegra');
const { filtroNSFW } = require('../utils/nsfwFilter');
const { olheiroEntrada } = require('../utils/olheiroEntrada');
const { sha256Hex, verificarTeto, verificarFreeze } = require('../utils/antiAbusoIA');
// Quem pode gerar uma Brilhante (SPEC-FIGURINHA-3, §5). Toda geração nasce paga:
// crédito comprado/presenteado ou pacote do time.
const { temDireito, ehMigracaoEmFalta } = require('../utils/direitoBrilhante');
// A pintura roda em segundo plano, numa fila em memória (uma por vez por pessoa).
const geracaoJobs = require('../utils/geracaoJobs');
// Bloco 2-A2: com o Cloud Tasks ligado, quem pinta é o pedido da tarefa (POST /api/interno/pintar/:jobId), não a CPU ociosa.
const tarefasPintura = require('../utils/tarefasPintura');
// O enquadramento da miniatura (PUT/DELETE /api/me/avatar/enquadro).
const { validarRecorte } = require('../utils/recorteAvatar');
const recortesAvatar = require('../utils/recortesAvatar');
const { parseUrlPublico } = require('../utils/storage');
const { KITS_IA } = require('../utils/kitsIa');
const { receberAvatar, receberRecorte, AVATAR_MIME } = require('../middleware/uploadDoAvatar');
// Os arquivos do avatar e a pintura da figurinha vivem em services/ (a rota só decide e responde).
const {
  caminhoFotoNovo, caminhoFotoOriginalNovo, lerEstadoDoAvatar, apagarAntigo, faxinaDaFotoNova, garantirFotoHash, fotoEstaRecusada, MSG_FOTO_RECUSADA,
  TETO_HISTORICO_FIGURINHAS,
} = require('../services/fotoDoAvatar');
const {
  pintarFigurinha, resolverDireitoEKit, avisarQuePintou, respostaDePinturaEmCurso, pintarDaTarefa,
} = require('../services/pinturaFigurinha');

const router = express.Router();

/**
 * POST /api/me/avatar — upload da foto de perfil (multipart, campo "avatar";
 * opcional "original" — a foto ANTES do recorte 2:3, guardada para
 * "Ajustar enquadramento" reabrir sem perder área/qualidade).
 * Vai para o Supabase Storage (bucket "avatars", caminho
 * `public/{userId}-{carimbo}.{ext}`) e guarda o URL em users.foto_url — e o
 * sha256 dos bytes em users.foto_hash, no MESMO update. Cada foto é um objeto
 * NOVO; a anterior é apagada depois de o banco estar gravado.
 */
router.post(
  '/api/me/avatar',
  requireAuth,
  receberAvatar,
  filtroNSFW, // bloqueia imagem explícita antes de guardar (avatar + onboarding)
  olheiroEntrada, // barra foto sem futuro (pequena/corrompida/preta/estourada) antes de guardar
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, 'Nenhuma imagem enviada (campo "avatar").');
    const ext = AVATAR_MIME[file.mimetype];
    if (!ext) throw new HttpError(400, 'Formato de imagem não suportado.');
    // A original (se vier) segue o mesmo formato aceite — sem campo próprio de
    // validação: já passou pelo mesmo fileFilter do multer (AVATAR_MIME).
    const original = req.fileOriginal;
    const extOriginal = original ? AVATAR_MIME[original.mimetype] : null;

    const userId = req.user.id;
    // 1. Ficheiro recebido (multer).
    console.log('[avatar] ficheiro recebido:', { userId, mimetype: file.mimetype, ext, size: file.size, comOriginal: !!original });

    await ensureUserRow(req.user);

    // Nome POR VERSÃO: cada foto é um objeto novo. Ver a nota em
    // `caminhoFotoNovo` — caminho que muda de conteúdo é caminho que alguém,
    // algures, serve desactualizado. A original leva um caminho PRÓPRIO
    // (sufixo "-original"), nunca confundível com o recorte.
    const caminho = caminhoFotoNovo(userId, ext);
    const caminhoOriginal = original && extOriginal ? caminhoFotoOriginalNovo(userId, extOriginal) : null;
    console.log('[avatar] upload p/ Storage:', { bucket: 'avatars', caminho, caminhoOriginal });

    // Gravar o recorte, gravar a original (opcional) e ler o estado atual da
    // pessoa saem JUNTOS: são três idas ao Supabase e nenhuma depende das outras (em série, a
    // rota levava seis a sete idas até responder; ver o resto depois do res.json). Sem upsert:
    // o carimbo de tempo já torna o nome único, e se por absurdo colidisse, o certo é falhar
    // aqui em vez de escrever por cima do objeto de outra chamada.
    const gravar = (destino, arquivo) => supabase.storage.from('avatars').upload(destino, arquivo.buffer, {
      contentType: arquivo.mimetype,
      upsert: false,
      cacheControl: '3600',
    });
    const [upRecorte, upOriginal, atual] = await Promise.all([
      gravar(caminho, file),
      caminhoOriginal ? gravar(caminhoOriginal, original) : Promise.resolve(null),
      lerEstadoDoAvatar(userId),
    ]);
    if (upRecorte.error) {
      console.error('[avatar] erro no upload:', upRecorte.error.message);
      // A original subiu junto e, sem recorte, não serve a ninguém.
      if (caminhoOriginal && !upOriginal?.error) apagarAntigo(caminhoOriginal, 'original sem recorte');
      throw new HttpError(500, upRecorte.error.message);
    }
    // A original é um "nice to have" (Ajustar enquadramento cai no fallback sem ela) — falhar o
    // upload dela não pode derrubar o recorte, que já está gravado no Storage e é o que o card
    // usa. E foto_original_url só aponta para ela se ela existe: antes apontava para um objeto
    // que não tinha subido, e o "Ajustar enquadramento" abria com erro.
    const originalGravada = !!caminhoOriginal && !upOriginal?.error;
    if (upOriginal?.error) console.error('[avatar] upload da original falhou (segue sem ela):', upOriginal.error.message);

    const { data: pub } = supabase.storage.from('avatars').getPublicUrl(caminho);
    // O ?v= já não é o que garante a atualização (o caminho é novo a cada
    // foto), mas fica: é o que distingue versões no proxy de mídia, que usa o
    // `v` na chave de cache dos derivados.
    const avatarUrl = `${pub.publicUrl}?v=${Date.now()}`;
    const originalUrl = originalGravada
      ? `${supabase.storage.from('avatars').getPublicUrl(caminhoOriginal).data.publicUrl}?v=${Date.now()}`
      : null;
    // URL público — deve usar o domínio do Supabase, não localhost.
    console.log('[avatar] URL público:', avatarUrl);

    // 3. UPDATE na tabela users. foto_url = a nova foto (fonte da geração IA).
    //    avatar_url (o que o card mostra): no modo 'foto' (users.card_modo,
    //    migração 056) segue sempre a foto nova, mesmo
    //    havendo figurinha — é a escolha explícita da pessoa. Nos demais
    //    casos (modo 'figurinha' ou ainda sem escolha) SÓ é preservado se o
    //    avatar atual for mesmo uma figurinha nossa (utils/figurinhaRegra.js);
    //    aí o card continua a mostrá-la até a pessoa gerar de novo (nunca a
    //    foto crua) — comportamento de sempre, mantido como fail-safe se a 056
    //    ainda não tiver corrido. Sem figurinha, avatar_url vira a foto nova,
    //    sempre. (Não se decide por avatar_url ≠ foto_url: a foto do Google
    //    copiada pelo trigger contava como figurinha, a foto nova ia
    //    para foto_url e o card nunca mudava.)
    const modoFoto = atual?.card_modo === 'foto';
    const preservar = devePreservarAvatar({ avatarUrlAtual: atual?.avatar_url, cardModo: atual?.card_modo });
    const novoAvatarUrl = preservar ? atual.avatar_url : avatarUrl;
    console.log('[avatar] UPDATE users:', { userId, preservar, modoFoto });

    // O HASH VAI NO MESMO UPDATE que o URL. Num update próprio, a
    // seguir, abriria uma janela de milissegundos em
    // que `foto_url` já seria a foto NOVA e `foto_hash` ainda o da ANTIGA.
    // Quem pedisse figurinha dentro dessa janela cairia no reuso de slot — que
    // compara o fingerprint do slot com o `foto_hash` — e receberia a figurinha
    // velha de volta. Uma linha só fecha a janela: ou grava tudo, ou nada.
    // foto_original_url só entra no patch quando há original nova — sem ela,
    // uma original antiga (se houver) fica exatamente como está.
    const patchFoto = { foto_url: avatarUrl, avatar_url: novoAvatarUrl, foto_hash: sha256Hex(file.buffer) };
    if (originalUrl) patchFoto.foto_original_url = originalUrl;
    let { error: updErr } = await supabase.from('users').update(patchFoto).eq('id', userId);
    if (updErr && /foto_hash/i.test(updErr.message || '')) {
      // Migração 048 por correr: grava o resto, avisa, e segue. O anti-abuso
      // perde um sinal; o upload não pode cair por causa disso.
      console.error('[avatar] foto_hash não existe nesta base (migração 048 por correr?) — gravo sem ele');
      delete patchFoto.foto_hash;
      ({ error: updErr } = await supabase.from('users').update(patchFoto).eq('id', userId));
    }
    if (updErr && /foto_original_url/i.test(updErr.message || '')) {
      // Migração 057 por correr: idêntico ao caso do foto_hash acima — grava
      // o recorte, que é o que o card usa; a original fica só no Storage
      // (órfã, mas inofensiva) até a migração correr e a próxima foto gravar
      // o campo direito.
      console.error('[avatar] foto_original_url não existe nesta base (migração 057 por correr?) — gravo sem ele');
      delete patchFoto.foto_original_url;
      ({ error: updErr } = await supabase.from('users').update(patchFoto).eq('id', userId));
    }
    if (updErr) {
      console.error('[avatar] erro no UPDATE:', updErr.message);
      throw new HttpError(500, updErr.message);
    }

    // A FIGURINHA COMUM FICA PRONTA AQUI (SPEC-FIGURINHA-3 §3): ela é a foto na
    // moldura — assim que há foto, não há nada a esperar. O 'gerando' passa a
    // existir só para a Brilhante. Sem isto, quem trocasse a foto logo depois
    // de uma Brilhante falhada ficava preso no "não deu certo" do Início.
    // Best-effort (coluna da migração 051): nunca derruba o upload. Sai ANTES da
    // resposta (sem esperar por ela): quem relê o /api/me a seguir já vê 'pronta'.
    marcarFigurinhaStatus(userId, 'pronta');

    console.log('[avatar] concluído:', { userId, preservouAvatarIA: preservar, modoFoto, comOriginal: !!originalUrl });
    // figurinha_ativa: o que o card mostra agora, pela regra única — as telas não comparam URLs.
    res.json({ foto_url: avatarUrl, avatar_url: novoAvatarUrl, foto_original_url: originalUrl || atual?.foto_original_url || null, figurinha_ativa: avatarEhFigurinhaNossa(novoAvatarUrl) });

    // A pessoa já tem o que precisa; o resto é faxina e adiantamento.
    faxinaDaFotoNova({ atual, caminho, caminhoOriginal, originalUrl, novoAvatarUrl, avatarUrl, buffer: file.buffer, tipo: file.mimetype, motivoAntiga: 'foto substituída' });
  })
);

/**
 * PUT /api/me/avatar/recorte — "Ajustar enquadramento" regrava só
 * o recorte 2:3 (multipart, campo "recorte"), sem tocar em foto_original_url.
 * O CropModal (cliente) já reabriu sobre a foto original guardada — ou, sem
 * ela (foto antiga, fail-safe), sobre o recorte atual — e manda aqui só o
 * resultado. A TRAVA DE HASH é a do recorte novo: é ele que a
 * geração de figurinha usa.
 */
router.put(
  '/api/me/avatar/recorte',
  requireAuth,
  receberRecorte,
  filtroNSFW,
  olheiroEntrada,
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, 'Nenhuma imagem enviada (campo "recorte").');
    const ext = AVATAR_MIME[file.mimetype];
    if (!ext) throw new HttpError(400, 'Formato de imagem não suportado.');

    const userId = req.user.id;
    await ensureUserRow(req.user);

    // Ler o estado e gravar o recorte novo saem juntos (não dependem um do outro).
    // Sem foto, não há o que reenquadrar: o objeto que subiu à toa é apagado.
    const caminho = caminhoFotoNovo(userId, ext);
    const [atual, upRecorte] = await Promise.all([
      lerEstadoDoAvatar(userId, { comOriginal: false }),
      supabase.storage.from('avatars').upload(caminho, file.buffer, { contentType: file.mimetype, upsert: false, cacheControl: '3600' }),
    ]);
    if (!atual?.foto_url) {
      if (!upRecorte.error) apagarAntigo(caminho, 'recorte sem foto');
      throw new HttpError(400, 'Adicione uma foto primeiro.');
    }
    if (upRecorte.error) throw new HttpError(500, upRecorte.error.message);

    const { data: pub } = supabase.storage.from('avatars').getPublicUrl(caminho);
    const avatarUrl = `${pub.publicUrl}?v=${Date.now()}`;

    // Mesma regra do POST /api/me/avatar: reenquadrar é "uma foto nova" para
    // efeito de quem manda no card (card_modo e figurinha nossa) — não é um
    // jeito separado de decidir isso.
    const preservar = devePreservarAvatar({ avatarUrlAtual: atual.avatar_url, cardModo: atual.card_modo });
    const novoAvatarUrl = preservar ? atual.avatar_url : avatarUrl;

    const patchFoto = { foto_url: avatarUrl, avatar_url: novoAvatarUrl, foto_hash: sha256Hex(file.buffer) };
    let { error: updErr } = await supabase.from('users').update(patchFoto).eq('id', userId);
    if (updErr && /foto_hash/i.test(updErr.message || '')) {
      delete patchFoto.foto_hash;
      ({ error: updErr } = await supabase.from('users').update(patchFoto).eq('id', userId));
    }
    if (updErr) throw new HttpError(500, updErr.message);

    marcarFigurinhaStatus(userId, 'pronta');
    console.log('[avatar-recorte] concluído:', { userId, preservouAvatarIA: preservar });
    res.json({ foto_url: avatarUrl, avatar_url: novoAvatarUrl, figurinha_ativa: avatarEhFigurinhaNossa(novoAvatarUrl) });

    // A foto anterior sai e os derivados da nova ficam prontos DEPOIS da resposta.
    faxinaDaFotoNova({ atual, caminho, caminhoOriginal: null, originalUrl: null, novoAvatarUrl, avatarUrl, buffer: file.buffer, tipo: file.mimetype });
  })
);

/**
 * POST /api/me/avatar/ai — gera a Figurinha BRILHANTE a partir da foto atual
 * (receita V6 por omissão, ver utils/geracaoFigurinha.js) e guarda em
 * avatars/public/{userId}-ai-{kit}-{carimbo}.png, separada da foto real.
 *
 * SPEC-FIGURINHA-3: toda geração nasce PAGA. Sem direito (crédito ou
 * pacote do time) → 403 SEM_DIREITO. `LIMITES_IA` por plano e
 * `users.avatar_ia_mes` deixaram de mandar aqui — a figurinha grátis é a
 * COMUM (a foto na moldura), que não passa por esta rota nem custa nada.
 */
router.post(
  '/api/me/avatar/ai',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!process.env.FAL_KEY) throw new HttpError(500, 'A geração de figurinha está indisponível agora. Tente de novo mais tarde.');

    const userId = req.user.id;
    const perfil = await getUserById(userId, 'foto_url, foto_hash, is_super_admin, created_at');
    if (!perfil?.foto_url) throw new HttpError(400, 'Adicione uma foto primeiro.');

    // Uma pintura por vez por pessoa: quem já está pintando acompanha a que existe,
    // não abre uma segunda (e não se debita duas vezes). Antes do slot-reuse de propósito.
    const assincrono = req.body?.assincrono === true;
    const emCurso = await geracaoJobs.emCursoDoUsuario(userId);
    if (emCurso) return respostaDePinturaEmCurso(res, emCurso.id, emCurso.estimativaSegundos, assincrono);

    // Origem: só para log. O 'cadastro' do Onboarding DEIXOU DE EXISTIR
    // (SPEC-FIGURINHA-3 §3: o cadastro não gera nada) — se ainda chegar aqui,
    // vindo de um app antigo que não atualizou, cai no gate do direito como
    // qualquer outro e recebe 403 SEM_DIREITO. Fica registrado para o Gabinete
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
    if (!kit) throw new HttpError(400, 'Uniforme inexistente.');
    if (!kit.ativo) throw new HttpError(400, 'Uniforme ainda não disponível.');

    const { direitoUsado, kitId } = resolverDireitoEKit(direito, kitPedido);
    console.log('[avatar-ai] direito', { userId, fonte: direitoUsado.fonte, teamId: direitoUsado.teamId, kitId, creditos: direito.creditos });

    // --- IDEMPOTÊNCIA: se já existe slot deste kit E foi gerado da MESMA foto
    // atual, veste-o e NÃO gera nem gasta quota. (Caso real: uma
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
      invalidarSessaoDoPedido(req); // nota completa no 'gerando' logo abaixo.
      console.log('[avatar-ai] slot reutilizado (sem geração, sem direito gasto):', { userId, kitId });
      return res.json({ avatar_url: slot.avatar_url, kit: kitId, do_slot: true, reutilizado: true, figurinha_ativa: avatarEhFigurinhaNossa(slot.avatar_url) });
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

    // Conta sem foto_hash (antes da 048): calcula-o agora, para a checagem de recusa abaixo valer também para ela.
    await garantirFotoHash(userId, perfil);
    // Foto já recusada (cabeça cortada nas duas tentativas) não gera de novo — nem fal, nem débito, nem job.
    // Vem depois do slot-reuse de propósito: vestir uma figurinha que já existe continua de graça.
    if (await fotoEstaRecusada(perfil.foto_hash)) throw new HttpError(422, MSG_FOTO_RECUSADA, 'FOTO_RECUSADA');

    // Figurinha automática: marca 'gerando' AQUI — depois de kit/plano/
    // slot-reuse/quota (validações de uso normal do endpoint, não específicas do
    // cadastro), mas ANTES do e-mail-gate. Motivo: no fluxo do Onboarding (fire-
    // and-forget logo após o upload), o e-mail-gate é o erro mais provável de
    // todos — quase toda conta nova via email+senha ainda não confirmou o e-mail
    // nesse instante — e o polling do Início precisa ver 'falhou' nesse caso, ou
    // fica preso mostrando "criando..." para sempre. Try/catch amplo a partir
    // daqui (não só ao redor da geração): qualquer gate reprovado também conta.
    await marcarFigurinhaStatus(userId, 'gerando');
    // Invalida o cache de sessão (60s, middleware/auth.js) nas 4
    // marcações de figurinha_status (aqui e as 'pronta'/'falhou' mais abaixo).
    // Hoje isto não muda nada sozinho — esse
    // cache guarda o USER do Supabase Auth (id/email/user_metadata), nunca as
    // colunas de `users`, e obterMe() lê figurinha_status com uma query
    // própria e SEMPRE fresca (obterPerfilResiliente), sem cache nenhum por
    // cima. GET /api/me e /api/inicio já respondem "na hora" sem esta linha.
    // Fica mesmo assim por ser grátis: mesmo padrão já
    // usado para onboarding-completo/tour-visto (linhas ~237-278), e barato
    // o suficiente para não pesar a decisão — se um dia figurinha_status
    // entrar em req.user (ex.: um JWT custom claim), esta chamada já está no
    // sítio certo em vez de ser mais uma coisa a lembrar depois.
    invalidarSessaoDoPedido(req);

    try {
      // PACOTE ANTI-ABUSO DE CUSTO — três gates, só a partir daqui (uma
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
    } catch (err) {
      // Qualquer gate reprovado → 'falhou', para o polling do Início parar de mostrar "criando...".
      await marcarFigurinhaStatus(userId, 'falhou');
      invalidarSessaoDoPedido(req); // nota completa no 'gerando', mais acima.
      throw err;
    }

    // A PINTURA NÃO SEGURA O PEDIDO. Reserva a vez (uma por vez por pessoa:
    // o toque duplo recebe a pintura do primeiro), anota na tabela e devolve na hora `{ jobId,
    // estimativaSegundos }`; o app consulta GET /api/figurinha/job/:id. O direito só é debitado lá dentro,
    // DEPOIS da figurinha gravada — um job que morre a meio não custa nada a ninguém.
    // `assincrono` vem do app novo. Os apps já publicados não o mandam e esperam a figurinha na resposta:
    // para eles o pedido espera a MESMA pintura terminar, como sempre esperou (mesmos códigos de erro).
    const { job, jaEmAndamento } = geracaoJobs.reservar({ userId, kitId });
    if (jaEmAndamento) return respostaDePinturaEmCurso(res, job.id, job.estimativaSegundos, assincrono);
    await geracaoJobs.registrar(job);

    // Com o Cloud Tasks ligado, a pintura roda DENTRO de um pedido (o da tarefa), porque o
    // Cloud Run só dá CPU enquanto há pedido: o POST só enfileira e responde. O app antigo (sem `assincrono`) espera a
    // figurinha na resposta — esse pedido já segura a CPU, então pinta aqui mesmo, como sempre. Sem a linha na tabela
    // (069 por aplicar) ou se o Cloud Tasks recusar, cai na fila em memória: o app consulta e a CPU anda.
    if (assincrono && tarefasPintura.ativas() && job.persistido) {
      try {
        await tarefasPintura.enfileirar({ jobId: job.id, ip: req.ip, origem });
        geracaoJobs.entregarATarefa(job);
        return res.status(202).json({ jobId: job.id, estimativaSegundos: job.estimativaSegundos });
      } catch (e) {
        console.error('[avatar-ai] Cloud Tasks não aceitou a tarefa — pinto em memória:', e?.message || e);
        // A tarefa pode ter sido criada mesmo com o erro (prazo estourado na resposta): só pinta aqui quem pegar o job.
        const r = await geracaoJobs.reivindicar(job.id).catch(() => ({ resultado: 'ok' }));
        if (r.resultado !== 'ok') {
          geracaoJobs.entregarATarefa(job);
          return res.status(202).json({ jobId: job.id, estimativaSegundos: job.estimativaSegundos });
        }
      }
    }
    geracaoJobs.iniciar(
      job,
      async (controle) => {
        try {
          return await pintarFigurinha({ req, userId, perfil, origem, direitoUsado, kitId, kit, slot }, controle);
        } catch (err) {
          // Qualquer falha a partir do e-mail-gate (inclusive) → 'falhou', para o polling do Início parar
          // de mostrar "criando..." e oferecer nova foto (como era no catch do handler).
          await marcarFigurinhaStatus(userId, 'falhou');
          invalidarSessaoDoPedido(req);
          throw err;
        }
      },
      assincrono ? { aoTerminar: avisarQuePintou } : undefined,
    );

    if (assincrono) return res.status(202).json({ jobId: job.id, estimativaSegundos: job.estimativaSegundos });
    await job.promessa;
    if (job.estado === 'falhou') throw job.erroOriginal;
    return res.json(job.resultado);
  })
);

const UUID_JOB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/interno/pintar/:jobId — o pedido do Cloud Tasks que PINTA (bloco 2-A2). Interno: só passa com o segredo
 * (`x-futty-interno`) e, com o Cloud Tasks ligado, o token OIDC da conta de serviço do Cloud Run (utils/tarefasPintura.js);
 * sem um dos dois, 401. Roda a pintura DENTRO do pedido e responde ao fim — a CPU do Cloud Run existe porque o pedido está aberto.
 *   200 { estado }    terminou — 'pronta' OU 'falhou'. Falha de pintura (cabeça cortada, foto, sem direito) é DESFECHO,
 *                     não motivo de repetir: repetir pagaria a fal de novo à toa. O app lê o erro pelo job.
 *   200 { repintou: false }  o job já tinha terminado (a tarefa chegou de novo): não repinta, não cobra de novo.
 *   409               outro processo pinta agora, com batimento fresco: o Cloud Tasks tenta mais tarde.
 *   5xx / conexão caída  o processo morreu no meio: o Cloud Tasks repete (3 vezes, 10 s de espera inicial) e a repetição
 *                     retoma a pintura quando o batimento do processo morto passa de 40 s — o direito só é debitado
 *                     depois da figurinha gravada, então nada foi cobrado.
 */
router.post(
  '/api/interno/pintar/:jobId',
  asyncHandler(async (req, res) => {
    await tarefasPintura.autorizar(req);
    const { jobId } = req.params;
    if (!UUID_JOB.test(jobId)) throw new HttpError(404, 'Pintura não encontrada.');
    const r = await geracaoJobs.reivindicar(jobId);
    if (r.resultado === 'inexistente') throw new HttpError(404, 'Pintura não encontrada.');
    if (r.resultado === 'concluido') return res.json({ jobId, estado: r.linha.estado, repintou: false });
    if (r.resultado === 'em_curso') throw new HttpError(409, 'Esta pintura já está em andamento.', 'PINTURA_EM_CURSO');

    const job = geracaoJobs.adotar(r.linha);
    geracaoJobs.iniciar(
      job,
      (controle) => pintarDaTarefa(job, { ip: req.body?.ip, origem: req.body?.origem }, controle),
      { aoTerminar: avisarQuePintou },
    );
    await job.promessa;
    return res.json({ jobId, estado: job.estado, repintou: true });
  })
);

/**
 * PUT /api/me/kit — veste um kit JÁ GERADO (slot, ou histórico se o slot não
 * sobreviveu). Não gera nada, não custa direito.
 * 200 { avatar_url, kit } se achou uma figurinha guardada; 409 { precisa_gerar: true, kit } se não.
 */
router.put(
  '/api/me/kit',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const kitId = String(req.body?.kit || '');
    const kit = KITS_IA[kitId];
    if (!kit) throw new HttpError(400, 'Uniforme inexistente.');

    // Esta rota só veste o que JÁ existe num slot
    // — nunca gera nada, nunca custa direito. Não há gate de `plan` aqui: era
    // do modelo Free/Pro/Elite (aposentado na SPEC-FIGURINHA-3) e, como
    // ninguém mais tem `plan` diferente de 'free', barraria QUALQUER kit que não
    // fosse o dark-gold para todo mundo — mesmo para quem já tinha aquela
    // Brilhante gerada e só queria voltar a vesti-la. O direito de gerar já foi
    // gasto quando o slot nasceu; vestir de novo é livre, sempre.
    const { data: slot } = await supabase
      .from('user_avatar_slots')
      .select('avatar_url')
      .eq('user_id', userId)
      .eq('kit_id', kitId)
      .maybeSingle();

    // Uniformes guardados: o slot é a fonte normal (guarda a
    // ÚLTIMA versão de cada kit e nunca é apagado, só substituído quando o
    // MESMO kit é regerado). Ainda assim, sem slot, olha para o histórico
    // (user_avatar_historico) antes de mandar gerar — mesma rede de segurança
    // do PUT /api/me/avatar/historico/:id, para uma versão antiga desse kit
    // nunca custar uma geração nova só porque o slot dela não sobreviveu.
    let avatarUrl = slot?.avatar_url || null;
    if (!avatarUrl) {
      try {
        const { data: antiga, error: erroHist } = await supabase
          .from('user_avatar_historico')
          .select('avatar_url')
          .eq('user_id', userId)
          .eq('kit_id', kitId)
          .order('criado_em', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (erroHist) throw new Error(erroHist.message);
        avatarUrl = antiga?.avatar_url || null;
      } catch (e) {
        if (!ehMigracaoEmFalta(e.message)) throw new HttpError(500, e.message);
        console.warn('[me/kit] histórico indisponível (migração 057 aplicada?):', e.message);
      }
    }

    // Sem slot nem histórico → o cliente tem de gerar (gasta quota). 409 ≠ erro: é um estado.
    if (!avatarUrl) return res.status(409).json({ precisa_gerar: true, kit: kitId });

    await ensureUserRow(req.user);
    const { error } = await supabase
      .from('users')
      .update({ avatar_url: avatarUrl, kit_ativo: kitId })
      .eq('id', userId);
    if (error) throw new HttpError(500, error.message);

    res.json({ avatar_url: avatarUrl, kit: kitId, figurinha_ativa: avatarEhFigurinhaNossa(avatarUrl) });
  })
);

/**
 * PUT /api/me/avatar/modo { modo: 'foto' | 'figurinha' } — quem
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
    res.json({ avatar_url: novoAvatarUrl, modo, figurinha_ativa: avatarEhFigurinhaNossa(novoAvatarUrl) });
  })
);

/**
 * GET /api/me/avatar/historico — as últimas figurinhas de
 * "Minhas figurinhas" (user_avatar_historico, migração 057). Fail-safe: sem
 * a migração, devolve lista vazia (a galeria some sozinha, sem erro na tela).
 */
router.get(
  '/api/me/avatar/historico',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { data, error } = await supabase
      .from('user_avatar_historico')
      .select('id, kit_id, avatar_url, criado_em')
      .eq('user_id', req.user.id)
      .order('criado_em', { ascending: false })
      .limit(TETO_HISTORICO_FIGURINHAS);
    if (error) {
      if (!ehMigracaoEmFalta(error.message)) throw new HttpError(500, error.message);
      console.warn('[avatar/historico] user_avatar_historico indisponível (migração 057 aplicada?):', error.message);
      return res.json({ items: [] });
    }
    res.json({ items: data || [] });
  })
);

/**
 * PUT /api/me/avatar/historico/:id — "Usar esta" numa figurinha antiga:
 * vira avatar_url + kit_ativo, sem custo (não gera nada, não debita
 * crédito nem pacote do time) e marca card_modo='figurinha' — a pessoa
 * está escolhendo, de propósito, mostrar uma figurinha.
 */
router.put(
  '/api/me/avatar/historico/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { data: linha, error: erroLinha } = await supabase
      .from('user_avatar_historico')
      .select('id, kit_id, avatar_url, user_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (erroLinha) {
      if (ehMigracaoEmFalta(erroLinha.message)) throw new HttpError(400, 'Histórico de figurinhas indisponível.');
      throw new HttpError(500, erroLinha.message);
    }
    if (!linha || linha.user_id !== userId) throw new HttpError(404, 'Figurinha não encontrada no seu histórico.');

    await ensureUserRow(req.user);
    const { error: updErr } = await supabase
      .from('users')
      .update({ avatar_url: linha.avatar_url, kit_ativo: linha.kit_id })
      .eq('id', userId);
    if (updErr) throw new HttpError(500, updErr.message);

    // Best-effort, mesmo padrão do PUT /modo acima: escolher uma figurinha do
    // histórico é uma escolha de card_modo tanto quanto o interruptor é.
    try {
      const { error: erroModo } = await supabase.from('users').update({ card_modo: 'figurinha' }).eq('id', userId);
      if (erroModo) throw new Error(erroModo.message);
    } catch (e) {
      if (!ehMigracaoEmFalta(e.message)) throw e;
      console.warn('[avatar/historico] card_modo indisponível (migração 056 aplicada?):', e.message);
    }

    invalidarSessaoDoPedido(req);
    res.json({ avatar_url: linha.avatar_url, kit: linha.kit_id, figurinha_ativa: avatarEhFigurinhaNossa(linha.avatar_url) });
  })
);

/**
 * PUT /api/me/avatar/enquadro { x, y, escala } — grava o recorte da
 * MINIATURA do avatar (a janela quadrada que aparece no Início, no ranking, no sorteio…). Vale para
 * o arquivo que é o avatar AGORA (foto crua ou figurinha): trocar de foto/uniforme leva a outro
 * arquivo e o recorte velho para de valer sozinho. O motor serve TODAS as miniaturas desse
 * arquivo — as dela e as que as outras pessoas veem — no enquadramento escolhido (utils/recortesAvatar.js).
 * 200 { recorte, avatar_url } (o avatar_url já sai com o recorte, pelo proxy) ·
 * 400 recorte inválido · 409 o avatar não é um arquivo nosso (foto do Google, silhueta) · 503 sem a migração 070.
 */
router.put(
  '/api/me/avatar/enquadro',
  requireAuth,
  asyncHandler(async (req, res) => {
    const recorte = validarRecorte(req.body);
    if (!recorte) throw new HttpError(400, 'Enquadramento inválido.');
    const { atual, alvo } = await lerAvatarParaEnquadro(req.user.id);
    if (!alvo) throw new HttpError(409, 'Só dá para enquadrar uma foto sua ou a sua figurinha.', 'SEM_ARQUIVO_PROPRIO');

    await ensureUserRow(req.user);
    const { error } = await supabase
      .from('users')
      .update({ avatar_recorte: { ...recorte, arquivo: alvo.path } })
      .eq('id', req.user.id);
    if (error) throw erroDoEnquadro(error);

    if (atual?.arquivo && atual.arquivo !== alvo.path) recortesAvatar.remover(atual.arquivo);
    recortesAvatar.registrar(alvo.path, recorte);
    invalidarSessaoDoPedido(req);
    res.json({ recorte, avatar_url: atual.avatar_url });
  })
);

/** DELETE /api/me/avatar/enquadro — volta à regra de sempre (figurinha no topo, foto em 50% 35%). */
router.delete(
  '/api/me/avatar/enquadro',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { atual } = await lerAvatarParaEnquadro(req.user.id);
    const { error } = await supabase.from('users').update({ avatar_recorte: null }).eq('id', req.user.id);
    if (error) throw erroDoEnquadro(error);
    if (atual?.arquivo) recortesAvatar.remover(atual.arquivo);
    invalidarSessaoDoPedido(req);
    res.json({ recorte: null, avatar_url: atual?.avatar_url ?? null });
  })
);

/** A linha do enquadro: o avatar atual, o arquivo dele no bucket e o recorte que já havia (se a migração 070 existe). */
async function lerAvatarParaEnquadro(userId) {
  const { data, error } = await supabase.from('users').select('avatar_url, avatar_recorte').eq('id', userId).maybeSingle();
  if (error) throw erroDoEnquadro(error);
  const parsed = parseUrlPublico(data?.avatar_url);
  const alvo = parsed && parsed.bucket === 'avatars' ? parsed : null;
  const arquivo = typeof data?.avatar_recorte?.arquivo === 'string' ? data.avatar_recorte.arquivo : null;
  return { atual: { avatar_url: data?.avatar_url ?? null, arquivo }, alvo };
}

function erroDoEnquadro(error) {
  if (ehMigracaoEmFalta(error.message)) {
    console.warn('[avatar/enquadro] users.avatar_recorte indisponível (migração 070 aplicada?):', error.message);
    return new HttpError(503, 'O enquadramento da miniatura ainda não está disponível. Tente mais tarde.');
  }
  return new HttpError(500, error.message);
}

module.exports = router;
