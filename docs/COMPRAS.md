# Compras — como o dinheiro vira figurinha

Pagamentos P1 (26-set). O código: `routes/compras.js` (rotas), `utils/compras.js` (regra de crédito), migração `064_compras.sql`.

## O fluxo

```
app (SDK RevenueCat) → App Store / Play Store cobra
      → RevenueCat → POST /api/compras/webhook/revenuecat
      → utils/compras.aplicarCompra → linha em `compras` + crédito
```

- **Uma linha por transação.** O índice único `(loja, transacao_id)` impede crédito em dobro: o RevenueCat reenvia webhooks, e o "Restaurar compras" pode chegar antes ou depois dele.
- **O app nunca credita sozinho.** `POST /api/compras/sincronizar` só diz ao motor *que transações procurar*; o motor pergunta à API do RevenueCat (`RC_API_KEY`) e credita só o que ela confirmar.
- **O Gabinete também passa por aqui:** créditos e pacote dados à mão viram linha `loja='gabinete'`, `transacao_id='gab-<uuid>'`, preço 0.
- `app_user_id` no RevenueCat = `users.id` (o app faz `Purchases.logIn(users.id)`). O pacote e o manto levam o time no atributo de assinante `team_id`.

## Produtos (iguais nas duas lojas)

| product_id | produto | o que faz |
|---|---|---|
| `futty_minha` | minha | +10 gerações para quem comprou |
| `futty_pacote` | pacote | liga o pacote do time (só o dono do time — `team_members.role='admin'`) |
| `futty_manto` | manto | gravado e pago; o uniforme próprio é montado à mão (fica pendente no Gabinete) |

O pacote comprado na loja herda o uniforme que o time já tiver. Se não tiver, liga com o uniforme vazio (ninguém gera ainda) e o uniforme é fixado no Gabinete ("Ativar pacote" num time já ativo só grava o uniforme).

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

## Variáveis (Cloud Run)

| variável | para quê |
|---|---|
| `RC_WEBHOOK_SECRET` | segredo do webhook. **Sem ele o motor de produção não arranca** — colar antes de publicar. |
| `RC_API_KEY` | chave `sk_…` do RevenueCat; sem ela o "Restaurar compras" responde 503 |
| `RC_ACEITAR_SANDBOX` | `false` transforma compras de sandbox em `ignorada` (padrão `true` até a 1.0.1 sair) |
| `PAGAMENTOS_ATIVOS` | `true` faz o app mostrar a loja (`loja_pronta` em `/api/brilhantes/estado`) |

## Testar em sandbox

1. Aplicar a 064 e pôr as variáveis no motor que vai receber o teste.
2. No painel do RevenueCat, **Send test event** → o motor responde 200 e não grava nada.
3. Compra de verdade em sandbox: iPhone com conta de teste da Apple (Settings → App Store → Sandbox Account) ou testador de licença na Play Console; comprar `futty_minha` no app.
4. Conferir: `/api/super/gabinete/brilhantes` → `compras` mostra a linha com `ambiente='sandbox'`; os créditos da pessoa sobem 10.
5. Reembolso: no painel do RevenueCat, abrir o cliente → a transação → *Refund* → a linha vira `reembolsada` e os créditos descem.

Sandbox **credita de verdade** no banco (é o mesmo Supabase). A receita do Gabinete conta só produção; o sandbox aparece em `sandbox_mes`.
