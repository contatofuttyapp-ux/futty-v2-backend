// Futty v2.0 — a TABELA das rotas que escrevem: método, rota, a classe de quem pode usá-la e um corpo válido. Quem a usa:
//   · tests/seguranca-matriz.test.js ... prova quem pode o quê em cada linha;
//   · tests/seguranca-escrita.test.js ... ataca cada linha com entrada maliciosa (texto gigante, HTML, tipo errado, números absurdos…).
// Uma rota nova que escreve precisa de uma linha aqui (ou da lista das públicas de propósito): o teste do inventário reprova sem isso.
const { iso, HORA } = require('./_mundoDeSeguranca');

const CLASSES = {
  admin: { negados: ['fora', 'memB', 'admB', 'memA'], permitidos: ['admA'] },
  membro: { negados: ['fora', 'memB', 'admB'], permitidos: ['memA', 'admA'] },
  autorOuAdmin: { negados: ['fora', 'memB', 'admB', 'memA2'], permitidos: ['memA'] },
  proprio: { negados: [], permitidos: ['memA'] },
  super: { negados: ['fora', 'memA', 'admA', 'admB'], permitidos: ['super'] },
};

// ─── A tabela: método, rota, classe e corpo ──────────────────────────────────────────────────────────────────────────────────
const L = (classe, metodo, rota, corpo, extra = {}) => ({ classe, metodo, rota, corpo, ...extra });
// A mídia da Resenha que `userId` acabou de subir (o upload dá ao arquivo o id de quem subiu como prefixo do nome).
const midiaDe = (userId) => `https://projeto-falso.supabase.test/storage/v1/object/public/resenha/${userId}-arquivo.webp`;

// Um mundo só de marcadores (":p"): a rota da tabela vira o desenho do Express (/api/teams/:p/convites/:p).
const marcador = new Proxy({}, { get: () => ':p' });
const MUNDO_DE_MARCADORES = { A: marcador, B: marcador, p: new Proxy({}, { get: () => marcador }), ids: marcador };
const desenho = (l) => `${l.metodo} ${l.rota(MUNDO_DE_MARCADORES)}`;

