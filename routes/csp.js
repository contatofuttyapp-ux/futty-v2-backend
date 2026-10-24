// Futty v2.0 — POST /api/csp: os avisos da Content-Security-Policy do site (public/_headers do frontend).
//
// O navegador manda um aviso a cada coisa que a política barra. Aqui ele vira UMA linha no log ("[csp] img-src bloqueou
// https://exemplo.com em /feed") — é por ela que se descobre se a política barrou algo que o site usa. O aviso diz se a política
// BLOQUEOU (disposition "enforce", a Content-Security-Policy de verdade) ou só BLOQUEARIA (disposition "report", uma política em
// Report-Only); sem o campo, vale "bloqueou", que é o modo em que o site está. Nada vai para o banco. Sem sessão de propósito (o navegador manda sozinho, sem o token), com limiter próprio por IP, fora do
// balde geral da /api: um site com muitos avisos nunca pode gastar a cota de pedidos de quem está usando o app.
//
// Os dois formatos que os navegadores mandam: o antigo `report-uri` (application/csp-report, { "csp-report": {…} }) e o novo
// `report-to` (application/reports+json, [{ type: "csp-violation", body: {…} }]). Do endereço só sai origem + caminho: a query
// pode levar token (o /api/media/:token também fica de fora, cortado no caminho).
const express = require('express');
const { criarLimiteDeCsp } = require('../middleware/limiters');

const TIPOS = ['application/csp-report', 'application/reports+json', 'application/json'];
const TETO_DA_LINHA = 300;
// A mesma linha não se repete no log dentro de 10 min (uma página com 20 imagens bloqueadas mandaria 20 avisos iguais).
const JANELA_DE_REPETICAO_MS = 10 * 60 * 1000;
const TETO_DE_LINHAS_LEMBRADAS = 500;

/** Origem + caminho (sem query nem fragmento) de um endereço; palavras-chave da CSP ("inline", "eval", "data") passam como vieram. */
function semDetalhe(valor) {
  const s = String(valor ?? '').trim();
  if (!s) return '(vazio)';
  try {
    const u = new URL(s);
    if (u.protocol === 'data:' || u.protocol === 'blob:') return `${u.protocol}`;
    const caminho = u.pathname.startsWith('/api/media/') ? '/api/media/…' : u.pathname;
    return `${u.origin}${caminho}`.slice(0, 120);
  } catch {
    return s.replace(/[^\w:.-]/g, '').slice(0, 40) || '(?)';
  }
}

/** Os avisos do corpo, nos dois formatos, como { diretiva, acao, bloqueado, pagina }. Corpo estranho = lista vazia. */
function avisosDoCorpo(corpo) {
  const lista = Array.isArray(corpo) ? corpo : corpo && typeof corpo === 'object' ? [corpo] : [];
  const avisos = [];
  for (const item of lista.slice(0, 20)) {
    const antigo = item?.['csp-report'];
    const novo = item?.type === 'csp-violation' ? item.body : null;
    const r = antigo || novo;
    if (!r || typeof r !== 'object') continue;
    const diretiva = String(r['effective-directive'] || r.effectiveDirective || r['violated-directive'] || r.violatedDirective || '?').split(' ')[0].slice(0, 40);
    const acao = r.disposition === 'report' ? 'bloquearia' : 'bloqueou';
    const bloqueado = semDetalhe(r['blocked-uri'] ?? r.blockedURL);
    let pagina = '?';
    try { pagina = new URL(String(r['document-uri'] || r.documentURL || '')).pathname.slice(0, 80); } catch { /* fica "?" */ }
    avisos.push({ diretiva, acao, bloqueado, pagina });
  }
  return avisos;
}

function criarRotaCsp({ registrar = (linha) => console.warn(linha), limite = criarLimiteDeCsp(), agora = () => Date.now() } = {}) {
  const router = express.Router();
  const vistas = new Map();
  // strict: false — um corpo que é JSON mas não é objeto (texto, número) cai em "corpo estranho" (204 sem linha), não num 400.
  router.post('/api/csp', limite, express.json({ type: TIPOS, limit: '16kb', strict: false }), (req, res) => {
    for (const a of avisosDoCorpo(req.body)) {
      const linha = `[csp] ${a.diretiva} ${a.acao} ${a.bloqueado} em ${a.pagina}`.slice(0, TETO_DA_LINHA);
      const ultima = vistas.get(linha);
      if (ultima != null && agora() - ultima < JANELA_DE_REPETICAO_MS) continue;
      vistas.set(linha, agora());
      if (vistas.size > TETO_DE_LINHAS_LEMBRADAS) vistas.delete(vistas.keys().next().value);
      registrar(linha);
    }
    res.status(204).end();
  });
  return router;
}

module.exports = criarRotaCsp();
module.exports.criarRotaCsp = criarRotaCsp;
module.exports.avisosDoCorpo = avisosDoCorpo;
