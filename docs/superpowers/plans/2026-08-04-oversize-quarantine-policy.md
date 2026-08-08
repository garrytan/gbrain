# Oversize Quarantine Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator promote every page above `content_sanity.bytes_warn` from a passive warning to a recoverable quarantine, then make retroactive scans apply the same policy.

**Architecture:** Add an explicit `content_sanity.oversize_disposition` setting with a backwards-compatible default of `warn`. The pure assessor owns the threshold decision, `importFromContent` owns marker mutation and chunk removal, and `gbrain quarantine scan` reuses the same effective DB/file configuration for dry-run and apply.

**Tech Stack:** TypeScript, Bun test, PGLite, GBrain frontmatter quarantine markers.

---

### Task 1: Pin the assessor policy in a failing unit test

**Files:**
- Modify: `test/content-sanity.test.ts`
- Modify: `src/core/content-sanity.ts`

- [ ] **Step 1: Write the failing opt-in policy test**

Add a case that assesses 66,413 bytes of clean content with `bytes_warn: 50_000`, `bytes_block: 500_000`, and `oversize_disposition: 'quarantine'`. Assert `shouldQuarantine === true`, `quarantine_reason === 'oversized'`, `shouldFlag === false`, and `shouldSkipEmbed === false`. Keep the existing default-policy case asserting the same content only produces `oversize_warn`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test test/content-sanity.test.ts
```

Expected: FAIL because `oversize_disposition` and `quarantine_reason` do not exist and the warn-tier page is not quarantined.

- [ ] **Step 3: Implement the minimal pure policy**

Extend `assessContentSanity` with:

```ts
oversize_disposition?: 'warn' | 'quarantine';
```

Compute a size quarantine only when the setting is `quarantine` and `bytes > bytes_warn`. Add `quarantine_reason: 'junk_pattern' | 'literal_substring' | 'oversized' | null` to `ContentSanityResult`. Preserve junk-pattern precedence when both size and junk match.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run `bun test test/content-sanity.test.ts` and expect all cases to pass.

### Task 2: Resolve the setting and quarantine at the ingest narrow waist

**Files:**
- Modify: `src/core/config.ts`
- Modify: `src/core/quarantine.ts`
- Modify: `src/core/import-file.ts`
- Modify: `test/import-file-content-sanity.test.ts`

- [ ] **Step 1: Write the failing import regression**

Set the PGLite key `content_sanity.oversize_disposition=quarantine`, import a clean 66 KB note, and assert:

```ts
expect(result.quarantined).toBe(true);
expect(await engine.getChunks(slug)).toHaveLength(0);
expect(isQuarantined(page!.frontmatter)).toBe(true);
expect(getContentFlag(page!.frontmatter)).toBeNull();
expect(isEmbedSkipped(page!.frontmatter)).toBe(false);
```

- [ ] **Step 2: Run the import test and verify RED**

Run `bun test test/import-file-content-sanity.test.ts` and expect the new case to fail because the DB setting is ignored and the page remains unmarked.

- [ ] **Step 3: Implement config and marker wiring**

Add `oversize_disposition?: 'warn' | 'quarantine'` to `GBrainConfig.content_sanity`, lift the DB key only for those two legal values, and register it in `KNOWN_CONFIG_KEYS`. Expand `QuarantineMarker.reason` to include `oversized`.

Pass the setting to `assessContentSanity`. In the quarantine branch, use `quarantine_reason`; apply `junk_disposition=reject` only to junk/literal reasons, never to size-only quarantine. When quarantine wins, remove stale `content_flag` and `embed_skip` markers before setting `quarantine`.

- [ ] **Step 4: Run the import test and verify GREEN**

Run `bun test test/import-file-content-sanity.test.ts` and expect all cases to pass.

### Task 3: Make retroactive scan preview and apply the same promotion

**Files:**
- Modify: `src/commands/quarantine.ts`
- Modify: `test/quarantine-cli.test.ts`

- [ ] **Step 1: Write the failing scan regression**

Seed a pre-gate 66 KB page directly with `engine.putPage`, set the DB policy to `quarantine`, and assert `quarantine scan --json` reports one would-quarantine result without mutation. Then run `--apply --no-embed --json` and assert the page receives an `oversized` quarantine marker and has zero chunks.

Add a second assertion that a pre-existing `content_flag` page is promoted rather than skipped when the new policy says it must be quarantined.

- [ ] **Step 2: Run the CLI test and verify RED**

Run `bun test test/quarantine-cli.test.ts` and expect the new case to report zero quarantines because the scan does not pass the setting and skips flagged pages too early.

- [ ] **Step 3: Implement assessment-before-skip**

Pass `effCs.oversize_disposition` into `assessContentSanity`. Skip already-quarantined pages immediately. Assess flagged pages, and only keep the old skip optimization when the effective assessment does not promote them to quarantine.

- [ ] **Step 4: Run the CLI test and verify GREEN**

Run `bun test test/quarantine-cli.test.ts` and expect all cases to pass.

### Task 4: Update current-state architecture docs and run regression gates

**Files:**
- Modify: `docs/architecture/KEY_FILES.md`

- [ ] **Step 1: Update the current behavior entry**

Document `content_sanity.oversize_disposition` as an explicit `warn | quarantine` operator policy, with `warn` as the compatibility default and quarantine firing above `bytes_warn`.

- [ ] **Step 2: Run focused tests**

Run:

```bash
bun test test/content-sanity.test.ts test/import-file-content-sanity.test.ts test/quarantine.test.ts test/quarantine-cli.test.ts test/sql-ranking.test.ts test/e2e/quarantine-search-exclusion.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Run static and diff-aware gates**

Run `bun run typecheck` and `bun run ci:local:diff`, preserving full output before inspecting its tail. Expected: both exit 0.

### Task 5: Produce cleanup evidence without deleting data

**Files:**
- Create outside repository: Multica attachments `ws-3001-empty-report-summary.json` and `ws-3001-empty-report-inventory.csv`

- [ ] **Step 1: Generate the strict inventory**

Include only sensor reports whose structured headers simultaneously say `状态: error`, `样本数: 0`, and `原始字符: 0`. Report import-root, output-root, mirrored-copy, and DB-presence counts. Do not copy raw error/OCR blobs into the artifact.

- [ ] **Step 2: Stop at the approval gate**

Post the inventory and criteria for user review. Do not move source files, quarantine database pages, or run bulk cleanup until the user confirms the 804 strict import-root candidates. Preserve the 44 `status:error` reports with nonzero samples/raw characters.

## Self-review

- Spec coverage: configurable warn-to-quarantine policy, producer-gate evidence, retroactive scan parity, strict inventory, no destructive cleanup before review, and end-to-end verification after approval are all represented.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: the setting is consistently named `oversize_disposition`; the new marker/assessment reason is consistently `oversized`.
