/**
 * v0.32.2 — markdown-first fact write path.
 *
 * The "system of record" invariant means new facts land in the entity
 * page's `## Facts` fence FIRST, then the DB index gets stamped via
 * engine.insertFacts. After this commit, every write path that wants
 * persistent fact storage routes through `writeFactsToFence`. The DB
 * single-row `engine.insertFact` stays in the surface for the
 * legacy / thin-client fallback only (when the brain has no
 * sources.local_path configured).
 *
 * Concurrency: reuses the v0.28 page-lock primitive
 * (`src/core/page-lock.ts`), an FS-level lockfile under
 * `~/.gbrain/page-locks/<sha256-of-slug>.lock` with heartbeat-recency
 * staleness (5-minute TTL; namespace-agnostic — no PID-liveness, #2840).
 * Multi-process safe — two `gbrain` invocations writing
 * to the same entity page serialize through the same kernel-visible
 * lockfile. 5-second timeout per the plan's "5s retry" failure mode.
 *
 * Atomicity: write the fence to `<file>.tmp`, re-parse the .tmp body,
 * THEN `renameSync` to the canonical file. If parse fails the .tmp
 * stays in place as quarantine evidence and the JSONL surface
 * (`facts.write_failures.jsonl`) records the failure for `gbrain
 * doctor` to surface. The on-disk markdown file is never corrupted
 * mid-write (renameSync is atomic on POSIX) and the DB is never
 * inserted when the fence isn't valid (Codex Q7 atomic-write
 * recovery).
 *
 * No re-entrancy needed: writeFactsToFence uses fs.writeFileSync +
 * renameSync directly — NOT engine.putPage — so no code path can
 * re-trigger runFactsBackstop on the markdown write. The architecture
 * self-prevents the recursion concern Codex Q7 raised; documenting
 * here so a future refactor that swaps writeFileSync for putPage
 * sees the constraint.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';

import type { BrainEngine, NewFact, FactVisibility } from '../engine.ts';
import type { ResolutionSource } from '../entities/resolve.ts';
import { inferTypeFromPack } from '../markdown.ts';
import { loadActivePackBestEffort } from '../schema-pack/best-effort.ts';
import { withPageLock } from '../page-lock.ts';
import { gbrainPath } from '../config.ts';
import { isWriteThroughDisabled, resolvePageWriteTarget } from '../write-through.ts';
import { isDurabilityHardened, commitWriteThroughFile } from '../brain-repo-durability.ts';
import { upsertFactRow, parseFactsFence } from '../facts-fence.ts';
import { extractFactsFromFenceText } from './extract-from-fence.ts';
import { logStubGuardEvent } from './stub-guard-audit.ts';

/** Resolved source binding for the entity page. */
export interface FenceTarget {
  /** Source primary key, e.g. 'default'. */
  sourceId: string;
  /** Filesystem root for this source. Null when the brain is read-only / thin-client. */
  localPath: string | null;
  /** Entity slug — also becomes source_markdown_slug + the file basename. */
  slug: string;
  /**
   * #4108: how `slug` was resolved. REQUIRED (not optional) so no caller can
   * silently skip provenance: 'fallback_slugify' and null (resolver returned
   * nothing / caller has no resolution step) are blocked from stub-creating a
   * page — a fallback-minted slug names an entity nothing verified exists.
   * 'exact_page' / 'alias_exact' / 'fuzzy_match' all verified a live page, so
   * stub-create (DB↔file drift repair) stays allowed for them.
   */
  resolutionSource: ResolutionSource | null;
}

/** Input fact prepared by runPipelineWithBody (post-dedup). */
export interface FenceInputFact {
  fact: string;
  kind: NewFact['kind'];
  notability: NewFact['notability'];
  source: string;
  context?: string | null;
  visibility: FactVisibility;
  /** Defaults to 1.0 when undefined (matches engine.insertFact behavior). */
  confidence?: number;
  validFrom?: Date;
  /**
   * MEMORY_VERBS v1 (c5): remember's ttl → valid_until. Date-only in the
   * fence cell; the DB column derives from it on the stamp step.
   * Undefined/null = never expires (pre-v1 behavior unchanged).
   */
  validUntil?: Date | null;
  embedding: Float32Array | null;
  sessionId: string | null;
}

