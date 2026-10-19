// Futty v2.0 — A PINTURA da figurinha (a parte que custa dinheiro): a foto conferida vai à fal, a coroa é auditada, a figurinha e o
// slot são gravados e SÓ DEPOIS o direito é debitado. Roda em segundo plano (utils/geracaoJobs.js) ou dentro do pedido do Cloud Tasks.
const sharp = require('sharp');
const { invalidarSessaoDoPedido } = require('../middleware/auth');
const { HttpError } = require('../utils/http');
const { supabase, ensureUserRow, getUserById } = require('../utils/db');
const { marcarFigurinhaStatus } = require('./inicio');
const { avatarEhFigurinhaNossa } = require('../utils/figurinhaRegra');
const { registrarGeracao } = require('../utils/antiAbusoIA');
// A figurinha, em três módulos próprios:
//   prompts/figurinha.js       o texto que vai à IA (a bancada importa o MESMO)
//   utils/entradaFigurinha.js  a foto que vai com ele (faixa + corte quadrado)
//   utils/falFila.js           a chamada, e o custo REAL vindo dos headers da fal
const { montarPrompt } = require('../prompts/figurinha');
const { preprocessarQuadrado, preprocessarRetrato } = require('../utils/entradaFigurinha');
const {
  gerarFigurinha, RECEITA, V6_ENDPOINT, FIDELIDADE_V6,
  PASSADA1_ENDPOINT, PASSADA2_ENDPOINT, QUALIDADE, FIDELIDADE_PASSADA2, TAMANHO_1_5,
} = require('../utils/geracaoFigurinha');
// Quem pode gerar uma Brilhante (SPEC-FIGURINHA-3, §5). Toda geração nasce paga:
// crédito comprado/presenteado ou pacote do time.
const { temDireito, debitar } = require('../utils/direitoBrilhante');
const { enviarNotificacao } = require('../routes/push'); // o "Sua figurinha ficou pronta" (avisarQuePintou)
const { KITS_IA } = require('../utils/kitsIa');
const {
  garantirFotoHash, fotoEstaRecusada, MSG_FOTO_RECUSADA, caminhoNoBucket, assinarUrlAvatars, baixarFotoConferida, recusarFoto, caminhoFigurinhaNova,
  arquivarFigurinhaAntiga,
} = require('./fotoDoAvatar');

// fal.ai — a chave vem do ambiente (FAL_KEY) e é lida dentro de utils/falFila.js,
// que é quem fala com a fal (o SDK escondia os headers de custo).

// O PROMPT DA FIGURINHA vive em prompts/figurinha.js (fonte única).
// Aqui fica só a chamada: montarPrompt(kitId). O prompt antigo (PROMPT_BASE
// de 5.375 caracteres + kitPrompt em cinco pontos + kitChecklist) foi REPROVADO
// na bancada de 49 figurinhas — 1,6/5 contra 4,1/5 do que está agora lá. Não
// voltar a escrever prompt dentro desta rota: a bancada importa do mesmo módulo,
// e é isso que garante que o que se mede é o que está no ar.
// O prompt vem inteiro do módulo — esta rota não monta texto nenhum.
const promptFutty = (kitId) => montarPrompt(kitId);

/**
 * A PINTURA em si — roda em segundo plano, pela fila de utils/geracaoJobs.js (era o corpo de POST /api/me/avatar/ai). Baixa a foto conferida, pinta (fal), audita a
 * coroa, grava a figurinha e o slot e, SÓ DEPOIS de ela existir, debita o direito. `etapa(nome)` avisa
 * em que pé está (o app mostra 'preparando a foto → pintando o uniforme → acabamento'). Lança HttpError;
 * quem chama transforma isso no desfecho do job (e no status
 * 'falhou' do usuário). O pedido HTTP pode já ter respondido: `req` só serve para o IP, o usuário e
 * a invalidação da sessão.
 */
