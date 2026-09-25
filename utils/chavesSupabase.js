// Futty v2.0 — De onde saem as chaves do Supabase (Rodada 28, formato novo).
//
// O Supabase trocou as chaves JWT (anon / service_role) pelas novas: publishable
// (sb_publishable_…) e secret (sb_secret_…). As novas giram sem derrubar sessões
// e podem ser revogadas uma a uma. As duas famílias convivem até o Pedro desligar
// as antigas no painel (Settings → API Keys); o motor prefere a nova e cai para a
// antiga enquanto ela for a única no ambiente. Nenhum outro arquivo lê essas
// variáveis direto — é aqui que a troca acontece, uma vez só.
//
// Nunca imprimir o valor: quem precisa saber qual está em uso usa `origemDasChaves()`
// (nomes e formato, sem a chave).

/** A chave de servidor (ignora RLS). Só no motor e nos scripts, nunca no app. */
function chaveSecreta() {
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY || '';
}

/** A chave pública (a do app, sujeita a RLS). Testes e scripts a usam para abrir sessão. */
function chavePublica() {
  return process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';
}

/** 'nova' (sb_…), 'antiga' (JWT) ou null — o formato, nunca o conteúdo. */
function formato(chave) {
  if (!chave) return null;
  return chave.startsWith('sb_') ? 'nova' : 'antiga';
}

/** Qual variável manda em cada chave e em que formato — seguro para log. */
function origemDasChaves() {
  return {
    secreta: process.env.SUPABASE_SECRET_KEY ? 'SUPABASE_SECRET_KEY' : process.env.SUPABASE_SERVICE_KEY ? 'SUPABASE_SERVICE_KEY' : null,
    secretaFormato: formato(chaveSecreta()),
    publica: process.env.SUPABASE_PUBLISHABLE_KEY ? 'SUPABASE_PUBLISHABLE_KEY' : process.env.SUPABASE_ANON_KEY ? 'SUPABASE_ANON_KEY' : null,
    publicaFormato: formato(chavePublica()),
  };
}

module.exports = { chaveSecreta, chavePublica, origemDasChaves };
