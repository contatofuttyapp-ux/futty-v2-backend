// Futty v2.0 — Backend (Express + Supabase)
// Setup do servidor: middleware, ficheiros estáticos, rotas e tratamento de erros.
require('dotenv').config();

// SEGURANCA-REVISAO-10SET.md secção 3 (10-set): o token do proxy de imagem
// (utils/mediaToken.js) caía para a SUPABASE_SERVICE_KEY como segredo de
// assinatura quando MEDIA_TOKEN_SECRET faltava — reaproveitar um segredo que
// já abre o banco inteiro para outra coisa. Falha alto e cedo em produção em
// vez de arrancar silenciosamente inseguro.
if (process.env.NODE_ENV === 'production' && !process.env.MEDIA_TOKEN_SECRET) {
  throw new Error(
    '[Futty] MEDIA_TOKEN_SECRET em falta. Gera 32 bytes aleatórios ' +
    '(ex.: `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"` ' +
    'ou `openssl rand -hex 32`) e define a variável no Render antes de arrancar em produção.'
  );
}

// Error tracking — inicializar logo após o dotenv (DSN/NODE_ENV já carregados) e
// antes dos restantes requires, para o Sentry instrumentar http/express. Só
// ativo em produção (SENTRY_DSN definido).
const Sentry = require('@sentry/node');
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  enabled: process.env.NODE_ENV === 'production',
  tracesSampleRate: 0.1,
});

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const { supabase, ensureAvatarsBucket } = require('./utils/db');
const { ensureCampeonatosBucket } = require('./utils/campeonatoStore');
const { carregarModelo } = require('./utils/nsfwFilter');
const { mediaUrls } = require('./middleware/mediaUrls');
const { tempoPorRota } = require('./middleware/tempo');
const { privatizarBuckets } = require('./utils/storage');
const adsStore = require('./utils/adsStore');
const plataformaStore = require('./utils/plataformaStore');
const gabineteStore = require('./utils/gabineteStore');
const { HttpError } = require('./utils/http');

const authRoutes = require('./routes/auth');
const teamsRoutes = require('./routes/teams');
const gamesRoutes = require('./routes/games');
const rankingRoutes = require('./routes/ranking');
const avataresRoutes = require('./routes/avatares');
const feedRoutes = require('./routes/feed');
const pushRoutes = require('./routes/push');
const rsvpRoutes = require('./routes/rsvp');
const campeonatoRoutes = require('./routes/campeonato');
const campeonatosRoutes = require('./routes/campeonatos');
const superadminRoutes = require('./routes/superadmin');
const gabineteRoutes = require('./routes/gabinete');
const adsRoutes = require('./routes/ads');
const mediaProxyRoutes = require('./routes/media');
const denunciasRoutes = require('./routes/denuncias');
const { ensureDenunciasBucket } = require('./utils/denunciaStore');
const blocksRoutes = require('./routes/blocks');
const inicioRoutes = require('./routes/inicio');
const diagnosticoRoutes = require('./routes/diagnostico');

const app = express();

