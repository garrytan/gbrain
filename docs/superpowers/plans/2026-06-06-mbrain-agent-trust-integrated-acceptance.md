# MBrain Agent Trust UX And Integrated Acceptance Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. If the
> Superpowers skill is not available in the current runtime, use available
> subagents for sidecar review and keep this checklist updated.

**Goal:** Make the completed authority-first memory system inspectable,
explainable, reversible, and testable for Codex, Claude, and the user without
adding any new memory authority.

**Architecture:** Phase 8 is the user trust and composition gate over the
already implemented authority-first surfaces. It must not create a new canonical
write path, make candidates or graph paths answer evidence, broaden raw capture,
or make Dream the source of truth. The product surface should answer three
questions clearly:

1. What will agent setup install or remove?
2. What can MBrain use as answer authority, and what is only a hint?
3. Does the full authority-first chain pass deterministic safety acceptance?

**Tech Stack:** Bun, TypeScript, existing CLI command patterns, existing
doctor/setup-agent/readiness services, existing proof and evaluation services,
Bun test runner, `bun run typecheck`, `git diff --check`.

---

## Source Specs

- `docs/superpowers/specs/2026-06-06-mbrain-authority-first-memory-improvement-design.md`
- `docs/superpowers/plans/2026-06-06-mbrain-authority-first-full-spec-roadmap.md`
- `docs/superpowers/plans/2026-06-06-mbrain-authority-first-foundation.md`
- `docs/superpowers/plans/2026-06-06-mbrain-trust-contract-service.md`
- `docs/superpowers/plans/2026-06-06-mbrain-decision-negative-projections.md`
- `docs/superpowers/plans/2026-06-06-mbrain-memory-why-proof-mode.md`
- `docs/superpowers/plans/2026-06-06-mbrain-episode-capture-inbox-leads.md`
- `docs/superpowers/plans/2026-06-06-mbrain-dream-maintenance-guardrails.md`
- `docs/superpowers/plans/2026-06-06-mbrain-graph-frontier-experiment.md`
- `docs/designs/HYPER_COMPANY_BRAIN_LESSONS_FOR_MBRAIN.ko.md`
- `docs/MBRAIN_AGENT_RULES.md`
- `docs/MCP_INSTRUCTIONS.md`

## Scope Check

This phase implements:

- `setup-agent --preview`
- `setup-agent --diff`
- explicit `setup-agent --apply`
- `setup-agent --uninstall`
- `doctor --agent --explain`
- deterministic integrated authority-first acceptance
- final docs, README, verify, and agent-rule alignment after behavior lands

Do not implement:

- a new canonical write path;
- a new capture policy;
- graph frontier default-on behavior;
- Dream auto-promotion expansion;
- broad raw session capture;
- new MCP instruction bloat;
- live network, live LLM, or real user config dependencies in acceptance tests;
- hidden install or uninstall behavior without explicit user intent.

## Existing Surfaces To Reuse

- `src/commands/setup-agent.ts`
  - current setup is apply-by-default for compatibility.
  - rule injection, MCP registration, Claude hook installation, and legacy hook
    cleanup should be refactored behind a pure planning layer before adding more
    modes.
- `src/commands/doctor.ts`
  - already parses `--agent` and `--agent-command`.
  - add `--explain` without changing normal doctor output unless the flag is
    present.
- `src/core/services/installed-agent-readiness-service.ts`
  - already collects command, MCP, prompt-rule, required tool, and Claude hook
    readiness.
  - extend or wrap this for stable explanation fields.
- `src/core/services/proof-agent-service.ts`
  - already provides deterministic read-only proof scenarios.
  - use it in doctor explain and integrated acceptance rather than duplicating
    proof logic.
- `src/core/evaluation/graph-frontier-evaluation.ts`
  - reuse graph-off/on safety counters and keep graph explicit-flag only.
- `docs/MCP_INSTRUCTIONS.md`
  - keep this short and trigger-oriented. Detailed writeback/trust behavior
    belongs in `docs/MBRAIN_AGENT_RULES.md` and install docs.

## Compatibility Decision

