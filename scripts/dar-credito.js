// ═══════════════════════════════════════════════════════════════════════════════
// DAR CRÉDITOS DE FIGURINHA BRILHANTE À MÃO (SPEC-FIGURINHA-3, 22-set).
//
// O Gabinete "Brilhantes" é o bloco 2. Até lá, é por aqui que se ativa alguém:
// a conta demo das lojas (2 créditos, para o revisor ver o produto completo),
// um pedido que chegou em `pedidos_ativacao`, ou a própria bancada.
//
//   node scripts/dar-credito.js demo-loja@futtymock.com          +1 crédito
//   node scripts/dar-credito.js demo-loja@futtymock.com 2        +2 créditos
//   node scripts/dar-credito.js --ver demo-loja@futtymock.com    só mostra
//   node scripts/dar-credito.js --time <slug> --kit dark-gold    ativa o pacote
//
// Precisa da migração 054 aplicada — sem ela avisa e sai sem escrever nada.
// ═══════════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const { supabase } = require('../utils/db');

const arg = (n, o = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : o;
};
const tem = (n) => process.argv.includes(`--${n}`);

const KITS = ['dark-gold', 'dark-purple', 'white-gold', 'elite-gold', 'royal-purple'];

async function ativarPacote(slug, kit) {
  if (!KITS.includes(kit)) {
    console.error(`kit inválido: ${kit}. Um de: ${KITS.join(', ')}`);
    process.exit(1);
  }
  const { data: time, error } = await supabase.from('teams').select('id, nome, slug').eq('slug', slug).maybeSingle();
  if (error) { console.error('erro a ler o time:', error.message); process.exit(1); }
  if (!time) { console.error(`time "${slug}" não existe.`); process.exit(1); }

  const { error: erroUpd } = await supabase
    .from('teams')
    .update({ brilhante_ativo: true, brilhante_kit: kit, brilhante_ativado_em: new Date().toISOString() })
    .eq('id', time.id);
  if (erroUpd) {
    console.error('não consegui ativar (migração 054 aplicada?):', erroUpd.message);
    process.exit(1);
  }
  const { count } = await supabase.from('team_members').select('user_id', { count: 'exact', head: true }).eq('team_id', time.id);
  console.log(`pacote ativado em "${time.nome}" (${slug}) · uniforme ${kit} · ${count || 0} membro(s) com direito`);
}

async function mostrar(email) {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, nome_jogador, brilhante_creditos, presente_criador_em')
    .eq('email', email)
    .maybeSingle();
  if (error) { console.error('erro (migração 054 aplicada?):', error.message); process.exit(1); }
  if (!data) { console.error(`conta "${email}" não existe.`); process.exit(1); }
  console.log(`${data.email} · créditos: ${data.brilhante_creditos ?? '—'} · presente do criador: ${data.presente_criador_em || 'ainda não'}`);
  return data;
}

(async () => {
  const slug = arg('time');
  if (slug) {
    await ativarPacote(slug, arg('kit', 'dark-gold'));
    return;
  }

  const email = process.argv.slice(2).find((a) => a.includes('@'));
  if (!email) {
    console.error('Uso: node scripts/dar-credito.js <email> [quantos] | --ver <email> | --time <slug> --kit <kit>');
    process.exit(1);
  }

  const antes = await mostrar(email);
  if (tem('ver')) return;

  const quantos = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) || 1);
  const novo = (Number(antes.brilhante_creditos) || 0) + quantos;
  const { error } = await supabase.from('users').update({ brilhante_creditos: novo }).eq('id', antes.id);
  if (error) { console.error('não consegui dar o crédito (migração 054 aplicada?):', error.message); process.exit(1); }
  console.log(`→ ${email} agora tem ${novo} crédito(s) (+${quantos})`);
})();