// Origens permitidas: localhost (dev), qualquer URL do Codespaces (.app.github.dev)
// e origens de produção definidas em CORS_ORIGINS (separadas por vírgula).
const envOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  /\.app\.github\.dev$/, // Codespaces
  // VELOCIDADE 4 — as origens do app nativo são NOSSAS e fixas (Capacitor: iOS
  // serve em capacitor://localhost, Android em https://localhost). Estavam a
  // depender de alguém lembrar-se de as pôr em CORS_ORIGINS; uma variável mal
  // preenchida no Cloud Run tirava o app do ar inteiro. Ficam aqui, no código.
  'capacitor://localhost',
  'https://localhost',
  ...envOrigins,
];
// VAGA DO CELULAR (dev-rede): fora de produção, aceita qualquer origem da rede
// local (192.168.x.x / 10.x.x.x / 172.16-31.x.x), porta 5173 — o telefone do
// dono na mesma wifi acede via http://<IP-da-máquina>:5173. Nunca em produção
// (NODE_ENV==='production' desliga isto; CORS_ORIGINS continua a via oficial lá).
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push(/^http:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)[\d.]+:5173$/);
}
const corsOptions = {
  origin(origin, callback) {
    // Pedidos sem Origin (curl, server-to-server) → permitir.
    if (!origin) return callback(null, true);
    const permitido = allowedOrigins.some((o) => (o instanceof RegExp ? o.test(origin) : o === origin));
    return callback(null, permitido);
  },
  // Server-Timing (13-set, "Velocidade 3", middleware/tempo.js): por omissão
  // o browser só lê headers "seguros" de um pedido cross-origin — sem isto o
  // header ia na resposta mas o DevTools/fetch do frontend não o enxergava.
  // X-Futty-Cache (15-set, "Velocidade 6A"): diz se a imagem veio do LRU do
  // proxy (hit) ou do Storage (miss) — é como se mede, do lado de cá, se o
  // cache está a trabalhar.
  exposedHeaders: ['Server-Timing', 'X-Futty-Cache'],
  // VELOCIDADE 4 (o app nativo "surreal de devagar" em Lisboa): sem maxAge o
  // browser/WebView repete o preflight a CADA pedido. De Lisboa para São Paulo
  // isso é ~250 ms de ida e volta desperdiçados antes de cada chamada — numa
  // tela com 3 pedidos, quase um segundo só a pedir licença. 86400 = 24 h, o
  // tecto que o Chromium aceita (o Safari corta em 600 s, e tudo bem: 10 min
  // já cobre uma sessão inteira). O preflight passa a acontecer uma vez.
  maxAge: 86400,
  // 204 em vez do 200 default: resposta sem corpo é o que o preflight é.
  optionsSuccessStatus: 204,
};

// PRIMEIRO middleware da casa, de propósito. O cors() responde ao OPTIONS e
// termina ali (preflightContinue fica false), portanto o preflight nunca chega
// ao helmet, ao rate limiter, ao parser de JSON, ao tempoPorRota nem a
// autenticação nenhuma — nada disso tem o que fazer num pedido que só pergunta
// "posso?". O limiter abaixo ainda ignora OPTIONS explicitamente, para o dia em
// que alguém mexer nesta ordem.
app.use(cors(corsOptions));

// Headers de segurança HTTP. crossOriginResourcePolicy em 'cross-origin' porque
// este backend serve imagens (avatares, fotos) consumidas pelo frontend noutra
// origem — o default 'same-origin' do helmet bloquearia esse carregamento.
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// VELOCIDADE 6A (15-set): não havia compressão nenhuma. O /api/feed e o
// /api/inicio são JSON com muito texto repetido — é onde o gzip ganha mais, e
// de Lisboa cada KB poupado conta. `threshold: 1024` deixa passar as respostas
// pequenas (comprimir 200 bytes custa mais CPU do que poupa rede).
// O /api/media não é afetado: o `compression` salta o que já vem comprimido
// (image/webp, image/gif), por isso as imagens seguem sem passar por aqui.
app.use(compression({ threshold: 1024 }));

// Atrás de 1 reverse proxy (Codespaces/produção): confia no X-Forwarded-For
// para que o rate limiter conte por IP real do cliente, e não pelo IP do proxy.
app.set('trust proxy', 1);

