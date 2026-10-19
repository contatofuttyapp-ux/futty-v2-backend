// Futty v2.0 — Explorar times públicos (busca por nome/cidade e a vitrine dos públicos). Montadas por routes/teams.js ANTES de
// /api/teams/:slug, para não colidirem com o param :slug.

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/http');
const { supabase } = require('../utils/db');
const { condicaoPorCidade } = require('../utils/cidade');
const plataforma = require('../utils/plataformaStore');
const { lerComFuso } = require('../utils/fuso'); // o fuso do time
const { escudoDoTime } = require('../utils/escudo'); // o escudo do time
const { recusaDoWaf } = require('../utils/recusaDoWaf');

const router = express.Router();

// Escapa um valor para uso dentro da string de filtro do .or() do PostgREST.
// Vírgula separa condições, parênteses agrupam, ponto separa
// coluna.operador.valor — um valor com qualquer um deles precisa vir entre
// aspas duplas (sintaxe suportada pelo PostgREST) para ser lido como valor
// literal em vez de sintaxe de filtro.
function valorFiltroOr(valor) {
  // A barra invertida escapa a si mesma ANTES das aspas: sem isso, o texto `a\"` virava `a\\"`, que o PostgREST lê como "barra, fecha as aspas" e o
  // resto da busca passava a valer como condição nova do filtro.
  if (/[,.()"\\]/.test(valor)) return `"${valor.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return valor;
}

/**
 * GET /api/teams/explorar — times públicos (pesquisa por nome/cidade).
 * Registrado ANTES de /api/teams/:slug para não colidir com o param :slug.
 */
router.get(
  '/api/teams/explorar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const loc = String(req.query.localizacao ?? '').trim();

    // geo_lat/geo_lng (arredondados) vão no payload → o cliente calcula a distância
    // LOCALMENTE (a posição do usuário nunca chega ao servidor). Só times públicos.
    const COLUNAS = 'id, nome, slug, cor, localizacao, cidade, descricao, logo_url, cor_fundo, modo_visibilidade, geo_lat, geo_lng';
    // O escudo (segunda cor e padrão, migração 077) vai junto — sem a migração a leitura repete sem ele
    // (lerComFuso). O bairro (coluna da migração 073) vai junto; sem ela a leitura repete sem o bairro e
    // os times valem sem bairro.
    const montar = (comNormalizada, comBairro, novas) => {
      const escudo = (novas || '').split(', ').filter((c) => c.startsWith('escudo_')).join(', ');
      let query = supabase
        .from('teams')
        .select([COLUNAS, comNormalizada ? 'cidade_normalizada' : '', comBairro ? 'bairro' : '', escudo].filter(Boolean).join(', '))
        .in('modo_visibilidade', ['publico_aprovacao', 'publico_aberto']);
      // q pesquisa em nome OU localização (a barra única diz "nome ou cidade").
      // SEGURANCA-REVISAO-10SET.md secção 3: q ia direto para dentro da
      // string de filtro do .or() — vírgula separa condições, parênteses
      // agrupam, ponto separa coluna.operador.valor no PostgREST; um q com esses
      // caracteres conseguia adicionar/alterar condições do filtro. O PostgREST
      // suporta valores com esses caracteres se o valor inteiro vier entre aspas
      // duplas — é o que valorFiltroOr faz quando encontra algum deles.
      if (q) {
        const padrao = valorFiltroOr(`%${q}%`);
        // Time SEM coordenada (cidade que o Nominatim não achou) casa pelo texto da cidade, normalizado — igual à
        // busca normalizada. Com coordenada, quem manda é a distância (app).
        const porCidade = comNormalizada ? condicaoPorCidade(q, valorFiltroOr) : '';
        query = query.or(`nome.ilike.${padrao},localizacao.ilike.${padrao}${porCidade}`);
      }
      if (loc) query = query.ilike('localizacao', `%${loc}%`);
      return query;
    };

    // Migração 066 (cidade_normalizada) ou 073 (bairro) por aplicar: a coluna que faltar sai e a busca continua como era.
    let comNormalizada = true;
    let comBairro = true;
    let teamsRaw;
    let error;
    let status;
    for (let tentativa = 0; tentativa < 3; tentativa += 1) {
      ({ data: teamsRaw, error, status } = await lerComFuso((novas) => montar(comNormalizada, comBairro, novas)));
      const mensagem = error?.message || '';
      if (comBairro && /bairro/i.test(mensagem)) comBairro = false;
      else if (comNormalizada && /cidade_normalizada/i.test(mensagem)) comNormalizada = false;
      else break;
    }
    if (error) {
      // O WAF na frente do banco recusou o texto digitado (`a;cat /etc/passwd;`): para a pessoa, é uma busca
      // sem resultado, não um erro do servidor. Só com texto digitado — sem ele, quem quebrou foi o banco.
      if ((q || loc) && recusaDoWaf(error, status)) {
        console.warn('[teams] explorar: o banco recusou o texto digitado, respondendo lista vazia (WAF).');
        return res.json({ teams: [] });
      }
      throw new HttpError(500, error.message);
    }

    // Equipa suspensa = invisível na descoberta.
    const { equipas: susEquipas } = await plataforma.conjuntos();
    const teams = (teamsRaw || []).filter((t) => !susEquipas.has(t.id));

    const ids = (teams || []).map((t) => t.id);
    const counts = {};
    const meus = new Set();
    if (ids.length) {
      const { data: mem } = await supabase.from('team_members').select('team_id, user_id').in('team_id', ids);
      for (const m of mem || []) {
        counts[m.team_id] = (counts[m.team_id] || 0) + 1;
        if (m.user_id === req.user.id) meus.add(m.team_id);
      }
    }
    const pendentes = new Set();
    if (ids.length) {
      const { data: reqs } = await supabase
        .from('team_join_requests')
        .select('team_id')
        .eq('user_id', req.user.id)
        .eq('status', 'pending')
        .in('team_id', ids);
      for (const r of reqs || []) pendentes.add(r.team_id);
    }

    const lista = (teams || [])
      .map((t) => ({
        id: t.id,
        nome: t.nome,
        slug: t.slug,
        ...escudoDoTime(t), // cor + escudo_cor2 + escudo_padrao
        logo_url: t.logo_url || null,
        cor_fundo: t.cor_fundo || null,
        modo_visibilidade: t.modo_visibilidade,
        localizacao: t.localizacao,
        cidade: t.cidade || null,
        cidade_normalizada: t.cidade_normalizada || null, // o app casa por texto quando não há ponto
        bairro: t.bairro || null, // o card do Radar mostra "Bairro · Cidade"
        descricao: t.descricao,
        geo_lat: t.geo_lat ?? null, // arredondado ~1km; só entra na busca por distância se não-nulo
        geo_lng: t.geo_lng ?? null,
        membro_count: counts[t.id] || 0,
        ja_membro: meus.has(t.id),
        pedido_pendente: pendentes.has(t.id),
      }))
      .sort((a, b) => b.membro_count - a.membro_count);

    res.json({ teams: lista });
  })
);

/**
 * GET /api/teams/publicas — times públicos com nº de membros e último jogo,
 * ordenadas por recência do último jogo (7d > 30d > resto) e depois nº membros.
 * Equivalente ao SQL do briefing (feito em JS — o cliente Supabase não faz GROUP BY).
 * Registrado ANTES de /api/teams/:slug para não colidir com o param :slug.
 */
router.get(
  '/api/teams/publicas',
  requireAuth,
  asyncHandler(async (req, res) => {
    // A cor e o escudo vão junto (o card desenha o escudo do time sem logo); sem a 077, só a cor.
    const { data: teamsRaw, error } = await lerComFuso((novas) => {
      const escudo = (novas || '').split(', ').filter((c) => c.startsWith('escudo_')).join(', ');
      return supabase
        .from('teams')
        .select(['id, nome, slug, cor, descricao, localizacao, logo_url, cor_fundo, modo_visibilidade', escudo].filter(Boolean).join(', '))
        .in('modo_visibilidade', ['publico_aberto', 'publico_aprovacao']);
    });
    if (error) throw new HttpError(500, error.message);

    // Equipa suspensa = invisível na descoberta.
    const { equipas: susEquipas } = await plataforma.conjuntos();
    const lista = (teamsRaw || []).filter((t) => !susEquipas.has(t.id));
    const ids = lista.map((t) => t.id);

    const membros = {};
    const ultimoJogoTs = {};
    if (ids.length) {
      const { data: tm } = await supabase.from('team_members').select('team_id, user_id').in('team_id', ids);
      for (const m of tm || []) membros[m.team_id] = (membros[m.team_id] || 0) + 1;

      const { data: gs } = await supabase.from('games').select('team_id, data').in('team_id', ids).is('cancelado_at', null);
      for (const g of gs || []) {
        const ts = g.data ? new Date(g.data).getTime() : 0;
        if (ts > (ultimoJogoTs[g.team_id] || 0)) ultimoJogoTs[g.team_id] = ts;
      }
    }

    const now = Date.now();
    const cut7 = now - 7 * 86400000;
    const cut30 = now - 30 * 86400000;
    const bucket = (ts) => (ts > cut7 ? 1 : ts > cut30 ? 2 : 3);

    const out = lista
      .map((t) => ({
        id: t.id,
        nome: t.nome,
        slug: t.slug,
        descricao: t.descricao,
        localizacao: t.localizacao,
        ...escudoDoTime(t),
        logo_url: t.logo_url || null,
        cor_fundo: t.cor_fundo || null,
        modo_visibilidade: t.modo_visibilidade,
        numero_membros: membros[t.id] || 0,
        ultimo_jogo: ultimoJogoTs[t.id] ? new Date(ultimoJogoTs[t.id]).toISOString() : null,
      }))
      .sort((a, b) => {
        const ba = bucket(ultimoJogoTs[a.id] || 0);
        const bb = bucket(ultimoJogoTs[b.id] || 0);
        if (ba !== bb) return ba - bb;
        return b.numero_membros - a.numero_membros;
      });

    res.json({ teams: out });
  })
);

module.exports = router;
