/**
 * Skill vectors (V1): one vector per skill, made at build by the brain's own
 * embedding model (embed-http.ts), stored beside the index as vectors.bin
 * and tied to the catalog_hash, the model and the width. On a turn the
 * message is embedded once, every skill is scored by cosine, and the cosine
 * list is fused with the word ranking by reciprocal rank fusion, the rule the
 * brain's own search uses (1 / (RRF_K + rank), rank from 0; RRF_K is
 * src/core/search/hybrid.ts's, repeated here so the resolver stays a leaf).
 *
 * vectors.bin: "GSV1", a little-endian u32 header length, the header JSON
 * ({v, catalog_hash, model, dims, text, ids}), zero padding to a 4-byte
 * boundary, then one unit-length float32 row per id, in ids order.
 *
 * Only catalogs whose turns may use vectors get them: a catalog built for
 * Claude Code or Codex, or with no harness (a catalog built by hand), in
 * user scope. The OpenClaw plugin, the Pi extension, Hermes, qm and Cursor
 * catalogs never do, and neither does a project catalog (a cloned
 * repository's skills stay on this machine).
 */
import { embedKey, embedTexts, type EmbedProvider, type Embedder, type EmbedSkipCode, readEmbedder } from './embed-http.ts';
import { readBounded } from './fsutil.ts';
import type { SkillRecord } from './sources.ts';

/** src/core/search/hybrid.ts RRF_K. */
export const RRF_K = 60;
/** Harnesses whose catalogs get vectors (plus a catalog built with no harness). */
export const VECTOR_HARNESSES: readonly string[] = ['claude-code', 'codex'];
/** The skill text a vector is made from: name, description, when to use, triggers and the start of the body, capped (chosen over the same text without the body on the gskills bench's dev rows). A new recipe gets a new id, so old files stop matching. */
export const VECTOR_TEXT_ID = 'v1';
export const VECTOR_TEXT_CHARS = 6000;
export const VECTOR_FILE_CAP_BYTES = 64 * 1024 * 1024;
const BUILD_BATCH = 64;
/** Characters per build request, under every provider's per-request cap (the brain's Voyage recipe uses the same budget). */
export const BUILD_BATCH_CHARS = 60_000;
const BUILD_CONCURRENCY = 4;
/** The most a build waits for its embeddings before it publishes without vectors. */
export const BUILD_EMBED_TIMEOUT_MS = 60_000;
/** The longest a turn waits for its message's vector when the picker is off; with the picker on, the wait counts inside the picker's. */
export const VECTOR_WAIT_MS = 1000;
/** What a turn keeps after a vector wait its deadline cut short: the cosine scores, the word fallback, the render, and a timer that fires late on a busy machine (CI runners have stalled 30 to 60 ms). */
export const VECTOR_DEADLINE_RESERVE_MS = 100;
/** A build whose embedding failed for a passing reason is retried by the turn's auto-rebuild once its receipt is this old. */
export const VECTOR_RETRY_MS = 10 * 60_000;
export const VECTOR_RETRY_CODES: readonly EmbedSkipCode[] = ['provider_error', 'timeout', 'bad_reply'];
/** Builds in a row that may end in a passing failure before the turn stops asking for another (a failed embed may still be billed). */
export const VECTOR_RETRY_MAX = 3;
/** A receipt's vectors when there are none: why, and for a passing failure how many builds in a row ended that way. */
export interface VectorsSkip { skipped: EmbedSkipCode; attempts?: number }
/**
 * The no-skill gate with vectors on: a block shows only when one of its
 * skills from a catalog with vectors has a cosine at or above this floor
 * (a skill from a catalog without vectors keeps top_gate). Chosen on the
 * gskills bench's dev rows only; see docs/guides/skill-resolver.md.
 */
export const VECTOR_FLOOR: Readonly<Record<string, number>> = {
  'voyage:voyage-4': 0.26,
  'voyage:voyage-4-large': 0.22,
  'voyage:voyage-4-lite': 0.26,
  'voyage:voyage-3.5': 0.34,
  'openai:text-embedding-3-large': 0.26,
  'openai:text-embedding-3-small': 0.28,
  'google:gemini-embedding-001': 0.6,
  'google:gemini-embedding-2': 0.62,
};
let floorOverride: number | null = null;
/** Tests and the dev-row sweep only: use `x` as every model's floor (null restores the table). */
export function __setVectorFloorForTests(x: number | null): void { floorOverride = x; }
/** The model's cosine floor, or null for a model nobody measured: it gets no vectors (unmeasured_model), so its no-skill rate can't get worse than the word matcher's. */
export const vectorFloor = (model: string): number | null => floorOverride ?? VECTOR_FLOOR[model] ?? null;
const MAGIC = 'GSV1';

export interface CatalogVectors { model: string; dims: number; rows: Map<string, Float32Array> }
export interface VectorsReceipt { model: string; dims: number; count: number }

