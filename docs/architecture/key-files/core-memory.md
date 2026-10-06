# Always-loaded core memory (key files cluster)

[Subsystem index](../KEY_FILES.md).

Owner-designated pages (`always_load: true`) rendered into every session,
held to a brain-wide character budget on the write path, plus the
save-before-compaction path (`remember` with `items`, the context-pressure
notice). User guide: [core memory](../../guides/core-memory.md).

- `src/core/core-memory.ts`: marking and priority normalization, settings
  (`memory.core.*`), page rendering and budget accounting, `listCorePages`
  (withdrawal-aware), `renderCoreBlock` (whole-page truncation, notice lines,
  withheld lines), `coreRevision`, the delivery sensitivity policy
  (`applyCoreSensitivity`: credential-like hits withhold, contact details and
  private paths redact) and `loadCoreBlock`, which every delivery lane uses.
- `src/core/persistence/core-guard.ts`: the write-path guard run from
  `preparePageMutation`: owner-only marking (`core_mark_owner_only`,
  `core_delete_owner_only`), the budget (`core_budget_exceeded`, re-checked in
  the publish transaction), the remote-edit policy and `core_edit_notices`
  rows, and `lockCoreSources`.
- Lock order for a core-touching publish (`coordinator.ts`): worktree native
  lock, then the protocol declaration takes the brain row first
  (`declareDurablePersistence` in `protocol.ts`, `persistence_brain` FOR
  SHARE), then `guardOwnership` (`persistence_worktrees` FOR SHARE), then
  `lockCoreSources` (`sources` rows FOR UPDATE, `ORDER BY id`, own source plus
  `default`) in the source-exclusive slot, then `authorizeStoredRequest`
  (`sources` FOR SHARE), then `lockCounters`: the global order `protocol.ts`
  documents. `put_pages` batch groups skip the per-request source lock, so
  `groupable()` excludes core-locked writes.
  `test/e2e/core-memory-locks-postgres.test.ts` races core writes against
  topology changes and a claim-shaped transaction on Postgres.
- `scripts/check-core-guard-coverage.mjs` (`bun run check:core-guard-coverage`,
  in `verify`): every PreparedMutation builder routes through the guard or is
  on its reviewed exemption list, and wrappers forward `exclusiveSources`.
- Delivery: `src/commands/hook.ts` session-start (core first via
  `src/core/context/session-start-output.ts`), `context_pack`
  (`src/core/ops/facts.ts`, `src/mcp/context-pack-handler.ts`, including the
  read-only `coreOnly` IPC arm), OpenClaw `assemble()` in
  `src/core/context-engine.ts` (60 s memo), and `gbrain compile-context
  --include-core` (`src/core/context/compile-view.ts`,
  `src/core/context/compiled-core.ts` for git safety and the record doctor
  reads).
- Pressure notice: `src/core/context/pressure.ts` (gate read by serve, transcript
  scan, window detection, once-per-segment state); wired in the user-prompt
  hook and OpenClaw `assemble()`.
- `src/core/remember-batch.ts`: `remember` with `items[]` (all-or-none
  validation, deterministic child request ids, per-item status).
- `src/commands/core.ts` (`gbrain core`), `src/commands/doctor/checks/core-memory.ts`
  (`core_memory`), schema `src/core/core-memory-schema.ts` + migration v213.
- Tests: `test/core-memory.test.ts`, `test/core-guard.test.ts`,
  `test/core-cli.test.ts`, `test/compile-context-core.serial.test.ts`,
  `test/context-pressure.test.ts`, `test/remember-batch.test.ts`,
  `test/e2e/core-memory-locks-postgres.test.ts`.
