// Futty v2.0 — SEGURANÇA · o banco trancado, lido DAS MIGRAÇÕES (db/migrations/*.sql): só leitura de arquivo, sem banco, sem rede.
//
// A regra da casa (migração 049): o app nunca fala com o banco pela chave pública — tudo passa pelo motor, que usa a chave secreta e
// ignora RLS. Então toda tabela do schema `public` nasce TRANCADA: RLS ligado (cinto e suspensório), sem acesso de `anon`/`authenticated`
// e com GRANT explícito para `service_role`. O GRANT explícito deixou de ser luxo: o Supabase muda a regra de grants dos objetos novos em
// 30-out, e uma tabela criada depois dessa data sem ele fica invisível até para a chave secreta.
//
// O que este teste prova, lendo as migrações em ordem:
//   1. toda tabela criada em `public` (e não apagada depois) tem ENABLE ROW LEVEL SECURITY em alguma migração;
//   2. toda tabela criada de 050 em diante tem REVOKE para anon/authenticated e GRANT para service_role, na própria migração ou numa seguinte;
//   3. nenhuma policy criada de 050 em diante abre para `anon` ou usa `using (true)`;
//   4. toda função SECURITY DEFINER tira o EXECUTE de anon/authenticated (senão `/rest/v1/rpc/<função>` rodaria com os poderes do dono);
//   5. o semáforo do Gabinete (gabinete_rls_status) existe e olha as tabelas sem RLS.
//
// Uso: node --test tests/seguranca-banco.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'db', 'migrations');
const arquivos = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const numero = (arquivo) => Number(arquivo.slice(0, 3));

const semComentarios = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const nomeLimpo = (n) => n.replace(/"/g, '').replace(/^public\./i, '').toLowerCase();
const lista = (texto) => texto.split(',').map((n) => nomeLimpo(n.trim())).filter(Boolean);

/** O que as migrações dizem de cada tabela: onde nasce, onde ganha RLS, REVOKE e GRANT, onde é apagada. */
function lerMigracoes() {
  const tabelas = new Map();
  const funcoes = new Map();
  const policies = [];
  const ver = (n) => { if (!tabelas.has(n)) tabelas.set(n, { nasce: null, rls: [], revoke: [], grant: [], dropada: null }); return tabelas.get(n); };
  for (const arquivo of arquivos) {
    const sql = semComentarios(fs.readFileSync(path.join(DIR, arquivo), 'utf8').replace(/\r\n/g, '\n'));
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?((?:"?public"?\.)?"?\w+"?)/gi)) { const t = ver(nomeLimpo(m[1])); t.nasce ||= arquivo; }
    for (const m of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?((?:"?public"?\.)?"?\w+"?)/gi)) ver(nomeLimpo(m[1])).dropada = arquivo;
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?((?:"?public"?\.)?"?\w+"?)\s+enable\s+row\s+level\s+security/gi)) ver(nomeLimpo(m[1])).rls.push(arquivo);
    for (const m of sql.matchAll(/revoke\s+all(?:\s+privileges)?\s+on\s+(?:table\s+)?([\w."]+(?:\s*,\s*[\w."]+)*)\s+from\s+([\w,\s]+?)\s*;/gi)) {
      if (/anon/i.test(m[2]) && /authenticated/i.test(m[2])) for (const n of lista(m[1])) ver(n).revoke.push(arquivo);
    }
    for (const m of sql.matchAll(/grant\s+(?:all(?:\s+privileges)?)\s+on\s+(?:table\s+)?([\w."]+(?:\s*,\s*[\w."]+)*)\s+to\s+([\w,\s]+?)\s*;/gi)) {
      if (/service_role/i.test(m[2])) for (const n of lista(m[1])) ver(n).grant.push(arquivo);
    }
    // "tira tudo de anon/authenticated em TODAS as tabelas do schema" (049): vale para as que existiam até ali
    if (/revoke\s+all\s+on\s+all\s+tables\s+in\s+schema\s+public\s+from\s+anon,\s*authenticated/i.test(sql)) {
      for (const t of tabelas.values()) if (t.nasce && numero(t.nasce) <= numero(arquivo)) t.revoke.push(`${arquivo} (todas as existentes)`);
    }
    // funções SECURITY DEFINER e quem as pode executar
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(\w+)\s*\(/gi)) {
      const depois = sql.slice(m.index, m.index + 1500);
      const cabeca = depois.split(/\$\$|\bas\s+\$/i)[0];
      if (/security\s+definer/i.test(cabeca)) { const f = funcoes.get(m[1]) || { arquivo, revoke: [], grant: [], gatilho: /returns\s+trigger/i.test(cabeca) }; funcoes.set(m[1], f); }
    }
    for (const m of sql.matchAll(/revoke\s+all\s+on\s+function\s+(?:public\.)?(\w+)\s*\([^)]*\)\s+from\s+([\w,\s]+?)\s*;/gi)) {
      if (funcoes.has(m[1]) && /anon/i.test(m[2]) && /authenticated/i.test(m[2])) funcoes.get(m[1]).revoke.push(arquivo);
    }
    for (const m of sql.matchAll(/grant\s+execute\s+on\s+function\s+(?:public\.)?(\w+)\s*\([^)]*\)\s+to\s+([\w,\s]+?)\s*;/gi)) {
      if (funcoes.has(m[1])) funcoes.get(m[1]).grant.push(`${m[2].trim()}@${arquivo}`);
    }
    for (const m of sql.matchAll(/create\s+policy\s+"?([\w ]+)"?\s+on\s+((?:"?public"?\.)?"?\w+"?)([\s\S]*?);/gi)) policies.push({ arquivo, nome: m[1].trim(), tabela: nomeLimpo(m[2]), corpo: m[3] });
  }
  return { tabelas, funcoes, policies };
}

