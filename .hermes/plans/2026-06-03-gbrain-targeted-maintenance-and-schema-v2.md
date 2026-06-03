# GBrain Targeted Maintenance + Schema v2 Readiness Implementation Plan

> **For Hermes:** Execute this plan directly in `~/gbrain` for code changes and against the live Mac mini GBrain instance only for safe maintenance. Do **not** run destructive type migration (`unify-types --apply`) without a preview and explicit approval.

**Goal:** Make the Mac mini GBrain more complete and less brittle by fixing schema-pack discovery for `gbrain-base-v2`, preserving/validating federated MCP visibility changes, running safe onboard maintenance, and preparing—but not blindly executing—the type-unification path.

**Architecture:** Treat this as two tracks: (1) safe operational remediation of the live brain (sync, embeddings, extraction) and (2) code-level readiness for schema-pack v2 discovery and future type migration. The code change should fix the discrepancy where the core loader can load `gbrain-base-v2` but `gbrain schema list/show/validate/use` cannot discover it through the CLI. Type migration remains gated behind a dry-run report because Idrees's brain has important domain-specific Kavalier/JDA/Personal types that stock v2 would otherwise collapse to generic `note`.

**Tech Stack:** Bun/TypeScript GBrain CLI, schema-pack YAML manifests, Postgres-backed GBrain DB, Hermes MCP integration, Bun tests.

---

## Current State Observed

- GBrain binary: `/Users/idreesoc/.bun/bin/gbrain`
- Version: `0.42.8.0`
- Engine: Postgres
- Active schema pack: `gbrain-base@1.0.0+7bd490ab`
- CLI `gbrain schema list` currently shows only:
  - `gbrain-base`
  - `gbrain-recommended`
- But source code includes bundled `src/core/schema-pack/base/gbrain-base-v2.yaml` and the loader registry already knows about `gbrain-base-v2`.
- Live stats before execution:
  - Pages: 2953
  - Chunks: 5787
  - Embedded: 5786
  - Links: 7856
  - Timeline: 543
- Onboard recommendations before execution:
  - auto sync: 312 stale pages on disk
  - auto extract timeline from meetings
  - auto embed catch-up: 1 chunk
  - auto extract link/timeline material
  - manual `unify-types` to `gbrain-base-v2`
- Local Codex patch exists in working tree:
  - `src/commands/extract.ts`
  - `src/commands/serve-http.ts`
  - `src/core/oauth-provider.ts`
  - `src/mcp/dispatch.ts`
  - `src/mcp/http-transport.ts`
  - backup files `*.bak-20260603-codex-federated-legacy`

## Root Causes / Why These Changes Matter

### 1. GBrain is close to complete, but not fully caught up

The brain has strong graph coverage and nearly complete embeddings, but onboard reports stale disk pages and one stale/missing embedding. Running safe onboard automation should pull the live vault state into the DB and close the embedding gap.

### 2. Schema-pack discovery is inconsistent

The core loader recognizes `gbrain-base-v2`, but the CLI helper `packPathByName` and `runList` are hardcoded to older bundled packs. That is why `onboard` can recommend v2 while the CLI appears unable to list/show/validate it.

### 3. Stock `gbrain-base-v2` is useful but risky for Idrees's brain

`gbrain-base-v2` collapses many redundant types into 15 canonical types. That is good for general brains, but Idrees's multi-vault brain has meaningful domain types like Kavalier CRM records. A blind `unify-types` run could collapse useful operational types into generic `note` unless we preview and/or create a custom Idrees pack.

### 4. Codex federated MCP patch must be treated as real but unverified

The local patch changes legacy bearer MCP/HTTP source scoping so federated reads can see all sources instead of falling back to `default`. This likely fixes a real issue for Codex/MCP clients, but it needs targeted tests/smoke checks before being trusted or upstreamed.

---

## Task 1: Fix CLI schema-pack discovery for bundled packs