const LINHAS = [
  // ── Conta (auth.js) ──
  L('proprio', 'PATCH', () => '/api/me', () => ({ nome: 'Alice Nova', nome_jogador: 'Alice', avatar_url: 'https://fora.test/foto.png' })),
  L('proprio', 'POST', () => '/api/me/onboarding-completo', () => ({})),
  L('proprio', 'POST', () => '/api/me/tour-visto', () => ({})),
  L('proprio', 'PUT', () => '/api/me/kit', () => ({ kit: 'dark-gold' })),
  L('proprio', 'PUT', () => '/api/me/avatar/modo', () => ({ modo: 'foto' })),
  L('proprio', 'PUT', (m) => `/api/me/avatar/historico/${m.ids.postA}`, () => ({})),
  L('proprio', 'DELETE', () => '/api/me', () => ({ confirmacao: 'EXCLUIR' }), { permitidos: ['lixo'] }), // acaba com a conta descartável
  L('proprio', 'PUT', () => '/api/me/avatar/enquadro', () => ({ x: 50, y: 40, escala: 1 })),
  L('proprio', 'DELETE', () => '/api/me/avatar/enquadro'),
  L('proprio', 'POST', () => '/api/me/avatar/ai', () => ({})),
  L('proprio', 'POST', () => '/api/me/avatar', undefined, { soSemLogin: true }),
  L('proprio', 'PUT', () => '/api/me/avatar/recorte', undefined, { soSemLogin: true }),
  // ── Times ──
  L('proprio', 'POST', () => '/api/teams', () => ({ nome: 'Time Novo da Alice', localizacao: 'Brasília', descricao: 'Peladas aos domingos' })), // (cidade e bairro geocodificam pela rede: têm teste à parte)
  L('admin', 'PATCH', (m) => `/api/teams/${m.A.slug}`, () => ({ nome: 'Domingueira FC', descricao: 'Peladas aos domingos', localizacao: 'Brasília', cor_fundo: '#112233', jogadores_por_time: 5 })),
  L('admin', 'PUT', (m) => `/api/teams/${m.A.slug}/brilhante-kit`, () => ({ kitId: 'dark-gold' })),
  L('admin', 'DELETE', (m) => `/api/teams/${m.A.slug}/logo`),
  L('admin', 'POST', (m) => `/api/teams/${m.A.slug}/logo`, undefined, { soSemLogin: true }),
  L('membro', 'PATCH', (m) => `/api/equipas/${m.A.slug}/membros/posicao`, () => ({ goleiro: true })),
  L('membro', 'PATCH', (m) => `/api/equipas/${m.A.slug}/membros/joga`, () => ({ joga: true })),
  L('membro', 'PATCH', (m) => `/api/teams/${m.A.slug}/membros/ausencia`, () => ({ ausente: true })),
  L('admin', 'PATCH', (m) => `/api/teams/${m.A.slug}/membros/${m.p.memA2.id}/ativo`, () => ({ ativo: false })),
  L('admin', 'PATCH', (m) => `/api/teams/${m.A.slug}/membros/${m.p.memA2.id}`, () => ({ role: 'member' })),
  L('admin', 'DELETE', (m) => `/api/teams/${m.A.slug}/membros/${m.p.memA2.id}`),
  L('membro', 'DELETE', (m) => `/api/teams/${m.A.slug}/membros/me`, undefined, { permitidos: ['memA2'], negacoes: [400, 403, 404] }), // sair do time (quem não é do time recebe 400)
  L('membro', 'POST', (m) => `/api/teams/${m.A.slug}/convite`, () => ({})),
  L('admin', 'DELETE', (m) => `/api/teams/${m.A.slug}/convites/${m.ids.conviteA}`),
  L('admin', 'PATCH', (m) => `/api/teams/${m.A.slug}/pedidos/${m.ids.pedidoA}`, () => ({ status: 'rejected' })),
  L('proprio', 'DELETE', (m) => `/api/me/pedidos/${m.ids.pedidoA}`),
  L('proprio', 'POST', (m) => `/api/teams/${m.A.slug}/pedir-entrada`, () => ({}), { regraDeNegocio403: true }), // o time A é privado: 403 "este time não é público"
  L('proprio', 'DELETE', (m) => `/api/teams/${m.A.slug}/pedir-entrada`),
  // ── Jogos ──
  L('admin', 'POST', () => '/api/games', (m) => ({ team_slug: m.A.slug, data: iso(48 * HORA), jogadores_por_time: 5, local: 'Quadra Vila Nova' })),
  L('membro', 'POST', (m) => `/api/games/${m.ids.jogoPassadoA}/link-curto`, () => ({})),
  L('membro', 'POST', (m) => `/api/games/${m.ids.jogoPassadoA}/partilha-declarada`, () => ({})),
  L('admin', 'PATCH', (m) => `/api/games/${m.ids.jogoPassadoA}/resultado`, (m) => ({ campeao_time_index: 1, placar_a: 1, placar_b: 2, gols: [{ user_id: m.p.memA.id, gols: 2 }, { convidado_nome: 'Zeca', gols: 1 }] })),
  L('admin', 'POST', (m) => `/api/games/${m.ids.jogoPassadoA}/jogador`, (m) => ({ user_id: m.p.memA.id, goleiro: true })),
  L('membro', 'POST', (m) => `/api/games/${m.ids.jogoAbertoA}/confirmar`, () => ({ confirmado: true })),
  L('admin', 'POST', (m) => `/api/games/${m.ids.jogoAbertoA}/presencas`, (m) => ({ jogadores: [{ user_id: m.p.memA.id }] })),
  L('admin', 'POST', (m) => `/api/games/${m.ids.jogoAbertoA}/times-manuais`, (m) => ({ times: [{ nome: 'Ouro', jogadores: [{ user_id: m.p.memA.id, nome: 'Alice' }] }, { nome: 'Roxo', jogadores: [{ nome: 'Zeca', convidado: true }] }] })),
  L('admin', 'POST', (m) => `/api/games/${m.ids.jogoPassadoA}/associar-jogador`, (m) => ({ convidado_nome: 'Zeca', user_id: m.p.memA.id })),
  L('admin', 'POST', (m) => `/api/games/${m.ids.jogoPassadoA}/associar-jogador/desfazer`, (m) => ({ user_id: m.p.memA.id })),
  L('admin', 'POST', (m) => `/api/games/${m.ids.jogoAbertoA}/sortear`, () => ({ convidados: ['Zeca', 'Beto', 'Caio', 'Dani', 'Edu', 'Fábio'] })),
  L('admin', 'PUT', (m) => `/api/games/${m.ids.jogoAbertoA}/convidados`, () => ({ convidados: [{ nome: 'Zeca', cabeca_chave: true }, { nome: 'Beto', goleiro: true }] })),
  L('admin', 'PATCH', (m) => `/api/games/${m.ids.jogoPassadoA}/times`, (m) => ({ times_resultado: { times: [{ nome: 'Time 1', jogadores: [{ user_id: m.p.admA.id, nome: 'Ana' }] }, { nome: 'Time 2', jogadores: [{ user_id: m.p.memA.id, nome: 'Alice' }] }], reservas: [] } })),
  L('admin', 'PATCH', (m) => `/api/games/${m.ids.jogoAbertoA}`, () => ({ location: 'Quadra nova' })),
  L('admin', 'PATCH', (m) => `/api/games/${m.ids.jogoAbertoA}/capacidade`, () => ({ max_jogadores: 12 })),
  L('admin', 'POST', (m) => `/api/games/${m.ids.jogoAbertoA}/cancelar`, () => ({ motivo: 'Chuva' })),
  L('admin', 'DELETE', (m) => `/api/games/${m.ids.jogoAbertoA}`),
  L('admin', 'POST', (m) => `/api/teams/${m.A.slug}/jogos/recorrentes`, () => ({ dia_semana: 3, hora: '20:00', semanas: 4 })),
  // ── Presença (RSVP) ──
  L('admin', 'POST', (m) => `/api/jogos/${m.ids.jogoAbertoA}/rsvp/abrir`, () => ({ prazo: iso(24 * HORA) })),
  L('admin', 'POST', (m) => `/api/jogos/${m.ids.jogoAbertoA}/rsvp/fechar`, () => ({})),
  L('membro', 'POST', (m) => `/api/jogos/${m.ids.jogoAbertoA}/rsvp/responder`, () => ({ status: 'confirmado' })),
  L('membro', 'POST', (m) => `/api/jogos/${m.ids.jogoAbertoA}/rsvp/sair-espera`, () => ({})),
  // ── Ranking e notas ──
  L('membro', 'POST', (m) => `/api/teams/${m.A.slug}/votar`, (m) => ({ para_user_id: m.p.memA2.id, nota: 4 })),
  L('admin', 'POST', (m) => `/api/teams/${m.A.slug}/pedir-revotacao`, () => ({})),
  L('admin', 'DELETE', (m) => `/api/teams/${m.A.slug}/votos/${m.p.memA2.id}`),
  L('admin', 'DELETE', (m) => `/api/teams/${m.A.slug}/votos`),
  // ── Resenha ──
  L('admin', 'POST', () => '/api/feed/posts', (m) => ({ team_id: m.A.id, body: 'Resenha do domingo', media: [{ url: midiaDe(m.p.admA.id), media_type: 'image', position: 0 }] })),
  L('admin', 'POST', (m) => `/api/feed/equipas/${m.A.slug}/anuncio`, () => ({ titulo: 'Aviso', mensagem: 'Jogo domingo às 20h' })),
  L('autorOuAdmin', 'DELETE', (m) => `/api/feed/posts/${m.ids.postA}`),
  L('admin', 'PATCH', (m) => `/api/feed/games/${m.ids.jogoPassadoA}/resultado`, (m) => ({ campeao_time_index: 0, artilheiro_user_id: m.p.memA.id, artilheiro_gols: 2, destaque_user_id: m.p.memA2.id, destaque_titulo: 'Craque', rodada_user_id: m.p.admA.id, campeao_foto_url: midiaDe(m.p.admA.id) })),
  L('membro', 'POST', () => '/api/feed/reacoes', (m) => ({ target_type: 'post', target_id: m.ids.postA, emoji: '👍' })),
  L('membro', 'POST', () => '/api/feed/comentarios', (m) => ({ parent_type: 'post', parent_id: m.ids.postA, body: 'Boa!', reply_to: m.ids.comA, anexos: [{ url: midiaDe(m.p.memA.id), media_type: 'image' }] })),
  L('autorOuAdmin', 'DELETE', (m) => `/api/feed/comentarios/${m.ids.comA}`),
  L('membro', 'POST', () => '/api/feed/denuncias', (m) => ({ target_type: 'post', target_id: m.ids.postA, motivo: 'spam' })),
  L('admin', 'PATCH', (m) => `/api/feed/denuncias/${m.ids.denA}/resolver`, () => ({ apagar_conteudo: false })),
  L('proprio', 'POST', () => '/api/feed/upload', undefined, { soSemLogin: true }),
  // ── Campeonato antigo (2 times) e novo (N times) ──
  L('admin', 'POST', (m) => `/api/equipas/${m.A.slug}/campeonato`, () => ({ nome: 'Copa Antiga', num_jornadas: 4 })),
  L('admin', 'POST', (m) => `/api/equipas/${m.A.slug}/campeonatos`, (m) => ({ nome: 'Copa', formato: 'pontos', nomes: ['Ouro', 'Roxo', 'Prata'], plantel: [[{ user_id: m.p.memA.id, nome: 'Alice', avatar_url: null, convidado: false }], [{ nome: 'Zeca', convidado: true }], []] })),
  L('admin', 'POST', (m) => `/api/equipas/${m.A.slug}/campeonatos/de-sorteio`, (m) => ({ game_id: m.ids.jogoPassadoA, formato: 'pontos' })),
  // ── Push ──
  L('proprio', 'POST', () => '/api/push/subscribe', () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } })),
  L('proprio', 'DELETE', () => '/api/push/subscribe', () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' })),
  L('proprio', 'PATCH', () => '/api/push/preferencias', () => ({ jogos: false })),
  L('admin', 'POST', (m) => `/api/push/equipas/${m.A.slug}/broadcast`, () => ({ titulo: 'Aviso', mensagem: 'Chuva, jogo cancelado' })),
  L('admin', 'POST', (m) => `/api/push/equipas/${m.A.slug}/membros/${m.p.memA.id}/mensagem`, () => ({ titulo: 'Oi', mensagem: 'Vem jogar' })),
  // ── Bloqueios, denúncias, pedidos, diagnóstico ──
  L('proprio', 'POST', () => '/api/blocks', (m) => ({ blocked_id: m.p.memA2.id })),
  L('proprio', 'DELETE', (m) => `/api/blocks/${m.p.memA2.id}`),
  L('membro', 'POST', () => '/api/denuncias', (m) => ({ target_type: 'post', target_id: m.ids.postA, categoria: 'spam', descricao: 'propaganda' })),
  L('admin', 'POST', (m) => `/api/denuncias/${m.ids.denA}/decidir`, (m) => ({ slug: m.A.slug, acao: 'manter' })),
  L('proprio', 'POST', () => '/api/brilhantes/pedido', () => ({ produto: 'minha' })),
  L('proprio', 'POST', () => '/api/diagnostico', () => ({ resumo: 'ok' })),
  L('proprio', 'POST', () => '/api/compras/sincronizar', () => ({ transacoes: [] })),
  // ── Gabinete e super-admin ──
  L('super', 'PATCH', (m) => `/api/super/users/${m.p.memA2.id}/suspender`, () => ({ suspenso: true })),
  L('super', 'PATCH', (m) => `/api/super/users/${m.p.memA2.id}/ban`, () => ({ ban: true })),
  L('super', 'PATCH', (m) => `/api/super/teams/${m.B.id}/suspender`, () => ({ suspensa: true })),
  L('super', 'DELETE', (m) => `/api/super/teams/${m.B.id}`),
  // a conta descartável é uma @futtymock de teste (não a do revisor das lojas): o super a exclui de verdade
  L('super', 'DELETE', (m) => `/api/super/users/${m.p.lixo.id}`, () => ({ confirmar: 'EXCLUIR' })),
  L('super', 'POST', (m) => `/api/super/contas-sem-time/${m.p.fora.id}/time`, (m) => ({ team_id: m.A.id })),
  L('super', 'PUT', () => '/api/super/gabinete/operacao', () => ({})),
  L('super', 'POST', () => '/api/super/gabinete/brilhantes/ativar-pacote', (m) => ({ team_id: m.A.id })),
  L('super', 'POST', () => '/api/super/gabinete/brilhantes/creditos', (m) => ({ user_id: m.p.memA.id, quantidade: 1 })),
  L('super', 'POST', () => '/api/super/gabinete/brilhantes/recusar', () => ({ pedido_id: '00000000-0000-4000-8000-000000000000' })),
  L('super', 'POST', (m) => `/api/super/denuncias/${m.ids.denA}/decidir`, () => ({ acao: 'manter' })),
];

