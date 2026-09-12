// Futty v2.0 — Limpeza de usuários de teste (14-set). Apaga TODOS os
// usuários do auth EXCETO os da lista MANTER e qualquer super-admin —
// pré-lançamento, a base inteira (menos essas contas) é considerada teste.
//
// Uso:
//   node scripts/limpar-usuarios-teste.js                       → SIMULAÇÃO (default). Não altera nada.
//   node scripts/limpar-usuarios-teste.js --apagar --confirmo   → apaga de verdade. As DUAS flags juntas.
//   ... --times-tambem (soma às duas acima, ou sozinha na simulação) → além
//       dos usuários de teste, apaga TAMBÉM todos os times que sobrariam —
//       inclusive os criados pelas contas MANTER — com o Storage (logos) e
//       os dependentes por cascade. As contas MANTER em si (perfil, e-mail,
//       figurinha, fotos) NUNCA são tocadas — só os times deixam de existir.
//
// Requer backend/.env com SUPABASE_URL e SUPABASE_SERVICE_KEY (reaproveita
// utils/db.js, mesmo cliente service_role que o resto do backend usa).
//
// ORDEM da deleção real (por isto, nunca a ordem inversa):
//   1) Storage (avatars/resenha) dos usuários a apagar + logos dos times
//      deles — nada disto cai por FK, é preciso apagar à mão (Tijolo 1B).
//   2) geracao_ia_log — user_id SEM foreign key nenhuma (migração 046):
//      apagar user não apaga isto sozinho, fica órfão para sempre se não
//      limparmos à mão.
//   3) user_avatar_slots — tabela sem migração commitada (criada à mão no
//      Supabase; confirmado por grep + 049_trancar_banco.sql linha 63-65).
//      Sem saber se tem FK com cascade, limpamos à mão por segurança —
//      idempotente, não falha se a tabela nem existir.
//   4) teams WHERE criado_por IN (...) — cascade cuida de team_members,
//      games (e tudo dependente de game: game_players, votes.game_id,
//      rsvp_respostas, gols_jogadores, rsvp_espera, share_declarations),
//      feed_posts+feed_post_media, champion_photos, team_join_requests,
//      convites, campeonatos+campeonato_jornadas. Tudo confirmado
//      "ON DELETE CASCADE" em db/migrations/*.sql (auditoria 14-set).
//   5) auth.admin.deleteUser(id) — cascade automático (001_schema.sql linha
//      11: public.users.id REFERENCES auth.users(id) ON DELETE CASCADE)
//      apaga a linha em public.users, que por sua vez cascade-apaga tudo o
//      que ainda restava referenciando user_id diretamente (team_members
//      como MEMBRO de outros times, votes, comentarios+comentario_anexos,
//      denuncias, reacoes, rsvp*, push_subscriptions, user_blocks,
//      convites.criado_por/usado_por — todos CASCADE ou SET NULL,
//      confirmado por grep em db/migrations/).
//
// Fazer o passo 4 (times) ANTES do passo 5 (usuário) é deliberado: dá
// visibilidade e controlo (contamos exatamente quantos times saíram, com um
// erro claro se algo bloquear) em vez de confiar cegamente numa cascade de
// 2 níveis (teams.criado_por → users.id) escondida dentro do
// auth.admin.deleteUser.
//
// campeonatos_v2/campeonato_times/campeonato_confrontos (migração 039) ficam
// DE FORA de propósito — mesma decisão de scripts/backup-banco.js: ainda não
// existem em produção (a v1 do campeonato guarda tudo como JSON no Storage).
const path = require('path');
const { execFileSync } = require('child_process');
const { supabase } = require('../utils/db');
const { removerFicheirosPorUrl, parseUrlPublico } = require('../utils/storage');

const MANTER_EMAILS = ['phferreiraborgesbackup@gmail.com', 'contatofuttyapp@gmail.com'].map((e) => e.toLowerCase());
const TAMANHO_LOTE = 200; // PostgREST/.in() em lotes — mesmo espírito do TAMANHO_PAGINA de backup-banco.js

