/**
 * The wire and comparison encoding of mirrored reads (plan PR S1).
 *
 * `encodeValue` turns call arguments and results into plain JSON that survives the pipe to the shadow child:
 * typed arrays become `{ "$typed": "Float32Array", "v": [...] }`, Dates `{ "$date": iso }`, bigints
 * `{ "$bigint": "123" }`. AbortSignals, functions and symbols are dropped (a mirrored call never shares the caller's
 * cancellation). `decodeValue` reverses it in the child so a vector search gets a real Float32Array back.
 *
 * `canonicalJson` is the comparison form: the encoded value with object keys sorted, so two engines that build the
 * same row in a different key order still match.
 */

const TYPED_ARRAYS = {
  Float32Array, Float64Array, Int8Array, Int16Array, Int32Array, Uint8Array, Uint16Array, Uint32Array,
} as const;
type TypedArrayName = keyof typeof TYPED_ARRAYS;

/** The most an encoded read may weigh while it is built on the caller's path (the pipe's line cap). */
export const CAPTURE_BUDGET_BYTES = 1024 * 1024;

/** A value too big to mirror; thrown while encoding so the copy is never built. */
export class CaptureTooLargeError extends Error {}

/** The running weight of one encode: strings by length, numbers by a typical text size. */
export interface CaptureBudget { left: number }

function spend(budget: CaptureBudget | undefined, bytes: number): void {
  if (!budget) return;
  budget.left -= bytes;
  if (budget.left < 0) throw new CaptureTooLargeError('capture over budget');
}

function isAbortSignal(value: object): boolean {
  return typeof AbortSignal !== 'undefined' && value instanceof AbortSignal;
}

/** Plain-JSON form of a value; never throws on cycles (a repeated object becomes `{ "$cycle": true }`). */
export function encodeValue(value: unknown, seen: WeakSet<object> = new WeakSet(), budget?: CaptureBudget): unknown {
  spend(budget, 4); // every node costs at least its `null`: a million nulls or empty objects is not free
  if (value === null || value === undefined) return value ?? null;
  switch (typeof value) {
    case 'string': spend(budget, value.length); return value;
    case 'boolean': return value;
    case 'number': spend(budget, 6); return Number.isFinite(value) ? value : { $number: String(value) };
    case 'bigint': return { $bigint: value.toString() };
    case 'function': case 'symbol': return undefined;
  }
  const obj = value as object;
  if (obj instanceof Date) return { $date: Number.isNaN(obj.getTime()) ? 'invalid' : obj.toISOString() };
  if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
    const name = obj.constructor.name as TypedArrayName;
    if (name in TYPED_ARRAYS) {
      spend(budget, (obj as unknown as ArrayLike<number>).length * 10);
      return { $typed: name, v: Array.from(obj as unknown as ArrayLike<number>) };
    }
    return undefined;
  }
  if (isAbortSignal(obj)) return undefined;
  if (seen.has(obj)) return { $cycle: true };
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return obj.map((item) => { const e = encodeValue(item, seen, budget); return e === undefined ? null : e; });
    if (obj instanceof Map) return { $map: [...obj.entries()].map(([k, v]) => [encodeValue(k, seen, budget), encodeValue(v, seen, budget)]) };
    if (obj instanceof Set) return { $set: [...obj].map((v) => encodeValue(v, seen, budget)) };
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(obj)) {
      if (key === 'signal') continue;
      spend(budget, key.length + 4);
      if (item === undefined) continue; // an option left undefined stays absent, as JSON would have it; a null would be a different option
      const e = encodeValue(item, seen, budget);
      if (e !== undefined) out[key] = e;
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/**
 * The wire form of a call's argument list. A trailing or skipped `undefined` stays distinct from `null` (engine
 * methods treat them differently), so the child replays the call the caller made.
 */
export function encodeArgs(args: readonly unknown[], budget?: CaptureBudget): unknown[] {
  return args.map((arg) => (arg === undefined ? { $undefined: true } : encodeValue(arg, undefined, budget)));
}

/** Reverses `encodeValue`. */
export function decodeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  const rec = value as Record<string, unknown>;
  if (typeof rec.$typed === 'string' && Array.isArray(rec.v) && rec.$typed in TYPED_ARRAYS) {
    return new TYPED_ARRAYS[rec.$typed as TypedArrayName](rec.v as number[]);
  }
  if (rec.$undefined === true) return undefined;
  if (typeof rec.$date === 'string') return new Date(rec.$date);
  if (typeof rec.$bigint === 'string') return BigInt(rec.$bigint);
  if (typeof rec.$number === 'string') return Number(rec.$number);
  if (Array.isArray(rec.$map)) return new Map((rec.$map as unknown[][]).map(([k, v]) => [decodeValue(k), decodeValue(v)]));
  if (Array.isArray(rec.$set)) return new Set((rec.$set as unknown[]).map(decodeValue));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(rec)) out[key] = decodeValue(item);
  return out;
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(rec).sort()) out[key] = sortKeys(rec[key]);
  return out;
}

/** Comparison form of an already-encoded value: JSON with sorted keys. */
export function canonicalJson(encoded: unknown): string {
  return JSON.stringify(sortKeys(encoded)) ?? 'null';
}
