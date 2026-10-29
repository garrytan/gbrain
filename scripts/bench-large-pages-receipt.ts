/**
 * The receipt one run of scripts/bench-large-pages.ts writes (Wave C spec §9.2, PR 1G; record-only, so no gate reads it
 * yet): one JSON object per run, schema `gbrain.bench.large-pages` at RECEIPT_VERSION. A stage has a name from
 * STAGE_NAMES, its wall time, the process's peak RSS over the stage (VmHWM after `clear_refs`) and its row counts; a
 * door stage adds the Git checkout's object sizes (`git count-objects -v`) and the native writer-lock hold of its
 * publication. `pages` records each generated page's size, seed, sha256 and decile needles. `validateReceipt` lists
 * every problem with a receipt (empty when it conforms); the nightly workflow and the tests run it.
 */
export const RECEIPT_SCHEMA = 'gbrain.bench.large-pages';
export const RECEIPT_VERSION = 1;

export const DOOR_STAGES = ['door_put', 'door_create', 'door_probes', 'door_append', 'door_splice'] as const;
export const DATABASE_STAGES = ['database_ingest', 'database_append', 'database_child_rss', 'database_flip_retire'] as const;
const STAGE_NAMES: readonly string[] = [...DOOR_STAGES, ...DATABASE_STAGES];
/** Door stages that publish a page through the door: each records its lock hold and the checkout's Git sizes. */
const PUBLISHING: readonly string[] = ['door_put', 'door_create', 'door_append', 'door_splice'];

export interface GitSizes { loose_objects: number; loose_bytes: number; packs: number; packed_bytes: number }
export interface ReceiptStage {
  name: typeof DOOR_STAGES[number] | typeof DATABASE_STAGES[number];
  ms: number;
  rss_peak_bytes: number;
  rows: Record<string, number>;
  git?: GitSizes;
  lock_hold_ms?: number;
  detail?: Record<string, unknown>;
}
export interface ReceiptPage { slug: string; bytes: number; seed: number; sha256: string; needles: Array<{ decile: number; word: string; offset: number }> }
export interface Receipt {
  schema: typeof RECEIPT_SCHEMA;
  version: typeof RECEIPT_VERSION;
  engine: 'pglite' | 'postgres';
  commit: string | null;
  started_at: string;
  wall_ms: number;
  rss_peak_bytes: number;
  pages: ReceiptPage[];
  stages: ReceiptStage[];
}

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const duration = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function validateReceipt(value: unknown): string[] {
  const problems: string[] = [];
  const receipt = value as Partial<Receipt> | null;
  if (!receipt || typeof receipt !== 'object') return ['receipt is not an object'];
  if (receipt.schema !== RECEIPT_SCHEMA) problems.push(`schema is ${JSON.stringify(receipt.schema)}, expected ${RECEIPT_SCHEMA}`);
  if (receipt.version !== RECEIPT_VERSION) problems.push(`version is ${JSON.stringify(receipt.version)}, expected ${RECEIPT_VERSION}`);
  if (receipt.engine !== 'pglite' && receipt.engine !== 'postgres') problems.push(`engine is ${JSON.stringify(receipt.engine)}`);
  if (receipt.commit !== null && !/^[0-9a-f]{40}$/.test(String(receipt.commit))) problems.push('commit is neither null nor a full sha');
  if (typeof receipt.started_at !== 'string' || Number.isNaN(Date.parse(receipt.started_at))) problems.push('started_at is not a timestamp');
  if (!duration(receipt.wall_ms)) problems.push('wall_ms is not a duration');
  if (!count(receipt.rss_peak_bytes)) problems.push('rss_peak_bytes is not a byte count');
  if (!Array.isArray(receipt.pages)) problems.push('pages is not an array');
  for (const [i, page] of (Array.isArray(receipt.pages) ? receipt.pages : []).entries()) {
    if (typeof page?.slug !== 'string' || !count(page.bytes) || !count(page.seed) || !/^[0-9a-f]{64}$/.test(String(page.sha256))) problems.push(`pages[${i}] needs slug, bytes, seed and a sha256`);
    const needles = Array.isArray(page?.needles) ? page.needles : [];
    if (needles.length !== 10 || needles.some((needle, decile) => needle?.decile !== decile || typeof needle.word !== 'string' || !count(needle.offset) || needle.offset >= page.bytes)) {
      problems.push(`pages[${i}] needs 10 needles, one per decile, inside the page`);
    }
  }
  if (!Array.isArray(receipt.stages) || !receipt.stages.length) return [...problems, 'stages is not a non-empty array'];
  const names = receipt.stages.map(stage => stage?.name);
  for (const [i, stage] of receipt.stages.entries()) {
    const at = `stages[${i}] (${String(stage?.name)})`;
    if (!STAGE_NAMES.includes(stage?.name as string)) problems.push(`${at}: unknown stage name`);
    if (names.indexOf(stage?.name) !== i) problems.push(`${at}: duplicate stage`);
    if (!duration(stage?.ms)) problems.push(`${at}: ms is not a duration`);
    if (!count(stage?.rss_peak_bytes)) problems.push(`${at}: rss_peak_bytes is not a byte count`);
    if (!stage?.rows || typeof stage.rows !== 'object' || Object.values(stage.rows).some(n => !count(n))) problems.push(`${at}: rows is not a map of counts`);
    if (stage?.detail !== undefined && (typeof stage.detail !== 'object' || stage.detail === null)) problems.push(`${at}: detail is not an object`);
    if (!PUBLISHING.includes(stage?.name as string)) continue;
    if (!duration(stage.lock_hold_ms)) problems.push(`${at}: lock_hold_ms is not a duration`);
    const git = stage.git;
    if (!git || !count(git.loose_objects) || !count(git.loose_bytes) || !count(git.packs) || !count(git.packed_bytes)) problems.push(`${at}: git needs loose_objects, loose_bytes, packs and packed_bytes`);
  }
  for (const group of [DOOR_STAGES, DATABASE_STAGES] as const) {
    const missing = group.filter(name => !names.includes(name));
    if (missing.length && missing.length < group.length) problems.push(`stages ran part of a group; missing ${missing.join(', ')}`);
  }
  return problems;
}