function lotes(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** SELECT em lotes de `coluna IN ids`, concatenando os resultados. */
async function selecionarEmLotes(tabela, coluna, select, ids) {
  const todos = [];
  for (const lote of lotes(ids, TAMANHO_LOTE)) {
    if (!lote.length) continue;
    const { data, error } = await supabase.from(tabela).select(select).in(coluna, lote);
    if (error) throw new Error(`${tabela}: ${error.message}`);
    todos.push(...(data || []));
  }
  return todos;
}

/**
 * DELETE em lotes de `coluna IN ids`. Devolve o nº de linhas apagadas — via
 * .select(coluna) no delete (RETURNING), não .select('id'): nem toda tabela
 * tem uma coluna `id` (achado 14-set: user_avatar_slots não tem — RETURNING
 * id nessa tabela falha a query inteira, incluindo o DELETE. `coluna` é
 * sempre segura porque é a mesma que acabámos de filtrar com .in()).
 */
async function apagarEmLotes(tabela, coluna, ids) {
  let total = 0;
  for (const lote of lotes(ids, TAMANHO_LOTE)) {
    if (!lote.length) continue;
    const { data, error } = await supabase.from(tabela).delete().in(coluna, lote).select(coluna);
    if (error) throw new Error(`${tabela}: ${error.message}`);
    total += (data || []).length;
  }
  return total;
}

/** Lista TODOS os usuários do auth, paginando (listUsers tem um teto por página). */
async function listarTodosAuthUsers() {
  const todos = [];
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers: ${error.message}`);
    todos.push(...data.users);
    if (data.users.length < perPage) break;
    page += 1;
  }
  return todos;
}

/** Agrupa por chave, devolvendo Map(chave -> contagem). */
function contarPorChave(linhas, chave) {
  const mapa = new Map();
  for (const l of linhas) {
    const k = l[chave];
    mapa.set(k, (mapa.get(k) || 0) + 1);
  }
  return mapa;
}

/**
 * Monta o plano de limpeza: quem apaga, o que apaga, e as URLs de Storage a
 * remover — TUDO calculado uma vez só, reaproveitado tanto pela simulação
 * (só imprime) quanto pela execução real (imprime E apaga com os mesmos
 * dados, sem re-consultar depois).
 */
async function montarPlano({ timesTambem = false } = {}) {
  const todosAuth = await listarTodosAuthUsers();
  const porEmail = new Map(todosAuth.map((u) => [u.email?.toLowerCase(), u]));

  const manterFaltando = MANTER_EMAILS.filter((e) => !porEmail.has(e));
  if (manterFaltando.length) {
    throw new Error(`conta(s) MANTER não encontrada(s) no auth — abortando sem tocar em nada: ${manterFaltando.join(', ')}`);
  }

  const { data: superAdmins, error: saErr } = await supabase.from('users').select('id').eq('is_super_admin', true);
  if (saErr) throw new Error(`users(is_super_admin): ${saErr.message}`);

  const manterIds = new Set([
    ...MANTER_EMAILS.map((e) => porEmail.get(e).id),
    ...(superAdmins || []).map((u) => u.id),
  ]);

  const aApagar = todosAuth
    .filter((u) => !manterIds.has(u.id))
    .sort((a, b) => (a.email || '').localeCompare(b.email || ''));
  const apagarIds = aApagar.map((u) => u.id);

  // Times: todos (para reportar tanto os que saem quanto os que ficam).
  // --times-tambem: TODOS os times vão embora (mesmo os das contas MANTER) —
  // "times que ficam" fica vazio de propósito.
  const { data: todosTeams, error: teamsErr } = await supabase.from('teams').select('id, nome, slug, criado_por, logo_url');
  if (teamsErr) throw new Error(`teams: ${teamsErr.message}`);
  const timesApagar = timesTambem ? (todosTeams || []) : (todosTeams || []).filter((t) => apagarIds.includes(t.criado_por));
  const timesFicam = timesTambem ? [] : (todosTeams || []).filter((t) => !apagarIds.includes(t.criado_por));
  const timesApagarIds = timesApagar.map((t) => t.id);

  // Aviso de segurança (item 7 do pedido original): alguma conta MANTER é
  // MEMBRO (não dono) de um time que vai ser apagado? A participação dela
  // nesse time some junto — mensagem genérica de propósito (com
  // --times-tambem o time pode até ter sido criado por outra conta MANTER).
  const avisos = [];
  if (timesApagarIds.length && manterIds.size) {
    const membrosDeTimesApagar = await selecionarEmLotes('team_members', 'team_id', 'team_id, user_id', timesApagarIds);
    const idParaEmail = new Map(todosAuth.map((u) => [u.id, u.email]));
    for (const m of membrosDeTimesApagar) {
      if (manterIds.has(m.user_id)) {
        const time = timesApagar.find((t) => t.id === m.team_id);
        avisos.push(`conta MANTER ${idParaEmail.get(m.user_id) || m.user_id} é membro do time "${time?.nome || m.team_id}", que vai ser apagado — a participação dela nesse time some junto.`);
      }
    }
  }

  // Participações/jogos/votos — 1 query em lote por tabela, agrupado por user_id.
  const [membrosLinhas, jogadoresLinhas, votosLinhas] = await Promise.all([
    selecionarEmLotes('team_members', 'user_id', 'user_id', apagarIds),
    selecionarEmLotes('game_players', 'user_id', 'user_id', apagarIds),
    selecionarEmLotes('votes', 'de_user_id', 'de_user_id', apagarIds),
  ]);
  const participacoesPorUser = contarPorChave(membrosLinhas, 'user_id');
  const jogosPorUser = contarPorChave(jogadoresLinhas, 'user_id');
  const votosPorUser = contarPorChave(votosLinhas, 'de_user_id');

  // Dados de public.users (avatar_url/foto_url) — fonte principal das fotos no Storage.
  const usersRows = await selecionarEmLotes('users', 'id', 'id, avatar_url, foto_url', apagarIds);
  const usersRowsPorId = new Map(usersRows.map((u) => [u.id, u]));

  // user_avatar_slots — sem migração commitada (schema desconhecido); defensivo.
  let slotsRows = [];
  try {
    slotsRows = await selecionarEmLotes('user_avatar_slots', 'user_id', 'user_id, avatar_url', apagarIds);
  } catch (e) {
    console.warn(`[limpar] aviso: não consegui ler user_avatar_slots (tabela pode não existir) — ${e.message}`);
  }

  // champion_photos.
  const championRows = await selecionarEmLotes('champion_photos', 'user_id', 'user_id, url', apagarIds);

  // feed_posts do usuário → feed_post_media (2 passos).
  const feedPostsRows = await selecionarEmLotes('feed_posts', 'author_id', 'id, author_id', apagarIds);
  const feedPostsPorId = new Map(feedPostsRows.map((p) => [p.id, p.author_id]));
  const feedMediaRows = feedPostsRows.length
    ? await selecionarEmLotes('feed_post_media', 'post_id', 'post_id, url', feedPostsRows.map((p) => p.id))
    : [];

  // comentarios do usuário → comentario_anexos (2 passos).
  const comentariosRows = await selecionarEmLotes('comentarios', 'author_id', 'id, author_id', apagarIds);
  const comentariosPorId = new Map(comentariosRows.map((c) => [c.id, c.author_id]));
  const anexosRows = comentariosRows.length
    ? await selecionarEmLotes('comentario_anexos', 'comentario_id', 'comentario_id, url', comentariosRows.map((c) => c.id))
    : [];

  // ── Junta tudo por usuário (para o relatório) e por bucket (para apagar) ──
  const urlsPorUser = new Map(apagarIds.map((id) => [id, []]));
  const addUrl = (userId, url) => { if (userId && url && urlsPorUser.has(userId)) urlsPorUser.get(userId).push(url); };

  for (const u of usersRows) { addUrl(u.id, u.avatar_url); addUrl(u.id, u.foto_url); }
  for (const s of slotsRows) addUrl(s.user_id, s.avatar_url);
  for (const c of championRows) addUrl(c.user_id, c.url);
  for (const m of feedMediaRows) addUrl(feedPostsPorId.get(m.post_id), m.url);
  for (const a of anexosRows) addUrl(comentariosPorId.get(a.comentario_id), a.url);
  // Logos dos times que vão ser apagados — conta no relatório do dono, só
  // quando o dono é um usuário a apagar (urlsPorUser só tem chaves para
  // apagarIds). Times de contas MANTER (--times-tambem) não entram aqui —
  // não têm "dono a apagar" — mas entram no total global de Storage abaixo.
  for (const t of timesApagar) addUrl(t.criado_por, t.logo_url);

  // Lista final, DEDUPLICADA (Set), de tudo o que sai de verdade do Storage —
  // junta as URLs por usuário acima com os logos de TODOS os times a apagar
  // (inclusive os sem dono a apagar, ex.: times de contas MANTER).
  const todasUrls = new Set();
  for (const [, urls] of urlsPorUser) urls.forEach((u) => todasUrls.add(u));
  for (const t of timesApagar) if (t.logo_url) todasUrls.add(t.logo_url);

  const urlsPorBucket = { avatars: [], resenha: [] };
  for (const url of todasUrls) {
    const p = parseUrlPublico(url);
    if (p) urlsPorBucket[p.bucket].push(url);
  }
  // Ficheiro temporário determinístico (routes/auth.js: tmp/${userId}-pad.jpg,
  // gerado durante a geração de avatar IA) — não vem de nenhuma linha da BD,
  // tentamos remover sempre; se não existir, o remove() é um no-op silencioso.
  const caminhosTmp = apagarIds.map((id) => `tmp/${id}-pad.jpg`);

  const usuarios = aApagar.map((u) => ({
    id: u.id,
    email: u.email,
    created_at: u.created_at,
    times_criados: timesApagar.filter((t) => t.criado_por === u.id).map((t) => `${t.nome} (${t.slug})`),
    participacoes: participacoesPorUser.get(u.id) || 0,
    jogos: jogosPorUser.get(u.id) || 0,
    votos: votosPorUser.get(u.id) || 0,
    fotos_storage: (urlsPorUser.get(u.id) || []).filter((url) => parseUrlPublico(url)).length,
  }));

  return {
    timesTambem,
    manterIds,
    manterEmails: MANTER_EMAILS,
    superAdminsCount: (superAdmins || []).length,
    usuarios,
    apagarIds,
    timesApagar,
    timesApagarIds,
    timesFicam,
    avisos,
    urlsPorBucket,
    caminhosTmp,
  };
}

function imprimirRelatorio(plano, { execucaoReal }) {
  const titulo = execucaoReal ? 'EXECUÇÃO' : 'SIMULAÇÃO (dry-run — nada foi alterado)';
  console.log(`\n[limpar] ${titulo}`);
  console.log(`[limpar] mantidos: ${plano.manterEmails.join(', ')} + ${plano.superAdminsCount} super-admin(s)`);
  if (plano.timesTambem) {
    console.log('[limpar] --times-tambem ATIVO: TODOS os times serão apagados, inclusive os das contas MANTER (perfil/e-mail/figurinha delas continuam intactos — só os times deixam de existir).');
  }

  if (plano.avisos.length) {
    console.log('\n[limpar] ⚠ AVISOS:');
    plano.avisos.forEach((a) => console.log(`  - ${a}`));
  }

  console.log(`\n[limpar] ${plano.usuarios.length} usuário(s) a apagar:`);
  for (const u of plano.usuarios) {
    console.log(`  - ${u.email}  (criado em ${u.created_at})`);
    console.log(
      `      times criados: ${u.times_criados.length ? u.times_criados.join(', ') : '-'} · ` +
      `participações: ${u.participacoes} · jogos: ${u.jogos} · votos: ${u.votos} · fotos no Storage: ${u.fotos_storage}`
    );
  }

  const totais = plano.usuarios.reduce(
    (acc, u) => ({
      participacoes: acc.participacoes + u.participacoes,
      jogos: acc.jogos + u.jogos,
      votos: acc.votos + u.votos,
      fotos: acc.fotos + u.fotos_storage,
    }),
    { participacoes: 0, jogos: 0, votos: 0, fotos: 0 }
  );
  console.log('\n[limpar] TOTAIS:');
  console.log(`  usuários: ${plano.usuarios.length}`);
  console.log(`  times a apagar: ${plano.timesApagar.length}`);
  console.log(`  times que ficam: ${plano.timesFicam.length}`);
  console.log(`  participações em times: ${totais.participacoes}`);
  console.log(`  jogos: ${totais.jogos}`);
  console.log(`  votos: ${totais.votos}`);
  console.log(`  fotos no Storage: ${totais.fotos + plano.caminhosTmp.length} (+ ${plano.caminhosTmp.length} arquivo(s) temporário(s) tentado(s), best-effort)`);

  console.log(`\n[limpar] times que seriam apagados (${plano.timesApagar.length}):`);
  plano.timesApagar.forEach((t) => console.log(`  - ${t.nome} (${t.slug})`));
  console.log(`\n[limpar] times que ficam (${plano.timesFicam.length}):`);
  plano.timesFicam.forEach((t) => console.log(`  - ${t.nome} (${t.slug})`));
  console.log('');
}

/** node scripts/backup-banco.js — aborta a limpeza se o backup falhar. */
function rodarBackup() {
  console.log('[limpar] a rodar backup-banco.js antes de apagar...');
  execFileSync('node', [path.join(__dirname, 'backup-banco.js')], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
  });
  console.log('[limpar] backup OK.\n');
}

async function executarApagar(plano) {
  // Com --times-tambem pode não sobrar nenhum usuário a apagar (2ª corrida)
  // mas ainda haver times de contas MANTER para limpar — só sai cedo se as
  // DUAS listas estiverem vazias.
  if (!plano.usuarios.length && !plano.timesApagarIds.length) {
    console.log('[limpar] nada a apagar — a base já só tem as contas mantidas (e os times delas, se --times-tambem não estiver ativo).');
    return;
  }

  rodarBackup(); // lança (execFileSync) se o exit code não for 0 — aborta aqui, antes de tocar em nada

  // 1) Storage — best-effort, nunca aborta a limpeza por um ficheiro que falhe.
  console.log('[limpar] a remover ficheiros no Storage...');
  for (const bucket of Object.keys(plano.urlsPorBucket)) {
    const urls = plano.urlsPorBucket[bucket];
    if (!urls.length) continue;
    const r = await removerFicheirosPorUrl(bucket, urls);
    console.log(`  ${bucket}: ${r.removidos} removido(s)${r.erro ? ` (erro: ${r.erro})` : ''}`);
  }
  if (plano.caminhosTmp.length) {
    const { error } = await supabase.storage.from('avatars').remove(plano.caminhosTmp);
    if (error) console.warn(`  avatars/tmp: aviso (${error.message}) — segue, são ficheiros efêmeros`);
  }

  // 2) geracao_ia_log — sem FK nenhuma (migração 046), nunca cai por cascade.
  const logsApagados = await apagarEmLotes('geracao_ia_log', 'user_id', plano.apagarIds);
  console.log(`[limpar] geracao_ia_log: ${logsApagados} linha(s) apagada(s).`);

  // 3) user_avatar_slots — schema desconhecido (sem migração); defensivo.
  try {
    const slotsApagados = await apagarEmLotes('user_avatar_slots', 'user_id', plano.apagarIds);
    console.log(`[limpar] user_avatar_slots: ${slotsApagados} linha(s) apagada(s).`);
  } catch (e) {
    console.warn(`[limpar] aviso: não consegui limpar user_avatar_slots (tabela pode não existir) — ${e.message}`);
  }

  // 4) times a apagar (por id — cobre tanto os criados pelos usuários a
  // apagar quanto, com --times-tambem, os das contas MANTER) — cascade cuida
  // do resto (ver cabeçalho).
  const timesApagados = await apagarEmLotes('teams', 'id', plano.timesApagarIds);
  console.log(`[limpar] teams: ${timesApagados} time(s) apagado(s) (cascade: membros, jogos, votos, posts, convites, campeonatos...).`);

  // 5) auth.admin.deleteUser — 1 por 1 (a API não aceita lote); cascade final
  // (public.users e tudo o que ainda referenciava user_id diretamente).
  let usuariosApagados = 0;
  const falhas = [];
  for (const u of plano.usuarios) {
    const { error } = await supabase.auth.admin.deleteUser(u.id);
    if (error) {
      falhas.push({ email: u.email, erro: error.message });
      console.error(`[limpar] FALHOU ao apagar ${u.email}: ${error.message}`);
    } else {
      usuariosApagados += 1;
    }
  }

  console.log(`\n[limpar] RESUMO: ${usuariosApagados}/${plano.usuarios.length} usuário(s) apagado(s), ${timesApagados} time(s) apagado(s).`);
  if (falhas.length) {
    console.log(`[limpar] ${falhas.length} falha(s) — rode o script de novo para tentar essas contas outra vez (idempotente):`);
    falhas.forEach((f) => console.log(`  - ${f.email}: ${f.erro}`));
  }

  console.log('\n[limpar] estado final — a relistar o que sobrou...');
  const planoFinal = await montarPlano({ timesTambem: plano.timesTambem });
  console.log(`[limpar] restam ${planoFinal.usuarios.length} usuário(s) fora da lista MANTER (esperado: só as falhas acima, se houver).`);
  console.log(`[limpar] times que ficam agora: ${planoFinal.timesFicam.length}.`);
}

async function main() {
  const args = process.argv.slice(2);
  const querApagar = args.includes('--apagar');
  const confirmou = args.includes('--confirmo');
  const timesTambem = args.includes('--times-tambem');
  if (querApagar !== confirmou) {
    console.error('[limpar] Para apagar de verdade use as DUAS flags juntas: --apagar --confirmo');
    console.error('[limpar] Sem flags, o script só simula (dry-run) e não altera nada.');
    process.exit(1);
  }
  const execucaoReal = querApagar && confirmou;

  const plano = await montarPlano({ timesTambem });
  imprimirRelatorio(plano, { execucaoReal });

  if (execucaoReal) {
    await executarApagar(plano);
  } else {
    console.log('[limpar] simulação concluída — nada foi alterado. Rode com --apagar --confirmo para executar de verdade.');
  }
}

main().catch((e) => {
  console.error(`[limpar] ERRO: ${e.message}`);
  process.exit(1);
});
