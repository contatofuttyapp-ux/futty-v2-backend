// BANCADA — RESET DE CONTA PARA DEMONSTRAÇÃO (31-jul).
// Devolve uma conta mock ao estado "recém-instalado": sem foto, sem avatar IA,
// onboarding por fazer. Serve para o dono VER com os próprios olhos:
//   · o onboarding completo (3 passos, de verdade, não simulado)
//   · a LEI DA SILHUETA no Início e na Figurinha (card sem avatar)
//
// Uso:  node scripts/_bench/resetar-conta-demo.js            (erick@futtymock.com)
//       node scripts/_bench/resetar-conta-demo.js wesley@futtymock.com
//
// Só funciona em contas @futtymock.com — recusa qualquer outra (proteção).

const { supabase } = require('../../utils/db');

(async () => {
  const email = (process.argv[2] || 'erick@futtymock.com').toLowerCase();
  if (!email.endsWith('@futtymock.com')) {
    console.error('Recusado: só contas @futtymock.com podem ser resetadas.');
    process.exit(1);
  }

  // 1) encontra o utilizador no auth
  const { data: lista, error: eLista } = await supabase.auth.admin.listUsers({ perPage: 200 });
  if (eLista) { console.error('listUsers falhou:', eLista.message); process.exit(1); }
  const user = lista.users.find((u) => (u.email || '').toLowerCase() === email);
  if (!user) { console.error(`Conta ${email} não existe. Corre o seed-mock primeiro.`); process.exit(1); }

  // 2) onboarding por fazer (flag no user_metadata — mesma usada pelo gate)
  const meta = { ...(user.user_metadata || {}), onboarding_completo: false };
  const { error: eMeta } = await supabase.auth.admin.updateUserById(user.id, { user_metadata: meta });
  if (eMeta) { console.error('updateUser falhou:', eMeta.message); process.exit(1); }

  // 3) limpa foto + avatar e volta kit/fundo aos PADRÕES de estreia (as colunas
  //    são NOT NULL — conta nova nasce com dark-gold/estadio, não com vazio).
  const { error: eRow } = await supabase
    .from('users')
    .update({ avatar_url: null, foto_url: null, kit_ativo: 'dark-gold', fundo_figurinha: 'estadio' })
    .eq('id', user.id);
  if (eRow) { console.error('update users falhou:', eRow.message); process.exit(1); }

  // 4) apaga os slots de kits gerados (para a Figurinha nascer limpa)
  const { error: eSlots } = await supabase.from('user_avatar_slots').delete().eq('user_id', user.id);
  if (eSlots) console.warn('aviso: slots não apagados:', eSlots.message);

  console.log(`\nCONTA DEMO PRONTA: ${email} / FuttyMock123!`);
  console.log('Entra com ela e vais ver, por ordem:');
  console.log('  1. o ONBOARDING completo (3 passos) — podes pular a foto em "deixar para depois"');
  console.log('  2. o INÍCIO com o card em SILHUETA');
  console.log('  3. a FIGURINHA em silhueta — troca o fundo (funciona); o uniforme só nasce com o avatar IA');
  console.log('\nPara voltar ao estado com avatar: gera de novo pelo app (gasta 1 geração low ≈ $0,015)\nou simplesmente ignora — é uma conta mock.\n');
})();