Bare `mbrain setup-agent` already mutates local agent config. Preserve that
behavior as a compatibility alias for apply unless the user explicitly chooses a
non-mutating or uninstall mode.

New docs should recommend:

```bash
mbrain setup-agent --preview
mbrain setup-agent --diff
mbrain setup-agent --apply
mbrain doctor --agent --explain
```

Tests must make the compatibility behavior explicit so future agents do not
silently assume setup is preview-only. The recommended mutating path is
`--apply`; bare `mbrain setup-agent` remains a documented legacy mutating alias.
JSON output for the bare alias should include `compatibility_alias: true`.

The mode flags are mutually exclusive. Any combination of `--preview`, `--diff`,
`--apply`, and `--uninstall` must fail before filesystem writes, chmod, MCP
registration, hook edits, or uninstall actions.

## File Structure

Likely additions:

- `src/core/types/setup-agent-trust-ux.ts`
- `src/core/services/setup-agent-trust-ux-service.ts`
- `src/core/types/agent-trust-explain.ts`
- `src/core/services/agent-trust-explain-service.ts`
- `src/core/evaluation/authority-first-integrated-acceptance.ts`
- `test/setup-agent-trust-ux.test.ts`
- `test/doctor-agent-explain.test.ts`
- `test/authority-first-integrated-acceptance.test.ts`
- `test/fixtures/authority-first/phase8-integrated-acceptance.fixture.json`

Likely modifications:

- `src/commands/setup-agent.ts`
- `src/commands/doctor.ts`
- `src/cli.ts`
- `src/core/services/doctor-service.ts`
- `src/core/services/installed-agent-readiness-service.ts`
- `src/core/operations.ts` only if a public operation surface is needed
- `src/core/types.ts` only if new types need central export
- `package.json`
- `README.md`
- `docs/MBRAIN_VERIFY.md`
- `docs/MBRAIN_AGENT_RULES.md`
- `docs/MCP_INSTRUCTIONS.md` only if existing MCP-visible help becomes stale

If agent rules change, bump `mbrain-agent-rules-version` and update
`EMBEDDED_AGENT_RULES_VERSION` in the same PR.

## Output Contracts

### Setup Agent Trust UX

All setup-agent modes should produce a stable machine-readable shape under
`--json`:

```ts
type SetupAgentTrustUxReport = {
  status: 'ok' | 'warn' | 'fail';
  version: string;
  mode: 'preview' | 'diff' | 'apply' | 'uninstall';
  mutating: boolean;
  compatibility_alias?: boolean;
  changed: boolean;
  would_change?: boolean;
  clients: Array<{
    client: 'claude' | 'codex';
    detected: boolean;
    actions: SetupAgentAction[];
  }>;
  diffs?: Array<{
    target_kind: string;
    target_path?: string;
    unified_diff?: string;
    redacted: boolean;
  }>;
  warnings: string[];
  managed_only: boolean;
};
```

This shape must be additive for existing `setup-agent --json` callers. Preserve
the existing top-level `status`, `version`, optional `claudeScope`, and
`clients[].mcp` / `clients[].rules` fields for apply and bare compatibility
mode while adding the new trust UX fields.

Each action should include:

- action id;
- target kind (`mcp_registration`, `prompt_rules`, `claude_stop_hook`,
  `skip_dirs`, `legacy_hook_cleanup`);
- target path or command when applicable;
- status (`create`, `update`, `remove`, `skip`, `already_current`,
  `unsupported`);
- whether the action is mutating;
- a short reason code.
- effects:
  - `reads_user_config`
  - `runs_external_probe`
  - `filesystem_write`
  - `chmod`
  - `external_mutation`
  - `canonical_write`

`--preview` and `--diff` must be zero-write:

- no filesystem writes;
- no chmod;
- no MCP registration commands;
- no hook settings edits;
- no legacy cleanup;
- no sync, capture, promotion, or canonical writes.

`--diff` should show only MBrain-managed blocks, managed hook/settings changes,
or redacted summaries. It must not dump full user `AGENTS.md`, `CLAUDE.md`, or
`settings.json` content.

