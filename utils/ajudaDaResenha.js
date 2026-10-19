// Futty v2.0 — Ajudantes comuns das rotas da Resenha (routes/feed.js e os sub-roteadores dele): o bucket, de que time é um alvo e
// as reações de vários alvos de uma vez.

const { supabase } = require('./db');

const STORAGE_BUCKET = 'resenha';

/** Devolve o team_id do parent ('game' | 'post') ou null se não existir. */
async function parentTeamId(parentType, parentId) {
  if (parentType === 'game') {
    const { data } = await supabase.from('games').select('team_id').eq('id', parentId).maybeSingle();
    return data?.team_id || null;
  }
  if (parentType === 'post') {
    const { data } = await supabase.from('feed_posts').select('team_id').eq('id', parentId).maybeSingle();
    return data?.team_id || null;
  }
  return null;
}

/**
 * Devolve o team_id de um target de reação/denúncia.
 * Para 'comentario' resolve o parent do comentário; 'game'/'post' são diretos.
 */
async function targetTeamId(targetType, targetId) {
  if (targetType === 'comentario') {
    const { data } = await supabase
      .from('comentarios')
      .select('parent_type, parent_id')
      .eq('id', targetId)
      .maybeSingle();
    if (!data) return null;
    return parentTeamId(data.parent_type, data.parent_id);
  }
  return parentTeamId(targetType, targetId);
}

/**
 * Para um conjunto de targets do mesmo tipo, devolve um mapa
 * id -> { contagem: { emoji: N }, minha: emoji|null } com a reação do user.
 */
async function reacoesParaTargets(targetType, targetIds, userId) {
  const map = {};
  for (const id of targetIds) map[id] = { contagem: {}, minha: null };
  if (!targetIds.length) return map;

  const { data } = await supabase
    .from('reacoes')
    .select('target_id, user_id, emoji')
    .eq('target_type', targetType)
    .in('target_id', targetIds);

  for (const r of data || []) {
    const slot = map[r.target_id];
    if (!slot) continue;
    slot.contagem[r.emoji] = (slot.contagem[r.emoji] || 0) + 1;
    if (r.user_id === userId) slot.minha = r.emoji;
  }
  return map;
}

module.exports = { STORAGE_BUCKET, parentTeamId, targetTeamId, reacoesParaTargets };
