/**
 * Segmented page storage (Wave B): every size class bound, ceiling, retention
 * number and config key in one place. The product numbers (ceilings, version
 * retention) are open product calls; change them here and nowhere else.
 *
 * `pages.segmented_storage` defaults to `on` (SEGMENTED_STORAGE_DEFAULT); on, it
 * is effectively on only while no recent writer predates segmented
 * pages (`segmentedWriterBlockers`). While
 * it is off no page is newly segmented, every page stays inline up to
 * `PAGE_MAX_BYTES` (Wave A) and no code path below the inline threshold changes.
 */
import type { BrainEngine } from '../engine.ts';
import { PAGE_INLINE_MAX_BYTES, PAGE_MAX_BYTES } from '../page-size-policy.ts';
import type { SegmentedGateWriter } from '../persistence/writer-versions.ts';

export { PAGE_INLINE_MAX_BYTES };

/** Config keys this module reads (registered in `KNOWN_CONFIG_KEYS`). */
export const PAGE_BODY_CONFIG_KEYS = {
  segmentedStorage: 'pages.segmented_storage',
  maxBytes: 'pages.max_bytes',
  flipRetireMaxRows: 'pages.flip_retire_max_rows',
  versionsMaxPerPage: 'versions.segmented_max_per_page',
  versionsMaxPinnedBytes: 'versions.segmented_max_pinned_bytes',
} as const;

/** A page is promoted to segmented storage when its body grows past this many UTF-8 bytes (`body_bytes > 1 MiB`). */
export const SEGMENTED_PROMOTE_ABOVE_BYTES = PAGE_INLINE_MAX_BYTES;
/** A segmented page is demoted to inline only when a write leaves its body at or under this many bytes (hysteresis). */
export const SEGMENTED_DEMOTE_AT_OR_BELOW_BYTES = 512 * 1024;

/** Segmenter size bounds (UTF-8 bytes of the stored stream). */
export const SEGMENT_MIN_BYTES = 64 * 1024;
export const SEGMENT_TARGET_BYTES = 256 * 1024;
/** Rank-4 candidates (level-3+ headings, paragraph-ending blank lines) count once a segment passes this. */
export const SEGMENT_RANK4_BYTES = 384 * 1024;
/** Hard bound, matched by the `page_segment_texts.byte_len` CHECK. */
export const SEGMENT_MAX_BYTES = 1024 * 1024;
/**
 * The longest facts fence a withdrawal holds as one string, counted from its begin marker through its end marker
 * (UTF-8 bytes): withdrawal discovery, the purge and forget rewrite of the segments (segment-rewrite.ts), the trusted
 * read's join (read-range.ts `trustedSegments`) and the canonical file's overlaid digest (body-digests.ts) all count a
 * fence this way and refuse a longer one with `page_body_segmented` (`fenceTooLargeError`).
 */
export const FENCE_MAX_BYTES = PAGE_MAX_BYTES;

/** Raw prefix of each region kept on the page row (`truth_lead`, `timeline_lead`), equal to Wave A's bounded prefix. */
export const BODY_LEAD_BYTES = 64 * 1024;
/** Frontmatter of a streamed page must close within this many bytes of the file head. */
export const FRONTMATTER_HEAD_MAX_BYTES = 256 * 1024;
/** Pass 1 holds a line whole up to this many bytes; a longer line is read in slices of this size into bounded summaries. */
export const SCAN_LINE_BUFFER_BYTES = 64 * 1024;

/** Default segmented page ceiling per engine (`pages.max_bytes` when the switch is on). */
export const SEGMENTED_PAGE_CEILING_BYTES: Readonly<Record<'postgres' | 'pglite', number>> = {
  postgres: 256 * 1024 ** 2,
  pglite: 128 * 1024 ** 2,
};

/**
 * Rows one staging statement may carry, by payload bytes. A statement's transient memory is many times its payload
 * (driver hex text, protocol buffers, decoded texts, chunk strings): at 16 MiB a 100 MiB Postgres import peaked
 * ~400 MB above one at 4 MiB (scripts/bench-large-pages.ts), for 3% more ingest time.
 */
