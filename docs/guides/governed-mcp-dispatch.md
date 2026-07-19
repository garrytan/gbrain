# Embedding governed MCP dispatch

`gbrain/mcp/dispatch` is the supported seam for a policy-owning gateway that
wants to expose a reviewed subset of native gbrain operations without mounting
gbrain's HTTP or stdio server.

The gateway remains responsible for authentication, authorization, rate
limits, audit, tenant/brain selection, and MCP transport framing. The gbrain
seam supplies the native parameter validation, `OperationContext`, handler
calling convention, tool-result envelope, and `OperationError` mapping.

```ts
import { operations } from 'gbrain/operations';
import { createGovernedMcpDispatcher } from 'gbrain/mcp/dispatch';

const approved = operations.filter(operation => reviewedNames.has(operation.name));
const nativeMcp = createGovernedMcpDispatcher({
  operations: approved,
  config: immutableProcessConfig,
  logger,
});

// Use this exact list for MCP tools/list.
const tools = nativeMcp.listTools();

// Authenticate/authorize and select a per-brain engine before dispatch.
const result = await nativeMcp.dispatch(toolName, params, {
  engine: tenantEngine,
  sourceId: route.sourceId,
  auth: route.authInfo,
  takesHoldersAllowList: route.takesHoldersAllowList,
});
```

## Security contract

- The factory snapshots the operation ceiling, schemas, and handler references.
  Later mutation of the caller's list or operation objects cannot widen or
  replace the dispatcher.
- A `GovernedOperationResolver` may dynamically deny a listed operation. It
  cannot return a different handler: the returned operation must be the exact
  object advertised by `listOperations()` at construction.
- Config is explicit, copied, and deeply frozen. Context construction never
  calls `loadConfig()` or consults `GBRAIN_HOME`/config files.
- `sourceId` is required per call. The dispatcher does not silently select the
  `default` source.
- Calls are always `remote: true`, and the top-level `OperationContext`, auth
  data, config, and allow-list arrays are frozen before the handler runs.
- Native `OperationError` codes/messages remain caller-visible. Unexpected
  exceptions return only `internal_error` with `The tool failed unexpectedly.`;
  thrown details do not cross the MCP boundary.
- `gbrain/mcp/tool-defs` exposes the native `buildToolDefs` and
  `paramDefToSchema` helpers without exposing either gbrain HTTP server.

This seam does **not** enforce OAuth scopes, `localOnly`, application rate
limits, spend policy, or per-tenant audit. Exclude disallowed operations before
factory construction and enforce caller-specific policy before every dispatch.
It also does not remove process-global state from an operation's own handler;
operations that depend on ambient provider, schema-pack, or filesystem state
still require a reviewed isolated worker or must remain denied.
