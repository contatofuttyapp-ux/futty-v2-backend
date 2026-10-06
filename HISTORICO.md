# HISTORICO — a memória de quando e por que cada coisa foi feita

Este arquivo guarda os comentários de história (rodadas, achados, datas, decisões, bancadas) que foram retirados do código do motor em 6-out-2026 (Arrumação 0, bloco 1-B).
O código guarda só as regras vivas — o PORQUÊ de cada regra, sem data nem número de rodada; a cronologia mora aqui.
Cada item traz a linha aproximada do arquivo no momento da retirada, um trecho de 1 linha do código a que o comentário se referia e o texto original, sem corte;
quando o comentário misturava história e regra, a regra ficou no código e o original completo está aqui.
A lista mestra de decisões continua em C:\Users\phfer\Desktop\FUT\LISTA-CURTA.md e nos RODADA-*.md.

## server.js

- (linha ~1, `require('dotenv').config({ quiet: true });`) Futty v2.0 — Backend (Express + Supabase)
  Setup do servidor: middleware, ficheiros estáticos, rotas e tratamento de erros.
  { quiet: true } (23-set): sem isto o dotenv imprime um "tip" promocional
  próprio a cada arranque (ex.: "auth for agents [vestauth.com]") — propaganda
  do pacote, não do nosso código. Não muda o carregamento das variáveis.
- (linha ~8, `if (process.env.NODE_ENV === 'production' && !process.env.MEDIA_TOKEN_SECRET) {`) SEGURANCA-REVISAO-10SET.md secção 3 (10-set): o token do proxy de imagem
  (utils/mediaToken.js) caía para a SUPABASE_SERVICE_KEY como segredo de
  assinatura quando MEDIA_TOKEN_SECRET faltava — reaproveitar um segredo que
  já abre o banco inteiro para outra coisa. Falha alto e cedo em produção em
  vez de arrancar silenciosamente inseguro.
- (linha ~21, `if (process.env.NODE_ENV === 'production' && !process.env.RC_WEBHOOK_SECRET) {`) Pagamentos P1 (26-set): o webhook do RevenueCat (routes/compras.js) credita figurinhas
  pagas. Sem o segredo, ninguém (nem o RevenueCat) passa na porta — em produção isso
  é dinheiro cobrado e não creditado. Mesmo padrão do MEDIA_TOKEN_SECRET: falha cedo.