**Objective:** Make `gbrain schema list/show/validate/use gbrain-base-v2` agree with the core loader by discovering every bundled schema pack that is actually registered.

**Files:**
- Modify: `~/gbrain/src/commands/schema.ts`
- Test: `~/gbrain/test/schema-cli.test.ts`

**Implementation details:**

1. Import `BUNDLED_PACK_NAMES` from `../core/schema-pack/mutate.ts` or centralize bundled names in an exported helper if cleaner.
2. Update `runList` so it prints every bundled pack from `BUNDLED_PACK_NAMES`, not only `gbrain-base` and `gbrain-recommended`.
3. Update `packPathByName` so any name in `BUNDLED_PACK_NAMES` resolves to `src/core/schema-pack/base/<name>.yaml` using the same source-relative paths as the existing helper.
4. Keep user-installed pack lookup unchanged.

**Regression tests:**

Add/adjust tests in `test/schema-cli.test.ts`:

- `schema list shows gbrain-base-v2 bundled`
- `schema show gbrain-base-v2 prints manifest details`
- `schema validate gbrain-base-v2 passes`
- optionally `schema use gbrain-base-v2 writes config` in isolated `GBRAIN_HOME`

**Verification commands:**

```bash
cd ~/gbrain
bun test test/schema-cli.test.ts
bun test test/schema-pack-find-pack-successors.serial.test.ts
bun test test/schema-pack-mutate.test.ts
bun run typecheck
```

Expected:
- Tests pass.
- `gbrain schema list` includes `gbrain-base-v2`.
- `gbrain schema validate gbrain-base-v2` passes.

---

## Task 2: Validate current Codex federated-MCP patch

**Objective:** Confirm the existing uncommitted Codex changes do what we think: legacy bearer HTTP/MCP reads can be federated/unscoped, while writes remain safe/default-scoped through handlers.

**Files:**
- Existing modified files:
  - `src/commands/serve-http.ts`
  - `src/core/oauth-provider.ts`
  - `src/mcp/dispatch.ts`
  - `src/mcp/http-transport.ts`

**Inspection checklist:**

1. Review each diff and identify the effective behavior change.
2. Confirm no write handler relies on `ctx.sourceId` being non-null without its own fallback.
3. Search for `ctx.sourceId!`, `sourceId ?? 'default'`, and write operations that use `sourceId`.
4. If gaps exist, add a safer helper: reads may be undefined/federated; writes must resolve to `default` or explicit source before mutation.

**Verification commands:**

```bash
cd ~/gbrain
git diff -- src/commands/serve-http.ts src/core/oauth-provider.ts src/mcp/dispatch.ts src/mcp/http-transport.ts
bun test test/*mcp* test/*operations*  # narrow if available
bun run typecheck
curl -fsS --max-time 5 http://127.0.0.1:3131/health
```

**Live smoke checks:**

Use GBrain MCP/CLI to retrieve across sources:

- Business: query `Kavalier Active Pipeline Rollup` with `source_id=business-vault`.
- JDA: exact/current context page `jda-vault/00-system/_active-context` or source-scoped query.
- Personal: query social-growth/networking context with `source_id=personal-vault`.
- Default/calendar: list/read calendar-day pages.

Expected:
- Federated/source-scoped reads work.
- No mutation path becomes ambiguous.

---

## Task 3: Run safe live remediation

**Objective:** Close stale sync/embedding/extraction gaps without running manual type migration.

**Commands:**

```bash
export PATH="$HOME/.bun/bin:$PATH"
gbrain onboard --auto --max-usd 1
```

**Expected:**
- It runs only auto-eligible steps.
- It does not run `unify-types` because that is manual-only/protected.
- Spend remains near zero.

**Verification commands:**

```bash
gbrain stats
gbrain doctor --json
gbrain extract --stale --dry-run
gbrain embed --stale --dry-run
gbrain quarantine list --include-flagged --json
curl -fsS --max-time 5 http://127.0.0.1:3131/health
```

