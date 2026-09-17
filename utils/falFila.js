// ═══════════════════════════════════════════════════════════════════════════════
// A FAL PELA FILA REST — e o custo REAL de cada chamada (17-set).
//
// Porque não o SDK: o `fal.subscribe` do @fal-ai/serverless-client devolve o
// resultado e deita fora os headers da resposta. E é num header que vem o que
// interessa saber: `x-fal-billable-units`, o custo em dólares daquela chamada.
//
// Sem isso a casa andou desde julho a acreditar num custo de tabela ($0,015 por
// figurinha) que só contava a imagem de SAÍDA. A fal cobra quatro coisas na
// mesma chamada — texto do prompt, tokens de imagem de ENTRADA (os caros:
// $0,008 por 1.000, e uma imagem 1024×1024 em fidelidade alta são 3.050),
// raciocínio, e a imagem de saída. A receita que estava no ar custava $0,132.
// Medir é barato; adivinhar custou 9× o previsto.
//
// SEGURANÇA (SEGURANCA-REVISAO-10SET.md secção 3): nada aqui loga a chave da
// fal nem o URL assinado da foto do utilizador. O texto de erro da fal passa
// por `limpar()` antes de chegar a qualquer log.
// ═══════════════════════════════════════════════════════════════════════════════

const BASE_FILA = 'https://queue.fal.run';
const ESPERA_MS = 2000;
const LIMITE_MS = 8 * 60 * 1000;

/** Erro da fal sem a chave e sem o URL assinado da foto (tem token de leitura). */
function limpar(texto) {
  const chave = process.env.FAL_KEY;
  return String(texto || '')
    .replace(chave ? new RegExp(chave.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : /$^/g, '***')
    .replace(/https:\/\/[^\s"']*supabase[^\s"']*/gi, '<url-assinado>')
    .slice(0, 300);
}

const cabecalhos = () => ({
  Authorization: `Key ${process.env.FAL_KEY}`,
  'Content-Type': 'application/json',
});

/**
 * O custo desta chamada, lido dos headers. `usd: null` = a fal não mandou —
 * quem chama decide o que fazer (em produção, a média do dia; ver antiAbusoIA).
 */
function custoDosHeaders(headers) {
  const achados = {};
  for (const [k, v] of headers.entries()) if (/^x-fal-/i.test(k)) achados[k.toLowerCase()] = v;
  const campos = ['x-fal-billable-units', 'x-fal-cost', 'x-fal-billing-cost', 'x-fal-usd-cost'];
  for (const c of campos) {
    if (achados[c] != null && achados[c] !== '' && Number.isFinite(Number(achados[c]))) {
      return { usd: Number(achados[c]), campo: c, headers: achados };
    }
  }
  return { usd: null, campo: null, headers: achados };
}

/**
 * Uma chamada à fal pela fila: submete, espera, busca o resultado.
 * Devolve { dados, custo, segundos, id } — `custo.usd` é o dinheiro REAL.
 * Lança `Error` com `status` e `body` quando a fal recusa, para quem chama
 * poder distinguir 401/403/402 (motor) de file_download_error (foto).
 */
async function chamarFal(endpoint, input) {
  const t0 = Date.now();
  const sub = await fetch(`${BASE_FILA}/${endpoint}`, {
    method: 'POST', headers: cabecalhos(), body: JSON.stringify(input),
  });
  if (!sub.ok) {
    const texto = await sub.text();
    const erro = new Error(`fal ${sub.status} ao submeter: ${limpar(texto)}`);
    erro.status = sub.status;
    try { erro.body = JSON.parse(texto); } catch { erro.body = null; }
    throw erro;
  }
  const { request_id: id, status_url: statusUrl, response_url: respUrl } = await sub.json();
  const base = `${BASE_FILA}/${endpoint.split('/').slice(0, 2).join('/')}/requests/${id}`;
  const urlStatus = statusUrl || `${base}/status`;
  const urlResp = respUrl || base;

  let estado = 'IN_QUEUE';
  const limite = Date.now() + LIMITE_MS;
  while (estado !== 'COMPLETED') {
    if (Date.now() > limite) throw new Error('fal demorou mais de 8 min — desisti');
    await new Promise((r) => setTimeout(r, ESPERA_MS));
    const s = await fetch(urlStatus, { headers: cabecalhos() });
    if (!s.ok) {
      const erro = new Error(`fal ${s.status} no status: ${limpar(await s.text())}`);
      erro.status = s.status;
      throw erro;
    }
    const j = await s.json();
    estado = j.status;
    if (estado === 'FAILED' || j.error) {
      const erro = new Error(`fal falhou: ${limpar(JSON.stringify(j.error || j))}`);
      erro.body = j.error || j;
      throw erro;
    }
  }
  const r = await fetch(urlResp, { headers: cabecalhos() });
  if (!r.ok) {
    const erro = new Error(`fal ${r.status} no resultado: ${limpar(await r.text())}`);
    erro.status = r.status;
    throw erro;
  }
  const custo = custoDosHeaders(r.headers);
  const dados = await r.json();
  return { dados, custo, segundos: (Date.now() - t0) / 1000, id };
}

module.exports = { chamarFal, custoDosHeaders, limpar };
