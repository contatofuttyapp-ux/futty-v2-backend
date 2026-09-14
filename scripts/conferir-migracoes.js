#!/usr/bin/env node
// Futty v2.0 — Confere db/migrations/*.sql contra o ESTADO REAL do banco (build 9,
// achado real: PATCH /api/me deu 500 "violates check constraint
// users_fundo_figurinha_check" porque a migração 043 nunca correu — resolve
// também o item pendente da migração 039, "nunca correu no banco").
//
// Como funciona: não há ligação directa ao Postgres nesta máquina (só a API
// REST do Supabase, via service_role — ver utils/db.js), por isso não se lê o
// catálogo do banco directamente. Em vez disso, cada migração é lida e
// extraem-se os alvos que ela declara criar (CREATE TABLE, ADD COLUMN); para
// cada alvo, faz-se uma SONDA — um SELECT de 1 linha nessa tabela/coluna — e
// o CÓDIGO DE ERRO do PostgREST diz se existe:
//   42703      = coluna não existe
//   PGRST205   = tabela não existe
// CHECK CONSTRAINTS (ex.: 043) não têm sonda segura sem escrever dados de
// teste — ficam listadas à parte, para conferência manual.
//
// Uso: node scripts/conferir-migracoes.js  (ou: npm run conferir-migracoes)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { supabase } = require('../utils/db');

const DIR = path.join(__dirname, '..', 'db', 'migrations');

// Remove comentários de linha (--...) antes de dividir em statements — um
// ';' dentro de um comentário não pode cortar a instrução ao meio. \r\n
// normalizado primeiro: `\r` conta como quebra de linha para o `$` do JS
// regex, então "--texto\r" sem isto não batia (o \r sobrava intacto e
// "CREATE TABLE" dentro de um comentário em prosa era lido como DDL de
// verdade — foi apanhado ao rodar contra 049_trancar_banco.sql).
function semComentarios(sql) {
  return sql
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
}

function extrairAlvos(sqlBruto) {
  const sql = semComentarios(sqlBruto);
  const statements = sql.split(';');
  const colunas = []; // { tabela, coluna }
  const tabelas = []; // tabela
  const constraints = []; // { tabela, nome }
  for (const stmt of statements) {
    const createM = stmt.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/i);
    if (createM) tabelas.push(createM[1]);

    const alterM = stmt.match(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/i);
    if (alterM) {
      const tabela = alterM[1];
      const colRe = /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"?(\w+)"?/gi;
      let cm;
      while ((cm = colRe.exec(stmt))) colunas.push({ tabela, coluna: cm[1] });
      const conRe = /ADD\s+CONSTRAINT\s+"?(\w+)"?\s+CHECK/gi;
      let cn;
      while ((cn = conRe.exec(stmt))) constraints.push({ tabela, nome: cn[1] });
    }
  }
  return { colunas, tabelas, constraints };
}

const CODIGOS_AUSENTE = new Set(['42703', 'PGRST204', 'PGRST205']);

async function tabelaExiste(tabela) {
  const { error } = await supabase.from(tabela).select('*').limit(1);
  if (!error) return true;
  if (error.code === 'PGRST205') return false;
  return null; // erro de outra natureza (rede, permissão) — indeterminado
}

async function colunaExiste(tabela, coluna) {
  const { error } = await supabase.from(tabela).select(coluna).limit(1);
  if (!error) return true;
  if (CODIGOS_AUSENTE.has(error.code)) return false;
  return null;
}