Expected:
- Embedded equals chunks or missing count decreases to 0.
- Extraction stale pages remain 0.
- Sources are fresher.
- MCP health remains OK.

---

## Task 4: Produce a type-unification preview, not migration

**Objective:** Understand what `unify-types` would do to Idrees's domain types before any migration.

**Commands / research path:**

```bash
cd ~/gbrain
gbrain jobs submit unify-types --allow-protected --params '{"target_pack":"gbrain-base-v2","apply":false}'
# or use the direct handler / documented dry-run path if CLI shape differs.
```

If the job command shape is not appropriate, inspect:

- `src/core/schema-pack/unify-types-handler.ts`
- `src/commands/jobs.ts`
- tests in `test/schema-pack-unify-types-handler.test.ts`

**Report must include:**

- Current type counts.
- Proposed explicit retypes.
- Catch-all unknown types that would become `note`.
- Domain-specific types at risk:
  - Kavalier clothing types
  - calendar/context/index types
  - JDA-specific types
  - Personal-vault context types

**Gate:** Do not apply migration. Use preview to decide whether to create a custom Idrees pack.

---

## Task 5: Decide whether to create an Idrees-specific schema pack

**Objective:** Preserve useful domain semantics while still benefiting from v2's cleaner taxonomy.

**Likely pack strategy:**

- Name: `idrees-base` or `gbrain-idrees`
- Base: either fork `gbrain-base-v2` or create a standalone pack borrowing v2 ideas.
- Preserve domain types that materially improve routing/retrieval:
  - `calendar-day`
  - `folder-index`, `domain-index`, `vault-entry`, `context-index`
  - Kavalier CRM types: `clothing_client`, `clothing_order`, `clothing_order_item`, `clothing_measurements`, `clothing_fitting`, `clothing_payment`, `clothing_opportunity`, `clothing_pipeline_rollup`, etc.
  - system/context/report types used by Hermes routing
- Collapse purely redundant or accidental types to v2 canonical types.

**Gate:** This is a design step after preview. Do not create/activate without preview evidence.

---

## Task 6: Final verification and memory update

**Objective:** Leave Hermes with accurate durable knowledge of the working state.

**Verification:**

- `gbrain schema list` includes `gbrain-base-v2`.
- `gbrain schema validate gbrain-base-v2` passes.
- `gbrain stats` shows improved/completed embedding/sync/extraction state.
- MCP health is OK.
- Cross-vault smoke queries work.

**Memory update:**

Update durable memory with:

- Current GBrain version/engine.
- Whether schema v2 discovery is fixed.
- Whether safe onboard remediation completed.
- Whether type unification remains gated.
- Any specific blocker or recommended next step.

---

## Non-goals / Safety Gates

- Do **not** run `unify-types --apply` or equivalent protected job.
- Do **not** delete pages or purge data.
- Do **not** activate a custom pack without preview + validation.
- Do **not** assume stock `gbrain-base-v2` is appropriate for Kavalier/JDA/Personal types.
- Do **not** trust CLI success alone; verify DB stats and real retrieval.

## Goal Prompt for Execution

You are Hermes working in `~/gbrain` on Idrees's Mac mini. Implement and verify the safe targeted GBrain changes from this plan. First fix CLI schema-pack discovery so `gbrain-base-v2` is listed, showable, validatable, and usable by the schema CLI, matching the core loader's bundled-pack registry. Add regression tests in `test/schema-cli.test.ts`. Then run the relevant tests and typecheck. Next run safe live remediation with `gbrain onboard --auto --max-usd 1`, but do not run or apply `unify-types`. Verify with `gbrain stats`, `gbrain doctor --json`, stale extraction/embedding dry-runs, MCP health, and cross-vault smoke queries. Inspect but do not recklessly alter the existing Codex federated MCP patch; report whether it remains uncommitted and what it changes. Update durable memory only with stable current-state facts. If any command fails, diagnose root cause before fixing. Final response should include what changed, verification output, remaining blockers, and the exact next recommended action.
