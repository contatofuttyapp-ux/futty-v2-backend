# Migrações — como escrever uma nova

Quem roda é o Pedro, à mão, no SQL Editor do Supabase. Número novo = o último + 1 (`087_…sql`). Nunca editar
uma migração que já rodou: conserto vira migração nova.

## GRANT explícito sempre (regra do Supabase a partir de 30-out-2026)

Desde 30-out-2026 o Supabase deixa de dar permissão automática a objeto novo em `public`: tabela, view,
sequência ou função criada sem `GRANT` não é vista por **ninguém** — nem pela chave secreta do motor
(`service_role`). O motor recebe `permission denied` e a rota quebra.

Por isso **toda migração que cria tabela, view ou função em `public` termina com os GRANTs explícitos e com
a RLS**. Vale também para o banco recriado do zero (rodar 001 → última num projeto novo).

### Tabela ou view — o padrão da casa (trancada, só o motor)

O celular só usa o Supabase para o login; os dados passam todos pelo motor. Então tabela nova nasce trancada
(regra da 049): RLS ligada, nada para `anon`/`authenticated`, tudo para `service_role`.

```sql
alter table public.<t> enable row level security;
revoke all on table public.<t> from public;
revoke all on table public.<t> from anon, authenticated;
grant all on table public.<t> to service_role;
```

(View: as mesmas três linhas de `revoke`/`grant`, com `on table public.<v>`. Se a tabela tem coluna
`serial`/`identity`, a sequência ganha o mesmo par: `grant usage, select on sequence public.<t>_id_seq to service_role;`.)

### Só se o celular for ler a tabela direto (hoje: nenhuma)

Aí, e só aí, entram `authenticated` (e `anon` apenas se a tabela for pública de verdade), **sempre com as
políticas RLS na mesma migração** — sem política, a RLS barra tudo; com GRANT e sem RLS, qualquer pessoa com a
chave pública lê a tabela inteira.

```sql
alter table public.<t> enable row level security;
grant select, insert, update, delete on table public.<t> to authenticated;
grant all on table public.<t> to service_role;
-- grant select on table public.<t> to anon;   -- só se for pública mesmo
create policy "<t>: dono lê" on public.<t> for select to authenticated using (user_id = auth.uid());
-- … uma política por operação liberada
```

### Função

`security definer` com `search_path` fixo, dona explícita e `execute` só para quem chama (receita da 050):

```sql
alter function public.<f>(<args>) owner to postgres;
revoke all on function public.<f>(<args>) from public;
revoke all on function public.<f>(<args>) from anon, authenticated;
grant execute on function public.<f>(<args>) to service_role;
```

Função de gatilho (`returns trigger`) não precisa de `grant execute`: quem dispara é o próprio banco.

## Fim de toda migração

Um bloco `CONFERIR DEPOIS DE CORRER` com o `select` que prova que deu certo (ex.:
`select has_table_privilege('service_role', 'public.<t>', 'insert');` → `true` e o mesmo com `'anon'` →
`false`) e a linha de reversão.
