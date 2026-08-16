# MCP `_meta` channels

Normative conventions for `ToolResult._meta` on gbrain's MCP surfaces
(WP2 amendment 9 / decision D3). `_meta` is the structured, out-of-band
channel for tool-call responses; the response BODY contract never changes
shape for it.

## Rules

1. **One producer per top-level key.** A producer owns exactly one
   namespaced key and never writes another producer's key. The dispatch
   layer (`src/mcp/dispatch.ts`) merges per top-level key — never wholesale
   `_meta` assignment.
2. **Additive-forever within a key.** Fields inside a key may be added,
   never renamed or removed — the RESPONSE_SCHEMAS discipline applied to
   `_meta`. Consumers must tolerate unknown fields.
3. **Producer isolation.** Every producer attaches inside its own
   try/catch. A failing producer degrades to its key being absent; it never
   drops another producer's key and never errors the tool call.
4. **Merge precedence.** Handler-emitted keys (via
   `OperationContext.emitResponseMeta`) attach first; transport hooks
   (`metaHook`) attach after and may add keys but shadow nothing that
   matters — key ownership (rule 1) makes ordering a non-event.
5. **Model visibility caveat.** Mainstream harnesses do NOT feed `_meta` to
   the model. Anything the model must SEE rides a content block (see the D8
   second text block on empty retrievals); `_meta` serves structured
   programmatic consumers (thin clients, harness plumbing, tests).

## Registered keys

| Key | Producer | Contents |
|-----|----------|----------|
| `brain_hot_memory` | serve-http `metaHook` (`getBrainHotMemoryMeta`) | Hot-memory facts relevant to the call (v0.31 eD3) |
| `retrieval` | `search`/`query` op handlers | `returned_count`, `retrieved_count`, `vector_enabled`, `expansion_applied`, `cache`, `token_budget`, `degraded[]` (closed stage vocabulary, D6), `hint` (non-contractual prose, E1) |
| `warnings` | dispatch strict-params warn mode (WP3) | `[{code: 'unknown_param', param, suggestion?}]` |

Inbound `_meta` (e.g. `_meta.session_id` inside tool ARGUMENTS, CX2-11) is a
separate, client-to-server plane. The eval-report `_meta.metric_glossary`
lives in JSON BODIES of eval commands — a third, unrelated plane. Ambient
recall (#4028) rides content/hooks, not `_meta`.

Adding a key: register it in the table above, one producer, additive-forever.
