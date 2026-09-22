// Futty v2.0 — Quem pode gerar uma Figurinha Brilhante (SPEC-FIGURINHA-3, §5).
//
// Desde 22-set toda geração de IA nasce paga. Há dois direitos:
//
//   1. CRÉDITO  `users.brilhante_creditos > 0` — comprou a "Minha Brilhante"
//      (+2) ou ganhou o presente de criador de time (+1, uma vez na vida).
//      O uniforme é à escolha entre os 5.
//   2. TIME     é membro de um time com `teams.brilhante_ativo` e ainda não
//      tem linha em `brilhantes_time` para (team_id, user_id), dentro de
//      `teams.brilhante_limite` (25). O uniforme é o do time
//      (`teams.brilhante_kit`), fixado pelo dono.
//
// Depende da migração 054. SEM ela aplicada tudo aqui falha SEGURO: devolve
// `{ fonte: null }` e regista um aviso — ninguém gera, ninguém gasta dinheiro.
// É o contrário do fail-open da cota da Resenha (utils/resenhaCota.js): lá o
// pior caso é um time passar da cota; aqui seria a casa pagar US$0,11 por
// cadastro, que é exatamente o que esta spec veio acabar.
const { supabase } = require('./db');

/** O erro é "a coluna/tabela ainda não existe" e não um problema real? */
function ehMigracaoEmFalta(mensagem = '') {
  return /brilhante|pedidos_ativacao|manto_proprio|presente_criador|does not exist|schema cache/i.test(mensagem);
}

/**
 * Os direitos de uma pessoa, em ordem de uso.
 *
 * Devolve `{ fonte, teamId, kitId, creditos, opcoes }`:
 *   fonte    'time' | 'credito' | null   o direito que será gasto por omissão
 *   teamId   o time, quando fonte='time'
 *   kitId    o uniforme obrigatório, quando fonte='time' (null no crédito:
 *            quem tem crédito escolhe)
 *   creditos quantos créditos a pessoa tem (para o contador da tela)
 *   opcoes   todos os direitos encontrados — a rota usa isto para honrar um
 *            kit pedido que não seja o do time (ver POST /api/me/avatar/ai)
 *
 * A PREFERÊNCIA é o time, não o crédito (a spec não diz qual gastar
 * primeiro): o direito do time é grátis para a pessoa, está limitado a 25 e
 * morre com o pacote; o crédito é dela, foi pago e escolhe uniforme. Gastar
 * primeiro o que não é dela é o lado generoso do erro.
 */
async function temDireito(userId) {
  const vazio = { fonte: null, teamId: null, kitId: null, creditos: 0, opcoes: [] };
  if (!userId) return vazio;

  let creditos = 0;
  try {
    const { data, error } = await supabase
      .from('users')
      .select('brilhante_creditos')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    creditos = Number(data?.brilhante_creditos) || 0;
  } catch (e) {
    console.warn('[direitoBrilhante] créditos indisponíveis (migração 054 aplicada?):', e.message);
    if (!ehMigracaoEmFalta(e.message)) throw e;
    return vazio;
  }

  const opcoes = [];
  try {
    // Os times ATIVOS de que a pessoa é membro, com o uniforme e o tecto.
    const { data: membros, error: erroMembros } = await supabase
      .from('team_members')
      .select('team_id, teams!inner(id, brilhante_ativo, brilhante_kit, brilhante_limite)')
      .eq('user_id', userId)
      .eq('teams.brilhante_ativo', true);
    if (erroMembros) throw new Error(erroMembros.message);

    for (const m of membros || []) {
      const time = m.teams;
      if (!time?.brilhante_kit) continue; // pacote ativo sem uniforme escolhido: não dá para gerar
      // Já tem a dele neste time?
      const { data: jaTem, error: erroJa } = await supabase
        .from('brilhantes_time')
        .select('user_id')
        .eq('team_id', time.id)
        .eq('user_id', userId)
        .maybeSingle();
      if (erroJa) throw new Error(erroJa.message);
      if (jaTem) continue;
      // O time ainda cabe no tecto?
      const { count, error: erroConta } = await supabase
        .from('brilhantes_time')
        .select('user_id', { count: 'exact', head: true })
        .eq('team_id', time.id);
      if (erroConta) throw new Error(erroConta.message);
      const limite = Number(time.brilhante_limite) || 25;
      if ((count || 0) >= limite) continue;
      opcoes.push({ fonte: 'time', teamId: time.id, kitId: time.brilhante_kit });
    }
  } catch (e) {
    console.warn('[direitoBrilhante] direito de time indisponível (migração 054 aplicada?):', e.message);
    if (!ehMigracaoEmFalta(e.message)) throw e;
    // Sem a tabela do pacote fica só o crédito — que já foi lido acima.
  }

  if (creditos > 0) opcoes.push({ fonte: 'credito', teamId: null, kitId: null });

  const escolhido = opcoes[0] || { fonte: null, teamId: null, kitId: null };
  return { ...escolhido, creditos, opcoes };
}

