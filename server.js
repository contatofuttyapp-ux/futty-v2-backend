// Futty v2.0 — Backend (Express + Supabase)
// Setup do servidor: middleware, ficheiros estáticos, rotas e tratamento de erros.
require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

const { supabase } = require('./utils/db');
const { HttpError } = require('./utils/http');

const authRoutes = require('./routes/auth');
const teamsRoutes = require('./routes/teams');
const gamesRoutes = require('./routes/games');
const rankingRoutes = require('./routes/ranking');
const avataresRoutes = require('./routes/avatares');
const feedRoutes = require('./routes/feed');
const pushRoutes = require('./routes/push');

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
  ...envOrigins,
];
const corsOptions = {
  origin(origin, callback) {
    // Pedidos sem Origin (curl, server-to-server) → permitir.
    if (!origin) return callback(null, true);
    const permitido = allowedOrigins.some((o) => (o instanceof RegExp ? o.test(origin) : o === origin));
    return callback(null, permitido);
  },
};
app.use(cors(corsOptions));
app.use(express.json());

// Ficheiros estáticos (fotos de campeão, etc.) em /uploads
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// Avatares migrados da V1 (avatar_url relativo, ex.: /public/avatares/verde/gui.png)
app.use('/public/avatares', express.static(path.join(__dirname, 'public', 'avatares')));

// Conteúdo público geral (fotos de jogos/campeão, etc.): /public/fotos-jogos/...
app.use('/public', express.static(path.join(__dirname, 'public')));

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

// Raiz
app.get('/', (req, res) => {
  res.json({ name: 'Futty v2.0 API', status: 'running' });
});

// Rotas da API
app.use(authRoutes);
app.use(teamsRoutes);
app.use(gamesRoutes);
app.use(rankingRoutes);
app.use(avataresRoutes);
app.use(feedRoutes);
app.use('/api/push', pushRoutes);

// 404 para rotas /api não encontradas
app.use((req, res) => {
  res.status(404).json({ error: 'Recurso não encontrado.' });
});

// Error handler central — converte HttpError no status certo; resto é 500.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error('[Futty] Erro:', err.message);
  res.status(status).json({ error: err.message || 'Erro interno.' });
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`[Futty] Servidor a correr em http://localhost:${port}`);
  console.log(`[Futty] Health check: http://localhost:${port}/health`);
});

module.exports = { app, supabase };
