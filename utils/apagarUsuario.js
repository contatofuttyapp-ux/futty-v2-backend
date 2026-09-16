// Futty v2.0 — Exclusão de conta (LGPD / exigência das lojas). Lógica ÚNICA de
// apagar um usuário por completo — partilhada entre a rota DELETE /api/me (o
// próprio usuário) e scripts/limpar-usuarios-teste.js (limpeza em massa), para
// nunca haver duas versões da ordem de deleção a divergir com o tempo.
//
// ORDEM (mesma auditoria de scripts/limpar-usuarios-teste.js, 14-set):
//   1) Times onde o usuário é criador/admin — sucessão ANTES de tudo: se sobra
//      outro admin, só passa o criado_por adiante (teams.criado_por tem ON
//      DELETE CASCADE — sem isto, apagar o usuário apagava também um time com
//      gente ativa); se não sobra outro admin mas sobra outro membro, o mais
//      antigo vira admin E leva o criado_por; se o usuário é o único membro, o
//      time é apagado (com o logo dele no Storage).
//   2) Storage — avatar/foto, slots de avatar IA, fotos de campeão, mídia de
//      posts/comentários dele na Resenha, + o logo dos times apagados no passo
//      1. Nada disto cai por FK, é preciso apagar à mão (best-effort).
//   3) geracao_ia_log — user_id SEM foreign key nenhuma (migração 046).
//   4) user_avatar_slots — tabela sem migração commitada; defensivo.
//   5) auth.admin.deleteUser(id) — cascade cuida do resto: public.users e
//      tudo o que referencia user_id diretamente (team_members como membro,
//      votes, comentarios+comentario_anexos, feed_posts+feed_post_media,
//      denuncias, reacoes, rsvp*, push_subscriptions, user_blocks,
//      convites.criado_por/usado_por — todos CASCADE ou SET NULL, confirmado
//      por grep em db/migrations/).
const { supabase } = require('./db');
const { removerFicheirosPorUrl, bucketEcaminho } = require('./storage');

/** Ordena por created_at ascendente (o mais antigo primeiro). */
function porAntiguidade(a, b) {
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}

/**
 * Resolve os times onde o usuário é criador OU admin: transfere a sucessão
 * (outro admin já existente, ou o membro mais antigo promovido) ou apaga o
 * time (usuário era o único membro). NÃO mexe no Storage — só devolve os
 * URLs dos logos dos times apagados, para quem chama juntar com o resto e
 * apagar tudo de uma vez (passo 2).
 */
async function resolverTimes(userId) {
  const [{ data: minhasAdmins, error: e1 }, { data: criados, error: e2 }] = await Promise.all([
    supabase.from('team_members').select('team_id').eq('user_id', userId).eq('role', 'admin'),
    supabase.from('teams').select('id').eq('criado_por', userId),
  ]);
  if (e1) throw new Error(`team_members: ${e1.message}`);
  if (e2) throw new Error(`teams: ${e2.message}`);

  const idsRelevantes = [...new Set([...(minhasAdmins || []).map((m) => m.team_id), ...(criados || []).map((t) => t.id)])];
  const timesApagados = [];
  const timesTransferidos = [];
  const logosParaApagar = [];
  if (!idsRelevantes.length) return { timesApagados, timesTransferidos, logosParaApagar };

  const { data: times, error: e3 } = await supabase.from('teams').select('id, nome, slug, criado_por, logo_url').in('id', idsRelevantes);
  if (e3) throw new Error(`teams: ${e3.message}`);

  for (const time of times || []) {
    // eslint-disable-next-line no-await-in-loop
    const { data: membros, error: e4 } = await supabase.from('team_members').select('user_id, role, created_at').eq('team_id', time.id);
    if (e4) throw new Error(`team_members: ${e4.message}`);
    const outros = (membros || []).filter((m) => m.user_id !== userId);

    if (!outros.length) {
      if (time.logo_url) logosParaApagar.push(time.logo_url);
      // eslint-disable-next-line no-await-in-loop
      const { error: eDel } = await supabase.from('teams').delete().eq('id', time.id);
      if (eDel) throw new Error(`teams(delete ${time.slug}): ${eDel.message}`);
      timesApagados.push(time.slug);
      continue;
    }

    const outroAdmin = outros.find((m) => m.role === 'admin');
    let sucessorId = outroAdmin?.user_id;
    if (!sucessorId) {
      sucessorId = [...outros].sort(porAntiguidade)[0].user_id;
      // eslint-disable-next-line no-await-in-loop
      const { error: eRole } = await supabase.from('team_members').update({ role: 'admin' }).eq('team_id', time.id).eq('user_id', sucessorId);
      if (eRole) throw new Error(`team_members(promover em ${time.slug}): ${eRole.message}`);
    }
    if (time.criado_por === userId) {
      // eslint-disable-next-line no-await-in-loop
      const { error: eCriador } = await supabase.from('teams').update({ criado_por: sucessorId }).eq('id', time.id);
      if (eCriador) throw new Error(`teams(criado_por em ${time.slug}): ${eCriador.message}`);
      timesTransferidos.push({ slug: time.slug, novoAdmin: sucessorId });
    }
  }
  return { timesApagados, timesTransferidos, logosParaApagar };
}