/**
 * Debita o direito DEPOIS de a geração ter corrido bem — nunca antes: uma
 * geração que falha (fal fora do ar, coroa cortada no retry, foto
 * desatualizada) não pode custar o crédito de ninguém.
 *
 * Best-effort com aviso: se isto falhar, a pessoa fica com a Brilhante e com
 * o direito por gastar. O contrário — cobrar e não entregar — seria pior.
 */
async function debitar(direito, { userId, kitId, avatarUrl, custoCents }) {
  try {
    if (direito?.fonte === 'time') {
      const { error } = await supabase.from('brilhantes_time').upsert(
        {
          team_id: direito.teamId,
          user_id: userId,
          kit_id: kitId,
          avatar_url: avatarUrl,
          custo_cents: custoCents == null ? null : Math.round(custoCents),
          gerada_em: new Date().toISOString(),
        },
        { onConflict: 'team_id,user_id' },
      );
      if (error) throw new Error(error.message);
      console.log('[direitoBrilhante] debitado do pacote do time', { userId, teamId: direito.teamId, kitId });
      return true;
    }
    if (direito?.fonte === 'credito') {
      // Lê-e-escreve em vez de um decremento atómico: o Supabase não expõe
      // `update ... set x = x - 1` pelo PostgREST sem uma função, e uma
      // pessoa não gera duas Brilhantes ao mesmo tempo (o botão desativa
      // durante os ~45 s). GREATEST(0) no cliente para nunca ir a negativo.
      const { data, error: erroLer } = await supabase
        .from('users').select('brilhante_creditos').eq('id', userId).maybeSingle();
      if (erroLer) throw new Error(erroLer.message);
      const novo = Math.max(0, (Number(data?.brilhante_creditos) || 0) - 1);
      const { error } = await supabase.from('users').update({ brilhante_creditos: novo }).eq('id', userId);
      if (error) throw new Error(error.message);
      console.log('[direitoBrilhante] crédito debitado', { userId, restam: novo });
      return true;
    }
  } catch (e) {
    console.error('[direitoBrilhante] NÃO consegui debitar (a pessoa ficou com a Brilhante e com o direito):', {
      userId, fonte: direito?.fonte, erro: e.message,
    });
  }
  return false;
}

/**
 * O presente de quem cria o primeiro time: +1 crédito, uma vez na vida
 * (`users.presente_criador_em`). Devolve true se o presente foi dado agora.
 * Best-effort: um time nunca deixa de ser criado por causa disto.
 */
async function presentearCriador(userId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('brilhante_creditos, presente_criador_em')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data?.presente_criador_em) return false; // já recebeu

    const { error: erroUpd } = await supabase
      .from('users')
      .update({
        brilhante_creditos: (Number(data?.brilhante_creditos) || 0) + 1,
        presente_criador_em: new Date().toISOString(),
      })
      .eq('id', userId)
      .is('presente_criador_em', null); // corrida: só ganha quem chegar primeiro
    if (erroUpd) throw new Error(erroUpd.message);
    console.log('[direitoBrilhante] presente do criador dado', { userId });
    return true;
  } catch (e) {
    console.warn('[direitoBrilhante] presente do criador não dado (migração 054 aplicada?):', e.message);
    return false;
  }
}

module.exports = { temDireito, debitar, presentearCriador, ehMigracaoEmFalta };