// Rate limiting geral: protege todas as rotas /api de abuso.
// DEV (31-jul): fora de produção o tecto sobe para 2000 — numa tarde de teste o
// dono + o Claude + o hot-reload estouravam os 200 e o app "morria" por 15 min.
// Em produção (NODE_ENV=production) os 200 continuam valendo.
// VELOCIDADE 4: a web passou a falar com o motor através de uma função na
// Cloudflare (frontend/functions/api/[[path]].js), para acabar com o preflight.
// O efeito colateral é que, visto daqui, TODOS esses pedidos chegam do mesmo IP
// — o do edge. Um tecto por IP juntaria pessoas diferentes no mesmo balde e
// bastavam quatro a navegar ao mesmo tempo para o app "cair" 15 minutos para
// toda a gente. O edge reencaminha o IP real em CF-Connecting-IP; quando esse
// header vem, é ele que conta.
// O empate, de olhos abertos: quem bata direto no Cloud Run pode forjar o
// header e trocar de balde. O tecto por IP é a rede grossa (anti-tráfego
// anónimo); a rede fina é por utilizador (middleware/limiters.js) e essa não se
// forja sem a sessão de alguém.
function chaveDoPedido(req) {
  const doEdge = req.get('cf-connecting-ip');
  return ipKeyGenerator(doEdge || req.ip);
}

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: process.env.NODE_ENV === 'production' ? 200 : 2000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: chaveDoPedido,
  message: { error: 'Demasiados pedidos. Tenta mais tarde.' },
  // SEGURANCA-REVISAO-10SET.md secção 3 (10-set): /api/media/:token é o proxy
  // de imagem — um feed com muitas fotos faz várias chamadas de uma vez e
  // esgotava os 200/15min do limiter geral por IP. Tem o próprio limiter,
  // mais largo (routes/media.js), então sai da conta daqui para não somar dois
  // tectos apertados. NB: dentro de app.use('/api', ...) o Express já tira o
  // prefixo /api de req.path (confirmado com um teste rápido), por isso o
  // check é /media, não /api/media.
  // VELOCIDADE 4: o preflight já morre no cors() lá em cima, mas contá-lo aqui
  // seria contar duas vezes cada chamada (OPTIONS + o pedido real) e cortar o
  // tecto a meio. Ignorar OPTIONS é a rede de segurança para o dia em que
  // alguém trocar a ordem dos middleware.
  skip: (req) => req.method === 'OPTIONS' || req.path.startsWith('/media'),
});
app.use('/api', apiLimiter);

// Rate limiting restrito para endpoints caros/abusáveis. NB: não há rotas de
// login/registo no backend (a auth é feita no frontend via Supabase Auth), por
// isso o limite estrito aplica-se à geração de avatar IA (custa $ no fal.ai) e
// ao upload de avatar.
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas tentativas. Tenta em 15 minutos.' },
});
app.use('/api/me/avatar', strictLimiter); // cobre também /api/me/avatar/ai

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));
app.use(tempoPorRota);

// Ficheiros estáticos (fotos de campeão, etc.) em /uploads
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// Avatares migrados da V1 (avatar_url relativo, ex.: /public/avatares/verde/gui.png)
app.use('/public/avatares', express.static(path.join(__dirname, 'public', 'avatares')));

// SEGURANCA-REVISAO-10SET.md secção 2/3 (10-set): removido o mount genérico
// `app.use('/public', express.static(...))` que servia a pasta public/ inteira
// sem login — era isso que expunha fotos-teste/fotos-teste-4/fotos-treino/
// fotos-jogos (fotos reais de pessoas, algumas de menores) a qualquer um com
// o URL. Removido também `/public/logos`: os logos de equipa já vão para o
// Storage privado do Supabase (routes/teams.js, POST /:slug/logo), a pasta
// public/logos nunca chegou a existir em disco. Só sobem os dois mounts
// acima — avatares (V1 migrada) e uploads (fotos de campeão) — que é tudo o
// que o frontend de facto usa da pasta public/.

// Health check — confirma o servidor e a ligação ao Supabase.
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    service: 'futty-backend',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    supabase: 'unknown',
  };
  try {
    const { error } = await supabase.from('users').select('id', { count: 'exact', head: true });
    health.supabase = error ? 'error' : 'connected';
    if (error) health.supabaseError = error.message;
  } catch (err) {
    health.supabase = 'error';
    health.supabaseError = err.message;
  }
  res.json(health);
});

// Health check mínimo sob /api — o diagnóstico de rede (vaga do celular) bate
// aqui primeiro; vale a pena existir sem depender do Supabase.
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Raiz
app.get('/', (req, res) => {
  res.json({ name: 'Futty v2.0 API', status: 'running' });
});

// Tijolo 1C — assina/despublica URLs de média (buckets privados) na fronteira,
// ANTES das rotas (embrulha res.json). Autenticadas → assinado; /api/p/ → silhueta.
app.use(mediaUrls);