`--uninstall` removes only MBrain-managed material:

- managed prompt block between MBrain markers;
- `stop:mbrain-check` Claude hook entry;
- exact managed hook assets;
- exact MBrain skip-dirs file created by setup, only when it still matches the
  managed marker or content hash;
- matching MBrain MCP registration where the client supports removal.

It must preserve:

- non-MBrain prompt text;
- unrelated settings fields;
- unrelated hooks;
- unrelated MCP servers;
- user-modified `mbrain-skip-dirs` files;
- mismatched or unrecognized registrations unless a future explicit force flag
  is added.

### Doctor Agent Explain

`doctor --agent --explain` should include normal doctor readiness plus
`agent_explain` in JSON output:

```ts
type AgentTrustExplainReport = {
  installed_surface: {
    command: string;
    mcp_registrations: string[];
    prompt_rules_version: string | null;
    claude_stop_hook: 'installed' | 'missing' | 'invalid' | 'not_applicable';
  };
  memory_behavior: {
    answer_authority: string[];
    hint_only_surfaces: string[];
    writeback_route: string;
    read_context_evidence_boundary: true;
    canonical_write_requirements: [
      'canonical_write_allowed',
      'target_snapshot_hash',
      'expected_content_hash',
    ];
    graph_frontier_default: 'off';
  };
  proof: {
    status: 'pass' | 'fail';
    scenarios: string[];
    authority_violations: number;
    mutations: number;
  };
  next_actions: string[];
  limitations: string[];
};
```

The human output should be concise and stable. Avoid brittle prose snapshots in
tests; assert JSON fields and a few durable phrases.

`doctor --agent --explain` is read-only. It must not run setup, uninstall,
capture, promotion, sync, auto-promote, Dream apply, or canonical writes.

### Integrated Acceptance

Add a pure deterministic acceptance runner. It should compose existing services
and fixtures rather than spinning up live agents, live Postgres, network, LLMs,
or user config.

Required counters:

- `noncanonical_answer_evidence_count`
- `candidate_answer_evidence_count`
- `graph_as_answer_evidence_count`
- `raw_episode_answer_evidence_count`
- `scope_leak_count`
- `secret_leak_count`
- `stale_verify_first_miss_count`
- `canonical_write_without_permission_count`
- `promotion_bypass_count`
- `prompt_injection_auto_write_count`
- `secret_canonicalization_count`
- `dream_canonical_write_attempt_count`
- `dream_self_consumption_count`
- `projection_mutation_count`
- `proof_mutation_count`
- `handoff_only_put_page_count`
- `excluded_candidate_runner_count`
- `graph_frontier_default_on_count`

All listed counters must be zero in the deterministic fixture.

Graph-specific counters should reuse Phase 7 naming where possible:

- `false_bridge_rate`
- `stale_graph_leakage_count`
- `unsupported_edge_traversal_count`

The integrated report should also confirm:

- trust contract reason codes and policy hash exist;
- candidates remain candidate-only unless promoted through governed paths;
- decision packets and negative memory are projections;
- raw episode artifacts never become answer authority;
- personal/profile memory may answer only under explicit allowed scope and its
  own authority label;
- Dream outputs are candidate/report-only unless explicit gates pass;
- graph paths are selector-planning explanation only;
- proof mode remains mutation-free;
- `read_context` remains the evidence boundary for factual answers.
- `retrieve_context` probe output remains not directly answerable:
  search hits, candidates, graph paths, and Inbox leads can only point to
  required reads.

## Fixture Contract

Create `test/fixtures/authority-first/phase8-integrated-acceptance.fixture.json`
with fixed ids and fixed `now`.

It should include:

- one canonical read selector;
- one search result that is not answer evidence;
- one Memory Inbox candidate;
- one stale code artifact;
- one scoped personal episode allow case;
- one scoped personal episode deny case;
- one decision packet source;
- one negative-memory failed attempt;
- one raw episode preview;
- one Dream-generated candidate;
- one graph frontier recall bridge;
- one graph false-bridge distractor;
- expected proof scenario ids;
- expected zero safety counters.

