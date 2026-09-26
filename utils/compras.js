// Futty v2.0 — Compras: a regra de crédito num lugar só (Pagamentos P1, 26-set).
//
// Toda concessão de figurinha passa por aqui, venha de onde vier: a loja (webhook do
// RevenueCat, routes/compras.js), o "Restaurar compras" do app, ou a mão do dono no
// Gabinete (loja 'gabinete', transação `gab-<uuid>`, preço 0). Cada uma vira UMA linha em
// `compras` (migração 064) — e o índice único (loja, transacao_id) é a trava contra
// crédito em dobro: o RevenueCat reenvia webhooks e o restauro pode chegar antes ou
// depois dele, com a mesma transação.
//
// A ordem é: grava a linha → aplica o efeito → marca creditada_em. Se o efeito falhar, a
// linha é apagada e o erro sobe (o webhook responde 5xx e o RevenueCat reenvia). Crédito
// sem linha nunca existe; linha sem crédito só dura o tempo de um erro.
//
// Fábrica com o Supabase e o push injetáveis: os testes (tests/compras.test.js) correm
// sem banco, com um Supabase falso em memória.
const crypto = require('node:crypto');
const { supabase: supabaseReal } = require('./db');
const { somarCreditos } = require('./direitoBrilhante');

// Rodada 21 (24-set): a Minha Figurinha dá 10 gerações.
const MINHA_GERACOES = 10;
const PRODUTOS = ['minha', 'pacote', 'manto'];
const LOJAS = ['app_store', 'play_store', 'promo', 'gabinete', 'outra'];

/** Erro de regra (não de banco): a compra não pode ser aplicada como veio. */
class ErroCompra extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.codigo = codigo;
  }
}

/** A tabela `compras` / coluna nova da 064 ainda não existe neste banco? */
function ehTabelaEmFalta(mensagem = '') {
  return /compras|brilhante_origem|does not exist|schema cache|PGRST205|42P01|42703/i.test(mensagem);
}

/** Push lido na hora (routes/push carrega o web-push): só quem notifica paga o require. */
function notificarReal(ids, payload) {
  // eslint-disable-next-line global-require
  return require('../routes/push').enviarNotificacao(ids, payload);
}