export interface FenceWriteResult {
  /** Number of new rows written + indexed. */
  inserted: number;
  /** DB ids assigned to the inserted rows, in input order. */
  ids: number[];
  /** True when the path fell through to DB-only because local_path was unset. */
  legacyFallback?: true;
  /** True when fence parse-validate failed; rows were NOT inserted, .tmp quarantined. */
  fenceWriteFailed?: true;
  /**
   * True when the stub-creation guard refused to spawn a phantom entity
   * page — either for an unprefixed bare slug (e.g. `jared` with no
   * `people/` directory), or (#4108) for a slug whose resolutionSource is
   * 'fallback_slugify'/null, i.e. a slug the resolver invented rather than
   * verified. Rows were NOT inserted; the caller is expected to route the
   * facts to the legacy DB-only path so they aren't silently dropped.
   *
   * The unprefixed arm is the v0.34.5 fix for the entity-resolution bug
   * where `"Jared"` fell through resolution and produced a top-level
   * `jared.md` stub.
   */
  stubGuardBlocked?: true;
  /**
   * True when the shared page-target resolver could not produce a usable
   * fence file path (source tree missing / not a directory, or a hostile
   * recorded `source_path` escaping the tree). Rows were NOT inserted; the
   * caller is expected to route the facts to the legacy DB-only path so
   * they aren't silently dropped. Unlike the old blind `mkdir -p`, we do
   * NOT resurrect a deleted source tree just to hold a fence — the same
   * refusal writePageThrough applies (#2018 `repo_not_found`).
   */
  targetUnresolvable?: true;
}

const FAILURE_LOG_PATH = (): string => gbrainPath('facts.write_failures.jsonl');

function recordWriteFailure(slug: string, sourceId: string, warnings: string[], filePath: string): void {
  // Best-effort JSONL append — never throws back into the caller. The
  // log is the operator-visibility surface; `gbrain doctor` reads it
  // to surface facts.write_failures.
  try {
    const dir = dirname(FAILURE_LOG_PATH());
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      slug,
      source_id: sourceId,
      file_path: filePath,
      warnings,
    });
    appendFileSync(FAILURE_LOG_PATH(), `${line}\n`, 'utf-8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[facts.write_failures] couldn't append: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type FactFenceGitPathState = 'clean' | 'self_dirty' | 'foreign_dirty' | 'unknown';

function gitPathState(repoPath: string, filePath: string): FactFenceGitPathState {
  try {
    const rel = relative(repoPath, filePath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return 'unknown';
    const status = execFileSync(
      'git',
      ['-C', repoPath, 'status', '--porcelain=v1', '--untracked-files=all', '--', rel],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: process.env },
    );
    const lines = status.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) return 'clean';
    // Distinguish dirt that IS the target fence file (safe for the
    // path-limited commit to sweep — a prior gbrain fence-commit that failed
    // leaves exactly this shape) from genuinely foreign dirt: unmerged
    // conflict states, rename entries naming a second path, or any entry the
    // parse can't positively attribute to `rel` (git quotes special chars).
    for (const line of lines) {
      const xy = line.slice(0, 2);
      if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'foreign_dirty';
      const pathField = line.slice(3);
      if (pathField !== rel && pathField !== `"${rel}"`) return 'foreign_dirty';
    }
    return 'self_dirty';
  } catch {
    return 'unknown';
  }
}