export const STAGE_BATCH_BYTES: Readonly<Record<'postgres' | 'pglite', number>> = {
  postgres: 4 * 1024 ** 2,
  pglite: 4 * 1024 ** 2,
};

/**
 * Chunk rows the generation flip deletes inside the publication transaction; above it the page publishes unsealed and a
 * projection job deletes the rest, this many rows per statement. Deleting leaves `idx_chunks_embedding` (HNSW) alone
 * (marking rows retired rewrote each entry: 20,000 embedded rows took 129 s on PGLite). `scripts/bench-large-pages.ts
 * --flip-only` measured 20,000 embedded rows at 0.88 s on PGLite and 0.51 s on Postgres, 40,000 at 1.83 s and 1.47 s,
 * under the publication's 5 s statement timeout.
 */
export const DEFAULT_FLIP_RETIRE_MAX_ROWS = 20_000;

/**
 * A segmented create of at most this many body bytes is searchable when its write commits: it chunks during preparation
 * (outside the transaction, the chunk inputs held in memory) and its publication inserts the chunk rows, one staging
 * statement's worth or a little more (STAGE_BATCH_BYTES), and seals. A larger create publishes unsealed and its projection runs after
 * commit (`searchable: 'pending'` on the receipt). The insert is the part the publication holds the page lock for:
 * about 0.3 s per MB on PGLite and 0.25 s on Postgres (a 20 MB chat page, 8,900 chunk rows): ~1.2 s at this bound,
 * ~7 s at 24 MiB, and 30 s to over a minute at the 128/256 MiB ceilings, with every write to the page waiting behind it.
 */
export const SEGMENTED_CREATE_SEAL_MAX_BYTES = 4 * 1024 ** 2;

/**
 * Snapshots of an inline page over the inline cap kept per page (Wave A). Each
 * one is a full copy of the body, so an append-heavy 24 MiB page would otherwise
 * grow history by 24 MiB per write. Snapshots at or under the inline cap, and
 * every snapshot of a small page, are never pruned.
 */
export const LARGE_PAGE_VERSIONS_KEPT = 5;

/** Segmented version retention: newest N kept, then oldest-first pruning while pinned bytes exceed max(floor, body_bytes). */
export const DEFAULT_SEGMENTED_VERSIONS_MAX_PER_PAGE = 50;
export const DEFAULT_SEGMENTED_VERSIONS_MAX_PINNED_BYTES = 64 * 1024 ** 2;

/** Unreferenced segment texts older than this are swept (insert-reference-before-GC grace). */
export const SEGMENT_TEXT_GC_GRACE_MS = 60 * 60 * 1000;
/** Body stagings expire after this long idle, and always after the hard limit. */
export const BODY_STAGING_IDLE_MS = 60 * 60 * 1000;
export const BODY_STAGING_HARD_MS = 24 * 60 * 60 * 1000;

/** A writer below `SEGMENTED_WRITER_FLOOR` keeps the switch off until this many days after its last committed request. */
export const SEGMENTED_WRITER_WINDOW_DAYS = 7;
/** The writer-version gate is read at most once per this many ms per engine (a transaction engine shares its root's entry). */
export const SEGMENTED_WRITER_GATE_TTL_MS = 60_000;

export interface PageBodyPolicy {
  /** The effective switch: `pages.segmented_storage` is not `off` and no recent writer predates segmented pages. */
  segmented: boolean;
  /** Largest page body admitted: `PAGE_MAX_BYTES` while the switch is off, else `pages.max_bytes` or the engine ceiling. */
  maxBytes: number;
  flipRetireMaxRows: number;
  versionsMaxPerPage: number;
  versionsMaxPinnedBytes: number;
}

type PolicyEngine = Pick<BrainEngine, 'getConfig' | 'kind' | 'executeRaw'>;

