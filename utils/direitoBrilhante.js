// Futty v2.0 — Quem pode gerar uma Figurinha Brilhante (SPEC-FIGURINHA-3, §5).
//
// Desde 22-set toda geração de IA nasce paga. Há dois direitos:
//
//   1. CRÉDITO  `users.brilhante_creditos > 0` — comprou a "Minha Brilhante"
//      (+10, Rodada 21) ou ganhou o presente de criador de time (+3, Rodada
//      21, uma vez na vida). O uniforme é à escolha entre os 5.
//   2. TIME     é membro de um time com `teams.brilhante_ativo` e ainda tem
//      geração no pacote: sem linha em `brilhantes_time` para
//      (team_id, user_id) OU `geracoes < teams.brilhante_por_jogador` (3,
//      migração 059), dentro de `teams.brilhante_limite` (25 jogadores). O
//      uniforme é o do time (`teams.brilhante_kit`), fixado pelo dono.
//
// Depende da migração 054. SEM ela aplicada tudo aqui falha SEGURO: devolve
// `{ fonte: null }` e regista um aviso — ninguém gera, ninguém gasta dinheiro.
// É o contrário do fail-open da cota da Resenha (utils/resenhaCota.js): lá o
// pior caso é um time passar da cota; aqui seria a casa pagar US$0,11 por
// cadastro, que é exatamente o que esta spec veio acabar.
//
// Migração 059 (Rodada 21) é o MESMO tipo de fail-safe: sem a coluna
// `geracoes`, o motor lê "existe linha = já gerou a única vez que se sabia
// dar" (o comportamento de antes da 059) — nunca deixa passar mais gerações
// do que o banco sabe contar.
const { supabase } = require('./db');

/** O erro é "a coluna/tabela ainda não existe" e não um problema real? */
function ehMigracaoEmFalta(mensagem = '') {
  return /brilhante|pedidos_ativacao|manto_proprio|presente_criador|does not exist|schema cache/i.test(mensagem);
}

/**
 * Quantas gerações a pessoa já usou neste time, e se a linha existe.
 * Fail-safe da migração 059: sem a coluna `geracoes`, só dá para saber SE
 * existe linha — trata-se então como "já usou a única que se sabia dar" (o
 * comportamento de antes da 059), nunca inventando um número.
 */
async function geracoesNoTime(teamId, userId) {
  const { data, error } = await supabase
    .from('brilhantes_time')
    .select('user_id, geracoes')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!error) {
    return {
      existe: !!data,
      usadas: data ? (data.geracoes == null ? 1 : Number(data.geracoes)) : 0,
      colunaExiste: true,
    };
  }
  if (!ehMigracaoEmFalta(error.message)) throw new Error(error.message);
  const { data: antigo, error: erroAntigo } = await supabase
    .from('brilhantes_time')
    .select('user_id')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .maybeSingle();
  if (erroAntigo) throw new Error(erroAntigo.message);
  // colunaExiste:false avisa o debitar() para NÃO escrever `geracoes` no
  // upsert (coluna ainda não existe) — deixa o banco/comportamento antigo.
  return { existe: !!antigo, usadas: antigo ? 1 : 0, colunaExiste: false };
}

/**
 * Os direitos de uma pessoa, em ordem de uso.
 *
 * Devolve `{ fonte, teamId, kitId, creditos, restantes, opcoes }`:
 *   fonte     'time' | 'credito' | null   o direito que será gasto por omissão
 *   teamId    o time, quando fonte='time'
 *   kitId     o uniforme obrigatório, quando fonte='time' (null no crédito:
 *             quem tem crédito escolhe)
 *   creditos  quantos créditos a pessoa tem (para o contador da tela)
 *   restantes gerações que sobram no direito ESCOLHIDO (creditos, ou
 *             brilhante_por_jogador - geracoes usadas no time) — é o "N" do
 *             contador e do diálogo de confirmação na Figurinha
 *   opcoes    todos os direitos encontrados — a rota usa isto para honrar um
 *             kit pedido que não seja o do time (ver POST /api/me/avatar/ai)
 *
 * A PREFERÊNCIA é o time, não o crédito (a spec não diz qual gastar
 * primeiro): o direito do time é grátis para a pessoa, está limitado a 25 e
 * morre com o pacote; o crédito é dela, foi pago e escolhe uniforme. Gastar
 * primeiro o que não é dela é o lado generoso do erro.
 */