- (linha ~101, `'capacitor://localhost',`) VELOCIDADE 4 — as origens do app nativo são NOSSAS e fixas (Capacitor: iOS
  serve em capacitor://localhost, Android em https://localhost). Estavam a
  depender de alguém lembrar-se de as pôr em CORS_ORIGINS; uma variável mal
  preenchida no Cloud Run tirava o app do ar inteiro. Ficam aqui, no código.
- (linha ~123, `exposedHeaders: ['Server-Timing', 'X-Futty-Cache'],`) Server-Timing (13-set, "Velocidade 3", middleware/tempo.js): por omissão
  o browser só lê headers "seguros" de um pedido cross-origin — sem isto o
  header ia na resposta mas o DevTools/fetch do frontend não o enxergava.
  X-Futty-Cache (15-set, "Velocidade 6A"): diz se a imagem veio do LRU do
  proxy (hit) ou do Storage (miss) — é como se mede, do lado de cá, se o
  cache está a trabalhar.
- (linha ~130, `maxAge: 86400,`) VELOCIDADE 4 (o app nativo "surreal de devagar" em Lisboa): sem maxAge o
  browser/WebView repete o preflight a CADA pedido. De Lisboa para São Paulo
  isso é ~250 ms de ida e volta desperdiçados antes de cada chamada — numa
  tela com 3 pedidos, quase um segundo só a pedir licença. 86400 = 24 h, o
  tecto que o Chromium aceita (o Safari corta em 600 s, e tudo bem: 10 min
  já cobre uma sessão inteira). O preflight passa a acontecer uma vez.
- (linha ~158, `app.use(compression({ threshold: 1024 }));`) VELOCIDADE 6A (15-set): não havia compressão nenhuma. O /api/feed e o
  /api/inicio são JSON com muito texto repetido — é onde o gzip ganha mais, e
  de Lisboa cada KB poupado conta. `threshold: 1024` deixa passar as respostas
  pequenas (comprimir 200 bytes custa mais CPU do que poupa rede).
  O /api/media não é afetado: o `compression` salta o que já vem comprimido
  (image/webp, image/gif), por isso as imagens seguem sem passar por aqui.
- (linha ~170, `app.use('/api', ...criarLimitesDaApi({ tokenDoPedido: bearerToken, sessaoConhec…`) Rate limiting geral: protege todas as rotas /api de abuso. Em DOIS baldes, e
  cada pedido cai em um só: por IP (rede grossa, anti-tráfego anônimo) e por
  sessão (rede fina, para quem o motor já validou). Os tetos, o critério e o
  porquê estão em middleware/limiters.js (hotfix 25: o IP da casa do dono e o
  Wi-Fi da quadra esgotavam o balde de todo mundo). DEV (31-jul): fora de
  produção os tetos sobem; numa tarde de teste o dono + o Claude + o hot-reload
  estouravam o de produção e o app "morria" por 15 min.
  VELOCIDADE 4: a web fala com o motor por uma função na Cloudflare
  (frontend/functions/api/[[path]].js), e visto daqui todos esses pedidos
  chegam do mesmo IP, o do edge; ele reencaminha o IP real em CF-Connecting-IP.
  /api/media tem o limiter próprio (routes/media.js).
- (linha ~199, `app.get('/health', async (req, res) => {`) SEGURANCA-REVISAO-10SET.md secção 2/3 (10-set): removido o mount genérico
  `app.use('/public', express.static(...))` que servia a pasta public/ inteira
  sem login — era isso que expunha fotos-teste/fotos-teste-4/fotos-treino/
  fotos-jogos (fotos reais de pessoas, algumas de menores) a qualquer um com
  o URL. Removido também `/public/logos`: os logos de equipa já vão para o
  Storage privado do Supabase (routes/teams.js, POST /:slug/logo), a pasta
  public/logos nunca chegou a existir em disco. Só sobem os dois mounts
  acima — avatares (V1 migrada) e uploads (fotos de campeão) — que é tudo o
  que o frontend de facto usa da pasta public/.
- (linha ~238, `app.use(mediaUrls);`) Tijolo 1C — assina/despublica URLs de média (buckets privados) na fronteira,
  ANTES das rotas (embrulha res.json). Autenticadas → assinado; /api/p/ → silhueta.
- (linha ~256, `app.use(mediaProxyRoutes);`) GET /api/media/:token — proxy de imagem (Tijolo 2)
- (linha ~257, `app.use(denunciasRoutes);`) Denúncias + triagem IA (Tijolo 3)
- (linha ~261, `app.use(diagnosticoRoutes);`) /api/diagnostico — caixa-preta do app (VELOCIDADE 4)
- (linha ~262, `app.use(telemetriaRoutes);`) POST /api/telemetria — velocidade anônima (Rodada 28), sem sessão
- (linha ~264, `app.use(figurinhaJobRoutes);`) GET /api/figurinha/job/:id — em que pé está a pintura da figurinha em segundo plano (29B)
- (linha ~286, `if (require.main === module) {`) SEGURANCA-REVISAO-10SET.md secção 3 (10-set): só arranca sozinho quando
  corrido diretamente (`node server.js`, produção/dev normal) — não quando
  outro módulo faz require('./server') (backend/tests/permissoes.test.js,
  que sobe o app na sua própria porta livre via app.listen(0)). Sem isto os
  testes colidiam com um dev server já a correr em 3001 (EADDRINUSE).
- (linha ~295, `const encerrar = async (sinal) => {`) VELOCIDADE 6A (15-set): as impressões de publicidade ficam num acumulador em
  memória e só descem ao Storage de 30 em 30 s. O Cloud Run manda SIGTERM antes
  de apagar a instância — é a última oportunidade de gravar o que está pendente.
  Registados JÁ (antes do modelo NSFW carregar): um SIGTERM a meio do arranque
  ainda encontra o handler — sem servidor para fechar, só sai.
- (linha ~302, `try {`) Rodada 29B (bloco 2, A): o que está pintando aqui não termina — marca 'falhou' (sem cobrar) já, para quem
  consulta ver a mensagem em segundos e não esperar o prazo do batimento.
- (linha ~317, `carregarModelo().then(() => {`) RODADA 8B (15-set): o modelo NSFW (Tijolo 1) carrega ANTES de abrir a porta —
  antes disto, o listen() já aceitava pedidos com o modelo (TensorFlow.js +
  MobileNetV2) ainda a carregar em fundo. Não era incorreto (classificar() em
  utils/nsfwFilter.js espera a MESMA promessa de carga), só lento: quem
  disparasse o primeiro upload numa instância nova pagava essa espera. Com
  minScale 1 no Cloud Run (a instância nunca dorme), isso só acontece mesmo no
  DEPLOY — e é aí que o custo deve cair: o Cloud Run só manda tráfego para a
  revisão nova quando a porta responde, então atrasar o listen() até o modelo
  estar pronto tira essa espera de cima de qualquer pessoa real.
  carregarModelo() nunca rejeita (falha aberta, registada lá dentro) — o
  .then() corre sempre, mesmo se o modelo não carregar.
- (linha ~332, `const chaves = require('./utils/chavesSupabase').origemDasChaves();`) Rodada 28: qual chave do Supabase o motor pegou (nome e formato, nunca o valor) — é
  pelo log da revisão nova que se confere a troca para a chave secreta sb_secret_….
- (linha ~348, `require('./utils/recortesAvatar').iniciar(supabase);`) Rodada 29B (bloco 3, E): quem tem recorte de miniatura (users.avatar_recorte) — carrega agora e relê a cada 2 min.
- (linha ~350, `const tarefasIncompletas = tarefasPintura.configuracaoIncompleta();`) Rodada 29B (bloco 2-A2): a pintura por Cloud Tasks só liga com as três variáveis — diz no log em que modo subiu.
- (linha ~354, `geracaoJobs.varrerInterrompidas({ aoMarcar: (id) => marcarFigurinhaStatus(id, '…`) Rodada 29B (bloco 2, A): pintura "em andamento" sem batimento há mais de 60 s é de um processo que morreu
  (reinício, deploy): vira 'falhou' com a mensagem "interrompida, nada foi cobrado". A de outra instância
  viva tem batimento fresco e não é tocada.
- (linha ~363, `privatizarBuckets().catch((e) => console.error('[Futty] privatizarBuckets:', e.…`) Tijolo 1C: garante os buckets de avatares/resenha privados (idempotente).

## middleware/auth.js

- (linha ~79, `const MSG_AUTH_FORA = 'Não deu para confirmar sua sessão agora. Tente de novo e…`) RODADA 28 — 401 passou a significar, para o app, "a sessão acabou: sai deste aparelho e vai para o
  login" (lib/api.js). Então 401 só pode sair quando o Supabase DISSE que o token não vale. Sem sessão
  em cache e com o Supabase Auth fora do ar, o motor não sabe — e a resposta honesta é 503 (antes era
  401, e um soluço do Supabase ia deslogar todo mundo que estivesse abrindo o app naquele minuto).
- (linha ~157, `function invalidarSessaoDoPedido(req) {`) Remove o token do pedido atual do cache de sessão — usado por DELETE /api/me
  (14-set): sem isto, a conta já excluída continuava "autenticada" nesse
  mesmo token por até SESSAO_CACHE_TTL_MS (60s), porque requireAuth nunca
  voltaria a validar contra o Supabase dentro dessa janela.

  Velocidade 7A: esquece também as sessões da MESMA conta em outros tokens
  (outro aparelho). Com a renovação por trás, uma delas podia sair velha mais
  uma vez — com a conta já apagada ou o onboarding já concluído.

## middleware/limiters.js

- (linha ~66, `const diagnosticoLimiter = criarLimiter({`) POST /api/diagnostico — 10/hora por utilizador (VELOCIDADE 4). É um botão que
  se toca de propósito na tela de Diagnóstico, não um fluxo automático; o tecto
  existe para um relatório enviado em loop não encher o Storage.
- (linha ~75, `function limitesPara(emProducao) {`) ─── Limites gerais (hotfix 25, 25-set) ──────────────────────────────────────

  Incidente real: o celular do dono levou "Muitos pedidos" no onboarding porque o
  IP da casa esgotou os 200/15 min, e no dia do time 20 celulares numa quadra
  dividem um IP de Wi-Fi ou de operadora (CGNAT). Um teto por IP sozinho junta
  gente diferente no mesmo balde. Agora o IP é só a rede grossa (anti-tráfego
  anônimo) e cada sessão tem o seu balde.
- (linha ~95, `telemetria: 300, // por IP`) Rodada 28: a telemetria anônima manda no máximo 1 aviso por tela por sessão (~15 numa sessão
  longa). 300 por IP cabe um time inteiro no mesmo Wi-Fi da quadra; o resto é enchimento.
- (linha ~98, `webhookCompras: 120, // por IP, por MINUTO`) Pagamentos P1: o webhook do RevenueCat. Chega de poucos IPs deles, em rajada quando
  reenviam uma fila; 120/min folga o real e barra quem martela a porta sem o segredo.
- (linha ~205, `function criarLimiteDeTelemetria({ limites = LIMITES } = {}) {`) POST /api/telemetria (Rodada 28): anônima, sem sessão — conta pelo IP real, que só vive na
  memória do limiter durante a janela e nunca vai para tabela nenhuma.
- (linha ~220, `function criarLimiteDeAviseMe({ max = 10 } = {}) {`) POST /api/avise-me (Rodada 29B, F): a lista de quem quer ser avisado do lançamento. Pública, sem sessão: conta pelo
  IP real (o mesmo da telemetria — pela Cloudflare vem em CF-Connecting-IP), 10 por HORA. Uma pessoa não precisa de mais
  que isso; e o IP só vive na memória do limiter, não vai para a tabela.
- (linha ~236, `function criarLimiteDeWebhook({ limites = LIMITES } = {}) {`) POST /api/compras/webhook/revenuecat (Pagamentos P1): sem sessão — a autorização é o segredo
  no header. Conta por IP real, 120 por minuto.

## middleware/mediaUrls.js

- (linha ~1, `const { proxificarPayload, despublicarPayload } = require('../utils/storage');`) Tijolo 1C — assina URLs de média na fronteira da API.
  Buckets 'avatars'/'resenha' são privados; os URLs guardados são públicos e
  morreriam. Este middleware embrulha res.json e, ANTES de enviar:
    - rotas autenticadas → assina os URLs (validade curta) → o frontend renderiza
      sem qualquer alteração (urlAsset devolve URLs http tal-qual);
    - rotas PÚBLICAS de partilha (/api/p/...) → despublica (→ silhueta no cliente).
  Fail-open: qualquer erro envia o payload original.
- (linha ~10, `function baseDoBackend(req) {`) Tijolo 2: as rotas autenticadas passam a emitir URLs do PROXY de imagem
  (`/api/media/:token`), estáveis 7 dias → sem expiração à vista no DOM, bucket
  privado. O proxy é que assina a Supabase (vida curta) a cada pedido. As páginas
  públicas /api/p/ continuam a despublicar (→ silhueta). Fail-open.

## prompts/figurinha.js

- (linha ~1, `const REGRA_OCULOS = 'SUNGLASSES: if Image 1 shows sunglasses, remove them comp…`) ═══════════════════════════════════════════════════════════════════════════════
  O PROMPT DA FIGURINHA — fonte única (17-set, variante 6 da bancada).

  Este ficheiro é o prompt. `routes/auth.js` e a bancada
  (`scripts/_bench/testar-prompt.js`) importam daqui — nunca copiam.

  DE ONDE VEIO: bancada de 49 figurinhas (7 fotos × 7 variantes,
  `scripts/_bench/testar-prompt.js`), avaliada às cegas pelo dono a 17-set:
    P1, o prompt antigo (5.375 caracteres, PRIORITY ORDER + STYLE de pincelada
         larga + checklist de kit em cinco pontos) ................. 1,6/5
    P2, este ("FACE FIRST", kit em uma frase) ..................... 4,0/5
    P3, P2 com o bloco STYLE antigo de volta ...................... 3,3/5
    P2 + input_fidelity high + entrada quadrada (a escolhida) ..... 4,1/5
  O prompt é a alavanca principal: mesmo modelo, mesma qualidade, mesma conta —
  1,6 → 4,1 só trocando o texto. O bloco STYLE antigo ("broad brush", "hair as
  masses", "skin smooth") está REPROVADO: era ele que apagava o rosto (P3 caiu
  0,7 ponto face a P2 sem mudar mais nada).

  O que NÃO mudar sem outra bancada:
    • a ordem dos blocos (FACE FIRST vem primeiro de propósito);
    • o kit numa frase só — a versão em cinco pontos com checklist do prompt
      antigo errou o emblema em 4 das 7 fotos, esta versão em 0;
    • "flat mid-grey #8a8a8a" no fundo, que é o que o birefnet recorta.
  ═══════════════════════════════════════════════════════════════════════════════
- (linha ~26, `const REGRA_OCULOS = 'SUNGLASSES: if Image 1 shows sunglasses, remove them comp…`) A regra dos óculos vive numa LINHA PRÓPRIA, no início do FACE FIRST. Na
  bancada de 17-set ela estava entre parênteses no fim do parágrafo e três
  figurinhas do Gui saíram com os óculos escuros na cara — a versão entre
  parênteses perde-se no meio do texto.
  22-set, forma FORTE: "remove them" sozinho deixava o modelo trocar lentes
  escuras por óculos de grau, que também não é o que se pede. Agora não há
  espaço: tira tudo e pinta os olhos.
- (linha ~81, `const PROMPT_REPINTURA = 'Repaint this exact image as a polished semi-realistic…`) ── A SEGUNDA PASSADA (22-set) ────────────────────────────────────────────────

  Desde 22-set a figurinha nasce em duas passadas: o gpt-image-2.5 dá a CARA
  (foi a que o dono aprovou) e o gpt-image-1.5 repinta no acabamento da casa.
  Este é o prompt da segunda — ele NÃO descreve a pessoa nem o kit, porque não
  precisa: a imagem que recebe já tem tudo. A única coisa que ele faz é trocar
  o acabamento sem deixar nada mais mudar.

  A ordem "Change NOTHING else" vem à frente de qualquer coisa que se possa ler
  como liberdade criativa, e repete item a item o que tem de ficar igual — na
  bancada, "keep the same" sozinho não segurava nem o emblema nem o
  enquadramento. É esta frase que protege a cara que a passada 1 acertou.

## routes/ads.js

- (linha ~1, `const express = require('express');`) Futty v2.0 — Serving REAL de publicidade + medição. As campanhas vivem no gabineteStore
  (operacao.json), geridas no Gabinete. LEIS SELADAS respeitadas:
   · filtro etário FAIL-CLOSED: sem classificação = '18+'; quem não tem 18 anos confirmados pela
     data (e o anónimo) só recebe 'livre' — o app é 18+ (Rodada 29G) e esta é a 2ª linha;
   · interruptor geral (Gabinete 2.0, aba Anúncios) — desligado corta tudo,
     independente dos toggles por página;
   · toggle por página (default OFF) — página desligada = nenhum anúncio;
   · rótulo "PUBLICIDADE" é do frontend.
  Lógica em services/inicio.js#obterAd — a MESMA função que GET /api/inicio usa,
  para o JSON nunca divergir entre as duas rotas.
- (linha ~29, `router.get(`) GET /api/ads/sessao — os slots de TODAS as páginas de uma vez (VELOCIDADE 9).
  O app pede isto uma vez por sessão (ou recebe-o dentro do /api/inicio) e
  serve as telas a partir dele durante `validadeMs`.
- (linha ~53, `router.post(`) POST /api/ads/eventos { eventos: [{ id, tipo }] } — os mesmos eventos, em
  lote (VELOCIDADE 9). O app junta as impressões e manda-as de uma vez, por
  `sendBeacon`, quando a tela sai da frente — fora do caminho de pintura.

  Teto de 50 por lote: um beacon é de confiança limitada e isto é contagem
  agregada, não contabilidade — melhor recusar um lote absurdo do que deixar
  uma chamada escrever mil linhas.

## routes/auth.js

- (linha ~20, `const { montarPrompt } = require('../prompts/figurinha');`) A figurinha, em três módulos próprios (17-set, variante 6 da bancada):
    prompts/figurinha.js       o texto que vai à IA (a bancada importa o MESMO)
    utils/entradaFigurinha.js  a foto que vai com ele (faixa + corte quadrado)
    utils/falFila.js           a chamada, e o custo REAL vindo dos headers da fal
- (linha ~31, `const { temDireito, debitar, ehMigracaoEmFalta } = require('../utils/direitoBri…`) Quem pode gerar uma Brilhante (SPEC-FIGURINHA-3, §5). Desde 22-set toda
  geração nasce paga: crédito comprado/presenteado ou pacote do time.
- (linha ~34, `const geracaoJobs = require('../utils/geracaoJobs');`) Rodada 29B (bloco 2, A): a pintura roda em segundo plano, numa fila em memória (uma por vez por pessoa).
- (linha ~39, `const { validarRecorte } = require('../utils/recorteAvatar');`) Rodada 29B (bloco 3, E): o enquadramento da miniatura (PUT/DELETE /api/me/avatar/enquadro).
- (linha ~44, `const router = express.Router();`) fal.ai — a chave vem do ambiente (FAL_KEY) e é lida dentro de utils/falFila.js,
  que é quem fala com a fal desde 17-set (o SDK escondia os headers de custo).
- (linha ~52, `const uploadAvatarMw = multer({`) RODADA 19 — "Escolher outra foto" manda dois ficheiros no mesmo pedido: o
  recorte 2:3 (campo "avatar", como sempre) e, opcional, a foto ORIGINAL
  antes do recorte (campo "original", para "Ajustar enquadramento" mais
  tarde). .fields() em vez de .single(): quem só manda "avatar" (Onboarding,
  clientes antigos) continua a funcionar sem mudar nada.
- (linha ~80, `if (req.file) {`) EXIF (build 9, achado real: selfie do iPhone girada 180°). .rotate() sem
  argumentos lê a tag Orientation, reescreve os pixels já em pé e apaga a
  tag — ninguém depois (NSFW, Olheiro, Storage, IA) precisa de voltar a
  interpretar orientação. O frontend já normaliza antes de subir
  (utils/normalizarFoto.js) — isto é o cinto e suspensório: cobre
  qualquer caminho que não passe por lá (API directa, cliente antigo).
  ANTES de qualquer outra operação: primeira coisa a tocar no buffer.
- (linha ~105, `const uploadRecorteMw = multer({`) RODADA 19 — PUT /api/me/avatar/recorte: um ficheiro só (campo "recorte"),
  o resultado de reabrir o CropModal sobre a original (ou o fallback, sobre
  o recorte atual). Mesmo teto/mesmos tipos do avatar normal.
- (linha ~144, `const FUNDOS_PREMIUM = ['golden', 'aura', 'royal'];`) Fundos PREMIUM: GOLDEN, AURA e ROYAL. ÉPICO ('gradiente', chave interna) é
  GRÁTIS (15-set, decisão do dono) — fora desta lista de propósito.

  LEI DA REGRA JUSTA (sem punição retroativa): o gate só corre AQUI, no PATCH
  que TROCA fundo_figurinha — nunca em leitura (GET /api/me) nem no render.
  Quem já tinha Aura equipado antes deste gate MANTÉM (a coluna já gravada
  nunca é revalidada até o próprio utilizador mexer nela). Só ao tentar
  EQUIPAR de novo (depois de trocar pra outro fundo) é que o direito volta a
  ser exigido — ninguém perde o que já tinha, mas ninguém re-adquire de graça.
  Ver Figurinha.jsx `escolherFundo` (o `if (k === fundo) return` early-return
  é o que preserva isto: reabrir a mesma página nunca reenvia o PATCH do
  fundo já equipado).

  22-set (SPEC-FIGURINHA-3): estes 3 fundos vêm com a BRILHANTE, não com um
  plano — o gate virou DIREITO (ter avatar_url ≠ foto_url), super-admin
  sempre passa. Lista de ids, já não um mapa de planos.
- (linha ~168, `const PERFIL_COLS =`) Colunas de perfil devolvidas ao frontend.
  mostrar_rosto_publico (migração 040) e avatar_generico (migração 044) confirmadas
  presentes em produção (10-set) — juntas aqui em vez de 2 consultas extra por /api/me.
- (linha ~174, `function cadastroEmCurso(user) {`) RODADA 29G (1-out) — o Futty é para maiores de 18 anos (utils/idade.js). "Cadastro em curso" = o
  onboarding dia-1 ainda não foi concluído: é aí que a data chega (e-mail: no formulário; Google/Apple:
  no passo "Quando você nasceu?"). Contas que já existiam (onboarding concluído) o motor não apaga:
  com data menor de 18, o app mostra a tela com "Excluir minha conta".
- (linha ~249, `if (FUNDOS_PREMIUM.includes(v)) {`) GATE (servidor é a fonte da verdade — sem truque de frontend). 22-set,
  SPEC-FIGURINHA-3 §4/§9: os 3 fundos de cima deixaram de ser por PLANO e
  passaram a vir COM a Brilhante. Os planos saíram das telas e um membro
  do pacote via o Aura trancado no card que o time tinha acabado de
  pagar. Quem não tem Brilhante não tem sequer seletor de fundo — este
  gate é a defesa em profundidade para um pedido montado à mão.
- (linha ~277, `if ('birthdate' in b) {`) Data de nascimento (pedido único do Início a quem não a tem; e, desde a Rodada 28, o passo
  "Quando você nasceu?" do onboarding de quem entrou com Google/Apple). SET-ONCE: se já
  existir, não deixa mudar (evita a passagem trivial menor→adulto).
- (linha ~287, `if (cadastroEmCurso(req.user) && menorQueIdadeMinima(v)) await recusarMenor(req…`) Rodada 29G: no cadastro, menor de 18 não fica com conta.
- (linha ~343, `const perfilIdade = await getUserById(req.user.id, 'birthdate');`) RODADA 29G: a data do cadastro por e-mail (metadata → users.birthdate) ou a do
  passo do onboarding. Menor de 18: a conta não fica. Sem data nenhuma a conclusão passa — o
  app da loja que ainda não tem o passo (iOS 33, Android 15) não pode ficar preso aqui; o app
  novo não deixa concluir sem ela. Quando só houver builds novos nas lojas, exigir aqui.
- (linha ~354, `invalidarSessaoDoPedido(req);`) Sem isto, o req.user cacheado (middleware/auth.js, TTL 60s) continuava a
  devolver onboarding_completo:false ao GET /api/me seguinte — o
  OnboardingGate do frontend mandava de volta para /onboarding em loop
  (achado 14-set: só aparecia em quem pulava a foto, porque esse caminho é
  rápido demais para os 60s do cache expirarem sozinhos).
- (linha ~383, `router.post(`) POST /api/me/avatar — upload da foto de perfil (multipart, campo "avatar";
  opcional "original" — RODADA 19, a foto ANTES do recorte 2:3, guardada para
  "Ajustar enquadramento" reabrir sem perder área/qualidade).
  Vai para o Supabase Storage (bucket "avatars", caminho
  `public/{userId}-{carimbo}.{ext}`) e guarda o URL em users.foto_url — e o
  sha256 dos bytes em users.foto_hash, no MESMO update. Cada foto é um objeto
  NOVO; a anterior é apagada depois de o banco estar gravado.
- (linha ~396, `filtroNSFW,`) Tijolo 1: bloqueia imagem explícita antes de guardar (avatar + onboarding)
- (linha ~397, `olheiroEntrada,`) 11-ago: barra foto sem futuro (pequena/corrompida/preta/estourada) antes de guardar
- (linha ~414, `const caminho = caminhoFotoNovo(userId, ext);`) Nome POR VERSÃO (22-set): cada foto é um objeto novo. Ver a nota em
  `caminhoFotoNovo` — caminho que muda de conteúdo é caminho que alguém,
  algures, serve desactualizado. A original leva um caminho PRÓPRIO
  (sufixo "-original"), nunca confundível com o recorte.
- (linha ~422, `const gravar = (destino, arquivo) => supabase.storage.from('avatars').upload(de…`) RODADA 27 (25-set) — gravar o recorte, gravar a original (opcional) e ler o estado atual da
  pessoa saem JUNTOS: eram três idas ao Supabase em série e nenhuma depende das outras (a
  rota levava seis a sete idas até responder; ver o resto depois do res.json). Sem upsert:
  o carimbo de tempo já torna o nome único, e se por absurdo colidisse, o certo é falhar
  aqui em vez de escrever por cima do objeto de outra chamada.
- (linha ~461, `const modoFoto = atual?.card_modo === 'foto';`) 3. UPDATE na tabela users. foto_url = a nova foto (fonte da geração IA).
     avatar_url (o que o card mostra): no modo 'foto' (Rodada 18,
     users.card_modo, migração 056) segue sempre a foto nova, mesmo
     havendo figurinha — é a escolha explícita da pessoa. Nos demais
     casos (modo 'figurinha' ou ainda sem escolha) SÓ é preservado se o
     avatar atual for mesmo uma figurinha nossa (utils/figurinhaRegra.js);
     aí o card continua a mostrá-la até a pessoa gerar de novo (nunca a
     foto crua) — comportamento de sempre, mantido como fail-safe se a 056
     ainda não tiver corrido. Sem figurinha, avatar_url vira a foto nova,
     sempre. (Hotfix 26: antes decidia por avatar_url ≠ foto_url, e a foto
     do Google copiada pelo trigger contava como figurinha: a foto nova ia
     para foto_url e o card nunca mudava.)
- (linha ~478, `const patchFoto = { foto_url: avatarUrl, avatar_url: novoAvatarUrl, foto_hash:…`) O HASH VAI NO MESMO UPDATE que o URL (22-set). Antes era gravado a
  seguir, num update próprio, e isso abria uma janela de milissegundos em
  que `foto_url` já era a foto NOVA e `foto_hash` ainda era o da ANTIGA.
  Quem pedisse figurinha dentro dessa janela caía no reuso de slot — que
  compara o fingerprint do slot com o `foto_hash` — e recebia a figurinha
  velha de volta. Uma linha só fecha a janela: ou grava tudo, ou nada.
  foto_original_url só entra no patch quando há original nova — sem ela,
  uma original antiga (se houver) fica exatamente como está.
- (linha ~519, `res.json({ foto_url: avatarUrl, avatar_url: novoAvatarUrl, foto_original_url: o…`) figurinha_ativa (Rodada 28): o que o card mostra agora, pela regra única — as telas não comparam URLs.
- (linha ~522, `faxinaDaFotoNova({ atual, caminho, caminhoOriginal, originalUrl, novoAvatarUrl,…`) RODADA 27 — a pessoa já tem o que precisa; o resto é faxina e adiantamento.
- (linha ~527, `router.put(`) PUT /api/me/avatar/recorte — RODADA 19: "Ajustar enquadramento" regrava só
  o recorte 2:3 (multipart, campo "recorte"), sem tocar em foto_original_url.
  O CropModal (cliente) já reabriu sobre a foto original guardada — ou, sem
  ela (foto antiga, fail-safe), sobre o recorte atual — e manda aqui só o
  resultado. A TRAVA DE HASH passa a ser a do recorte novo: é ele que a
  geração de figurinha usa.
- (linha ~550, `const caminho = caminhoFotoNovo(userId, ext);`) RODADA 27 — ler o estado e gravar o recorte novo saem juntos (não dependem um do outro).
  Sem foto, não há o que reenquadrar: o objeto que subiu à toa é apagado.
- (linha ~584, `faxinaDaFotoNova({ atual, caminho, caminhoOriginal: null, originalUrl: null, no…`) RODADA 27 — a foto anterior sai e os derivados da nova ficam prontos DEPOIS da resposta.
- (linha ~589, `const KIT_URL =`) O PROMPT DA FIGURINHA vive em prompts/figurinha.js (fonte única, 17-set).
  Aqui ficou só a chamada: montarPrompt(kitId). O prompt antigo (PROMPT_BASE
  de 5.375 caracteres + kitPrompt em cinco pontos + kitChecklist) foi REPROVADO
  na bancada de 49 figurinhas — 1,6/5 contra 4,1/5 do que está agora lá. Não
  voltar a escrever prompt dentro desta rota: a bancada importa do mesmo módulo,
  e é isso que garante que o que se mede é o que está no ar.
  Kit Futty (referência) no Supabase Storage — usado na composição final (ETAPA 3).
  Assets dos kits em bucket PÚBLICO próprio ('kits') — são assets do app, não PII.
  (Antes viviam em avatars/Kits/; o tijolo 1C privatizou avatars e partia o fal +
  as thumbnails. Movidos para 'kits' público, que a privatização não toca.)
- (linha ~604, `const KITS_IA = {`) Catálogo de kits geráveis. `ativo:false` → 400 (ainda sem asset próprio no
  Storage). Espelha os 5 ids do frontend. `acento` é a cor de destaque do kit
  (usada no cartaz e na composição do app). A frase do kit para a IA NÃO vive
  aqui: está em prompts/figurinha.js, uma por kit.

  22-set (SPEC-FIGURINHA-3): o campo `planos` (Free/Pro/Elite) saiu — quem
  pode GERAR um kit novo é o DIREITO (utils/direitoBrilhante.js), não plano
  nenhum; quem já gerou um kit pode sempre voltar a vesti-lo (PUT /api/me/kit,
  sem gate nenhum). Nenhum kit é mais "grátis" ou "pago" em si — o que é pago
  é a Brilhante inteira.
- (linha ~626, `ativo: true,`) asset escolhido pelo dono (31-jul): white-gold-c1 → kit3
- (linha ~631, `ativo: true,`) asset escolhido pelo dono (31-jul): elite-gold-c1 → kit4
- (linha ~636, `ativo: true,`) 5º kit do lançamento (31-jul): royal-purple-c3 → kit5. Par do Elite Gold.
- (linha ~645, `function caminhoNoBucket(urlPublico, bucket) {`) O bucket "avatars" é PRIVADO (Tijolo 1C) — um users.foto_url guardado como URL
  "público" do Storage já não é descarregável por ninguém de fora (nem a própria fal.ai,
  que busca a imagem do lado dela). Estas duas funções extraem o CAMINHO desse URL
  legado e emitem um URL ASSINADO de vida curta, o único que a fal consegue mesmo buscar.
- (linha ~662, `` const caminhoFotoNovo = (userId, ext) => `public/${userId}-${Date.now()}.${ext}… ``) ── Nomes de ficheiro POR VERSÃO (22-set) ────────────────────────────────────

  Antes, a foto ia sempre para `public/<userId>.<ext>` e a figurinha para
  `public/<userId>-ai-<kit>.png`, com upsert por cima. Um caminho que muda de
  conteúdo é um convite a cache velho: navegador, WebView, CDN e qualquer
  proxy pelo caminho podem servir a versão anterior, e não há como pedir para
  esquecerem. Com o carimbo de tempo no nome, cada versão é um OBJETO NOVO —
  URL diferente, cache sem nada a dizer.

  Quem já tem ficheiro no nome antigo fica como está até trocar de foto: a
  LEITURA sai sempre de `users.foto_url` / `avatar_url`, que guardam o caminho
  completo, e por isso aceita os dois padrões sem saber a diferença.
- (linha ~675, `` const caminhoFotoOriginalNovo = (userId, ext) => `public/${userId}-original-${D… ``) RODADA 19 — sufixo "-original" para nunca colidir com o nome do recorte
  (os dois podem nascer no MESMO milissegundo, no mesmo pedido).
- (linha ~709, `function faxinaDaFotoNova({ atual, caminho, caminhoOriginal, originalUrl, novoA…`) O que sobra de trocar a foto e NÃO precisa segurar a resposta (RODADA 27, 25-set):
    · apagar a foto e a original anteriores. Só depois de o banco estar gravado: se apagasse
      antes e o update falhasse, a pessoa ficava sem foto nenhuma. Ficou depois da RESPOSTA
      porque já não há update a esperar; o pior caso continua sendo um arquivo órfão (logado);
    · deixar prontos os derivados que as telas vão pedir da foto nova (utils/derivadosMidia.js),
      a partir dos bytes que o motor já tem: o primeiro pedido da própria pessoa deixa de pagar a
      ida ao Storage e o sharp.
  Não lança e ninguém a espera.
- (linha ~738, `const TETO_HISTORICO_FIGURINHAS = 10;`) RODADA 19 — teto de "Minhas figurinhas" (decisão do dono, 23-set).
  RODADA 21 (24-set) — subiu de 6 para 10: gerações mais generosas enchiam o
  histórico mais depressa (Minha Figurinha sozinha já dá 10).
- (linha ~779, `async function baixarFotoConferida(caminho, hashEsperado) {`) Baixa a foto e confirma que é a que a tabela diz ser a atual.

  Existe por causa do relato de 22-set (foto nova, figurinha da foto antiga).
  A causa nunca se reproduziu em bancada — o download autenticado devolveu
  sempre a versão certa —, mas a verificação é barata e o que ela evita é caro:
  uma figurinha da foto errada com o dinheiro já gasto. Se o hash não bater,
  tenta de novo (pode ser propagação), e ao fim de três tentativas recusa sem
  chamar a fal e sem contar quota.
- (linha ~823, `const MSG_FOTO_RECUSADA = 'Essa foto não deu certo. Escolha outra: de frente, c…`) 6-out (decisão do dono): cabeça cortada (ou braço extremo na lateral) nas DUAS tentativas → a FOTO fica recusada. Um pedido novo com a
  mesma foto é barrado ANTES da fal (FOTO_RECUSADA), sem débito. A identidade é o foto_hash (sha256 dos bytes
  da foto guardada), não o nome do arquivo nem a conta: foto nova = hash novo = libera. Migração 080 (fotos_recusadas).
- (linha ~891, `async function pintarFigurinha({ req, userId, perfil, origem, direitoUsado, kit…`) A PINTURA em si — era o corpo de POST /api/me/avatar/ai (Rodada 29B, bloco 2, A: passou a rodar em
  segundo plano, pela fila de utils/geracaoJobs.js). Baixa a foto conferida, pinta (fal), audita a
  coroa, grava a figurinha e o slot e, SÓ DEPOIS de ela existir, debita o direito. `etapa(nome)` avisa
  em que pé está (o app mostra 'preparando a foto → pintando o uniforme → acabamento'). Lança HttpError
  como sempre lançou; quem chama transforma isso no desfecho do job (e, como antes, no status
  'falhou' do usuário). O pedido HTTP pode já ter respondido: `req` só serve para o IP, o usuário e
  a invalidação da sessão.
- (linha ~903, `if (await fotoEstaRecusada(perfil.foto_hash)) throw new HttpError(422, MSG_FOTO…`) 6-out: foto já recusada não chega à fal — esta é a última porta antes do dinheiro (a da POST é a primeira).
- (linha ~905, `const temporarios = [];`) ETAPA 0 — a foto que vai à IA (17-set, variante 6 da bancada): faixa de
  18% no topo + corte QUADRADO 1024×1024 com a cabeça a 12% do topo.
  A receita vive em utils/entradaFigurinha.js e a bancada usa a MESMA.
  Porquê quadrado: ganhou em 6 das 7 fotos (4,1/5 contra 4,0 do retrato) e
  custa menos — a fal cobra os tokens da imagem de ENTRADA, e o quadrado
  baixou a chamada de US$0,132 para US$0,112. A SAÍDA continua 1024×1536.
  Upload no Supabase (URL assinado) em vez de data URI: é o formato de input
  confirmado no schema do fal — não se arrisca uma geração paga noutro.
  Tudo o que é temporário nesta geração (o pad e a imagem entre passadas)
  fica aqui para ser apagado no fim — com nomes por versão, ninguém os
  sobrescreve, portanto é a limpeza que tem de os levar.
- (linha ~922, `const fotoBuf = await baixarFotoConferida(caminhoFoto, perfil.foto_hash);`) download() autenticado (SDK) em vez de fetch(url pública) — o bucket é
  PRIVADO (Tijolo 1C), um fetch simples do URL "público" devolve 400.
  TRAVA ANTES DE GASTAR (22-set). A foto que se baixou tem de ser a que a
  tabela diz ser a atual — senão a figurinha sairia da foto errada e o
  dinheiro já estaria gasto quando alguém percebesse. Três tentativas com
  2 s de intervalo: se for atraso de propagação, passa; se for outra
  coisa, ninguém paga por ela.

  Só corre quando há `foto_hash` gravado: contas antigas (antes da
  migração 048) não têm, e barrá-las seria inventar um defeito.
- (linha ~1016, `console.error('[avatar-ai] erro fal:', { status: err.status, message: err.messa…`) SEGURANCA-REVISAO-10SET.md secção 3 (10-set): era logada a resposta
  inteira do fal (body/response, que pode incluir o inputUrl assinado
  enviado no pedido) — fica só o código de erro e a mensagem curta.
- (linha ~1025, `if (Array.isArray(corpo?.detail) && corpo.detail.some((d) => d.type === 'file_d…`) Bug corrigido (14-set): em 401/403 a fal devolve `detail` como STRING
  ("Forbidden"), não array — .some() nessa string derrubava com
  TypeError e escondia a causa real. Só chama .some() se for array.
- (linha ~1080, `const lateralAviso = Math.round(h * 0.15);`) HIERARQUIA DOS DEFEITOS (11-ago, dono): braço tocando a borda lateral NÃO
  reprova — é linguagem de cromo (Panini/FIFA cortam braço na moldura) e era
  a causa nº1 de retry (~31% de custo a mais). Vira AVISO no log. Rede de
  segurança: contacto EXTREMO (>60% da altura colada) ainda reprova.
- (linha ~1124, `const defeitoDaFoto = (v) => v.borda.topo.cortado || v.achatamento.cortada || v…`) 6-out: "defeito da foto" = a cabeça cortada (o topo na borda, ou a coroa achatada) OU o braço EXTREMO na lateral
  (>60% da altura colada). Só as DUAS tentativas com defeito recusam a FOTO; o braço colado normal (só aviso) e a
  2ª tentativa caída por outro motivo não marcam nada.
- (linha ~1152, `await recusarFoto(userId, perfil.foto_hash);`) 6-out: a foto reprovou nas duas tentativas (cabeça cortada ou braço extremo) → recusada. O próximo pedido com ela é barrado antes da fal.
- (linha ~1172, `const caminho = caminhoFigurinhaNova(userId, kitId);`) Um ficheiro POR KIT E POR VERSÃO → os slots não se sobrepõem entre si, e
  a figurinha nova não escreve por cima da velha (22-set). Sem upsert: o
  carimbo de tempo torna colisão impossível, e se algum dia houvesse, o
  certo é rebentar aqui em vez de apagar o trabalho de outra chamada.
- (linha ~1204, `invalidarSessaoDoPedido(req);`) RODADA 17 — nota completa no 'gerando', mais acima.
- (linha ~1206, `const figurinhaAntiga = caminhoNoBucket(slot?.avatar_url, 'avatars');`) RODADA 19 (decisão do dono, 23-set): a figurinha anterior DESTE kit
  já não é apontada por ninguém (o slot e o users.avatar_url acabaram de
  mudar) — mas em vez de sair do bucket, vai para "Minhas figurinhas"
  (user_avatar_historico, migração 057). custo_cents fica null: é o custo
  de QUANDO ELA foi gerada, que não foi guardado antes desta rodada — só
  passa a existir para gerações futuras (não há como recuperar retroativo).
- (linha ~1217, `const custoCents = conta.semHeader === conta.chamadas ? null : conta.usd * 100;`) Pacote anti-abuso (11-ago): soma o gasto do dia, guarda o log de IP e
  dispara alertas/auto-freeze se algum sinal bater. Fire-and-forget (nunca
  derruba a resposta — a figurinha já foi entregue ao utilizador).
  17-set: vai o custo REAL em cêntimos, somado de todas as chamadas desta
  geração (retry incluído). `null` só quando a fal não mandou header nenhum
  — nesse caso quem decide o valor é o antiAbusoIA, não este sítio.
- (linha ~1232, `registrarGeracao({ userId, ip: req.ip, custoCents, teamId: direitoUsado?.fonte…`) Rodada 28: o time que pagou (pacote) vai junto — é o custo por time e por mês do Gabinete.
- (linha ~1285, `router.post(`) POST /api/me/avatar/ai — gera a Figurinha BRILHANTE a partir da foto atual
  (receita V6 por omissão, ver utils/geracaoFigurinha.js) e guarda em
  avatars/public/{userId}-ai-{kit}-{carimbo}.png, separada da foto real.

  SPEC-FIGURINHA-3 (22-set): toda geração nasce PAGA. Sem direito (crédito ou
  pacote do time) → 403 SEM_DIREITO. `LIMITES_IA` por plano e
  `users.avatar_ia_mes` deixaram de mandar aqui — a figurinha grátis é a
  COMUM (a foto na moldura), que não passa por esta rota nem custa nada.
- (linha ~1305, `const assincrono = req.body?.assincrono === true;`) RODADA 29B (bloco 2, A) — uma pintura por vez por pessoa: quem já está pintando acompanha a que existe,
  não abre uma segunda (e não se debita duas vezes). Antes do slot-reuse de propósito.
- (linha ~1335, `const { data: slot } = await supabase`) --- IDEMPOTÊNCIA: se já existe slot deste kit E foi gerado da MESMA foto
  atual, veste-o e NÃO gera nem gasta quota. (build 9, achado real: uma
  foto NOVA não invalidava o slot — o motor servia o avatar da foto
  ANTIGA como se fosse da nova. foto_fingerprint = foto_hash, migração 052,
  guardada no slot no momento da geração; se alguma das duas faltar
  (slot antigo, antes desta coluna, ou foto_hash ainda não gravado),
  NÃO reutiliza — gera de novo é o lado seguro do erro.)
- (linha ~1360, `invalidarSessaoDoPedido(req);`) RODADA 17 — nota completa no 'gerando' logo abaixo.
- (linha ~1378, `if (await fotoEstaRecusada(perfil.foto_hash)) throw new HttpError(422, MSG_FOTO…`) 6-out: foto já recusada (cabeça cortada nas duas tentativas) não gera de novo — nem fal, nem débito, nem job.
  Vem depois do slot-reuse de propósito: vestir uma figurinha que já existe continua de graça.
- (linha ~1382, `await marcarFigurinhaStatus(userId, 'gerando');`) Figurinha automática (12-set): marca 'gerando' AQUI — depois de kit/plano/
  slot-reuse/quota (validações de uso normal do endpoint, não específicas do
  cadastro), mas ANTES do e-mail-gate. Motivo: no fluxo do Onboarding (fire-
  and-forget logo após o upload), o e-mail-gate é o erro mais provável de
  todos — quase toda conta nova via email+senha ainda não confirmou o e-mail
  nesse instante — e o polling do Início precisa ver 'falhou' nesse caso, ou
  fica preso mostrando "criando..." para sempre. Try/catch amplo a partir
  daqui (não só ao redor da geração): qualquer gate reprovado também conta.
- (linha ~1391, `invalidarSessaoDoPedido(req);`) RODADA 17 — invalida o cache de sessão (60s, middleware/auth.js) nas 4
  marcações de figurinha_status (aqui e as 'pronta'/'falhou' mais abaixo).
  Investigado antes de adicionar: HOJE isto não muda nada sozinho — esse
  cache guarda o USER do Supabase Auth (id/email/user_metadata), nunca as
  colunas de `users`, e obterMe() lê figurinha_status com uma query
  própria e SEMPRE fresca (obterPerfilResiliente), sem cache nenhum por
  cima. GET /api/me e /api/inicio já respondem "na hora" sem esta linha.
  Fica mesmo assim por pedido explícito e por ser grátis: mesmo padrão já
  usado para onboarding-completo/tour-visto (linhas ~237-278), e barato
  o suficiente para não pesar a decisão — se um dia figurinha_status
  entrar em req.user (ex.: um JWT custom claim), esta chamada já está no
  sítio certo em vez de ser mais uma coisa a lembrar depois.
- (linha ~1406, `const provedor = req.user.app_metadata?.provider;`) PACOTE ANTI-ABUSO DE CUSTO (11-ago) — três gates, só a partir daqui (uma
  geração real vai custar dinheiro; o slot-reuse acima nunca passa por aqui).

  1. E-MAIL-GATE: contas Google confirmam e-mail no próprio login (passam
     direto); contas email+senha precisam ter clicado no link de confirmação.
     Só trava a GERAÇÃO — nunca cadastro, login ou navegação.
- (linha ~1432, `invalidarSessaoDoPedido(req);`) RODADA 17 — nota completa no 'gerando', mais acima.
- (linha ~1436, `const { job, jaEmAndamento } = geracaoJobs.reservar({ userId, kitId });`) RODADA 29B (bloco 2, A) — A PINTURA DEIXOU DE SEGURAR O PEDIDO. Reserva a vez (uma por vez por pessoa:
  o toque duplo recebe a pintura do primeiro), anota na tabela e devolve na hora `{ jobId,
  estimativaSegundos }`; o app consulta GET /api/figurinha/job/:id. O direito só é debitado lá dentro,
  DEPOIS da figurinha gravada — um job que morre a meio não custa nada a ninguém.
  `assincrono` vem do app novo. Os apps já publicados não o mandam e esperam a figurinha na resposta:
  para eles o pedido espera a MESMA pintura terminar, como sempre esperou (mesmos códigos de erro).
- (linha ~1446, `if (assincrono && tarefasPintura.ativas() && job.persistido) {`) RODADA 29B (bloco 2-A2) — com o Cloud Tasks ligado, a pintura roda DENTRO de um pedido (o da tarefa), porque o
  Cloud Run só dá CPU enquanto há pedido: o POST só enfileira e responde. O app antigo (sem `assincrono`) espera a
  figurinha na resposta — esse pedido já segura a CPU, então pinta aqui mesmo, como sempre. Sem a linha na tabela
  (069 por aplicar) ou se o Cloud Tasks recusar, cai na fila em memória: o app consulta e a CPU anda.
- (linha ~1571, `const { data: slot } = await supabase`) ACHADO DA VARREDURA (22-set): esta rota só veste o que JÁ existe num slot
  — nunca gera nada, nunca custa direito. O gate de `plan` que havia aqui
  era do modelo Free/Pro/Elite (aposentado na SPEC-FIGURINHA-3) e, como
  ninguém mais tem `plan` diferente de 'free', barrava QUALQUER kit que não
  fosse o dark-gold para todo mundo — mesmo para quem já tinha aquela
  Brilhante gerada e só queria voltar a vesti-la. O direito de gerar já foi
  gasto quando o slot nasceu; vestir de novo é livre, sempre.
- (linha ~1585, `let avatarUrl = slot?.avatar_url || null;`) RODADA 21 — "uniformes guardados": o slot é a fonte normal (guarda a
  ÚLTIMA versão de cada kit e nunca é apagado, só substituído quando o
  MESMO kit é regerado). Ainda assim, sem slot, olha para o histórico
  (user_avatar_historico) antes de mandar gerar — mesma rede de segurança
  do PUT /api/me/avatar/historico/:id, para uma versão antiga desse kit
  nunca custar uma geração nova só porque o slot dela não sobreviveu.
- (linha ~1624, `router.put(`) PUT /api/me/avatar/modo { modo: 'foto' | 'figurinha' } — Rodada 18: quem
  tem figurinha (IA) escolhe o que o card mostra. 'foto' põe avatar_url =
  foto_url (a figurinha continua no slot, nada é apagado); 'figurinha' repõe
  o slot do kit ativo (ou outro já gerado, se o ativo não tiver um). Só quem
  tem pelo menos um slot pode escolher 'figurinha'. A escolha fica em
  users.card_modo (migração 056, fail-safe) para sobreviver à próxima troca
  de foto — ver o `modoFoto` em POST /api/me/avatar, acima.
- (linha ~1701, `router.get(`) GET /api/me/avatar/historico — RODADA 19: as últimas figurinhas de
  "Minhas figurinhas" (user_avatar_historico, migração 057). Fail-safe: sem
  a migração, devolve lista vazia (a galeria some sozinha, sem erro na tela).
- (linha ~1769, `router.put(`) PUT /api/me/avatar/enquadro { x, y, escala } — Rodada 29B (bloco 3, E): grava o recorte da
  MINIATURA do avatar (a janela quadrada que aparece no Início, no ranking, no sorteio…). Vale para
  o arquivo que é o avatar AGORA (foto crua ou figurinha): trocar de foto/uniforme leva a outro
  arquivo e o recorte velho para de valer sozinho. O motor passa a servir TODAS as miniaturas desse
  arquivo — as dela e as que as outras pessoas veem — no enquadramento escolhido (utils/recortesAvatar.js).
  200 { recorte, avatar_url } (o avatar_url já sai com o recorte, pelo proxy) ·
  400 recorte inválido · 409 o avatar não é um arquivo nosso (foto do Google, silhueta) · 503 sem a migração 070.
- (linha ~1838, `router.arquivarFigurinhaAntiga = arquivarFigurinhaAntiga;`) RODADA 19 — testável sem chamar a fal (custaria dinheiro de verdade): os
  testes de user_avatar_historico chamam arquivarFigurinhaAntiga() direto.

## routes/aviseMe.js

- (linha ~1, `const express = require('express');`) Futty v2.0 — POST /api/avise-me: "Quero ser avisado quando o Futty chegar nas lojas" (Rodada 29B, F).

  Pública DE PROPÓSITO: quem chega das redes não tem conta nem app. Por isso o cuidado é outro:
    · limiter por IP real, 10 por hora (middleware/limiters.js#criarLimiteDeAviseMe) — o IP só vive na memória do
      limiter, nunca na tabela;
    · validação do e-mail e da origem (utils/aviseMe.js) e uma isca para robô (campo `site`, escondido na tela):
      preenchida, finge que deu certo e não grava;
    · responde igual para e-mail novo e e-mail que já estava na lista (201 nos dois): a rota não serve para descobrir
      quem está na lista.
  NÃO manda e-mail nenhum: o "chegou nas lojas" sai no dia do lançamento, pelo Gabinete. A lista mora em
  `avisos_lancamento` (migração 068).

## routes/brilhantes.js

- (linha ~46, `const lerTimes = async () => {`) Rodada 29B (bloco 2, B — conta pesada): as quatro leituras não dependem uma da outra e corriam EM FILA (~1,2 s de motor,
  medido); agora correm juntas e a resposta leva o tempo da mais lenta (o direito, ~2 idas).
- (linha ~71, `const lerComprasAtivas = async () => {`) Pagamentos P1: há ao menos uma compra creditada? Sem a 064, false (nunca quebra a tela).

## routes/campeonatos.js

- (linha ~1, `const express = require('express');`) Futty v2.0 — Campeonatos (modelo N times). Vaga 11B.
  Auto-contido no Storage (utils/campeonatoStore) — DDL nenhum, ranking intocado.
  A rota antiga (routes/campeonato.js, 026 de 2 times fixos) fica intocada.
- (linha ~30, `async function computeSelos(uid, teamIds) {`) GET /api/me/selos — (Vaga 11C) selos de honra do utilizador, lidos do Storage
  dos campeonatos + do ranking (sem DDL). A faixa antiga morreu.
   - campeonato: pódio 1º/2º/3º de campeonato terminado onde o user está no time —
     ATIVO até 30 dias, depois histórico (vitrine).
   - ranking: posição atual (1º/2º/3º) na equipa — VIVO (sem prazo; sai se cair).
   - artilheiro: os resultados do campeonato não guardam golos por jogador → dado
     inexistente hoje (v2 na SPEC).
  Prioridade no cromo: campeonato > (artilheiro) > ranking.
- (linha ~44, `const { data: teamsData } = await supabase.from('teams').select('id, nome').in(…`) Velocidade 2 (12-set): era 1 query de nome POR equipa, dentro do loop
  sequencial abaixo — agora 1 query só, com .in(), para todas as equipas.
- (linha ~105, `const vistos = new Set();`) Achado 12: mesmo tipo + mesmo time só uma vez (ex.: "RANKING 1º" duplicado).
  `id` já é único por time (rank:<teamId>) ou por campeonato (camp:<campId>).
- (linha ~133, `res.set('Cache-Control', 'private, max-age=30');`) Rodada 29B (B): os selos mudam poucas vezes por semana (e o motor já os guarda 2 min): o navegador pode reaproveitar a resposta por
  30 s. `private` + `Vary: Authorization` — é de UMA pessoa, e outra conta no mesmo aparelho nunca recebe a de quem saiu.
- (linha ~210, `const dataJogo = game.data ? dataNoFuso(game.data, fusoDoTime(team)) : null;`) 29I (achado 83): a data do jogo no nome do campeonato é a do CAMPO (fuso do time), não a do servidor.
- (linha ~261, `let plantel;`) Composição à mão (Vaga 11C, OPCIONAL): plantel[i] = jogadores do time i
  (membros por user_id + convidados por nome). Times só com nome continuam
  válidos. Sanitiza: 22 por time, só campos conhecidos.
- (linha ~359, `res.json({ campeonato: enriquecer(camp), equipa: { nome: team.nome, slug: team.…`) logo_url (achado 121, 29J): og:image da prévia do link, quando o time tem logo.

## routes/compras.js

- (linha ~1, `const crypto = require('node:crypto');`) Futty v2.0 — Compras na loja (Pagamentos P1, 26-set). Ver docs/COMPRAS.md.

  O app compra pela App Store / Play Store através do SDK do RevenueCat; o RevenueCat
  avisa este motor pelo webhook, e é o webhook que credita (utils/compras.js). O app nunca
  credita nada sozinho: o que ele manda em "sincronizar" só vira crédito depois de a API
  do RevenueCat confirmar a transação.

  POST /api/compras/webhook/revenuecat — sem sessão. A autorização é o header
    `Authorization: Bearer <RC_WEBHOOK_SECRET>` (o valor que o Pedro cola no painel do
    RevenueCat), comparado em tempo constante. Fora do limiter geral por IP (os IPs do
    RevenueCat não são gente), com limiter próprio de 120/min.
    Responde 200 sempre que conseguiu REGISTRAR o evento — creditado, repetido ou
    ignorado — para o RevenueCat não repetir para sempre; 5xx só se o banco falhou (aí o
    RevenueCat reenvia, e o índice único de `compras` segura o crédito em dobro).

  GET  /api/compras/minhas     — a tela "Minhas compras".
  POST /api/compras/sincronizar — "Restaurar compras" e o webhook atrasado: o app manda as
    transações que o SDK conhece; o motor só credita o que a API REST do RevenueCat
    confirmar para esta pessoa (RC_API_KEY, chave secreta de servidor).

  Fábrica com tudo injetável (Supabase, compras, segredo, fetch): tests/compras-rotas.test.js
  corre sem banco e sem rede.

## routes/denuncias.js

- (linha ~1, `const express = require('express');`) Futty v2.0 — Denúncias + triagem IA (Tijolo 3, Fase B). Segue a SPEC-DENUNCIAS.
  Fluxo: denunciar (anti-abuso) → triagem (Fable/regras, leis duras) → auto-resolve
  OU fila do admin → decisão do admin → desfecho. Dono só vê agregados.
- (linha ~79, `if (teamId && !(await getRole(teamId, req.user.id))) {`) SEGURANCA-REVISAO-10SET.md secção 3 (10-set): sem isto qualquer
  utilizador logado denunciava conteúdo de um time onde nunca esteve
  (bastava adivinhar/enumerar um UUID). targetType 'perfil' não tem
  teamId (denúncia de perfil não é presa a nenhum time) — só se aplica
  quando o alvo pertence a um time. Mesmo padrão já usado em
  feed.js (POST /api/feed/denuncias).

## routes/diagnostico.js

- (linha ~1, `const express = require('express');`) Futty v2.0 — Diagnóstico do app (VELOCIDADE 4).

  O app mede-se a si próprio e a pessoa envia o que mediu. Serve para responder
  com número a "está lento": o relatório separa o tempo do MOTOR (Server-Timing,
  posto pelo backend em todo pedido) do tempo de REDE, e mostra quanto demora
  entre tocar numa aba e a tela aparecer.

  O que entra aqui não tem corpo de pedido, token, nem conteúdo de utilizador —
  só rotas, estados e tempos. Ver frontend/src/lib/diagnostico.js.

## routes/feed.js

- (linha ~31, `const LIMITE_FEED = 60;`) VELOCIDADE 6A (15-set): o feed vinha SEM limite — uma equipa antiga puxava
  todos os jogos e todos os posts desde sempre, em cada abertura da tela. 60 de
  cada lado dá mais de um mês de Resenha para uma equipa que joga por semana.
  A paginação "ver mais antigos" chegou na Rodada 29B (ver PAGINA_FEED, abaixo).
- (linha ~36, `const PAGINA_FEED = 20;`) RODADA 29B (bloco 2, B — conta pesada): o app novo pede o feed em PÁGINAS (`?limite=20`, e `?antes=<created_at do último>` para a
  seguinte). Sem `limite` a resposta é a de sempre (até 60 jogos + 60 posts de uma vez): os apps já publicados não conhecem
  `proximo` e ficariam sem como ver o resto.
- (linha ~42, `const UPLOAD_MAX_BYTES = 12 * 1024 * 1024;`) Upload: lê o ficheiro para memória; envia-se depois ao Supabase Storage.

  RODADA 15 (16-set): o teto geral desceu de 50MB para 12MB — fotos JPG/PNG/
  WebP passam por compressão (ver comprimirImagem) antes de gravar, então
  chegam bem abaixo disto; GIF tem o seu PRÓPRIO teto, mais apertado
  (GIF_MAX_BYTES), porque não é comprimido (perderia a animação). Vídeo
  segue sem transcodificação — 12MB é o teto dele também agora (era 50MB).
- (linha ~149, `const { data } = await supabase`) VELOCIDADE 6A (15-set): o autor vem EMBUTIDO. Antes, os ids dos autores dos
  comentários só se sabiam depois desta query, o que obrigava a query de
  `users` a esperar por ela — uma ida em série a mais. Com o autor embutido,
  a query de users cobre só os jogos e os posts, que já se conhecem, e as
  duas correm na mesma onda.
- (linha ~174, `async function comprimirImagem(buffer, mimetypeOriginal, extOriginal) {`) Comprime uma foto estática antes de gravar (Rodada 15): respeita a
  orientação EXIF, reduz o lado maior a COMPRESSAO_LADO_MAX (nunca amplia) e
  converte para WebP. Fail-open: se o sharp falhar (arquivo corrompido de um
  jeito que passou pelo NSFW mas não pelo decode aqui), grava o ORIGINAL em
  vez de derrubar o upload — melhor uma foto grande que nenhuma foto.
  Devolve { buffer, mimetype, ext }.
- (linha ~219, `const { data: memberships } = await lerComFuso((novas) => supabase`) Equipas do utilizador
  29I (achado 83): o fuso do time vem junto (mesma consulta) — o jogo da Resenha é lido no relógio do campo.
- (linha ~239, `const paginado = req.query.limite != null;`) VELOCIDADE 6A (15-set): eram 10 idas ao banco EM SÉRIE. Agora são 3 ondas.

  Paginação (opt-in): cada lista pede UM a mais que a página, para saber se há mais; `antes` é o cursor (created_at).
- (linha ~364, `fuso,`) 29I (achado 83): a data e a hora do jogo se leem neste fuso
- (linha ~437, `if (mediaList.some((m) => !urlDeMidiaValida(m.url, req))) {`) SEGURANCA-REVISAO-10SET.md secção 3 (10-set): só aceita URLs https do
  Storage do Supabase ou do proxy do próprio backend (/api/media/) —
  impede que o campo vire um redirect/SSRF para qualquer host.
- (linha ~593, `const { data: media } = await supabase`) Peça 2 (Tijolo 1B): antes do cascade na BD, junta as URLs da média para
  apagar os OBJETOS no Storage — senão ficam órfãos, públicos e para sempre.
- (linha ~697, `fuso: fusoDoTime(game.teams),`) 29I (achado 83)
- (linha ~714, `}, { categoria: 'resenha' })`) 29I, bloco 3: o tipo "Resenha" do Perfil → Notificações
- (linha ~731, `filtroNSFW,`) Tijolo 1: bloqueia imagem explícita da resenha antes de guardar

## routes/figurinhaJob.js

- (linha ~1, `const express = require('express');`) Futty v2.0 — Em que pé está a pintura da figurinha (Rodada 29B, bloco 2, parte A).

  POST /api/me/avatar/ai devolve na hora `{ jobId, estimativaSegundos }` (routes/auth.js); o trabalho
  roda em segundo plano (utils/geracaoJobs.js) e o app pergunta aqui, a cada 3 s enquanto a aba está
  visível e ao voltar para ela:

    GET /api/figurinha/job/:id  →  { estado, etapa, progresso, avatar_url, estimativaSegundos,
                                     decorridoSegundos } + (pronta) { kit, figurinha_ativa }
                                   + (falhou) { erro, code, status }

  `estado`: na_fila | em_andamento | pronta | falhou. `etapa`: preparando | pintando | acabamento | pronta.
  `progresso` (0–1) avança pelo tempo estimado até 0,9 e segura ali; só 'pronta' vale 1 — nunca 100%
  antes de existir a imagem. Só o DONO da pintura a enxerga (outro usuário ou id inventado → 404).

## routes/gabinete.js

- (linha ~1, `const express = require('express');`) Futty v2.0 — Gabinete do Dono (/gabinete). Rota super-admin exclusiva.
  Camada de LEITURA agregada (série temporal, pulso, vida, marcos) + store editável
  (Operação/Publicidade). Lei da casa: o dono é CEGO ao conteúdo — só números.
  Receita: tabela compras (Pagamentos P1, migração 064). Publicidade (medição de ads) ainda não tem fonte real → "em breve"
  digno, SEM inventar números. Ver SPEC-GABINETE v3.
- (linha ~28, `const TETO_DIARIO_CENTS = Number(process.env.TETO_DIARIO_CENTS) || 5000;`) 17-set: o custo por geração deixou de ser constante aqui. Ele é MEDIDO na fal
  a cada chamada (header `x-fal-billable-units`, ver utils/falFila.js) e somado
  em gasto_ia_diario — o Gabinete passa a dividir custo_cents por geracoes do
  próprio período. A constante antiga (1,7 cêntimos) mostrava ao dono um número
  6,6× abaixo do real.
- (linha ~94, `supabase.from('campeonatos').select('nome, estado, campeao, criado_em'),`) A coluna de data desta tabela é `criado_em` (migração 026), não `created_at`:
  com o nome errado o PostgREST devolvia erro, `camps` caía para [] e o
  gráfico de campeonatos ficava eternamente a zero (15-set).
- (linha ~152, `let receitaDisponivel = false;`) Pagamentos P1: a receita existe a partir da primeira compra de loja (sandbox conta —
  é assim que o dono vê o painel acender no teste). Concessões do Gabinete não contam.
- (linha ~166, `receita_disponivel: receitaDisponivel,`) Pagamentos P1: true depois da 1ª compra de loja
- (linha ~197, `await adsStore.descarregar();`) As impressões vivem num acumulador em memória que só desce ao Storage de
  30 em 30 s (Velocidade 6A). Aqui o dono quer o número certo AGORA, por
  isso força o flush antes de ler — é uma tela de dono, não um caminho quente.
- (linha ~272, `const receita = comprasMes.error ? null : resumirReceita(comprasMes.data);`) Pagamentos P1: sem a 064, a receita diz que não sabe (null) em vez de mostrar 0.
- (linha ~332, `receita_mes: receita ? receita.receita_mes : null,`) Pagamentos P1 — US$ das compras de loja creditadas no mês (produção só). Tudo null
  enquanto a migração 064 não correr.
- (linha ~354, `const KITS_DISPONIVEIS = Object.entries(KITS_IA || {}).filter(([, k]) => k?.ati…`) ═══════════════════════════════════════════════════════════════════════════
  FIGURINHAS BRILHANTES (SPEC-FIGURINHA-3 §7 — bloco 2, 22-set)

  Enquanto a compra na loja não existe, é AQUI que o pedido vira produto: a
  pessoa toca em "Pedir ativação" (Planos/Figurinha), o pedido cai em
  `pedidos_ativacao`, e o dono ativa à mão nesta aba.

  Ativar o pacote NÃO gera nada em lote (§5, geração preguiçosa): cada membro
  gera quando abre o app. É o que impede um time de 25 custar US$2,80 na hora
  da ativação com metade das pessoas a nunca abrir o Futty outra vez.

  Depende da migração 054 (tudo) e da 055 (só o motivo da recusa). Sem a 054
  estas rotas dizem `indisponivel: true` em vez de listas vazias — uma lista
  vazia afirmaria "não há pedidos", que é uma mentira diferente de "ainda não
  dá para saber".
  ═══════════════════════════════════════════════════════════════════════════
- (linha ~379, `async function ultimasCompras() {`) Pagamentos P1 — as últimas 50 compras (loja, Gabinete e ignoradas), com quem e que time.
  null se a 064 ainda não correu: uma lista vazia afirmaria "ninguém comprou".
- (linha ~455, `const uso = {};`) Uso e custo REAL por time (a mesma verdade do gasto_ia_diario: o que a
  fal cobrou, gravado por geração). `sem_custo` conta as linhas antigas
  sem custo gravado, para o total não se fazer passar por completo.
  RODADA 28 (achado da Rodada 22): cada linha é UMA pessoa, com `geracoes` e o custo SOMADO
  delas (utils/direitoBrilhante.js#debitar) — `geradas` é a soma das gerações, não das linhas,
  e `jogadores` é quantos já gastaram vaga do pacote. O mês sai do log (migração 063).
- (linha ~478, `for (const m of equipas || []) if (!organizam.get(m.team_id)?.has(m.user_id)) m…`) Rodada 29B (E): quem só organiza o time não é jogador — não entra na conta dos jogadores do pacote.
- (linha ~597, `const { data: pedido } = await supabase`) Pagamentos P1: a concessão manual é uma "compra" da loja 'gabinete', preço 0 — fica
  em `compras` e aparece na receita como R$0. O comprador é quem pediu o pacote (ou
  quem criou o time, sem pedido). Ninguém é gerado aqui (geração preguiçosa).
- (linha ~626, `router.post(`) POST /api/super/gabinete/brilhantes/creditos { userId, quantidade } ou
  { email, quantidade } — soma créditos à pessoa (a "Minha Figurinha" dá 10,
  Rodada 21), resolve o pedido 'minha' pendente dela e avisa. `email` é para
  dar crédito a quem AINDA não tem pedido nem crédito nenhum (não aparece em
  nenhuma das duas listas da aba) — resolvido para userId aqui dentro, nunca
  no cliente.
- (linha ~662, `const { creditos: novo } = await aplicarCompra({`) Pagamentos P1: a concessão vira linha 'gabinete' (preço 0) em `compras`; a soma é a
  atómica da 064, o pedido 'minha' é resolvido e a pessoa recebe o push — tudo lá dentro.
- (linha ~728, `router.get(`) GET /api/super/gabinete/velocidade — aba Velocidade (Rodada 28, bloco E): p50/p95 por tela e por
  versão nos últimos 7 dias e as 5 rotas mais lentas, da telemetria ANÔNIMA. A conta (percentis) é
  feita no banco pela função da migração 061; aqui não chega nenhum evento individual.
- (linha ~750, `router.get(`) GET /api/super/gabinete/avise-me — a lista "Avise-me" (Rodada 29B, F; migração 068): total, por origem e os mais
  recentes. Com `?formato=csv` devolve o arquivo com TODOS os e-mails (para o dia do lançamento). Só o super-admin.
  O ENVIO do "chegou nas lojas" não existe ainda: é no dia do lançamento.

## routes/games.js

- (linha ~6, `const { jogadoresPorTimeDoTime } = require('../utils/jogadoresPorTime');`) item 68 (29I, bloco 3): o padrão do time
- (linha ~15, `const { codigoDoSorteio, jogoDoCodigo } = require('../utils/sorteioCodigo');`) o link curto /s/<código> (29I, bloco 3)
- (linha ~22, `function statusEfetivoJogo(game) {`) Estado efetivo do jogo (achado 9): "em_curso" só quando a hora do jogo já
  chegou e ainda não há resultado — nunca por causa do sorteio ter sido feito
  cedo. Calculado a cada leitura, não depende de um write acertar a hora certa.
- (linha ~32, `async function membrosDaEquipa(teamId) {`) Data curta (ex.: "12/06 · 20:30") para o corpo das notificações — no relógio do CAMPO (fuso do time, 29I achado 83), não no
  do servidor (o Cloud Run roda em UTC: "20:30" de São Paulo saía como "23:30").
- (linha ~52, `const porTime = jogadoresPorTime == null || jogadoresPorTime === '' ? jogadores…`) Item 68 (29I, bloco 3): sem número no pedido, o jogo nasce com o padrão do time (Ajustes); com número, é o "mudar só neste jogo".
- (linha ~88, `}, { categoria: 'jogos' })`) 29I, bloco 3: quem desligou "Jogos e presença" no Perfil fica de fora
- (linha ~112, `const ids = (games || []).map((g) => g.id);`) Contagem de confirmados por jogo (achados 109/116): enquanto o RSVP está aberto e ainda não
  fechado, a presença de verdade vive em rsvp_respostas — game_players só é sincronizado no
  "Fechar presença" (routes/rsvp.js). Fora disso (sem RSVP, ou já fechado), vale game_players,
  como sempre (o "Vou" simples de Jogo.jsx/Inicio.jsx escreve direto nele).
- (linha ~170, `const [gpResult, inativosResult, golsResult, votosResult] = await Promise.all([`) Achado 3/23: estas 4 leituras não dependem umas das outras (só de game.id/
  game.teams.id, já conhecidos) — corriam em série, uma round-trip a seguir à
  outra. Em paralelo.
- (linha ~330, `equipa: { nome: game.teams.nome, slug: game.teams.slug, cor: game.teams.cor ||…`) logo_url (achado 121, 29J): a prévia do link (functions/_shared/previaDoLink.js) usa o
  logo do time como og:image quando existe — "o mínimo" para a prévia parar de ser genérica.
  cidade (achado 112, 29K): o rabicho do fuso ("horário de São Paulo") precisa dela.
  cor (achado 114, 29K): o resultado já montado (DrawnTeams) pinta o cabeçalho de cada time com ela.
- (linha ~335, `jogo: { data: game.data || null, local: game.local || null },`) jogo (achado 112, 29K): quando e onde — a página pública mostrava só o time e os times sorteados,
  sem a informação que quem recebe o link no grupo foi mesmo procurar.
- (linha ~383, `const jaComecou = !!game.data && new Date(game.data).getTime() <= Date.now();`) Achado 9: sem resultado antes do jogo acontecer — exceto jogo histórico/
  retroativo (criado como "Já aconteceu"), que não tem essa trava.
- (linha ~467, `router.post(`) POST /api/games/:id/confirmar — confirma/cancela a própria presença.
  Rodada 9: `goleiro` é opcional. Sem ele no body, vale o que já estiver
  marcado naquele jogo (pelo jogador ou pelo admin) e, se ainda não houver
  linha, a flag do time (Rodada 10B: team_members.categoria === 'GR').
- (linha ~484, `if (confirmado && (await soOrganiza(game.teams.id, req.user.id))) throw new Htt…`) Rodada 29B (E): quem só organiza o time não entra na lista de presença (desmarcar continua valendo).
- (linha ~530, `const organizam = await idsQueSoOrganizam(game.teams.id);`) Rodada 29B (E): quem só organiza o time não joga — não entra no elenco nem pela checklist do admin.
- (linha ~603, `const jaComecou = !!game.data && new Date(game.data).getTime() <= Date.now();`) Achado 9: status só vira "em_curso" se a hora do jogo já passou — sorteio
  feito com antecedência (ou times definidos à mão) não adianta o estado.
- (linha ~668, `const organizam = await idsQueSoOrganizam(game.teams.id);`) Rodada 29B (E): o sorteio só recebe quem joga — quem só organiza o time fica de fora (utils/soOrganiza.js).
- (linha ~745, `const jaComecou = !!game.data && new Date(game.data).getTime() <= Date.now();`) Achado 9: status só vira "em_curso" se a hora do jogo já passou — sorteio
  feito com antecedência não adianta o estado (fica "agendado" + chip de
  times sorteados no frontend).
- (linha ~853, `if ('date' in b || 'time' in b) {`) Recombina data/hora (a coluna `data` guarda ambas). 29I (achado 83): data e hora são as do CAMPO — lidas e escritas no
  fuso do time, nunca no do servidor (UTC no Cloud Run: "20:00" virava 17:00 em São Paulo) nem no do aparelho de quem edita.
- (linha ~1010, `const fuso = fusoDoTime(team);`) Próximas N datas para o dia da semana escolhido (a partir de hoje). 29I (achado 83): "hoje", o dia da semana e a hora são
  os do CAMPO (fuso do time), não os do servidor — o Cloud Run roda em UTC, e "quinta 20:00" saía às 17:00 de São Paulo.
- (linha ~1040, `const porTime = jogadoresPorTimeDoTime(team);`) item 68 (29I, bloco 3): o padrão do time (sem ele, 5); o admin ajusta depois por jogo.

## routes/inicio.js

- (linha ~1, `const express = require('express');`) Futty v2.0 — GET /api/inicio: agrega TUDO que a tela Início precisa num
  round-trip só. Motivo (11-set): motor em São Paulo, utilizador em Lisboa
  (~240ms/pedido) — os ~13 pedidos que o Início disparava ao abrir davam 3-4s
  só de latência de rede, antes de qualquer dado chegar. Cada peça usa a MESMA
  função de services/inicio.js que a rota antiga (nunca diverge do JSON que
  outras telas já dependem — as rotas antigas continuam de pé).

  Fila de idas ao banco (Rodada 29B, bloco 2, B): vínculos → jogos → RSVP = 3. Tudo o que não depende de ninguém arranca
  no instante zero; o que depende do time principal (votação, campeonato) ou do próximo jogo (RSVP) arranca assim que a
  sua dependência chega — não quando uma onda inteira acaba.

  Promise.allSettled (via `seguro`, não Promise.all): se uma parte falhar (ex.:
  um time suspenso a meio da leitura), essa chave vem null e as restantes
  continuam — a tela não pode cair por causa de UM pedaço.
- (linha ~43, `const vinculosP = medir(res, 'vinculos', seguro(inicioService.obterVinculos(use…`) RODADA 29B (bloco 2, B — "conta pesada"). Medido com a conta pesada (super-admin, 2 times) e a leve (1 time): o
  /api/inicio levava ~990 ms de motor e 31 consultas nas DUAS — o que pesava era a FILA de idas ao banco (4 em série),
  não o volume. A fila era esta:
    1ª ida   os times (team_members) e os convites (team_members de novo)…
    2ª ida   …+ os pedidos pendentes (team_join_requests) e os jogos (games); só então o time principal era conhecido…
    3ª ida   …votação e campeonato do principal, e o jogo do próximo convite (loadGame)…
    4ª ida   …e o resto do RSVP (membros, respostas, fila) só depois do loadGame.
  Agora: UMA consulta de vínculos no instante zero, repartida entre todas as partes (11 consultas de team_members viram 1);
  os times saem na hora (o contador de pedidos pendentes corre ao lado, fora do caminho crítico); a votação e o campeonato
  arrancam assim que o principal é conhecido (sem esperar os jogos); e o RSVP do próximo jogo sai numa ida só (o time dele
  já veio na lista de jogos). Fila: vínculos → jogos → RSVP = 3 idas. A lista de jogos também parou de crescer com o
  histórico (ver obterConvites: os que vão acontecer + os 3 últimos de cada time, que é o que a tela mostra).
- (linha ~66, `const seuTimeP = medir(res, 'seu_time', teamsP.then((t) => (`) 29I, bloco 3: as pendências do card "Seu time" (só quem administra algum time) — ao lado, ninguém espera por elas.
- (linha ~96, `medir(res, 'ad', seguro(inicioService.obterAdsSessao(userId))),`) VELOCIDADE 9: vêm os slots de TODAS as páginas, não só o do Início. A
  conta de servidor é a mesma (uma leitura do store, uma do utilizador) e
  poupa um `GET /api/ads?pagina=…` por tela — eram 4 dos 22 pedidos do
  percurso que o dono mediu, ~500 ms cada, de Lisboa.
- (linha ~101, `medir(res, 'brilhante', seguro(temDireito(userId))),`) O direito de gerar Brilhante vem JUNTO (SPEC-FIGURINHA-3 §7): o Início
  mostra o cartão dourado "Você tem uma Brilhante para gerar" e dispara a
  geração preguiçosa do pacote do time. Um pedido à parte só para isto
  seria mais um round-trip na tela que a Velocidade 6A juntou num só.
- (linha ~122, `seu_time: seu_time || [],`) 29I, bloco 3: [{ team_id, slug, nome, fuso, pendencias }] — um por time em que a pessoa é admin ([] = não administra nenhum).
- (linha ~129, `brilhante: {`) Pagamentos P2: `loja_pronta` (PAGAMENTOS_ATIVOS no motor) vai junto — a Figurinha abre a partir
  deste payload e decide aqui se o convite é "Comprar" ou "Pedir ativação", sem pedir o /estado.

## routes/media.js

- (linha ~1, `const express = require('express');`) Proxy de imagem — GET /api/media/:token[?w=128|256|512|1024][&sq=1[&rc=x,y,escala]]

  VELOCIDADE 6A (15-set) — era um 302 para um signed URL do Supabase. Custava
  caro no celular: o redirect abria uma SEGUNDA ligação TLS (Cloud Run → CDN do
  Supabase) e devolvia o PNG original, 390 KB, medido a 1,4-1,6 s por imagem de
  Lisboa. Agora o proxy serve os BYTES ele próprio, já redimensionados e em
  WebP, e guarda o derivado em memória: a segunda pessoa a ver a mesma foto
  paga só a rede.

  RODADA 27 (25-set) — o LRU e a receita moraram até aqui; agora vivem em
  utils/derivadosMidia.js, porque o upload da foto também os usa: quem grava a foto
  deixa os derivados que as telas vão pedir prontos, e o primeiro pedido da própria
  pessoa deixa de pagar a ida ao Storage e o sharp. Dois pedidos do mesmo derivado ao
  mesmo tempo esperam a mesma geração.

  Porquê `Cache-Control: public` (e não `private`): o URL é uma CAPACIDADE
  assinada por HMAC — quem não tem o token não tem o URL, exatamente como um
  signed URL de qualquer CDN. E `immutable` porque conteúdo novo gera `v` novo
  (ver utils/mediaToken.js) → URL novo; este URL, esse, nunca muda de bytes.

  Os derivados NÃO são gravados no Storage de propósito: um WebP de rosto que
  sobrevivesse à conta apagada seria um órfão com PII (LGPD). O LRU em memória
  morre com o processo, que é o comportamento certo.
- (linha ~37, `const mediaLimiter = criarLimiteDeMidia();`) SEGURANCA-REVISAO-10SET.md secção 3 (10-set): isento do limiter geral da
  /api (server.js) porque um feed com muitas fotos dispara uma chamada por
  <img>, de uma vez. Sem sessão (o token HMAC é a própria autorização), por isso
  conta por IP, o real (CF-Connecting-IP quando vem, senão req.ip). Teto e chave
  em middleware/limiters.js (hotfix 25).
- (linha ~56, `const recorte = quadrado ? deParametro(req.query.rc) : null;`) `rc=x,y,escala` — a janela que a pessoa escolheu para a miniatura (Rodada 29B, E). Só conta
  junto de `sq=1`: o card, o cromo e as fotos grandes pedem sem ele e a ignoram. Lixo → sem recorte.

## routes/push.js

- (linha ~12, `const { CATEGORIAS, preferenciasCompletas, mesclarPreferencias, erroDaColunaNot…`) 29I, bloco 3
- (linha ~24, `const CODIGOS_DE_SUBSCRICAO_MORTA = [403, 404, 410];`) COFRE 25-set — o par VAPID foi trocado. Toda subscrição feita com a chave ANTIGA passa a ser recusada pelo push
  service com 403 (FCM: "SenderId mismatch"; os outros: JWT que não bate com a inscrição): ela nunca mais serve, então
  sai do banco — e o cliente se inscreve de novo sozinho na próxima abertura do app (usePushNotifications).
  404/410 = expirada/removida pelo próprio browser, como sempre. Qualquer outro código (429, 5xx, rede) é passageiro:
  a linha fica.
- (linha ~54, `if (!endpointPushValido(endpoint)) throw new HttpError(400, 'Endpoint de subscr…`) SEGURANCA-REVISAO-10SET.md secção 3 (10-set): sem isto o servidor fazia
  POST (webpush.sendNotification) para qualquer endpoint que mandassem —
  só aceita hosts de serviços de push conhecidos.
- (linha ~218, `router.get(`) GET /api/push/preferencias — as notificações que EU quero receber (Perfil → Notificações, Rodada 29I bloco 3).
  { preferencias: { jogos, pedidos, figurinha, resenha } (true = ligada), categorias (a ordem da tela),
    admin (administra algum time: só então a tela mostra "Pedidos de entrada"), salvavel (false sem a migração 079) }.
- (linha ~259, `async function enviarNotificacao(userIds, payload, opcoes = {}) {`) Envia uma notificação push a uma lista de utilizadores (fire-and-forget).
  Nunca lança: erros são engolidos; subscrições mortas (403/404/410) são apagadas.
  @param {string[]} userIds destinatários
  @param {{title:string, body?:string, url?:string}} payload
  @param {{categoria?: 'jogos'|'pedidos'|'figurinha'|'resenha'}} [opcoes] o tipo do aviso (29I, bloco 3): quem desligou esse tipo
    em Perfil → Notificações fica de fora. Sem categoria = aviso que não se desliga (o "Avisar o time" do admin, o Gabinete).

## routes/ranking.js

- (linha ~36, `const [{ data: membros }, { data: votos }, { data: jogos }, organizam] = await…`) Membros, votos e jogos só dependem de teamId — nenhum depende do resultado
  dos outros (13-set, "Velocidade 3": eram 3 awaits em série).
- (linha ~50, `idsQueSoOrganizam(teamId),`) Rodada 29B (E): quem só organiza o time não aparece no ranking
- (linha ~54, `const [{ golsMap, vitoriasMap, artilhariaMap, destaquesMap }, { data: gps }] =…`) FLUIDEZ 2 (16-set): os golos (dentro dos agregados) e os jogos por jogador só
  precisam dos gameIds — eram duas idas em série, agora saem juntas.
- (linha ~126, `avatar_generico: u.avatar_generico || null,`) Sem foto nem figurinha, a linha mostra o genérico que a pessoa ESCOLHEU (o mesmo da Presença e do
  Início), não uma silhueta "?": Rodada 27.
- (linha ~160, `async function montarJogadorForaDoRanking({ teamId, userId, games, parts, votos…`) RODADA 29I (achado 97): a pessoa sempre vê a PRÓPRIA vitrine. O ranking só leva quem tem 3 jogos, é visível, está ativo e joga
  (quem só organiza o time sai dele) — quem ficava de fora dava 404 e a tela dizia "Perfil só entre companheiros", como se a regra
  de dividir time valesse contra o dono do perfil. Aqui monta-se a linha do próprio jogador com os números DELE (os que a vitrine
  já mostra: jogos, vitórias, gols, destaques, nota), no mesmo formato do ranking, sem posição e sem pontos (`score: null`) — e sem
  mexer na lista nem nas posições dos outros.
- (linha ~219, `router.get(`) GET /api/teams/:slug/jogador/:userId — perfil completo do jogador.

  FLUIDEZ 2 (16-set): eram 18 consultas em 16 ondas EM SÉRIE — 1216 ms no iPhone,
  644 ms só de motor. Ficam 16 consultas em 4 ondas, e cada onda tem a sua fase no
  Server-Timing (a rota não marcava fase nenhuma: o tempo do motor era opaco).
  O corpo do JSON é o MESMO byte a byte — provado em scripts/bench-jogador-identico.js.
- (linha ~277, `const ehOProprio = userId === req.user.id;`) 29I (achado 97): o próprio id passa SEMPRE — antes de qualquer verificação de time em comum.
- (linha ~346, `const g = gameById[p.game_id];`) Achado 10: só conta jogos já ENCERRADOS — presença num jogo futuro não
  infla a estatística "jogos".
- (linha ~424, `jogador: { ...jogador, posicao, total_com_nota: comNota.length, figurinha_ativa…`) figurinha_ativa (Rodada 28, Manutenção 26-set): mesma regra única de services/inicio.js —
  o card mostra AGORA uma figurinha nossa? As telas não devem voltar a comparar foto_url/avatar_url.
- (linha ~515, `if (req.body?.zerar === true) {`) 29I, bloco 3 (dono): em Ajustes → AÇÕES DEFINITIVAS, "Pedir para votar de novo" ZERA as notas do time antes de pedir — todo mundo
  vota do zero. O app pede a confirmação; sem `zerar` (app antigo) segue só o pedido, como era.

## routes/rsvp.js

- (linha ~15, `async function promoverDaEspera(game) {`) Data curta (ex.: "12/06 · 20:30") para o corpo das notificações — no relógio do CAMPO (fuso do time, 29I achado 83).
- (linha ~125, `const { data: confirmados } = await supabase`) Sincroniza os confirmados via RSVP para game_players (alimenta o sorteio
  sem o admin ter de adicionar os jogadores manualmente).
  Rodada 9: quem já tem linha no jogo mantém o `goleiro` que ele ou o admin
  marcaram; quem entra agora herda a flag do time (Rodada 10B:
  team_members.categoria === 'GR', via goleirosDoTime).
- (linha ~135, `const organizam = await idsQueSoOrganizam(game.teams.id);`) Rodada 29B (E): quem só organiza o time nunca entra no elenco (nem se respondeu antes de mudar de papel).
- (linha ~164, `if (await soOrganiza(game.teams.id, req.user.id)) throw new HttpError(403, MSG_…`) Rodada 29B (E): quem só organiza o time não entra na lista de presença.

## routes/superadmin.js

- (linha ~44, `const users = (data || []).map(({ avatar_url, ...u }) => ({`) 22-set (SPEC-FIGURINHA-3): `plan` saiu — o que resta ver aqui é o direito
  de Brilhante (créditos e se já tem uma), pela mesma regra do resto do app
  (o avatar atual ser um arquivo de figurinha nosso; Hotfix 26, antes era
  avatar_url ≠ foto_url e a foto do Google contava). Sem avatar_url no
  payload de volta: é detalhe de implementação, não algo que a tela precise
  mostrar.
- (linha ~98, `const PAGINA_SUPABASE = 1000;`) Rodada 29Y: o Supabase devolve no máximo 1.000 linhas por resposta (o teto do PostgREST). Uma consulta sem paginação
  cortava a lista de equipas e a contagem de membros calado. Lê em páginas de 1.000 com .range até uma página vir menor.
  A ordem tem de ser TOTAL para as páginas não se repetirem nem pularem linhas: quem chama termina o .order() com 'id'.
- (linha ~112, `router.get(`) GET /api/super/teams — lista todas as equipas com nr. de membros e uso de
  mídia da Resenha (Rodada 15: cota de 500 MB por time). Lê tudo, sem teto de 1.000 (Rodada 29Y).

## routes/teams.js

- (linha ~20, `const { enviarNotificacao } = require('./push');`) o "Você entrou no <time>!" do aceite de pedido (Rodada 29D)
- (linha ~21, `const { criarCodigo, convitePorParametro, codigosDosConvites } = require('../ut…`) o link curto /c/<código> (29H)
- (linha ~22, `const { MSG_ARTILHEIRO_PRECISA_DOS_GOLS, combinacaoDePremiosCoerente } = requir…`) o artilheiro depende dos gols (29I, achado 78)
- (linha ~23, `const { FUSO_PADRAO, fusoDoTime, fusoDaCoordenada, horaNoFuso, erroDaColunaFuso…`) o fuso do time (29I, achado 83)
- (linha ~24, `const { PALETA, CORES_ANTIGAS, lerEscudo, erroDeEscudoSemMigracao, escudoDoTime…`) o escudo do time (29I, bloco 3)
- (linha ~25, `const { lerJogadoresPorTime, jogadoresPorTimeDoTime, erroDaColunaJogadoresPorTi…`) item 68 (29I, bloco 3)
- (linha ~29, `async function gravarFusoDoTimeNovo(team, geo) {`) 29I (achado 83): no time recém-criado, grava o fuso derivado do ponto da cidade geocodificada. Melhor esforço: sem ponto, sem
  fuso derivável ou sem a migração 076, não grava nada e o time fica no padrão (America/Sao_Paulo, o que a coluna nasce valendo —
  por isso o padrão nem precisa de escrita). Devolve o fuso que o time passou a ter.
- (linha ~45, `const CORES_VALIDAS = [...new Set([...PALETA, ...CORES_ANTIGAS])];`) 29I, bloco 3: a cor principal do escudo vem da paleta de 12 (utils/escudo.js); as 4 chaves antigas continuam valendo.
- (linha ~48, `const CONVITE_DIAS = 30;`) RODADA 20 (23-set, decisão do dono): o link vira "de grupo" — o MESMO link
  serve pra todo mundo, vale 30 dias (era 7, uso único), e o admin revoga
  quando quiser (DELETE /api/teams/:slug/convites/:id, já existia).
- (linha ~90, `const golsLigados = req.body?.mostrar_gols !== false;`) 29I (achado 78): o artilheiro depende dos gols — gols desligados com artilheiro ligado é combinação incoerente e o motor recusa.
  `mostrar_gols` agora também vem no POST (antes ia num PATCH logo depois): o time nasce já com os dois prêmios coerentes.
- (linha ~97, `const cid = await resolverCidade(req.body || {});`) GEO (14-set, mesma regra do PATCH /api/teams/:slug): guarda o nome da CIDADE (texto) + o ponto ARREDONDADO
  (a morada exacta nunca entra). RODADA 29B (D), regra completa em utils/cidade.js: cidade DA LISTA do app →
  a coordenada vem da lista (sem Nominatim); fora dela → Nominatim; se nada achar, guarda só o texto (normalizado
  em `cidade_normalizada`, para o Explorar casar por texto) e segue — nunca bloqueia a criação do time.
- (linha ~103, `const bar = await resolverBairro(req.body || {}, cid);`) RODADA 29H (item 12): o bairro opcional. Achou perto da cidade → o ponto do time é o do bairro; senão fica o da cidade.
- (linha ~186, `const soOrganizo = req.body?.joga === false;`) Adiciona o criador como admin (rollback se falhar). RODADA 29B (E): "Só organizo o time" (`joga: false` no corpo)
  grava `team_members.joga = false` — ele administra tudo, mas fica fora da presença, do sorteio, do ranking e do
  pacote. Sem a migração 067 a coluna não existe: o time nasce com o criador jogando (a resposta diz `joga: true`).
- (linha ~204, `team.fuso = await gravarFusoDoTimeNovo(team, cid.geo);`) 29I (achado 83): o fuso nasce da cidade geocodificada (da lista do app ou do Nominatim); sem cidade ou sem ponto, o padrão.
- (linha ~207, `const bairroResposta = bar.info ? (extrasGravados ? bar.info : { ...bar.info, s…`) `geo` (29B, D): o que a tela diz da cidade — { encontrada: true, nomeOficial } ou { encontrada: false }.
  `bairro` (29H): o mesmo para o bairro — { encontrado, nomeOficial } ou { encontrado: false }; `salvo: false` quando a
  migração 073 ainda não existe. `premios_salvos: false`: o pedido de desligar artilheiro/destaque não pôde ser gravado.
- (linha ~247, `const montar = (comNormalizada, comBairro, novas) => {`) 29I, bloco 3: o escudo (segunda cor e padrão, migração 077) vai junto — sem a migração a leitura repete sem ele (lerComFuso).
  29T-C: o bairro (coluna da migração 073) vai junto; sem ela a leitura repete sem o bairro e os times valem sem bairro.
- (linha ~255, `if (q) {`) q pesquisa em nome OU localização (a barra única diz "nome ou cidade").
  SEGURANCA-REVISAO-10SET.md secção 3 (10-set): q ia direto para dentro da
  string de filtro do .or() — vírgula separa condições, parênteses
  agrupam, ponto separa coluna.operador.valor no PostgREST; um q com esses
  caracteres conseguia adicionar/alterar condições do filtro. O PostgREST
  suporta valores com esses caracteres se o valor inteiro vier entre aspas
  duplas — é o que valorFiltroOr faz quando encontra algum deles.
- (linha ~264, `const porCidade = comNormalizada ? condicaoPorCidade(q, valorFiltroOr) : '';`) RODADA 29B (D): time SEM coordenada (cidade que o Nominatim não achou) casa pelo texto da cidade,
  normalizado — igual à busca normalizada. Com coordenada, quem manda é a distância (app).
- (linha ~317, `...escudoDoTime(t),`) cor + escudo_cor2 + escudo_padrao (29I, bloco 3)
- (linha ~323, `cidade_normalizada: t.cidade_normalizada || null,`) 29B (D): o app casa por texto quando não há ponto
- (linha ~324, `bairro: t.bairro || null,`) 29T-C: o card do Radar mostra "Bairro · Cidade"
- (linha ~348, `const { data: teamsRaw, error } = await lerComFuso((novas) => {`) 29I, bloco 3: a cor e o escudo vão junto (o card desenha o escudo do time sem logo); sem a 077, só a cor.
- (linha ~412, `` const team = (await getTeamBySlug(req.params.slug, `${COLUNAS}, bairro, mostrar… ``) RODADA 29H: bairro e os dois prêmios do time (migração 073). Sem a migração a leitura com elas volta vazia (coluna
  inexistente) e a página do time NÃO pode cair: repete só com as colunas de sempre.
- (linha ~418, `const [role, { data: rawMembers, error }, organizam] = await Promise.all([`) Achado 3/23: role e membros só dependem do team.id, não um do outro — em
  paralelo em vez de dois round-trips seguidos ao Supabase.
- (linha ~427, `idsQueSoOrganizam(team.id),`) Rodada 29B (E): em consulta à parte (a coluna `joga` é da migração 067)
- (linha ~441, `joga: !organizam.has(m.users?.id),`) 29B (E): false = só organiza o time
- (linha ~442, `goleiro: m.categoria === 'GR',`) Rodada 10B: a FONTE é só categoria — a coluna `posicao` (Rodada 9) e a
  `categoria` (que já mandava no ranking) eram a mesma decisão guardada
  duas vezes; o dono escolheu ficar só com esta. `goleiro` é o campo novo
  (booleano); `posicao` continua saindo por compatibilidade com o app já
  instalado (Rodada 9) — os dois nunca podem discordar porque vêm da
  MESMA leitura.
- (linha ~456, `fuso: fusoDoTime(team),`) 29I (achado 83): sem a migração 076 a coluna não vem — vale o padrão
- (linha ~457, `...escudoDoTime(team),`) 29I, bloco 3: sem a 077 o escudo vale sólido, uma cor
- (linha ~459, `bairro: team.bairro || null,`) 29H: sem a migração 073 as colunas não vêm — valem os padrões (tudo ligado, sem bairro).
- (linha ~490, `const escudo = lerEscudo(b);`) 29I, bloco 3 (achado 102): UM controle, "Escudo do time" — cor principal (teams.cor) + segunda cor + padrão, da paleta fixa.
- (linha ~502, `if ('mostrar_artilheiro' in b) patch.mostrar_artilheiro = !!b.mostrar_artilheir…`) RODADA 29H (item 44): "Artilheiro do dia" e "Destaque do dia" — o editor de resultado só oferece a seção quando ligado.
- (linha ~505, `if ('mostrar_gols' in patch || 'mostrar_artilheiro' in patch) {`) RODADA 29I (achado 78): o artilheiro depende dos gols. A combinação que o time vai TER depois desta gravação (o do pedido, ou o que
  já estava) não pode ser "gols desligados e artilheiro ligado": o motor recusa. Religar os gols não religa o artilheiro sozinho.
- (linha ~523, `let geoInfo = null;`) GEO (opt-in): guarda o nome da CIDADE (texto) + o ponto ARREDONDADO (a morada exacta nunca entra). Limpar a
  cidade tira a equipa da busca por distância. RODADA 29B (D), regra em utils/cidade.js: cidade DA LISTA → o ponto
  vem da lista; fora dela → Nominatim; nada achou → guarda o texto e LIMPA o ponto (o de antes era de outra cidade;
  sem ponto o Explorar casa por texto). Cidade igual à de antes (o painel reenvia o campo a cada "Salvar") não
  geocodifica de novo nem mexe no ponto.
- (linha ~546, `const fusoDaCidade = fusoDaCoordenada(cid.geo?.lat, cid.geo?.lng);`) 29I (achado 83): a cidade mudou, o fuso acompanha — derivado do ponto da cidade; sem ponto, fica o que o time tinha.
- (linha ~552, `let bairroInfo = null;`) RODADA 29H (item 12): o bairro. O ponto do time passa a ser o do bairro quando o motor o acha perto da cidade; sem
  bairro (ou sem cidade onde pôr um) volta a ser o da cidade. O painel reenvia cidade e bairro a cada "Salvar": bairro
  igual ao de antes, com a cidade igual, não geocodifica de novo nem mexe no ponto.
- (linha ~631, `router.put(`) PUT /api/teams/:slug/brilhante-kit { kitId } — Pagamentos P2: o dono escolhe o uniforme das
  figurinhas do time (o pacote comprado na loja chega sem uniforme). Só admin, só com o pacote
  ativo; trocar só antes da primeira geração. Regras em utils/uniformeDoPacote.js.
- (linha ~660, `verificarImagemReal,`) SEGURANCA-REVISAO-10SET.md secção 3 (10-set): antes só checava o
  mimetype declarado pelo multer; agora confirma que decodifica como
  imagem de verdade (mesmo princípio do avatar, utils/olheiroEntrada.js).
- (linha ~692, `router.delete(`) DELETE /api/teams/:slug/logo — remove o logo da equipa (só admin; achado 118, Rodada 29J).
  Sem logo, EscudoEquipa volta a desenhar o escudo (editor de escudo, Ajustes). O ficheiro
  sai do bucket nas 3 extensões possíveis (o upload grava em path fixo "logos/{teamId}.{ext}";
  sem saber qual foi a última, tenta as 3 — a que não existir simplesmente não apaga nada).
- (linha ~733, `const [{ data, error }, { data: votos }, { data: ultimosJogos }, agregados, org…`) Achado 3/23: estas 4 leituras só dependem de team.id, nenhuma do resultado
  das outras — corriam em série. Em paralelo; só a busca de presenças (que
  precisa dos IDs dos "últimos jogos") fica sequencial a seguir.
- (linha ~749, `idsQueSoOrganizam(team.id),`) Rodada 29B (E)
- (linha ~750, `supabase.from('games').select('id, data, status, cancelado').eq('team_id', team…`) 29I (achado 104): todos os jogos, para contar as PRESENÇAS de cada um (a aba Estatísticas do admin).
- (linha ~805, `goleiro: m.categoria === 'GR',`) Rodada 10B: uma só flag — categoria manda. `goleiro` é o campo novo;
  `posicao` sai calculado dela, só por compatibilidade com o app já
  instalado (nunca mais é lido da coluna `posicao`).
- (linha ~812, `joga: !organizam.has(uid),`) 29B (E): false = só organiza o time
- (linha ~828, `tem_brilhante: avatarEhFigurinhaNossa(m.users?.avatar_url),`) 22-set (SPEC-FIGURINHA-3): `plan` deixou de significar algo pago —
  o selo do admin agora é ter a Brilhante: o avatar ser uma figurinha NOSSA
  (utils/figurinhaRegra.js, a regra única; a desigualdade avatar_url ≠ foto_url
  que valia até o Hotfix 26 contava a foto do Google como figurinha).
- (linha ~843, `router.patch(`) PATCH /api/equipas/:slug/membros/posicao — marca (ou desmarca) o jogador como
  goleiro do time. Qualquer membro define a sua; admin pode definir a de outro
  (body.user_id). Body: { goleiro: true|false } (ou, por compatibilidade com o
  app já instalado antes da Rodada 10B: { posicao: 'GL'|null }).

  Rodada 9 (decisão do dono, 16-set): só existe goleiro ou jogador de linha.
  Rodada 10B (16-set): esta rota GRAVA `categoria` (não mais `posicao`) — era a
  mesma decisão em duas colunas (esta e a que já mandava no ranking); o dono
  escolheu ficar só com `categoria`. A rota/campo antigo do admin
  (PATCH /api/teams/:slug/membros/:userId com `categoria`) continua igual e
  grava a mesma coluna — as duas nunca mais podem discordar.
- (linha ~885, `router.patch(`) PATCH /api/equipas/:slug/membros/joga — "Eu jogo" / "Só organizo o time" (Rodada 29B, E; migração 067). A pessoa muda o
  SEU papel (nunca o de outra). Só quem administra o time pode ficar só organizando (`joga: false`); voltar a jogar é de
  qualquer um. Quem só organiza administra tudo, mas não entra na presença, no sorteio, no ranking nem no pacote.
  Body: { joga: true|false }.
- (linha ~1067, `router.post(`) POST /api/teams/:slug/convite — gera um token de convite (qualquer membro) e, junto, o código do link curto /c/<código> (29H).
- (linha ~1085, `const codigo = await criarCodigo(supabase, convite.id);`) Rodada 29H (item 7): o link curto. `codigo` é null quando a migração 072 ainda não foi aplicada — o convite vale pelo
  link longo, como sempre.
- (linha ~1093, `router.get(`) GET /api/convite/:token — valida um convite (público; auth opcional). O parâmetro é o token longo (uuid) OU o código
  curto de /c/<código> (29H). Devolve sempre 200 com { valido, motivo, ... }.
- (linha ~1107, `const [{ data: team }, { data: inviter }, { data: usosRows }, role, { count: me…`) RODADA 29A (item 11, "o link demora a abrir"): o time, quem convidou, os usos e o papel de quem abre só
  dependem do CONVITE, que já foi lido — iam em fila, uma ida a São Paulo atrás da outra (de Lisboa, ~300 ms
  cada). Agora saem juntos: 2 idas no total (o convite, depois estas ao mesmo tempo). O select do
  time leva também logo_url e cor_fundo, para a página do convite mostrar o escudo de verdade.
  RODADA 29B (A): a página nova mostra 3 fatos para dar vontade de entrar — quantos já estão no time, quando é o
  próximo jogo e de que cidade. Entram na MESMA leva (a cidade vem no select do time; a contagem e o próximo
  jogo são duas consultas a mais, em paralelo): continuam 2 idas no total.
- (linha ~1115, `lerComFuso((novas) => supabase`) 29I (achado 83): o fuso do time vai junto — o "próximo jogo" da página do convite é lido no relógio do campo.
- (linha ~1126, `supabase.from('convite_usos').select('user_id').eq('convite_id', convite.id),`) RODADA 20 — 'usado' deixou de existir: o link é reutilizável, só 'expirado' (ou 'nao_encontrado',
  acima) barra. `usos` é best-effort (migração 058); sem ela, 0 — nunca derruba a validação do convite.
- (linha ~1142, `idsQueSoOrganizam(convite.team_id),`) 29B (E): o fato é "N jogadores" — quem só organiza não conta
- (linha ~1157, `membros: Math.max(0, (membrosTotal ?? 0) - organizam.size),`) Os fatos da página (29B, A): `membros` é a contagem, `proximoJogo` o instante do próximo jogo agendado
  (ISO; o app o escreve como data curta no fuso de quem olha) ou null, `cidade` o texto que o admin declarou.
- (linha ~1161, `fuso: fusoDoTime(team),`) 29I (achado 83): o instante do próximo jogo se lê neste fuso (o do campo)
- (linha ~1168, `router.post(`) POST /api/convite/:token/aceitar — entra na equipa e consome o convite. `:token` é o uuid ou o código curto (29H).
- (linha ~1185, `const teamResumo = { id: team.id, slug: team.slug, nome: team.nome, cor: team.c…`) `id` (29H): o Onboarding marca as boas-vindas do time como vistas (`futty_onboarding_<id>`) logo que a pessoa entra.
- (linha ~1194, `if (new Date(convite.expires_at).getTime() < Date.now()) {`) Valida o estado do convite (apenas para novos membros). RODADA 20 — o
  link é reutilizável: só a validade importa, não se já foi usado antes.
- (linha ~1212, `const { error: usoError } = await supabase.from('convite_usos').insert({ convit…`) RODADA 20 — regista o uso em vez de marcar o convite como consumido
  (migração 058): o link continua válido para a próxima pessoa. Fail-safe
  de propósito: tabela ausente ou 23505 (mesma pessoa aceitando de novo,
  corrida) nunca podem derrubar uma entrada que já valeu (o INSERT em
  team_members acima já commitou).
- (linha ~1226, `function avisarAdminsDoPedido(team, userId) {`) 29I, bloco 3 (dono): chegou pedido de entrada → push para os admins do time ("Fulano quer entrar no <time>"), que leva à aba
  Elenco, onde se aceita. Tipo "pedidos" em Perfil → Notificações: quem desligou não recebe. Nunca lança.
- (linha ~1429, `if (status === 'approved' && pedido.status !== 'approved') {`) Rodada 29D: quem foi aceito recebe o push e abre o time já com as boas-vindas (`?entrou=1` → Equipa.jsx). Só na 1ª
  aprovação (um 2º toque do admin não avisa de novo), com o aceite já gravado e ANTES de responder (no Cloud Run a CPU
  fica estrangulada depois da resposta). O push nunca derruba o aceite — falha vira log — e não segura o admin: espera
  no máximo 4 s.
- (linha ~1465, `const nowIso = new Date().toISOString();`) RODADA 20 — sem o .is('usado_por', null): o link reutilizável continua
  "ativo" mesmo depois de usado; só a validade (expires_at) tira da lista.
- (linha ~1493, `const codigosMap = await codigosDosConvites(supabase, conviteIds);`) O código do link curto (29H, migração 072): best-effort — sem a tabela, o admin segue com o link longo.
- (linha ~1609, `time: horaNoFuso(g.data, fusoDoTime(team)),`) 29I (achado 83): HH:MM no relógio do campo (era o do servidor)

## routes/telemetria.js

- (linha ~1, `const express = require('express');`) Futty v2.0 — POST /api/telemetria: a velocidade que o app mediu, sem ninguém dentro (Rodada 28, E).

  Sem requireAuth DE PROPÓSITO: a rota não lê o Authorization nem o IP (o limiter conta por IP em
  memória e esquece em 15 min). O que vai para a tabela é só o que utils/telemetria.js#montarLinha
  deixa passar — ver lá o porquê de cada campo. Responde 204 sempre que o corpo é válido: o app não
  espera nada disto e uma falha de gravação nunca vira erro na tela de ninguém.

## utils/adsStore.js

- (linha ~20, `const FLUSH_MS = 30000;`) VELOCIDADE 6A (15-set): registar() era um read-modify-write do JSON inteiro a
  CADA impressão — 2 idas ao Storage por anúncio visto, com o POST /api/ads/evento
  à espera das duas. Agora o evento só toca num contador em memória e o POST
  responde na hora; o ficheiro é escrito de 30 em 30 segundos (e no SIGTERM).

  O que se perde: até 30 s de contagens se o processo morrer de morte súbita.
  São números de publicidade agregados por dia, não dinheiro nem conteúdo — o
  preço certo a pagar por tirar duas idas ao Storage do caminho do utilizador.

## utils/antiAbusoIA.js

- (linha ~1, `const crypto = require('crypto');`) Futty v2.0 — Anti-abuso de custo da geração de avatar IA (11-ago, ordem do
  dono). Filosofia: PARAQUEDAS COM ALERTA, nunca teto de vidro — viral legítimo
  nunca é travado. Três camadas:
    1. contador diário + teto suave (pausa só ao bater 100%, volta sozinho à
       meia-noite — a chave é a DATA, não um estado global a limpar);
    2. alertas em degraus (20/50/75/90%) ao super-admin, com diagnóstico
       viral-vs-ataque calculado dos sinais disponíveis;
    3. auto-freeze cirúrgico — só contas <48h, só sob regra de ferro (farm
       de contas), nunca toca em quem já é da casa.
  FAIL-OPEN: se as tabelas novas ainda não existirem (migrações 045-048 por
  correr), nada aqui bloqueia uma geração — é reforço, não dependência do
  caminho feliz. O incremento do contador é read-then-write (não atómico —
  mesma tolerância já aceite pela quota mensal em avatar_ia_mes, ali perto):
  é um paraquedas de custo, não um livro-razão financeiro; uma corrida rara
  entre duas gerações simultâneas subestima o gasto em ±1, irrelevante face
  aos degraus de 20 pontos percentuais.
- (linha ~21, `const CUSTO_FALLBACK_CENTS = 11.2;`) 17-set: não há mais custo constante. O valor de cada geração vem dos headers
  da fal (`x-fal-billable-units`, ver utils/falFila.js) e chega aqui em
  `registrarGeracao({ custoCents })`. A constante antiga dizia 1,7 cêntimos; o
  real medido na bancada de 49 figurinhas é ~11,2 — a casa andou a subestimar o
  gasto diário em 6,6×, e era esse número que alimentava os alertas e o teto.
  Isto é a última linha de defesa quando a fal não manda header nenhum.
- (linha ~80, `let idsPorConvite = new Set();`) RODADA 20 — convite virou reutilizável (migração 058): quem entrou por
  convite agora está em convite_usos, não em convites.usado_por (que só
  guarda o legado, de antes da mudança). A pergunta é "entrou por
  qualquer um dos dois caminhos" — união dos ids, sem contar duas vezes.
  Isolado num try próprio: um tropeço aqui não pode derrubar o resto do
  diagnóstico (ataque por IP/hash), que não depende de convite nenhum.
- (linha ~215, `const { error: erroLog } = await supabase.from('geracao_ia_log').insert({`) RODADA 28 — o log passa a guardar também o time que pagou (pacote) e o custo REAL desta geração
  (null se a fal não mandou o header): é daqui que o Gabinete tira o custo por time POR MÊS.

## utils/apagarUsuario.js

- (linha ~1, `const { supabase } = require('./db');`) Futty v2.0 — Exclusão de conta (LGPD / exigência das lojas). Lógica ÚNICA de
  apagar um usuário por completo — partilhada entre a rota DELETE /api/me (o
  próprio usuário) e scripts/limpar-usuarios-teste.js (limpeza em massa), para
  nunca haver duas versões da ordem de deleção a divergir com o tempo.

  ORDEM (mesma auditoria de scripts/limpar-usuarios-teste.js, 14-set):
    1) Times onde o usuário é criador/admin — sucessão ANTES de tudo: se sobra
       outro admin, só passa o criado_por adiante (teams.criado_por tem ON
       DELETE CASCADE — sem isto, apagar o usuário apagava também um time com
       gente ativa); se não sobra outro admin mas sobra outro membro, o mais
       antigo vira admin E leva o criado_por; se o usuário é o único membro, o
       time é apagado (com o logo dele no Storage).
    2) Storage — avatar/foto, slots de avatar IA, fotos de campeão, mídia de
       posts/comentários dele na Resenha, + o logo dos times apagados no passo
       1. Nada disto cai por FK, é preciso apagar à mão (best-effort).
    3) geracao_ia_log — user_id SEM foreign key nenhuma (migração 046).
    4) user_avatar_slots — tabela sem migração commitada; defensivo.
    5) auth.admin.deleteUser(id) — cascade cuida do resto: public.users e
       tudo o que referencia user_id diretamente (team_members como membro,
       votes, comentarios+comentario_anexos, feed_posts+feed_post_media,
       denuncias, reacoes, rsvp*, push_subscriptions, user_blocks,
       convites.criado_por/usado_por — todos CASCADE ou SET NULL, confirmado
       por grep em db/migrations/).
- (linha ~116, `try {`) user_avatar_historico — migração 057 (Rodada 19, "Minhas figurinhas"); defensivo.
- (linha ~163, `const p = bucketEcaminho(url);`) bucketEcaminho (não parseUrlPublico): a mídia da Resenha guardada em
  feed_post_media/comentario_anexos é sempre a URL do PROXY desde o
  Tijolo 2 — sem isto, essas URLs nunca entravam em urlsPorBucket e a
  conta apagada deixava fotos/comentários órfãos no bucket resenha para
  sempre (achado real, Rodada 15 — mesma causa do item 3 em feed.js).
- (linha ~179, `for (const pasta of ['public', 'tmp']) {`) VARRIMENTO POR PREFIXO (22-set). Os ficheiros do utilizador passaram a ter
  carimbo de tempo no nome (`public/<userId>-<carimbo>.jpg`,
  `public/<userId>-ai-<kit>-<carimbo>.png`, `tmp/<userId>-<carimbo>-*`), por
  duas razões: cache nenhum serve versão velha, e cada geração é um objeto
  novo. O efeito colateral é que o banco já não conhece TODOS os ficheiros —
  uma versão anterior cuja limpeza tenha falhado fica órfã e sem ninguém a
  apontar para ela. Por isso, além das URLs de cima, varre-se as duas pastas
  pelo prefixo do id. Best-effort: uma sobra no bucket nunca pode impedir a
  conta de ser apagada.

## utils/avataresDoSorteio.js

- (linha ~1, `function comAvataresAtuais(tr, avatarPorUsuario) {`) Futty v2.0 — O avatar de HOJE nos jogadores de um sorteio (Rodada 27, 25-set).

  O sorteio guarda uma CÓPIA do avatar_url de cada jogador no instante em que foi feito:
  `times_resultado` é um snapshot, e precisa ser (o replay da cerimônia sai igual pela seed).
  Só que a cópia envelhece: quem trocava a foto, ou reajustava o enquadramento, depois do
  sorteio continuava aparecendo com a foto ANTIGA no cartão do sorteio e na lista de sorteados.

  Na LEITURA, o avatar de quem ainda tem conta passa a ser o de hoje. O resto do snapshot
  (times, ordem, seed, nomes, notas) fica como está. Quem não está no mapa (convidado, conta
  apagada) mantém a cópia; quem hoje não tem avatar também (não se apaga rosto do histórico).

## utils/aviseMe.js

- (linha ~1, `const EMAIL_MAX = 254;`) Futty v2.0 — Rodada 29B (F): a lista "Avise-me" — a parte pura (validar o pedido, ler e contar a lista, montar o CSV).
  Quem recebe o pedido é routes/aviseMe.js; quem mostra a lista é o Gabinete (routes/gabinete.js). Aqui não há Express
  nem rede: o cliente do banco entra por parâmetro, para testar de ponta a ponta sem nada.

  O que a lista guarda: o e-mail (minúsculas), de onde veio a pessoa (`origem`) e quando. NADA mais — nem IP, nem
  nome, nem aparelho (LGPD: só o que o aviso do lançamento precisa).

## utils/cacheQuente.js

- (linha ~1, `const { registrarCache } = require('../middleware/tempo');`) Futty v2.0 — Cache em memória com dedupe de pedidos em voo e stale-while-revalidate
  (15-set, "Velocidade 7A").

  Primeiro relatório real do Diagnóstico (iPhone em Lisboa): no arranque frio o
  app dispara 3 pedidos em paralelo, os 3 chegam com os caches vazios e CADA UM
  pagava a mesma ida à rede — 3 × supabase.auth.getUser, 3 × download das
  suspensões. A "manada". Aqui, chamadas simultâneas com a mesma chave esperam a
  MESMA promessa: uma ida à rede só, dividida por quem chegou junto.

  O mesmo relatório mostrou picos isolados (inicio 783 ms, blocks 630 ms) no
  instante em que um cache de TTL curto vencia: o azarado da vez pagava o
  download inteiro. Regra agora: NENHUM pedido paga o vencimento de um cache. Se
  a entrada venceu mas existe, sai o valor velho NA HORA e a renovação corre por
  trás (uma de cada vez). Só espera quem não tem nada em cache.

  Vive só neste processo (nada distribuído): cada instância do Cloud Run tem o seu.

  Cada consulta avisa o Server-Timing do pedido (middleware/tempo.js): valor
  pronto = hit; teve de esperar a rede = miss, com o tempo da espera.

## utils/campeonatoStore.js

- (linha ~53, `async function obter(teamId, id) {`) Rodada 8B: prazo de 3 s (comPrazo) nas duas leituras — uma ida sem resposta
  nunca pode prender quem chama (mesmo padrão de denunciaStore/gabineteStore/
  plataformaStore). Se o prazo vencer, rejeita como uma falha normal do Storage
  já rejeitaria — quem chama (asyncHandler das rotas) já sabe tratar isso.

## utils/chavesSupabase.js

- (linha ~1, `function chaveSecreta() {`) Futty v2.0 — De onde saem as chaves do Supabase (Rodada 28, formato novo).

  O Supabase trocou as chaves JWT (anon / service_role) pelas novas: publishable
  (sb_publishable_…) e secret (sb_secret_…). As novas giram sem derrubar sessões
  e podem ser revogadas uma a uma. As duas famílias convivem até o Pedro desligar
  as antigas no painel (Settings → API Keys); o motor prefere a nova e cai para a
  antiga enquanto ela for a única no ambiente. Nenhum outro arquivo lê essas
  variáveis direto — é aqui que a troca acontece, uma vez só.

  Nunca imprimir o valor: quem precisa saber qual está em uso usa `origemDasChaves()`
  (nomes e formato, sem a chave).

## utils/cidade.js

- (linha ~1, `const { geocodar: geocodarNominatim } = require('./geocode');`) Futty v2.0 — Rodada 29B (D): a cidade de um time.

  O app (CampoCidade) deixa a pessoa escolher numa lista estática — 5.570 municípios do Brasil e 308 concelhos de
  Portugal — e manda { cidade, uf, pais, lat, lng, origem: 'lista' }. Regra completa (dono, 30-set):
    1. cidade DA LISTA → a coordenada vem da própria lista (arredondada como sempre, ~1 km); nenhuma chamada externa;
    2. FORA da lista → tenta o Nominatim como antes; achou → "Encontramos: <nome oficial>" e guarda o ponto;
    3. nada achou → guarda o TEXTO mesmo assim e avisa na tela; o Explorar passa a casar por texto normalizado
       (sem acento, sem maiúscula, sem espaço sobrando) quando o time não tem coordenada.
  Este módulo é a parte pura dessa regra: normalizar, ler a escolha da lista, decidir e devolver o que gravar.

  RODADA 29H (item 12, dono 2-out): o BAIRRO, opcional. Antes o ponto do time era o centro da cidade (todos os times de
  "São Paulo" no mesmo ponto). Agora o admin pode declarar o bairro ("Pinheiros"; em Portugal, a freguesia) e o motor
  geocodifica "bairro, cidade" UMA vez (Nominatim, como a cidade; ver resolverBairro). Achou perto da cidade → o ponto do
  time passa a ser o do bairro (~1 km); não achou → fica o ponto da cidade e o app avisa. Freguesia escolhida na lista do app
  (Portugal) vem com a coordenada e dispensa a chamada. Só o bairro e a cidade, nunca o endereço.
  RODADA 29T-C: o mesmo vale para o bairro/distrito escolhido da lista no Brasil (IBGE) — o ponto da lista vale em qualquer país,
  desde que perto (RAIO_DO_BAIRRO_KM) do ponto da cidade; o Nominatim não diz "Não achamos" para um bairro que o app ofereceu.
- (linha ~115, `const RAIO_DO_BAIRRO_KM = 60; // um bairro fica perto do centro da cidade; mais…`) ─── O bairro (29H) ───────────────────────────────────────────────────────────────────────────────────────────────
- (linha ~136, `function lerPontoDaLista(corpo, cidadeGeo) {`) O bairro escolhido na lista do app (freguesia em Portugal, bairro/distrito no Brasil): { lat, lng } arredondado, ou null.
  29T-C: vale em qualquer país, desde que o ponto esteja a até RAIO_DO_BAIRRO_KM do ponto da cidade (`cidadeGeo`); longe demais, ou
  sem ponto da cidade para comparar, não vale como "da lista" — quem chamou cai na geocodificação de sempre.

## utils/compras.js

- (linha ~1, `const crypto = require('node:crypto');`) Futty v2.0 — Compras: a regra de crédito num lugar só (Pagamentos P1, 26-set).

  Toda concessão de figurinha passa por aqui, venha de onde vier: a loja (webhook do
  RevenueCat, routes/compras.js), o "Restaurar compras" do app, ou a mão do dono no
  Gabinete (loja 'gabinete', transação `gab-<uuid>`, preço 0). Cada uma vira UMA linha em
  `compras` (migração 064) — e o índice único (loja, transacao_id) é a trava contra
  crédito em dobro: o RevenueCat reenvia webhooks e o restauro pode chegar antes ou
  depois dele, com a mesma transação.

  A ordem é: grava a linha → aplica o efeito → marca creditada_em. Se o efeito falhar, a
  linha é apagada e o erro sobe (o webhook responde 5xx e o RevenueCat reenvia). Crédito
  sem linha nunca existe; linha sem crédito só dura o tempo de um erro.

  Fábrica com o Supabase e o push injetáveis: os testes (tests/compras.test.js) correm
  sem banco, com um Supabase falso em memória.
- (linha ~20, `const MINHA_GERACOES = 10;`) Rodada 21 (24-set): a Minha Figurinha dá 10 gerações.

## utils/comPrazo.js

- (linha ~1, `function comPrazo(promessa, ms = 3000, rotulo = 'Storage') {`) Futty v2.0 — Prazo para promessas que podem ficar penduradas (Rodada 8B, 15-set).

  O Storage do Supabase, numa rede ruim ou instável, pode simplesmente nunca
  responder — nem sucesso nem erro, só silêncio. Um try/catch não ajuda nesse
  caso: a promessa não REJEITA, fica pendurada, e quem está à espera (o
  /api/inicio, por exemplo) trava com ela. `seguro()` (routes/inicio.js) já
  devolve null para qualquer parte que FALHE — mas uma promessa pendurada não
  é uma falha, é o próprio pedido nunca terminar.

  comPrazo() faz a promessa competir contra um relógio: se não resolver nem
  rejeitar a tempo, a promessa devolvida REJEITA com um erro claro. A ida real
  continua a correr ao fundo (sem AbortController não há como cancelá-la de
  verdade), mas ninguém mais espera por ela — e, para o Node não se queixar de
  uma rejeição sem dono se ela chegar tarde, fica sempre alguém a apanhá-la.

  @param {Promise} promessa - já em curso (chamar a função ANTES de passar aqui).
  @param {number} [ms] - prazo em milissegundos.
  @param {string} [rotulo] - aparece na mensagem de erro (qual ida era).

## utils/conviteCodigo.js

- (linha ~1, `const crypto = require('node:crypto');`) Futty v2.0 — Rodada 29H (item 7): o link curto do convite, futtyapp.com.br/c/<código>.

  O convite continua sendo uma linha de `convites` com o token longo (uuid) — o link /convite/<uuid> segue válido, igual. O
  código é só outro jeito de chegar à MESMA linha (tabela `convite_codigos`, migração 072): mesmo prazo (vale o
  `expires_at` do convite), some junto se o admin revoga (ON DELETE CASCADE). Aqui vivem as quatro peças pequenas disso:
  gerar o código, reconhecê-lo, gravá-lo e achar o convite a partir de um parâmetro que pode ser uuid OU código.

  Alfabeto: minúsculas e números sem os que se confundem (0/o, 1/l/i): 31 símbolos; 8 posições ≈ 8,5 × 10^11 combinações.
  O link vai pro WhatsApp e às vezes é ditado: nada de maiúscula/minúscula para errar. A leitura aceita 6–8 posições e
  qualquer caixa (digitaram "K7M2P9QX" no celular).

## utils/custoPorTime.js

- (linha ~1, `function mesEmBrasilia(iso) {`) Futty v2.0 — Custo real das figurinhas por time e por mês (Rodada 28, bloco H). Puro: quem busca
  as linhas é routes/gabinete.js; aqui só se agrupa (e o teste prova a conta).

## utils/db.js

- (linha ~1, `require('dotenv').config({ quiet: true });`) Futty v2.0 — Camada de acesso à base de dados (cliente Supabase + helpers).
  { quiet: true } (23-set): silencia os "tips" promocionais do dotenv nos
  scripts (utils/db.js é o require mais comum entre eles) — ver server.js.
- (linha ~12, `const { SUPABASE_URL } = process.env;`) Rodada 28: a chave secreta nova (SUPABASE_SECRET_KEY, sb_secret_…) manda; a
  service_role antiga (SUPABASE_SERVICE_KEY) só vale enquanto a nova não estiver no
  ambiente. Ver utils/chavesSupabase.js.
- (linha ~33, `const pedeFuso = !/\bfuso\b|\*/.test(cols);`) Rodada 29I (achado 83): o fuso do time vai em TODA leitura de time — a resposta que devolve `team` já leva a hora do campo.
  Sem a migração 076 a leitura repete sem a coluna (utils/fuso.js#lerComFuso) e o time vale o padrão.
- (linha ~126, `async function loadGame(id) {`) Carrega um jogo com a equipa associada (game.teams, com o fuso, a cidade e o escudo dela — 29I). Null se não existir.
- (linha ~183, `async function goleirosDoTime(teamId, userIds) {`) Rodada 9: quem é goleiro DO TIME. É o padrão de cada jogo: quem confirma sem
  dizer nada entra como goleiro.
  Rodada 10B: a fonte passa a ser SÓ team_members.categoria ('GR'). A coluna
  `posicao` ('GL'|null) era a mesma decisão guardada duas vezes — o dono
  decidiu manter uma só, e é esta (é a que já mandava no ranking).
  @param {string} teamId
  @param {string[]} [userIds] restringe a consulta (omitir = time inteiro)
  @returns {Promise<Set<string>>} user_ids marcados como goleiro no time

## utils/denunciaStore.js

- (linha ~1, `const crypto = require('crypto');`) Futty v2.0 — Denúncias + triagem — camada de dados SEM DDL (Tijolo 3, Fase B).
  À boleia do padrão da casa (campeonatoStore): cada denúncia vive como um JSON no
  Storage (bucket privado "denuncias"), o LOG é append-only (eventos[] nunca se
  reescreve destrutivamente — só se acrescenta) = escudo jurídico. O dono é cego
  (só agregados). A tabela antiga `denuncias` (009) fica INTOCADA.
- (linha ~32, `async function obterReporter(userId) {`) Rodada 8B: prazo de 3 s (comPrazo) em toda LEITURA do Storage deste módulo —
  uma ida sem resposta nunca pode prender quem chama (ex.: obterDesfechosDenuncias,
  no caminho de /api/inicio, embrulhado em seguro() do lado de lá).
- (linha ~69, `const aoGravarCaso = [];`) VELOCIDADE 6A (15-set): quem lê casos em rota quente (services/inicio.js,
  obterDesfechosDenuncias) guarda o resultado em cache por equipa. Gravar um
  caso tem de esquecer essa cache, senão o utilizador não via o desfecho da
  própria denúncia durante minutos. Registado por quem cacheia, chamado aqui.

## utils/derivadosMidia.js

- (linha ~1, `const crypto = require('node:crypto');`) Futty v2.0 — Derivados da mídia (Rodada 27, 25-set): o LRU em memória dos derivados WebP
  do proxy de imagem e a receita que os gera, num módulo só, para o PROXY (routes/media.js)
  e o UPLOAD DA FOTO (routes/auth.js) partilharem um cache.

  Por que isto existe. O proxy gera cada tamanho da foto na PRIMEIRA vez que alguém o pede
  (baixa o original do Storage, redimensiona, guarda no LRU). Depois de "Trocar foto" o primeiro
  pedido de cada tamanho era da própria pessoa, olhando a tela, e pagava tudo isso: ida ao
  Storage + sharp. Agora quem grava a foto já tem os bytes na mão e deixa os derivados que as
  telas vão pedir prontos (aquecerDerivados), sem baixar nada.

  Os derivados NÃO são gravados no Storage de propósito: um WebP de rosto que sobrevivesse à
  conta apagada seria um órfão com PII (LGPD). O LRU em memória morre com o processo.

  Vive só neste processo (nada distribuído): cada instância do Cloud Run tem o seu LRU. O
  aquecimento vale para a instância que recebeu o upload; nas outras o proxy gera na hora, como
  sempre gerou. Só a chave (bucket, caminho, versão, largura, quadrado) decide se é o mesmo derivado.
- (linha ~69, `function chaveDoDerivado({ bucket, path, v, largura, quadrado, recorte = null }…`) A chave do derivado: o `v` entra nela, conteúdo novo nunca é servido a partir de um derivado velho.
  O recorte (Rodada 29B, E) só entra quando conta — quadrado COM recorte —, para a chave de tudo o
  que não tem recorte continuar exatamente a de sempre (e o aquecimento do upload continuar a bater).
- (linha ~82, `async function gerarDerivado(original, tipoOriginal, { largura, quadrado, recor…`) A receita: os bytes do original → o derivado ({ buf, tipo }). GIF (animado) e o que não for
  imagem conhecida passam intactos: converter um GIF para WebP estático mataria a animação.
  `quadrado` corta o quadrado do TOPO (RODADA 19: o recorte 2:3 já garante o rosto no terço de
  cima; a 'attention' falhava em fotos de corpo inteiro, escolhendo o pulso em vez do rosto).
  `recorte` (Rodada 29B, E): a janela quadrada que a pessoa escolheu para a miniatura (utils/recorteAvatar.js)
  substitui o "quadrado do topo" — só vale junto de `quadrado`.

## utils/diagnosticoStore.js

- (linha ~1, `const { supabase } = require('./db');`) Futty v2.0 — Relatórios de diagnóstico do app (VELOCIDADE 4).

  O app mede-se a si próprio (frontend/src/lib/diagnostico.js) e a pessoa pode
  enviar o que mediu. Isto guarda esse JSON. À boleia do padrão do
  denunciaStore/gabineteStore: sem DDL, cada relatório é um ficheiro no bucket
  privado "denuncias", debaixo do prefixo "_diagnostico/" — o mesmo sítio onde
  já vive o "_gabinete/operacao.json".

  Um ficheiro por envio, nomeado pelo instante: ordenar por nome é ordenar por
  tempo, e não é preciso índice nenhum para saber quais são os últimos.

  O que aqui entra não tem corpo de pedido, token nem conteúdo de utilizador —
  só rotas, estados e tempos (ver o que o frontend recolhe).

## utils/direitoBrilhante.js

- (linha ~1, `const { supabase } = require('./db');`) Futty v2.0 — Quem pode gerar uma Figurinha Brilhante (SPEC-FIGURINHA-3, §5).

  Desde 22-set toda geração de IA nasce paga. Há dois direitos:

    1. CRÉDITO  `users.brilhante_creditos > 0` — comprou a "Minha Figurinha"
       (+10) ou recebeu crédito à mão pelo Gabinete. O uniforme é à escolha
       entre os 5. (O presente do criador de time, +3 ao criar o time, foi
       ABOLIDO em 26-set pelo dono: conta grátis não gera nada, nunca.)
    2. TIME     é membro de um time com `teams.brilhante_ativo` e ainda tem
       geração no pacote: sem linha em `brilhantes_time` para
       (team_id, user_id) OU `geracoes < teams.brilhante_por_jogador` (2,
       migração 065; era 5 na 059), dentro de `teams.brilhante_limite` (25
       jogadores). O uniforme é o do time (`teams.brilhante_kit`), fixado
       pelo dono.

  Depende da migração 054. SEM ela aplicada tudo aqui falha SEGURO: devolve
  `{ fonte: null }` e regista um aviso — ninguém gera, ninguém gasta dinheiro.
  É o contrário do fail-open da cota da Resenha (utils/resenhaCota.js): lá o
  pior caso é um time passar da cota; aqui seria a casa pagar US$0,11 por
  cadastro, que é exatamente o que esta spec veio acabar.

  Migração 059 (Rodada 21) é o MESMO tipo de fail-safe: sem a coluna
  `geracoes`, o motor lê "existe linha = já gerou a única vez que se sabia
  dar" (o comportamento de antes da 059) — nunca deixa passar mais gerações
  do que o banco sabe contar.
- (linha ~51, `custoCents: data?.custo_cents ?? null,`) Rodada 28: o custo JÁ gasto nesta linha — a geração nova SOMA a ele (ver debitar).
- (linha ~69, `function somarCusto(anteriorCents, destaCents) {`) RODADA 28 (achado da Rodada 22) — o custo de uma linha do pacote é a SOMA das gerações dela.
  O upsert gravava o custo da geração atual por cima do anterior: refazer 5 vezes deixava no
  Gabinete só o custo da última. Sem custo nenhum conhecido fica null (o Gabinete conta à parte
  as gerações sem custo gravado, para o total não se passar por completo).
- (linha ~129, `const soOrganiza = membros?.length ? await timesEmQueSoOrganiza(userId) : new S…`) Rodada 29B (E): quem só organiza o time não joga — não usa o pacote (nem as gerações, nem uma das 25 vagas).
- (linha ~140, `if (usadas >= porJogador) continue;`) Rodada 29A: o pacote caiu de 5 para 2. Quem já tinha gasto mais de 2 antes da mudança
  fica sem geração nova — e `restantes` nunca sai negativo (clamp em 0 logo abaixo).
- (linha ~184, `async function somarCreditos(userId, qtd, cliente = supabase) {`) Soma `qtd` (negativo debita) a `users.brilhante_creditos` e devolve o saldo
  novo — nunca abaixo de zero. Pagamentos P1: pela função atómica da migração
  064 (`update ... set x = x + n` num passo só); o ler-e-gravar antigo perdia
  uma soma quando duas escritas caíam juntas (webhook + restaurar compras).
  Sem a 064 no banco, cai no ler-e-gravar de sempre com aviso — nunca quebra.
  `cliente` injetável para os testes de utils/compras.js (Supabase falso).
- (linha ~223, `const { usadas, custoCents: jaGasto, colunaExiste } = await geracoesNoTime(dire…`) Rodadas 21/22/29A — o pacote dá várias gerações por jogador (2 desde a 29A), não 1:
  `geracoes` conta quantas essa pessoa já usou NESTE time, e o upsert
  tem de a SOMAR, não substituir. Lê-e-escreve (uma pessoa não gera
  duas ao mesmo tempo) — sem linha ainda, começa de 0 (a que está a nascer é a 1ª).
- (linha ~233, `custo_cents: somarCusto(jaGasto, custoCents),`) Rodada 28: SOMA à linha (antes o upsert punha só o custo desta geração por cima).

## utils/entradaFigurinha.js

- (linha ~1, `const sharp = require('sharp');`) ═══════════════════════════════════════════════════════════════════════════════
  A ENTRADA DA FIGURINHA — o que se manda à IA junto com o prompt (17-set).

  Vem da variante 6 da bancada (`scripts/_bench/testar-prompt.js`), a que o dono
  escolheu: faixa de 18% no topo + corte QUADRADO 1024×1024 com a cabeça a 12%
  do topo. Ganha duas vezes:
    • semelhança — 4,1/5 contra 4,0 da mesma receita em retrato, melhor em 6 das
      7 fotos (a foto quadrada dá à IA menos cenário e mais cara);
    • dinheiro — US$0,112 contra US$0,132, porque a fal cobra os tokens da
      imagem de ENTRADA ($0,008 por 1.000; uma imagem 1024×1024 em fidelidade
      alta são 3.050 tokens) e o quadrado é menor que o retrato.
  A SAÍDA continua 1024×1536 — o corte é só da entrada.

  A faixa de 18% no topo é herança da receita antiga e fica: é ela que impede a
  IA de ancorar no enquadramento do input e comer a coroa da cabeça.
  ═══════════════════════════════════════════════════════════════════════════════
- (linha ~75, `async function preprocessarQuadrado(buf) {`) A ENTRADA DE PRODUÇÃO desde 17-set: faixa de 18% no topo, corte quadrado com
  a cabeça a 12% do topo, 1024×1024, JPEG q90.
  Sem pele encontrada, o quadrado assenta no topo da faixa — nunca abaixo, para
  não cortar a cabeça.

## utils/escudo.js

- (linha ~1, `const PALETA = ['roxo', 'azul', 'ciano', 'gramado', 'lima', 'ouro', 'laranja',…`) Futty v2.0 — Rodada 29I, bloco 3 (achado 102 + bancadas aprovadas pelo dono em 2-out): o escudo do time sem logo.

  UM controle: cor principal + segunda cor + padrão. Paleta FIXA de 12 cores nas duas pontas, 6 padrões = 864 escudos, todos
  legíveis em 84, 36 e 20 px (DESIGN/escudo-cores.html, DESIGN/escudo-padroes.html). Reprovados pelo dono e fora daqui: RGB livre,
  quadriculado, listras finas, pontinhos, gradiente. As chaves são as MESMAS do app (frontend/src/utils/escudo.js) e da regra do banco
  (migração 077). A cor principal continua em teams.cor; a chave antiga 'verde' sempre foi mostrada como roxo e segue valendo assim.
  Puro (sem banco), para testar no Node.

## utils/falFila.js

- (linha ~1, `const BASE_FILA = 'https://queue.fal.run';`) ═══════════════════════════════════════════════════════════════════════════════
  A FAL PELA FILA REST — e o custo REAL de cada chamada (17-set).

  Porque não o SDK: o `fal.subscribe` do @fal-ai/serverless-client devolve o
  resultado e deita fora os headers da resposta. E é num header que vem o que
  interessa saber: `x-fal-billable-units`, o custo em dólares daquela chamada.

  Sem isso a casa andou desde julho a acreditar num custo de tabela ($0,015 por
  figurinha) que só contava a imagem de SAÍDA. A fal cobra quatro coisas na
  mesma chamada — texto do prompt, tokens de imagem de ENTRADA (os caros:
  $0,008 por 1.000, e uma imagem 1024×1024 em fidelidade alta são 3.050),
  raciocínio, e a imagem de saída. A receita que estava no ar custava $0,132.
  Medir é barato; adivinhar custou 9× o previsto.

  SEGURANÇA (SEGURANCA-REVISAO-10SET.md secção 3): nada aqui loga a chave da
  fal nem o URL assinado da foto do utilizador. O texto de erro da fal passa
  por `limpar()` antes de chegar a qualquer log.
  ═══════════════════════════════════════════════════════════════════════════════

## utils/figurinhaRegra.js

- (linha ~1, `const MARCADOR_BUCKET_AVATARS = '/storage/v1/object/public/avatars/';`) Futty v2.0 — A regra ÚNICA de "esse avatar é uma figurinha IA" (Rodada 20, corrigida no
  Hotfix 26, 25-set).

  O motor decidia por `avatar_url <> foto_url`. Só que o trigger handle_new_user (001)
  copiava a foto de perfil da conta Google para users.avatar_url, então quem entrava com
  o Google "tinha figurinha" sem nunca ter gerado: a foto nova ia para foto_url e o card
  (avatar_url) nunca mudava. Comparar URLs não diz o que o arquivo é; o nome dele diz.

## utils/fuso.js

- (linha ~1, `const tzLookup = require('tz-lookup');`) Futty v2.0 — Rodada 29I (achado 83): o fuso horário do time.

  A hora de um jogo é a hora do CAMPO, sempre: quem viaja continua vendo "quinta, 20h". O jogo fica gravado como instante
  (UTC, timestamptz); o que diz "que horas são no campo" é o fuso do time (teams.fuso, migração 076, padrão
  America/Sao_Paulo), derivado da cidade quando o time nasce ou muda de cidade.

  Este módulo é puro (sem banco, sem rede): o padrão, a validação, a derivação a partir da coordenada, as contas de relógio
  de parede no fuso (para o servidor escrever e interpretar horas sem depender do TZ do processo — o Cloud Run roda em UTC) e
  a leitura tolerante da coluna `fuso` enquanto a migração 076 não foi aplicada.
- (linha ~127, `const COLUNAS_NOVAS_DO_TIME = ['fuso', 'escudo_cor2', 'escudo_padrao', 'jogador…`) Rodada 29I, bloco 3: o mesmo jeito vale para TODAS as colunas novas do time — o fuso (076), o escudo de duas cores e padrão (077)
  e os jogadores por time padrão (079). Elas viajam juntas nas leituras do time (a mesma ida ao banco); a que faltar sai da leitura
  SOZINHA (o erro do banco diz qual é) e as outras continuam valendo — com a 076 aplicada e a 077 não, o fuso vale e o escudo fica
  sólido. Cada uma que falta vale o seu padrão (fuso de São Paulo, escudo sólido, 5 por time) até o Pedro aplicar a migração dela.

## utils/gabineteStore.js

- (linha ~1, `const { randomUUID } = require('crypto');`) Futty v2.0 — Gabinete: store JSON dos dados editáveis à mão pelo dono (Operação +
  Publicidade). Mesmo padrão dos campeonatos/denúncias (Storage privado, sem DDL).
  Vive no bucket privado "denuncias" (owner-only) sob `_gabinete/operacao.json` — zero
  PII, só dinheiro/infra/registos. Seed = os valores reais de PAINEL-E-CUSTOS.md
  (editáveis; NÃO são medições — são estimativas do dono a ajustar à mão).

  Gabinete 2.0 (11-set): custos_fixos e registros ganharam schema novo (campos
  explícitos da aba Dinheiro/Registros do painel de 5 abas). custos/registos
  (schema antigo) saem — a página velha de 16 secções que os lia foi substituída.
  cobertura/protecao_dados/toggles continuam a existir (a Gabinete.jsx só deixa
  de MOSTRAR essas secções atrás da flag MOSTRAR_AVANCADO — o dado não morre).
- (linha ~22, `cambio_usd_eur: 0.86,`) Câmbio US$→€ (14-set): a fal cobra em dólar (gasto_ia_diario), mas o
  painel de Dinheiro passou a mostrar tudo em euros (custos já regravados
  em EUR) — este número converte o card "IA do mês" para o mesmo padrão.
  Editável à mão na aba Dinheiro; não há fonte automática de câmbio.
- (linha ~80, `toggles: { inicio: false, resenha: false, ranking: false, figurinha: false, sor…`) toggle por página (default OFF). Chaves = as páginas onde há slot de publicidade.
  Rodada 12C (16-set): entraram 'resenha', 'ranking' e 'figurinha' — a Resenha
  pedia 'inicio' emprestado (não dava para ligar uma sem a outra) e as outras
  duas não tinham slot nenhum. Nada no motor valida estes nomes: obterAd faz
  `toggles[pagina] !== true` e `c.paginas.includes(pagina)`, os dois
  fail-closed — uma página desconhecida devolve `ad: null` em vez de erro.
- (linha ~111, `if (pareceSegredo(a?.obs) || pareceSegredo(a?.custo_eur)) {`) P2 (26-set): a coluna "Custo €/mês" (custo_eur, texto livre) passa pela mesma trava.
- (linha ~119, `const TTL_MS = 30000;`) VELOCIDADE 6A (15-set): ler() corria um DOWNLOAD do Storage dentro de rotas
  quentes — um por /api/inicio e outro por /api/ads, em todo carregamento de
  tela. O ficheiro muda quando o dono edita o Gabinete: raríssimo. Cache de 30 s
  (mesmo padrão de utils/plataformaStore.js), invalidada em gravar() para o
  dono ver a própria edição de imediato.
  Velocidade 7A: leituras simultâneas (arranque frio) esperam o MESMO download,
  e depois dos 30 s sai o valor conhecido enquanto o novo baixa por trás.
- (linha ~130, `async function lerRaw() {`) Lê SEM cache — usado por gravar(), para não gravar por cima de escrita alheia.
   Rodada 8B: prazo de 3 s (comPrazo) — este é o download que /api/inicio e
   /api/ads pagam em toda tela fria; sem prazo, uma ida sem resposta prendia
   a tela inteira (o catch já existia, mas não protege contra uma promessa
   pendurada, só contra uma que rejeita).

## utils/geocode.js

- (linha ~8, `function nomeOficialDoNominatim(item) {`) O nome que a pessoa vê em "Encontramos: …" (Rodada 29B, D): o nome do lugar e a região — "Brasília, Distrito Federal",
  "Porto, Portugal". Só o que o Nominatim diz do lugar; nunca a morada.

## utils/geracaoFigurinha.js

- (linha ~1, `const sharp = require('sharp');`) ═══════════════════════════════════════════════════════════════════════════════
  A RECEITA DA FIGURINHA BRILHANTE — num sítio só. Duas, na verdade:

    'v6'            (PADRÃO desde 22-set, SPEC-FIGURINHA-3) — UMA chamada ao
                    gpt-image-1.5/edit em low com `input_fidelity: high`, foto
                    quadrada + imagem do kit, saída 1024×1536, birefnet no fim.
                    US$0,112. É a que o dono avaliou em 4,1/5 na bancada cega
                    de 17-set, a melhor de todas as testadas. A Brilhante é
                    PAGA — quem paga leva a melhor, não a mais barata.
    'duas-passadas' US$0,05, descrita em detalhe abaixo. Continua inteira e
                    disponível por `FIGURINHA_RECEITA=duas-passadas`: se um dia
                    o custo apertar, a troca é uma variável de ambiente.

  O QUE SEGUE descreve a receita das duas passadas (18/22-set).

  Porque duas: nenhum motor sozinho dava as duas coisas que a figurinha precisa.
  O gpt-image-2.5 acerta a CARA mas entrega um retoque de foto; o gpt-image-1.5
  pinta como a casa quer mas, sozinho e em fidelidade alta, custava US$0,112.
  Postos em série — o 2.5 faz o retrato, o 1.5 só repinta — sai US$0,05.

    passada 1   openai/gpt-image-2.5/flare/edit · low · foto quadrada + kit
                → a cara. US$0,025.
    entre elas  birefnet + composição sobre #8a8a8a: a passada 2 tem de receber
                o jogador num fundo CHAPADO. O prompt da passada 1 pede cinza,
                mas modelo nenhum promete fundo sem sombra — e uma sombra no
                fundo vira mancha pintada na passada 2.
    passada 2   fal-ai/gpt-image-1.5/edit · low · input_fidelity LOW · 1 imagem
                → o acabamento. Fidelidade BAIXA de propósito: são 135 tokens de
                imagem em vez de 3.050, e a imagem que entra já é a resposta
                certa — não há nada para "ler com atenção". US$0,020.
    birefnet    o recorte final que a composição do app usa. US$0,002.

  O QUE ESTA BANCADA REPROVOU (não reabrir sem motivo, ver CLAUDE.md):
  encolher as imagens de entrada (a fal tokeniza num tamanho canónico — o preço
  não muda), repintar com flux-2 klein (troca a pessoa), difusão direto da foto
  (cartoon) e kit só por texto (perde o emblema em 7 de 7).

  Esta função é a fonte ÚNICA: `routes/auth.js` e a bancada
  `scripts/_bench/testar-economia.js` chamam-na, ninguém copia a receita.
  ═══════════════════════════════════════════════════════════════════════════════
- (linha ~52, `const RECEITA = process.env.FIGURINHA_RECEITA === 'duas-passadas' ? 'duas-passa…`) A RECEITA (SPEC-FIGURINHA-3, 22-set): a Brilhante é paga, por isso leva a
  MELHOR — a V6, que o dono avaliou em 4,1/5 contra as duas passadas. As duas
  passadas ficam disponíveis por env (`FIGURINHA_RECEITA=duas-passadas`):
  custam US$0,05 contra US$0,112 e servem se um dia o custo apertar.
- (linha ~64, `const TAMANHO_2_5 = { width: 1024, height: 1536 };`) A saída fica em retrato: é o que dá altura para cabeça + busto sem cortar a
  coroa (receita de 30-jul; em quadrado o achatamento ia a 0,72). Os dois
  motores querem o tamanho em formatos DIFERENTES e trocá-los dá 422: o
  gpt-image-1.5 só aceita o enum em string, o 2.5 aceita {width,height}.
- (linha ~102, `if (receita === 'v6') {`) ── V6: uma chamada só, fidelidade ALTA, foto quadrada + kit ──
  A receita que o dono escolheu em 17-set (4,1/5 na avaliação cega das 7
  fotos) e que desde 22-set é a da Brilhante, porque a Brilhante é paga.

## utils/geracaoJobs.js

- (linha ~1, `const crypto = require('node:crypto');`) ═══════════════════════════════════════════════════════════════════════════════
  A PINTURA DA FIGURINHA EM SEGUNDO PLANO (Rodada 29B, bloco 2, parte A — 1-out).

  Por quê: a geração segurava o pedido HTTP por ~45 s (~90 s com o retry da
  cabeça cortada) e a Cloudflare corta um pedido aos 100 s. Agora o POST de gerar
  devolve na hora `{ jobId, estimativaSegundos }`, a pintura roda aqui — numa fila
  em memória do PRÓPRIO processo, uma por vez por usuário — e o app consulta
  GET /api/figurinha/job/:id. O trabalho em si (as chamadas à fal pela
  utils/falFila.js, o auditor da coroa, o débito do direito) continua sendo o de
  sempre, na função `pintarFigurinha` de routes/auth.js; este módulo só cuida de
  QUEM está pintando, EM QUE PÉ, e do que fazer quando acaba ou quando o processo
  morre no meio.

  O registro durável é a tabela `geracoes_jobs` (migração 069). Sem ela o motor
  continua pintando — a fila vive em memória —, só perde o que sobrevive a um
  reinício (e a consulta vinda de outra instância do Cloud Run).

  LEI DA CASA: nunca gastar geração sem entregar. O direito só é debitado dentro
  da pintura, DEPOIS de a figurinha estar gravada; um job que morre antes disso
  (reinício, deploy, fal fora do ar) termina 'falhou' e não custa nada a ninguém.

  O QUE ESTE MÓDULO NÃO FAZ: não escolhe kit, não checa direito, não fala com a fal.

  BLOCO 2-A2 (1-out): com o Cloud Tasks ligado (utils/tarefasPintura.js) o POST só REGISTRA o job e
  enfileira uma tarefa; quem pinta é POST /api/interno/pintar/:jobId, DENTRO de um pedido (o Cloud
  Run só dá CPU enquanto há pedido). `reivindicar` é a porta de entrada desse pedido — atômica e
  idempotente — e `adotar` põe o job na memória DESTE processo para ele pintar como sempre pintou.
  ═══════════════════════════════════════════════════════════════════════════════

## utils/idade.js

- (linha ~1, `const IDADE_MINIMA = 18;`) Futty v2.0 — A régua de idade do cadastro (Rodada 29G, 1-out: o Futty é 18+ de ponta a ponta).

  O Futty é para maiores de 18 anos. A conta não nasce abaixo disso: o app pergunta a data no cadastro
  (e-mail) e no onboarding (Google/Apple, que não trazem a data), e o motor confere de novo — ver
  PATCH /api/me e POST /api/me/onboarding-completo. Conta que já existia com data menor de 18 não é
  apagada pelo motor: o app mostra a tela com "Excluir minha conta". O número mora SÓ aqui (e no
  espelho frontend/src/utils/idade.js); rostoPublico.js e services/inicio.js usam estas funções.

## utils/jogadoresPorTime.js

- (linha ~1, `const PADRAO = 5;`) Futty v2.0 — Rodada 29I, bloco 3 (item 68 da Rodada 29): jogadores por time, UM padrão no time.

  Era perguntado duas vezes — na criação do time e em cada jogo novo. Agora o time guarda o seu padrão (teams.jogadores_por_time,
  migração 079; Ajustes do time) e o "Novo jogo" e os recorrentes já nascem com ele; cada jogo continua podendo mudar só para si
  (games.jogadores_por_time). Sem a migração, ou sem padrão escolhido, vale 5 — o que os recorrentes sempre usaram.
  Puro (sem banco), para testar no Node.

## utils/mediaToken.js

- (linha ~1, `const crypto = require('crypto');`) Token de capacidade para o proxy de imagem (Tijolo 2).
  Um <img> não pode enviar o header Authorization, por isso a autorização viaja
  NO URL: um token HMAC assinado por nós, emitido só dentro de respostas já
  autenticadas (middleware mediaUrls). O proxy valida a assinatura + validade e
  serve o ficheiro do bucket privado. Segredo = server-only (nunca no cliente).
- (linha ~87, `return { bucket: alvo.bucket, path: alvo.path, v: alvo.v };`) Tokens emitidos antes da Velocidade 6A não têm `v` — continuam válidos.

## utils/notificacoes.js

- (linha ~1, `const CATEGORIAS = ['jogos', 'pedidos', 'figurinha', 'resenha'];`) Futty v2.0 — Rodada 29I, bloco 3 (item 4): as notificações que cada pessoa quer receber.

  Perfil → Notificações tem um interruptor por tipo. Todos ligados por padrão: `users.notificacoes` (migração 079) guarda só o
  que a pessoa DESLIGOU — {"pedidos": false}; chave ausente = ligada. Vale para o push e para o aviso dentro do app.
  Sem a migração 079 a coluna não existe: ninguém tem nada desligado (como sempre foi) e gravar responde 503.
  Puro, menos `quemQuer` (que lê o banco que lhe passam), para testar no Node.

## utils/nsfwFilter.js

- (linha ~1, `const path = require('node:path');`) Filtro de conteúdo — NSFWJS no caminho dos uploads de imagem.
  Tijolo 1 da fase Segurança: bloqueia explícito ANTES de a imagem ser guardada.

  Decisões (SPEC-SEGURANCA v2):
  - modelo carrega UMA vez (singleton) — ideal: no arranque do servidor;
  - só bloqueia em ALTA confiança (Porn/Hentai > LIMIAR); "Sexy" médio NÃO bloqueia
    (a calibração fina é o tijolo 2 — Fable);
  - falso-positivo custa mais que falso-negativo numa rede de amigos → limiar alto;
  - FALHA ABERTA em erro de infra (modelo não carrega / decode falha): regista e
    deixa passar, para um problema técnico não derrubar TODOS os uploads. A recusa
    é só por deteção positiva, nunca por avaria.
- (linha ~16, `const LIMIAR = 0.75; // max(Porn,Hentai) acima disto = recusa. NUNCA se usa Sex…`) ─────────────────────────────────────────────────────────────────────────────
  LIMIAR — CALIBRADO (Tijolo 2). LEI, não palpite. Medido por scripts/calibrar-nsfw.js
  contra uma bateria LIMPA de 15 imagens (11 fotos reais da casa + 4 proxies dos
  extremos do futebol amador). Resultado (max na bateria legítima):
    max PORN   = 0.016 · max HENTAI = 0.025 · max explícito = 0.025
    max SEXY   = 0.947  ← uma celebração de campeão (sem-camisa/abraço colado):
                          SEXY altíssimo mas PORN 0.001. POR ISSO **nunca bloquear
                          em Sexy** — mataria celebrações, praia, balneário.
  Só bloqueamos em PORN/HENTAI. O fosso é enorme (legítimo ≤ 0.025 vs explícito
  real ~0.9+), o que dá para descer de 0.85 → 0.75 e ganhar sensibilidade a
  conteúdo mesmo assim com ~30× de margem sobre o pior caso legítimo (0.025).
  0 falsos positivos na bateria a QUALQUER limiar entre 0.6 e 0.9.
  Se surgir falso positivo real, SOBE este número (não desças abaixo de 0.6).
- (linha ~30, `const MSG = 'Esta imagem não pode entrar no Futty. Escolha outra e siga em fren…`) MENSAGEM ÚNICA (decisão Tijolo 2): variar por categoria vazaria o motivo
  (= detalhe técnico proibido) e podia envergonhar. Uma frase neutra e digna serve
  todos os casos e não dá pista para "afinar" um upload malicioso.
- (linha ~41, `async function escolherBackend(tf) {`) RODADA 27 (25-set) — o classificador roda no backend WASM do tfjs, não no CPU em JS puro.
  O motor não tem o tfjs-node, e o backend padrão em JS puro levava ~1 040 ms para classificar UMA
  foto de 224×224 (medido na bancada); no WASM são ~76 ms, com as MESMAS probabilidades (Neutral
  0,699 · Drawing 0,279 · Hentai 0,014 · Porn 0,007 · Sexy 0,002 numa imagem de prova). Era a
  maior fatia do POST /api/me/avatar (a rede do Supabase, de São Paulo a São Paulo, é barata).
  Se o WASM não subir (binário, CPU, versão do Node), fica no CPU e regista: uma avaria de
  desempenho nunca pode derrubar o upload nem o filtro.

## utils/olheiroEntrada.js

- (linha ~1, `const sharp = require('sharp');`) Futty v2.0 — Olheiro de entrada (11-ago): barra foto sem futuro ANTES de
  gastar geração de avatar IA. Corre no upload da foto de perfil, ANTES de
  guardar — reprovado não consome nada (nem Storage, nem cota de IA).

  Pisos CONSERVADORES (provado na bancada: foto de nitidez 4 gera bem — por
  isso NITIDEZ NÃO reprova). Só barra o que é matematicamente impossível
  salvar: foto minúscula, ficheiro corrompido, ou preto/estourado total.
  Medições baratas via sharp (metadata + stats), sem modelo nenhum.

  Ao contrário do filtroNSFW (que falha ABERTO em qualquer erro técnico),
  aqui "não decodifica" é um dos critérios de reprovação — é um sinal em si
  (ficheiro corrompido nunca vai gerar nada de bom). Só um erro INESPERADO no
  próprio filtro (bug aqui, não na imagem) falha aberto.

## utils/orfaos.js

- (linha ~1, `const UM_DIA_MS = 24 * 60 * 60 * 1000;`) Futty v2.0 — Quais arquivos do bucket `avatars` já não servem a ninguém (Rodada 28, bloco G).

  Puro: quem lista o bucket e lê o banco é scripts/limpar-orfaos.js; aqui só se decide. A limpeza da
  foto antiga roda DEPOIS da resposta (Rodada 27) e o Cloud Run sem "CPU sempre alocada" pode deixar
  esse trabalho pela metade — daí as sobras. Regras, todas do lado seguro:
    · órfão = nenhuma linha do banco aponta para ele (fotos, originais, figurinhas, slots, histórico,
      pacote do time, logo do time — ver REFERENCIAS em scripts/limpar-orfaos.js);
    · nada com menos de 1 dia (pode ser um upload ou uma faxina ainda em curso);
    · tmp/ é temporário por natureza (as passadas da geração): passou de 1 hora, é sobra;
    · objeto sem data não é tocado — melhor sobrar do que apagar o que não se sabe de quando é.

## utils/orientarFoto.js

- (linha ~1, `const sharp = require('sharp');`) Futty v2.0 — Auto-orientar a foto pelo EXIF, SÓ quando há o que corrigir (Rodada 27, 25-set).

  O recorte e a original que o app manda saem de um canvas (utils/normalizarFoto.js e o CropModal,
  no frontend): já em pé e sem EXIF. Recodificar isso a cada upload custava CPU (a original de
  celular, 3024×4032, ~175 ms), qualidade (JPEG de novo, a 80) e mais nada. Uma foto que traga EXIF
  (orientação, GPS, modelo do aparelho...) continua passando pelo .rotate().toBuffer(), que gira os
  pixels já em pé e DESCARTA o EXIF — a privacidade de antes fica igual.

## utils/pendenciasAdmin.js

- (linha ~1, `const JANELA_DA_PRESENCA_MS = 7 * 24 * 3600 * 1000;`) Futty v2.0 — Rodada 29I, bloco 3 (item 1): o card "Seu time" do Início, só para quem administra algum time.

  "Admin não é um lugar" (dono, 3-out): o que o Dashboard do painel mostrava vira, no Início, uma linha por pendência —
  pedido de entrada, jogo sem presença aberta, resultado por lançar, denúncia — e o card fica compacto ("Tudo tranquilo por
  aqui.") quando não há nenhuma. Aqui vive a conta, pura (sem banco), para testar no Node; a leitura está em services/inicio.js.

## utils/plataformaStore.js

- (linha ~16, `const CHAVE = 'suspensoes';`) Velocidade 7A (15-set): no arranque frio, os 3 pedidos simultâneos do app
  baixavam este arquivo 3 vezes. Agora quem chega junto espera o mesmo download.
  E passados os 15 s ninguém mais espera: sai a lista conhecida e o download
  novo corre por trás. Numa instância parada há horas, uma suspensão feita por
  OUTRA instância vale a partir do segundo pedido, não do primeiro.
- (linha ~31, `async function lerRaw() {`) Lê SEMPRE do Storage (sem cache) — usado antes de gravar para não perder
  escritas concorrentes. Fail-open: erro → estado vazio (não bloqueia ninguém).
  Rodada 8B: prazo de 3 s (comPrazo) — sem ele, uma ida sem resposta prendia
  esta função (e quem a chama, como a gate de CADA pedido autenticado) para
  sempre; o catch já existia, mas não protege contra uma promessa pendurada.

## utils/premiosDoTime.js

- (linha ~1, `const MSG_ARTILHEIRO_PRECISA_DOS_GOLS = 'O artilheiro precisa dos gols ligados.…`) Futty v2.0 — Rodada 29I (achado 78): o "Artilheiro do dia" depende dos "gols" do time.

  Decisão do dono (3-out): quem desliga "Mostrar gols" desliga o artilheiro junto — o texto do próprio "Mostrar gols" diz que ele traz
  "o radar de 5 eixos, o bloco de Gols e o troféu de Artilheiro", então um time com gols desligados e artilheiro ligado se contradiz. O app
  já não deixa montar essa combinação (o artilheiro fica apagado quando os gols estão desligados); o motor também recusa, para nenhum
  app antigo nem pedido à mão gravar o time incoerente. Religar os gols NÃO religa o artilheiro: quem decide é a pessoa.
  Puro (sem banco), para testar no Node.

## utils/recorteAvatar.js

- (linha ~1, `const ESCALA_MAX = 3;`) Futty v2.0 — Rodada 29B (bloco 3, E): o recorte da MINIATURA do avatar — as contas puras.

  A miniatura redonda (Início, ranking, sorteio…) mostra uma JANELA QUADRADA da foto (ou da
  figurinha), que é 2:3. O recorte escolhido pela pessoa diz onde fica essa janela:
    x, y    o CENTRO da janela, em fração da imagem (0–1)
    escala  o zoom: 1 = a janela tem a largura da imagem (o maior quadrado que cabe); 3 = um terço dela

  Estas funções são a ÚNICA definição da janela. O app tem uma cópia idêntica
  (frontend/src/lib/enquadroAvatar.js) e os dois lados são provados contra os mesmos casos
  (tests/recorte-avatar.test.js ↔ scripts/unidade/enquadro-recorte.test.mjs): o que a pessoa
  vê ao arrastar a miniatura no editor é, ao pixel, o que o proxy de imagem entrega depois.

## utils/resenhaCota.js

- (linha ~1, `const { supabase } = require('./db');`) Futty v2.0 — Cota de mídia da Resenha por time (Rodada 15, 16-set).

  500 MB por time: uma foto de celular sem compressão pesa 3-5 MB; 100 GB do
  plano dariam só ~25 mil fotos. Depende da migração 053 (coluna
  feed_post_media.bytes + as funções feed_bytes_por_time/
  feed_bytes_por_todos_times). SEM ela aplicada, tudo aqui falha ABERTO —
  devolve null/{} em vez de lançar, e regista um aviso; quem chama trata
  null como "não sei, não bloqueio". O Pedro aplica a migração quando puder;
  até lá o upload/post funciona exatamente como antes.

## utils/restauro.js

- (linha ~1, `const ORDEM_TABELAS = [`) Futty v2.0 — A lógica pura do restauro de backup (Manutenção 26-set, item B.5).
  Separada de scripts/restaurar-banco.js (que só lê arquivo e fala com o Supabase)
  para poder ser testada sem rede — mesmo espírito de utils/orfaos.js.

  ORDEM_TABELAS respeita as FKs das migrações (backend/db/migrations/*.sql): quem é
  referenciado vem antes de quem referencia (users antes de teams, teams antes de
  team_members, games antes de votes/rsvp/gols_jogadores, etc.) — um upsert de uma
  tabela filha antes da mãe falha por violação de FK.

## utils/rostoPublico.js

- (linha ~1, `const { parseUrlPublico, urlDoProxy } = require('./storage');`) Futty v2.0 — Privacidade do rosto nas páginas públicas /p/ (Opção B aprovada).
  REGRA DURA (fail-closed): um rosto só se revela numa partilha pública SE o dono
  tiver IDADE_MINIMA anos (18, utils/idade.js; birthdate preenchida) E tiver o consentimento
  ligado (mostrar_rosto_publico, default TRUE). Sem 18 confirmados · sem birthdate · sem
  consentimento · convidado sem conta → SILHUETA, sempre. A idade manda mesmo com a flag ligada.
  Desde a Rodada 29G o app é 18+: esta é a 2ª linha, para nunca depender só do cadastro.

  Mecânica: o times_resultado é um snapshot congelado com avatar_url = URL público
  do bucket privado. Para quem PODE revelar, reescrevemos para um URL do PROXY
  (`/api/media/<token>`, público, token HMAC) — que NÃO bate no regex de
  despublicarPayload, logo sobrevive à varredura do middleware. Para quem não pode,
  pomos '' → o frontend cai na silhueta-casa. O middleware fica INTOCADO.

## utils/selosCache.js

- (linha ~1, `const { criarCache } = require('./cacheQuente');`) Futty v2.0 — Cache dos selos do usuário (GET /api/me/selos), 15-set, "Velocidade 7A".

  computeSelos (routes/campeonatos.js) faz, POR TIME, um list no Storage + um
  download por campeonato + o ranking inteiro: 515-525 ms de motor no relatório
  do Diagnóstico, para uma resposta que muda poucas vezes por semana. Fica em
  cache por usuário durante 2 min, com renovação por trás (utils/cacheQuente.js),
  e é esquecido NA HORA quando acontece o que mexe nos selos:
    · um campeonato termina ou é apagado          → routes/campeonatos.js
    · um voto é registrado ou zerado               → routes/ranking.js
    · alguém entra, sai ou muda de estado num time → routes/teams.js
  O resto (resultado de jogo, presença) mexe no ranking e aparece em até 2 min.

## utils/sorteioCodigo.js

- (linha ~1, `const { gerarCodigo, lerCodigo } = require('./conviteCodigo');`) Futty v2.0 — Rodada 29I, bloco 3 (item 74 da Rodada 29): o link curto do sorteio, futtyapp.com.br/s/<código>.

  O MESMO molde do link curto do convite (utils/conviteCodigo.js, /c/<código>): o sorteio continua morando em /p/<slug>/<id do jogo>
  — esse link segue valendo, igual —, e o código é só outro jeito de chegar ao MESMO jogo (tabela `sorteio_codigos`, migração 078;
  um código por jogo, some junto com o jogo). Mesmo alfabeto e tamanho do convite (gerarCodigo/lerCodigo vêm de lá).

## utils/storage.js

- (linha ~1, `const { supabase } = require('./db');`) Ajuda a APAGAR ficheiros no Supabase Storage a partir das suas URLs públicas.
  Tijolo 1B (peça 2): remover conteúdo tem de matar o objeto no bucket também —
  senão fica órfão, público e para sempre. Best-effort: se falhar, regista e segue
  (nunca quebra o fluxo do utilizador que só quer apagar o post).
- (linha ~9, `function caminhoDeUrl(url, bucket) {`) Extrai o caminho dentro do bucket a partir de uma URL de mídia — a URL
  CRUA do Storage (.../object/public/<bucket>/<path>) OU a do PROXY que o
  Tijolo 2 emite (/api/media/<token>). Uma URL que veio do CLIENTE (salva em
  feed_post_media.url, comentario_anexos.url — o que o utilizador reenviou
  depois de um upload) é SEMPRE a forma do proxy desde o Tijolo 2: sem este
  segundo caminho, removerFicheirosPorUrl nunca achava o ficheiro e ele
  ficava órfão no Storage para sempre (achado real, Rodada 15). Usa
  decodificarToken (não verificarToken): apagar tem de continuar a
  funcionar mesmo com o token há muito expirado — expiração é sobre PODER
  SERVIR agora, não sobre saber a que ficheiro a URL se refere.
- (linha ~54, `const BUCKETS_PRIVADOS = ['avatars', 'resenha'];`) ─────────────────────────────────────────────────────────────────────────────
  Tijolo 1C — buckets PRIVADOS + URLs ASSINADOS.
  Os URLs guardados na BD são públicos (formato .../object/public/<bucket>/...).
  Com os buckets privados, esses links morrem; assinamos na fronteira da API.
  ─────────────────────────────────────────────────────────────────────────────
- (linha ~61, `function parseUrlPublico(url) {`) Deteta um URL público de um bucket nosso privado → { bucket, path, v } | null.

  VELOCIDADE 6A (15-set): o `?v=<timestamp>` que os uploads gravam (routes/auth.js
  :304 e :885, routes/teams.js :428) era simplesmente deitado fora aqui. É ele que
  diz "este ficheiro MUDOU" — o caminho no bucket é fixo (upsert), só o v muda.
  Agora é capturado e entra no token: conteúdo novo = v novo = URL novo (o cache
  do celular renova-se sozinho); conteúdo igual = URL igual (o cache acerta).
- (linha ~150, `function urlDoProxy(base, p) {`) O URL do proxy de um arquivo ({ bucket, path, v }, de parseUrlPublico). Rodada 29B (bloco 3, E):
  se a pessoa escolheu um recorte para a miniatura deste arquivo (utils/recortesAvatar.js), ele
  vai junto na query (`?rc=x,y,escala`); o proxy só o aplica nos pedidos quadrados (`sq=1`) e o
  resto (card, cromo, fotos grandes) o ignora. Fica na URL — e não no token — para o app, que
  acrescenta `&w=…`, nunca ter de decodificar nada, e porque o URL novo é o que quebra o cache.
- (linha ~162, `function proxificarPayload(payload, base) {`) Reescreve, IN-PLACE, os URLs de buckets privados para URLs ESTÁVEIS do proxy
  (`${base}/api/media/<token>`). Tijolo 2: o DOM deixa de segurar URLs assinados
  de vida curta → sem expiração à vista; o bucket continua privado. `base` é a
  origem do backend (ex. http://localhost:3001).

## utils/tarefasPintura.js

- (linha ~1, `const crypto = require('node:crypto');`) ═══════════════════════════════════════════════════════════════════════════════
  A PINTURA POR PEDIDO, NÃO POR CPU OCIOSA (Rodada 29B, bloco 2-A2 — 1-out).

  No Cloud Run a CPU só existe enquanto um pedido está aberto. A pintura em segundo plano da
  parte A roda DEPOIS de responder, então sem "CPU sempre alocada" (~R$250/mês, recusada em
  25-set) ela só andava enquanto o app consultava. O padrão certo do Cloud Run: o trabalho roda
  DENTRO de um pedido, e quem faz esse pedido é o Cloud Tasks. Custo ≈ zero (1 milhão de
  operações grátis por mês) e, se o processo reiniciar no meio, a tarefa é repetida sozinha.

  Este módulo só cuida de DUAS coisas: (1) enfileirar a tarefa de uma pintura; (2) conferir que
  o pedido que chega em POST /api/interno/pintar/:jobId veio mesmo do Cloud Tasks. Quem pinta
  continua sendo routes/auth.js (pintarFigurinha); quem sabe de estado é utils/geracaoJobs.js.

  LIGADO só com as TRÊS variáveis (senão a fila em memória de sempre, como no dev/local):
    CLOUD_TASKS_QUEUE  projects/<projeto>/locations/<região>/queues/futty-pintura
    URL_DO_SERVICO     https://<serviço>.run.app — para onde a tarefa bate e a audiência do token
    INTERNO_SEGREDO    o segredo que a tarefa leva no cabeçalho x-futty-interno
  A URL vem SEMPRE da variável, nunca do Host do pedido: um Host forjado mandaria o segredo e o
  token para fora.

  SEGURANÇA: nenhum log daqui imprime o segredo nem o token.
  ═══════════════════════════════════════════════════════════════════════════════

## utils/telemetria.js

- (linha ~1, `const PLATAFORMAS = new Set(['ios', 'android', 'web']);`) Futty v2.0 — Telemetria ANÔNIMA de velocidade (Rodada 28, bloco E).

  Substitui o botão de Diagnóstico para todo mundo: o app manda, no máximo uma vez por tela por
  sessão, quanto a tela levou para ficar útil e quanto cada chamada ao motor custou. É o número do
  aparelho de quem usa, sem ninguém precisar tocar em nada.

  ANÔNIMA DE VERDADE, por construção — não por promessa:
    · a linha gravada é montada só com os campos da LISTA abaixo; qualquer outro campo que chegue
      (user id, e-mail, token, id de aparelho) é ignorado, nunca copiado;
    · rotas e telas passam por `normalizarRota`: slug de time, id, token, número, e-mail — tudo o que
      não for palavra fixa de rota vira `:slug`/`:id`/`:x`;
    · a rota não lê o Authorization nem o IP. O IP só existe na memória do limiter (por 15 min) e
      nos logs de acesso da infraestrutura; nunca numa tabela nossa.
  Retenção: 30 dias (`limparAntigas`, abaixo).
- (linha ~26, `const ANTES_DO_SLUG = new Set(['teams', 'equipas', 'equipa', 'time', 'admin']);`) 'equipa' = o endereço antigo (29I: /equipa → /time), que ainda chega por link já enviado

## utils/triagem.js

- (linha ~1, `const LIMIAR_REMOVER = 0.90;`) Triagem de denúncias (Tijolo 3, Fase B) — o cérebro da SPEC-DENUNCIAS §3.
  Motor: Fable (claude-fable-5) quando ANTHROPIC_API_KEY existe; senão fallback
  conservador por regras (o fluxo funciona e é provável sem chave). Camada
  substituível: quem chama nunca sabe qual motor decidiu.

  LEIS DURAS aplicadas SEMPRE no servidor (nunca se confia só no modelo):
   - categoria "menor" → decisao "escalar" (nunca outra);
   - "remover" só vale com confianca ≥ 0.90; abaixo disso degrada para "fila_humana"
     (dúvida = humano, nunca auto-remoção por engano).

## utils/uniformeDoPacote.js

- (linha ~1, `const { supabase: supabaseReal } = require('./db');`) Futty v2.0 — O dono escolhe o uniforme do pacote do time (Pagamentos P2, 26-set).

  Achado do P1: o pacote comprado na LOJA liga o time sem uniforme quando o time ainda não tinha
  `brilhante_kit` (nenhum pedido guarda uniforme) — e sem uniforme ninguém gera (direitoBrilhante
  salta pacote sem kit). Até aqui só o Gabinete fixava o uniforme. Agora o próprio dono escolhe:
    · só o admin do time;
    · só com o pacote ativo;
    · a 1ª escolha sempre vale; trocar, só enquanto ninguém gerou (depois disso o time já tem
      figurinhas num uniforme, e trocar deixaria o álbum com dois — fala com o suporte).
  Na 1ª escolha os membros recebem o push "Sua figurinha foi liberada" (é agora que dá para gerar).

  Fábrica com o Supabase e o push injetáveis: tests/uniforme-do-pacote.test.js corre sem banco.

## scripts/_bench/aplicar-icone.js

- (linha ~1, `const fs = require('fs');`) ═══════════════════════════════════════════════════════════════════════════════
  APLICA O ÍCONE DO iPHONE — variante 2 "ouro vivo + aro" da bancada
  (scripts/_bench/testar-icone.js, commit e2914ab). Reusa as MESMAS funções da
  bancada (require, não cópia).

  RODADA 29X (5-out): este script grava SÓ o ícone do iPhone, e só com --so-ios.
  Até a 29W ele também gravava o Android e o site — e a variante 2 tem o ANEL
  dourado, que o dono mandou tirar de todo lugar menos da moldura fina do iPhone
  ("um ícone só, o ouro vivo, sem anel": 5-out). Rodá-lo sem opção devolvia o
  anel ao Android e ao site. Agora, de onde sai cada ícone:

    iPhone    ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
              — ESTE script, com --so-ios: 1024, sem alpha, ouro vivo + a moldura
              fina nos cantos (o iOS aplica a máscara de cantos sozinho). Contents.json
              já é "universal" 1024×1024 — não muda.
    Android   mipmap-*/ic_launcher(_background|_foreground|_monochrome|_round).png
    site      public/icons/icon-192.png e icon-512.png
              — frontend/scripts/gerar-icones.mjs: a vinheta SEM aro + o F, composição.
    splash    Splash.imageset, drawable*/splash_logo.png e frontend/assets/
              — frontend/scripts/gerar-splash.mjs: o F ouro vivo sobre #080808 sólido.

  Sem IA, sem imagem baixada — tudo SVG via sharp/librsvg, como a bancada.

    node scripts/_bench/aplicar-icone.js --so-ios
  ═══════════════════════════════════════════════════════════════════════════════

## scripts/_bench/auditor-bench.js

- (linha ~1, `const fs = require('fs');`) BANCADA DO AUDITOR — ronda 3: COMPETIÇÃO DE MODELOS DE VISÃO.

  Histórico:
    r1: moondream2 reprovou TODAS (pergunta errada: exigia mão visível com
        braços cruzados).
    r2: pergunta certa, e o moondream2 APROVOU todas — inclusive as sem braço.
        Pequeno demais: responde de memória ("pessoas têm braços"), não olha.
    r3 (esta): mesmos 6 casos-gabarito do dono, modelos maiores em competição.
        O any-llm/vision está marcado "deprecated" no fal mas pode ainda servir
        — a sonda custa centavos e responde a dúvida de uma vez.

  Gabarito (30-jul, apontado pelo dono):
    Denis--L2PB, Renato, Kim2  → defeito de braço  (REPROVAR)
    Gui--L2P, foto-normal--L2P, prova-ruidosa--L2P → boas (PASSAR)

  Uso:  node scripts/_bench/auditor-bench.js

## scripts/_bench/comum.js

- (linha ~1, `const fs = require('fs');`) ═══════════════════════════════════════════════════════════════════════════════
  O QUE TODA BANCADA DE FIGURINHA USA (17-set).

  Saiu de dentro do testar-prompt.js quando a bancada de MODELOS precisou das
  mesmas peças: medir a coroa, recortar o fundo, vestir a moldura e montar a
  folha de contacto. Duas bancadas a medir a mesma coisa com código diferente
  mediriam coisas diferentes — daí o módulo.

  O que NÃO está aqui de propósito: o prompt (prompts/figurinha.js), a entrada
  (utils/entradaFigurinha.js) e a chamada à fal (utils/falFila.js). Esses são
  módulos de PRODUÇÃO, e as bancadas importam-nos de lá — é isso que garante
  que o que se mede é o que está no ar.
  ═══════════════════════════════════════════════════════════════════════════════

## scripts/_bench/conferencia-final.js

- (linha ~1, `require('dotenv').config();`) Futty v2.0 — LIMPEZA TOTAL (23-set): contagens finais pós-reconstrução da demo
  + confirmação do estado das duas contas que ficam.

## scripts/_bench/conferir-kit.js

- (linha ~1, `const fs = require('fs');`) CONFERIR O KIT (bancada do prompt, 17-set) — não gasta nada, não chama a fal.

  A tabela do relatório pede "kits errados por variante". Julgar isso na folha
  de contacto é impossível: o emblema do peito tem 20 px lá. Este script corta
  a FAIXA DO PEITO de cada figurinha (onde vivem os cinco itens do checklist:
  base, painel diagonal, gola em V, punhos e emblema) e monta uma tira por foto,
  já com o número da variante — a chave cega é para o dono, a conferência
  técnica do kit é minha.

    node scripts/_bench/conferir-kit.js            todas as fotos
    node scripts/_bench/conferir-kit.js Renato     só uma

## scripts/_bench/conta-de-prova.js

- (linha ~1, `require('dotenv').config();`) ═══════════════════════════════════════════════════════════════════════════════
  CONTA DESCARTÁVEL PARA AS PROVAS DE TELA (22-set, Figurinha 3).

  A conta demo-loja tem a Brilhante das lojas e NÃO pode ser desfeita para
  provar a figurinha comum. Este script cria (ou refaz) uma conta @futtymock
  limpa — sem foto, sem figurinha, onboarding por fazer — e escreve a sessão
  num JSON que o scripts/ver-iphone.mjs do frontend lê com --sessao.

    node scripts/_bench/conta-de-prova.js                      cria/refaz e grava a sessão
    node scripts/_bench/conta-de-prova.js --apagar             apaga a conta
    node scripts/_bench/conta-de-prova.js --credito 1          cria com N créditos (pede a 054)

  A sessão sai em ../frontend/scripts/capturas/sessao-prova.json (fora do git).
  ═══════════════════════════════════════════════════════════════════════════════

## scripts/_bench/conta-hotfix26.js

- (linha ~1, `require('dotenv').config({ quiet: true });`) ═══════════════════════════════════════════════════════════════════════════════
  CONTA DESCARTÁVEL NO ESTADO DO BUG DO "TROCAR FOTO" (Hotfix 26, 25-set).

  Para a cena 'hotfix26' do scripts/ver-iphone.mjs (frontend), que prova pela tela
  que trocar a foto de uma conta SEM figurinha muda o card. O estado é o que o
  trigger handle_new_user (001) deixava em quem entrava com o Google: uma foto
  (foto_url) e um avatar_url DIFERENTE dela que não é figurinha nossa. Sem
  figurinha de verdade: nada em brilhantes_time, nada em user_avatar_historico,
  nenhum arquivo -ai- no bucket avatars.

  A "foto do Google" aqui é uma silhueta do bucket `kits`: uma imagem qualquer que
  abre numa bancada sem internet liberada e que também não é figurinha nossa (a
  regra olha o NOME do arquivo, utils/figurinhaRegra.js). O upsert grava o estado
  direto, então vale igual antes e depois da migração 060.

    node scripts/_bench/conta-hotfix26.js            cria/refaz a conta e grava a sessão
    node scripts/_bench/conta-hotfix26.js --apagar   apaga a conta (e os arquivos dela)

  A sessão sai em ../frontend/scripts/capturas/sessao-hotfix26.json (fora do git).
  ═══════════════════════════════════════════════════════════════════════════════

## scripts/_bench/contas-varredura.js

- (linha ~1, `require('dotenv').config();`) ═══════════════════════════════════════════════════════════════════════════════
  CONTAS DESCARTÁVEIS PARA A VARREDURA GERAL PÓS-FIGURINHA 3 (22-set).

  Os 4 papéis do roteiro (App.jsx logado como cada um):
    novo     conta nova sem time (onboarding feito, figurinha comum, zero times)
    membro   membro de um time sem Brilhante (comum, sem crédito, time sem pacote)
    dono     dono de time — SEM time ainda: a cena de varredura cria o time pela
             UI de propósito (é a própria prova de "criar time → presente →
             Brilhante"), depois vira "dono de time com Brilhante"
    super    super-admin (comum, is_super_admin)
    convidado uma 5ª conta, à parte dos 4 papéis — só para a prova do convite
             (entra pelo link, pede, leva recusa, vê o recado)

  novo/membro/super nascem já com a figurinha COMUM pronta (copiada do mesmo
  objeto de Storage da conta demo-loja — o modelo fictício de sempre, nunca
  uma pessoa real) para a varredura focar nas ROTAS, não em repetir o
  onboarding 4 vezes. `dono` nasce SEM foto — é a UI de criar time que a leva
  para lá pela primeira vez.

    node scripts/_bench/contas-varredura.js                cria as 5 e grava as sessões
    node scripts/_bench/contas-varredura.js --apagar        apaga tudo (contas + o time, se existir)
    node scripts/_bench/contas-varredura.js --entrar-membro
        depois da cena "criar time" ter corrido (acha o time pelo criado_por
        = dono, não precisa saber o slug), põe `membro` lá — sem Brilhante
  ═════════════════════════════════════════════════════════════════════════════

## scripts/_bench/exportar-bustos-onboarding.js

- (linha ~1, `const fs = require('fs');`) BANCADA — Rodada 29E (1-out): os 6 BUSTOS do mini sorteio do onboarding, a partir dos recortes dos modelos fictícios
  (saida-modelos-jovens/*-recorte.png, 30-set e 1-out). Cada busto = o recorte sobre o fundo da casa (comum.js fundoSVG,
  SEM a moldura dourada — a moldura é a .fr do CSS, como no sorteio real), janela 3:4 pelo topo (cabeça + ombros + peito),
  exportado em WebP 112×150 (2× os 56×75 de exibição) com ≤ 6 KB cada (lei do app leve, 14-set): a qualidade desce de 5 em 5
  até caber. Saída: FUTTY-V2/frontend/public/onboarding/<nome>.webp (servida do site, fora do pacote nativo).

  Uso: node scripts/_bench/exportar-bustos-onboarding.js
- (linha ~22, `const BUSTOS = [`) nome do arquivo (sem acento, é URL) ← recorte do modelo. Rodada 29E2 (2-out): ficam TIAGÃO (j8), PEDRÃO (j4), RAFA (j10), BRUNINHO (j11) e LÉO (j12),
  aprovados pelo dono; BRUNINHO e LÉO são a 2ª leva (--jovens4); DUDU é a 4ª (--jovens6: gordinho nerd de óculos, cabeça reta e de frente). 3 Brasil, 3 Portugal.
  Com --so a,b exporta só esses nomes (os aprovados não são tocados).
  Rodada 29E3 (2-out): 4 por time (8 rolos) — entram NANDO (j16, Brasil, ~39, grisalho) e CAIO (j17, Portugal, ~24, negro, sério), leva --jovens7.
  Os 8 são FINAIS (dono, 2-out): não re-exportar. Só o NOME do j12 mudou: LÉO virou GONÇALO (arquivo goncalo.webp, mesmos bytes do leo.webp).

## scripts/_bench/gerar-avatar-generico.js

- (linha ~1, `const fs = require('fs');`) BANCADA — AVATAR GENÉRICO DA CASA (31-jul, ideia do dono).
  O jogador SEM ROSTO que veste o card de quem ainda não gerou avatar próprio:
  substitui as iniciais ("CH") e o texto "seu card espera por você" por um
  jogador de verdade, em grafite neutro (sem tom de pele), vestindo o manto
  Dark Gold com luz dourada de contorno. Um asset, gerado uma vez.

  Uso:   node scripts/_bench/gerar-avatar-generico.js          (3 candidatos)
         node scripts/_bench/gerar-avatar-generico.js --publicar saida-generico/generico-c2.png

  Custo: 3 × ~$0,055 ≈ $0,17. Passa pela MESMA esteira da produção
  (birefnet → trim → extend → resize) para cair no card como um avatar normal.
- (linha ~22, `const FEM = process.argv.includes('--feminino');`) --feminino (31-jul, dono): gera/publica a versão feminina — 3 masc + 3 fem no total.
- (linha ~47, `if (process.argv.includes('--publicar-todos')) {`) ---- publicar TODOS (decisão do dono, 31-jul: os 3 em rodízio para que
       vários jogadores sem foto no mesmo time não fiquem idênticos) ----

## scripts/_bench/gerar-campo.js

- (linha ~1, `const fs = require('fs');`) BANCADA — FUNDO DE CAMPO da ESCALAÇÃO (31-jul, dono).
  A tentativa antiga desenhava o campo por código e "ficou horroroso" — a regra
  da casa agora: CAMPO É ASSET (gerado 1x por IA), a composição só põe coisas
  por cima (avatares, chapas, aura pixelada, escudo, título).

  Gera 2 candidatos de cada estilo:
    verde — gramado clássico premium (nostálgico, vibe álbum de figurinha)
    dark  — o campo noturno da casa (piano-black, linhas douradas)
  Formato: 1024×1536 (2:3). Na composição final vira 9:16: escala p/ 1080×1620
  e estende o topo com a continuação escura (a faixa do cabeçalho).

  Uso:  node scripts/_bench/gerar-campo.js
        node scripts/_bench/gerar-campo.js --publicar verde saida-campo/campo-verde-c1.png
        node scripts/_bench/gerar-campo.js --publicar dark  saida-campo/campo-dark-c2.png
  Custo: 4 × ~$0,053 ≈ $0,21.

## scripts/_bench/gerar-icone-splash.js

- (linha ~1, `const fs = require('fs');`) Futty v2.0 — gera resources/icon.png e resources/splash.png do frontend a
  partir do F real (frontend/src/utils/futtyMonograma.js), via sharp. Corre
  UMA VEZ (não é bancada de comparação); fica em _bench por convenção do
  house style (scripts avulsos de geração de asset vivem aqui).

  23-set — "ouro vivo": reusa a MESMA peça de F e o MESMO fundo de
  scripts/_bench/testar-icone.js (gradiente vertical + reflexo diagonal +
  brilho atrás, sobre a vinheta #0b0a12→#1a1826) em vez de redesenhar aqui —
  é a linguagem escolhida pelo dono na bancada (variante 2, "ouro vivo + aro";
  o aro fica só no ÍCONE — ver aplicar-icone.js — o splash não tem cantos de
  app para emoldurar). Antes: F a 62%/40%, fundo chapado #0d0d12, ouro sólido
  #d4a017 sem gradiente nem brilho.

  5-out, Rodada 29X — O resources/splash.png DESTE script NÃO é o splash que vai ao aparelho:
    · tem vinheta (#0b0a12→#1a1826) e o splash do app é o #080808 SÓLIDO (a cor de colors.xml, do capacitor.config.json
      e do --bg: com vinheta haveria degrau na troca da abertura para o app);
    · o ouro sai CHAPADO (#f5e070, sem degradê): o degradê do pecaF (defsOuro) é userSpaceOnUse e vive dentro do grupo
      transformado do F, ou seja, em coordenadas do próprio F — só cobre o F inteiro no quadrado de 1024 da bancada; a
      2732 px ele cai fora do F. (O icon.png, a 1024, está certo.)
  O splash do app (iPhone, Android abaixo do 12 e frontend/assets/) sai de frontend/scripts/gerar-splash.mjs, que renderiza
  a MESMA peça do ícone do iPhone em escala maior (scripts/_bench/renderizar-camadas.js). Este script só vale para o icon.png.

## scripts/_bench/gerar-kits.js

- (linha ~1, `const fs = require('fs');`) BANCADA — ASSETS DOS KITS 3 e 4 (White Gold · Elite Gold), 31-jul.
  O dono decidiu: 4 uniformes no lançamento, mesmo design, só a cor muda.
  Este script RECOLORE o asset oficial kit1-dark-gold.png (Image 1 = verdade)
  e gera N candidatos por cor para o olho do dono escolher.

  Uso:
    node scripts/_bench/gerar-kits.js                     (3 candidatos × 2 kits)
    node scripts/_bench/gerar-kits.js --n 2               (2 por kit)
    node scripts/_bench/gerar-kits.js --publicar white-gold saida-kits/white-gold-c2.png
      → sobe o escolhido ao bucket 'kits' com o nome DEFINITIVO (kit3/kit4) e
        imprime a URL pública. (Ligar ativo:true no auth.js é passo meu, a seguir.)

  Custo: ~$0,05/candidato (medium) → 6 candidatos ≈ $0,32. Tecto $0,60.
- (linha ~28, `'royal-purple': {`) Royal Purple (pedido do dono, 31-jul): o INVERTIDO do roxo — par do Elite Gold.
  Candidato a 5º kit pago; decisão de entrar no lançamento só depois do olho.

## scripts/_bench/gerar-modelos-ficticios.js

- (linha ~1, `const fs = require('fs');`) BANCADA — 5 MODELOS FICTÍCIOS para a publicidade "low vs medium"
  (decisão do dono, 31-jul: exemplos diversos em rodízio, nunca classificar o
   usuário; pessoas que NÃO existem, geradas por IA, sem direito de imagem)

  O que faz, por modelo:
    1. gera uma "foto" de uma pessoa fictícia brasileira (texto → imagem)
    2. passa essa foto pela ESTEIRA REAL de produção (prompt lido de auth.js)
       duas vezes: quality LOW e quality MEDIUM — o par que a publicidade mostra
    3. mede achatamento e guarda tudo em saida-modelos/ + galeria HTML

  Custo: 5 fotos t2i (~$0,013) + 5 low ($0,015) + 5 medium ($0,053) ≈ $0,41.
  Tecto: $0,60. É custo ÚNICO — os pares rodam na publicidade para sempre.

  Uso:  node scripts/_bench/gerar-modelos-ficticios.js

  RONDA 2 — refazer só o medium de modelos escolhidos, com estilo "rico":
    node scripts/_bench/gerar-modelos-ficticios.js --refazer m3-homem-negro,m5-homem-grisalho --estilo rico
  Motivo (31-jul, dono): em m3/m5 o low saiu MELHOR que o medium. O prompt é
  afinado para o low (proíbe textura fina) e amarra o medium — o pago tem de
  SUBIR de estilo junto com a qualidade. O --estilo rico liberta o detalhe
  fino SÓ no medium; reusa as fotos fictícias do disco (sem custo t2i) e grava
  {id}-medium-rico.png ao lado do par original para comparação.
- (linha ~74, `const MODELOS_JOVENS = [`) ─── RODADA 29B (30-set): --jovens — 3 modelos novos para as REDES (onboarding/anúncios) ────────────────
  Dono pediu 15–25 anos; a Freaky recomendou 18+ (modelo com cara de menor num app com compra e cadastro 13+ é
  bandeira vermelha na revisão da Apple e do Google) — o prompt diz "clearly an adult in their early twenties".
  Dois homens e uma mulher, traços brasileiros/europeus, kit Dark Gold. Usa a RECEITA REAL da produção
  (utils/geracaoFigurinha.js, V6) e não a esteira antiga deste arquivo (que lia o prompt de routes/auth.js e já
  não existe lá). Teto US$1 (estimativa ~US$0,40: 3 fotos + 3 V6). Só o cartão final importa: um por modelo.
    node scripts/_bench/gerar-modelos-ficticios.js --jovens
  Saída: scripts/_bench/saida-modelos-jovens/ e cópia dos 3 cartões em FUT/REDES/modelos/ (fora do bundle do app).
- (linha ~88, `const MODELOS_JOVENS_2 = [`) ─── RODADA 29E (1-out): --jovens2 — mais 3 na MESMA receita, para o mini sorteio do onboarding fechar 3 com cara de Brasil
  (j1, j2, j4) e 3 de Portugal (j3, j5, j6). Mesma regra de idade (18–25, nunca menor, nunca pessoa real), mesmo kit.
    node scripts/_bench/gerar-modelos-ficticios.js --jovens2
- (linha ~96, `const MODELOS_JOVENS_3 = [`) ─── RODADA 29E2 (2-out): --jovens3 — os 4 HOMENS novos do mini sorteio (ficam DUDU = j6 e PEDRÃO = j4, aprovados pelo dono).
- (linha ~107, `` const fotoLivre = (desc, expressao, pose, idade) => `Casual amateur smartphone… ``) ─── RODADA 29E2, 2ª leva (2-out): --jovens4 — o dono reprovou DUDU/LÉO/BRUNINHO da 1ª leva ("cara de revista demais, todos na
  mesma pose e no mesmo sorriso"). Ficam TIAGÃO (j8), PEDRÃO (j4) e RAFA (j10). Três homens novos com variedade DE VERDADE: idade
  25–35, nenhum sorriso aberto, cabeça e ombros fora do frontal. A foto fictícia ganha prompt PRÓPRIO (campo `foto`): o fotoPrompt()
  padrão força "friendly smile" e "frontal", que é o que o dono não quer. A receita da figurinha (V6) mantém o ângulo da cabeça e a
  expressão da foto, mas quadra os ombros (POSE em prompts/figurinha.js) — isso é produção, fica. 1 Brasil (j11) + 2 Portugal (j12, j13).
    node scripts/_bench/gerar-modelos-ficticios.js --jovens4
- (linha ~137, `const MODELOS_JOVENS_5 = [`) ─── RODADA 29E2, 3ª leva (2-out): --jovens5 — só o DUDU (o j13 também saiu por "cara de revista"). Perfil bem diferente dos outros
  cinco: ~28, gordinho (rosto cheio, bochechas, pescoço largo, ombros redondos), nerd simpático de óculos grossos, cabelo curto bagunçado,
  sorriso tímido de boca fechada, cabeça inclinada. Pele bem clara e cabelo louro-acinzentado (nenhum dos cinco é claro nem louro). Portugal.
  Óculos de grau ficam na V6 (REGRA_OCULOS); o corpo "athletic" da POSE pode afinar a barriga, mas o busto (62 % pelo topo) corta antes dela.
    node scripts/_bench/gerar-modelos-ficticios.js --jovens5
- (linha ~149, `const MODELOS_JOVENS_6 = [`) ─── RODADA 29E2, 4ª leva (2-out): --jovens6 — o DUDU de novo, MESMO perfil do j14, só a POSE muda (dono): cabeça reta e de frente,
  nada de inclinar nem virar, queixo levemente baixo, ombros quadrados e relaxados, olhar direto. A receita de produção já pede
  "frontal bust, shoulders square" e mantém a cabeça da foto — basta a foto fictícia nascer reta. prompts/figurinha.js intocado.
    node scripts/_bench/gerar-modelos-ficticios.js --jovens6
- (linha ~161, `const MODELOS_JOVENS_7 = [`) ─── RODADA 29E3 (2-out): --jovens7 — o dono aprovou os 6 e quer 4 jogadores por time (8 rolos). Dois homens novos, perfis que o elenco
  ainda não tem (nenhum dos 6 é grisalho nem passa dos 33; e o único negro, PEDRÃO, sorri). "jovens" no nome da leva é só a sequência da
  bancada — o NANDO tem 38–40. Fictícios, nunca pessoa real, nunca menor, mesma receita V6 e mesmo kit. Os 6 aprovados não são tocados.
    node scripts/_bench/gerar-modelos-ficticios.js --jovens7
- (linha ~199, `const SO_IDS = (() => { const i = process.argv.indexOf('--so'); return i > 0 &&…`) --so id1,id2 corre só esses modelos da leva; --foto-do-disco reaproveita <id>-foto.png se já existir (sem pagar o t2i de novo).
  Rodada 29E3 (2-out): o j17 morreu em silêncio depois da foto (sem FALHOU nem resumo — morte nativa/processo, não erro de JS);
  o log por passo abaixo existe para a próxima vez dizer ONDE.
- (linha ~251, `const MODELOS_LOJA = [`) ─── PRINTS DAS LOJAS, AJUSTE 2 DO DONO (5-out): --loja — os 4 lugares que ainda eram silhueta no Sorteio da peça 01 ──────────────
  (LOJA-PRINTS-OUT.md, "Ajuste 2"). Receita de produção (V6, kit Dark Gold) e o enquadramento do avatar do Bruninho: o recorte INTEIRO,
  com peito e uniforme, tratado como routes/auth.js trata (trim + 40 px de folga no topo + 512×640) — não o close do rosto de
  public/onboarding/. Três fictícios novos (adultos, nunca pessoa real, sem parecença com famosos, diferentes entre si e dos 8 rostos que
  já estão na peça) e o PRÓPRIO DONO, a partir da foto original que ele subiu (lida do Storage só para leitura, guardada em
  LOJA/demo-avatares/foto-dono.jpg). "Índio" e "Nego Di" (apelidos de cor/etnia) saem da peça: no lugar do Índio entra o PAREDÃO; no do
  Nego Di, o dono. Careca e Zé Gordo ficam e ganham rosto que combina.

  Nada vai para o banco nem para o Storage: a entrada vai à fal como data URI (as levas acima subiam-na no bucket `kits`; aqui nem isso).
  Saída fora do repositório, em LOJA/demo-avatares/. Teto de US$1,50 para o ajuste INTEIRO: o custo de cada chamada é o lido da fal e fica
  anotado em custos.json, que soma entre corridas — a corrida para ANTES de gastar se a próxima chamada passaria do teto.
    node scripts/_bench/gerar-modelos-ficticios.js --loja                  os 3 fictícios
    node scripts/_bench/gerar-modelos-ficticios.js --loja --dono 1         uma tentativa do dono (até 3: ele quer ver o uniforme perfeito)
    node scripts/_bench/gerar-modelos-ficticios.js --loja --dono-final 2   a tentativa escolhida vira dono-avatar.png / dono-card.png (grátis)
    opções: --so l1-careca,l3-paredao   --foto-do-disco (reusa <id>-foto.png sem pagar o t2i de novo)
  Por modelo: <id>-foto.png (o t2i), <id>-entrada.jpg (o quadrado da produção), <id>-v6.png (a V6 crua, no cinza), <id>-recorte.png,
  <id>-avatar.png (o que a captura serve no Sorteio) e <id>-card.png (a figurinha na moldura, para a folha).
- (linha ~279, `{ id: 'l3-paredao', foto: fotoLivre(`) 1ª foto (5-out) saiu com "cara de revista" — o que o dono reprovou nos modelos do onboarding em 2-out. Esta é a de rosto comum.

## scripts/_bench/inventario-storage.js

- (linha ~1, `require('dotenv').config();`) Futty v2.0 — LIMPEZA TOTAL (23-set): inventário dos 3 buckets ANTES da
  limpeza — nome e tamanho de cada objeto, recursivo (list() do Supabase
  Storage não é recursivo por si só, e cada bucket tem uma estrutura de
  pastas diferente: avatars = Kits/public/tmp, resenha = plano, denuncias =
  _diagnostico/_gabinete/_plataforma/casos/reporters).

  Uso único, não é ferramenta permanente — roda a partir de backend/:
    node scripts/_bench/inventario-storage.js > caminho/inventario-storage.json

## scripts/_bench/medidor-uniforme.js

- (linha ~1, `const fs = require('fs');`) ═══════════════════════════════════════════════════════════════════════════════
  MEDIDOR DE FIDELIDADE DO UNIFORME (6-out, achado 3g da LISTA-CURTA).

  Não chama a fal, não gasta nada. Compara o TRONCO da figurinha com a imagem do
  kit que entrou na geração e diz se o uniforme saiu fiel.

  O molde dos 5 kits é o mesmo (kit2..5 nasceram do dark-gold): camisa da cor
  BASE, e o ACENTO é uma CUNHA — a borda esquerda (de quem olha) desce na
  diagonal do lado do colarinho até o meio da barra, a borda direita desce
  QUASE A PRUMO junto à costura lateral (com um vivo da cor base), e a manga
  esquerda de quem veste (a da direita de quem olha) é toda do acento, com o
  punho da cor base.

  Os defeitos de 5-out (LOJA/demo-avatares, 9 gerações, 4 certas):
    • FAIXA — o acento vira uma faixa de bordas PARALELAS: a borda direita
      desce na diagonal junto com a esquerda (dono t1 e t2, Careca).
      Ter preto à direita do ouro NÃO é o defeito — as 4 certas também têm
      (19–27% da largura); o defeito é esse preto crescer para baixo.
    • MANGA — a manga esquerda de quem veste sai da cor base (Zé Gordo 1 e 2).
  E dois que o medidor confere porque custam nada: cor base trocada (os kits
  invertidos tendem a voltar ao preto) e acento a mais ou a menos no tronco.

  Como mede:
    1. a paleta sai da IMAGEM DO KIT (k-médias com 2 grupos nos pixels da
       camisa) — nenhuma cor escrita à mão, vale para os 5 kits;
    2. cada pixel opaco do recorte (birefnet, com alfa — a produção já tem esse
       recorte em mãos) vira BASE, ACENTO ou OUTRO (pele, cabelo) — ver testeDeCor;
    3. acha a linha dos ombros e a largura dos ombros; o tronco analisado vai
       dos ombros até 0,8 largura de ombro abaixo (antes da barra da camisa);
    4. mede a manga, as duas bordas do acento e as proporções, e compara com o
       mesmo cálculo feito na imagem do kit.

  Uso (bancada):
    node scripts/_bench/medidor-uniforme.js --gabarito [--debug pasta]
         as 9 de 5-out × o veredito do dono; sai com erro se errar alguma
    node scripts/_bench/medidor-uniforme.js <recorte.png> --kit <kit.png> [--debug saida.png]
  Módulo: const { medirUniforme, lerReferenciaKit } = require('./medidor-uniforme');
  ═══════════════════════════════════════════════════════════════════════════════
- (linha ~62, `function testeDeCor(p) {`) Uma cor do kit vira um TESTE de pertença, conforme o tipo:
    cromática (ouro, roxo)     → matiz a ±17° e croma >= 60% da do kit; luz livre.
      Medido nas 9 de 5-out: o ouro gerado sai com matiz 61–85° e croma 40–67;
      a pele fica em 30–60° com croma 20–49. É o MATIZ que separa — numa
      distância Lab comum a pele cai mais perto do ouro do que do preto, e a
      primeira versão deste medidor pintava os rostos de "acento".
    acromática (preto, branco) → croma baixa e luz do mesmo lado: o preto
      pintado tem brilho de cetim (L até ~40), o branco tem sombra (L de 60).
- (linha ~163, `function geometria(cls, w, h) {`) Por linha, a maior corrida de camisa (base+acento; buracos até 3% da largura
  tolerados — emblema, dobra, reflexo). A linha dos OMBROS é a primeira (de
  cima) onde a camisa ocupa >= 60% da maior largura por 3% da altura seguidos:
  cabelo e barba pretos passam no teste do preto, mas a cabeça nunca chega a
  60% da largura dos ombros. O tronco analisado vai até 0,8 ombro abaixo —
  nas 9 de 5-out isso fica sempre acima da barra da camisa.
- (linha ~309, `const REGRAS = {`) O veredito. Cada regra é uma frase sobre o kit; o número é o meio da folga
  entre as certas e as erradas do gabarito de 5-out (rodar --gabarito):
- (linha ~380, `const GABARITO = [`) O gabarito: as 9 V6 de 5-out, pela ordem em que foram geradas. A LISTA-CURTA
  (3g) diz "fiel em 4 de 9": dono t1/t2 errados (faixa), t3 certo; Zé Gordo
  2 de 3 com a manga preta (as duas primeiras). Faltam 2 certas e 1 errada
  entre Careca e os dois Paredões: de perto (6-out), o Careca é faixa de bordas
  paralelas e os dois Paredões são cunha — o "reprovado" do Paredão foi pela
  cara de revista, não pelo uniforme.

## scripts/_bench/medir-conta-pesada.js

- (linha ~1, `require('dotenv').config({ quiet: true });`) ═══════════════════════════════════════════════════════════════════════════════
  MEDIR A CONTA PESADA (1-out, Rodada 29B, bloco 2, parte B) — tempo, tamanho e idas ao banco por rota.

  Sobe o motor (server.js) DENTRO deste processo, numa porta livre, e conta tudo o que ele pede ao Supabase: cada
  `supabase.from()` (uma consulta), cada `supabase.rpc()` e cada chamada ao Storage. Em cada rota, para a conta pesada
  (super-admin, 2 times) e para a leve (1 time), faz 1 pedido FRIO (primeiro da conta, caches do motor vazios) e 5
  QUENTES, e escreve a mediana dos quentes. A conta de prova vem de scripts/_bench/prova-conta-pesada.js.

  Só LEITURA (GET). As rotas são as do arranque: Início, /api/me, Resenha, Figurinha (selos), ranking, times.
  Os milissegundos são DESTA máquina até o Supabase de São Paulo — o que não muda de máquina para máquina é o número de
  idas ao banco e o tamanho da resposta; é nesses dois que a parte B mexe.

    node scripts/_bench/medir-conta-pesada.js --etiqueta antes
    node scripts/_bench/medir-conta-pesada.js --etiqueta depois

  Saída: a tabela em markdown no terminal e scripts/_bench/saida-conta-pesada/<etiqueta>.json.
  ═══════════════════════════════════════════════════════════════════════════════

## scripts/_bench/prompt-antigo-reprovado.js

- (linha ~1, `` const PROMPT_BASE = `You are illustrating a premium soccer player sticker card. ``) ═══════════════════════════════════════════════════════════════════════════════
  O PROMPT ANTIGO — ARQUIVO MORTO (17-set). NÃO USAR EM PRODUÇÃO.

  Este era o prompt do avatar até 17-set: PROMPT_BASE (5.375 caracteres, com
  PRIORITY ORDER e o bloco STYLE de pincelada larga) + a secção KIT em cinco
  pontos + o checklist de cinco itens. Foi REPROVADO na bancada de 49
  figurinhas: 1,6/5 contra 4,1/5 do prompt novo (prompts/figurinha.js), e errou
  o emblema do peito em 4 das 7 fotos (o novo, em 0).

  Fica aqui por uma razão só: a bancada precisa dele para REPETIR a comparação
  (variantes 1, 2 e 5). Ninguém importa isto fora de scripts/_bench/.
  ═══════════════════════════════════════════════════════════════════════════════
- (linha ~115, `` const kitChecklist = (acento) => `KIT CHECKLIST — before finishing, verify ALL… ``) Ronda 3 (30-jul): no low os detalhes pequenos do kit somem (o friso da manga
  foi o primeiro visto na prova de produção). Checklist explícito no fim do prompt.

## scripts/_bench/prompts-low.js

- (linha ~80, `` const ENQ_RETRATO = `FRAMING — PORTRAIT: ``) RONDA 2 (30-jul). A ronda 1 provou: o estilo do L2 funciona no low, mas TODAS
  as variantes quadradas cortaram a coroa (achatamento 0,66–0,96) enquanto o M0
  em retrato saiu limpo (0,02). A culpa é da GEOMETRIA, não da qualidade: num
  quadrado, "busto + cabeça grande" não deixa altura para o ar acima da cabeça.
  Dois consertos a testar:
- (linha ~127, `` const BRACOS = `ARMS — COMPLETE FIGURE: ``) RONDA 3 (30-jul). A prova de produção mostrou braço em falta (Renato) e braço
  cortado na borda (Kim2). Guarda explícita:
- (linha ~168, `function kitEscudoSimples(kitTxt, acento = 'the accent colour') {`) L2: escudo como forma sólida simples em vez de "duas F espelhadas".
   Idempotente: desde 30-jul a produção JÁ traz o escudo simplificado —
   nesse caso devolve o texto como está.
- (linha ~181, `` const kitChecklist = (acento) => `KIT CHECKLIST — before finishing, verify ALL… ``) Ronda 3: no low os detalhes pequenos do kit somem (o friso da manga foi o
  primeiro — visto na prova de produção de 30-jul). Checklist explícito:
- (linha ~390, `L2PT: { nome: 'L2P transp s/ birefnet', qualidade: 'low', tamanho: '1024x1536',…`) --- RONDA 4 (1-ago): TRANSPARENTE em retrato — mata o birefnet e o cabelo
      comido por construção. Comparar com os L2PB já no disco. ---

## scripts/_bench/prova-auditor.js

- (linha ~1, `const fs = require('fs');`) BANCADA — TREINO DO AUDITOR (1-ago, dono). LOW APENAS, medium morto.
  Para cada foto: gera 1x pela receita REAL de produção (prompt lido de auth.js,
  low, retrato, birefnet) e mede TODOS os cheques do auditor SEM retry — o
  objectivo é VER o julgamento, não escondê-lo:
    · borda TOPO (pré-trim)      — cabeça colada/cortada no tecto
    · borda LATERAL (pré-trim)   — braço cortado pela moldura
    · achatamento (pós-trim)     — coroa comida (>0,50)
    · simetria (pós-trim)        — braço em falta de um lado (<0,82; calibrada
                                   em 55 cards: bons ≥0,88, Denis-defeito 0,74)
  O HTML mostra cada card com métricas e VEREDITO. O dono confere com o olho e
  diz onde o auditor errou (falso alarme ou defeito que passou) — é assim que
  os limiares se afinam.

  Uso:  node scripts/_bench/prova-auditor.js               (./public/fotos-treino)
        node scripts/_bench/prova-auditor.js ./outra/pasta
  Custo: n × ~$0,017 (low retrato + birefnet). Tecto $0,30.
- (linha ~104, `const iF = process.argv.indexOf('--fotos');`) --fotos nome1,nome2 : repete SÓ essas (ex.: as reprovadas da rodada anterior)

## scripts/_bench/prova-conta-pesada.js

- (linha ~1, `require('dotenv').config({ quiet: true });`) ═══════════════════════════════════════════════════════════════════════════════
  A CONTA PESADA DE PROVA (1-out, Rodada 29B, bloco 2, parte B) — a forma da conta Chavo, sem tocar em time de ninguém.

  Achado do Pedro (30-set): no MESMO iPhone a conta nova de teste abre o Início rápido e a conta Chavo, devagar. A Chavo é
  super-admin e está em 2 times: o Missa de Quinta (1 membro, 16 posts de Resenha com foto) e o Várzea FC (22 membros, 9 jogos,
  9 posts). Entrar nesses times com uma conta de prova poluiria o ranking e as listas de gente de verdade, então esta
  bancada monta a MESMA forma em times descartáveis, com contas @futtymock:

    pesada  super-admin, admin dos 2 times:
              prova-r29b-pesada-missa   (Missa-like)  1 membro · 16 posts com 1–2 fotos · 30 jogos passados
              prova-r29b-pesada-varzea  (Várzea-like) 22 membros · 6 jogos passados + 3 futuros (RSVP aberto) · 9 posts · 462 votos
    leve    1 time só, com 1 jogo futuro (a conta "nova de teste" que abre rápido)

  Só servidor LOCAL e só leitura depois de montada (scripts/_bench/medir-conta-pesada.js). Nada gera figurinha (custo de IA 0).

    node scripts/_bench/prova-conta-pesada.js            cria/refaz tudo e grava as sessões
    node scripts/_bench/prova-conta-pesada.js --apagar   apaga times e contas

  Sessões em ../frontend/scripts/capturas/sessao-pesada.json e sessao-leve.json (fora do git).
  ═══════════════════════════════════════════════════════════════════════════════

## scripts/_bench/prova-figurinha-real.js

- (linha ~1, `require('dotenv').config();`) ═══════════════════════════════════════════════════════════════════════════════
  PROVA DE PRODUÇÃO REAL — uma figurinha pelo caminho de verdade (17-set).

  Não é bancada: isto chama a ROTA (`POST /api/me/avatar/ai`) com a sessão da
  conta demo da loja, e por isso exercita tudo o que mudou de uma vez —
  prompts/figurinha.js, a entrada quadrada, input_fidelity explícito, a fila da
  fal com leitura do custo, e a gravação em `gasto_ia_diario`.

  O que se prova: que a linha do dia ganha o custo REAL (~11 cêntimos), não a
  constante de 1,7 que estava lá antes.

    node scripts/_bench/prova-figurinha-real.js            (servidor em :3009)
    --porta 3009     onde o servidor de prova está a ouvir
    --kit dark-gold

  Antes de gerar, desarma os dois atalhos que impediriam a geração: o slot do
  kit (a conta demo já tem figurinha) e a quota do mês. Repõe a quota no fim.
  Custo: uma geração (~US$0,112); se a rede de segurança reprovar a 1ª imagem,
  o retry da própria produção gera outra e o dobro é cobrado — o script diz.
  ═══════════════════════════════════════════════════════════════════════════════
- (linha ~116, `const marcador = '/object/public/avatars/';`) O caminho vem do `avatar_url` que a rota devolveu — desde 22-set o nome do
  ficheiro leva carimbo de tempo (`public/<id>-ai-<kit>-<carimbo>.png`) e já
  não dá para o adivinhar aqui. Este é também o caminho que o resto do app
  usa: se a prova o lê do mesmo sítio, prova a mesma coisa que o app vê.

## scripts/_bench/prova-mista.js

- (linha ~1, `require('dotenv').config();`) Futty v2.0 — CAPTURA DA CERIMÔNIA COM TIME MISTO (23-set).

  Cria um time DESCARTÁVEL "Prova Mista" com 10 jogadores: 4 com figurinha
  (PNGs já pagos de saida-prompt/saida-economia — nenhuma geração de IA nova,
  custo US$0) e 6 só com foto (BANCADA-FOTOS, card comum). Marca 1 goleiro e
  1 cabeça de chave, cria um jogo, confirma os 10 e sorteia pelo algoritmo
  real (mesma função de routes/games.js) — a seed fica gravada em
  times_resultado, pronta para o ver-iphone.mjs reproduzir a cerimônia.

  Uso (a partir de backend/):
    node scripts/_bench/prova-mista.js            cria tudo, sorteia, grava a sessão do capitão
    node scripts/_bench/prova-mista.js --apagar   apaga o time e os 10 jogadores

## scripts/_bench/prova-rodada19.js

- (linha ~1, `require('dotenv').config();`) Futty v2.0 — RODADA 19: conta descartável para a cena 'rodada19' do
  ver-iphone.mjs (enquadrar dentro de Trocar foto, Minhas figurinhas,
  miniatura pelo topo). Entra em domingueira-fc-demo (já tem 6+ jogos
  passados) e confirma em 3 deles só para passar do MIN_JOGOS do Ranking —
  não mexe em nada que já existe do time.

    node scripts/_bench/prova-rodada19.js            cria a conta + sessão
    node scripts/_bench/prova-rodada19.js --apagar   desfaz tudo

## scripts/_bench/prova-rodada20.js

- (linha ~1, `require('dotenv').config();`) Futty v2.0 — RODADA 20: contas + convite reutilizável para a cena
  "rodada-20" do ver-iphone.mjs. Cria um time descartável com um convite já
  usado por UMA conta, para a 2ª conta (cuja sessão a cena usa) entrar pelo
  MESMO link — a prova visual de que o link não morre no 1º uso. Também
  grava a sessão de uma conta nova (sem figurinha) e lê a senha real da
  demo-loja (LOJA/demo-senha.txt) para as duas capturas do interruptor.

    node scripts/_bench/prova-rodada20.js            cria tudo
    node scripts/_bench/prova-rodada20.js --apagar   desfaz (não toca a demo-loja)

## scripts/_bench/prova-rodada21.js

- (linha ~1, `require('dotenv').config();`) Futty v2.0 — RODADA 21: conta descartável para a cena 'rodada21' do
  ver-iphone.mjs (gerações generosas + uniformes guardados). Uma pessoa com
  crédito (Minha Figurinha), um kit já pintado (dark-gold) e outro por pintar
  (dark-purple) — dá para provar, na mesma conta: o contador "N restantes",
  o selo "pintar · 1 geração", o diálogo de confirmação e a troca instantânea
  para um uniforme já pintado. Super-admin também, para a mesma sessão abrir
  o Gabinete → Figurinhas (campo "Dar crédito a um e-mail").

    node scripts/_bench/prova-rodada21.js            cria a conta + sessão
    node scripts/_bench/prova-rodada21.js --apagar   desfaz tudo

## scripts/_bench/prova-rodada28.js

- (linha ~1, `require('dotenv').config({ quiet: true });`) ═══════════════════════════════════════════════════════════════════════════════
  CONTAS DESCARTÁVEIS DA RODADA 28 (25-set) — para a cena `rodada28` do scripts/ver-iphone.mjs.

  O que a cena prova pela tela, em servidor LOCAL (nunca a produção — CLAUDE.md, 25-set):
    A · card com a FOTO: sem seletor de fundos, zoom com piso em "cobre a moldura", grade de
        uniformes com o 1º liberado e cadeados que levam aos Planos (e o card do pacote do time,
        com o uniforme do time pintável);
    B · "Sair" só deste aparelho; 401 do motor → login com aviso, nunca "crie seu time";
    C · cadastro com menos de 18 anos não cria conta (formulário e onboarding de Google/Apple);
    D · Diagnóstico só para o super-admin, pelo Gabinete;
    E · telemetria anônima de velocidade (o que sai do aparelho);
    H · Gabinete: jogadores, gerações e custo por time.
  Nada gera figurinha (custo de IA zero). Tudo @futtymock; os times são só desta rodada.

    node scripts/_bench/prova-rodada28.js            cria/refaz tudo e grava as sessões
    node scripts/_bench/prova-rodada28.js --apagar   apaga times e contas

  Sai em ../frontend/scripts/capturas/sessao-rodada28.json (fora do git).
  ═══════════════════════════════════════════════════════════════════════════════

## scripts/_bench/prova-rodada29b.js

- (linha ~1, `require('dotenv').config({ quiet: true });`) ═══════════════════════════════════════════════════════════════════════════════
  CONTAS DESCARTÁVEIS DA RODADA 29B (30-set) — para as cenas `rodada29b-*` do scripts/ver-iphone.mjs.

  Parte B (grade de uniformes): a MESMA grade para os três direitos, e o estado de cada tile sai do direito.
    gratis     card com a FOTO, sem direito de gerar               → os 5 uniformes com cadeado
    pacote     card com a FOTO, dono de time com pacote (Dark Purple) → o do time aberto, os outros com cadeado
    pacoteFig  figurinha do time vestida (Dark Purple), 1 geração gasta → vestido ✓, "Refazer" pequeno embaixo
    minha      card com a FOTO, 3 créditos (Minha Figurinha)       → os 5 abertos, com o selo "pintar · 1 geração · ~45 s"
    minhaFig   figurinha Dark Gold vestida + White Gold pintado, 3 créditos → vestido, pintado, 3 abertos, "Refazer"
  Parte C (boas-vindas do time): dois MEMBROS (não-admin) do time "gratis":
    novato     sem foto nenhuma (avatar_url nulo)  → a 1ª visita à página do time abre as boas-vindas
    membroFoto com foto                            → só abre logo depois de aceitar um convite (state.primeiraEntrada)
  Parte F ("Avise-me"): `super` — super-admin de prova para a aba do Gabinete.
  Parte E ("só organizo"): o time "gratis" tem um jogo futuro (id em sessao-rodada29b.json → jogo) para as telas de presença.
  Nada gera figurinha (custo de IA zero): as "figurinhas" são PNGs desenhados aqui, com `-ai-` no nome como as de verdade.
  Tudo @futtymock; os times são só desta rodada. Só servidor LOCAL (CLAUDE.md, 25-set).

    node scripts/_bench/prova-rodada29b.js            cria/refaz tudo e grava as sessões
    node scripts/_bench/prova-rodada29b.js --apagar   apaga times e contas

  Sai em ../frontend/scripts/capturas/sessao-rodada29b.json (fora do git).
  ═══════════════════════════════════════════════════════════════════════════════

## scripts/_bench/prova-v6.js

- (linha ~1, `require('dotenv').config();`) ═══════════════════════════════════════════════════════════════════════════════
  PROVA DA RECEITA V6 (SPEC-FIGURINHA-3 §4, 22-set).

  A Brilhante é paga, por isso leva a MELHOR receita — a V6 que o dono avaliou
  em 4,1/5 na bancada cega de 17-set, e não as duas passadas (US$0,05) que
  serviam a figurinha grátis. Esta prova responde a uma pergunta só: a V6
  continua a funcionar exactamente como em 17-set?

    mesmo motor      fal-ai/gpt-image-1.5/edit, quality low
    mesma entrada    corte QUADRADO 1024×1024 (utils/entradaFigurinha.js)
    mesma fidelidade input_fidelity: high
    mesmo prompt     prompts/figurinha.js (P2)
    mesmo custo      ~US$0,112 + US$0,002 do birefnet

  Chama `gerarFigurinha` DIRETO, sem passar pela rota: o portão do direito
  (§5) é outra coisa e tem os seus próprios testes. Usa a foto do modelo
  FICTÍCIO da conta demo — nunca uma pessoa real (regra de 17-set).

    node scripts/_bench/prova-v6.js
    --receita duas-passadas   compara com a receita alternativa (US$0,05)

  Custo: uma geração real (~US$0,11).
  ═══════════════════════════════════════════════════════════════════════════════

## scripts/_bench/qualidade-low-vs-medium.js

- (linha ~1, `const fs = require('fs');`) BANCADA — QUALIDADE (low vs medium) × FUNDO DE GERAÇÃO (preto vs cinza)

  ===========================================================================
  COMO CORRER (não é para abrir com duplo-clique — é um script de terminal):

    1) põe 4-8 fotos em  backend/public/fotos-teste/   (inclui a que falha!)
    2) no terminal, dentro da pasta  backend/ :

         node scripts/_bench/qualidade-low-vs-medium.js ./public/fotos-teste

    3) no fim ele escreve um ficheiro HTML e diz o caminho.
       ESSE sim abre-se com duplo-clique, no browser.

    Opções:  --fundos preto,cinza,verde     --qualidades low,medium
  ===========================================================================

  DUAS PERGUNTAS, UMA CORRIDA:

  A) QUALIDADE — produção corre em `medium` ($0,051/retrato); o `low` custa
     $0,013, 4× menos, e nunca foi testado. A copy do ENVELOPE já anuncia
     R$4,90 por 10 figurinhas, logo esta medição decide se o preço dá lucro.

  B) FUNDO — hipótese do dono (29-jul), e o prompt dá-lhe razão: o fundo de
     geração é #050810 (quase preto), a camisa é #0d0d12 (quase preto) e o
     cabelo do jogador é preto. O birefnet tem de recortar um objecto preto
     de um campo preto → come o cabelo → "cabeça achatada".
     O fundo de geração é DESCARTADO pelo birefnet: ninguém o vê. Fazê-lo
     preto é sabotar o recorte de graça. Este teste mede se um fundo com
     contraste resolve — custo zero, é só prompt.
     Consequência importante: se a causa é esta, o RETRY nunca conserta
     (regera preto sobre preto) → paga 2× com 0% de chance. Ver linha 695
     de routes/auth.js.

  De borla mede o tamanho real de saída (define se a conta é $0,034 ou $0,051)
  e a taxa de coroa cortada por combinação — as duas medições em falta do
  FUTTY-CUSTOS.md.

  NÃO TOCA EM PRODUÇÃO: só LÊ o prompt de auth.js e escreve no scratchpad.

## scripts/_bench/renderizar-camadas.js

- (linha ~1, `const fs = require('fs');`) ═══════════════════════════════════════════════════════════════════════════════
  CAMADAS DO "OURO VIVO" NO TAMANHO CHEIO — Rodada 29X.

  Quem desenha o ícone e o splash do app é a receita da bancada de 23-set
  (testar-icone.js: o F real de futtyMonograma.js, em ouro com degradê, reflexo e
  brilho, sobre a vinheta). Este script só RENDERIZA as peças dela no tamanho cheio
  e as grava como PNG; quem compõe, redimensiona e grava nos lugares do app é o
  frontend (scripts/gerar-icones.mjs e scripts/gerar-splash.mjs), que chama este
  script num processo filho. Por que filho: o sharp do backend e o do frontend são
  duas cópias do libvips (versões diferentes) e as duas no MESMO processo derrubam
  o Node (segfault) — cada uma fica no seu.

  Nada é desenhado aqui: as funções são as de testar-icone.js (require, não cópia).

    adaptativo-fundo-1024.png   a vinheta #1a1826 → #0b0a12 SEM aro (variante 1 "ouro vivo"), sem alfa
    adaptativo-frente-1024.png  só o F ouro vivo com o brilho, transparente, dentro da zona segura (66/108)
    splash-f-<altura>.png       o F ouro vivo com o brilho, transparente, num quadrado só um pouco maior que o F (74% do lado),
                                com <altura> px de altura — a mesma peça do ícone do iPhone, só em escala maior

    node scripts/_bench/renderizar-camadas.js --saida=<pasta> [--splash-altura=928]
  ═══════════════════════════════════════════════════════════════════════════════

## scripts/_bench/repor-estado-demo.js

- (linha ~1, `require('dotenv').config();`) ═══════════════════════════════════════════════════════════════════════════════
  DEVOLVER A CONTA DEMO AO ESTADO DA LOJA (22-set).

  A conta demo-loja@futtymock.com é a que aparece nas capturas da loja. Uma
  bancada que mexa nela (a de reprodução do bug da foto antiga, por exemplo)
  deixa-a com a cara de outra pessoa — e isso não pode ficar assim.

  Este script repõe o retrato do modelo fictício guardado em
  `estado-demo/foto-silhueta-original.jpg`, pela ROTA REAL (multipart), e gera
  uma figurinha dark-gold nova a partir dele. Depois limpa do bucket tudo o que
  tenha ficado para trás de corridas anteriores — incluindo os nomes FIXOS do
  esquema antigo (`<id>.png`, `<id>-ai-<kit>.png`, `tmp/<id>-pad.jpg`), que já
  não são escritos por ninguém.

    node scripts/_bench/repor-estado-demo.js --porta 3014
    --sem-gerar             repõe só a foto e limpa o bucket (US$0,00)
    --figurinha-de <arquivo> em vez de GERAR (rota paga), publica esse PNG já
                             existente como a figurinha do kit — mesmo efeito
                             final (bucket, users, slot), custo zero. Serve
                             para repor depois de uma bancada que já pagou por
                             uma figurinha boa da MESMA foto (ex.: a prova da
                             Rodada 17) e não precisa pagar outra vez só para
                             devolver a conta ao estado da loja. Ignorado
                             junto com --sem-gerar.

  Custo: uma geração (~US$0,05); zero com --sem-gerar ou --figurinha-de.
  Não é para correr contra produção: pede a um servidor LOCAL.
  ═══════════════════════════════════════════════════════════════════════════════

## scripts/_bench/repro-foto-antiga.js

- (linha ~1, `require('dotenv').config();`) ═══════════════════════════════════════════════════════════════════════════════
  REPRODUZIR O BUG DA FOTO ANTIGA (22-set, conta do Pedro).

  O que aconteceu em produção: às 12:21:08 subiu uma foto nova, às 12:21:14
  pediu figurinha — e a figurinha saiu da foto ANTIGA. Seis segundos.

  A suspeita: a foto vai sempre para o MESMO caminho (public/<userId>.<ext>,
  com upsert e cacheControl 3600), e a geração faz download desse caminho logo
  a seguir. O CDN da Supabase pode servir a versão velha por até ~60 s.

  Este script mede isso sem opinião: sobe a foto A, gera, sobe a foto B, gera
  UM SEGUNDO depois, e compara o sha256 da foto que o motor baixou (o log da
  ETAPA 0) com o `users.foto_hash` de cada momento. Se a segunda geração usou
  o hash de A, o bug está reproduzido.

    node scripts/_bench/repro-foto-antiga.js --porta 3013
    --espera 1   segundos entre subir a foto B e pedir a figurinha
    --so-upload  só sobe as fotos e compara hashes, SEM gerar (US$0,00)

  Custo: duas gerações (~US$0,10), ou zero com --so-upload.
  ═══════════════════════════════════════════════════════════════════════════════

## scripts/_bench/resetar-conta-demo.js

- (linha ~1, `const { supabase } = require('../../utils/db');`) BANCADA — RESET DE CONTA PARA DEMONSTRAÇÃO (31-jul).
  Devolve uma conta mock ao estado "recém-instalado": sem foto, sem avatar IA,
  onboarding por fazer. Serve para o dono VER com os próprios olhos:
    · o onboarding completo (3 passos, de verdade, não simulado)
    · a LEI DA SILHUETA no Início e na Figurinha (card sem avatar)

  Uso:  node scripts/_bench/resetar-conta-demo.js            (erick@futtymock.com)
        node scripts/_bench/resetar-conta-demo.js wesley@futtymock.com

  Só funciona em contas @futtymock.com — recusa qualquer outra (proteção).

## scripts/_bench/testar-acabamento.js

- (linha ~1, `require('dotenv').config();`) ═══════════════════════════════════════════════════════════════════════════════
  BANCADA DO ACABAMENTO (17-set) — a cara do 2.5 com o acabamento da V6.

  De onde vem: na bancada de modelos (commit 8628fd3) o dono viu as 7 folhas e
  disse que a CARA dos candidatos 1 e 2 (openai/gpt-image-2.5/flare/edit) está
  boa, mas o ACABAMENTO que ele quer é o da célula 8 — a V6, que é pintura
  semi-realista de figurinha. O 2.5 devolve algo mais perto de um retoque de
  foto: pele fotográfica, luz de celular, textura de JPEG. A pergunta aqui é
  uma só: dá para empurrar o 2.5 para a pintura, sem perder a cara?

  Se der, a conta muda: o 2.5 low custa US$0,025 contra os US$0,112 da V6 —
  4,5× mais barato na mesma figurinha.

  VARIANTES (endpoint único: openai/gpt-image-2.5/flare/edit, 1024x1536):
    1  low    + RENDERING reescrito para forçar pintura
    2  medium + o mesmo RENDERING
    3  low    + o mesmo RENDERING + uma TERCEIRA imagem de referência de
               acabamento (uma figurinha V6 já pronta)
    4  (não gera) o 2.5 low PURO, copiado de saida-modelos-2/<foto>/1.png
    5  (não gera) a V6 de hoje, copiada de saida-modelos-2/<foto>/8.png

  A TERCEIRA IMAGEM É DO MODELO FICTÍCIO da conta demo, nunca de uma pessoa
  real da bancada: uma figurinha de gente real na entrada contaminaria a cara
  do retrato — que é justamente o que não se quer mexer. E o prompt diz, com
  todas as letras, que de Image 3 só se tira o acabamento.

  O resto é igual ao que está em produção e às outras bancadas: mesmas fotos,
  mesma entrada quadrada (utils/entradaFigurinha.js), mesmo kit dark-gold,
  mesmo prompt base (prompts/figurinha.js), mesmo birefnet, mesma leitura de
  custo real (utils/falFila.js + a tabela de conversão por endpoint).

  CORRER (a fal só resolve na máquina do Pedro):
    node scripts/_bench/testar-acabamento.js --so-um     triagem: só o Gui
    node scripts/_bench/testar-acabamento.js --resto     as outras 6 fotos
    --teto 1.50        aborta antes de passar deste gasto
    --so 1,3           só estas variantes
    --foto <prefixo>   só a foto cujo nome começa assim
  ═══════════════════════════════════════════════════════════════════════════════

## scripts/_bench/testar-economia.js

- (linha ~1, `require('dotenv').config();`) ═══════════════════════════════════════════════════════════════════════════════
  BANCADA DA ECONOMIA (18-set) — baratear a V6 sem trocar de motor.

  ┌────────────────────────────────────────────────────────────────────────┐
  │ A VARIANTE 3 É A PRODUÇÃO desde 22-set (decisão do dono, 7 folhas).    │
  │ US$0,049 reais contra US$0,112 da V6, 0/7 cabeças cortadas, 0/7        │
  │ uniformes errados. A receita dela vive agora em                        │
  │ utils/geracaoFigurinha.js e é de lá que esta bancada a chama — correr  │
  │ isto outra vez compara sempre contra o que está mesmo no ar.          │
  └────────────────────────────────────────────────────────────────────────┘

  Onde estamos: a V6 (gpt-image-1.5/edit + P2 + entrada quadrada + fidelidade
  alta) é a única receita aprovada, e custa US$0,112. Duas bancadas já tentaram
  baratear trocando de motor (todos reprovados) e pintando o 2.5 por prompt
  (não pegou). Esta tenta dois caminhos diferentes:

    A) PAGAR MENOS PELA MESMA CHAMADA. A fal cobra os tokens da imagem de
       ENTRADA, e em fidelidade alta uma imagem 1024×1024 são 3.050 tokens
       (US$0,024). Mandar o kit — que é um desenho chapado, sem detalhe fino —
       a 512×512 deve cortar boa parte disso. A foto a 768 corta mais. A
       pergunta: até onde se pode encolher sem o uniforme sair errado?

    B) DUAS PASSADAS. A passada 1 já está paga e feita: o 2.5 low (US$0,025)
       dá a CARA, que o dono aprovou. A passada 2 só repinta: manda a imagem
       pronta com fidelidade BAIXA (135 tokens em vez de 3.050) e pede pintura
       sem mudar mais nada. Se funcionar, a figurinha sai por ~metade.

  VARIANTES
    1  V6 exata, kit a 512x512
    2  V6 exata, kit a 512x512 + foto a 768x768
    3  duas passadas: 2.5 low (já pago) → gpt-image-1.5 low + fidelidade BAIXA
    4  duas passadas: 2.5 low (já pago) → flux-2 klein 9b base
    5  (cópia, não gera) V6 de referência, de saida-prompt/<foto>/6.png
    6  (cópia, não gera) 2.5 low puro, de saida-modelos-2/<foto>/1.png

  A ENTRADA DA PASSADA 2 não é o 1.png tal e qual: esse ficheiro é a figurinha
  MONTADA (512x768, com moldura dourada e fundo escuro da casa). Mandá-lo
  assim faria o modelo repintar a moldura. Então: corta-se a moldura, passa-se
  pelo birefnet (US$0,002, registado) e compõe-se o jogador sobre o cinza
  #8a8a8a que o prompt promete, em 1024x1536.

  CORRER:
    node scripts/_bench/testar-economia.js --so-um --teto 0.60   triagem (Gui)
    node scripts/_bench/testar-economia.js --resto --teto 1.90   as outras 6
    --so 1,3           só estas variantes
    --foto <prefixo>   só a foto cujo nome começa assim
  ═══════════════════════════════════════════════════════════════════════════════

## scripts/_bench/testar-icone.js

- (linha ~1, `const fs = require('fs');`) ═══════════════════════════════════════════════════════════════════════════════
  ÍCONE DO APP — "o F está apagado na tela inicial do celular" (dono, 23-set).

  Bancada de COMPARAÇÃO (não aplica nada): 3 variantes do ícone em 1024×1024 e
  uma folha lado a lado com o ícone ATUAL, nos tamanhos reais de tela inicial.
  O passo seguinte (outro bloco) aplica a escolhida no iOS, Android e web.

  Regras da casa que mandam aqui:
    • O F é sempre o ASSET REAL — o mesmo `F_CONTORNO` de
      frontend/src/utils/futtyMonograma.js, lido daquele arquivo em tempo de
      execução (fonte única; se mudar lá, muda aqui). Só o TRATAMENTO muda:
      tamanho, gradiente, brilho, fundo. Nenhum traço do F é redesenhado.
    • Sem IA, sem imagem baixada: tudo é SVG (gradientes, blur, vinheta)
      renderizado pelo sharp/librsvg. Os "papéis de parede" da folha também.
    • App leve: 1024 é o mestre; o bloco de aplicação gera os tamanhos.

  Ponto de partida: scripts/_bench/gerar-icone-splash.js (F a 62%, fundo chapado).

  As 3 variantes (todas: F maior, a 74% da altura visível; ouro com gradiente
  vertical #f5e070 → #d4a017 → #b8860b; reflexo diagonal sutil; brilho dourado
  atrás, blur ~4% do lado, alpha 0,35):
    1 "ouro vivo"            fundo #0b0a12 com vinheta radial mais clara no centro (#1a1826)
    2 "ouro vivo + aro"      a 1 com aro dourado fino (2% da largura) nos cantos
                             arredondados, como a moldura da figurinha
    3 "ouro vivo + estádio"  a 1 com fundo azul-roxo (#0f0d1f → #050810) e três
                             pontos de luz muito discretos, lembrando o fundo Estádio

  Por plataforma:
    iOS      PNG 1024×1024 SEM alpha (o iOS aplica a máscara de cantos sozinho).
             O aro da variante 2 segue a superelipse do iOS por dentro da borda.
    Android  adaptive icon: `background` (arte cheia, sem alpha) + `foreground`
             (só o F e o brilho, transparente). A tela de 108 dp é recortada pelo
             launcher em 72 dp (círculo, squircle…); a ZONA SEGURA é o círculo de
             66 dp (66/108 = 61,1% do lado) — o F fica INTEIRO lá dentro, conferido
             vértice a vértice. O aro da 2 vai no background como círculo no
             diâmetro da zona segura (um aro nos cantos do quadrado seria cortado
             por qualquer máscara). Na web/iOS o F é 74% do lado; no Android é
             74% dos 72 dp VISÍVEIS (mesma proporção depois do recorte).

  Folha (saida-icone/folha.png): [atual, 1, 2, 3] × [iOS 60 pt = 180 px,
  Android 48 dp = 144 px] × [papel de parede escuro, claro], com "Futty" por
  baixo como no celular (iOS: 11 pt em 60 pt, branco com sombra; Android:
  12 sp em 48 dp, branco no escuro e quase-preto no claro). O ATUAL é o que
  está no aparelho de verdade: o AppIcon do iOS e o foreground/background do
  Android que estão no repositório — não uma regeneração.

    node scripts/_bench/testar-icone.js
  ═══════════════════════════════════════════════════════════════════════════════

## scripts/_bench/testar-low.js

- (linha ~1, `const fs = require('fs');`) BANCADA — VIABILIZAR O `low` (prioridade nº1 do dono, 29-jul)

  ===========================================================================
  COMO CORRER (é um script de terminal, não se abre com duplo-clique):

    1) põe as fotos em  backend/public/fotos-teste/
    2) no terminal, DENTRO da pasta  backend/ :

         node scripts/_bench/testar-low.js ./public/fotos-teste

    3) no fim ele imprime o caminho de um index.html — ESSE abre no browser.

    Opções:
      --variantes L1,L2,L3     quais candidatos low correr (omissão: os três)
      --controlo               inclui o medium de produção como régua (recomendado)
      --teto 1.00              tecto de gasto em dólares; recusa se passar
  ===========================================================================

  Mede quatro coisas por imagem:
    custo · achatamento da coroa (cabeça inteira ou comida) · nitidez
    (variância do laplaciano — quantifica a "moleza" do low) · tamanho de saída.

  NÃO TOCA EM PRODUÇÃO. Só LÊ o prompt de auth.js e escreve no scratchpad.

## scripts/_bench/testar-modelos.js

- (linha ~1, `require('dotenv').config();`) ═══════════════════════════════════════════════════════════════════════════════
  BANCADA DE MODELOS (17-set) — mesmo prompt, motores mais baratos.

  A V6 (gpt-image-1.5/edit + P2 + entrada quadrada) resolveu a SEMELHANÇA e
  custa US$0,112. A pergunta agora é só de dinheiro: algum motor mais barato
  entrega a mesma figurinha? O prompt, a entrada e a leitura de custo vêm dos
  módulos de PRODUÇÃO — se um candidato ganhar, o que muda é uma linha.

  CANDIDATOS (--so-um corre só a foto do Gui, que é a rodada de triagem):
    1  gpt-image-2.5/flare/edit · low    · foto + kit
    2  gpt-image-2.5/flare/edit · medium · foto + kit
    3  gpt-image-2.5/flare/edit · low    · SÓ a foto, kit por texto
    4  seedream v5 lite/edit            · foto + kit
    5  flux-2 klein 9b base/edit        · foto + kit
    6  nano-banana/edit                 · foto + kit
    7  qwen-image-edit-2511             · foto + kit
    8  (não gera) a V6 de produção, copiada de saida-prompt/<foto>/6.png

  SCHEMAS CONFERIDOS ANTES DE GASTAR (fal.ai/api/openapi/queue/openapi.json):
  os cinco endpoints aceitam `image_urls` (array), portanto todos levam foto E
  kit. NENHUM tem `input_fidelity` — é um parâmetro do gpt-image-1.5 e não
  sobreviveu no 2.5, o que significa que nos candidatos não há a alavanca de
  custo que a V6 usa. Tamanho: o 2.5, o flux e o qwen aceitam {width,height};
  o nano-banana só `aspect_ratio` ('2:3'); o seedream exige que a saída tenha
  entre 2560x1440 e 4096x4096 pixels no TOTAL, então vai em 1568x2352 (o 2:3
  mais pequeno que respeita o mínimo) e é reduzido depois.

  CORRER (a fal só resolve na máquina do Pedro):
    node scripts/_bench/testar-modelos.js --so-um       triagem: só o Gui
    node scripts/_bench/testar-modelos.js --resto       as outras 6 fotos
    --teto 3.00   aborta antes de passar deste gasto (soma os custos REAIS)
    --so 4,6      só estes candidatos
    --foto <prefixo>  só a foto cujo nome começa assim
  ═══════════════════════════════════════════════════════════════════════════════
- (linha ~59, `const ESTIMATIVA = { 1: 0.045, 2: 0.09, 3: 0.03, 4: 0.035, 5: 0.044, 6: 0.039,…`) Estimativas para o gate ANTES de gastar (a tabela pública da fal, 17-set). O
  que entra no CSV é o custo REAL, convertido como a tabela abaixo manda.
- (linha ~64, `const PRECO_UNIDADE = {`) ┌──────────────────────────────────────────────────────────────────────────┐
  │ x-fal-billable-units NÃO É SEMPRE DINHEIRO (achado desta bancada).       │
  │                                                                          │
  │ No gpt-image (1.5 e 2.5), que a fal cobra por TOKENS, o header traz o    │
  │ custo em dólares — 0,132 no 1.5, 0,0229 no 2.5 low, sempre com quatro    │
  │ casas, como a página de preços promete ("rounded up to the closest       │
  │ hundredth of a cent"). Nos modelos de preço fixo o header traz a         │
  │ CONTAGEM de unidades: o seedream devolveu 1,000 (uma imagem) e o flux    │
  │ 4,000 (quatro megapixels: 2 de entrada + 1,57 de saída, arredondado).    │
  │ Ler os dois como dólares dava US$5 numa bancada que custou 15 cêntimos.  │
  │                                                                          │
  │ `unidade` diz quanto vale UMA unidade daquele endpoint, pela tabela      │
  │ pública da fal; `fonte` diz se esse preço está publicado ou estimado.    │
  └──────────────────────────────────────────────────────────────────────────┘

## scripts/_bench/testar-prompt.js

- (linha ~1, `require('dotenv').config();`) ═══════════════════════════════════════════════════════════════════════════════
  BANCADA DO PROMPT (17-set) — só o PROMPT muda. Mesmo modelo, mesma qualidade.

  Pergunta do dono: dá para a figurinha ficar MAIS PARECIDA com a pessoa sem
  mexer no modelo (gpt-image-1.5/edit), na qualidade (low) nem no tamanho
  (1024×1536)? O kit tem de ficar idêntico e a cabeça inteira.

  ┌──────────────────────────────────────────────────────────────────────────┐
  │ RESULTADO (avaliação do dono, 17-set, 49 figurinhas às cegas, 1 a 5):    │
  │   1 P1 (o prompt antigo) .... 1,6    5 P3 (P2 + STYLE antigo) ..... 3,3  │
  │   2 P1 + fidelity high ...... 2,0    6 P2 + high + QUADRADA ....... 4,1  │
  │   3 P2 ...................... 4,0      (melhor em 6/7 fotos, US$0,112)   │
  │   4 P2 + fidelity high ...... 4,0    7 P2 + fidelity low .......... 2,7  │
  │                                                                          │
  │ A VARIANTE 6 É A PRODUÇÃO desde 17-set. O prompt dela vive em            │
  │ prompts/figurinha.js e a entrada em utils/entradaFigurinha.js — esta      │
  │ bancada IMPORTA os dois, não os copia. Correr isto outra vez compara      │
  │ sempre contra o que está mesmo no ar.                                    │
  └──────────────────────────────────────────────────────────────────────────┘

  SETE variantes por foto:
    1  P1                        o prompt antigo (prompt-antigo-reprovado.js)
    2  P1 + input_fidelity high  o mesmo, pedindo fidelidade ao input
    3  P2                        o prompt novo, de prompts/figurinha.js
    4  P2 + input_fidelity high
    5  P3 + input_fidelity high  P2 com o bloco STYLE antigo de volta — mede se
                                 é o ESTILO que apaga o rosto (é: -0,7)
    6  P2 + high + ENTRADA QUADRADA 1024×1024 ....... A PRODUÇÃO
    7  P2 + input_fidelity low   a barata (US$0,032), reprovada por inconstância

  Todas: birefnet e moldura Dark Gold, como o app entrega.

  CORRER (a fal só resolve na máquina do Pedro):
    cd FUTTY-V2/backend && node scripts/_bench/testar-prompt.js
    --fotos <pasta>     omissão: C:\Users\phfer\Desktop\FUT\BANCADA-FOTOS
    --teto 1.00         recusa antes de gastar se a estimativa passar
    --so Gui,Renato     só estas fotos (prefixo do nome)

  NÃO TOCA EM PRODUÇÃO: lê o prompt de routes/auth.js e escreve só aqui.
  A chave da fal nunca é impressa (nem em erro).
  ═══════════════════════════════════════════════════════════════════════════════
- (linha ~48, `const { montarPrompt } = require('../../prompts/figurinha');`) A bancada usa os MESMOS módulos que a produção — se divergirem, o que se mede
  deixa de ser o que está no ar (17-set: a variante 6 virou produção).
- (linha ~58, `const PRECO = { low: { '1024x1024': 0.009, '1024x1536': 0.013, '1536x1024': 0.0…`) ATENÇÃO AO CUSTO (medido nesta bancada, 17-set):
  A tabela abaixo é só o preço da IMAGEM DE SAÍDA — é o que as bancadas antigas
  contavam, e é por isso que a casa acredita em "$0,015 por figurinha". A fal
  cobra MAIS do que isso na mesma chamada:
    $0,005 / 1.000 tokens de texto do prompt
    $0,008 / 1.000 tokens de IMAGEM de entrada — e uma imagem 1024×1024 são
            135 tokens em fidelidade BAIXA, mas 3.050 em fidelidade ALTA
    $0,010 / 1.000 tokens de raciocínio sobre o prompt
    + $0,013 a imagem de saída low em 1024×1536
  Como `input_fidelity` tem omissão ALTA na fal, a produção manda duas imagens
  em alta fidelidade e paga por isso: o header x-fal-billable-units devolveu
  $0,132 na receita EXACTA de produção (variante 1). O custo verdadeiro por
  figurinha é ~9× o que está escrito no CLAUDE.md.
  Aqui o custo de cada linha vem SEMPRE do header quando ele existe; a tabela
  é o último recurso e a linha do CSV diz "tabela" quando foi usada.
- (linha ~85, `function lerKits(kitId) {`) ── prompts ───────────────────────────────────────────────────────────────────

  DEPOIS DA DECISÃO (17-set): a variante 6 É a produção. O que era "P2" nesta
  bancada é agora `prompts/figurinha.js`, e é de lá que ele vem — a bancada
  deixou de ter texto de prompt próprio. O prompt ANTIGO (P1), que a produção
  tinha até 17-set, está arquivado em `prompt-antigo-reprovado.js` só para estas
  variantes poderem ser repetidas.
- (linha ~107, `function montarP1(kitId, acento) {`) P1 — o prompt reprovado, montado como a produção o montava até 17-set.
- (linha ~130, `const { baixar, achatamento, montarFigurinha, folhaDeContato, mulberry32, paraC…`) As peças partilhadas pelas bancadas (medir a coroa, recortar o fundo, vestir
  a moldura, montar a folha) vivem em comum.js desde que a bancada de MODELOS
  passou a precisar das mesmas — duas cópias mediriam coisas diferentes.
- (linha ~149, `const P2 = montarPrompt('dark-gold');`) o prompt DE PRODUÇÃO desde 17-set
- (linha ~160, `{ n: 7, nome: 'P2 + fidelity LOW (barata)', prompt: P2, fidelity: 'low', entrad…`) Variante 7 (17-set, achado do custo): a MESMA receita da 4, mas com a
  fidelidade de entrada BAIXA — 135 tokens por imagem em vez de 3.050. É a
  que mostra quanto da semelhança se perde ao deixar de pagar a entrada cara.

## scripts/_bench/testar-recorte.js

- (linha ~1, `require('dotenv').config();`) ═══════════════════════════════════════════════════════════════════════════════
  BANCADA "FIGURINHA GRÁTIS SEM IA" (22-set) — recorte + sharp, nada generativo.

  Decisão em estudo (dono, 22-set): a figurinha GRÁTIS passa a ser o recorte da
  foto real; a arte IA fica só para quem paga. Esta bancada mostra, nas 7 fotos
  da BANCADA-FOTOS, como fica a figurinha grátis feita só com o birefnet
  (US$0,002) e processamento nosso — e quanto custa e demora cada acabamento.

  ETAPAS POR FOTO
    0  recorte: birefnet da fal sobre a foto auto-orientada (custo e tempo
       registados). Enquadramento de BUSTO: da coroa (1ª linha opaca) até meio
       do peito, centrado, 8% de folga em cima, no canvas 1024×1536 — a coroa
       nunca é cortada, por construção.
    1  "crua"       só o recorte na moldura da casa, fundo Estádio, placa+nome
    2  "impressão"  + acabamento de figurinha impressa (posterização 10 níveis,
                    contraste +10%, saturação +8%, grão fino, borda 1-2 px)
    3  "pintura"    + o mais perto que o sharp chega da V6 sem IA (mediana,
                    unsharp forte, posterização 8, rim light pelo alpha, vinheta)
    4  "cabeça no busto": a cabeça da pessoa sobre o busto sem cabeça do kit
                    (assets/busto-<kit>.png), emenda em pluma, a gola por cima,
                    a pele do busto (braços e V, assets/busto-<kit>-pele.png)
                    tingida para a mediana da pele do rosto da pessoa com luz e
                    sombra preservadas, acabamento 3 sobre o conjunto. Com
                    --dois-kits sai também no dark-purple (4-<kit>.png +
                    uniformes.png lado a lado): o busto de um kit gera-se UMA
                    vez (US$0,05, do modelo fictício) e trocar depois custa zero.
    5  (cópia) V6, de saida-prompt/<foto>/6.png
    6  (cópia) duas passadas — a produção de hoje, de saida-economia/<foto>/3.png
    As cópias 5/6 escolhem a pasta pelo CONTEÚDO (assinatura da foto para a
    saida-prompt, descritor de rosto contra o 3.png para a saida-economia):
    duas fotos partilham o nome de pasta e as bancadas anteriores deram o
    sufixo _2 por outra ordem.

  ONDE ESTÁ O PESCOÇO. Sem IA, o pescoço acha-se pela geometria do alpha: a
  cabeça é a parte mais larga no topo e o pescoço é o mínimo de largura logo
  abaixo. Com o detector de rosto (@vladmandic/face-api em WASM, instalado como
  devDependency — nunca vai para a imagem de produção) a linha do pescoço vem
  da caixa do rosto (queixo + ~22% da altura), que é mais estável quando há
  braços levantados ou cabelo volumoso. Os dois são medidos e registados; o do
  rosto manda quando existe.

  CORRER (a partir de FUTTY-V2/backend):
    node scripts/_bench/testar-recorte.js --so-um             só o Gui
    node scripts/_bench/testar-recorte.js --resto             as outras 6
    --foto a,b         só as fotos cujo nome começa por um destes prefixos
    --dois-kits        célula 4 em dark-gold E dark-purple (+ uniformes.png)
    --teto 0.20        tecto de gasto (omissão US$0,20)
    --sem-rosto        não usa o detector de rosto (só geometria do alpha)
    --refazer-busto    regenera assets/busto-<kit>.png (+ -pele.png, .json)

  Custo: US$0,002 por foto (um birefnet). O busto de um kit pago custa US$0,05
  UMA vez (fica em assets/); correr de novo não paga nada por ele.
  ═══════════════════════════════════════════════════════════════════════════════
- (linha ~61, `const { gerarFigurinha } = require('../../utils/geracaoFigurinha');`) A receita de produção, só para gerar UMA vez o busto de cada kit pago
  (US$0,05 cada) a partir do modelo fictício da conta demo — nunca de uma
  pessoa real, para não contaminar a cara (regra de 17-set).
- (linha ~76, `const ALTURA_BUSTO = 680;`) Todos os bustos à mesma altura: o de 17-set tem 680 px, e é essa a escala
  em que as medidas (pescoço, gola, pluma) foram afinadas.
- (linha ~255, `const ehPeleEstrita = (r, g, b) => {`) Apaga a cabeça da figurinha de produção de 17-set acima da gola, com pluma, e
  guarda em assets/. A gola é onde a largura dispara depois do pescoço (o V da
  camisa começa nos ombros): pescoço = mínimo entre 20% e 50% da altura, gola =
  primeira linha abaixo com largura > 1,5× o pescoço. Devolve as medidas que a
  emenda precisa (linha e largura do pescoço, centro, linha da gola).
- (linha ~280, `async function garantirBusto(kit, obterFonte) {`) O busto de um kit, sem cabeça, com a máscara de pele (braços + V) e as
  medidas guardadas ao lado: assets/busto-<kit>.png, -pele.png, .json. Só se
  gera quando falta ou com --refazer-busto; `obterFonte()` devolve a figurinha
  COM cabeça (PNG com alpha) — do ficheiro de 17-set no dark-gold, de uma
  geração real no resto. Todas as fontes são trimadas e postas a 680 px de
  altura, a escala em que as medidas foram afinadas.
- (linha ~332, `const cinza = (buf) => sharp(buf, { raw: { width: w, height: h, channels: 1 } }…`) Limiar em JS: o .threshold() do sharp sobre um raw de 1 canal devolveu
  zero (achado do adendo, "pele 0 px"); o desfoque de 1 canal funciona.
- (linha ~716, `const dentro = await sharp(await fundoEstadio(W, H))`) UM composite só: no sharp, chamar .composite() duas vezes não acumula — a
  segunda chamada substitui a primeira (achado na 1ª corrida: o card saía só
  com o estádio). A lista é aplicada em ordem sobre o resultado acumulado, e
  o dest-in no fim recorta tudo pelo octógono.
- (linha ~728, `async function assinatura(buf) {`) ─── As referências (5 e 6) escolhidas pelo CONTEÚDO, não pelo nome ──────────
  Duas fotos da bancada partilham o nome de pasta (`…22d_-` e `…22d_-_2`) e
  as bancadas anteriores atribuíram o sufixo por outra ordem: copiar por nome
  punha a V6 de OUTRA pessoa ao lado do recorte (achado da 7ª corrida — e a
  bancada da economia, que também copiou por nome, já tinha esse cruzamento).
  A assinatura é a foto a 24×24 em cinza; dentro de cada grupo de pastas com o
  mesmo nome base escolhe-se a permutação de menor distância total.

## scripts/_bench/testar-uniforme.js

- (linha ~1, `require('dotenv').config({ quiet: true });`) ═══════════════════════════════════════════════════════════════════════════════
  BANCADA DO UNIFORME (6-out, achado 3g da LISTA-CURTA).

  Em 5-out o uniforme saiu fiel ao kit em 4 de 9 gerações V6 (o dourado virou
  faixa de bordas paralelas; a manga esquerda saiu preta). Esta bancada testa
  até 3 variações da V6, cada uma mexendo numa alavanca só, e mede o resultado
  com o medidor automático (medidor-uniforme.js, que acerta as 9 de 5-out):

    controle   a V6 de produção, intocada (utils/geracaoFigurinha.js).
    v1-prompt  PROMPT: a frase do kit descreve a geometria como ela é — uma
               linha diagonal só, o acento à direita dela ALARGANDO até a barra,
               a manga da direita (de quem olha) inteira do acento, "não é
               faixa de bordas paralelas". A frase de produção ("painel do
               ombro esquerdo à barra direita") descreve, ao pé da letra, uma
               FAIXA — que é o defeito. Tudo o resto do prompt fica igual.
    v2-kit     ENTRADA: a imagem do kit recortada só na camisa (sem o calção,
               que tem uma listra diagonal fina) e quadrada, com a camisa
               ocupando o quadro. Prompt de produção.
    v3-ordem   ORDEM E PESO: o kit vai como Image 1 e a foto como Image 2 (o
               prompt troca as referências). Com input_fidelity alta o modelo
               guarda com mais detalhe a PRIMEIRA imagem — aqui ela é o kit.
               Risco conhecido: a cara pode perder; olhar as caras.

  Fotos: os 3 modelos fictícios da bancada da loja (Careca, Zé Gordo, Paredão)
  e a foto do dono, todos em LOJA/demo-avatares (nada sobe para o Storage: a
  entrada vai à fal como data URI). Nada é gravado no banco.

  DINHEIRO: o custo de cada chamada é o LIDO da fal (utils/falFila.js) e fica
  em LOJA/uniforme-bancada/custos.json, que soma entre corridas. Teto US$3,00
  para a bancada inteira: a corrida para ANTES de uma geração que passaria do
  teto. Teto por geração US$0,112 (o custo da V6, CLAUDE.md): a variação que
  passar dele numa geração é desqualificada e não gera mais.

  Uso (a partir de FUTTY-V2/backend):
    node scripts/_bench/testar-uniforme.js --var v1-prompt --kit dark-gold [--fotos dono,careca]
    node scripts/_bench/testar-uniforme.js --remedir      mede de novo tudo o que está no disco (grátis)
    node scripts/_bench/testar-uniforme.js --folha        monta folha.png
    node scripts/_bench/testar-uniforme.js --prompts      imprime os prompts das variações (grátis)
  ═══════════════════════════════════════════════════════════════════════════════
- (linha ~310, `const NOVE_5OUT = ['l1-careca', 'l2-ze-gordo-reprovado', 'l3-paredao-reprovado'…`) A régua do Dark Gold: as 9 V6 de produção de 5-out (o gabarito do medidor), na ordem em que nasceram.
- (linha ~341, `const yN = TIT;`) faixa de cima: as 9 de 5-out (V6 de produção, Dark Gold), medidas agora pelo mesmo medidor

## scripts/_bench/time-de-prova.js

- (linha ~1, `require('dotenv').config();`) ═══════════════════════════════════════════════════════════════════════════════
  TIME DESCARTÁVEL PARA A PROVA DO PACOTE (22-set, Figurinha 3 bloco 2).

  O percurso do pacote tem TRÊS pessoas: o dono pede a ativação, o super-admin
  ativa no Gabinete, e o membro é quem gera. A conta-de-prova.js faz uma conta
  só — esta faz as três e o time que as junta, e escreve as três sessões num
  JSON que o scripts/ver-iphone.mjs do frontend lê com --sessoes.

    node scripts/_bench/time-de-prova.js            cria/refaz e grava as sessões
    node scripts/_bench/time-de-prova.js --apagar   apaga time e contas

  O super-admin é uma conta @futtymock descartável com `is_super_admin` ligado,
  nunca a do Pedro: uma prova não entra na conta do dono.

  Sai em ../frontend/scripts/capturas/sessao-time.json (fora do git).
  ═══════════════════════════════════════════════════════════════════════════════

## scripts/_bench/time-rodada27.js

- (linha ~1, `require('dotenv').config({ quiet: true });`) ═══════════════════════════════════════════════════════════════════════════════
  TIME DESCARTÁVEL DA RODADA 27 — "check-up da foto de verdade" (25-set).

  A cena `rodada27` do scripts/ver-iphone.mjs (frontend) mede, em servidor LOCAL, o que
  o dono relatou pelo celular: "Trocar visual" que não troca, foto que demora a aparecer,
  enquadramento que muda de tela para tela e troca de tela lenta. Para isso precisa de:
    · uma conta COM foto (a foto de partida é uma imagem lisa, distinta da de prova);
    · uma conta SEM foto (vê o genérico da casa, escolhe outro);
    · um time onde as duas jogam, com Ranking (≥ 3 jogos), Presença e Sorteio de verdade
      — as telas onde a foto aparece pequena, em quadrado e em cartão 3:4.
  Nada disto gera figurinha (custo de IA zero). Tudo é @futtymock e descartável; o time
  é SÓ desta rodada (nunca a domingueira-fc-demo, que é a conta dos revisores das lojas).

    node scripts/_bench/time-rodada27.js            cria/refaz e grava as sessões
    node scripts/_bench/time-rodada27.js --apagar   apaga o time e as contas

  Sai em ../frontend/scripts/capturas/sessao-rodada27.json (fora do git).
  ═══════════════════════════════════════════════════════════════════════════════

## scripts/_bench/varredura-orfaos.js

- (linha ~1, `require('dotenv').config();`) Futty v2.0 — LIMPEZA TOTAL (23-set): varredura de órfãos pós-limpeza.

  apagarUsuario() já limpa o Storage de CADA usuário apagado (avatar/foto,
  slots, mídia da Resenha, varrimento por prefixo). O que sobra depois disso
  são objetos cujo DONO já não existe mas cujo CAMINHO não bate com nenhum
  prefixo de usuário conhecido (ficheiros antigos, de antes do nome-por-
  versão, ou de fluxos que nunca gravaram a URL numa linha da BD).

  Compara cada objeto do bucket contra as URLs REALMENTE referenciadas agora
  (users.avatar_url/foto_url, user_avatar_slots.avatar_url, teams.logo_url,
  champion_photos.url, feed_post_media.url, comentario_anexos.url) — o que
  sobra é órfão.

  denuncias: SÓ varre casos/<teamId>/* cujo teamId já não existe em `teams`.
  _diagnostico (relatórios por userId), _gabinete/operacao.json (campanhas de
  anúncio — têm de sobreviver), _plataforma e reporters/* ficam INTOCADOS de
  propósito: não são "donos" no sentido de apagarUsuario, e operacao.json é
  explicitamente uma das coisas que a limpeza NÃO pode tocar.

  Uso:
    node scripts/_bench/varredura-orfaos.js                → dry-run (só lista)
    node scripts/_bench/varredura-orfaos.js --apagar        → apaga de verdade

## scripts/backup-banco.js

- (linha ~21, `const TABELAS = [`) NB: campeonatos_v2/campeonato_times/campeonato_confrontos (migração 039,
  modelo de campeonato N-times) ficam DE FORA — testado ao vivo (10-set) e
  confirmado que ainda não existem (PGRST205), a v1 do campeonato guarda tudo
  como JSON no Storage. Junta-as aqui no dia em que a 039 for de facto
  aplicada.
  LIMPEZA TOTAL (23-set) — achado ao preparar o backup pré-limpeza: a lista
  abaixo é anterior à migração 054 (Figurinha Brilhante, 22-set) e nunca foi
  atualizada. pedidos_ativacao e brilhantes_time ficavam de fora em silêncio
  — exatamente o aviso que o comentário do topo do arquivo pede para evitar.
- (linha ~38, `'user_avatar_historico', 'convite_usos', 'telemetria_velocidade',`) Manutenção 26-set: ficaram para trás quando entraram (057/058/061).
- (linha ~40, `'compras',`) Pagamentos P1 (064).
- (linha ~42, `'avisos_lancamento',`) Rodada 29B (068): quem quer ser avisado do lançamento.
- (linha ~134, `try {`) Gabinete 2.0 (11-set): o semáforo "último backup" da aba Segurança lê daqui.
  Só grava quando a corrida foi 100% OK (return acima corta o caminho de falha).

## scripts/bench-jogador-identico.js

- (linha ~1, `const path = require('path');`) Futty — bancada da rodada "Fluidez 2" (16-set).

  Prova que GET /api/teams/:slug/jogador/:userId, depois de paralelizado, devolve
  BYTE A BYTE o mesmo corpo de antes. Mesma ideia da rodada "Velocidade 6A": a
  versão ANTIGA sai do git, a de AGORA sai do disco, as duas sobem no MESMO Express
  (em prefixos diferentes) e recebem o MESMO pedido, contra o banco de verdade.

    cd C:\Users\phfer\Desktop\FUT\FUTTY-V2\backend
    node scripts/bench-jogador-identico.js
    node scripts/bench-jogador-identico.js --ref=HEAD~1        (depois de commitar)
    node scripts/bench-jogador-identico.js --slug=... --viewer=email@x.com

  Antes de commitar, `--ref=HEAD` (o padrão) é a versão de antes, porque a de agora
  ainda está só na árvore de trabalho. Depois de commitar, aponte o ref para o
  commit anterior.

  A autenticação é a única coisa fingida: `requireAuth` passa a injetar o usuário
  pedido (as contas de teste têm senha aleatória, não dá para pedir um JWT). Tudo o
  resto é o caminho real — requireTeamMember, ranking, banco em São Paulo.

## scripts/calibrar-nsfw.js

- (linha ~1, `const path = require('path');`) CALIBRAÇÃO (experimental, fora das rotas) — Tijolo 2.
  Corre o filtro contra uma bateria LIMPA (fotos reais da casa + proxies sintéticos
  dos casos-limite do futebol amador). Mede porn/hentai/sexy e ajuda a fixar o
  limiar com margem. ZERO download de conteúdo explícito.
    node scripts/calibrar-nsfw.js
- (linha ~13, `const FOTOS_PRIVADAS = path.join(__dirname, '..', '..', '..', 'FOTOS-PRIVADAS');`) SEGURANCA-REVISAO-10SET.md secção 2/3 (10-set): fotos-jogos saiu de public/
  (não era mais servida sem login) e vive agora fora dos repos.

## scripts/conferir-migracoes.js

- (linha ~2, `require('dotenv').config();`) Futty v2.0 — Confere db/migrations/*.sql contra o ESTADO REAL do banco (build 9,
  achado real: PATCH /api/me deu 500 "violates check constraint
  users_fundo_figurinha_check" porque a migração 043 nunca correu — resolve
  também o item pendente da migração 039, "nunca correu no banco").

  Como funciona: não há ligação directa ao Postgres nesta máquina (só a API
  REST do Supabase, via service_role — ver utils/db.js), por isso não se lê o
  catálogo do banco directamente. Em vez disso, cada migração é lida e
  extraem-se os alvos que ela declara criar (CREATE TABLE, ADD COLUMN); para
  cada alvo, faz-se uma SONDA — um SELECT de 1 linha nessa tabela/coluna — e
  o CÓDIGO DE ERRO do PostgREST diz se existe:
    42703      = coluna não existe
    PGRST205   = tabela não existe
  CHECK CONSTRAINTS (ex.: 043) não têm sonda segura sem escrever dados de
  teste — ficam listadas à parte, para conferência manual.

  Uso: node scripts/conferir-migracoes.js  (ou: npm run conferir-migracoes)

## scripts/criar-campanha-previa.js

- (linha ~1, `require('dotenv').config({ quiet: true });`) Futty v2.0 — Campanha de PRÉVIA da publicidade, para o Pedro ver como fica o
  espaço de anúncio em cada tela antes de qualquer acordo comercial. Gera uma
  imagem-placeholder (fundo vermelho sólido, "PUBLICIDADE 320×100" em branco —
  propositalmente chamativa, ninguém confunde com um anúncio real), sobe para o
  Storage e liga a campanha nas páginas de PAGINAS.

  Rodada 12B (16-set): nasceu só para o slot IAB 320×100 da página do sorteio.
  Rodada 12C (16-set): passa a ligar nas CINCO telas com espaço de publicidade —
  o dono quis ver o formato em todas. A vista pública /p/ fica de fora de
  propósito (é a tela de quem não tem conta; anúncio ali é outra decisão).

  A MESMA arte serve os dois formatos: o slot 320×100 (proporção 3.2, igual à
  da arte) e o nativo de altura 100 (proporção ~3.9). Num `object-fit: cover` a
  arte mais "quadrada" numa caixa mais larga é escalada pela LARGURA e cortada
  em cima/embaixo — as laterais ficam inteiras, e o texto centrado sobrevive.

  Idempotente: id fixo (CAMPANHA_ID) — rodar de novo ATUALIZA a mesma
  campanha (nova imagem, mesmos dados) em vez de duplicar.

  Uso: node scripts/criar-campanha-previa.js

  Para DESLIGAR depois (o Pedro, pelo Gabinete → Anúncios):
    - apagar a campanha "Prévia do espaço de publicidade" da lista, OU
    - desligar o toggle de uma página (some só dessa tela), OU
    - desligar o interruptor geral (corta a publicidade em todas), OU
    - mudar o estado da campanha para algo diferente de 'ativa'.
- (linha ~38, `const PAGINAS = ['inicio', 'resenha', 'ranking', 'figurinha', 'sorteio'];`) As telas com espaço de publicidade (Rodada 12C). Os toggles do Gabinete
  mandam por cima disto: uma página aqui com o toggle desligado não mostra nada.

## scripts/dar-credito.js

- (linha ~1, `require('dotenv').config();`) ═══════════════════════════════════════════════════════════════════════════════
  DAR CRÉDITOS DE FIGURINHA BRILHANTE À MÃO (SPEC-FIGURINHA-3, 22-set).

  O Gabinete "Brilhantes" é o bloco 2. Até lá, é por aqui que se ativa alguém:
  a conta demo das lojas (2 créditos, para o revisor ver o produto completo),
  um pedido que chegou em `pedidos_ativacao`, ou a própria bancada.

    node scripts/dar-credito.js demo-loja@futtymock.com          +10 créditos
    node scripts/dar-credito.js demo-loja@futtymock.com 2        +2 créditos
    node scripts/dar-credito.js --ver demo-loja@futtymock.com    só mostra
    node scripts/dar-credito.js --time <slug> --kit dark-gold    ativa o pacote

  Precisa da migração 054 aplicada — sem ela avisa e sai sem escrever nada.
  ═══════════════════════════════════════════════════════════════════════════════
- (linha ~75, `const quantos = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) || 10…`) Rodada 21 (24-set): padrão subiu de 1 para 10 — o mesmo que "Minha Figurinha" dá.

## scripts/demo-completa.js

- (linha ~1, `const path = require('path');`) Futty — DEMO COMPLETA para o dono testar no celular (15-set).

    node scripts/demo-completa.js                   cria tudo (idempotente: 2ª vez não duplica)
    node scripts/demo-completa.js --limpar          desfaz TUDO o que este script criou
    node scripts/demo-completa.js --email=x@y.com   adiciona mais um admin além dos dois do dono
    node scripts/demo-completa.js --ensaio          só mostra os elencos/sorteios, não grava nada
    node scripts/demo-completa.js --so-jogo-extra   só o 2º jogo futuro (Rodada 8B), sobre uma
                                                     demo já criada; idempotente (não duplica)

  Correr a partir de backend/ (utils/db.js lê o .env do diretório atual).

  O QUE É "DELE" (e portanto o que o --limpar pode tocar):
    · contas com prefixo `demo-vila-` em @futtymock.com;
    · times com os slugs listados em SLUGS (todos terminam em `-demo-vila`);
    · no Storage: campeonatos e denúncias desses times, fotos da Resenha desses posts;
    · bloqueios e pedidos de entrada em que o alvo é uma conta `demo-vila-`.
  NADA MAIS. A conta demo-loja@futtymock.com e o time domingueira-fc-demo (conta do
  revisor das lojas, ver ONDE-ESTAMOS.md) ficam INTOCADOS — o --limpar nunca os vê,
  porque nenhum marcador acima bate com eles.
- (linha ~332, `categoria: j.gr ? 'GR' : 'linha', posicao: j.gr ? 'GL' : null, pode_postar: tru…`) Rodada 9: em team_members só existe goleiro ('GL') ou linha (null). O
  `pos` do elenco fictício continua a valer para distribuir os gols
  (distribuirGols), que é outra coisa — não vai para o banco.
- (linha ~555, `const LOCAL_JOGO_EXTRA = 'Quadra do Guará';`) Segundo jogo futuro (Rodada 8B, 15-set): outro dia, outro formato — para o
  Início mostrar DOIS jogos ao mesmo tempo (pedido do dono). 5x5, capacidade
  menor (14), RSVP aberto com prazo mais folgado (5 dias).

  FLUIDEZ 2 (16-set): este nasce com o SORTEIO FEITO — o Início mostra-o como
  "sorteado" e a escalação abre ao toque. O de Alvalade fica por sortear, é o que
  o dono sorteia ao vivo.

  11 confirmados (10 jogadores + o dono), não 9: com 9 pessoas em times de 5 o
  executarSorteio devolve 1 time só — e nesse caso devolve `times: []`, que
  gravado com sorteio_realizado = true daria um jogo "sorteado" com escalação
  vazia. Subir os confirmados (em vez de baixar para 4 por time) mantém o 5x5 da
  quadra, cabe nos 14 lugares, dá um goleiro por time e ainda deixa 1 no banco —
  é o único sítio da demo onde se vê a lista de reservas.

## scripts/demo-loja.js

- (linha ~1, `const path = require('path');`) Futty — Dados de demonstração para o material da Google Play (13-set).

    node scripts/demo-loja.js              cria tudo (aborta se já existir)
    node scripts/demo-loja.js --sortear    sorteia o próximo jogo (algoritmo real)
    node scripts/demo-loja.js --reagendar  põe o próximo jogo num domingo à frente e desfaz o
                                           sorteio; não apaga nem cria nada (é o que refaz as capturas)
    node scripts/demo-loja.js --limpar     apaga tudo o que o script criou (INCLUI a conta demo-loja@,
                                           que é a do revisor das lojas: só com o Pedro pedindo)
    opções: --sem-figurinha (não chama a API de IA)

  Correr a partir de backend/ (utils/db.js lê o .env do diretório atual).
  Todas as contas são @futtymock.com com prefixo "demo-loja": é assim que o
  --limpar as encontra. Só a senha do Bruninho é gravada, em LOJA/demo-senha.txt.
- (linha ~136, `const { data } = await supabase.from('teams').select('id').eq('slug', SLUG_TIME…`) LIMPEZA TOTAL (23-set) — o sinal certo passou a ser o TIME, não a conta
  do Bruninho: desde a decisão do dono de manter demo-loja@futtymock.com
  como conta MANTER de scripts/limpar-usuarios-teste.js, ela sobrevive a
  uma limpeza (--times-tambem) que zera o time dela mas não a conta. "Já
  existe" agora quer dizer "o demo já está montado", não "a conta existe"
  — ver criarUsuarios() abaixo, que reaproveita a conta em vez de abortar.
- (linha ~535, `async function reagendar() {`) Devolve a vitrine ao estado da loja, sem criar nem apagar nada: o próximo jogo
  num domingo à frente e sem sorteio, e as contas fictícias com a silhueta do bucket
  kits em avatar_url. Sem essa silhueta o sorteio e o ranking mostram o boneco
  cinza com "?" no lugar do jogador de camisa preta e dourada: aconteceu em 25-set,
  quando um reparo de avatar_url "de fora do bucket avatars" (a foto do Google, Hotfix
  26) também levou o bucket kits.

## scripts/limpar-orfaos.js

- (linha ~2, `require('dotenv').config({ quiet: true });`) Futty v2.0 — Arquivos órfãos do bucket `avatars` (Rodada 28, bloco G).

  Lista (por padrão só LISTA — nada é apagado) os arquivos do bucket `avatars` que nenhuma linha do
  banco usa: fotos e originais substituídas cuja faxina não terminou (a limpeza roda depois da resposta,
  e o Cloud Run sem "CPU sempre alocada" pode deixá-la pela metade), temporários da geração (tmp/),
  logos antigos. A regra de quem é órfão vive em utils/orfaos.js (nada com menos de 1 dia; tmp/ depois
  de 1 hora; sem data, não mexe).

  ⚠️ Fala com o Supabase DE VERDADE (o do .env). Rodar só quando o Pedro pedir.

  Uso (na pasta backend):
    node scripts/limpar-orfaos.js                    lista (dry-run), por pasta, com os 20 maiores
    node scripts/limpar-orfaos.js --pasta tmp        só uma pasta (public, tmp, logos…)
    node scripts/limpar-orfaos.js --apagar           apaga os órfãos listados (em lotes de 100)

## scripts/limpar-usuarios-teste.js

- (linha ~43, `const MANTER_EMAILS = ['contatofuttyapp@gmail.com', 'demo-loja@futtymock.com'].…`) LIMPEZA TOTAL (23-set, decisão do dono): a lista mudou — phferreiraborgesbackup@
  (a conta de teste do próprio dono) sai e demo-loja@futtymock.com (o revisor
  das lojas) entra. Registro histórico: antes disto a dupla era
  phferreiraborgesbackup@gmail.com + contatofuttyapp@gmail.com.
- (linha ~68, `async function apagarEmLotes(tabela, coluna, ids) {`) DELETE em lotes de `coluna IN ids`. Devolve o nº de linhas apagadas — via
  .select(coluna) no delete (RETURNING), não .select('id'): nem toda tabela
  tem uma coluna `id` (achado 14-set: user_avatar_slots não tem — RETURNING
  id nessa tabela falha a query inteira, incluindo o DELETE. `coluna` é
  sempre segura porque é a mesma que acabámos de filtrar com .in()).
- (linha ~227, `const p = bucketEcaminho(url);`) bucketEcaminho (não parseUrlPublico): feed_post_media/comentario_anexos
  guardam a URL do PROXY desde o Tijolo 2, não a crua do Storage — mesmo
  achado do item 3 da Rodada 15 (ver utils/apagarUsuario.js).

## scripts/postar-historico-resenha.js

- (linha ~1, `require('dotenv').config();`) Futty v2.0 — HISTÓRICO DA MISSA DE QUINTA NA RESENHA (23-set).

  Publica, com data retroativa, as fotos de "TIME CAMPEÃO" (uma por dia de
  jogo) como posts da Resenha do time "Missa de Quinta". Mesma compressão do
  upload normal (routes/feed.js: sharp 1600px, WebP q80), mesmo bucket
  (resenha), mesma cota (migração 053). Sem IA, custo US$0.

  IDEMPOTENTE: a legenda de cada post ("🏆 Time campeão · DD/MM/AAAA", ou a
  do 1º campeonato) é a marca — reexecutar pula quem já foi publicado.

  Uso (a partir de backend/):
    node scripts/postar-historico-resenha.js                 simulação (não grava nada)
    node scripts/postar-historico-resenha.js --confirmo       publica de verdade
- (linha ~26, `const COMPRESSAO_LADO_MAX = 1600;`) Mesma receita de routes/feed.js (Rodada 15) — não duplicar a constante, copiar o valor.

## scripts/radar-teste.js

- (linha ~183, `function elencoDe(time) {`) O elenco do time: o primeiro é o admin, os outros members; 1 ou 2 goleiros (categoria GR). Nascimento de adulto
  (1981–2004, lei de 1-out: 18+) e avatar genérico variado, tudo determinístico por slug.

## scripts/seed-resenha.js

- (linha ~86, `const JOGOS = [`) 3) Config dos 3 jogos. (Motta não existe → fallback Kimzera; Dudu = Eduardo.)
  AVISO (SEGURANCA-REVISAO-10SET.md secção 2/3, 10-set): as *_foto_url abaixo
  apontam para /public/fotos-jogos/..., que deixou de ser servido pelo
  backend (a pasta saiu de public/ e mudou para
  C:\Users\phfer\Desktop\FUT\FOTOS-PRIVADAS, fora dos repos — fotos reais de
  pessoas não ficam mais públicas sem login). Rodar este script agora insere
  URLs que dão 404. Antes de rodar de novo: trocar por URLs reais do
  Storage do Supabase ou deixar null.

## scripts/semear-acessos.js

- (linha ~2, `const fs = require('fs');`) Futty v2.0 — Semeia a tabela "Acessos & contas" do Gabinete a partir do CONTAS.md (Pagamentos P2, 26-set).

  O CONTAS.md (raiz do FUT, da Freaky) é onde cada conta da operação mora — SEM senhas. O Gabinete
  (aba Registros → "Acessos & contas") é o espelho no app. Este script leva do arquivo para lá só o que
  é caminho, nunca segredo: serviço, para quê, site, entra com e o custo €/mês. A coluna 2FA fica no
  arquivo. Tudo passa pela mesma trava do Gabinete (gabineteStore.gravar → validarAcessos): se algo
  parecer senha ou chave, a gravação inteira é recusada.

  Grava no Storage de verdade (o mesmo do app): quem roda é o Pedro, de propósito.

    node scripts/semear-acessos.js                 simula: lê o CONTAS.md e o Gabinete e diz o que faria
    node scripts/semear-acessos.js --gravar        grava — só se a tabela estiver VAZIA
    node scripts/semear-acessos.js --gravar --completar
                                                   com a tabela já cheia: acrescenta os serviços que
                                                   faltam e preenche só os campos VAZIOS (nunca troca
                                                   o que já está lá — o dono pode ter editado à mão)
    --arquivo <caminho>                            outro CONTAS.md (padrão: FUT\CONTAS.md)
    --sem-banco                                    só lê o CONTAS.md e mostra as linhas (não toca em nada)

## scripts/spike-nsfw.js

- (linha ~16, `const FOTOS_PRIVADAS = path.join(__dirname, '..', '..', '..', 'FOTOS-PRIVADAS');`) SEGURANCA-REVISAO-10SET.md secção 2/3 (10-set): fotos-jogos saiu de public/
  (não era mais servida sem login) e vive agora fora dos repos.

## scripts/subir-logo-time.js

- (linha ~1, `require('dotenv').config();`) Futty v2.0 — sobe o escudo de um time pelo mesmo caminho do painel de admin
  (POST /api/teams/:slug/logo, routes/teams.js): bucket "avatars", path
  logos/<teamId>.<ext>, teams.logo_url, ?v= para invalidar cache.

  Diferença de propósito (não de mecânica): o painel guarda o arquivo como o
  admin manda (PNG/JPG/WEBP, sem redimensionar); aqui a imagem entra pela
  regra geral do app (CLAUDE.md, "App leve"): WebP no dobro do tamanho de
  exibição. Maior uso do logo hoje é TeamAvatar "lg" = 64px → 128px.
  Sem filtro NSFW: upload direto do dono, sem fila de moderação.

  Generalizado (28-set, TIME-TESTE.md parte A) para servir qualquer time:
    node scripts/subir-logo-time.js                                sem args, comportamento de sempre (Missa de Quinta)
    node scripts/subir-logo-time.js --slug <slug> --arquivo <caminho>   sobe o logo de outro time
  A função `subirLogoTime` é exportada para outros scripts (time-teste.js)
  reutilizarem sem duplicar a lógica.

## scripts/time-teste.js

- (linha ~99, `const FIGURINHAS = [`) Figurinhas SEM IA (custo zero): PNGs já pagos noutra rodada, publicados no
  molde de _bench/repor-estado-demo.js --figurinha-de. Pessoas inventadas
  pela IA a partir da silhueta genérica — nenhuma é real.
- (linha ~108, `const CONFIRMADOS_PASSADOS = [`) Rotação dos 6 jogos passados: quem confirmou em cada um (12-14 por jogo,
  todo mundo chega a ≥3 — o ranking exige 3). Ver relatório da rodada para a
  conta: 5 "titulares" (cabeça-de-chave/figurinha) em todos os 6; os 3
  goleiros revezam 2 de cada vez (sempre 2 presentes); os outros 12 entram
  em janelas de 3 jogos seguidos (sempre exatamente 3 presenças).

## scripts/verificar-060.js

- (linha ~2, `require('dotenv').config({ quiet: true });`) Futty v2.0 — A migração 060 (a foto do Google não é figurinha, Hotfix 26) já foi aplicada?

  Não há ligação direta ao Postgres nesta máquina (só a API REST do Supabase), então o
  que se confere é o COMPORTAMENTO, e não o catálogo:
    1. o trigger handle_new_user: cria UMA conta descartável com a foto do Google no
       metadata e olha o que o trigger gravou em public.users.avatar_url. NULL = a 060 já
       foi aplicada; a URL do Google = o trigger antigo ainda copia. A conta é apagada.
    2. o reparo: quantas contas têm avatar_url fora dos nossos buckets (avatars, kits) nem
       são avatares migrados da V1. Depois da 060 deve ser 0.
  O motor funciona igual com ou sem a 060 (utils/figurinhaRegra.js); ela limpa a causa.

  Uso: node scripts/verificar-060.js   (a partir de backend/; sai com 0 se tudo em ordem)
