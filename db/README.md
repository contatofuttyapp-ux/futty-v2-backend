# Base de dados — Futty v2

Esquema PostgreSQL alojado no **Supabase**. As migrações estão em `db/migrations/`,
numeradas pela ordem em que devem ser aplicadas.

## Como aplicar (Supabase Dashboard)

1. Abre o teu projeto em https://supabase.com → **SQL Editor** → **New query**.
2. Cola o conteúdo de cada ficheiro de `db/migrations/` **pela ordem numérica** e carrega em **Run**:

   | Ficheiro | O que cria |
   |---|---|
   | `001_schema.sql` | Tabelas base: `users`, `teams`, `team_members`, `games`, `votes`, RLS, funções e trigger |
   | `002_convites.sql` | Tabela `convites` (links de convite) |
   | `003_games.sql` | `game_players` + campos de sorteio em `games` |
   | `004_votes.sql` | Liga os votos a um jogo (`votes.game_id`) |
   | `005_champion_photos.sql` | Stats em `team_members` + tabela `champion_photos` |

3. Numa base de dados nova, aplica de `001` a `005`. Todas as migrações são
   **idempotentes** (`IF NOT EXISTS` / `DROP POLICY IF EXISTS`), por isso é seguro
   re-executar.

## Notas

- O backend usa a **service_role key** (faz *bypass* da RLS), mas cada migração
  inclui os `GRANT` necessários para essa role.
- `db/schema.sql` mantém o esquema completo consolidado (equivalente a aplicar
  001→005 de uma vez) — útil para uma instalação rápida de raiz.
- Os ficheiros antigos por fase (`convites.sql`, `games.sql`, `fase6.sql`,
  `fase7.sql`, `fase7b.sql`) ficam mantidos por compatibilidade, mas as
  **migrações numeradas em `db/migrations/` são a referência**.