async function commitFactFenceFile(
  repoPath: string,
  filePath: string,
  slug: string,
  sourceId: string,
  prewriteState: FactFenceGitPathState,
): Promise<void> {
  // Self-dirt does NOT block the commit: a prior fence-commit failure
  // (index.lock contention, kill mid-commit) leaves the fence file itself
  // dirty, and refusing on that shape latched the page's durability off
  // permanently. The locked read-modify-write already incorporated the
  // file's pre-write content, and the commit below is path-limited to this
  // one file, so sweeping self-dirt is the recovery — only genuinely foreign
  // dirt (or an unreadable state) keeps the audit-and-skip behavior.
  if (prewriteState === 'foreign_dirty' || prewriteState === 'unknown') {
    recordWriteFailure(
      slug,
      sourceId,
      [prewriteState === 'foreign_dirty'
        ? 'git_durability_preexisting_dirty'
        : 'git_durability_prewrite_state_unknown'],
      filePath,
    );
    return;
  }

  for (const delayMs of [0, 50, 200] as const) {
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    if (commitWriteThroughFile(repoPath, filePath, slug) && gitPathState(repoPath, filePath) === 'clean') {
      return;
    }
  }

  recordWriteFailure(slug, sourceId, ['git_durability_commit_failed'], filePath);
}

/**
 * Stub-create body for a new entity page. Minimum frontmatter so the
 * page validates as gbrain-canonical markdown and survives an
 * `importFromFile` round-trip. Type inferred from slug prefix
 * (e.g. `people/alice` → 'person'); unknown prefixes fall back to
 * 'concept' which is the most permissive PageType.
 */
function stubEntityPage(
  slug: string,
  pack: Parameters<typeof inferTypeFromPack>[1] | null,
): string {
  // #4322: resolve the type through the ACTIVE PACK, not a hardcoded table.
  // The previous people/companies/deals/topics ternary shadowed every other
  // pack-declared prefix, so a stub under a declared prefix such as
  // `products/` was written as `concept` even though the pack maps that
  // prefix to `company` — manufacturing prefix/type mismatches in brains
  // that were otherwise fully pack-conformant, and (because `concept` skips
  // the facts backstop) silently opting those pages out of the very
  // subsystem that created them.
  //
  // A null pack means the load failed. Per best-effort.ts's contract we do
  // NOT substitute an ad-hoc table here; passing an empty pack routes
  // inferTypeFromPack to its own documented GBRAIN_BASE_PATH_PREFIXES
  // fallback, the same base behaviour every other ingest path degrades to.
  const type = inferTypeFromPack(slug, pack ?? { page_types: [] });
  const tail = slug.split('/').slice(1).join('/');
  const title = tail
    .replace(/[-_/]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase()) || slug;
  return `---\ntype: ${type}\ntitle: ${title}\nslug: ${slug}\n---\n\n# ${title}\n`;
}

/**
 * Run a markdown-first fence write for one entity. Acquires the page
 * lock, reads or stub-creates the file, appends each input fact to
 * the `## Facts` fence, atomically renames the .tmp into place, and
 * stamps the DB index via engine.insertFacts.
 *
 * Returns `legacyFallback: true` when `target.localPath` is null —
 * the caller is responsible for falling through to the legacy
 * DB-only `engine.insertFact` path. We don't do the legacy fallback
 * here because the caller has the FactsBackstopCtx (visibility,
 * session, supersede policy) that the fence path doesn't need but
 * the legacy path does.
 *
 * Returns `fenceWriteFailed: true` when parse-validation of the
 * just-written .tmp fails. In that case the .tmp stays on disk as
 * quarantine evidence, the JSONL failure log records the warnings,
 * and the DB is NOT touched. The caller treats this as a hard
 * failure on the page (no rows inserted, no duplicate count, no
 * fact_ids).
 */
