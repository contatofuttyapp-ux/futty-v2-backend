// Futty v2.0 — Bloqueio entre jogadores (exigência Apple UGC 1.2 — App Store Review
// Guidelines §1.2: apps com conteúdo gerado por utilizador têm de oferecer um
// mecanismo de bloqueio). Tabela `user_blocks` (DDL entregue ao dono, ver
// db/migrations/041_user_blocks.sql). Bloquear NUNCA notifica o bloqueado (silencioso).
const { supabase } = require('./db');

/** Conjunto mútuo: ids que NÃO se devem ver com `userId` (bloqueei OU fui bloqueado). */
async function conjuntoMutuo(userId) {
  const { data } = await supabase
    .from('user_blocks')
    .select('blocker_id, blocked_id')
    .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`);
  const set = new Set();
  for (const row of data || []) {
    if (row.blocker_id === userId) set.add(row.blocked_id);
    else set.add(row.blocker_id);
  }
  return set;
}

/** true se userId bloqueou outroId (direção única — usado para a lista "Bloqueados"). */
async function euBloqueei(userId, outroId) {
  const { data } = await supabase
    .from('user_blocks')
    .select('id')
    .eq('blocker_id', userId)
    .eq('blocked_id', outroId)
    .maybeSingle();
  return !!data;
}

module.exports = { conjuntoMutuo, euBloqueei };