// As rotas que escrevem e são públicas DE PROPÓSITO, cada uma com a sua trava (provadas em seguranca-escrita.test.js).
const PUBLICAS_DE_PROPOSITO = [
  'POST /api/ads/evento', 'POST /api/ads/eventos', 'POST /api/telemetria', 'POST /api/avise-me', 'POST /api/compras/webhook/revenuecat',
  'POST /api/interno/pintar/:jobId', // segredo + token do Cloud Tasks
  'POST /api/csp', // os avisos da CSP do site: o navegador manda sem sessão; limite por IP, nada vai para o banco (tests/csp.test.js)
  'POST /api/convite/:token/pendente', // sem sessão de propósito (a página do convite ainda não tem conta); limite por IP, convite válido, nada volta na resposta
];
// Rotas com login, mas cuja autorização é o próprio token/id da URL (provadas à parte).
const POR_TOKEN = ['POST /api/convite/:token/aceitar'];
// Rotas do campeonato novo: provadas, uma a uma, em seguranca-rotas-novas.test.js.
const NO_TESTE_DAS_ROTAS_NOVAS = [
  'POST /api/equipas/:slug/campeonatos/:id/confrontos/:cid/resultado', 'POST /api/equipas/:slug/campeonatos/:id/desempate',
  'POST /api/equipas/:slug/campeonatos/:id/terminar', 'DELETE /api/equipas/:slug/campeonatos/:id',
  'POST /api/campeonato/:id/jornada', 'POST /api/campeonato/:id/terminar',
];


module.exports = { L, LINHAS, PUBLICAS_DE_PROPOSITO, POR_TOKEN, NO_TESTE_DAS_ROTAS_NOVAS, CLASSES, desenho, midiaDe };
