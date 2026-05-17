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
 * `~/.gbrain/page-locks/<sha256-of-slug>.lock` with PID-liveness +
 * 5-minute TTL. Multi-process safe — two `gbrain` invocations writing
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

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

import type { BrainEngine, NewFact, FactVisibility } from '../engine.ts';
import { withPageLock } from '../page-lock.ts';
import { gbrainPath } from '../config.ts';
import { upsertFactRow, parseFactsFence } from '../facts-fence.ts';
import { extractFactsFromFenceText } from './extract-from-fence.ts';

/** Resolved source binding for the entity page. */
export interface FenceTarget {
  /** Source primary key, e.g. 'default'. */
  sourceId: string;
  /** Filesystem root for this source. Null when the brain is read-only / thin-client. */
  localPath: string | null;
  /** Entity slug — also becomes source_markdown_slug + the file basename. */
  slug: string;
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
   * Optional time-bound expiration for the fact (e.g. "valid through
   * 2026-08-31"). When set, the rendered fence row carries the
   * date so re-fence operations preserve the validity window
   * (codex round-10 P2 fix). Defaults to undefined for normal
   * extraction paths where the LLM never produces an explicit upper
   * bound.
   */
  validUntil?: Date;
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
   * page for an unprefixed bare slug (e.g. `jared` with no `people/`
   * directory). Rows were NOT inserted; the caller is expected to route
   * the facts to the legacy DB-only path so they aren't silently dropped.
   *
   * This is the v0.34.5 fix for the entity-resolution bug where `"Jared"`
   * fell through resolution and produced a top-level `jared.md` stub.
   */
  stubGuardBlocked?: true;
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

/**
 * Stub-create body for a new entity page. Minimum frontmatter so the
 * page validates as gbrain-canonical markdown and survives an
 * `importFromFile` round-trip. Type inferred from slug prefix
 * (e.g. `people/alice` → 'person'); unknown prefixes fall back to
 * 'concept' which is the most permissive PageType.
 */
function stubEntityPage(slug: string): string {
  const prefix = slug.split('/')[0];
  const type =
    prefix === 'people'    ? 'person' :
    prefix === 'companies' ? 'company' :
    prefix === 'deals'     ? 'deal' :
    prefix === 'topics'    ? 'concept' :
    /* fallback */           'concept';
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

  const filePath = join(target.localPath, `${target.slug}.md`);
  const tmpPath = `${filePath}.tmp`;

  return withPageLock(
    target.slug,
    async () => {
      // 1. Read existing body, materialize from DB, or stub-create.
      let body: string;
      if (existsSync(filePath)) {
        body = readFileSync(filePath, 'utf-8');
        // Codex round-24 P2: an existing phantom .md file on disk
        // (pre-v0.34.5 era) would previously slip past the stub-guard
        // because the missing-file branch was the only place that
        // checked. resolveEntitySlug can still hand us an unprefixed
        // slug when prefix expansion finds no canonical (the "bare
        // name with no matching people/* page" case). Without this
        // second check, future facts keep appending to the existing
        // phantom and the split keeps growing.
        if (!target.slug.includes('/')) {
          const { isStubBody } = await import('../entities/resolve.ts');
          if (isStubBody(body)) {
            // eslint-disable-next-line no-console
            console.warn(
              `[facts] refusing to append to existing stub-shaped phantom slug=${target.slug} (file present but body is stub-shape). Routing to dropped-audit so future facts don't keep splitting onto this page.`,
            );
            return { inserted: 0, ids: [], stubGuardBlocked: true };
          }
          // Body is non-stub (intentional bare page) — let the
          // append continue.
        }
      } else {
        // The stub-creation guard prevents v0.34.5-era phantom entity
        // pages (`jared.md`, `alice.md` at brain root) from being
        // spawned. But there's a benign case: a legitimate top-level
        // DB page (created via MCP put_page or importFromContent on a
        // source with local_path but never synced to disk). For that
        // case we materialize the DB body to disk BEFORE the fence
        // append, so the user's content survives intact.
        //
        // Codex round-17 P2 + round-18 P1 — distinguish:
        //   - Real DB page with non-stub body → materialize + append.
        //   - DB page with stub body OR no DB row at all → fire guard.
        const existingPage = await engine.getPage(target.slug, {
          sourceId: target.sourceId,
        });
        const { isStubBody, stubBodyChars } = await import('../entities/resolve.ts');
        const hasRealContent =
          existingPage !== null &&
          (!isStubBody(existingPage.compiled_truth ?? '') ||
            (existingPage.timeline ?? '').trim().length > 0);

        if (!hasRealContent && !target.slug.includes('/')) {
          // No real DB body AND unprefixed slug — this would spawn a
          // phantom. Caller routes to the dropped-audit log.
          // eslint-disable-next-line no-console
          console.warn(
            `[facts] refusing to stub-create unprefixed entity page slug=${target.slug} — routing to legacy DB-only path. Provide a directory prefix (people/, companies/, etc.) to opt into fence writes.`,
          );
          return { inserted: 0, ids: [], stubGuardBlocked: true };
        }

        mkdirSync(dirname(filePath), { recursive: true });
        if (existingPage && hasRealContent) {
          // Materialize the existing DB body to disk so the fence
          // write appends to the real content rather than a stub.
          const { serializeMarkdown } = await import('../markdown.ts');
          const tags = Array.isArray(existingPage.frontmatter?.tags)
            ? (existingPage.frontmatter!.tags as string[])
            : [];
          body = serializeMarkdown(
            (existingPage.frontmatter as Record<string, unknown>) ?? {},
            existingPage.compiled_truth ?? '',
            existingPage.timeline ?? '',
            { type: existingPage.type, title: existingPage.title, tags },
          );
        } else {
          // Prefixed slug with no DB row → legitimately stub-create
          // a new entity page (the path that always worked).
          body = stubEntityPage(target.slug);
        }
        // Silence unused-import warnings on stubBodyChars.
        void stubBodyChars;
      }

      // 2. Upsert each fact onto the fence in input order. row_num
      //    monotonically increases (max-existing + 1 per call, append-only).
      const assignedRowNums: number[] = [];
      for (const f of facts) {
        const validFromStr = (f.validFrom ?? new Date()).toISOString().slice(0, 10);
        const validUntilStr = f.validUntil
          ? f.validUntil.toISOString().slice(0, 10)
          : undefined;
        const { body: updated, rowNum } = upsertFactRow(body, {
          claim:       f.fact,
          kind:        (f.kind ?? 'fact') as 'fact' | 'event' | 'preference' | 'commitment' | 'belief',
          confidence:  f.confidence ?? 1.0,
          visibility:  f.visibility,
          notability:  f.notability ?? 'medium',
          validFrom:   validFromStr,
          validUntil:  validUntilStr,
          source:      f.source,
          context:     f.context ?? undefined,
        });
        body = updated;
        assignedRowNums.push(rowNum);
      }

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
