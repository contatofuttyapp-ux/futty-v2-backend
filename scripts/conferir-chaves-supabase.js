#!/usr/bin/env node
// Futty v2.0 — Confere as chaves do Supabase que o motor está usando (Rodada 28, bloco F).
//
// Para depois de colar SUPABASE_SECRET_KEY / SUPABASE_PUBLISHABLE_KEY no .env: diz QUAL variável
// manda em cada chave, em que formato (nova sb_… ou antiga JWT) e se ela funciona nas quatro coisas
// que o motor faz com o Supabase — banco, Auth admin, Storage e o login do app. Só leitura.
//
// NUNCA imprime chave nenhuma, nem pedaço dela: só nomes de variável, formato e ok/falhou.
//
// Uso (na pasta backend): node scripts/conferir-chaves-supabase.js
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { chaveSecreta, chavePublica, origemDasChaves } = require('../utils/chavesSupabase');

const { SUPABASE_URL } = process.env;

// Mensagem de erro sem risco de ecoar cabeçalho: corta e tira qualquer coisa com cara de chave.
function limpar(msg) {
  return String(msg || 'erro').replace(/(sb_[a-z]+_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_.-]+)/g, '[chave]').slice(0, 160);
}

async function passo(nome, fn) {
  try {
    const detalhe = await fn();
    console.log(`  ok      ${nome}${detalhe ? ` (${detalhe})` : ''}`);
    return true;
  } catch (e) {
    console.log(`  FALHOU  ${nome}: ${limpar(e.message)}`);
    return false;
  }
}

async function main() {
  const origem = origemDasChaves();
  console.log('Chaves em uso:');
  console.log(`  secreta:     ${origem.secreta || 'NENHUMA'}${origem.secretaFormato ? ` (formato ${origem.secretaFormato})` : ''}`);
  console.log(`  publishable: ${origem.publica || 'NENHUMA'}${origem.publicaFormato ? ` (formato ${origem.publicaFormato})` : ''}`);
  if (!SUPABASE_URL || !chaveSecreta()) {
    console.log('\nFalta SUPABASE_URL ou a chave secreta no .env.');
    process.exit(1);
  }

  const admin = createClient(SUPABASE_URL, chaveSecreta(), { auth: { autoRefreshToken: false, persistSession: false } });
  console.log('\nChave secreta (o motor):');
  const resultados = [];
  resultados.push(await passo('banco (users, só contagem)', async () => {
    const { count, error } = await admin.from('users').select('id', { count: 'exact', head: true });
    if (error) throw new Error(error.message);
    return `${count} linhas`;
  }));
  resultados.push(await passo('Auth admin (listar 1 conta)', async () => {
    const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (error) throw new Error(error.message);
    return `${data?.users?.length ?? 0} devolvida`;
  }));
  resultados.push(await passo('Storage (avatars, listar 1 objeto)', async () => {
    const { data, error } = await admin.storage.from('avatars').list('public', { limit: 1 });
    if (error) throw new Error(error.message);
    return `${(data || []).length} devolvido`;
  }));

  console.log('\nChave publishable (o app):');
  if (!chavePublica()) {
    console.log('  (nenhuma no .env do motor — o app lê a dele do .env do frontend; nada a conferir aqui)');
  } else {
    resultados.push(await passo('Auth aceita a chave (/auth/v1/settings)', async () => {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: chavePublica() } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return 'HTTP 200';
    }));
    resultados.push(await passo('banco continua trancado para ela (users)', async () => {
      const publico = createClient(SUPABASE_URL, chavePublica(), { auth: { autoRefreshToken: false, persistSession: false } });
      const { data, error } = await publico.from('users').select('id').limit(1);
      if (!error && (data || []).length) throw new Error('a chave pública LEU a tabela users — conferir RLS/grants (migração 049)');
      return error ? 'recusado, como deve' : 'nenhuma linha, como deve';
    }));
  }

  const falhas = resultados.filter((ok) => !ok).length;
  console.log(falhas ? `\n${falhas} verificação(ões) falharam.` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
}

main().catch((e) => {
  console.error('Erro inesperado:', limpar(e.message));
  process.exit(1);
});
