/**
 * GBRA-130: every inventory row not fixed in this suite yet is a named
 * test.todo here (reports/GBRA-130-inventory.md in the crew drive), so a row
 * can't drop out of sight. When a row is fixed, delete it from DEFERRED and add
 * its probe file; ./sites.test.ts and the guard below keep the two lists apart.
 */
import { describe, expect, test } from 'bun:test';
import { ISOLATE_SITES } from '../../src/core/item-failure.ts';

/** [row id, owner or disposition, what goes wrong] */
export const DEFERRED: ReadonlyArray<readonly [string, string, string]> = [
  ['A-8', 'GBRA-129', 'Managed discovery: two pages claim one source_path, or the page at the file\'s slug records another origin'],
  ['A-16', 'next wave (effect variant fixed with C-1)', 'A staging-bytes recovery, or a terminal request that still holds a recovery record, has no preview-bound exit (only the withdrawal-mirror effect variant is fixed)'],
  ['A-19', 'deferred (intentional gate; narrow later)', 'Legacy rename reconcile'],
  ['A-20', 'not reproducible (4b): frontmatter validation is pack-independent, pinned by test/sync-pack-independent-frontmatter-6712.test.ts; real if that guard fails', 'Managed screen'],
  ['A-29', 'deferred (intentional gate; narrow later)', 'One live job (waiting/active/delayed/waiting-children/paused) whose submission_authority is SQL NULL, malformed, or a future version written by a n...'],
  ['A-32', 'deferred: next wave (test.todo)', 'Legacy un-syncable sweep'],
  ['A-33', 'deferred: next wave (test.todo)', 'Full sync reconcile delete'],
  ['A-35', 'deferred: next wave (test.todo)', 'drainEffects runs the noop-settle loop first'],
  ['A-37', 'deferred: next wave (test.todo)', 'extract_atoms, unmanaged'],
  ['A-38', 'deferred: next wave (test.todo)', 'Managed extract_facts on a connector source (always windowed by sourceChangedSince)'],
  ['A-39', 'deferred: next wave (test.todo)', 'chronicle'],
  ['A-40', 'deferred: next wave (test.todo)', 'edge_contradictions with dream.single_value.mode=apply'],
  ['A-43', 'deferred (intentional gate; narrow later)', 'synthesize'],
  ['A-47b', 'next wave (found by the A-47 lane)', 'Orchestrator v0.29.1 backfill_effective_date (src/core/backfill-effective-date.ts) runs each batch in one transaction with no per-row isolation, the shape A-47 fixed in backfill-base'],
  ['A-48', 'deferred: next wave (test.todo)', 'gbrain repair-jsonb / orchestrator v0.12.2: for the five non-jsonPayloadOnly targets (pages.frontmatter, raw_data.data, ingest_log.pages_updated, f...'],
  ['A-52', 'deferred: next wave (test.todo)', 'Unmanaged extraction (cycle incremental pass and full fs walk)'],
  ['A-53', 'GBRA-101 (4b)', 'Managed import batches (IMPORT_BATCH_MAX_PAGES) admit every member in one transaction'],
  ['A-54', 'deferred: next wave (test.todo)', 'One link whose addLink throws on the target (a target page absent for any reason other than a known failed/vanished page, or a link-type constraint...'],
  ['A-56', 'deferred: next wave (test.todo)', 'Legacy facts backstop per page: catch { /* per-page enqueue is best-effort */ } with no counter'],
  ['A-57', 'GBRA-101 (4b)', 'Managed per-file prepare/screen: loadActivePackForEngine(...).catch(() => null)'],
  ['A-58', 'deferred: next wave (test.todo)', 'Legacy import, file gone from disk branch: clearLegacyHold is outside any try, so a DB error there escapes importOnePath and aborts the whole drain...'],
  ['A-61', 'deferred: next wave (test.todo)', 'The comment says "the next settlement retries"'],
  ['A-62', 'deferred: next wave (test.todo)', 'doctor --remediate --resume with pending_embed_sources from a budget-exhausted checkpoint: one source\'s embed error aborts the run before any job s...'],
  ['A-63', 'deferred: next wave (test.todo)', 'gbrain repair file-drift --source <id> --all-drifted preview: a plain Error for one slug (fs EACCES/ENAMETOOLONG on the canonical path, a YAML or d...'],
  ['A-64', 'deferred: next wave (test.todo)', 'Fences\' managed write rethrows codes other than the changed/sync_in_progress set'],
  ['A-67', 'deferred (intentional gate; narrow later)', 'Jobs fail as a whole when any single page or file was refused (#5904, #6273 intent: never report success over unwritten rows)'],
  ['B-1', 'GBRA-129', 'Two live pages record one source_path'],
  ['B-2', 'GBRA-101 (4b)', 'One page in the source whose stored source_path is empty, absolute or contains ../'],
  ['B-8', 'deferred: next wave (test.todo)', 'Rename A→B leaves alias A→B; a later put_page, import, restore or sync creates a live page at A'],
  ['B-11', 'deferred: next wave (test.todo)', 'NFD and NFC spellings are accepted as two different slugs (probe: validateSlug of people/jose + U+0301 is not equal to the NFC people/josé)'],
  ['B-13', 'deferred: next wave (test.todo)', 'Frontmatter id is not unique per source'],
  ['B-14', 'GBRA-95', 'Streamed (segmented) sync refuses revision_conflict "A different page already owns this file identity"'],
  ['B-15', 'GBRA-129', 'sources reconcile refuses per page when several live pages claim the recorded file'],
  ['B-16', 'GBRA-101 (4b)', 'legacy_slug_conflict (#6727): several legacy pages fold to one file slug'],
  ['C-8', 'deferred (intentional gate; narrow later)', 'One live job row with a missing or unsupported submission_authority (a pre-v0.50 row, or one written by a newer build) stops every worker from star...'],
  ['C-10', 'deferred: next wave (test.todo)', 'A projection job that fails deterministically (a code page missing source_path, an unreadable segment) is retried every 30 s forever'],
  ['C-11', 'deferred: next wave (test.todo)', 'One transcript with real drift keeps --since last from ever advancing, so every run rescans all sessions'],
  ['C-12', 'deferred: next wave (test.todo)', 'A crash during writeState truncates .github-source.json'],
  ['C-13', 'deferred: next wave (test.todo)', 'A crashed skillpack install leaves .gbrain-skillpack.lock behind'],
  ['C-14', 'deferred: next wave (test.todo)', 'A holder hung inside its body (awaiting a statement the pooler never returns, the #6366 shape) keeps refreshing, so the TTL, the steal grace and --...'],
  ['C-15', 'deferred: next wave (test.todo)', 'When the vault lock is busy for more than 5 s, the writer proceeds without it (the code comment admits a deleted credential can be resurrected)'],
  ['C-16', 'GBRA-129', 'Duplicate-origin twins abort all managed sync'],
  ['C-17', 'GBRA-128', 'A 0-byte index.lock parks every git effect'],
  ['C-18', 'GBRA-101 (4b)', 'One resolved page write leaves the run blocked_by_failures, and every autopilot sync job "completes" with the parked result'],
  ['C-19', 'GBRA-101 (4b)', 'Generic invalid_params refusal, and a writer queue with a null heartbeat'],
  ['C-20', 'GBRA-101 (4b)', 'Holds survive an authorized DB-only delete (#6600)'],
  ['C-21', 'GBRA-101 (4b)', 'On macOS, case-colliding paths: refresh_dirty has no safe recovery'],
];

describe('GBRA-130 inventory rows not yet fixed here', () => {
  test('row ids are unique and none is already fixed at an ISOLATE_SITES site', () => {
    const ids = DEFERRED.map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
    const fixed = new Set<string>(Object.values(ISOLATE_SITES));
    expect(ids.filter((id) => fixed.has(id))).toEqual([]);
  });
  for (const [id, owner, what] of DEFERRED) test.todo(`${id} (${owner}): ${what}`, () => {});
});
