# Downstream AI runtime integration

GBrain exposes its canonical AI configuration, provider probes, gateway budget
tracker, and database-backed reservation ledger as package subpaths. Downstream
servers should reuse these modules instead of copying provider configuration,
pricing, or spend-accounting logic.

## Public package paths

| Package path | Supported responsibility |
|---|---|
| `gbrain/ai/config` | `buildGatewayConfig()` and its `AIGatewayConfig` return type |
| `gbrain/ai/gateway` | `configureGateway()`, provider calls, diagnostics, and `withBudgetTracker()` |
| `gbrain/ai/probes` | Structured OpenAI-compatible and local-provider `/v1/models` probes |
| `gbrain/budget/tracker` | `BudgetTracker`, `BudgetExhausted`, actual-usage extraction, and pricing views |
| `gbrain/budget/ledger` | `BudgetLedger` reserve/commit/rollback/state operations over a `BrainEngine` |
| `gbrain/budget/mcp` | Atomic per-OAuth-client reserve/settle operations over the native MCP spend tables |

These are exports of the native implementation, not downstream adapters or a
second ledger.

## Configure once at startup

```ts
import { loadConfig } from 'gbrain/config';
import { buildGatewayConfig } from 'gbrain/ai/config';
import { configureGateway } from 'gbrain/ai/gateway';

const storedConfig = loadConfig();
if (!storedConfig) throw new Error('gbrain configuration is unavailable');
const config = buildGatewayConfig(storedConfig);
configureGateway(config);
```

`buildGatewayConfig()` snapshots the effective process environment and folds
supported file-plane keys and provider base URLs into the gateway config. Its
return value contains credentials: do not log, serialize, or return it.

The gateway is module-global. A multi-tenant server must select one immutable
platform policy at process startup and must not call `configureGateway()` per
request or per tenant. Tenant-owned keys require a separate process boundary.

## Probe readiness

`probeOpenAICompat(baseUrl)` validates that the explicit endpoint answers with
the OpenAI-compatible models-list shape. `probeOllama()`, `probeLMStudio()`, and
`probeLlamaServer(baseUrl?)` apply the same structured probe to their supported
local endpoints. A result distinguishes unreachable endpoints from reachable
but invalid models endpoints.

The models-list probe does not prove that a paid chat, embedding, or reranking
call will succeed. Use `diagnoseEmbedding()` or `probeChatModel()` from
`gbrain/ai/gateway` for zero-spend configuration checks. A live hosted-provider
readiness check must use the applicable gateway call with an abort signal and a
bounded `BudgetTracker`; never send a live probe during every user request.

## Attribute and bound gateway calls

```ts
import { withBudgetTracker } from 'gbrain/ai/gateway';
import { BudgetTracker } from 'gbrain/budget/tracker';

const tracker = new BudgetTracker({
  label: 'brain-123/import-456',
  maxCostUsd: 2,
  auditPath: '/srv/gbrain/audit/brain-123-import-456.jsonl',
});

const result = await withBudgetTracker(tracker, async () => {
  // Calls made through gateway.chat/embed/rerank in this async scope reserve
  // against the tracker before dispatch and record actual usage afterward.
  return runNativeWork();
});
```

When a cap is present, unknown pricing fails closed with
`BudgetExhausted(reason: 'no_pricing')`. Keep the tracker label and audit path
bound to the authorized job/brain; do not reuse one tracker across unrelated
tenants.

## Reserve durable resolver spend

`BudgetLedger` is the native database-backed reserve/commit/rollback primitive
for paid resolver work. Construct it with the routed brain engine, pass an
explicit scope, reserve before the provider call, then commit actual USD or
roll back when no charge occurred.

```ts
import { BudgetError, BudgetLedger } from 'gbrain/budget/ledger';

const ledger = new BudgetLedger(brainEngine, { tz: 'UTC' });
const reservation = await ledger.reserve({
  scope: 'brain-123',
  resolverId: 'provider:model',
  estimateUsd: 0.05,
  capUsd: 5,
});

if (reservation.kind === 'exhausted') throw new Error(reservation.reason);

try {
  const actualUsd = await callResolver();
  await ledger.commit(reservation.reservationId, actualUsd);
} catch (error) {
  // cap_exceeded means commit finalized and recorded the paid call. Do not
  // retry it. Roll back only when the provider call incurred no charge.
  if (!(error instanceof BudgetError && error.code === 'cap_exceeded')) {
    await ledger.rollback(reservation.reservationId);
  }
  throw error;
}
```

The OAuth/MCP spend-log helpers are a different internal accounting path and
do not automatically mirror `BudgetTracker` events. For paid MCP operations,
use the supported reservation seam instead of a read-then-call spend check:

```ts
import { reserve, settle } from 'gbrain/budget/mcp';

const held = await reserve(brainEngine, {
  clientId: authorizedClientId,
  estimatedCents: 0.12,
  capCents: 500,
  provider: 'voyage',
  model: 'voyage-multimodal-3',
});

const result = await callPaidProvider();
await settle(brainEngine, held.reservationId, 0.12, 'search_by_image', tokenName);
```

On Postgres, `reserve()` serializes same-client decisions with a
transaction-scoped advisory lock; the cap check and pending insert commit as
one transaction. `settle()` commits the reservation state and spend-log mirror
atomically. Both fail closed on accounting errors. If a provider call times out
or its billing outcome is unknown, settle a documented pessimistic upper bound;
never settle it to zero. A late paid result can still settle an expired hold.
Rollback/cancellation is intentionally not exposed until a caller can prove
that no provider charge occurred.

Use each primitive only for the native workflow it owns rather than
double-writing the same call.
