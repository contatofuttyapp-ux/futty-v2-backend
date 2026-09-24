// Futty v2.0 — sobe o escudo da Missa de Quinta pelo mesmo caminho do painel
// de admin (POST /api/teams/:slug/logo, routes/teams.js): bucket "avatars",
// path logos/<teamId>.<ext>, teams.logo_url, ?v= para invalidar cache.
//
// Diferença de propósito (não de mecânica): o painel guarda o arquivo como o
// admin manda (PNG/JPG/WEBP, sem redimensionar); aqui a imagem entra pela
// regra geral do app (CLAUDE.md, "App leve"): WebP no dobro do tamanho de
// exibição. Maior uso do logo hoje é TeamAvatar "lg" = 64px → 128px.
// Sem filtro NSFW: upload direto do dono, sem fila de moderação.
require('dotenv').config();
const fs = require('fs');
const sharp = require('sharp');
const { supabase } = require('../utils/db');

const ARQUIVO = 'C:/Users/phfer/Desktop/FUT/TIME CAMPEÃO/Logo Missa de Quinta.png';
const NOME_TIME = 'Missa de Quinta';
const LADO_MAX = 128; // 2x o maior uso atual (TeamAvatar "lg" = 64px)
const QUALIDADE = 80; // mesma qualidade WebP do resto do app (routes/feed.js)

const normalizar = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

async function main() {
  const { data: times, error: eTimes } = await supabase.from('teams').select('id, nome, slug, logo_url');
  if (eTimes) throw new Error(`teams: ${eTimes.message}`);
  const time = (times || []).find((t) => normalizar(t.nome) === normalizar(NOME_TIME));
  if (!time) throw new Error(`Time "${NOME_TIME}" não encontrado.`);
  console.log(`· time "${time.nome}" (${time.slug}, ${time.id}) — logo atual: ${time.logo_url || '(nenhum)'}`);

  const original = fs.readFileSync(ARQUIVO);
  const webp = await sharp(original)
    .resize(LADO_MAX, LADO_MAX, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: QUALIDADE })
    .toBuffer();
  console.log(`· convertido: ${original.length} bytes (png) → ${webp.length} bytes (webp, até ${LADO_MAX}px)`);

  const caminho = `logos/${time.id}.webp`;
  const { error: eUp } = await supabase.storage.from('avatars').upload(caminho, webp, {
    contentType: 'image/webp', upsert: true, cacheControl: '3600',
  });
  if (eUp) throw new Error(`upload: ${eUp.message}`);

  const { data: pub } = supabase.storage.from('avatars').getPublicUrl(caminho);
  const logoUrl = `${pub.publicUrl}?v=${Date.now()}`;
  const { error: eTeam } = await supabase.from('teams').update({ logo_url: logoUrl }).eq('id', time.id);
  if (eTeam) throw new Error(`teams.logo_url: ${eTeam.message}`);

  console.log(`✓ logo_url atualizado: ${logoUrl}`);
}

main().catch((e) => { console.error('[logo] ERRO:', e.message); process.exitCode = 1; });