async function main() {
  const arquivos = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  const relatorio = [];

  for (const arquivo of arquivos) {
    const sql = fs.readFileSync(path.join(DIR, arquivo), 'utf8');
    const { colunas, tabelas, constraints } = extrairAlvos(sql);

    for (const nomeTabela of new Set(tabelas)) {
      const ok = await tabelaExiste(nomeTabela);
      relatorio.push({ arquivo, tipo: 'tabela', alvo: nomeTabela, existe: ok });
    }
    for (const { tabela, coluna } of colunas) {
      const ok = await colunaExiste(tabela, coluna);
      relatorio.push({ arquivo, tipo: 'coluna', alvo: `${tabela}.${coluna}`, existe: ok });
    }
    for (const { tabela, nome } of constraints) {
      relatorio.push({ arquivo, tipo: 'constraint', alvo: `${nome} (em ${tabela})`, existe: null, naoVerificavel: true });
    }
    if (!tabelas.length && !colunas.length && !constraints.length) {
      relatorio.push({ arquivo, tipo: 'sem-sinal', alvo: null, existe: null });
    }
  }

  const porArquivo = new Map();
  for (const r of relatorio) {
    if (!porArquivo.has(r.arquivo)) porArquivo.set(r.arquivo, []);
    porArquivo.get(r.arquivo).push(r);
  }

  const faltando = [];
  const indeterminado = [];
  const constraintsParaConferir = [];
  const semSinal = [];
  const ok = [];

  for (const [arquivo, itens] of porArquivo) {
    const ausentes = itens.filter((i) => i.existe === false);
    const semSinalItens = itens.filter((i) => i.tipo === 'sem-sinal');
    const constraintItens = itens.filter((i) => i.naoVerificavel);
    const indefinidos = itens.filter((i) => i.existe === null && !i.naoVerificavel && i.tipo !== 'sem-sinal');
    const confirmados = itens.filter((i) => i.existe === true);

    if (ausentes.length) faltando.push({ arquivo, itens: ausentes });
    if (indefinidos.length) indeterminado.push({ arquivo, itens: indefinidos });
    if (constraintItens.length) constraintsParaConferir.push({ arquivo, itens: constraintItens });
    if (semSinalItens.length && !ausentes.length && !confirmados.length) semSinal.push(arquivo);
    if (confirmados.length && !ausentes.length) ok.push({ arquivo, n: confirmados.length });
  }

  console.log('\n=== Conferência de migrações — db/migrations/*.sql vs banco real ===');
  console.log(`(${arquivos.length} arquivos de migração lidos)\n`);

  if (faltando.length) {
    console.log(`❌ FALTANDO APLICAR (${faltando.length} arquivo(s)):`);
    for (const { arquivo, itens } of faltando) {
      console.log(`   ${arquivo}`);
      for (const i of itens) console.log(`      - ${i.tipo} ${i.alvo}: NÃO existe no banco`);
    }
    console.log('');
  } else {
    console.log('✅ Nenhuma coluna/tabela declarada como ADD COLUMN/CREATE TABLE está faltando.\n');
  }

  if (indeterminado.length) {
    console.log(`⚠️  INDETERMINADO — erro inesperado ao sondar (${indeterminado.length} arquivo(s)):`);
    for (const { arquivo, itens } of indeterminado) {
      for (const i of itens) console.log(`   ${arquivo}: ${i.tipo} ${i.alvo}`);
    }
    console.log('');
  }

  if (constraintsParaConferir.length) {
    console.log(`🔍 CONSTRAINTS declaradas — sem sonda seguro (não escrevo dados de teste), confira à mão:`);
    for (const { arquivo, itens } of constraintsParaConferir) {
      for (const i of itens) console.log(`   ${arquivo}: ${i.alvo}`);
    }
    console.log('');
  }

  console.log(`✅ Confirmadas aplicadas: ${ok.reduce((s, o) => s + o.n, 0)} alvo(s) em ${ok.length} arquivo(s).`);
  console.log(`ℹ️  Sem ADD COLUMN/CREATE TABLE para sondar (RLS, policy, index, UPDATE, etc.): ${semSinal.length} arquivo(s).`);
  if (process.argv.includes('--verbose')) {
    console.log('   ' + semSinal.join(', '));
  }

  console.log(`\nSaída: ${faltando.length ? 'FALTA aplicar migração(ões) — ver ❌ acima' : 'tudo o que dá para sondar está em dia'}.`);
  process.exit(faltando.length ? 1 : 0);
}

main().catch((e) => {
  console.error('[conferir-migracoes] erro fatal:', e.message);
  process.exit(2);
});