function positiveInt(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** The effective `pages.segmented_storage` when it is not configured. */
export const SEGMENTED_STORAGE_DEFAULT: 'on' | 'off' = 'on';

/** The configured `pages.segmented_storage`: unset means SEGMENTED_STORAGE_DEFAULT; an unrecognized value counts as `off`. */
export function parseSegmentedStorage(raw: string | null): 'on' | 'off' | 'unset' | 'invalid' {
  const value = (raw ?? '').trim();
  if (!value) return 'unset';
  if (/^(on|true|1|yes)$/i.test(value)) return 'on';
  return /^(off|false|0|no)$/i.test(value) ? 'off' : 'invalid';
}

let writerGate = new WeakMap<object, { at: number; blockers: SegmentedGateWriter[] }>();
/** Work counter: reads of the writer-version gate (the TTL cache answers the rest). */
export const segmentedWriterGateWork = { reads: 0 };

/**
 * Writers seen in the last `SEGMENTED_WRITER_WINDOW_DAYS` days that do not read segmented pages
 * (`segmentedGateWriters`: evidence without the segment-reader mark, or marked evidence of any role stamped below
 * `SEGMENTED_WRITER_FLOOR`, writer-floor.ts). Any one keeps segmented storage off. Cached per engine for
 * `SEGMENTED_WRITER_GATE_TTL_MS`; `fresh` (doctor) reads through.
 */
export async function segmentedWriterBlockers(engine: Pick<BrainEngine, 'executeRaw'>, opts: { fresh?: boolean } = {}): Promise<SegmentedGateWriter[]> {
  let root: object = engine;
  for (let proto = Object.getPrototypeOf(root); proto && !Object.hasOwn(proto, 'constructor'); proto = Object.getPrototypeOf(proto)) root = proto;
  const cached = writerGate.get(root);
  if (!opts.fresh && cached && Date.now() - cached.at < SEGMENTED_WRITER_GATE_TTL_MS) return cached.blockers;
  const [{ segmentedGateWriters }, { SEGMENTED_WRITER_FLOOR }] = await Promise.all([import('../persistence/writer-versions.ts'), import('./writer-floor.ts')]);
  segmentedWriterGateWork.reads++;
  const blockers = await segmentedGateWriters(engine, SEGMENTED_WRITER_WINDOW_DAYS, SEGMENTED_WRITER_FLOOR);
  writerGate.set(root, { at: Date.now(), blockers });
  return blockers;
}

/** Whether the configured switch asks for segmented storage, before the writer gate. */
export function segmentedStorageRequested(setting: ReturnType<typeof parseSegmentedStorage>): boolean {
  return setting === 'on' || (setting === 'unset' && SEGMENTED_STORAGE_DEFAULT === 'on');
}

/** Test seam: forget cached writer-gate reads. */
export function _resetSegmentedWriterGateForTests(): void {
  writerGate = new WeakMap();
}

/** The engine's default segmented ceiling. */
export function segmentedPageCeiling(kind: BrainEngine['kind']): number {
  return kind === 'pglite' ? SEGMENTED_PAGE_CEILING_BYTES.pglite : SEGMENTED_PAGE_CEILING_BYTES.postgres;
}

/** The largest body admitted while the switch is on: a configured `pages.max_bytes`, never above the engine ceiling. */
export function segmentedMaxBytes(kind: BrainEngine['kind'], maxRaw: string | null): number {
  const ceiling = segmentedPageCeiling(kind);
  return Math.min(positiveInt(maxRaw, ceiling), ceiling);
}

/** Bytes a page's file adds over its body, per staged copy, in the recovery default: frontmatter, separators, the record. */
export const RECOVERY_FILE_HEADROOM_BYTES = 1024 ** 2;

/**
 * The default `persistence.limits.worktree_recovery_bytes` (persistence/limits.ts): never below `floor`, room for the
 * largest page the configured switch admits, and room for the largest page already stored in segments
 * (`storedSegmentedBytes`, deleted pages included, which a restore brings back). A restore that writes a page's file
 * back reserves the file twice (persistence/coordinator.ts `pageRecoveryRecord`: its staging file and the file), so a
 * page needs twice its body plus RECOVERY_FILE_HEADROOM_BYTES per copy. It ignores the writer gate, and a switch turned
 * off or a lowered `pages.max_bytes` never shrinks it below a stored page: that page stays deletable, restorable and
 * mirrorable (a withdrawal rewrites its file) instead of being refused `request_too_large` with its file unchanged.
 */
export function pageRecoveryBytes(kind: BrainEngine['kind'], switchRaw: string | null, maxRaw: string | null, floor: number, storedSegmentedBytes = 0): number {
  const maxBytes = segmentedStorageRequested(parseSegmentedStorage(switchRaw)) ? segmentedMaxBytes(kind, maxRaw) : PAGE_MAX_BYTES;
  return Math.max(floor, 2 * (Math.max(maxBytes, storedSegmentedBytes) + RECOVERY_FILE_HEADROOM_BYTES));
}

/**
 * Read the segmented-storage policy once per write. The switch is effectively on when it is configured `on`
 * (or unset while SEGMENTED_STORAGE_DEFAULT is `on`) and no recent writer predates segmented pages; an
 * unreadable gate counts as blocked, and so does a failed read of `pages.segmented_storage` or `pages.max_bytes`
 * (only a missing row is unset, which means on). A configured `pages.max_bytes` never exceeds the engine ceiling.
 */
export async function readPageBodyPolicy(engine: PolicyEngine): Promise<PageBodyPolicy> {
  const readOrFail = (key: string) => engine.getConfig(key).then(value => ({ value }), () => null);
  const read = async (key: string) => (await readOrFail(key))?.value ?? null;
  const [switchRead, maxRead, retireRaw, versionsRaw, pinnedRaw] = await Promise.all([
    readOrFail(PAGE_BODY_CONFIG_KEYS.segmentedStorage), readOrFail(PAGE_BODY_CONFIG_KEYS.maxBytes), read(PAGE_BODY_CONFIG_KEYS.flipRetireMaxRows),
    read(PAGE_BODY_CONFIG_KEYS.versionsMaxPerPage), read(PAGE_BODY_CONFIG_KEYS.versionsMaxPinnedBytes),
  ]);
  const setting = switchRead && maxRead ? parseSegmentedStorage(switchRead.value) : 'off';
  const segmented = segmentedStorageRequested(setting) && (await segmentedWriterBlockers(engine).catch(() => null))?.length === 0;
  return {
    segmented,
    maxBytes: segmented ? segmentedMaxBytes(engine.kind, maxRead!.value) : PAGE_MAX_BYTES,
    flipRetireMaxRows: positiveInt(retireRaw, DEFAULT_FLIP_RETIRE_MAX_ROWS),
    versionsMaxPerPage: positiveInt(versionsRaw, DEFAULT_SEGMENTED_VERSIONS_MAX_PER_PAGE),
    versionsMaxPinnedBytes: positiveInt(pinnedRaw, DEFAULT_SEGMENTED_VERSIONS_MAX_PINNED_BYTES),
  };
}

/**
 * The storage class a write produces: segmented above the promote bound, inline
 * at or under the demote bound, and the current class in between (hysteresis).
 * Always inline while the switch is off, and for code and image pages.
 */
export function chooseBodyStorage(input: { policy: Pick<PageBodyPolicy, 'segmented'>; bodyBytes: number;
  current: 'inline' | 'segmented' | null; pageKind?: string | null }): 'inline' | 'segmented' {
  if (!input.policy.segmented || (input.pageKind && input.pageKind !== 'markdown')) return 'inline';
  if (input.bodyBytes > SEGMENTED_PROMOTE_ABOVE_BYTES) return 'segmented';
  if (input.bodyBytes <= SEGMENTED_DEMOTE_AT_OR_BELOW_BYTES) return 'inline';
  return input.current === 'segmented' ? 'segmented' : 'inline';
}