async function pintarFigurinha({ req, userId, perfil, origem, direitoUsado, kitId, kit, slot }, { etapa }) {
  // Conta sem foto_hash (antes da 048): calcula-o aqui se a POST ainda não o fez (a tarefa relê o perfil do banco).
  await garantirFotoHash(userId, perfil);
  // Foto já recusada não chega à fal — esta é a última porta antes do dinheiro (a da POST é a primeira).
  if (await fotoEstaRecusada(perfil.foto_hash)) throw new HttpError(422, MSG_FOTO_RECUSADA, 'FOTO_RECUSADA');
  // ETAPA 0 — a foto que vai à IA: faixa de
  // 18% no topo + corte QUADRADO 1024×1024 com a cabeça a 12% do topo.
  // A receita vive em utils/entradaFigurinha.js e a bancada usa a MESMA.
  // Porquê quadrado: ganhou em 6 das 7 fotos (4,1/5 contra 4,0 do retrato) e
  // custa menos — a fal cobra os tokens da imagem de ENTRADA, e o quadrado
  // baixou a chamada de US$0,132 para US$0,112. A SAÍDA continua 1024×1536.
  // Upload no Supabase (URL assinado) em vez de data URI: é o formato de input
  // confirmado no schema do fal — não se arrisca uma geração paga noutro.
  // Tudo o que é temporário nesta geração (o pad e a imagem entre passadas)
  // fica aqui para ser apagado no fim — com nomes por versão, ninguém os
  // sobrescreve, portanto é a limpeza que tem de os levar.
  const temporarios = [];
  const caminhoFoto = caminhoNoBucket(perfil.foto_url, 'avatars');
  let inputUrl = caminhoFoto ? await assinarUrlAvatars(caminhoFoto) : perfil.foto_url;
  let formaEntrada = 'foto-crua';
  try {
    if (!caminhoFoto) throw new Error('foto_url não é um caminho do bucket avatars.');
    // download() autenticado (SDK) em vez de fetch(url pública) — o bucket é
    // PRIVADO, um fetch simples do URL "público" devolve 400.
    // TRAVA ANTES DE GASTAR. A foto que se baixou tem de ser a que a
    // tabela diz ser a atual — senão a figurinha sairia da foto errada e o
    // dinheiro já estaria gasto quando alguém percebesse. Três tentativas com
    // 2 s de intervalo: se for atraso de propagação, passa; se for outra
    // coisa, ninguém paga por ela.
    //
    // Só corre quando há `foto_hash` gravado: contas antigas (antes da
    // migração 048) não têm, e barrá-las seria inventar um defeito.
    const fotoBuf = await baixarFotoConferida(caminhoFoto, perfil.foto_hash);
    // O quadrado é a receita de produção; se ele falhar (foto estranha, sharp a
    // recusar o corte), cai-se no retrato com faixa — NUNCA na foto crua, que
    // é o que fazia a IA comer a coroa da cabeça.
    let entradaBuf;
    try {
      entradaBuf = await preprocessarQuadrado(fotoBuf);
      formaEntrada = 'quadrada-1024';
    } catch (eq) {
      console.error('[avatar-ai] corte quadrado falhou, uso o retrato com faixa:', eq.message);
      entradaBuf = await preprocessarRetrato(fotoBuf);
      formaEntrada = 'retrato-faixa';
    }
    // Nome por versão também aqui: esta é a imagem que a fal vai BUSCAR por
    // URL. Um caminho reutilizado é a única peça do caminho que um cache
    // externo poderia servir velha — e a fal está do outro lado do mundo.
    const caminhoPad = `tmp/${userId}-${Date.now()}-pad.jpg`;
    temporarios.push(caminhoPad);
    const { error: padErr } = await supabase.storage.from('avatars').upload(caminhoPad, entradaBuf, {
      contentType: 'image/jpeg',
      upsert: true,
      cacheControl: '3600',
    });
    if (padErr) throw new Error(padErr.message);
    inputUrl = await assinarUrlAvatars(caminhoPad);
    console.log('[avatar-ai] etapa 0 - entrada pronta', { forma: formaEntrada, bytes: entradaBuf.length });
  } catch (e) {
    // A trava do hash (FOTO_DESATUALIZADA) é uma RECUSA, não uma falha de
    // preparação: tem de subir inteira até ao cliente. Cair para a foto crua
    // aqui seria gerar exactamente a figurinha errada que ela existe para
    // impedir — e cobrar por ela.
    if (e instanceof HttpError) throw e;
    console.error('[avatar-ai] etapa 0 falhou, usa foto original (assinada):', e.message);
  }
  // A RECEITA vive em utils/geracaoFigurinha.js — endpoints, qualidades e
  // fidelidade são constantes de lá, com override por ambiente. Esta rota
  // não decide mais nada sobre COMO se gera: só trata da foto, do kit, da
  // rede de segurança e do dinheiro.
  console.log('[avatar-ai] a chamar fal com:', {
    receita: RECEITA,
    ...(RECEITA === 'v6'
      ? { endpoint: V6_ENDPOINT, input_fidelity: FIDELIDADE_V6 }
      : { passada1: PASSADA1_ENDPOINT, passada2: PASSADA2_ENDPOINT, input_fidelity_passada2: FIDELIDADE_PASSADA2 }),
    kit: kitId,
    origem,
    fonte_do_direito: direitoUsado.fonte,
    prompt_length: promptFutty(kitId).length,
    quality: QUALIDADE,
    image_size: TAMANHO_1_5,
    entrada: formaEntrada,
  });

  // O DINHEIRO desta geração, somado de TODAS as tentativas: um retry por
  // cabeça cortada são DUAS passadas novas, e isso é dinheiro que tem de
  // aparecer no contador do dia. `parcelas` guarda quanto custou cada etapa,
  // para o log dizer de onde veio o total.
  const conta = { usd: 0, chamadas: 0, semHeader: 0, parcelas: {} };

  // A fal só lê URLs públicos. A imagem do meio (o jogador sobre o cinza,
  // entre as duas passadas) vai para o bucket privado `avatars` com URL
  // ASSINADO de vida curta — nunca para um bucket público, porque é a cara
  // do usuário. É apagada no fim, dê no que der.
  const publicar = async (nomeFicheiro, buffer, tipo) => {
    const caminho = `tmp/${userId}-${Date.now()}-${nomeFicheiro}`;
    const { error } = await supabase.storage.from('avatars').upload(caminho, buffer, {
      contentType: tipo, upsert: true, cacheControl: '3600',
    });
    if (error) throw new Error(`upload do passo intermédio: ${error.message}`);
    temporarios.push(caminho);
    return assinarUrlAvatars(caminho);
  };

  // ETAPA 1+2 (retriáveis) — as duas passadas + birefnet → buffer recortado.
  const gerarERecortar = async () => {
    let saida;
    try {
      saida = await gerarFigurinha({
        fotoUrl: inputUrl,
        kitUrl: kit.url,
        kitId,
        publicar,
        etiqueta: 'fig',
      });
    } catch (err) {
      // SEGURANCA-REVISAO-10SET.md secção 3: não se loga a resposta
      // inteira do fal (body/response, que pode incluir o inputUrl assinado
      // enviado no pedido) — fica só o código de erro e a mensagem curta.
      console.error('[avatar-ai] erro fal:', { status: err.status, message: err.message });
      // fal não conseguiu DESCARREGAR/DECODIFICAR a foto de entrada (arquivo
      // corrompido ou inacessível) — causa acionável (fotografia, não instabilidade
      // do serviço). Código próprio para o frontend distinguir sem depender do texto.
      let corpo = err.body;
      if (typeof corpo === 'string') { try { corpo = JSON.parse(corpo); } catch { corpo = null; } }
      // Em 401/403 a fal devolve `detail` como STRING
      // ("Forbidden"), não array — .some() nessa string derrubava com
      // TypeError e escondia a causa real. Só chama .some() se for array.
      if (Array.isArray(corpo?.detail) && corpo.detail.some((d) => d.type === 'file_download_error')) {
        throw new HttpError(422, 'Sua foto não pôde ser processada. Tente enviar uma foto nova.', 'FOTO_INVALIDA');
      }
      // Chave inválida, conta sem permissão ou sem crédito na fal — falha do
      // MOTOR, não da foto do usuário (não sugerir "tente outra foto").
      // ALERTA no log: precisa de ação humana (chave/plano fal), não é
      // instabilidade passageira.
      if ([401, 403, 402].includes(err.status)) {
        console.error('[avatar-ai] ALERTA: fal recusou', { status: err.status });
        throw new HttpError(503, 'A geração de figurinha está indisponível agora. Tente de novo mais tarde.', 'IA_INDISPONIVEL');
      }
      throw err;
    }

    // O custo desta tentativa entra na conta da geração (o retry soma por cima).
    conta.usd += saida.custo.usd;
    conta.chamadas += saida.custo.chamadas;
    conta.semHeader += saida.custo.semHeader;
    for (const [nome, p] of Object.entries(saida.custo.parcelas)) {
      conta.parcelas[nome] = (conta.parcelas[nome] || 0) + (p.usd || 0);
    }
    console.log(`[avatar-ai] ${saida.receita || RECEITA} OK`, {
      segundos: saida.tempos,
      custo_usd: Number(saida.custo.usd.toFixed(4)),
    });
    return { recorteBuffer: saida.recorteBuffer };
  };
  // REDE DE DETECÇÃO 1 — contacto com a borda, ANTES do trim. Topo (linhas
  // y=0..2, como antes): cabeça cortada. Laterais (colunas x=0..2 e
  // x=w-3..w-1, opacos > 15% da ALTURA): braço cortado pela borda.
  const bordaCortada = async (buf) => {
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h, channels: c } = info;
    const opaco = (x, y) => data[(y * w + x) * c + 3] > 200;

    let topoCount = 0;
    for (let y = 0; y <= 2 && y < h; y++) {
      let cnt = 0;
      for (let x = 0; x < w; x++) if (opaco(x, y)) cnt++;
      if (cnt > topoCount) topoCount = cnt;
    }
    const topoLimiar = Math.round(w * 0.15);

    const contarColuna = (x0) => {
      let cnt = 0;
      for (let y = 0; y < h; y++) if (opaco(x0, y)) cnt++;
      return cnt;
    };
    let esqCount = 0;
    for (let x = 0; x <= 2 && x < w; x++) esqCount = Math.max(esqCount, contarColuna(x));
    let dirCount = 0;
    for (let x = Math.max(0, w - 3); x < w; x++) dirCount = Math.max(dirCount, contarColuna(x));
    // HIERARQUIA DOS DEFEITOS (decisão do dono): braço tocando a borda lateral NÃO
    // reprova — é linguagem de cromo (Panini/FIFA cortam braço na moldura) e era
    // a causa nº1 de retry (~31% de custo a mais). Vira AVISO no log. Rede de
    // segurança: contacto EXTREMO (>60% da altura colada) ainda reprova.
    const lateralAviso = Math.round(h * 0.15);
    const lateralExtremo = Math.round(h * 0.6);

    const topo = { cortado: topoCount > topoLimiar, count: topoCount, limiar: topoLimiar };
    const esquerda = { cortado: esqCount > lateralExtremo, aviso: esqCount > lateralAviso, count: esqCount };
    const direita = { cortado: dirCount > lateralExtremo, aviso: dirCount > lateralAviso, count: dirCount };
    if ((esquerda.aviso && !esquerda.cortado) || (direita.aviso && !direita.cortado)) {
      console.log('[avatar-ai] AVISO: braço na borda lateral, aceite como enquadramento', { esq: esqCount, dir: dirCount, h });
    }
    return { cortada: topo.cortado || esquerda.cortado || direita.cortado, topo, esquerda, direita };
  };

  // REDE DE DETECÇÃO 2 — achatamento da coroa, APÓS o trim: largura da 1ª
  // linha opaca ÷ largura máxima nas primeiras ~10% de linhas da figura.
  // > 0,5 = coroa comida. (scripts/_bench/prova-producao.js)
  const achatamentoCoroa = async (buf) => {
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h, channels: c } = info;
    const larg = (y) => { let n = 0; for (let x = 0; x < w; x++) if (data[(y * w + x) * c + 3] > 200) n++; return n; };
    let y0 = -1;
    for (let y = 0; y < h && y0 < 0; y++) if (larg(y) > 0) y0 = y;
    if (y0 < 0) return { razao: null, cortada: false };
    const faixa = Math.min(h, y0 + Math.max(8, Math.round(h * 0.10)));
    const primeira = larg(y0);
    let maxima = 0;
    for (let y = y0; y < faixa; y++) maxima = Math.max(maxima, larg(y));
    const razao = maxima ? primeira / maxima : 0;
    return { razao, cortada: razao > 0.5 };
  };

  // As duas verificações por geração: borda (pré-trim) + achatamento (pós-trim).
  // Guarda o buffer já trimado para reaproveitar na ETAPA 3 sem trim duplo.
  const verificarQualidade = async (recorteBuffer) => {
    const borda = await bordaCortada(recorteBuffer);
    const trimado = await sharp(recorteBuffer).trim({ threshold: 10 }).png().toBuffer();
    const achatamento = await achatamentoCoroa(trimado);
    return { ok: !borda.cortada && !achatamento.cortada, borda, achatamento, trimado };
  };

  await etapa('pintando');
  // O "defeito da foto" = a cabeça cortada (o topo na borda, ou a coroa achatada) OU o braço EXTREMO na lateral
  // (>60% da altura colada). Só as DUAS tentativas com defeito recusam a FOTO; o braço colado normal (só aviso) e a
  // 2ª tentativa caída por outro motivo não marcam nada.
  const defeitoDaFoto = (v) => v.borda.topo.cortado || v.achatamento.cortada || v.borda.esquerda.cortado || v.borda.direita.cortado;
  let gen = await gerarERecortar();
  let verif = await verificarQualidade(gen.recorteBuffer);
  console.log('[avatar-ai] verificação de qualidade:', { borda: verif.borda, achatamento: verif.achatamento });
  const defeitoNaPrimeira = !verif.ok && defeitoDaFoto(verif);
  let defeitoNaSegunda = false;
  if (!verif.ok) {
    console.log('[avatar-ai] retry: reprovada na 1ª geração', { borda: verif.borda, achatamento: verif.achatamento });
    try {
      const gen2 = await gerarERecortar();
      const verif2 = await verificarQualidade(gen2.recorteBuffer);
      console.log('[avatar-ai] verificação de qualidade (pós-retry):', { borda: verif2.borda, achatamento: verif2.achatamento });
      gen = gen2;
      verif = verif2;
      defeitoNaSegunda = !verif2.ok && defeitoDaFoto(verif2);
    } catch (e) {
      console.error('[avatar-ai] retry falhou, mantém 1ª geração:', e.message);
    }
  }
  if (!verif.ok) {
    // Lei da casa: cabeça cortada nunca sai. Falhou nas duas rondas → não
    // entrega, não grava slot, não consome quota (o throw acontece antes
    // de qualquer um dos três, mais abaixo neste handler).
    console.error('[avatar-ai] REPROVADA após retry — não entrega:', { borda: verif.borda, achatamento: verif.achatamento });
    if (defeitoNaPrimeira && defeitoNaSegunda) {
      // A foto reprovou nas duas tentativas (cabeça cortada ou braço extremo) → recusada. O próximo pedido com ela é barrado antes da fal.
      await recusarFoto(userId, perfil.foto_hash);
      throw new HttpError(422, MSG_FOTO_RECUSADA, 'FOTO_RECUSADA');
    }
    throw new HttpError(422, 'Não conseguimos gerar uma figurinha à altura com esta foto. Tente outra: de frente e bem iluminada.', 'FIGURINHA_DEFEITUOSA');
  }

  await etapa('acabamento');

  // ETAPA 3 — redimensiona o PNG já recortado e trimado (sharp). A troca de cor do kit é feita no frontend.
  const buffer = await sharp(verif.trimado)
    // Rede de segurança: garante 40px de margem transparente acima de QUALQUER
    // conteúdo, mesmo que a IA cole a cabeça à borda do PNG.
    .extend({ top: 40, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .resize({ height: 640, width: 512, fit: 'inside' })
    .png()
    .toBuffer();
  console.log('[avatar-ai] etapa 3 - resize OK');

  await ensureUserRow(req.user);
  // Um arquivo POR KIT E POR VERSÃO → os slots não se sobrepõem entre si, e
  // a figurinha nova não escreve por cima da velha. Sem upsert: o
  // carimbo de tempo torna colisão impossível, e se algum dia houvesse, o
  // certo é rebentar aqui em vez de apagar o trabalho de outra chamada.
  const caminho = caminhoFigurinhaNova(userId, kitId);
  const { error: upErr } = await supabase.storage.from('avatars').upload(caminho, buffer, {
    contentType: 'image/png',
    upsert: false,
    cacheControl: '3600',
  });
  if (upErr) throw new HttpError(500, upErr.message);

  const { data: pub } = supabase.storage.from('avatars').getPublicUrl(caminho);
  const avatarUrl = `${pub.publicUrl}?v=${Date.now()}`;

  // Guarda o SLOT deste kit (upsert por (user_id, kit_id)) → a próxima vez que o
  // usuário pedir este kit COM A MESMA FOTO é servido do slot, sem gerar
  // nem gastar quota. foto_fingerprint = foto_hash atual (migração 052) —
  // é o que a checagem de reuso acima compara na próxima chamada.
  const { error: slotErr } = await supabase
    .from('user_avatar_slots')
    .upsert({ user_id: userId, kit_id: kitId, avatar_url: avatarUrl, foto_fingerprint: perfil.foto_hash || null }, { onConflict: 'user_id,kit_id' });
  if (slotErr) throw new HttpError(500, slotErr.message);

  // Persiste o novo avatar + kit vestido. A quota mensal por plano
  // (avatar_ia_mes/reset) saiu daqui na SPEC-FIGURINHA-3: quem manda agora é
  // o direito, e ele é debitado mais abaixo — depois de a figurinha existir.
  const dadosUpdate = { avatar_url: avatarUrl, kit_ativo: kitId };
  const { error: updErr } = await supabase.from('users').update(dadosUpdate).eq('id', userId);
  if (updErr) throw new HttpError(500, updErr.message);
  // Separado do update acima de propósito (ver nota no slot-reuse, mais acima).
  marcarFigurinhaStatus(userId, 'pronta');
  invalidarSessaoDoPedido(req); // nota completa no 'gerando', mais acima.

  // (decisão do dono) A figurinha anterior DESTE kit
  // já não é apontada por ninguém (o slot e o users.avatar_url acabaram de
  // mudar) — mas em vez de sair do bucket, vai para "Minhas figurinhas"
  // (user_avatar_historico, migração 057). custo_cents fica null: é o custo
  // de QUANDO ELA foi gerada, que não foi guardado antes — só
  // passa a existir para gerações futuras (não há como recuperar retroativo).
  const figurinhaAntiga = caminhoNoBucket(slot?.avatar_url, 'avatars');
  if (figurinhaAntiga && figurinhaAntiga !== caminho) {
    await arquivarFigurinhaAntiga(userId, kitId, slot.avatar_url);
  }

  // Pacote anti-abuso: soma o gasto do dia, guarda o log de IP e
  // dispara alertas/auto-freeze se algum sinal bater. Fire-and-forget (nunca
  // derruba a resposta — a figurinha já foi entregue ao usuário).
  // Vai o custo REAL em cêntimos, somado de todas as chamadas desta
  // geração (retry incluído). `null` só quando a fal não mandou header nenhum
  // — nesse caso quem decide o valor é o antiAbusoIA, não este sítio.
  const custoCents = conta.semHeader === conta.chamadas ? null : conta.usd * 100;
  console.log('[avatar-ai] custo da geração', {
    chamadas: conta.chamadas,
    sem_header: conta.semHeader,
    custo_usd: Number(conta.usd.toFixed(4)),
    // De onde veio o total: se um dia a conta disparar, é aqui que se vê qual
    // das quatro chamadas mudou de preço.
    parcelas: Object.fromEntries(Object.entries(conta.parcelas).map(([k, v]) => [k, Number(v.toFixed(4))])),
  });
  // O time que pagou (pacote) vai junto — é o custo por time e por mês do Gabinete.
  registrarGeracao({ userId, ip: req.ip, custoCents, teamId: direitoUsado?.fonte === 'time' ? direitoUsado.teamId : null }).catch(() => {});

  // DEBITA O DIREITO — só AGORA, com a figurinha gravada e entregue
  // (SPEC-FIGURINHA-3 §5). Uma geração que falhou a meio (fal fora do ar,
  // coroa cortada nas duas tentativas, foto desatualizada) nunca chega
  // aqui, e por isso nunca custa o crédito de ninguém. `await` de propósito:
  // o job só termina (e a pessoa só pode abrir outra pintura) depois de o débito
  // estar decidido, senão um toque rápido em "Gerar" duas vezes gastaria um
  // direito e cobraria dois.
  await debitar(direitoUsado, { userId, kitId, avatarUrl, custoCents });

  // A imagem do meio (o jogador sobre o cinza, entre as duas passadas) é a
  // cara do usuário num arquivo temporário: sai daqui assim que a
  // figurinha está entregue. Fire-and-forget — falhar a limpeza não pode
  // derrubar a resposta, e o pior caso é um arquivo a mais no tmp/.
  if (temporarios.length) {
    supabase.storage.from('avatars').remove(temporarios)
      .catch((e) => console.error('[avatar-ai] limpeza do tmp falhou:', e.message));
  }

  return { avatar_url: avatarUrl, kit: kitId, do_slot: false, reutilizado: false, figurinha_ativa: avatarEhFigurinhaNossa(avatarUrl) };
}

/**
 * Quem paga e qual uniforme, dado o direito e o kit pedido: no pacote do time vale o uniforme do time, e um kit
 * diferente só sai se a pessoa TAMBÉM tiver crédito (aí é o crédito que paga). Idempotente: aplicada ao kit já
 * resolvido devolve o mesmo par — é o que a tarefa do Cloud Tasks faz, lendo `kit_id` da linha do job.
 */
function resolverDireitoEKit(direito, kitPedido) {
  let direitoUsado = direito;
  let kitId = kitPedido;
  if (direito.fonte === 'time' && kitPedido !== direito.kitId) {
    const comCredito = direito.opcoes.find((o) => o.fonte === 'credito');
    if (comCredito) direitoUsado = { ...comCredito, creditos: direito.creditos, opcoes: direito.opcoes };
    else kitId = direito.kitId; // sem crédito, vale o uniforme do time
  }
  return { direitoUsado, kitId };
}

/** O push "Sua figurinha ficou pronta" — só se a pessoa NÃO está olhando o card (não consultou o job há 6 s). */
async function avisarQuePintou(job) {
  if (job.estado !== 'pronta') return;
  if (Date.now() - job.ultimaConsulta < 6000) return;
  enviarNotificacao([job.userId], { title: 'Futty', body: 'Sua figurinha ficou pronta', url: '/figurinha' }, { categoria: 'figurinha' });
}

/** Já há uma pintura desta pessoa em curso: o app novo acompanha a que existe; o antigo (que espera a figurinha na resposta) recebe um aviso claro. */
function respostaDePinturaEmCurso(res, jobId, estimativaSegundos, assincrono) {
  if (!assincrono) throw new HttpError(409, 'Sua figurinha já está sendo criada. Espere terminar.', 'PINTURA_EM_CURSO');
  return res.status(202).json({ jobId, estimativaSegundos, jaEmAndamento: true });
}

/**
 * O contexto que o POST montou (perfil, direito, kit, slot) refeito do banco para o pedido da tarefa, que roda
 * depois e talvez em outro processo. `kit_id` da linha é o uniforme já resolvido. Qualquer recusa (sem foto, sem
 * direito, kit fora do ar) vira o desfecho do job, como no POST — e, como lá, só debita depois da figurinha gravada.
 */
async function pintarDaTarefa(job, { ip, origem }, controle) {
  const { userId } = job;
  const reqDaTarefa = { user: { id: userId }, ip: ip || null, headers: {} };
  try {
    const perfil = await getUserById(userId, 'foto_url, foto_hash, is_super_admin, created_at, email');
    if (!perfil?.foto_url) throw new HttpError(400, 'Adicione uma foto primeiro.');
    reqDaTarefa.user.email = perfil.email;
    const direito = await temDireito(userId);
    const { direitoUsado, kitId } = resolverDireitoEKit(direito, String(job.kitId || direito.kitId || 'dark-gold'));
    const kit = KITS_IA[kitId];
    if (!kit?.ativo) throw new HttpError(400, 'Uniforme ainda não disponível.');
    if (!direitoUsado.fonte) {
      throw new HttpError(403, 'Sua figurinha vem do pacote do time ou da Minha Figurinha. Peça a ativação na aba Figurinhas.', 'SEM_DIREITO');
    }
    const { data: slot } = await supabase
      .from('user_avatar_slots')
      .select('avatar_url, foto_fingerprint')
      .eq('user_id', userId)
      .eq('kit_id', kitId)
      .maybeSingle();
    return await pintarFigurinha({ req: reqDaTarefa, userId, perfil, origem: origem || null, direitoUsado, kitId, kit, slot }, controle);
  } catch (err) {
    await marcarFigurinhaStatus(userId, 'falhou');
    invalidarSessaoDoPedido(reqDaTarefa);
    throw err;
  }
}

module.exports = { pintarFigurinha, resolverDireitoEKit, avisarQuePintou, respostaDePinturaEmCurso, pintarDaTarefa, promptFutty };
