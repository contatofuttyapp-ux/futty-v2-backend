// Futty v2.0 — sobe o escudo de um time pelo mesmo caminho do painel de admin
// (POST /api/teams/:slug/logo, routes/teams.js): bucket "avatars", path
// logos/<teamId>.<ext>, teams.logo_url, ?v= para invalidar cache.
//
// Diferença de propósito (não de mecânica): o painel guarda o arquivo como o
// admin manda (PNG/JPG/WEBP, sem redimensionar); aqui a imagem entra pela
// regra geral do app (CLAUDE.md, "App leve"): WebP no dobro do tamanho de
// exibição. Maior uso do logo hoje é TeamAvatar "lg" = 64px → 128px.
// Sem filtro NSFW: upload direto do dono, sem fila de moderação.
//
// Serve qualquer time (TIME-TESTE.md parte A):
//   node scripts/subir-logo-time.js                                sem args, comportamento de sempre (Missa de Quinta)
//   node scripts/subir-logo-time.js --slug <slug> --arquivo <caminho>   sobe o logo de outro time
// A função `subirLogoTime` é exportada para outros scripts (time-teste.js)
// reutilizarem sem duplicar a lógica.
require('dotenv').config();
const fs = require('fs');
const sharp = require('sharp');
const { supabase } = require('../utils/db');

const ARQUIVO_PADRAO = 'C:/Users/phfer/Desktop/FUT/TIME CAMPEÃO/Logo Missa de Quinta.png';
const NOME_TIME_PADRAO = 'Missa de Quinta';
const LADO_MAX = 128; // 2x o maior uso atual (TeamAvatar "lg" = 64px)
const QUALIDADE = 80; // mesma qualidade WebP do resto do app (routes/feed.js)

const normalizar = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/**
 * Sobe o logo de UM time (por slug exato ou por nome, normalizado) e grava
 * teams.logo_url. Devolve { time, logoUrl }. Lança em qualquer falha.
 * @param {object} opts
 * @param {string} [opts.slug] slug exato do time (tem prioridade sobre nome)
 * @param {string} [opts.nome] nome do time (comparado sem acento/maiúsculas)
 * @param {string} opts.arquivo caminho do PNG/JPG de origem
 * @param {number} [opts.ladoMax] lado máximo do WebP (padrão 128px)
 * @param {number} [opts.qualidade] qualidade WebP (padrão 80)
 */
async function subirLogoTime({ slug, nome, arquivo, ladoMax = LADO_MAX, qualidade = QUALIDADE } = {}) {
  if (!slug && !nome) throw new Error('subirLogoTime: informe slug ou nome.');
  if (!arquivo) throw new Error('subirLogoTime: informe o caminho do arquivo.');

  let time;
  if (slug) {
    const { data, error } = await supabase.from('teams').select('id, nome, slug, logo_url').eq('slug', slug).maybeSingle();
    if (error) throw new Error(`teams: ${error.message}`);
    time = data;
  } else {
    const { data: times, error } = await supabase.from('teams').select('id, nome, slug, logo_url');
    if (error) throw new Error(`teams: ${error.message}`);
    time = (times || []).find((t) => normalizar(t.nome) === normalizar(nome));
  }
  if (!time) throw new Error(`Time não encontrado (${slug ? `slug "${slug}"` : `nome "${nome}"`}).`);
  console.log(`· time "${time.nome}" (${time.slug}, ${time.id}) — logo atual: ${time.logo_url || '(nenhum)'}`);

  const original = fs.readFileSync(arquivo);
  const webp = await sharp(original)
    .resize(ladoMax, ladoMax, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: qualidade })
    .toBuffer();
  console.log(`· convertido: ${original.length} bytes (origem) → ${webp.length} bytes (webp, até ${ladoMax}px)`);

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
  return { time, logoUrl };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
  const slugArg = arg('slug');
  const arquivoArg = arg('arquivo');
  if (slugArg) {
    await subirLogoTime({ slug: slugArg, arquivo: arquivoArg || ARQUIVO_PADRAO });
  } else {
    // Sem argumentos: exatamente o comportamento de sempre (Missa de Quinta).
    await subirLogoTime({ nome: NOME_TIME_PADRAO, arquivo: arquivoArg || ARQUIVO_PADRAO });
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[logo] ERRO:', e.message); process.exitCode = 1; });
}

module.exports = { subirLogoTime };
