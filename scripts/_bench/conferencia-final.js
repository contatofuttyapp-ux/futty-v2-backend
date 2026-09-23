// Futty v2.0 — LIMPEZA TOTAL (23-set): contagens finais pós-reconstrução da demo
// + confirmação do estado das duas contas que ficam.
require('dotenv').config();
const { supabase } = require('../../utils/db');

const TABELAS = ['users', 'teams', 'team_members', 'games', 'feed_posts', 'feed_post_media',
  'rsvp_respostas', 'votos', 'convites', 'pedidos_ativacao', 'brilhantes_time', 'denuncias'];

(async () => {
  console.log('=== contagens finais (pós-reconstrução da demo) ===');
  for (const t of TABELAS) {
    const { count, error } = await supabase.from(t).select('*', { count: 'exact', head: true });
    console.log(error ? `${t}: ERRO ${error.message}` : `${t}: ${count}`);
  }

  console.log('\n=== contatofuttyapp@gmail.com ===');
  const { data: chefe, error: eChefe } = await supabase
    .from('users')
    .select('id, email, is_super_admin, avatar_url, foto_url, brilhante_creditos, kit_ativo')
    .eq('email', 'contatofuttyapp@gmail.com')
    .maybeSingle();
  console.log(eChefe ? `ERRO: ${eChefe.message}` : JSON.stringify(chefe, null, 2));

  console.log('\n=== demo-loja@futtymock.com ===');
  const { data: demo, error: eDemo } = await supabase
    .from('users')
    .select('id, email, avatar_url, foto_url, brilhante_creditos, kit_ativo')
    .eq('email', 'demo-loja@futtymock.com')
    .maybeSingle();
  console.log(eDemo ? `ERRO: ${eDemo.message}` : JSON.stringify(demo, null, 2));

  console.log('\n=== todos os e-mails restantes na base ===');
  const { data: todos } = await supabase.from('users').select('email');
  (todos || []).map((u) => u.email).sort().forEach((e) => console.log(' -', e));
})();