/** The text one skill's vector is made from. */
export function skillVectorText(s: Pick<SkillRecord, 'name' | 'description' | 'whenToUse' | 'triggers' | 'body'>): string {
  return [s.name, s.description, s.whenToUse ?? '', s.triggers.join('; '), s.body].map(x => x.split(/\s+/).filter(Boolean).join(' ')).filter(Boolean).join('\n').slice(0, VECTOR_TEXT_CHARS);
}

/** The vector scaled to unit length; a zero or non-finite reply is a bad_reply, never a row of zeros that ranks or gates. */
function unit(v: readonly number[]): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  if (!(n > 0) || !Number.isFinite(n)) throw new Error('bad_reply');
  const s = 1 / Math.sqrt(n);
  return Float32Array.from(v, x => x * s);
}

function vectorsHeader(catalogHash: string, model: string, dims: number, ids: readonly string[]): { header: Buffer; start: number; size: number } {
  const header = Buffer.from(JSON.stringify({ v: 1, catalog_hash: catalogHash, model, dims, text: VECTOR_TEXT_ID, ids }), 'utf8');
  const start = Math.ceil((8 + header.length) / 4) * 4;
  return { header, start, size: start + ids.length * dims * 4 };
}

/** Encode vectors.bin for `ids` (each vector already unit length, all of `dims`). */
export function encodeVectors(catalogHash: string, model: string, dims: number, ids: readonly string[], vectors: readonly Float32Array[]): Uint8Array {
  const { header, start, size } = vectorsHeader(catalogHash, model, dims, ids);
  const out = new Uint8Array(size);
  out.set(Buffer.from(MAGIC, 'ascii'), 0);
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  const f = new Float32Array(out.buffer, start, ids.length * dims);
  vectors.forEach((v, i) => f.set(v, i * dims));
  return out;
}

/** A catalog's vectors.bin, or null when it is missing, unreadable, or made for another catalog, model, width or text recipe. */
export function readCatalogVectors(path: string, catalogHash: string, model: string): CatalogVectors | null {
  try {
    const b = readBounded(path, VECTOR_FILE_CAP_BYTES);
    if (b === 'too_large' || b.length < 8 || b.subarray(0, 4).toString('ascii') !== MAGIC) return null;
    const len = b.readUInt32LE(4);
    const h = JSON.parse(b.subarray(8, 8 + len).toString('utf8')) as { v?: unknown; catalog_hash?: unknown; model?: unknown; dims?: unknown; text?: unknown; ids?: unknown };
    if (h.v !== 1 || h.catalog_hash !== catalogHash || h.model !== model || h.text !== VECTOR_TEXT_ID || !Number.isInteger(h.dims) || !Array.isArray(h.ids)) return null;
    const dims = h.dims as number;
    const ids = h.ids as string[];
    const start = Math.ceil((8 + len) / 4) * 4;
    if (b.length !== start + ids.length * dims * 4) return null;
    const all = new Float32Array(b.buffer.slice(b.byteOffset + start, b.byteOffset + b.length));
    const rows = new Map<string, Float32Array>();
    ids.forEach((id, i) => rows.set(id, all.subarray(i * dims, (i + 1) * dims)));
    return { model, dims, rows };
  } catch { return null; } // silent-read-ok: a catalog without a readable vectors.bin ranks by words, as before vectors existed
}

/** Why a build makes no vectors for this catalog, or null when it may. */
export function vectorsIneligible(harness: string | undefined, scope: 'user' | 'project'): EmbedSkipCode | null {
  if (scope === 'project') return 'project_scope';
  return harness === undefined || VECTOR_HARNESSES.includes(harness) ? null : 'not_this_harness';
}

/**
 * Embed a catalog's skills for the build: vectors.bin's bytes, or the code
 * that says why it has none. Never throws for the provider: a keyless,
 * failed or slow embed returns its code, and the build publishes as before,
 * without vectors.
 */
