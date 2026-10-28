// Futty v2.0 — GET /api/saude/banco: o medidor do caminho até o Supabase (utils/saudeBanco.js), chamado de fora.
//
// Só super-admin (a mesma trava do Gabinete): a resposta diz o IP do banco, o datacenter por onde ele responde e como o motor guarda
// as ligações — detalhe interno que não é de mais ninguém. Só leitura. `no-store` porque cada chamada é uma medição nova.
const express = require('express');
const { requireSuperAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');
const { supabase } = require('../utils/db');
const { medirBanco } = require('../utils/saudeBanco');

const router = express.Router();

router.get('/api/saude/banco', requireSuperAdmin, asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await medirBanco({ supabase, url: process.env.SUPABASE_URL, userId: req.user.id }));
}));

module.exports = router;