function criarCompras({ supabase = supabaseReal, notificar = notificarReal } = {}) {
  /** Resolve pedidos pendentes (estado 'ativado'). Best-effort: nunca derruba a ativação. */
  async function resolverPedidos(filtro) {
    try {
      let q = supabase.from('pedidos_ativacao').update({ estado: 'ativado', resolvido_em: new Date().toISOString() }).eq('estado', 'pendente');
      for (const [col, val] of Object.entries(filtro)) q = q.eq(col, val);
      const { error } = await q;
      if (error) throw new Error(error.message);
    } catch (e) {
      console.warn('[compras] pedidos não resolvidos:', e.message);
    }
  }

  /** O pedido 'manto' pendente do time existe (cria se faltar). Best-effort: nunca derruba a compra. */
  async function garantirPedidoManto(userId, teamId) {
    try {
      const { error } = await supabase.from('pedidos_ativacao').insert({ user_id: userId, team_id: teamId, produto: 'manto' });
      // 23505: o índice único parcial da 054 — já há um pendente igual, que é o que se queria.
      if (error && error.code !== '23505') throw new Error(error.message);
    } catch (e) {
      console.warn('[compras] pedido do manto não criado:', e.message);
    }
  }

  async function buscarCompra(loja, transacaoId) {
    const { data, error } = await supabase
      .from('compras')
      .select('id, user_id, team_id, produto, loja, estado, transacao_id')
      .eq('loja', loja)
      .eq('transacao_id', transacaoId)
      .maybeSingle();
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    return data;
  }

  /** Dono do time = membro com role 'admin' (o mesmo critério do POST /api/brilhantes/pedido). */
  async function ehDono(teamId, userId) {
    const { data, error } = await supabase
      .from('team_members').select('role').eq('team_id', teamId).eq('user_id', userId).maybeSingle();
    if (error) throw new Error(error.message);
    return data?.role === 'admin';
  }

  async function lerTime(teamId) {
    const { data, error } = await supabase
      .from('teams').select('id, nome, brilhante_ativo, brilhante_kit').eq('id', teamId).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  /** Liga o pacote. Sem a 064 (coluna brilhante_origem), liga sem ela — só o Gabinete chega aqui assim. */
  async function ligarPacote(teamId, { kitId, loja }) {
    const patch = { brilhante_ativo: true, brilhante_ativado_em: new Date().toISOString(), brilhante_kit: kitId, brilhante_origem: loja };
    const { error } = await supabase.from('teams').update(patch).eq('id', teamId);
    if (!error) return;
    if (!/brilhante_origem/i.test(error.message)) throw new Error(error.message);
    console.warn('[compras] teams.brilhante_origem em falta (migração 064 aplicada?) — pacote ligado sem a origem');
    delete patch.brilhante_origem;
    const { error: erro2 } = await supabase.from('teams').update(patch).eq('id', teamId);
    if (erro2) throw new Error(erro2.message);
  }

  /**
   * Aplica uma compra. Devolve `{ repetida: true }` se a transação já estava gravada (nada
   * é creditado de novo), ou `{ repetida: false, compraId, produto, ... }`.
   *
   * `kitId` e `quantidade` só valem para a loja 'gabinete' (o dono escolhe o uniforme ao
   * ativar e dá de 1 a 25 créditos); na loja o pacote herda o kit que o time já tiver e a
   * Minha Figurinha dá sempre MINHA_GERACOES.
   *
   * Lança ErroCompra (regra) — PRODUTO_INVALIDO, SEM_USUARIO, SEM_TIME, TIME_NAO_EXISTE,
   * NAO_E_DONO, SEM_PACOTE — antes de gravar nada; qualquer outro erro é de banco.
   */
  async function aplicarCompra({
    userId, teamId = null, produto, loja, transacaoId, transacaoOriginalId = null, eventoId = null,
    appUserId = null, moeda = null, preco = null, precoUsd = null, ambiente = 'producao', payload = null,
    kitId = null, quantidade = null,
  }) {
    if (!PRODUTOS.includes(produto)) throw new ErroCompra('PRODUTO_INVALIDO', `Produto desconhecido: ${produto}`);
    if (!LOJAS.includes(loja) || loja === 'outra') throw new ErroCompra('LOJA_INVALIDA', `Loja inválida: ${loja}`);
    if (!transacaoId) throw new ErroCompra('SEM_TRANSACAO', 'Transação em falta.');
    if (!userId) throw new ErroCompra('SEM_USUARIO', 'Comprador em falta.');
    const doGabinete = loja === 'gabinete';

    // Idempotência, 1ª linha: a transação já está gravada? (A 2ª é o índice único, abaixo.)
    let registra = true;
    try {
      const existente = await buscarCompra(loja, transacaoId);
      if (existente) return { repetida: true, compraId: existente.id, produto: existente.produto, estado: existente.estado };
    } catch (e) {
      // Sem a 064, só o Gabinete segue (a concessão manual não pode parar por isso). A loja
      // NÃO: sem a tabela não há trava contra crédito em dobro — 5xx e o RevenueCat reenvia.
      if (!(doGabinete && ehTabelaEmFalta(e.message))) throw e;
      console.warn('[compras] tabela compras em falta (migração 064 aplicada?) — concessão do Gabinete sem registro');
      registra = false;
    }

    // Regras do produto — ANTES de gravar qualquer coisa.
    let time = null;
    if (produto === 'pacote' || produto === 'manto') {
      if (!teamId) throw new ErroCompra('SEM_TIME', 'O pacote e o manto são de um time: team_id em falta.');
      time = await lerTime(teamId);
      if (!time) throw new ErroCompra('TIME_NAO_EXISTE', 'Time não encontrado.');
      if (!doGabinete && !(await ehDono(teamId, userId))) throw new ErroCompra('NAO_E_DONO', 'Só o dono do time compra o pacote ou o manto.');
      if (produto === 'manto' && !time.brilhante_ativo) throw new ErroCompra('SEM_PACOTE', 'O manto próprio exige o pacote do time ativo.');
    }

    let compraId = null;
    if (registra) {
      const linha = {
        user_id: userId,
        team_id: teamId,
        produto,
        loja,
        transacao_id: String(transacaoId),
        transacao_original_id: transacaoOriginalId,
        evento_id: eventoId,
        app_user_id: appUserId,
        moeda,
        preco,
        preco_usd: precoUsd,
        ambiente,
        estado: 'creditada',
        payload,
      };
      const { data, error } = await supabase.from('compras').insert(linha).select('id').single();
      if (error) {
        // 23505: outra entrega da mesma transação ganhou a corrida — ela credita, esta não.
        if (error.code === '23505') return { repetida: true, produto };
        throw Object.assign(new Error(error.message), { code: error.code });
      }
      compraId = data.id;
    }

    const resultado = { repetida: false, compraId, produto };
    try {
      if (produto === 'minha') {
        const qtd = doGabinete && Number.isInteger(quantidade) ? quantidade : MINHA_GERACOES;
        const novo = await somarCreditos(userId, qtd, supabase);
        resultado.creditos = novo;
        await resolverPedidos({ user_id: userId, produto: 'minha' });
        notificar([userId], {
          title: 'Sua figurinha foi liberada ✨',
          body: novo === 1 ? 'Você tem 1 geração. Abra e faça a sua.' : `Você tem ${novo} gerações. Abra e faça a sua.`,
          url: '/figurinha',
        });
      } else if (produto === 'pacote') {
        // O uniforme: o que o Gabinete escolheu, senão o que o time já tinha (pacote que
        // voltou depois de um reembolso). Nenhum pedido guarda uniforme — sem nenhum dos
        // dois fica null e ninguém gera até o uniforme ser fixado (direitoBrilhante salta
        // pacote sem kit).
        const kit = (doGabinete && kitId) || time.brilhante_kit || null;
        await ligarPacote(teamId, { kitId: kit, loja });
        resultado.kitId = kit;
        await resolverPedidos({ team_id: teamId, produto: 'pacote' });
        if (kit) {
          const { data: membros } = await supabase.from('team_members').select('user_id').eq('team_id', teamId);
          const ids = (membros || []).map((m) => m.user_id).filter(Boolean);
          resultado.membrosAvisados = ids.length;
          notificar(ids, {
            title: 'Sua figurinha foi liberada ✨',
            body: `O ${time.nome} ativou as figurinhas. Abra e gere a sua.`,
            url: '/figurinha',
          });
        } else {
          resultado.membrosAvisados = 0;
          notificar([userId], {
            title: 'Pacote do time ativo ✨',
            body: `Falta escolher o uniforme do ${time.nome} para liberar as figurinhas.`,
            url: '/figurinha',
          });
        }
      } else {
        // Manto: gravado e pago; o uniforme próprio é montado à mão (fase 2). O pedido
        // 'manto' fica pendente — é por ele que o dono vê o que tem de fazer.
        // P2: comprado na loja SEM pedido antes, o pedido nasce aqui — é ele que põe o manto
        // na fila do Gabinete e que faz o app mostrar "Manto pedido" em vez de vender de novo.
        await garantirPedidoManto(userId, teamId);
        notificar([userId], {
          title: 'Manto próprio confirmado ✨',
          body: `Recebemos o manto do ${time.nome}. A gente avisa quando o uniforme estiver pronto.`,
          url: '/figurinha',
        });
      }
    } catch (e) {
      if (compraId) {
        const { error: erroApagar } = await supabase.from('compras').delete().eq('id', compraId);
        if (erroApagar) console.error('[compras] linha sem crédito ficou gravada — conferir à mão:', { compraId, erro: erroApagar.message });
      }
      throw e;
    }

    if (compraId) {
      const { error } = await supabase.from('compras').update({ creditada_em: new Date().toISOString() }).eq('id', compraId);
      if (error) console.warn('[compras] creditada_em não gravado:', error.message);
    }
    console.log('[compras] compra aplicada', { produto, loja, ambiente, userId, teamId, compraId });
    return resultado;
  }

  /**
   * Reembolso vindo da loja. Marca a compra 'reembolsada' e desfaz o efeito:
   *   minha  → −MINHA_GERACOES (a função nunca deixa abaixo de 0);
   *   pacote → desliga o pacote SÓ se foi esta loja que o ligou e não há outra compra de
   *            pacote creditada no time. `brilhantes_time` nunca é apagado (histórico).
   *   manto  → nada automático (o manto é montado à mão).
   * Devolve `{ encontrada: false }` se a transação não existe, `{ repetida: true }` se já
   * estava reembolsada.
   */
  async function reembolsar({ loja, transacaoId }) {
    const compra = await buscarCompra(loja, transacaoId);
    if (!compra) return { encontrada: false };
    if (compra.estado === 'reembolsada') return { encontrada: true, repetida: true, produto: compra.produto };

    const { data: marcada, error } = await supabase
      .from('compras').update({ estado: 'reembolsada' }).eq('id', compra.id).eq('estado', 'creditada').select('id').maybeSingle();
    if (error) throw new Error(error.message);
    if (!marcada) return { encontrada: true, repetida: true, produto: compra.produto }; // outra entrega chegou antes

    const resultado = { encontrada: true, repetida: false, produto: compra.produto };
    if (compra.produto === 'minha' && compra.user_id) {
      resultado.creditos = await somarCreditos(compra.user_id, -MINHA_GERACOES, supabase);
    } else if (compra.produto === 'pacote' && compra.team_id) {
      const [{ data: time, error: erroTime }, { count, error: erroConta }] = await Promise.all([
        supabase.from('teams').select('id, brilhante_origem').eq('id', compra.team_id).maybeSingle(),
        supabase.from('compras').select('id', { count: 'exact', head: true })
          .eq('team_id', compra.team_id).eq('produto', 'pacote').eq('estado', 'creditada'),
      ]);
      if (erroTime) throw new Error(erroTime.message);
      if (erroConta) throw new Error(erroConta.message);
      if (time && time.brilhante_origem === compra.loja && !count) {
        const { error: erroDesligar } = await supabase.from('teams').update({ brilhante_ativo: false }).eq('id', compra.team_id);
        if (erroDesligar) throw new Error(erroDesligar.message);
        resultado.pacoteDesligado = true;
      } else {
        resultado.pacoteDesligado = false;
      }
    }
    console.log('[compras] reembolso aplicado', { loja, produto: compra.produto, compraId: compra.id, ...resultado });
    return resultado;
  }

  /**
   * Grava um evento que não vira crédito (tipo desconhecido, pessoa desconhecida, sandbox
   * desligado, regra que falhou) — para auditoria. A transação é `evento:<id do evento>`,
   * nunca a da compra: um CANCELLATION traz o mesmo transaction_id da compra que cancela.
   */
  async function registrarIgnorada({ userId = null, teamId = null, produto = null, loja, eventoId, transacaoId = null,
    transacaoOriginalId = null, appUserId = null, moeda = null, preco = null, precoUsd = null, ambiente = 'producao', payload = null, motivo }) {
    const linha = {
      user_id: userId,
      team_id: teamId,
      produto: PRODUTOS.includes(produto) ? produto : null,
      loja: LOJAS.includes(loja) ? loja : 'outra',
      transacao_id: `evento:${eventoId || crypto.randomUUID()}`,
      transacao_original_id: transacaoOriginalId || transacaoId,
      evento_id: eventoId,
      app_user_id: appUserId,
      moeda,
      preco,
      preco_usd: precoUsd,
      ambiente,
      estado: 'ignorada',
      payload: { motivo, ...(payload || {}) },
    };
    const { error } = await supabase.from('compras').insert(linha);
    if (error && error.code !== '23505') throw Object.assign(new Error(error.message), { code: error.code });
    console.warn('[compras] evento ignorado', { motivo, loja: linha.loja, eventoId, appUserId });
    return { ignorada: true, motivo };
  }

  return { aplicarCompra, reembolsar, registrarIgnorada, resolverPedidos };
}

/**
 * O bloco de receita do Gabinete, a partir das linhas de `compras` do mês (função pura,
 * testada sem banco). Receita = soma de `preco_usd` das creditadas em PRODUÇÃO — o sandbox
 * conta à parte e o reembolso sai da soma. As concessões do Gabinete (preço 0) entram na
 * receita como 0, mas não contam como compra: ficam em `concessoes_mes`.
 */
function resumirReceita(linhas = []) {
  const r = { receita_mes: 0, compras_mes: 0, sandbox_mes: 0, reembolsadas_mes: 0, concessoes_mes: 0, por_produto: { minha: 0, pacote: 0, manto: 0 } };
  let centavos = 0;
  for (const c of linhas) {
    if (c.estado === 'ignorada') continue;
    if (c.ambiente === 'sandbox') { r.sandbox_mes += 1; continue; }
    if (c.estado === 'reembolsada') { r.reembolsadas_mes += 1; continue; }
    if (c.estado !== 'creditada') continue;
    centavos += Math.round((Number(c.preco_usd) || 0) * 100);
    if (c.loja === 'gabinete') { r.concessoes_mes += 1; continue; }
    r.compras_mes += 1;
    if (c.produto in r.por_produto) r.por_produto[c.produto] += 1;
  }
  r.receita_mes = centavos / 100;
  return r;
}

const padrao = criarCompras();

module.exports = {
  ...padrao,
  criarCompras,
  ErroCompra,
  MINHA_GERACOES,
  PRODUTOS,
  LOJAS,
  ehTabelaEmFalta,
  resumirReceita,
  novaTransacaoGabinete: () => `gab-${crypto.randomUUID()}`,
};