const { tabelas, funcoes, policies } = lerMigracoes();
const criadas = [...tabelas].filter(([, t]) => t.nasce && !t.dropada).map(([nome, t]) => ({ nome, ...t }));

test('o leitor de migrações achou as tabelas de verdade (e não leu comentário como código)', () => {
  assert.ok(criadas.length >= 35, `achei só ${criadas.length} tabelas`);
  for (const esperada of ['users', 'teams', 'games', 'compras', 'avisos_lancamento', 'geracoes_jobs', 'convite_codigos', 'sorteio_codigos', 'fotos_recusadas']) {
    assert.ok(tabelas.get(esperada)?.nasce, `não achei a criação de ${esperada}`);
  }
  assert.ok(arquivos.length >= 70);
});

test('toda tabela criada em `public` tem RLS ligado em alguma migração', () => {
  const semRls = criadas.filter((t) => t.rls.length === 0).map((t) => `${t.nome} (nasce na ${t.nasce})`);
  assert.deepEqual(semRls, [], `tabelas SEM row level security — o semáforo "banco trancado" do Gabinete ficaria vermelho: ${semRls.join(', ')}`);
});

test('toda tabela criada de 050 em diante nega anon/authenticated e dá GRANT explícito ao service_role (a regra de grants do Supabase muda em 30-out)', () => {
  const sem = [];
  for (const t of criadas.filter((x) => numero(x.nasce) >= 50)) {
    const faltas = [];
    if (!t.revoke.length) faltas.push('REVOKE de anon/authenticated');
    if (!t.grant.length) faltas.push('GRANT para service_role');
    if (faltas.length) sem.push(`${t.nome} (${t.nasce}): falta ${faltas.join(' e ')}`);
  }
  assert.deepEqual(sem, [], `tabelas novas sem a trava completa:\n${sem.join('\n')}`);
});