// Rotas da API
app.use(authRoutes);
app.use(teamsRoutes);
app.use(gamesRoutes);
app.use(rankingRoutes);
app.use(avataresRoutes);
app.use(feedRoutes);
app.use('/api/push', pushRoutes);
app.use(rsvpRoutes);
app.use(campeonatoRoutes);
app.use(campeonatosRoutes);
app.use(superadminRoutes);
app.use(gabineteRoutes); // /api/super/gabinete — Gabinete do Dono (super-admin)
app.use(adsRoutes); // /api/ads — serving + medição de publicidade
app.use(mediaProxyRoutes); // GET /api/media/:token — proxy de imagem (Tijolo 2)
app.use(denunciasRoutes); // Denúncias + triagem IA (Tijolo 3)
app.use(blocksRoutes); // /api/blocks — bloqueio entre jogadores (Apple UGC 1.2)
app.use(inicioRoutes); // GET /api/inicio — agregado da tela Início (1 pedido só)
app.use(diagnosticoRoutes); // /api/diagnostico — caixa-preta do app (VELOCIDADE 4)

// 404 para rotas /api não encontradas
app.use((req, res) => {
  res.status(404).json({ error: 'Recurso não encontrado.' });
});

// Sentry: captura os erros propagados (por defeito só status >= 500) ANTES do
// handler central. API do @sentry/node v8+ (substitui Sentry.Handlers do v7).
Sentry.setupExpressErrorHandler(app);

// Error handler central — converte HttpError no status certo; resto é 500.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error('[Futty] Erro:', err.message);
  const corpo = { error: err.message || 'Erro interno.' };
  if (err instanceof HttpError && err.code) corpo.code = err.code;
  res.status(status).json(corpo);
});

// SEGURANCA-REVISAO-10SET.md secção 3 (10-set): só arranca sozinho quando
// corrido diretamente (`node server.js`, produção/dev normal) — não quando
// outro módulo faz require('./server') (backend/tests/permissoes.test.js,
// que sobe o app na sua própria porta livre via app.listen(0)). Sem isto os
// testes colidiam com um dev server já a correr em 3001 (EADDRINUSE).
if (require.main === module) {
  const port = process.env.PORT || 3001;
  const servidor = app.listen(port, () => {
    console.log(`[Futty] Servidor a correr em http://localhost:${port}`);
    console.log(`[Futty] Health check: http://localhost:${port}/health`);
    // VELOCIDADE 7A (15-set): aquece os caches que a primeira pessoa depois de um
    // deploy (ou de uma instância nova do Cloud Run) pagaria dentro do tempo dela —
    // as suspensões, lidas por TODO pedido autenticado, e o gabinete, lido pelo
    // /api/inicio e pelo /api/ads: dois downloads do Storage. Quem chegar com isto
    // ainda em curso espera o MESMO download, nunca um segundo. A chave VAPID não
    // precisa: routes/push.js já a lê do ambiente quando o módulo carrega.
    const inicioAquecimento = Date.now();
    Promise.all([plataformaStore.ler(), gabineteStore.ler()])
      .then(() => console.log(`[Futty] Caches aquecidos (suspensões, gabinete) em ${Date.now() - inicioAquecimento} ms`))
      .catch((e) => console.error('[Futty] aquecimento dos caches:', e.message));
    // Garante o bucket de avatares (idempotente; não bloqueia o arranque).
    ensureAvatarsBucket().catch((e) => console.error('[Futty] ensureAvatarsBucket:', e.message));
    ensureCampeonatosBucket().catch((e) => console.error('[Futty] ensureCampeonatosBucket:', e.message));
    ensureDenunciasBucket().catch((e) => console.error('[Futty] ensureDenunciasBucket:', e.message));
    // Tijolo 1: pré-carrega o modelo NSFW uma vez (não bloqueia; falha aberta).
    carregarModelo();
    // Tijolo 1C: garante os buckets de avatares/resenha privados (idempotente).
    privatizarBuckets().catch((e) => console.error('[Futty] privatizarBuckets:', e.message));
  });

  // VELOCIDADE 6A (15-set): as impressões de publicidade ficam num acumulador em
  // memória e só descem ao Storage de 30 em 30 s. O Cloud Run manda SIGTERM antes
  // de apagar a instância — é a última oportunidade de gravar o que está pendente.
  const encerrar = async (sinal) => {
    console.log(`[Futty] ${sinal} recebido — a gravar o que está pendente.`);
    try { await adsStore.descarregar(); } catch (e) { console.error('[Futty] flush de ads:', e.message); }
    servidor.close(() => process.exit(0));
    // Se alguma ligação ficar presa, não esperar para sempre.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => encerrar('SIGTERM'));
  process.on('SIGINT', () => encerrar('SIGINT'));
}

module.exports = { app, supabase };
