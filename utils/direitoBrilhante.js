// Futty v2.0 — Quem pode gerar uma Figurinha Brilhante (SPEC-FIGURINHA-3, §5).
//
// Desde 22-set toda geração de IA nasce paga. Há dois direitos:
//
//   1. CRÉDITO  `users.brilhante_creditos > 0` — comprou a "Minha Figurinha"
//      (+10) ou recebeu crédito à mão pelo Gabinete. O uniforme é à escolha
//      entre os 5. (O presente do criador de time, +3 ao criar o time, foi
//      ABOLIDO em 26-set pelo dono: conta grátis não gera nada, nunca.)
//   2. TIME     é membro de um time com `teams.brilhante_ativo` e ainda tem
//      geração no pacote: sem linha em `brilhantes_time` para
//      (team_id, user_id) OU `geracoes < teams.brilhante_por_jogador` (2,
//      migração 065; era 5 na 059), dentro de `teams.brilhante_limite` (25
//      jogadores). O uniforme é o do time (`teams.brilhante_kit`), fixado
//      pelo dono.
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
  return /brilhante|pedidos_ativacao|manto_proprio|does not exist|schema cache/i.test(mensagem);
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
    .select('user_id, geracoes, custo_cents')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!error) {
    return {
      existe: !!data,
      usadas: data ? (data.geracoes == null ? 1 : Number(data.geracoes)) : 0,
      // Rodada 28: o custo JÁ gasto nesta linha — a geração nova SOMA a ele (ver debitar).
      custoCents: data?.custo_cents ?? null,
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
  return { existe: !!antigo, usadas: antigo ? 1 : 0, custoCents: null, colunaExiste: false };
}

/**
 * RODADA 28 (achado da Rodada 22) — o custo de uma linha do pacote é a SOMA das gerações dela.
 * O upsert gravava o custo da geração atual por cima do anterior: refazer 5 vezes deixava no
 * Gabinete só o custo da última. Sem custo nenhum conhecido fica null (o Gabinete conta à parte
 * as gerações sem custo gravado, para o total não se passar por completo).
 */
function somarCusto(anteriorCents, destaCents) {
  if (anteriorCents == null && destaCents == null) return null;
  return Math.round((Number(anteriorCents) || 0) + (Number(destaCents) || 0));
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
      // Rodada 29A: o pacote caiu de 5 para 2. Quem já tinha gasto mais de 2 antes da mudança
      // fica sem geração nova — e `restantes` nunca sai negativo (clamp em 0 logo abaixo).
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
      opcoes.push({ fonte: 'time', teamId: time.id, kitId: time.brilhante_kit, restantes: Math.max(0, porJogador - usadas) });
    }
  } catch (e) {
    console.warn('[direitoBrilhante] direito de time indisponível (migração 054 aplicada?):', e.message);
    if (!ehMigracaoEmFalta(e.message)) throw e;
    // Sem a tabela do pacote fica só o crédito — que já foi lido acima.
  }

  if (creditos > 0) opcoes.push({ fonte: 'credito', teamId: null, kitId: null, restantes: Math.max(0, creditos) });

  const escolhido = opcoes[0] || { fonte: null, teamId: null, kitId: null, restantes: 0 };
  return { ...escolhido, creditos, opcoes };
}

/** A função creditar_brilhante (migração 064) ainda não existe neste banco? */
function ehFuncaoEmFalta(erro) {
  return /creditar_brilhante|PGRST202|could not find the function|does not exist|schema cache/i.test(`${erro?.code || ''} ${erro?.message || ''}`);
}

/**
 * Soma `qtd` (negativo debita) a `users.brilhante_creditos` e devolve o saldo
 * novo — nunca abaixo de zero. Pagamentos P1: pela função atómica da migração
 * 064 (`update ... set x = x + n` num passo só); o ler-e-gravar antigo perdia
 * uma soma quando duas escritas caíam juntas (webhook + restaurar compras).
 * Sem a 064 no banco, cai no ler-e-gravar de sempre com aviso — nunca quebra.
 * `cliente` injetável para os testes de utils/compras.js (Supabase falso).
 */
async function somarCreditos(userId, qtd, cliente = supabase) {
  if (typeof cliente.rpc === 'function') {
    const { data, error } = await cliente.rpc('creditar_brilhante', { p_user: userId, p_qtd: qtd });
    if (!error) {
      if (data == null) throw new Error('Pessoa não encontrada para creditar.');
      return Number(data);
    }
    if (!ehFuncaoEmFalta(error)) throw new Error(error.message);
  }
  console.warn('[direitoBrilhante] creditar_brilhante indisponível (migração 064 aplicada?) — soma lida-e-gravada');
  const { data, error: erroLer } = await cliente
    .from('users').select('brilhante_creditos').eq('id', userId).maybeSingle();
  if (erroLer) throw new Error(erroLer.message);
  if (!data) throw new Error('Pessoa não encontrada para creditar.');
  const novo = Math.max(0, (Number(data.brilhante_creditos) || 0) + qtd);
  const { error } = await cliente.from('users').update({ brilhante_creditos: novo }).eq('id', userId);
  if (error) throw new Error(error.message);
  return novo;
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
      // Rodadas 21/22/29A — o pacote dá várias gerações por jogador (2 desde a 29A), não 1:
      // `geracoes` conta quantas essa pessoa já usou NESTE time, e o upsert
      // tem de a SOMAR, não substituir. Lê-e-escreve (uma pessoa não gera
      // duas ao mesmo tempo) — sem linha ainda, começa de 0 (a que está a nascer é a 1ª).
      const { usadas, custoCents: jaGasto, colunaExiste } = await geracoesNoTime(direito.teamId, userId);
      const linha = {
        team_id: direito.teamId,
        user_id: userId,
        kit_id: kitId,
        avatar_url: avatarUrl,
        // Rodada 28: SOMA à linha (antes o upsert punha só o custo desta geração por cima).
        custo_cents: somarCusto(jaGasto, custoCents),
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
      const novo = await somarCreditos(userId, -1);
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

module.exports = { temDireito, debitar, somarCreditos, ehMigracaoEmFalta, somarCusto };