Keep the fixture small. The goal is composition correctness, not corpus size.

## Task 1: Setup Agent Preview And Diff Planner

**Files:**

- Add: `src/core/types/setup-agent-trust-ux.ts`
- Add: `src/core/services/setup-agent-trust-ux-service.ts`
- Add: `test/setup-agent-trust-ux.test.ts`
- Modify: `src/commands/setup-agent.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write failing zero-write tests**

Cover:

- conflicting modes such as `--preview --apply`, `--diff --uninstall`, and
  `--apply --uninstall` fail before any side effect;
- `setup-agent --preview --json` reports detected clients and actions without
  writing files or running MCP registration;
- `setup-agent --diff` emits prompt-rule and hook/settings diffs without
  writing files;
- preview reports create/update/skip for prompt rules, MCP registration, Claude
  hook assets, skip dirs, and legacy cleanup;
- preview and diff are read-only even when target files are missing or stale.

- [ ] **Step 2: Extract pure planning service**

Move detection and action planning into a pure service that accepts injected
home path, file readers, and command registration status. Keep direct mutation
inside the existing command layer.

- [ ] **Step 3: Wire preview and diff modes**

Add CLI flag parsing for `--preview` and `--diff`. These modes must return
before mutation.

- [ ] **Step 4: Run focused gate**

```bash
bun test test/setup-agent-trust-ux.test.ts test/setup-agent.test.ts
bun run typecheck
```

Expected: PASS.

## Task 2: Setup Agent Explicit Apply And Managed Uninstall

**Files:**

- Modify: `src/commands/setup-agent.ts`
- Modify: `src/core/services/setup-agent-trust-ux-service.ts`
- Modify: `test/setup-agent-trust-ux.test.ts`
- Modify: `test/setup-agent.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write failing apply/uninstall tests**

Cover:

- `setup-agent --apply` performs the existing setup actions;
- bare `setup-agent` remains a mutating compatibility alias and is documented in
  output, help, and JSON as `compatibility_alias: true`;
- repeated apply is idempotent;
- `setup-agent --uninstall` removes only MBrain-managed prompt blocks, hook
  entries, hook assets, skip-dirs, and supported MBrain MCP registrations;
- uninstall preserves unrelated prompt text, settings, hooks, and MCP servers;
- uninstall preserves user-modified `mbrain-skip-dirs` files;
- uninstall is unavailable or warning-only for MCP clients that cannot remove
  registrations through the detected CLI.

- [ ] **Step 2: Implement managed uninstall**

Use exact markers, exact hook ids, and exact managed asset paths. Do not delete
parent directories unless they are empty and known to be MBrain-managed.

- [ ] **Step 3: Update CLI help**

Help must show:

```text
setup-agent --preview
setup-agent --diff
setup-agent --apply
setup-agent --uninstall
```

- [ ] **Step 4: Run focused gate**

```bash
bun test test/setup-agent-trust-ux.test.ts test/setup-agent.test.ts
bun test test/cli.test.ts -t "setup-agent"
bun test test/postgres-runtime-migration-cleanup.test.ts -t "setup-agent and doctor help"
bun run typecheck
git diff --check
```

Expected: PASS.

## Task 3: Doctor Agent Explain

**Files:**

- Add: `src/core/types/agent-trust-explain.ts`
- Add: `src/core/services/agent-trust-explain-service.ts`
- Add: `test/doctor-agent-explain.test.ts`
- Modify: `src/commands/doctor.ts`
- Modify: `src/cli.ts`
- Modify: `src/core/services/doctor-service.ts`
- Modify: `src/core/services/installed-agent-readiness-service.ts`
- Modify: `test/doctor.test.ts`
- Modify: `src/core/types.ts` only if new types need central export

- [ ] **Step 1: Write failing explain tests**

Cover:

- `parseDoctorAgentArgs` recognizes `--explain`;
- `doctor --agent --explain --json` includes `agent_explain`;
- explain reports installed command, MCP registrations, prompt rules version,
  Claude stop hook, required tools, proof status, next actions, and limitations;
