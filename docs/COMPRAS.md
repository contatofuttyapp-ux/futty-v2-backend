# Compras — como o dinheiro vira figurinha

Pagamentos P1 e P2 (26-set). O código: no motor, `routes/compras.js` (rotas), `utils/compras.js` (regra de crédito), migração `064_compras.sql`; no app, `frontend/src/lib/loja.js` (o único lugar que fala com o SDK) e `frontend/src/pages/Planos.jsx` (a loja na tela).

## O fluxo

```
app (SDK RevenueCat) → App Store / Play Store cobra
      → RevenueCat → POST /api/compras/webhook/revenuecat
      → utils/compras.aplicarCompra → linha em `compras` + crédito
```

- **Uma linha por transação.** O índice único `(loja, transacao_id)` impede crédito em dobro: o RevenueCat reenvia webhooks, e o "Restaurar compras" pode chegar antes ou depois dele.
- **O app nunca credita sozinho.** `POST /api/compras/sincronizar` só diz ao motor *que transações procurar*; o motor pergunta à API do RevenueCat (`RC_API_KEY`) e credita só o que ela confirmar.
- **O Gabinete também passa por aqui:** créditos e pacote dados à mão viram linha `loja='gabinete'`, `transacao_id='gab-<uuid>'`, preço 0.
- `app_user_id` no RevenueCat = `users.id` (o app faz `Purchases.configure({ appUserID: users.id })` e `logIn`/`logOut` na troca de conta). O pacote e o manto levam o time no atributo de assinante `team_id` (a Minha Figurinha não leva time).

## Produtos (iguais nas duas lojas)

| product_id | produto | o que faz |
|---|---|---|
| `futty_minha` | minha | +10 gerações para quem comprou |
| `futty_pacote` | pacote | liga o pacote do time (só o dono do time — `team_members.role='admin'`) |
| `futty_manto` | manto | gravado e pago; o uniforme próprio é montado à mão (fica pendente no Gabinete) |

O pacote comprado na loja herda o uniforme que o time já tiver. Se não tiver, liga com o uniforme vazio (ninguém gera ainda) e o **dono escolhe** logo depois da compra (P2: `PUT /api/teams/:slug/brilhante-kit` — só o admin, só com o pacote ativo, trocar só antes da 1ª geração; o Início mostra o recado enquanto faltar). O Gabinete também fixa ("Ativar pacote" num time já ativo só grava o uniforme).

**Quanto o pacote dá (Rodada 29A, 30-set — "nunca prejuízo", dono 26-set):** **2 gerações por jogador** (`teams.brilhante_por_jogador`, padrão 2 pela migração `065_pacote_2_geracoes.sql`; eram 5), até 25 jogadores, só o uniforme do time. Pior caso: 50 gerações × US$0,112 = US$5,60 contra US$8,18 que sobram depois dos 15% da loja (margem de 31%). Quem já tinha gasto mais de 2 antes da mudança fica sem geração nova — nunca com saldo negativo (`restantes` é limitado a 0). A Minha Figurinha dá 10 gerações (US$1,12 de custo máximo contra US$1,62 que sobram).

**Não existe presente do criador:** criar um time não dá geração nenhuma (abolido em 26-set). `users.presente_criador_em` fica na tabela só como histórico, ninguém mais escreve nela; quem já recebeu as 3 gerações mantém o que tem. `POST /api/teams` devolve só `{ team }`.

O manto comprado na loja cria o pedido `manto` pendente do time: é a fila do Gabinete, e o app mostra "Manto pedido — a gente desenha e avisa" em vez de vender de novo.

## Eventos do webhook

| evento | o que acontece |
|---|---|
| `INITIAL_PURCHASE`, `NON_RENEWING_PURCHASE` | credita |
| `CANCELLATION` com `cancel_reason=CUSTOMER_SUPPORT` | reembolso: tira as 10 gerações (mínimo 0) ou desliga o pacote que a própria loja ligou |
| `TEST` | 200, nada gravado |
| qualquer outro, pessoa desconhecida, regra que falhou | 200 + linha `estado='ignorada'` com o payload; nos dois últimos casos os super-admins recebem push |

Responde 5xx só quando o banco falhou — aí o RevenueCat reenvia sozinho.

## O que o Pedro cola no painel do RevenueCat

Project settings → Integrations → **Webhooks** → Add:

- **URL:** `https://futty-api-685039278359.southamerica-east1.run.app/api/compras/webhook/revenuecat`
- **Authorization header:** `Bearer ` + o mesmo valor de `RC_WEBHOOK_SECRET` do Cloud Run
- Ambiente: *Production and Sandbox*

E a chave secreta: Project settings → API keys → **Secret API key** (`sk_…`) → vai para `RC_API_KEY` no Cloud Run. Nunca no app.

