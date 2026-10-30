# MCP `_meta` channels

Normative conventions for `ToolResult._meta` on gbrain's MCP surfaces.
`_meta` is the structured, out-of-band
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
   the model. Anything the model must SEE rides a content block (see the
   second text block on empty retrievals); `_meta` serves structured
   programmatic consumers (thin clients, harness plumbing, tests).

## Registered keys

| Key | Producer | Contents |
|-----|----------|----------|
| `brain_hot_memory` | dispatch `metaHook` on stdio and HTTP (`getBrainHotMemoryMeta`, [details](#brain_hot_memory)) | Hot-memory facts relevant to the call; each fact carries `trust_tier` and `origin`, and `suppressed` (`{withheld, review}`, present only when non-zero) counts unconfirmed agent-written facts activation control withheld, never their content |
| `retrieval` | `search`/`query` op handlers | `returned_count`, `retrieved_count`, `vector_enabled`, `expansion_applied`, `cache`, `token_budget`, `degraded[]` (closed stage vocabulary), `rerank_degraded` (on a call whose reranker failed: `{reason, fallback: "fused_order", calls_this_session}`; reason is `timeout`, `budget`, `rate_limited`, `unreachable`, `auth` or `provider_error`; no `fields: "full"` needed), `hint` (non-contractual prose), `rows` (`"lean"` or `"full"`: the row shape of content[0]; reported for remote callers and whenever `fields` is passed), `timings` (`{total_ms, stages_ms, other_ms, overlapped_ms?, parts_ms?}`, integer ms, every response; [search-explain.md](../guides/search-explain.md#see-where-the-time-went)) |
| `warnings` | dispatch strict-params warn mode | `[{code: 'unknown_param', param, suggestion?}]` |
| `pagination` | `list_pages` op handler | `truncated` (more rows match), `limit` (effective), `clamped_from?` (the caller's limit when capped), `next?` (params for the following page: `{sort, updated_after, updated_after_slug}` under `updated_asc`, else `{offset}`). The model-visible counterpart is the `listing_truncated` notice block (kind `info`, never deduped), whose `fix.mcp` is the next-page call. |

## `brain_hot_memory`

The brain's recent facts, attached to tool results so a harness can keep them
in front of the model without a separate call.

**When it is sent.** On a successful tool call over stdio (`gbrain serve`) and
over HTTP (`gbrain serve --http`), except `recall`, `extract_facts` and
`forget_fact`, which already return facts. It is absent when there is nothing
to send, and it is best-effort: if it cannot be built, the key is left out and
the tool call still succeeds. It cannot be turned off per call.

**Which facts.** Up to 10 facts from the call's source, ranked by decayed
confidence, with duplicates collapsed:

- facts recorded in the caller's session, when the request carries
  `_meta.session_id` (beside `arguments` or at request level); otherwise
- the source's newest facts from the last 24 hours, from any session.
  `context.hot_memory.session_only` narrows only the hook and `context_pack`
  paths, never this key.

Remote callers get world-visible facts only (private pages are excluded unless
`search.remote_private_pages` allows them), and the trust floor, quarantine and
activation control apply. Payloads are cached for up to 30 seconds per engine,
source, tier, session and eligibility; any write, forget or trust change
invalidates them.

**Shape** (fields are additive-forever, per rule 2):

```json
{
  "brain_hot_memory": {
    "source_id": "default",
    "session_id": "s-123",
    "suppressed": { "withheld": 1, "review": 0 },
    "facts": [
      {
        "id": 42, "fact": "Prefers morning meetings", "kind": "preference",
        "notability": "high", "entity_slug": "people/alice-example",
        "valid_from": "2026-10-01T00:00:00.000Z", "created_at": "2026-10-01T09:30:00.000Z",
        "context": null, "confidence": 0.91,
        "trust_tier": "agent_written", "origin": "mcp:user_said", "unconfirmed": true
      }
    ]
  }
}
```

`suppressed` appears only when activation control withheld facts, and counts
them without their content. `attributed_to`, `entity_slugs` and `unconfirmed`
appear only when set.

**Using it from a harness.** Most harnesses drop `_meta` before the model
(rule 5), so these facts reach the model only if the harness copies them in:

1. Send a stable `_meta.session_id` per conversation, so the block carries
   that conversation's facts instead of the source's newest.
2. Read `result._meta.brain_hot_memory.facts` from each tool result and add
   them to the next model turn as context, labeled as saved memory.
3. Apply your own access rules before showing them: the 24-hour fallback can
   carry another session's facts, such as a different user's direct messages
   on a shared brain. Treat `unconfirmed: true` and `trust_tier:
   "agent_written"` facts as claims to check, not as the user's words.

A harness that cannot do this still gets the same facts on purpose through the
per-turn hook or `context_pack` ([ambient writeback](../guides/ambient-writeback.md)).

Inbound `_meta` (e.g. `_meta.session_id` inside tool ARGUMENTS) is a
separate, client-to-server plane. The eval-report `_meta.metric_glossary`
lives in JSON BODIES of eval commands — a third, unrelated plane. Ambient
recall rides content/hooks, not `_meta`.

Adding a key: register it in the table above, one producer, additive-forever.