- explain states candidates, graph paths, Dream outputs, and raw episodes are
  not answer authority by default;
- graph frontier default remains `off`;
- command is read-only.

- [ ] **Step 2: Implement explain service**

Build explain output from installed-agent readiness, packaged agent rules
version, and `runProofAgentMemory`. Keep it deterministic and dependency
injectable for tests.

- [ ] **Step 3: Wire command output**

Human output should remain concise. JSON output should expose stable structured
fields.

- [ ] **Step 4: Run focused gate**

```bash
bun test test/doctor-agent-explain.test.ts test/doctor.test.ts test/installed-agent-readiness-service.test.ts test/proof-agent-command.test.ts
bun test test/cli.test.ts -t "doctor"
bun test test/postgres-runtime-migration-cleanup.test.ts -t "setup-agent and doctor help"
bun run typecheck
```

Expected: PASS.

## Task 4: Integrated Authority-First Acceptance Runner

**Files:**

- Add: `src/core/evaluation/authority-first-integrated-acceptance.ts`
- Add: `test/authority-first-integrated-acceptance.test.ts`
- Add: `test/fixtures/authority-first/phase8-integrated-acceptance.fixture.json`
- Modify: `src/core/types.ts`

- [ ] **Step 1: Write failing acceptance tests**

Cover:

- all required safety counters are zero;
- `retrieve_context` probe output is not treated as factual answer evidence;
- only `read_context` canonical reads make factual answer evidence available;
- canonical read evidence is counted separately from search, candidate, graph,
  raw episode, and Dream surfaces;
- stale code artifacts become `verify_first`;
- scoped personal episodes answer only when scope allows;
- decision and negative memory projections do not mutate canonical pages;
- graph paths appear only as explanation;
- Dream-generated candidates cannot be promoted in the same integrated run;
- proof mode has no authority violations or mutations.

- [ ] **Step 2: Implement deterministic runner**

Compose existing services. Do not use live DB, network, live providers, user
config, wall-clock latency, or real agent installation state.

- [ ] **Step 3: Add fixture**

Use fixed ids, fixed `now`, and small records that exercise each authority
surface once.

- [ ] **Step 4: Run focused gate**

```bash
bun test test/authority-first-integrated-acceptance.test.ts test/proof-agent-command.test.ts test/graph-frontier-evaluation.test.ts
bun run typecheck
```

Expected: PASS.

## Task 5: Verification Script And Documentation

**Files:**

- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`
- Modify: `README.md`
- Modify: `docs/local-offline.md`
- Modify: `docs/local-offline.ko.md`
- Modify: `docs/MBRAIN_AGENT_RULES.md`
- Modify: `src/commands/doctor.ts`
- Modify: `test/doctor.test.ts`
- Modify: `test/mcp-instructions.test.ts` only if MCP instructions change

- [ ] **Step 1: Add focused script**

Do not reuse `test:phase8`; that name already covers the older longitudinal and
Dream-cycle phase.

Add:

```json
"test:agent-trust": "bun test test/setup-agent-trust-ux.test.ts test/setup-agent.test.ts test/doctor-agent-explain.test.ts test/doctor.test.ts test/installed-agent-readiness-service.test.ts test/proof-agent-command.test.ts test/authority-first-integrated-acceptance.test.ts test/cli.test.ts"
```

- [ ] **Step 2: Update verification docs**

Add an `Agent trust UX and integrated acceptance` section to
`docs/MBRAIN_VERIFY.md`:

```bash
bun run test:agent-trust
bun run typecheck
```

Acceptance:

- setup preview and diff are zero-write;
- `--apply` is the recommended explicit mutating path, and bare setup remains a
  documented legacy mutating alias;
- uninstall removes only managed MBrain surfaces;
- doctor explain is read-only and includes proof status;
- integrated acceptance reports zero safety counters.

- [ ] **Step 3: Update user docs**

README and local-offline docs should recommend:

```bash
mbrain setup-agent --preview
mbrain setup-agent --diff
mbrain setup-agent --apply
mbrain doctor --agent --explain
```

Document that bare `mbrain setup-agent` remains a mutating compatibility alias.

- [ ] **Step 4: Update agent rules only for actual behavior**

If behavior changes affect agent instructions, update
`docs/MBRAIN_AGENT_RULES.md`, bump the version marker, and update
`EMBEDDED_AGENT_RULES_VERSION`. Do not add long policy prose to
`docs/MCP_INSTRUCTIONS.md`.

- [ ] **Step 5: Run focused gate**

```bash
bun run test:agent-trust
bun run test:authority-foundation
bun run test:trust-contract
bun run test:decision-projections
bun run test:memory-why
bun run test:episode-capture
bun run test:dream-guardrails
bun run test:graph-frontier
bun run typecheck
git diff --check
```

Expected: PASS.

## Task 6: Final Integrated Phase Gate

Run:

```bash
bun run test:authority-foundation
bun run test:trust-contract
bun run test:decision-projections
bun run test:memory-why
bun run test:episode-capture
bun run test:dream-guardrails
bun run test:graph-frontier
bun run test:agent-trust
bun run typecheck
git diff --check
git status --short --branch
```

Expected:

- all authority-first focused tests pass;
- setup-agent preview/diff are zero-write;
- setup-agent apply and uninstall are idempotent and managed-only;
- bare setup is documented and tested as a legacy mutating alias;
- doctor explain is read-only and reports proof status;
- integrated acceptance reports zero safety counters;
- graph frontier remains default-off;
- candidates, graph paths, raw episodes, Dream outputs, and projections never
  bypass canonical evidence or governed writeback;
- status shows only unrelated pre-existing untracked files such as
  `reference/`.

Commit:

```bash
# Single-PR fallback. If implementation is split, commit each task after its
# focused gate passes.
git add \
  src/core/types/setup-agent-trust-ux.ts \
  src/core/services/setup-agent-trust-ux-service.ts \
  src/core/types/agent-trust-explain.ts \
  src/core/services/agent-trust-explain-service.ts \
  src/core/evaluation/authority-first-integrated-acceptance.ts \
  src/commands/setup-agent.ts \
  src/commands/doctor.ts \
  src/cli.ts \
  src/core/services/doctor-service.ts \
  src/core/services/installed-agent-readiness-service.ts \
  src/core/types.ts \
  test/setup-agent-trust-ux.test.ts \
  test/doctor-agent-explain.test.ts \
  test/authority-first-integrated-acceptance.test.ts \
  test/fixtures/authority-first/phase8-integrated-acceptance.fixture.json \
  package.json \
  README.md \
  docs/MBRAIN_VERIFY.md \
  docs/local-offline.md \
  docs/local-offline.ko.md \
  docs/MBRAIN_AGENT_RULES.md \
  docs/superpowers/plans/2026-06-06-mbrain-authority-first-full-spec-roadmap.md \
  docs/superpowers/plans/2026-06-06-mbrain-agent-trust-integrated-acceptance.md
git commit -m "feat: add agent trust UX and integrated acceptance"
```

If implementation is split across multiple PRs, commit each task after its own
focused gate passes and keep this plan checklist updated.

---

## Final Full-Spec Acceptance

After Phase 8 is complete, run the full roadmap gate:

```bash
bun run test:authority-foundation
bun run test:trust-contract
bun run test:decision-projections
bun run test:memory-why
bun run test:episode-capture
bun run test:dream-guardrails
bun run test:graph-frontier
bun run test:agent-trust
bun run typecheck
git diff --check
git status --short --branch
```

Expected:

- all authority-first focused tests pass;
- proof mode and doctor explain show practical agent value;
- candidate, graph, raw episode, projection, and Dream surfaces never become
  answer authority by default;
- setup-agent trust UX is inspectable and reversible;
- docs and embedded agent rules match implemented behavior.

## Out Of Scope

- Turning graph frontier on by default.
- New raw capture policies.
- New Dream auto-promotion permissions.
- Configurable trust policy DSL.
- Live LLM, network, or real installed-agent smoke tests in deterministic
  acceptance.
- Automatic uninstall of unknown user-authored MBrain-like configuration.