test('toda tabela que o motor consulta nasce de uma migração (uma tabela criada à mão no painel escapa de todas as travas acima)', () => {
  const raiz = path.join(__dirname, '..');
  const lerJs = (dir) => fs.readdirSync(path.join(raiz, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [] : e.name.endsWith('.js') ? [path.join(raiz, dir, e.name)] : []));
  const consultadas = new Set();
  for (const arquivo of ['routes', 'utils', 'services', 'middleware'].flatMap(lerJs)) {
    for (const m of fs.readFileSync(arquivo, 'utf8').matchAll(/\.from\(\s*'([a-z_]+)'\s*\)/g)) consultadas.add(m[1]);
  }
  assert.ok(consultadas.size >= 30, `achei só ${consultadas.size} tabelas consultadas`);
  // `user_avatar_slots` foi criada à mão no painel (não há migração para ela): a 049 liga o RLS dela com IF EXISTS. Qualquer OUTRA
  // tabela sem migração é uma tabela que ninguém trancou.
  const CRIADAS_A_MAO = new Set(['user_avatar_slots']);
  // (o `.from('avatars')` do Storage tem o mesmo desenho do `.from('users')` das tabelas: os buckets saem da conta)
  const BUCKETS = new Set(['avatars', 'resenha', 'campeonatos', 'denuncias', 'ads', 'kits']);
  const semMigracao = [...consultadas].filter((t) => !BUCKETS.has(t) && !tabelas.get(t)?.nasce && !CRIADAS_A_MAO.has(t));
  assert.deepEqual(semMigracao, [], `tabelas consultadas pelo motor sem migração que as crie: ${semMigracao.join(', ')}`);
  assert.match(fs.readFileSync(path.join(DIR, '049_trancar_banco.sql'), 'utf8'), /public\.user_avatar_slots\s+ENABLE ROW LEVEL SECURITY/);
});

test('nenhuma policy criada depois da 049 abre para anon nem usa `using (true)`', () => {
  const abertas = policies.filter((p) => numero(p.arquivo) > 49 && (/\bto\s+anon\b/i.test(p.corpo) || /using\s*\(\s*true\s*\)/i.test(p.corpo) || /with\s+check\s*\(\s*true\s*\)/i.test(p.corpo)));
  assert.deepEqual(abertas.map((p) => `${p.nome} em ${p.tabela} (${p.arquivo})`), []);
  // e a 049 derrubou as três permissivas da 001
  const e049 = fs.readFileSync(path.join(DIR, '049_trancar_banco.sql'), 'utf8');
  for (const nome of ['users_select_all', 'users_update_self', 'members_insert_self']) assert.match(e049, new RegExp(`DROP POLICY IF EXISTS "${nome}"`));
});

test('toda função SECURITY DEFINER tira o EXECUTE de anon/authenticated (senão /rest/v1/rpc/<função> roda com os poderes do dono)', () => {
  assert.ok(funcoes.size >= 4, `achei só ${funcoes.size} funções SECURITY DEFINER`);
  // Fora da conta: função de gatilho (o Postgres não deixa chamá-la como RPC) e os quatro "sou membro/admin?" da 001/003, que só olham
  // auth.uid() — a conta de quem chama — e por isso só respondem sobre a própria conta (as policies antigas dependem deles).
  const SO_AUTH_UID = new Set(['is_team_member', 'is_team_admin', 'is_game_member', 'is_game_admin']);
  const abertas = [...funcoes].filter(([nome, f]) => !f.gatilho && !SO_AUTH_UID.has(nome) && !f.revoke.length).map(([nome, f]) => `${nome} (${f.arquivo})`);
  assert.deepEqual(abertas, [], `funções SECURITY DEFINER abertas ao público: ${abertas.join(', ')}`);
  for (const nome of ['creditar_brilhante', 'gabinete_rls_status', 'telemetria_velocidade_resumo']) assert.ok(funcoes.has(nome), `${nome} devia estar entre as SECURITY DEFINER`);
});

test('o semáforo do Gabinete (gabinete_rls_status) lista as tabelas sem RLS do schema public', () => {
  const sql = fs.readFileSync(path.join(DIR, '050_gabinete_seguranca.sql'), 'utf8');
  assert.match(sql, /relrowsecurity\s*=\s*false/);
  assert.match(sql, /nspname\s*=\s*'public'/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.gabinete_rls_status\(\) TO service_role/);
});