## O app (P2)

A loja só aparece com as três coisas: `PAGAMENTOS_ATIVOS=true` no motor (vira `loja_pronta` no `/api/brilhantes/estado` e no `/api/inicio` — liga e desliga sem build novo) — ou só para as plataformas de `PAGAMENTOS_PLATAFORMAS` (pelo cabeçalho `X-Futty-Plataforma` que o app manda; sem a variável valem `android` e `ios`), o app nativo, e a chave PÚBLICA do SDK no build. Faltando uma, a tela fica no "Pedir ativação" (o Gabinete ativa à mão). A web nunca vende.

| variável (frontend) | onde |
|---|---|
| `VITE_RC_APPLE_KEY` | chave pública do app iOS no RevenueCat (`appl_…`) |
| `VITE_RC_GOOGLE_KEY` | chave pública do app Android no RevenueCat (`goog_…`) |

As duas vão em `frontend/.env` e `frontend/.env.production` (o `.aab` é compilado aqui), na Cloudflare Pages (Production e Preview) e nos GitHub Secrets do frontend (o `ios.yml` escreve o `.env.production` do iPhone). São públicas — vão dentro do app — mas nunca a `sk_…`.

No painel do RevenueCat: os 3 produtos criados como **consumíveis** na App Store Connect (Consumable) e na Play Console (produto único), importados no RevenueCat e marcados como consumíveis (o Google precisa "consumir" para dar para comprar de novo). A tela pede primeiro as ofertas (`getOfferings`, a oferta atual com os 3 pacotes) e o que faltar busca pelo id (`getProducts`) — as duas configurações funcionam. O preço mostrado é sempre o da loja (`priceString`), na moeda da conta da pessoa.

## Variáveis (Cloud Run)

| variável | para quê |
|---|---|
| `RC_WEBHOOK_SECRET` | segredo do webhook. **Sem ele o motor de produção não arranca** — colar antes de publicar. |
| `RC_API_KEY` | chave `sk_…` do RevenueCat; sem ela o "Restaurar compras" responde 503 |
| `RC_ACEITAR_SANDBOX` | `false` transforma compras de sandbox em `ignorada` (padrão `true` até a 1.0.1 sair) |
| `PAGAMENTOS_ATIVOS` | `true` faz o app mostrar a loja (`loja_pronta` em `/api/brilhantes/estado`) |
| `PAGAMENTOS_PLATAFORMAS` | plataformas com a loja ligada, separadas por vírgula (`ios`, `android`, `web`), ex.: `android`. Só decide a vitrine; o crédito sai só do webhook. Sem a variável valem `android,ios`; definida e vazia, nenhuma. O motor escreve na subida `[Futty] loja: plataformas=…, ativos=…` — é por ela que se confere no log depois de um deploy |

## Testar em sandbox

1. Aplicar a 064 e pôr as variáveis no motor que vai receber o teste.
2. No painel do RevenueCat, **Send test event** → o motor responde 200 e não grava nada.
3. Compra de verdade em sandbox: iPhone com conta de teste da Apple (Settings → App Store → Sandbox Account) ou testador de licença na Play Console; comprar `futty_minha` no app.
4. Conferir: `/api/super/gabinete/brilhantes` → `compras` mostra a linha com `ambiente='sandbox'`; os créditos da pessoa sobem 10.
5. Reembolso: no painel do RevenueCat, abrir o cliente → a transação → *Refund* → a linha vira `reembolsada` e os créditos descem.

Sandbox **credita de verdade** no banco (é o mesmo Supabase). A receita do Gabinete conta só produção; o sandbox aparece em `sandbox_mes`.

## O Pacote do time pode ser comprado mais de uma vez (Rodada 31F)
O dono do time compra o `futty_pacote` quantas vezes quiser, como presente para o time. Cada compra soma **+2 gerações para cada jogador** (até 25 jogadores, a regra de sempre), em cima do que cada um ainda tem: o que o jogador pode gerar no time é `teams.brilhante_por_jogador` (= 2 × os pacotes creditados do time, contados em `compras`), e o que ele já gerou (`brilhantes_time.geracoes`) não muda — o saldo é a diferença. Quem entra depois começa do zero gasto e recebe tudo o que os pacotes já comprados dão. Idempotência: a mesma transação (loja + id) nunca soma duas vezes. O uniforme (`brilhante_kit`) continua o que o dono escolheu. Um time ligado à mão antes de existir a tabela `compras` ganha uma linha `legado-<time>` (loja gabinete, preço 0, `payload.legado`) quando compra o 2º pacote, para a conta ser só contar linhas. Reembolso de um pacote tira as 2 dele (e desliga o pacote só quando não sobra nenhum). Sem migração.
