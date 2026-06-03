// Futty v2.0 — Backend (Express + Supabase)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, PORT } = process.env;

// Validação básica de configuração
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    '[Futty] ERRO: faltam variáveis de ambiente. Verifica o .env (SUPABASE_URL e SUPABASE_SERVICE_KEY).'
  );
  process.exit(1);
}

// Cliente admin (service_role) — uso exclusivo no servidor, ignora RLS.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    service: 'futty-backend',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    supabase: 'unknown',
  };

  // Testa ligação ao Supabase (uma query leve à tabela users)
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

const port = PORT || 3001;
app.listen(port, () => {
  console.log(`[Futty] Servidor a correr em http://localhost:${port}`);
  console.log(`[Futty] Health check: http://localhost:${port}/health`);
});

module.exports = { app, supabase };
