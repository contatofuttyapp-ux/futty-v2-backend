// Futty v2.0 — O post do campeão na Resenha: quando o campeonato (novo, do Storage) termina, a Resenha do time ganha UM post
// "<Time> é campeão · <campeonato>" com os jogadores do time campeão, o pódio e o placar da final. Um post só por campeonato: corrigir a
// final depois atualiza o MESMO post (as reações e os comentários ficam, porque o id é o mesmo).
//
// Sem migração: é uma linha de `feed_posts` (tipo 'post', que o CHECK da coluna aceita) com o retrato em `conteudo` (jsonb que já
// existe) marcado por `conteudo.tipo = 'campeao_campeonato'`. O autor é quem lançou o resultado (a coluna é obrigatória); a
// Resenha não mostra autor neste post.
const store = require('./campeonatoStore');

/**
 * Cria o post do campeão (ou atualiza o que já existe). Devolve o id do post, ou null se o campeonato ainda não tem campeão.
 * Nunca lança: a Resenha é um enfeite do resultado, e um erro aqui não pode desfazer o placar que o admin acabou de lançar.
 */
async function sincronizarPostDoCampeao({ supabase, team, camp, autorId, log = console }) {
  try {
    if (camp.estado !== 'terminado') return null;
    const pronto = store.conteudoDoPostDoCampeao(camp);
    if (!pronto) return null;
    const { body, conteudo } = pronto;

    // 1) o post que o campeonato já conhece; 2) por garantia, um post deste campeonato que o documento esqueceu de guardar.
    let postId = camp.post_id || null;
    if (!postId) {
      try {
        const achado = await supabase.from('feed_posts').select('id').eq('team_id', team.id).contains('conteudo', { tipo: 'campeao_campeonato', campeonato_id: camp.id }).limit(1).maybeSingle();
        postId = achado?.data?.id || null;
      } catch {
        // sem essa busca o post é criado como se fosse o primeiro: pior caso, um post a mais
      }
    }
    if (postId) {
      // Se o post foi apagado de propósito (pelo admin ou pelo autor), não ressuscita: o update simplesmente não acha linha.
      const { error } = await supabase.from('feed_posts').update({ body, conteudo, updated_at: new Date().toISOString() }).eq('id', postId).eq('team_id', team.id);
      if (error) throw error;
      return postId;
    }
    const { data, error } = await supabase.from('feed_posts').insert({ team_id: team.id, author_id: autorId, tipo: 'post', body, conteudo }).select('id').single();
    if (error) throw error;
    return data.id;
  } catch (e) {
    log.error('[Futty] post do campeão:', e?.message || e);
    return null;
  }
}

/** Apaga o post do campeão (o campeonato foi apagado). Também nunca lança. */
async function apagarPostDoCampeao({ supabase, team, camp, log = console }) {
  try {
    if (!camp.post_id) return;
    await supabase.from('feed_posts').delete().eq('id', camp.post_id).eq('team_id', team.id);
  } catch (e) {
    log.error('[Futty] apagar post do campeão:', e?.message || e);
  }
}

module.exports = { sincronizarPostDoCampeao, apagarPostDoCampeao };