export async function embedCatalog(records: readonly SkillRecord[], catalogHash: string, ineligible: EmbedSkipCode | null, home: string, env: NodeJS.ProcessEnv): Promise<{ bytes: Uint8Array; receipt: VectorsReceipt } | { skipped: EmbedSkipCode }> {
  if (ineligible) return { skipped: ineligible };
  const t = turnEmbedder(home, env);
  if ('skip' in t) return { skipped: t.skip };
  const { embedder: e, key } = t;
  if (vectorFloor(e.model) === null) return { skipped: 'unmeasured_model' };
  if (records.length === 0) return { skipped: 'not_needed' };
  const ids = records.map(r => r.id);
  const tooBig = (dims: number) => vectorsHeader(catalogHash, e.model, dims, ids).size > VECTOR_FILE_CAP_BYTES;
  if (e.dims !== null && tooBig(e.dims)) return { skipped: 'too_many_skills' };
  const abort = new AbortController();
  let timedOut = false;
  let oversize = false, sized = false;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, BUILD_EMBED_TIMEOUT_MS);
  try {
    const texts = records.map(skillVectorText);
    const batches: [number, number][] = [];
    for (let i = 0; i < texts.length;) {
      let end = i + 1, chars = texts[i]!.length;
      while (end < texts.length && end - i < BUILD_BATCH && chars + texts[end]!.length <= BUILD_BATCH_CHARS) chars += texts[end++]!.length;
      batches.push([i, end]);
      i = end;
    }
    const out: Float32Array[] = new Array(texts.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(BUILD_CONCURRENCY, batches.length) }, async () => {
      while (next < batches.length && !abort.signal.aborted) {
        const [at, end] = batches[next++]!;
        try {
          const got = await embedTexts({ provider: e.provider, id: e.id, dims: e.dims, texts: texts.slice(at, end), inputType: 'document', signal: abort.signal, baseUrl: e.baseUrl }, key);
          got.forEach((v, j) => { out[at + j] = unit(v); });
          if (!sized && got[0]) { sized = true; if (tooBig(got[0].length)) { oversize = true; abort.abort(); return; } }
        } catch (err) { abort.abort(); throw err; }
      }
    }));
    if (oversize) return { skipped: 'too_many_skills' };
    if (abort.signal.aborted) return { skipped: timedOut ? 'timeout' : 'provider_error' };
    const dims = out[0]!.length;
    if (out.some(v => v.length !== dims)) return { skipped: 'bad_reply' };
    if (tooBig(dims)) return { skipped: 'too_many_skills' };
    return { bytes: encodeVectors(catalogHash, e.model, dims, ids, out), receipt: { model: e.model, dims, count: records.length } };
  } catch (err) {
    return { skipped: oversize ? 'too_many_skills' : timedOut ? 'timeout' : (err as Error)?.message === 'bad_reply' ? 'bad_reply' : 'provider_error' };
  } finally { clearTimeout(timer); }
}

export type QueryOutcome = { ok: true; vector: Float32Array; ms: number } | { ok: false; code: EmbedSkipCode; ms: number };

/** Embed one message with the brain's embedder within `timeoutMs`; resolves with the vector or the code that says why there is none. */
export async function embedQuery(e: Embedder, key: string, text: string, timeoutMs: number, cancel?: AbortSignal): Promise<QueryOutcome> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  if (timeoutMs < 1) return { ok: false, code: 'timeout', ms: 0 };
  const abort = new AbortController();
  cancel?.addEventListener('abort', () => abort.abort(), { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<QueryOutcome>(resolve => { timer = setTimeout(() => { abort.abort(); resolve({ ok: false, code: 'timeout', ms: ms() }); }, timeoutMs); });
  const call = embedTexts({ provider: e.provider, id: e.id, dims: e.dims, texts: [text], inputType: 'query', signal: abort.signal, baseUrl: e.baseUrl }, key)
    .then((v): QueryOutcome => ({ ok: true, vector: unit(v[0]!), ms: ms() }))
    .catch((err): QueryOutcome => ({ ok: false, code: abort.signal.aborted ? 'timeout' : (err as Error)?.message === 'bad_reply' ? 'bad_reply' : 'provider_error', ms: ms() }));
  try { return await Promise.race([call, late]); } finally { clearTimeout(timer); }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** The embedder a turn would use and its key, or why vectors are off. */
export function turnEmbedder(home: string, env: NodeJS.ProcessEnv): { embedder: Embedder; key: string } | { skip: EmbedSkipCode } {
  const e = readEmbedder(home, env);
  if ('skip' in e) return e;
  const key = embedKey(e.provider, home, env);
  return key === null ? { skip: 'missing_key' } : { embedder: e, key };
}

/**
 * Whether a catalog's vectors no longer match what a build would make now: the
 * brain has a measured embedder with a key and the receipt names another model,
 * none (embedder added, or a key found), or a passing failure older than
 * VECTOR_RETRY_MS, at most VECTOR_RETRY_MAX builds in a row. A changed width shows only in the message's vector, so the
 * turn marks that one itself (resolve.ts). With no usable embedder here it never asks for a
 * rebuild, so a hook without the key cannot drop vectors another build made.
 */
export function vectorsOutdated(receipt: { vectors?: VectorsReceipt | VectorsSkip; catalog: { harness: string | null; scope: 'user' | 'project' }; build: { built_at: string } }, now: number, want: () => string | null): boolean {
  const v = receipt.vectors;
  if (!v || vectorsIneligible(receipt.catalog.harness ?? undefined, receipt.catalog.scope) !== null) return false;
  if ('skipped' in v && (v.skipped === 'too_many_skills' || v.skipped === 'not_needed')) return false;
  if ('skipped' in v && VECTOR_RETRY_CODES.includes(v.skipped) && ((v.attempts ?? 1) >= VECTOR_RETRY_MAX || now - Date.parse(receipt.build.built_at) < VECTOR_RETRY_MS)) return false;
  const w = want();
  if (!w) return false;
  return 'skipped' in v || v.model !== w;
}

export type { EmbedProvider, EmbedSkipCode };
