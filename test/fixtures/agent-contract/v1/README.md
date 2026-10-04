# Agent operator contract v1 goldens

Frozen wire shapes for `docs/protocol/AGENT_OPERATOR_v1.md` (spec:
`docs/designs/AGENT_OPERATOR_WAVE.md`, A0). Produced and checked by
`test/agent-contract-goldens.test.ts`; regenerate with
`GBRAIN_TEST_UPDATE_GOLDENS=1`.

- Fixtures never contain `next`: it is computed at render time from the
  effects, actor, transport, callability and preapprovals. Conformance tests
  recompute it.
- Docs URLs are stored as `{{DOCS_BASE}}/…` (the version-pinned base).
- `notice-block.txt` stores `next: {{next}}` for the same reason.