/** Junta todos os URLs de Storage do usuário: avatar/foto, slots, fotos de
 *  campeão, mídia de posts e comentários dele na Resenha. */
async function coletarUrlsStorage(userId) {
  const urls = [];
  const add = (u) => { if (u) urls.push(u); };

  const { data: userRow } = await supabase.from('users').select('avatar_url, foto_url').eq('id', userId).maybeSingle();
  add(userRow?.avatar_url);
  add(userRow?.foto_url);

  // user_avatar_slots — sem migração commitada (schema desconhecido); defensivo.
  try {
    const { data: slots, error } = await supabase.from('user_avatar_slots').select('avatar_url').eq('user_id', userId);
    if (error) throw new Error(error.message);
    (slots || []).forEach((s) => add(s.avatar_url));
  } catch (e) {
    console.warn('[apagarUsuario] user_avatar_slots (leitura) indisponível:', e.message);
  }

  const { data: campeao } = await supabase.from('champion_photos').select('url').eq('user_id', userId);
  (campeao || []).forEach((c) => add(c.url));

  // feed_posts (Resenha) do usuário → feed_post_media (2 passos).
  const { data: posts } = await supabase.from('feed_posts').select('id').eq('author_id', userId);
  const postIds = (posts || []).map((p) => p.id);
  if (postIds.length) {
    const { data: media } = await supabase.from('feed_post_media').select('url').in('post_id', postIds);
    (media || []).forEach((m) => add(m.url));
  }

  // comentarios do usuário → comentario_anexos (2 passos).
  const { data: comentarios } = await supabase.from('comentarios').select('id').eq('author_id', userId);
  const comentarioIds = (comentarios || []).map((c) => c.id);
  if (comentarioIds.length) {
    const { data: anexos } = await supabase.from('comentario_anexos').select('url').in('comentario_id', comentarioIds);
    (anexos || []).forEach((a) => add(a.url));
  }

  return urls;
}

/**
 * Apaga um usuário por completo: resolve os times dele (sucessão ou
 * exclusão), limpa o Storage, os logs sem FK, os slots de avatar IA e por
 * fim a conta em si (cascade cuida do resto). O Storage é best-effort (nunca
 * aborta a exclusão por um ficheiro que não sai); os passos de banco lançam
 * se falharem — melhor parar e avisar do que deixar a conta "meio excluída".
 *
 * Nunca loga e-mail — só o id.
 * @returns {Promise<{ timesApagados: string[], timesTransferidos: {slug:string, novoAdmin:string}[], fotosRemovidas: number }>}
 */
async function apagarUsuario(userId) {
  const { timesApagados, timesTransferidos, logosParaApagar } = await resolverTimes(userId);

  const urls = [...(await coletarUrlsStorage(userId)), ...logosParaApagar];
  const urlsPorBucket = { avatars: [], resenha: [] };
  for (const url of urls) {
    // bucketEcaminho (não parseUrlPublico): a mídia da Resenha guardada em
    // feed_post_media/comentario_anexos é sempre a URL do PROXY desde o
    // Tijolo 2 — sem isto, essas URLs nunca entravam em urlsPorBucket e a
    // conta apagada deixava fotos/comentários órfãos no bucket resenha para
    // sempre (achado real, Rodada 15 — mesma causa do item 3 em feed.js).
    const p = bucketEcaminho(url);
    if (p) urlsPorBucket[p.bucket].push(url);
  }
  let fotosRemovidas = 0;
  for (const bucket of Object.keys(urlsPorBucket)) {
    if (!urlsPorBucket[bucket].length) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await removerFicheirosPorUrl(bucket, urlsPorBucket[bucket]);
    fotosRemovidas += r.removidos;
    if (r.erro) console.warn(`[apagarUsuario] Storage (${bucket}): ${r.erro}`);
  }
  // Ficheiro temporário determinístico (routes/auth.js: tmp/${userId}-pad.jpg,
  // gerado durante a geração de avatar IA) — best-effort, é efêmero.
  const { error: tmpErr } = await supabase.storage.from('avatars').remove([`tmp/${userId}-pad.jpg`]);
  if (tmpErr) console.warn('[apagarUsuario] avatars/tmp (aviso, efêmero):', tmpErr.message);

  const { error: logErr } = await supabase.from('geracao_ia_log').delete().eq('user_id', userId);
  if (logErr) throw new Error(`geracao_ia_log: ${logErr.message}`);

  try {
    const { error: slotsErr } = await supabase.from('user_avatar_slots').delete().eq('user_id', userId);
    if (slotsErr) throw new Error(slotsErr.message);
  } catch (e) {
    console.warn('[apagarUsuario] user_avatar_slots (delete) indisponível:', e.message);
  }

  const { error: delErr } = await supabase.auth.admin.deleteUser(userId);
  if (delErr) throw new Error(`auth.admin.deleteUser: ${delErr.message}`);

  console.log('[conta] excluída', userId);
  return { timesApagados, timesTransferidos, fotosRemovidas };
}

module.exports = { apagarUsuario, resolverTimes, coletarUrlsStorage };