export async function writeFactsToFence(
  engine: BrainEngine,
  target: FenceTarget,
  facts: FenceInputFact[],
): Promise<FenceWriteResult> {
  if (target.localPath === null) {
    return { inserted: 0, ids: [], legacyFallback: true };
  }
  if (facts.length === 0) {
    return { inserted: 0, ids: [] };
  }
  // `sync.write_through` off values make the brain DB-only by operator
  // choice: no fence file, no stub entity page, no git commit. Same
  // legacyFallback contract as a missing local_path — the caller's DB-only
  // path still records the facts.
  if (await isWriteThroughDisabled(engine)) {
    return { inserted: 0, ids: [], legacyFallback: true };
  }

  // #4204: compute the SAME path writePageThrough computes for this
  // (source, slug) — the fence appends to the page's file, so the two writers
  // must agree. The previous resolvePageFilePath routing nested any
  // non-default source under `<local_path>/.sources/<id>/` — but every
  // non-default source that reaches this line has its OWN `local_path`
  // (callers fall back to the legacy DB-only path when `sources.local_path`
  // is NULL), and write-through/scanOneSource put that topology's pages at
  // the tree ROOT. Sync's walker skips dot-directories, so a `.sources/`
  // fence was invisible to sync and the next extract_facts reconcile deleted
  // the fence-owned DB rows. The shared resolver also prefers the page's
  // recorded `source_path`, so the fence lands in the file of record instead
  // of minting a slug-derived twin beside a human-named vault file.
  const resolved = await resolvePageWriteTarget(engine, target.slug, target.sourceId);
  if (!resolved.ok) {
    // Target tree unusable (deleted dir, hostile source_path row, …) — the
    // caller routes the facts to the legacy DB-only path so they are
    // recorded, not dropped.
    return { inserted: 0, ids: [], targetUnresolvable: true };
  }
  const { filePath, writeRoot } = resolved;
  const tmpPath = `${filePath}.tmp`;
  const durabilityEnabled = isDurabilityHardened(writeRoot);

  return withPageLock(
    target.slug,
    async () => {
      // 1. Read existing body or stub-create.
      let body: string;
      if (existsSync(filePath)) {
        body = readFileSync(filePath, 'utf-8');
      } else {
        // Stub-creation guard, two arms:
        //
        // 1. Unprefixed slug (v0.34.5). Phantom entity pages at the brain
        //    root were being spawned when resolveEntitySlug fell through to
        //    a bare slugify because pg_trgm scored too low on short bare
        //    names. The resolver now has a prefix-expansion step that
        //    catches most of those, but this arm is the second wall: refuse
        //    to stub-create a page whose slug has no directory prefix
        //    (people/, companies/, deals/, topics/, etc.).
        //
        // 2. Fallback/absent resolution provenance (#4108). A PREFIXED
        //    fallback_slugify result (e.g. "companies/zeta-widgets" for an
        //    entity no page backs) sailed past arm 1 and materialized as a
        //    canonical stub page; after sync it resolved as exact_page,
        //    closing a fallback→stub→exact-match feedback loop. Blocklist
        //    shape on purpose: only 'fallback_slugify' and null are blocked,
        //    so future ResolutionSource members that verify a live page
        //    (like v0.46.15's 'alias_exact') fence without touching this.
        //
        // Either way the caller routes these facts to the legacy DB-only
        // path so they aren't silently dropped — the fact still gets
        // recorded (entity_slug retained), it just doesn't spawn a phantom
        // entity page on disk.
        //
        // Sunset target: v0.36, for arm 1 ONLY (the 'unprefixed' reason in
        // the audit log). Once `stub_guard_24h` (the gbrain doctor surface
        // backed by the audit log written here) reads <5 unprefixed
        // hits/week for 3 consecutive weeks on production brains, the
        // prefix-expansion in resolveEntitySlug is sufficient and arm 1 can
        // be removed. Arm 2 does NOT sunset: it is the only wall between
        // resolver-invented slugs and canonical page creation, and no
        // resolver improvement can retire it (the fallback floor is by
        // design). The audit log under
        // `~/.gbrain/audit/stub-guard-YYYY-Www.jsonl` is the operator
        // visibility surface, with per-arm `reason` fields.
        const fallbackResolved =
          target.resolutionSource === 'fallback_slugify' || target.resolutionSource == null;
        if (!target.slug.includes('/') || fallbackResolved) {
          logStubGuardEvent({
            slug: target.slug,
            source_id: target.sourceId,
            fact_count: facts.length,
            reason: !target.slug.includes('/') ? 'unprefixed' : 'fallback_resolution',
          });
          // eslint-disable-next-line no-console
          console.warn(
            !target.slug.includes('/')
              ? `[facts] refusing to stub-create unprefixed entity page slug=${target.slug} — routing to legacy DB-only path. Provide a directory prefix (people/, companies/, etc.) to opt into fence writes.`
              : `[facts] refusing to stub-create entity page slug=${target.slug} from a fallback-resolved reference (no live page verified) — routing to legacy DB-only path.`,
          );
          return { inserted: 0, ids: [], stubGuardBlocked: true };
        }
        // Stub-create the parent directory if it doesn't exist.
        mkdirSync(dirname(filePath), { recursive: true });
        const activePack = await loadActivePackBestEffort({ engine } as never);
        body = stubEntityPage(target.slug, activePack?.manifest ?? null);
      }

      // 2. Upsert each fact onto the fence in input order. row_num
      //    monotonically increases (max-existing + 1 per call, append-only).
      //
      //    Seed the counter from the DB as well as the fence file. Uniqueness
      //    is enforced by idx_facts_fence_key on
      //    (source_id, source_markdown_slug, row_num) in Postgres, but
      //    upsertFactRow derives the next value from the fence in the markdown
      //    alone — and falls back to 1 when the file has no fence at all. Any
      //    write path that rewrites a page without preserving its facts fence
      //    (put_page write-through, sync, dream-cycle reverse-render) therefore
      //    resets the counter below what the DB already holds, and the next
      //    absorb re-issues a row_num that is already taken. That surfaces as
      //    "duplicate key value violates unique constraint idx_facts_fence_key"
      //    and the whole batch of facts is dropped.
      //
      //    Symptom in the wild: a page whose fence had been rewritten away had
      //    24 facts in the DB and none in the file, so every subsequent absorb
      //    on it failed permanently. Taking the max of both sources keeps the
      //    file as the readable mirror while the DB stays authoritative about
      //    which row_nums have been issued.
      //
      //    Degrades to the previous file-only behaviour if the lookup fails
      //    (pre-v51 brain without the fence columns, or a transient DB error):
      //    a fence write must not become impossible just because the counter
      //    hint is unavailable.
      let dbMaxRowNum = 0;
      try {
        const rows = await engine.executeRaw<{ max_row_num: number | null }>(
          `SELECT MAX(row_num) AS max_row_num FROM facts
            WHERE source_id = $1 AND source_markdown_slug = $2`,
          [target.sourceId, target.slug],
        );
        dbMaxRowNum = Number(rows[0]?.max_row_num ?? 0);
      } catch {
        dbMaxRowNum = 0;
      }
      const { facts: existingFenceFacts } = parseFactsFence(body);
      const fileMaxRowNum = existingFenceFacts.length > 0
        ? Math.max(...existingFenceFacts.map(f => f.rowNum))
        : 0;
      let nextRowNum = Math.max(fileMaxRowNum, dbMaxRowNum) + 1;

      const assignedRowNums: number[] = [];
      for (const f of facts) {
        const validFromStr = (f.validFrom ?? new Date()).toISOString().slice(0, 10);
        const { body: updated, rowNum } = upsertFactRow(body, {
          rowNum:      nextRowNum++,
          claim:       f.fact,
          kind:        (f.kind ?? 'fact') as 'fact' | 'event' | 'preference' | 'commitment' | 'belief' | 'idea',
          confidence:  f.confidence ?? 1.0,
          visibility:  f.visibility,
          notability:  f.notability ?? 'medium',
          validFrom:   validFromStr,
          // MEMORY_VERBS v1 (c5): remember's ttl threads through to the fence
          // cell — was hard-coded undefined, which silently dropped expiry on
          // this path. extractFactsFromFenceText derives the DB column from it.
          validUntil:  f.validUntil ? f.validUntil.toISOString().slice(0, 10) : undefined,
          source:      f.source,
          context:     f.context ?? undefined,
        });
        body = updated;
        assignedRowNums.push(rowNum);
      }

      // Snapshot the prewrite git state INSIDE the lock, immediately before
      // the write: an out-of-lock snapshot raced concurrent fence writers — a
      // waiter observed the holder's not-yet-committed rename as pre-existing
      // dirt and mis-attributed it in the audit.
      const durabilityPrewriteState: FactFenceGitPathState = durabilityEnabled
        ? gitPathState(writeRoot, filePath)
        : 'clean';

      // 3. Atomic write: .tmp first, then parse-validate, then rename.
      writeFileSync(tmpPath, body, 'utf-8');

      // 4. Parse-before-rename: re-read the .tmp content and verify the
      //    fence is well-formed. Anything malformed → leave .tmp in
      //    place as quarantine, write JSONL, do NOT insert to DB.
      const tmpBody = readFileSync(tmpPath, 'utf-8');
      const parsed = parseFactsFence(tmpBody);
      if (parsed.warnings.length > 0) {
        recordWriteFailure(target.slug, target.sourceId, parsed.warnings, filePath);
        return { inserted: 0, ids: [], fenceWriteFailed: true };
      }

      // 5. Rename .tmp → file. POSIX atomic; the canonical file is
      //    either the old content or the new content, never partial.
      renameSync(tmpPath, filePath);

      // 6. Stamp the DB. extractFactsFromFenceText handles the
      //    validFrom/validUntil date derivation + the strikethrough
      //    semantic distinction. We only want to insert the NEW rows
      //    (those with row_nums in assignedRowNums), so filter the
      //    re-parsed facts to that subset.
      const allExtracted = extractFactsFromFenceText(parsed.facts, target.slug, target.sourceId);
      const newRowSet = new Set(assignedRowNums);
      const toInsert = allExtracted.filter(r => newRowSet.has(r.row_num));

      // Carry per-input embedding + sessionId across — the fence
      // parser doesn't reconstruct embeddings (they're not in the
      // fence text) and source_session is runtime provenance that
      // isn't a fence column either. Stitch them back by row_num
      // index.
      const enriched = toInsert.map((row, i) => ({
        ...row,
        embedding:      facts[i].embedding,
        source_session: facts[i].sessionId,
      }));

      const result = await engine.insertFacts(enriched, { source_id: target.sourceId }); // gbrain-allow-direct-insert: writeFactsToFence is the markdown-first reconcile path; runs only after the atomic fence write commits
      // v0.46 (#3014) — an unresolvable `superseded by #N` reference (self
      // / dangling / struck target) leaves superseded_by NULL; log it rather
      // than swallow it. The row still lands (expired_at set for struck
      // rows), never a bad FK.
      for (const w of result.warnings) {
        // eslint-disable-next-line no-console
        console.warn(`[facts.supersession] ${w}`);
      }
      if (durabilityEnabled) {
        await commitFactFenceFile(
          writeRoot,
          filePath,
          target.slug,
          target.sourceId,
          durabilityPrewriteState,
        );
      }
      return { inserted: result.inserted, ids: result.ids };
    },
    { timeoutMs: 5_000 },
  );
}

/**
 * Look up `sources.local_path` for a given source_id. Returns null
 * when the source has no local_path configured (thin-client / remote-
 * brain installs). Cached via the calling site is not necessary —
 * brains have at most a few sources and the lookup is a single
 * indexed query.
 *
 * Lives here (not in sources-ops.ts) so fence-write callers don't
 * need to thread the sources-ops module through the FactsBackstopCtx.
 */
export async function lookupSourceLocalPath(
  engine: BrainEngine,
  sourceId: string,
): Promise<string | null> {
  const rows = await engine.executeRaw<{ local_path: string | null }>(
    `SELECT local_path FROM sources WHERE id = $1 LIMIT 1`,
    [sourceId],
  );
  if (rows.length === 0) return null;
  return rows[0].local_path;
}
