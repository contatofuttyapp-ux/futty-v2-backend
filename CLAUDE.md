# FUTTY — Constituição (backend)

Node + Express + Supabase (service_role em `utils/db.js`; PostgREST). Porta 3001,
`node --watch`. Par do frontend canónico `FUTTY-V2/frontend` (ver a CLAUDE.md de lá
para o processo completo: mockup-first, look do utilizador, selo só após aprovação).

## Regras deste repo
- **Commits coordenados**: routes/*.js novos entram no MESMO commit que o server.js
  que os importa; vagas que tocam os dois repos selam-se em par (mensagens em pt).
- **Migrations**: `db/migrations/NNN_nome.sql`, idempotentes (`if not exists`);
  aplicadas à mão no Supabase — o commit regista, não executa.
- **Gating por membership**: endpoints de equipa passam por requireTeamMember/getRole;
  dados de jogador só saem para quem partilha equipa (`equipas_partilhadas`).
- **Flags de equipa**: `teams.mostrar_gols` (037) — off → gols/artilharia fora do
  payload (radar 5↔3); o padrão para flags novas (boolean not null default true).
- **Assets**: fotos/avatares vivem em `public/` FORA do git (.gitignore); URLs
  absolutas `localhost:3001/public/...`; backup próprio é assunto da fase Privacidade.
- **Contas/jogadores**: convidados sem app e equipas avulsas (sorteio/campeonatos)
  NUNCA criam linhas em `users`/`teams` — vivem no payload do jogo/campeonato.
- **Sorteio**: algoritmo em `utils/sorteio.js` (GR 1/time, cabeças, snake-draft,
  sobra→reservas); requisito aberto: persistir a SEMENTE para replay exacto.
- Emails `@futtymock.com` = contas de teste (podem ser semeadas/limpas à vontade);
  contas reais nunca se tocam.