async function temDireito(userId) {
  const vazio = { fonte: null, teamId: null, kitId: null, creditos: 0, restantes: 0, opcoes: [] };
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
      .select('team_id, teams!inner(id, brilhante_ativo, brilhante_kit, brilhante_limite, brilhante_por_jogador)')
      .eq('user_id', userId)
      .eq('teams.brilhante_ativo', true);
    if (erroMembros) throw new Error(erroMembros.message);

    for (const m of membros || []) {
      const time = m.teams;
      if (!time?.brilhante_kit) continue; // pacote ativo sem uniforme escolhido: não dá para gerar
      // Quantas gerações já usou neste time, das que o pacote dá?
      const { usadas } = await geracoesNoTime(time.id, userId);
      // Fail-safe: `brilhante_por_jogador` também some se a 059 não rodou —
      // 1 mantém o comportamento de antes dela (uma geração por jogador).
      const porJogador = Number(time.brilhante_por_jogador) || 1;
      if (usadas >= porJogador) continue;
      // O time ainda cabe no tecto de JOGADORES (25), não de gerações: uma
      // pessoa que já gerou conta 1 só, mesmo tendo refeito 2 vezes.
      const { count, error: erroConta } = await supabase
        .from('brilhantes_time')
        .select('user_id', { count: 'exact', head: true })
        .eq('team_id', time.id);
      if (erroConta) throw new Error(erroConta.message);
      const limite = Number(time.brilhante_limite) || 25;
      if ((count || 0) >= limite && usadas === 0) continue; // já tem linha: refazer não esbarra no tecto de jogadores
      opcoes.push({ fonte: 'time', teamId: time.id, kitId: time.brilhante_kit, restantes: porJogador - usadas });
    }
  } catch (e) {
    console.warn('[direitoBrilhante] direito de time indisponível (migração 054 aplicada?):', e.message);
    if (!ehMigracaoEmFalta(e.message)) throw e;
    // Sem a tabela do pacote fica só o crédito — que já foi lido acima.
  }

  if (creditos > 0) opcoes.push({ fonte: 'credito', teamId: null, kitId: null, restantes: creditos });

  const escolhido = opcoes[0] || { fonte: null, teamId: null, kitId: null, restantes: 0 };
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
      // Rodada 21 — o pacote passou a dar 3 gerações por jogador, não 1:
      // `geracoes` conta quantas essa pessoa já usou NESTE time, e o upsert
      // tem de a SOMAR, não substituir. Lê-e-escreve, mesmo padrão do crédito
      // abaixo — sem linha ainda, começa de 0 (a que está a nascer é a 1ª).
      const { usadas, colunaExiste } = await geracoesNoTime(direito.teamId, userId);
      const linha = {
        team_id: direito.teamId,
        user_id: userId,
        kit_id: kitId,
        avatar_url: avatarUrl,
        custo_cents: custoCents == null ? null : Math.round(custoCents),
        gerada_em: new Date().toISOString(),
      };
      // Sem a migração 059, a coluna nem existe — escrevê-la rebentaria o
      // upsert. Fica de fora e o banco segue com o valor/default de sempre.
      if (colunaExiste) linha.geracoes = usadas + 1;
      const { error } = await supabase.from('brilhantes_time').upsert(linha, { onConflict: 'team_id,user_id' });
      if (error) throw new Error(error.message);
      console.log('[direitoBrilhante] debitado do pacote do time', { userId, teamId: direito.teamId, kitId, geracoes: usadas + 1 });
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

// Rodada 21 (24-set): o presente do criador subiu de 1 para 3 gerações.
const PRESENTE_CRIADOR_CREDITOS = 3;

/**
 * O presente de quem cria o primeiro time: +3 créditos (Rodada 21), uma vez
 * na vida (`users.presente_criador_em`). Devolve true se o presente foi dado
 * agora. Best-effort: um time nunca deixa de ser criado por causa disto.
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
        brilhante_creditos: (Number(data?.brilhante_creditos) || 0) + PRESENTE_CRIADOR_CREDITOS,
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

module.exports = { temDireito, debitar, presentearCriador, ehMigracaoEmFalta, PRESENTE_CRIADOR_CREDITOS };
