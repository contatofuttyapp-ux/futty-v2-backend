// Futty v2.0 — Rodada 29I, bloco 3 (item 4): as notificações que cada pessoa quer receber.
//
// Perfil → Notificações tem um interruptor por tipo. Todos ligados por padrão: `users.notificacoes` (migração 079) guarda só o
// que a pessoa DESLIGOU — {"pedidos": false}; chave ausente = ligada. Vale para o push e para o aviso dentro do app.
// Sem a migração 079 a coluna não existe: ninguém tem nada desligado (como sempre foi) e gravar responde 503.
// Puro, menos `quemQuer` (que lê o banco que lhe passam), para testar no Node.

/** Os tipos, na ordem da tela. `pedidos` só aparece para quem administra algum time. */
const CATEGORIAS = ['jogos', 'pedidos', 'figurinha', 'resenha'];

/** O que está guardado → as 4 chaves, todas presentes (true = ligada). */
function preferenciasCompletas(guardado) {
  const g = guardado && typeof guardado === 'object' && !Array.isArray(guardado) ? guardado : {};
  return Object.fromEntries(CATEGORIAS.map((c) => [c, g[c] !== false]));
}

/**
 * Lê o corpo do PATCH e devolve o que vai para a coluna: só as chaves DESLIGADAS (o resto some — ligada é o padrão).
 * Junta com o que já estava guardado; chave desconhecida ou valor que não é booleano = erro (400).
 */
function mesclarPreferencias(guardado, corpo) {
  const atual = preferenciasCompletas(guardado);
  for (const [chave, valor] of Object.entries(corpo || {})) {
    if (!CATEGORIAS.includes(chave)) return { erro: 'Esse tipo de notificação não existe.' };
    if (typeof valor !== 'boolean') return { erro: 'Use ligado ou desligado.' };
    atual[chave] = valor;
  }
  const paraGravar = Object.fromEntries(CATEGORIAS.filter((c) => atual[c] === false).map((c) => [c, false]));
  return { paraGravar, preferencias: atual };
}

const erroDaColunaNotificacoes = (erro) => !!erro && /notificacoes/i.test(erro.message || '');

/**
 * Dos `ids`, os que querem receber `categoria`. Sem categoria (aviso que não se desliga, como o "Avisar o time" do admin) ou sem
 * a migração 079, todos. Um erro do banco nunca derruba o envio: na dúvida, manda (é o que a pessoa tinha antes).
 */
async function quemQuer(supabase, ids, categoria) {
  if (!categoria || !ids.length) return ids;
  try {
    const { data, error } = await supabase.from('users').select('id, notificacoes').in('id', ids);
    if (error) return ids;
    const desligou = new Set((data || []).filter((u) => u.notificacoes?.[categoria] === false).map((u) => u.id));
    return ids.filter((id) => !desligou.has(id));
  } catch {
    return ids;
  }
}

module.exports = { CATEGORIAS, preferenciasCompletas, mesclarPreferencias, erroDaColunaNotificacoes, quemQuer };
